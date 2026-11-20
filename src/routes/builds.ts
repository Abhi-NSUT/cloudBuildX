import { Response } from 'express';
import { prisma } from '../db';
import { Prisma, BuildStatus } from '@prisma/client';
import { AuthRequest, assertOwnerOrAdmin } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { buildQueue, redisConnection } from '../queue';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../logger';

const s3Config: any = process.env.AWS_ACCESS_KEY_ID ? {
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
} : {
  region: 'us-east-1',
  endpoint: `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}`,
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER || '',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD || ''
  },
  forcePathStyle: true
};
const s3Client = new S3Client(s3Config);
const BUCKET = process.env.S3_BUCKET_NAME || 'cloudbuildx-artifacts';
const CANCEL_WINDOW_MS = 15_000;

// Loads a build and enforces ownership (owner or admin). 404 if missing, 403 if not allowed.
const findAccessibleBuild = async (req: AuthRequest) => {
  const build = await prisma.build.findUnique({
    where: { id: req.params.id as string },
    include: { repository: true },
  });
  if (!build) throw new AppError(404, 'Build not found');
  assertOwnerOrAdmin(req.user, build.repository.userId);
  return build;
};

// POST /api/builds - body validated by createBuildSchema
export const createBuild = async (req: AuthRequest, res: Response) => {
  const { repositoryId, commitHash } = req.body as { repositoryId: string; commitHash?: string };

  const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repo) throw new AppError(404, 'Repository not found');
  assertOwnerOrAdmin(req.user, repo.userId);

  const build = await prisma.build.create({
    data: { repositoryId: repo.id, commitHash: commitHash || null, status: 'PENDING' },
  });

  await buildQueue.add('execute-build', {
    buildId: build.id,
    repositoryUrl: repo.githubUrl,
    commitHash: build.commitHash,
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
  });

  // Wake any sleeping workers
  await redisConnection.publish('wakeup-worker', 'wake_up');

  logger.info('Build queued', { buildId: build.id, repositoryId: repo.id, userId: req.user!.id });

  return res.status(201).json({
    message: 'Build triggered and queued successfully',
    buildId: build.id,
    status: build.status,
  });
};

// GET /api/builds - users see their own builds, admins see every build
export const getBuilds = async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
  const skip = (page - 1) * limit;
  const status = (req.query.status as string | undefined)?.toUpperCase();

  const whereClause: Prisma.BuildWhereInput =
    user.role === 'ADMIN' ? {} : { repository: { userId: user.id } };

  if (status) {
    if (!Object.values(BuildStatus).includes(status as BuildStatus)) {
      throw new AppError(400, `status must be one of ${Object.values(BuildStatus).join(', ')}`);
    }
    whereClause.status = status as BuildStatus;
  }

  const [builds, totalCount] = await Promise.all([
    prisma.build.findMany({
      where: whereClause,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { repository: { select: { name: true, githubUrl: true } } },
    }),
    prisma.build.count({ where: whereClause }),
  ]);

  return res.status(200).json({
    data: builds,
    meta: {
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      hasNextPage: page * limit < totalCount,
      hasPreviousPage: page > 1,
    },
  });
};

// GET /api/builds/:id
export const getBuildById = async (req: AuthRequest, res: Response) => {
  const build = await findAccessibleBuild(req);
  return res.status(200).json(build);
};

// GET /api/builds/:id/artifact - presigned download URL (15 min)
export const getBuildArtifact = async (req: AuthRequest, res: Response) => {
  const build = await findAccessibleBuild(req);

  if (build.status !== 'SUCCESS') {
    throw new AppError(400, 'Artifacts are only available for successful builds');
  }

  const command = new GetObjectCommand({ Bucket: BUCKET, Key: `builds/${build.id}.zip` });
  const url = await getSignedUrl(s3Client, command, { expiresIn: 900 });

  return res.status(200).json({ url });
};

// GET /api/builds/:id/logs - historical log file for a finished build
export const getBuildLogs = async (req: AuthRequest, res: Response) => {
  const build = await findAccessibleBuild(req);

  if (build.status === 'PENDING' || build.status === 'RUNNING') {
    throw new AppError(400, 'Logs are still streaming. Please connect via WebSockets.');
  }

  try {
    const s3Response = await s3Client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: `builds/${build.id}.log` })
    );
    res.setHeader('Content-Type', 'text/plain');
    (s3Response.Body as any).pipe(res);
  } catch (s3Error: any) {
    if (s3Error.name === 'NoSuchKey') {
      throw new AppError(404, 'Log file not found in storage. It may have been deleted.');
    }
    throw s3Error;
  }
};

// POST /api/builds/:id/cancel
export const cancelBuild = async (req: AuthRequest, res: Response) => {
  const build = await findAccessibleBuild(req);

  if (build.status === 'SUCCESS' || build.status === 'FAILED' || build.status === 'CANCELLED') {
    throw new AppError(400, 'Build is already finished');
  }

  if (Date.now() - new Date(build.createdAt).getTime() > CANCEL_WINDOW_MS) {
    throw new AppError(400, 'Cancellation is only allowed within the first 15 seconds');
  }

  await prisma.build.update({
    where: { id: build.id },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });

  // Broadcast the kill signal to the workers (reuses the shared connection)
  await redisConnection.publish('cancel-build', build.id);

  logger.info('Build cancelled', { buildId: build.id, userId: req.user!.id });
  return res.status(200).json({ message: 'Cancellation requested' });
};
