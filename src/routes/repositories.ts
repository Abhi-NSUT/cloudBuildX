import { Response } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';
import IORedis from 'ioredis';

const redis = new IORedis((process.env.REDIS_URL as any) || {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
});

export const getRepositories = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const cacheKey = `user:${userId}:repos`;

    // 1. Check Redis Cache
    const cachedRepos = await redis.get(cacheKey);
    if (cachedRepos) {
      console.log(`[Cache Hit] Repositories for user ${userId}`);
      return res.status(200).json(JSON.parse(cachedRepos));
    }

    // 2. Cache Miss: Fetch from PostgreSQL
    console.log(`[Cache Miss] Fetching repositories from DB for user ${userId}`);
    const repos = await prisma.repository.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    // 3. Write back to Redis with a 5-minute (300 seconds) TTL
    await redis.set(cacheKey, JSON.stringify(repos), 'EX', 300);

    return res.status(200).json(repos);
  } catch (error) {
    console.error('Error fetching repositories:', error);
    return res.status(500).json({ error: 'Failed to fetch repositories' });
  }
};

export const createRepository = async (req: AuthRequest, res: Response) => {
  try {
    const { name, githubUrl } = req.body;
    const userId = req.user?.id;

    if (!name || !githubUrl) {
      return res.status(400).json({ error: 'name and githubUrl are required' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const repo = await prisma.repository.create({
      data: {
        name,
        githubUrl,
        userId
      }
    });

    // 4. Cache Invalidation: Delete the stale cache key
    const cacheKey = `user:${userId}:repos`;
    await redis.del(cacheKey);

    return res.status(201).json({
      message: 'Repository added successfully',
      repositoryId: repo.id
    });
  } catch (error) {
    console.error('Error adding repository:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
