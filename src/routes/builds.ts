import { Response } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';
import { buildQueue } from '../queue';

export const createBuild = async (req: AuthRequest, res: Response) => {
  try {
    const { repositoryId, commitHash } = req.body;
    const userId = req.user?.id;

    if (!repositoryId) return res.status(400).json({ error: 'repositoryId required' });

    const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
    
    if (!repo) return res.status(404).json({ error: 'Repository not found' });
    if (repo.userId !== userId) return res.status(403).json({ error: 'Unauthorized' });

    // Database Action: Create the build
    const build = await prisma.build.create({
      data: {
        repositoryId: repo.id,
        commitHash: commitHash || null,
        status: 'PENDING',
      }
    });

    // Push the job to BullMQ
    await buildQueue.add('execute-build', {
      buildId: build.id,
      repositoryUrl: repo.githubUrl,
      commitHash: build.commitHash
    }, {
      attempts: 3, 
      backoff: { type: 'exponential', delay: 2000 }
    });

    return res.status(201).json({
      message: 'Build triggered and queued successfully',
      buildId: build.id,
      status: build.status
    });

  } catch (error) {
    console.error('Error triggering build:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
