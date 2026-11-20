import { logger } from './logger';

export type BuildOutcome = 'success' | 'failed' | 'cancelled';

// Live, per-process build counters. Every finished build logs a `build.metrics`
// line with the running totals, so they can be graphed straight from the logs.
// (Platform-wide totals across all workers come from GET /api/admin/metrics.)
const counters = {
  started: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
};

export const recordBuildStarted = () => {
  counters.started += 1;
};

export const recordBuildFinished = (buildId: string, outcome: BuildOutcome, durationMs: number) => {
  if (outcome === 'success') counters.succeeded += 1;
  else if (outcome === 'failed') counters.failed += 1;
  else counters.cancelled += 1;

  counters.totalDurationMs += durationMs;
  counters.maxDurationMs = Math.max(counters.maxDurationMs, durationMs);

  logger.info('build.metrics', { buildId, outcome, durationMs, totals: getMetrics() });
};

export const getMetrics = () => {
  const finished = counters.succeeded + counters.failed + counters.cancelled;
  return {
    ...counters,
    finished,
    avgDurationMs: finished === 0 ? 0 : Math.round(counters.totalDurationMs / finished),
    failureRate: finished === 0 ? 0 : Math.round((counters.failed / finished) * 1000) / 10,
  };
};
