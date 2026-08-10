import { Response } from 'express';
import { prisma } from '../db';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { buildQueue } from '../queue';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import IORedis from 'ioredis';

const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}`,
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER || '',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD || ''
  },
  forcePathStyle: true // Required for MinIO
});

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
      attempts: 3, // Try up to 3 times
      backoff: {
        type: 'exponential',
        delay: 5000, // Wait 5s, then 25s, etc.
      },
      removeOnComplete: true,
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

    // 1. Parse and sanitize inputs
    const page = parseInt(req.query.page as string) || 1;
    let limit = parseInt(req.query.limit as string) || 10;
    
    // SECURITY: Enforce a hard cap on the limit
    if (limit > 100) limit = 100; 
    
    const skip = (page - 1) * limit;
    const status = req.query.status as string;

    // 2. Construct the dynamic Prisma WHERE clause
    const whereClause: Prisma.BuildWhereInput = {
      repository: { userId: userId }
    };

    if (status) {
      whereClause.status = status.toUpperCase() as any;
    }

    // 3. Execute data fetch and count simultaneously
    const [builds, totalCount] = await Promise.all([
      prisma.build.findMany({
        where: whereClause,
        skip: skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          repository: {
            select: {
              name: true,
              githubUrl: true
            }
          }
        }
      }),
      prisma.build.count({
        where: whereClause
      })
    ]);

    // 4. Return a structured REST response with metadata
    return res.status(200).json({
      data: builds,
      meta: {
        total: totalCount,
        page: page,
        limit: limit,
        totalPages: Math.ceil(totalCount / limit),
        hasNextPage: page * limit < totalCount,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching builds:', error);
    return res.status(500).json({ error: 'Failed to fetch build history' });
  }
};

// GET /api/builds/:id - Fetch a specific build by ID
export const getBuildById = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
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

// GET /api/builds/:id/artifact - Get a presigned download URL for the artifact
export const getBuildArtifact = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user?.id;

    const build = await prisma.build.findUnique({
      where: { id },
      include: { repository: true }
    });

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    if (build.repository.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized access' });
    }

    if (build.status !== 'SUCCESS') {
      return res.status(400).json({ error: 'Artifacts are only available for successful builds' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME || 'cloudbuildx-artifacts',
      Key: `builds/${id}.zip`
    });

    // URL expires in 15 minutes (900 seconds)
    const url = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return res.status(200).json({ url });
  } catch (error) {
    console.error('Error generating artifact URL:', error);
    return res.status(500).json({ error: 'Failed to generate download link' });
  }
};

// GET /api/builds/:id/logs - Fetch the historical log file for a completed build
export const getBuildLogs = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user?.id;

    const build = await prisma.build.findUnique({
      where: { id },
      include: { repository: true }
    });

    if (!build) return res.status(404).json({ error: 'Build not found' });
    if (build.repository.userId !== userId) return res.status(403).json({ error: 'Unauthorized access' });

    if (build.status === 'PENDING' || build.status === 'RUNNING') {
      return res.status(400).json({ error: 'Logs are still streaming. Please connect via WebSockets.' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME || 'cloudbuildx-artifacts',
      Key: `builds/${id}.log`
    });

    try {
      const s3Response = await s3Client.send(command);
      
      // The body is a Readable stream in Node.js
      const stream = s3Response.Body as any;
      
      res.setHeader('Content-Type', 'text/plain');
      stream.pipe(res);
      
    } catch (s3Error: any) {
      if (s3Error.name === 'NoSuchKey') {
        return res.status(404).json({ error: 'Log file not found in storage. It may have been deleted.' });
      }
      throw s3Error;
    }
  } catch (error) {
    console.error('Error fetching build logs:', error);
    return res.status(500).json({ error: 'Failed to fetch build logs' });
  }
};

// POST /api/builds/:id/cancel
export const cancelBuild = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user?.id;

    const build = await prisma.build.findUnique({
      where: { id },
      include: { repository: true }
    });

    if (!build) return res.status(404).json({ error: 'Build not found' });
    if (build.repository.userId !== userId) return res.status(403).json({ error: 'Unauthorized' });
    
    if (build.status === 'SUCCESS' || build.status === 'FAILED' || build.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Build is already finished' });
    }

    const timeSinceCreation = Date.now() - new Date(build.createdAt).getTime();
    if (timeSinceCreation > 15000) {
      return res.status(400).json({ error: 'Cancellation is only allowed within the first 15 seconds' });
    }

    // 1. Update the database immediately
    await prisma.build.update({
      where: { id },
      data: { status: 'CANCELLED', completedAt: new Date() }
    });

    // 2. Broadcast the kill signal to the workers
    const redisPublisher = new IORedis(process.env.REDIS_URL || { 
      host: process.env.REDIS_HOST || '127.0.0.1', 
      port: Number(process.env.REDIS_PORT) || 6379 
    });
    await redisPublisher.publish(`cancel-build`, id);

    return res.status(200).json({ message: 'Cancellation requested' });
  } catch (error) {
    console.error('Error canceling build:', error);
    return res.status(500).json({ error: 'Failed to cancel build' });
  }
};
