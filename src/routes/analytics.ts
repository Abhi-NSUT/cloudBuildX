import { Response } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';

export const getDashboardAnalytics = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    // 1. Extract just the IDs of the repos this user owns
    const userRepos = await prisma.repository.findMany({
      where: { userId },
      select: { id: true }
    });
    
    if (userRepos.length === 0) {
      return res.status(200).json({ totalBuilds: 0, successRate: 0, avgDurationSec: 0, metrics: [] });
    }

    const repoIds = userRepos.map(repo => repo.id);

    // 2. Run heavy database operations simultaneously
    const [statusDistribution, recentCompletedBuilds] = await Promise.all([
      
      // Query A: Ask PostgreSQL to group and count the statuses
      prisma.build.groupBy({
        by: ['status'],
        where: { repositoryId: { in: repoIds } },
        _count: { _all: true }
      }),

      // Query B: Fetch ONLY timestamps of the last 50 successful builds
      prisma.build.findMany({
        where: { 
          repositoryId: { in: repoIds }, 
          status: 'SUCCESS', 
          startedAt: { not: null }, 
          completedAt: { not: null } 
        },
        select: { startedAt: true, completedAt: true },
        orderBy: { completedAt: 'desc' },
        take: 50
      })
    ]);

    // 3. Transform the grouping data into a Success Rate percentage
    let totalBuilds = 0;
    let successCount = 0;

    statusDistribution.forEach(group => {
      totalBuilds += group._count._all;
      if (group.status === 'SUCCESS') {
        successCount = group._count._all;
      }
    });

    const successRate = totalBuilds === 0 ? 0 : Math.round((successCount / totalBuilds) * 100);

    // 4. Calculate Average Build Duration in seconds
    let avgDurationSec = 0;
    if (recentCompletedBuilds.length > 0) {
      const totalTimeMs = recentCompletedBuilds.reduce((acc, build) => {
        return acc + (build.completedAt!.getTime() - build.startedAt!.getTime());
      }, 0);
      
      avgDurationSec = Math.round((totalTimeMs / recentCompletedBuilds.length) / 1000);
    }

    // 5. Send the clean payload to the UI
    return res.status(200).json({
      totalBuilds,
      successRate,
      avgDurationSec,
      metrics: statusDistribution
    });

  } catch (error) {
    console.error('Error fetching analytics:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard analytics' });
  }
};
