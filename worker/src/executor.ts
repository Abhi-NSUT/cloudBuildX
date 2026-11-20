import fs from 'fs/promises';
import path from 'path';
import { PassThrough } from 'stream';
import simpleGit from 'simple-git';
import yaml from 'js-yaml';
import { docker } from './clients';
import { setContainer, clearContainer, throwIfCancelled } from './cancellation';
import { BuildLog } from './buildLog';
import { logger } from './logger';

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const CPU_QUOTA = 50_000; // 50% of one core (default period is 100000)

// A failure caused by the user's build itself (bad repo, non-zero exit, timeout).
// Retrying would just fail again, so these are final.
export class BuildError extends Error {}

export interface BuildConfig {
  image: string;
  commands: string[];
}

const DEFAULT_CONFIG: BuildConfig = { image: 'node:18-alpine', commands: ['npm install', 'npm run build'] };

export const cloneRepository = async (repositoryUrl: string, commitHash: string | null, workspaceDir: string) => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    await simpleGit().clone(repositoryUrl, workspaceDir);
    if (commitHash) await simpleGit(workspaceDir).checkout(commitHash);
  } catch (err: any) {
    throw new BuildError(`Could not clone repository: ${err.message}`);
  }
};

// Pipeline-as-code: an optional build.yml in the repo overrides the image and commands.
export const loadBuildConfig = async (workspaceDir: string): Promise<BuildConfig> => {
  try {
    const parsed = yaml.load(await fs.readFile(path.join(workspaceDir, 'build.yml'), 'utf8')) as any;
    return {
      image: typeof parsed?.image === 'string' ? parsed.image : DEFAULT_CONFIG.image,
      commands: Array.isArray(parsed?.commands) ? parsed.commands : DEFAULT_CONFIG.commands,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
};

const pullImage = (image: string) =>
  new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: any, stream: any) => {
      if (err) return reject(new Error(`Failed to pull image ${image}: ${err.message}`));
      docker.modem.followProgress(stream, (followErr: any) => (followErr ? reject(followErr) : resolve()));
    });
  });

// Runs the build inside a fresh, resource-limited container and streams its
// output to the build log. Resolves when the commands exit with code 0.
export const runInContainer = async (
  buildId: string,
  workspaceDir: string,
  config: BuildConfig,
  log: BuildLog,
  heartbeat: () => Promise<unknown>
) => {
  await pullImage(config.image);

  const container = await docker.createContainer({
    Image: config.image,
    Cmd: ['/bin/sh', '-c', config.commands.join(' && ')],
    WorkingDir: '/workspace',
    HostConfig: {
      Binds: [`${workspaceDir}:/workspace`],
      Memory: MEMORY_LIMIT_BYTES,
      CpuQuota: CPU_QUOTA,
      SecurityOpt: ['no-new-privileges:true'],
      AutoRemove: false, // we need the exit code first
    },
  });
  setContainer(buildId, container);

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    // Cancelled while the image was pulling or the container was being created
    throwIfCancelled(buildId);
    await container.start();

    // Demultiplex Docker's combined stream into stdout and stderr
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const forward = (write: (text: string) => void) => (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      write(text);
      void heartbeat(); // keeps the BullMQ job lock alive during long builds
    };
    stdout.on('data', forward((t) => log.stdout(t)));
    stderr.on('data', forward((t) => log.stderr(t)));
    container.modem.demuxStream(
      await container.logs({ follow: true, stdout: true, stderr: true }),
      stdout,
      stderr
    );

    const exitCode = await Promise.race([
      container.wait().then((data) => data.StatusCode as number),
      new Promise<number>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          logger.warn('Build timed out, killing container', { buildId });
          container.kill().catch(() => {});
          reject(new BuildError('Build timed out after 10 minutes'));
        }, BUILD_TIMEOUT_MS);
      }),
    ]);

    throwIfCancelled(buildId);
    if (exitCode !== 0) throw new BuildError(`Build failed with exit code ${exitCode}`);
  } finally {
    // Always clear the timer, otherwise it fires later on a removed container
    clearTimeout(timeoutHandle);
    clearContainer(buildId);
    await container.remove({ force: true }).catch(() => {});
  }
};
