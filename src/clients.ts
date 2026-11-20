import IORedis, { RedisOptions } from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';

export const BUCKET = process.env.S3_BUCKET_NAME || 'cloudbuildx-artifacts';

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
export const s3Client = new S3Client(
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
