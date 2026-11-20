import { Response } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';
import { redisConnection as redis } from '../queue';
import { logger } from '../logger';

const CACHE_TTL_SECONDS = 300;
const cacheKey = (userId: string) => `user:${userId}:repos`;

// GET /api/repositories - Cache-Aside: Redis first, Postgres on a miss
export const getRepositories = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const cachedRepos = await redis.get(cacheKey(userId));
  if (cachedRepos) {
    logger.debug('Repository cache hit', { userId });
    return res.status(200).json(JSON.parse(cachedRepos));
  }

  logger.debug('Repository cache miss', { userId });
  const repos = await prisma.repository.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  await redis.set(cacheKey(userId), JSON.stringify(repos), 'EX', CACHE_TTL_SECONDS);
  return res.status(200).json(repos);
};

// POST /api/repositories - body validated by createRepositorySchema
export const createRepository = async (req: AuthRequest, res: Response) => {
  const { name, githubUrl } = req.body as { name: string; githubUrl: string };
  const userId = req.user!.id;

  const repo = await prisma.repository.create({ data: { name, githubUrl, userId } });

  // Invalidate the stale cache entry
  await redis.del(cacheKey(userId));

  return res.status(201).json({
    message: 'Repository added successfully',
    repositoryId: repo.id,
  });
};
