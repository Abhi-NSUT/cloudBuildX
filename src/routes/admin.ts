import { Response } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';
import { getBuildStats } from '../services/buildStats';

// GET /api/admin/metrics (ADMIN only) - platform-wide build metrics from Postgres,
// so they stay correct across every worker process.
export const getPlatformMetrics = async (_req: AuthRequest, res: Response) => {
  const [stats, totalUsers] = await Promise.all([getBuildStats(), prisma.user.count()]);
  return res.status(200).json({ totalUsers, ...stats });
};
