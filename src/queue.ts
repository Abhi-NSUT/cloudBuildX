import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// Connect to the Redis container you started in docker-compose
const connection = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null, // Required by BullMQ
});

// Instantiate the queue. "build-queue" is the channel name.
export const buildQueue = new Queue('build-queue', { connection });
