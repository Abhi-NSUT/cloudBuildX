import { Response } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';

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

    return res.status(201).json({
      message: 'Repository added successfully',
      repositoryId: repo.id
    });
  } catch (error) {
    console.error('Error adding repository:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
