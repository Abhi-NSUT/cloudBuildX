import { Prisma } from '@prisma/client';
import { prisma } from '../db';

const DURATION_SAMPLE_SIZE = 50;

// Build statistics for any slice of builds: one user's (dashboard) or all (admin).
// Two queries run in parallel: a GROUP BY on status, and the durations of the
// most recent successful builds.
export const getBuildStats = async (where: Prisma.BuildWhereInput = {}) => {
  const [byStatusRows, recent] = await Promise.all([
    prisma.build.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.build.findMany({
      where: { ...where, status: 'SUCCESS', startedAt: { not: null }, completedAt: { not: null } },
      select: { startedAt: true, completedAt: true },
      orderBy: { completedAt: 'desc' },
      take: DURATION_SAMPLE_SIZE,
    }),
  ]);

  const byStatus: Record<string, number> = {};
  let totalBuilds = 0;
  for (const row of byStatusRows) {
    byStatus[row.status] = row._count._all;
    totalBuilds += row._count._all;
  }

  const succeeded = byStatus.SUCCESS ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

  const durations = recent.map((b) => (b.completedAt!.getTime() - b.startedAt!.getTime()) / 1000);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  return {
    totalBuilds,
    byStatus,
    successRate: percent(succeeded, totalBuilds),
    failureRate: percent(failed, succeeded + failed),
    durationSec: {
      sampleSize: durations.length,
      avg,
      min: durations.length ? Math.round(Math.min(...durations)) : 0,
      max: durations.length ? Math.round(Math.max(...durations)) : 0,
    },
  };
};
