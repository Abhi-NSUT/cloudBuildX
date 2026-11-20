import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getBuildStats } from '../services/buildStats';

// GET /api/analytics - dashboard stats for the current user's builds
export const getDashboardAnalytics = async (req: AuthRequest, res: Response) => {
  const stats = await getBuildStats({ repository: { userId: req.user!.id } });

  return res.status(200).json({
    totalBuilds: stats.totalBuilds,
    successRate: stats.successRate,
    avgDurationSec: stats.durationSec.avg,
    byStatus: stats.byStatus,
  });
};
