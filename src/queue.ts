import { Queue } from 'bullmq';
import { createRedis } from './clients';

// Shared connection for BullMQ, caching and publishing (BullMQ requires maxRetriesPerRequest: null).
export const redisConnection = createRedis({ maxRetriesPerRequest: null });

export const buildQueue = new Queue('build-queue', { connection: redisConnection });
