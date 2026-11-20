import * as fs from 'fs';
import { redis } from './clients';

export type FinalStatus = 'SUCCESS' | 'FAILED' | 'CANCELLED';

// Every line of build output goes to two places: live to the browser
// (Redis Pub/Sub -> API -> WebSocket) and into a log file that is uploaded
// to S3 at the end so finished builds can be replayed.
export class BuildLog {
  private readonly channel: string;
  private readonly file: fs.WriteStream;

  constructor(buildId: string, readonly filePath: string) {
    this.channel = `build-logs:${buildId}`;
    this.file = fs.createWriteStream(filePath, { flags: 'a' });
  }

  stdout(text: string) {
    this.publish({ type: 'info', text });
    this.file.write(`${text}\r\n`);
  }

  stderr(text: string) {
    this.publish({ type: 'error', text });
    this.file.write(`\x1b[31m${text}\x1b[0m\r\n`);
  }

  // System events carry an explicit final status so the UI never has to parse log text.
  system(text: string, status?: FinalStatus) {
    this.publish({ type: 'system', text, ...(status && { status }) });
    const colour = status === 'FAILED' || status === 'CANCELLED' ? 31 : 35;
    this.file.write(`\r\n\x1b[${colour}m[SYSTEM EVENT] ${text}\x1b[0m\r\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.file.end(resolve));
  }

  private publish(event: object) {
    void redis.publish(this.channel, JSON.stringify(event));
  }
}
