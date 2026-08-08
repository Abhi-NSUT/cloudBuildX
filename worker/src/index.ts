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
import yaml from 'js-yaml';
import { PassThrough } from 'stream';

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
    
    // 3. Parse build.yml Configuration
    console.log(`[Job ${job.id}] Looking for build.yml...`);
    let config = { 
      image: 'node:18-alpine', 
      commands: ['npm install', 'npm run build'] 
    };

    try {
      const configPath = path.join(workspaceDir, 'build.yml');
      const fileContents = await fs.readFile(configPath, 'utf8');
      
      const parsedConfig = yaml.load(fileContents) as any;
      if (parsedConfig.image) config.image = parsedConfig.image;
      if (parsedConfig.commands && Array.isArray(parsedConfig.commands)) {
        config.commands = parsedConfig.commands;
      }
      console.log(`[Job ${job.id}] Loaded custom build config:`, config);
    } catch (e) {
      console.log(`[Job ${job.id}] No valid build.yml found, using Node.js defaults.`);
    }

    // 4. Safely Pull the Docker Image
    console.log(`[Job ${job.id}] Pulling Docker image: ${config.image}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(config.image, (err: any, stream: any) => {
        if (err) return reject(new Error(`Failed to pull image ${config.image}: ${err.message}`));
        docker.modem.followProgress(stream, (followErr: any) => {
          if (followErr) reject(followErr);
          else resolve();
        });
      });
    });
    console.log(`[Job ${job.id}] Image pulled successfully.`);

    // 5. Create the Container with Security Constraints
    console.log(`[Job ${job.id}] Creating isolated container...`);
    const shellCmd = config.commands.join(' && ');

    const container = await docker.createContainer({
      Image: config.image,
      Cmd: ['/bin/sh', '-c', shellCmd],
      WorkingDir: '/workspace',
      HostConfig: {
        Binds: [`${workspaceDir}:/workspace`],
        Memory: 512 * 1024 * 1024, // Hard limit of 512MB RAM
        CpuQuota: 50000,           // Restrict to 50% of a single CPU core
        SecurityOpt: ['no-new-privileges:true'], // Prevents sudo escalation
        AutoRemove: false, // We must fetch the exit code first
      },
    });

    // 6. Start the Container
    console.log(`[Job ${job.id}] Starting container execution...`);
    await container.start();

    // 7. Demultiplex Logs (Properly separating stdout and stderr)
    const logStream = await container.logs({ follow: true, stdout: true, stderr: true });
    
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    stdoutStream.on('data', (chunk) => console.log(`[Job ${job.id} INFO] ${chunk.toString('utf8').trim()}`));
    stderrStream.on('data', (chunk) => console.log(`[Job ${job.id} ERR]  ${chunk.toString('utf8').trim()}`));

    container.modem.demuxStream(logStream, stdoutStream, stderrStream);

    // 8. Wait for Exit with a Hard Timeout
    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes maximum
    let exitCode: number;

    try {
      exitCode = await Promise.race([
        container.wait().then(data => data.StatusCode),
        new Promise<number>((_, reject) => 
          setTimeout(async () => {
            console.log(`[Job ${job.id}] Timeout reached! Killing container...`);
            await container.kill(); 
            reject(new Error('Build timed out after 10 minutes'));
          }, TIMEOUT_MS)
        )
      ]);
    } finally {
      // 9. Clean up the container from Docker Engine
      console.log(`[Job ${job.id}] Removing container from host...`);
      await container.remove({ force: true });
    }

    if (exitCode !== 0) {
      throw new Error(`Build failed with exit code ${exitCode}`);
    }

    // 10. Mark Success in PostgreSQL
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
