import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Prisma v7 with pg adapter (just like the API server)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Connect to Redis
const connection = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null,
});

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

log('Worker is listening for jobs on "build-queue"...');

const worker = new Worker('build-queue', async (job: Job) => {
  const { buildId, repositoryUrl } = job.data;
  console.log(`\n[Job ${job.id}] Picked up build: ${buildId}`);

  try {
    // 1. Mark as RUNNING
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'RUNNING', startedAt: new Date() }
    });

    // 2. Simulate doing heavy work (Docker execution comes tomorrow)
    console.log(`[Job ${job.id}] Cloning repo: ${repositoryUrl}...`);
    await simulateWork(2000);
    
    console.log(`[Job ${job.id}] Compiling code...`);
    await simulateWork(3000);

    // 3. Mark as SUCCESS
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'SUCCESS', completedAt: new Date() }
    });
    console.log(`[Job ${job.id}] Build completed successfully!`);

  } catch (error) {
    // 4. Mark as FAILED on error
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'FAILED', completedAt: new Date() }
    });
    console.error(`[Job ${job.id}] Failed:`, error);
    throw error; // Let BullMQ handle retries
  }
}, { connection, concurrency: 5 });

// Helper to fake a time-consuming task
const simulateWork = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
