import fs from 'fs/promises';
import path from 'path';
import { Job, UnrecoverableError } from 'bullmq';
import { prisma, WORKER_ID, WORKSPACE_ROOT } from './clients';
import { BuildLog } from './buildLog';
import { trackBuild, untrackBuild, isCancelled, throwIfCancelled, BuildCancelledError } from './cancellation';
import { cloneRepository, loadBuildConfig, runInContainer, BuildError } from './executor';
import { uploadArtifacts, uploadLogFile } from './artifacts';
import { recordBuildStarted, recordBuildFinished } from './metrics';
import { logger } from './logger';

export interface BuildJobData {
  buildId: string;
  repositoryUrl: string;
  commitHash: string | null;
}

// Only move RUNNING -> final. If the API already marked the build CANCELLED,
// this matches nothing and the cancellation wins.
const finishBuild = (buildId: string, status: 'SUCCESS' | 'FAILED') =>
  prisma.build.updateMany({
    where: { id: buildId, status: 'RUNNING' },
    data: { status, completedAt: new Date() },
  });

// The BullMQ job handler: claim -> clone -> run in Docker -> upload artifacts -> finish.
export const processBuild = async (job: Job<BuildJobData>) => {
  const { buildId, repositoryUrl, commitHash } = job.data;
  const attempt = job.attemptsMade + 1;

  // Atomically claim the build. A build cancelled while still queued (or already
  // finished) is skipped. RUNNING is allowed so a stalled job can be recovered.
  const claim = await prisma.build.updateMany({
    where: { id: buildId, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'RUNNING', startedAt: new Date(), workerNode: WORKER_ID },
  });
  if (claim.count === 0) {
    logger.info('Skipping build that is no longer pending (cancelled or finished)', { buildId });
    return;
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const workspaceDir = path.join(WORKSPACE_ROOT, buildId);
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  const log = new BuildLog(buildId, `${workspaceDir}.log`);

  trackBuild(buildId);
  recordBuildStarted();
  logger.info('Build started', { buildId, jobId: job.id, attempt, workerId: WORKER_ID, repositoryUrl });
  log.system(`Job claimed by ${WORKER_ID}. Starting execution...`);

  try {
    await cloneRepository(repositoryUrl, commitHash, workspaceDir);
    const config = await loadBuildConfig(workspaceDir);
    logger.info('Build config loaded', { buildId, config });

    await runInContainer(buildId, workspaceDir, config, log, () => job.updateProgress(50));

    log.system('Compressing and uploading artifacts...');
    await uploadArtifacts(buildId, workspaceDir);
    throwIfCancelled(buildId);

    const finished = await finishBuild(buildId, 'SUCCESS');
    if (finished.count === 0) throw new BuildCancelledError(); // cancelled during upload

    logger.info('Build finished', { buildId, status: 'SUCCESS', durationMs: elapsed() });
    recordBuildFinished(buildId, 'success', elapsed());
    log.system('Build completed successfully.', 'SUCCESS');
  } catch (error: any) {
    if (error instanceof BuildCancelledError || isCancelled(buildId)) {
      // The API already set CANCELLED in the database
      logger.warn('Build finished', { buildId, status: 'CANCELLED', durationMs: elapsed() });
      recordBuildFinished(buildId, 'cancelled', elapsed());
      log.system('Build cancelled by user.', 'CANCELLED');
      return;
    }

    const willRetry = !(error instanceof BuildError) && attempt < (job.opts.attempts ?? 1);
    if (willRetry) {
      // Infrastructure hiccup (registry, S3, DB): back to PENDING, BullMQ retries with backoff
      await prisma.build.updateMany({ where: { id: buildId, status: 'RUNNING' }, data: { status: 'PENDING' } });
      logger.warn('Infrastructure error, will retry', { buildId, attempt, error: error.message });
      log.system(`Infrastructure error (${error.message}). Retrying...`);
      throw error;
    }

    await finishBuild(buildId, 'FAILED');
    logger.error('Build finished', { buildId, status: 'FAILED', durationMs: elapsed(), attempt, error: error.message, stack: error.stack });
    recordBuildFinished(buildId, 'failed', elapsed());
    log.system(`Build failed: ${error.message}`, 'FAILED');
    // Tells BullMQ not to retry a build that failed on its own merits
    throw new UnrecoverableError(error.message);
  } finally {
    untrackBuild(buildId);
    await log.close();
    await uploadLogFile(buildId, log.filePath).catch((e: Error) =>
      logger.error('Failed to upload build log', { buildId, error: e.message })
    );
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(log.filePath, { force: true }).catch(() => {});
  }
};
