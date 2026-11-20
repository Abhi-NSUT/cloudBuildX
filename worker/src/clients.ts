import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import IORedis, { RedisOptions } from 'ioredis';
import Docker from 'dockerode';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { S3Client } from '@aws-sdk/client-s3';

export const WORKER_ID = `worker-${crypto.randomBytes(4).toString('hex')}`;
export const BUCKET = process.env.S3_BUCKET_NAME || 'cloudbuildx-artifacts';
export const WORKSPACE_ROOT = '/tmp/cloudbuildx-workspaces';

// One place that knows how to reach Redis: a hosted URL (Upstash) or host/port locally.
export const createRedis = (options: RedisOptions = {}) =>
  process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, options)
    : new IORedis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
        ...options,
      });

// AWS S3 in production (when AWS keys are set), MinIO locally.
export const createS3Client = () =>
  new S3Client(
    process.env.AWS_ACCESS_KEY_ID
      ? {
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
          },
        }
      : {
          region: 'us-east-1',
          endpoint: `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}`,
          credentials: {
            accessKeyId: process.env.MINIO_ROOT_USER || '',
            secretAccessKey: process.env.MINIO_ROOT_PASSWORD || '',
          },
          forcePathStyle: true,
        }
  );

// BullMQ needs maxRetriesPerRequest: null. This connection is shared by the
// BullMQ worker and for publishing log lines; only subscribing needs its own.
export const redis = createRedis({ maxRetriesPerRequest: null });
export const subscriber = createRedis();

export const s3Client = createS3Client();
export const prisma = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});
export const docker = new Docker(); // local Docker daemon via the mounted socket
