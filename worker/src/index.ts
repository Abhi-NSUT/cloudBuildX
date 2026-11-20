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
import { logger } from './logger';
import { recordBuildStarted, recordBuildFinished } from './metrics';

dotenv.config();

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

// Initialize Prisma v7 with pg adapter
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const docker = new Docker(); // Connects to local Docker daemon
const connection = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : new IORedis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: null,
    });

const publisher = new IORedis((process.env.REDIS_URL as any) || {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
});

const subscriber = new IORedis((process.env.REDIS_URL as any) || {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
});

const activeContainers = new Map<string, Docker.Container>();
const activeJobs = new Set<string>();
const cancelledBuilds = new Set<string>();


const WORKER_ID = `worker-${crypto.randomBytes(4).toString('hex')}`;
logger.info('Worker started, listening for jobs on "build-queue"', { workerId: WORKER_ID });

const worker = new Worker('build-queue', async (job: Job) => {
  const { buildId, repositoryUrl, commitHash } = job.data;
  
  // Define a unique, absolute path for this specific build
  const workspaceDir = `/tmp/cloudbuildx-workspaces/${buildId}`;
  const logFilePath = `/tmp/cloudbuildx-workspaces/${buildId}.log`;
  let logFileStream: fsSync.WriteStream | null = null;

  const buildStartedAt = Date.now();
  logger.info('Build started', { buildId, jobId: job.id, attempt: job.attemptsMade + 1, workerId: WORKER_ID, repositoryUrl });
  recordBuildStarted();
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
    logger.info(`[${WORKER_ID}] Initializing workspace...`);
    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    } catch (e) { /* Ignore if it doesn't exist */ }
    
    // Create the fresh directory
    await fs.mkdir(workspaceDir, { recursive: true });

    // 2. Clone the Repository
    logger.info(`[Job ${job.id}] Cloning repository...`);
    const git = simpleGit();
    
    await git.clone(repositoryUrl, workspaceDir);
    
    if (commitHash) {
      logger.info(`[Job ${job.id}] Checking out commit ${commitHash}...`);
      await simpleGit(workspaceDir).checkout(commitHash);
    }
    logger.info(`[Job ${job.id}] Repository cloned successfully.`);
    
    // 3. Parse build.yml Configuration
    logger.info(`[Job ${job.id}] Looking for build.yml...`);
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
      logger.info('Loaded custom build config', { buildId, config });
    } catch (e) {
      logger.info(`[Job ${job.id}] No valid build.yml found, using Node.js defaults.`);
    }

    // 4. Safely Pull the Docker Image
    logger.info(`[Job ${job.id}] Pulling Docker image: ${config.image}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(config.image, (err: any, stream: any) => {
        if (err) return reject(new Error(`Failed to pull image ${config.image}: ${err.message}`));
        docker.modem.followProgress(stream, (followErr: any) => {
          if (followErr) reject(followErr);
          else resolve();
        });
      });
    });
    logger.info(`[Job ${job.id}] Image pulled successfully.`);

    // 5. Create & Start the Container
    logger.info(`[Job ${job.id}] Creating isolated container...`);
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
    logger.info(`[Job ${job.id}] Starting container execution...`);
    await container.start();

    // 7. Demultiplex Logs (Properly separating stdout and stderr)
    const logStream = await container.logs({ follow: true, stdout: true, stderr: true });
    
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    const channel = `build-logs:${buildId}`;

    stdoutStream.on('data', async (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        logger.debug(text, { buildId, stream: 'stdout' });
        publisher.publish(channel, JSON.stringify({ type: 'info', text }));
        if (logFileStream) logFileStream.write(`${text}\r\n`);
        await job.updateProgress(50); // Explicit heartbeat
      }
    });

    stderrStream.on('data', async (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        logger.debug(text, { buildId, stream: 'stderr' });
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
            logger.info(`[Job ${job.id}] Timeout reached! Killing container...`);
            await container.kill(); 
            reject(new Error('Build timed out after 10 minutes'));
          }, TIMEOUT_MS)
        )
      ]);
    } finally {
      // 9. Clean up the container from Docker Engine
      logger.info(`[Job ${job.id}] Removing container from host...`);
      // We remove it from activeContainers here so that we don't try to kill it 
      // if a cancel signal arrives during the artifact zipping phase!
      activeContainers.delete(buildId);
      await container.remove({ force: true }).catch(() => {});
    }

    if (exitCode !== 0) {
      throw new Error(`Build failed with exit code ${exitCode}`);
    }

    // 9.5 Zip and Upload Artifacts to MinIO
    logger.info(`[Job ${job.id}] Zipping artifacts and uploading to MinIO...`);
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
    
    logger.info(`[Job ${job.id}] Artifacts uploaded successfully.`);
    publisher.publish(channel, JSON.stringify({ type: 'system', text: 'Artifacts uploaded successfully.' }));

    // 10. Mark Success in PostgreSQL
    await prisma.build.update({
      where: { id: buildId },
      data: { status: 'SUCCESS', completedAt: new Date() }
    });
    const durationMs = Date.now() - buildStartedAt;
    logger.info('Build finished', { buildId, status: 'SUCCESS', durationMs });
    recordBuildFinished(buildId, 'success', durationMs);
    publisher.publish(channel, JSON.stringify({ type: 'system', text: 'Build completed successfully.' }));

  } catch (error: any) {
    if (cancelledBuilds.has(buildId) || error.message === 'BUILD_CANCELLED') {
      const durationMs = Date.now() - buildStartedAt;
      logger.warn('Build finished', { buildId, status: 'CANCELLED', durationMs });
      recordBuildFinished(buildId, 'cancelled', durationMs);
      const channel = `build-logs:${buildId}`;
      publisher.publish(channel, JSON.stringify({ type: 'system', text: `Build cancelled by user.` }));
      if (logFileStream) logFileStream.write(`\r\n\x1b[31m[SYSTEM EVENT] Build cancelled by user.\x1b[0m\r\n`);
    } else {
      await prisma.build.update({
        where: { id: buildId },
        data: { status: 'FAILED', completedAt: new Date() }
      });
      const durationMs = Date.now() - buildStartedAt;
      logger.error('Build finished', { buildId, status: 'FAILED', durationMs, attempt: job.attemptsMade + 1, error: error.message, stack: error.stack });
      recordBuildFinished(buildId, 'failed', durationMs);
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
        logger.info(`[Job ${job.id}] Uploading historical logs to MinIO...`);
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
        logger.info(`[Job ${job.id}] Historical logs uploaded successfully.`);
      }
    } catch (uploadErr) {
      logger.error('Failed to upload historical logs', { buildId, error: (uploadErr as Error).message });
    }

    try {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(logFilePath, { force: true });
      logger.info(`[Job ${job.id}] Cleaned up workspace and local logs.`);
    } catch (cleanupErr) {
      logger.error('Failed to clean up workspace', { buildId, error: (cleanupErr as Error).message });
    }
  }
}, { 
  connection, 
  concurrency: 1, 
  lockDuration: 30000, 
  stalledInterval: 30000,
  drainDelay: 30
});

worker.on('failed', (job, err) => {
  logger.error('Job failed', { jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message });
  wakeUp();
});

worker.on('completed', (job) => {
  logger.info(`[${WORKER_ID}] Job ${job.id} completed successfully.`);
  wakeUp();
});

worker.on('stalled', (jobId) => {
  logger.warn(`[${WORKER_ID}] ⚠️ Warning: Job ${jobId} stalled. A worker likely crashed. BullMQ is re-queueing it for another node.`);
});

// ==========================================
// AUTO-SLEEP ARCHITECTURE
// ==========================================
let sleepTimer: NodeJS.Timeout | null = null;

const goSleep = async () => {
  logger.info(`[${WORKER_ID}] 💤 Worker has been idle for 5 minutes. Pausing to save Redis free-tier commands...`);
  await worker.pause();
};

const wakeUp = async () => {
  if (worker.isPaused()) {
    logger.info(`[${WORKER_ID}] ⚡ Received Wake-Up Signal! Resuming job processing...`);
    await worker.resume();
  }
  
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(goSleep, 5 * 60 * 1000); // 5 minutes
};

subscriber.subscribe('cancel-build', 'wakeup-worker');
subscriber.on('message', async (channel, message) => {
  if (channel === 'wakeup-worker') {
    wakeUp();
  } else if (channel === 'cancel-build') {
    const buildId = message;
    if (activeJobs.has(buildId)) {
      logger.info(`[Worker ${WORKER_ID}] Cancel signal received for build ${buildId}!`);
      cancelledBuilds.add(buildId);
      if (activeContainers.has(buildId)) {
        try {
          await activeContainers.get(buildId)?.kill();
        } catch (e) {
          logger.error('Error killing container', { buildId, error: (e as Error).message });
        }
      }
    }
  }
});

// Start the initial sleep timer
wakeUp();

// Graceful Shutdown Implementation
const shutdown = async (signal: string) => {
  logger.info(`[${WORKER_ID}] Received ${signal}. Initiating graceful shutdown...`);
  
  await worker.close(); // Stop accepting new jobs
  logger.info(`[${WORKER_ID}] Waiting for active jobs to finish...`);
  
  await worker.disconnect(); 
  await prisma.$disconnect();
  publisher.quit();
  connection.quit();
  
  logger.info(`[${WORKER_ID}] Shutdown complete. Goodbye.`);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
