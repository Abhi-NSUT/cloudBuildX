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
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import archiver = require('archiver');
import * as fsSync from 'fs';
import crypto from 'crypto';

dotenv.config();

const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}`,
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER || '',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD || ''
  },
  forcePathStyle: true // Required for MinIO
});

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

const publisher = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
});

const subscriber = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
});

const activeContainers = new Map<string, Docker.Container>();
const activeJobs = new Set<string>();
const cancelledBuilds = new Set<string>();

subscriber.subscribe('cancel-build');
subscriber.on('message', async (channel, buildId) => {
  if (channel === 'cancel-build') {
    if (activeJobs.has(buildId)) {
      console.log(`[Worker ${WORKER_ID}] Cancel signal received for build ${buildId}!`);
      cancelledBuilds.add(buildId);
      
      if (activeContainers.has(buildId)) {
        const container = activeContainers.get(buildId);
        try {
          await container?.kill();
        } catch (e) {
          console.error(`[Worker ${WORKER_ID}] Error killing container for build ${buildId}:`, e);
        }
      }
    }
  }
});

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

const WORKER_ID = `worker-${crypto.randomBytes(4).toString('hex')}`;
console.log(`🚀 Starting Node: ${WORKER_ID}`);
log(`Worker is listening for jobs on "build-queue"...`);

const worker = new Worker('build-queue', async (job: Job) => {
  const { buildId, repositoryUrl, commitHash } = job.data;
  
  // Define a unique, absolute path for this specific build
  const workspaceDir = path.resolve(__dirname, '../../tmp-workspaces', buildId);
  const logFilePath = path.resolve(__dirname, '../../tmp-workspaces', `${buildId}.log`);
  let logFileStream: fsSync.WriteStream | null = null;

  console.log(`\n[${WORKER_ID}] Picked up build: ${buildId} (Job ${job.id})`);
  activeJobs.add(buildId);

  try {
    // Create a write stream for the historical log file right at the start
    logFileStream = fsSync.createWriteStream(logFilePath, { flags: 'a' });

    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'RUNNING', startedAt: new Date(), workerNode: WORKER_ID }
    });

    const initMsg = `Job claimed by ${WORKER_ID}. Starting execution...`;
    publisher.publish(`build-logs:${buildId}`, JSON.stringify({ type: 'system', text: initMsg }));
    logFileStream.write(`${initMsg}\r\n`);

    // 1. Ensure a clean slate (Forcefully remove ghost directories)
    console.log(`[${WORKER_ID}] Initializing workspace...`);
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

    // 5. Create & Start the Container
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

    activeContainers.set(buildId, container);

    // Check if we were cancelled while the container was being created or image pulled
    if (cancelledBuilds.has(buildId)) {
      await container.remove({ force: true }).catch(() => {});
      activeContainers.delete(buildId);
      throw new Error('BUILD_CANCELLED');
    }

    // 6. Start the Container
    console.log(`[Job ${job.id}] Starting container execution...`);
    await container.start();

    // 7. Demultiplex Logs (Properly separating stdout and stderr)
    const logStream = await container.logs({ follow: true, stdout: true, stderr: true });
    
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    const channel = `build-logs:${buildId}`;

    stdoutStream.on('data', async (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        console.log(`[Job ${job.id} INFO] ${text}`);
        publisher.publish(channel, JSON.stringify({ type: 'info', text }));
        if (logFileStream) logFileStream.write(`${text}\r\n`);
        await job.updateProgress(50); // Explicit heartbeat
      }
    });

    stderrStream.on('data', async (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        console.log(`[Job ${job.id} ERR]  ${text}`);
        publisher.publish(channel, JSON.stringify({ type: 'error', text }));
        // Add ANSI red formatting for errors in the log file
        if (logFileStream) logFileStream.write(`\x1b[31m${text}\x1b[0m\r\n`);
        await job.updateProgress(50); // Explicit heartbeat
      }
    });

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
      // We remove it from activeContainers here so that we don't try to kill it 
      // if a cancel signal arrives during the artifact zipping phase!
      activeContainers.delete(buildId);
      await container.remove({ force: true }).catch(() => {});
    }

    if (exitCode !== 0) {
      throw new Error(`Build failed with exit code ${exitCode}`);
    }

    // 9.5 Zip and Upload Artifacts to MinIO
    console.log(`[Job ${job.id}] Zipping artifacts and uploading to MinIO...`);
    publisher.publish(channel, JSON.stringify({ type: 'system', text: 'Compressing and uploading artifacts...' }));
    logFileStream.write(`\r\n\x1b[35m[SYSTEM EVENT] Compressing and uploading artifacts...\x1b[0m\r\n`);
    
    const archive = new (archiver as any).ZipArchive({ zlib: { level: 9 } });
    const pass = new PassThrough();
    
    archive.pipe(pass);

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: process.env.S3_BUCKET_NAME || 'cloudbuildx-artifacts',
        Key: `builds/${buildId}.zip`,
        Body: pass,
        ContentType: 'application/zip'
      }
    });

    archive.directory(workspaceDir, false);
    archive.finalize();

    await upload.done();
    
    console.log(`[Job ${job.id}] Artifacts uploaded successfully.`);
    publisher.publish(channel, JSON.stringify({ type: 'system', text: 'Artifacts uploaded successfully.' }));

    // 10. Mark Success in PostgreSQL
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'SUCCESS', completedAt: new Date() }
    });
    console.log(`[Job ${job.id}] Build completed successfully!`);
    publisher.publish(channel, JSON.stringify({ type: 'system', text: 'Build completed successfully.' }));

  } catch (error: any) {
    if (cancelledBuilds.has(buildId) || error.message === 'BUILD_CANCELLED') {
      console.error(`[Job ${job.id}] Build was cancelled by user.`);
      const channel = `build-logs:${buildId}`;
      publisher.publish(channel, JSON.stringify({ type: 'system', text: `Build cancelled by user.` }));
      if (logFileStream) logFileStream.write(`\r\n\x1b[31m[SYSTEM EVENT] Build cancelled by user.\x1b[0m\r\n`);
    } else {
      await prisma.build.update({
        where: { id: buildId },
        data: { status: 'FAILED', completedAt: new Date() }
      });
      console.error(`[Job ${job.id}] Failed:`, error);
      const channel = `build-logs:${buildId}`;
      publisher.publish(channel, JSON.stringify({ type: 'system', text: `Build failed: ${error.message}` }));
      if (logFileStream) logFileStream.write(`\r\n\x1b[31m[SYSTEM EVENT] Build failed: ${error.message}\x1b[0m\r\n`);
      throw error;
    }
  } finally {
    activeJobs.delete(buildId);
    cancelledBuilds.delete(buildId);
    // Cleanup workspaces
    try {
      if (logFileStream) {
        console.log(`[Job ${job.id}] Uploading historical logs to MinIO...`);
        logFileStream.end();
        
        const logUpload = new Upload({
          client: s3Client,
          params: {
            Bucket: process.env.S3_BUCKET_NAME || 'cloudbuildx-artifacts',
            Key: `builds/${buildId}.log`,
            Body: fsSync.createReadStream(logFilePath),
            ContentType: 'text/plain',
          },
        });
        await logUpload.done();
        console.log(`[Job ${job.id}] Historical logs uploaded successfully.`);
      }
    } catch (uploadErr) {
      console.error(`[Job ${job.id}] Failed to upload historical logs:`, uploadErr);
    }

    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(logFilePath, { force: true });
      console.log(`[Job ${job.id}] Cleaned up workspace and local logs.`);
    } catch (cleanupErr) {
      console.error(`[Job ${job.id}] FATAL: Failed to clean up workspace:`, cleanupErr);
    }
  }
}, { 
  connection, 
  concurrency: 1, 
  lockDuration: 30000, 
  stalledInterval: 30000 
});

worker.on('failed', (job, err) => {
  console.error(`[${WORKER_ID}] Job ${job?.id} failed:`, err.message);
});

worker.on('completed', (job) => {
  console.log(`[${WORKER_ID}] Job ${job.id} completed successfully.`);
});

worker.on('stalled', (jobId) => {
  console.warn(`[${WORKER_ID}] ⚠️ Warning: Job ${jobId} stalled. A worker likely crashed. BullMQ is re-queueing it for another node.`);
});

// Graceful Shutdown Implementation
const shutdown = async (signal: string) => {
  console.log(`\n[${WORKER_ID}] Received ${signal}. Initiating graceful shutdown...`);
  
  await worker.close(); // Stop accepting new jobs
  console.log(`[${WORKER_ID}] Waiting for active jobs to finish...`);
  
  await worker.disconnect(); 
  await prisma.$disconnect();
  publisher.quit();
  connection.quit();
  
  console.log(`[${WORKER_ID}] Shutdown complete. Goodbye.`);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
