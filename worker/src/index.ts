import { Worker } from 'bullmq';
import { redis, subscriber, prisma, WORKER_ID } from './clients';
import { processBuild } from './processor';
import { requestCancel } from './cancellation';
import { logger } from './logger';

const IDLE_SLEEP_MS = 5 * 60 * 1000;

const worker = new Worker('build-queue', processBuild, {
  connection: redis,
  concurrency: 1,
  lockDuration: 30_000,
  stalledInterval: 30_000,
  drainDelay: 30,
});

logger.info('Worker started, listening for jobs on "build-queue"', { workerId: WORKER_ID });

worker.on('failed', (job, err) => {
  logger.error('Job failed', { jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message });
  wakeUp();
});
worker.on('completed', () => wakeUp());
worker.on('stalled', (jobId) => {
  logger.warn('Job stalled (a worker likely crashed); BullMQ is re-queueing it', { jobId });
});

// ==========================================
// Wake-on-demand: pause polling after 5 idle minutes to save Redis
// free-tier commands; the API publishes "wakeup-worker" when a build is queued.
// ==========================================
let sleepTimer: NodeJS.Timeout | undefined;

const wakeUp = () => {
  if (worker.isPaused()) {
    logger.info('Wake-up signal received, resuming job processing', { workerId: WORKER_ID });
    worker.resume();
  }
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(async () => {
    logger.info('Idle for 5 minutes, pausing to save Redis commands', { workerId: WORKER_ID });
    await worker.pause();
  }, IDLE_SLEEP_MS);
};

subscriber.subscribe('cancel-build', 'wakeup-worker');
subscriber.on('message', (channel, message) => {
  if (channel === 'wakeup-worker') wakeUp();
  else if (channel === 'cancel-build') void requestCancel(message);
});

wakeUp();

// Graceful shutdown: finish the current job, then close connections
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully`, { workerId: WORKER_ID });
  clearTimeout(sleepTimer);
  await worker.close();
  await prisma.$disconnect();
  subscriber.quit();
  redis.quit();
  logger.info('Shutdown complete', { workerId: WORKER_ID });
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
