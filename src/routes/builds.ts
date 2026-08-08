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

// GET /api/builds - Fetch all builds for the authenticated user
export const getBuilds = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    const builds = await prisma.build.findMany({
      where: {
        repository: {
          userId: userId
        }
      },
      include: {
        repository: {
          select: {
            name: true,
            githubUrl: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return res.status(200).json(builds);
  } catch (error) {
    console.error('Error fetching builds:', error);
    return res.status(500).json({ error: 'Failed to fetch build history' });
  }
};

// GET /api/builds/:id - Fetch a specific build by ID
export const getBuildById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const build = await prisma.build.findUnique({
      where: { id },
      include: {
        repository: true
      }
    });

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    if (build.repository.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized access to this build' });
    }

    return res.status(200).json(build);
  } catch (error) {
    console.error('Error fetching build details:', error);
    return res.status(500).json({ error: 'Failed to fetch build details' });
  }
};
