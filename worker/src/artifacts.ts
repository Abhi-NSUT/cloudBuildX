import * as fs from 'fs';
import { PassThrough } from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import archiver = require('archiver');
import { s3Client, BUCKET } from './clients';

// Zips the build workspace and streams it straight to S3 (no temp zip file on disk).
export const uploadArtifacts = async (buildId: string, workspaceDir: string) => {
  const archive = new (archiver as any).ZipArchive({ zlib: { level: 9 } });
  const body = new PassThrough();
  archive.pipe(body);

  const upload = new Upload({
    client: s3Client,
    params: { Bucket: BUCKET, Key: `builds/${buildId}.zip`, Body: body, ContentType: 'application/zip' },
  });

  archive.directory(workspaceDir, false);
  archive.finalize();
  await upload.done();
};

// Uploads the full build log so finished builds can be replayed in the UI.
export const uploadLogFile = (buildId: string, filePath: string) =>
  new Upload({
    client: s3Client,
    params: {
      Bucket: BUCKET,
      Key: `builds/${buildId}.log`,
      Body: fs.createReadStream(filePath),
      ContentType: 'text/plain',
    },
  }).done();
