import Docker from 'dockerode';
import { logger } from './logger';

// In-memory state for the builds this process is running right now.
const activeBuilds = new Set<string>();
const cancelled = new Set<string>();
const containers = new Map<string, Docker.Container>();

export class BuildCancelledError extends Error {
  constructor() {
    super('BUILD_CANCELLED');
  }
}

export const trackBuild = (buildId: string) => activeBuilds.add(buildId);

export const untrackBuild = (buildId: string) => {
  activeBuilds.delete(buildId);
  cancelled.delete(buildId);
  containers.delete(buildId);
};

export const setContainer = (buildId: string, container: Docker.Container) => containers.set(buildId, container);
export const clearContainer = (buildId: string) => containers.delete(buildId);

export const isCancelled = (buildId: string) => cancelled.has(buildId);

export const throwIfCancelled = (buildId: string) => {
  if (cancelled.has(buildId)) throw new BuildCancelledError();
};

// Called when a "cancel-build" message arrives over Redis. Only the worker that
// is running the build acts on it: it flags the build and kills its container.
export const requestCancel = async (buildId: string) => {
  if (!activeBuilds.has(buildId)) return;

  logger.info('Cancel signal received', { buildId });
  cancelled.add(buildId);
  await containers
    .get(buildId)
    ?.kill()
    .catch((e: Error) => logger.error('Error killing container', { buildId, error: e.message }));
};
