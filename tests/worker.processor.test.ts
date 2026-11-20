import type { Job } from 'bullmq';

// Swap every side-effecting dependency of the worker for a mock.
jest.mock('../worker/src/clients', () => ({
  prisma: { build: { updateMany: jest.fn() } },
  WORKER_ID: 'worker-test',
  WORKSPACE_ROOT: '/tmp/cloudbuildx-test-workspaces',
}));
jest.mock('../worker/src/buildLog', () => ({
  BuildLog: jest.fn().mockImplementation((_id: string, filePath: string) => ({
    filePath,
    stdout: jest.fn(),
    stderr: jest.fn(),
    system: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../worker/src/artifacts', () => ({
  uploadArtifacts: jest.fn().mockResolvedValue(undefined),
  uploadLogFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../worker/src/executor', () => ({
  ...jest.requireActual('../worker/src/executor'), // keep the real BuildError class
  cloneRepository: jest.fn().mockResolvedValue(undefined),
  loadBuildConfig: jest.fn().mockResolvedValue({ image: 'node:18-alpine', commands: ['npm test'] }),
  runInContainer: jest.fn(),
}));
jest.mock('../worker/src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { processBuild } from '../worker/src/processor';
import { prisma } from '../worker/src/clients';
import { cloneRepository, runInContainer, BuildError } from '../worker/src/executor';

const updateMany = prisma.build.updateMany as jest.Mock;

const makeJob = (attemptsMade = 0, attempts = 3) =>
  ({
    id: 'job-1',
    data: { buildId: 'b1', repositoryUrl: 'https://github.com/x/y', commitHash: null },
    attemptsMade,
    opts: { attempts },
    updateProgress: jest.fn(),
  }) as unknown as Job;

const statusesWritten = () => updateMany.mock.calls.map(([args]) => args.data.status);

describe('worker processBuild', () => {
  it('skips a build that was cancelled while still queued', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 }); // claim finds no PENDING/RUNNING build

    await expect(processBuild(makeJob())).resolves.toBeUndefined();
    expect(cloneRepository).not.toHaveBeenCalled();
  });

  it('marks a failing build FAILED once and tells BullMQ not to retry it', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    (runInContainer as jest.Mock).mockRejectedValueOnce(new BuildError('Build failed with exit code 1'));

    // Matched by name: the test and the worker load different copies of bullmq
    await expect(processBuild(makeJob())).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(statusesWritten()).toEqual(['RUNNING', 'FAILED']);
  });

  it('puts the build back to PENDING and retries on an infrastructure error', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    (runInContainer as jest.Mock).mockRejectedValueOnce(new Error('Failed to pull image: registry timeout'));

    await expect(processBuild(makeJob(0, 3))).rejects.toThrow('registry timeout');
    expect(statusesWritten()).toEqual(['RUNNING', 'PENDING']);
  });
});
