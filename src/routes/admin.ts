import { Response } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';

interface DurationRow {
  completed: bigint;
  avg_sec: number | null;
  min_sec: number | null;
  max_sec: number | null;
}

// GET /api/admin/metrics (ADMIN only)
// Platform-wide build metrics computed from Postgres, so they stay correct
// across every worker process (each worker also logs its own live counters).
export const getPlatformMetrics = async (_req: AuthRequest, res: Response) => {
  const [byStatus, durationRows, totalUsers] = await Promise.all([
    prisma.build.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.$queryRaw<DurationRow[]>`
      SELECT COUNT(*)                                                   AS completed,
             AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::float AS avg_sec,
             MIN(EXTRACT(EPOCH FROM (completed_at - started_at)))::float AS min_sec,
             MAX(EXTRACT(EPOCH FROM (completed_at - started_at)))::float AS max_sec
      FROM builds
      WHERE status = 'SUCCESS' AND started_at IS NOT NULL AND completed_at IS NOT NULL`,
    prisma.user.count(),
  ]);

  const counts: Record<string, number> = {};
  let totalBuilds = 0;
  for (const group of byStatus) {
    counts[group.status] = group._count._all;
    totalBuilds += group._count._all;
  }

  const failed = counts.FAILED ?? 0;
  const succeeded = counts.SUCCESS ?? 0;
  const finished = succeeded + failed;
  const d = durationRows[0];
  const round = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10) / 10);

  return res.status(200).json({
    totalUsers,
    builds: {
      total: totalBuilds,
      byStatus: counts,
      failureRate: finished === 0 ? 0 : Math.round((failed / finished) * 1000) / 10,
    },
    durationSec: {
      sampleSize: Number(d?.completed ?? 0),
      avg: round(d?.avg_sec),
      min: round(d?.min_sec),
      max: round(d?.max_sec),
    },
  });
};
