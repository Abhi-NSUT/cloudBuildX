import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';
import Docker from 'dockerode';
import simpleGit from 'simple-git';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

// Initialize Prisma v7 with pg adapter
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const docker = new Docker(); // Connects to local Docker daemon
const connection = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: 6379,
  maxRetriesPerRequest: null,
});

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

log('Worker is listening for jobs on "build-queue"...');

const worker = new Worker('build-queue', async (job: Job) => {
  const { buildId, repositoryUrl, commitHash } = job.data;
  
  // Define a unique, absolute path for this specific build
  const workspaceDir = path.resolve(__dirname, '../../tmp-workspaces', buildId);

  console.log(`\n[Job ${job.id}] Picked up build: ${buildId}`);

  try {
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'RUNNING', startedAt: new Date() }
    });

    // 1. Ensure a clean slate (Forcefully remove ghost directories)
    console.log(`[Job ${job.id}] Initializing workspace...`);
    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    } catch (e) { /* Ignore if it doesn't exist */ }
    
    // Create the fresh directory
    await fs.mkdir(workspaceDir, { recursive: true });

    // 2. Clone the Repository
    console.log(`[Job ${job.id}] Cloning repository...`);
    const git = simpleGit();
    
    await git.clone(repositoryUrl, workspaceDir);
    
    if (commitHash) {
      console.log(`[Job ${job.id}] Checking out commit ${commitHash}...`);
      await simpleGit(workspaceDir).checkout(commitHash);
    }
    console.log(`[Job ${job.id}] Repository cloned successfully.`);
    
    // 3. Mark as SUCCESS (temporary until Docker execution is added)
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'SUCCESS', completedAt: new Date() }
    });
    console.log(`[Job ${job.id}] Build completed successfully!`);

  } catch (error) {
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'FAILED', completedAt: new Date() }
    });
    console.error(`[Job ${job.id}] Failed:`, error);
    throw error;
  } finally {
    // 11. The Ironclad Cleanup Block
    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      console.log(`[Job ${job.id}] Cleaned up workspace.`);
    } catch (cleanupErr) {
      console.error(`[Job ${job.id}] FATAL: Failed to clean up workspace:`, cleanupErr);
    }
  }
}, { connection, concurrency: 2 });
