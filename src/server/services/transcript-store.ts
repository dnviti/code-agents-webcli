import fs from 'node:fs';
import path from 'node:path';
import { SessionRecord } from '../types.js';

export interface TranscriptStoreOptions {
  storageDir: string;
  replayChunkSize?: number;
  /** Max bytes replayed to a client on join. */
  replayLimitBytes?: number;
  /** Transcript size above which the head is discarded on disk. */
  maxTranscriptBytes?: number;
}

export type TranscriptSessionRef = Pick<SessionRecord, 'id' | 'ownerUserId'>;

export interface TranscriptStoreLike {
  ensureTranscript(session: TranscriptSessionRef): Promise<string>;
  appendOutput(session: TranscriptSessionRef, data: string): void;
  readTranscriptChunks(session: TranscriptSessionRef): Promise<string[]>;
  deleteTranscript(session: TranscriptSessionRef): Promise<void>;
}

export class TranscriptStore implements TranscriptStoreLike {
  readonly storageDir: string;
  readonly transcriptDir: string;
  readonly replayChunkSize: number;
  readonly replayLimitBytes: number;
  readonly maxTranscriptBytes: number;
  private readonly pendingWrites: Map<string, Promise<void>>;
  private readonly appendedSinceCheck: Map<string, number>;

  constructor(options: TranscriptStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.transcriptDir = path.join(this.storageDir, 'transcripts');
    this.replayChunkSize = options.replayChunkSize || 64 * 1024;
    this.replayLimitBytes = options.replayLimitBytes || 2 * 1024 * 1024;
    this.maxTranscriptBytes = options.maxTranscriptBytes || 16 * 1024 * 1024;
    this.pendingWrites = new Map();
    this.appendedSinceCheck = new Map();
  }

  getTranscriptPath(session: TranscriptSessionRef): string {
    return path.join(
      this.transcriptDir,
      String(session.ownerUserId),
      `${session.id}.md`,
    );
  }

  async ensureTranscript(session: TranscriptSessionRef): Promise<string> {
    const transcriptPath = this.getTranscriptPath(session);
    await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
    const handle = await fs.promises.open(transcriptPath, 'a');
    await handle.close();
    return transcriptPath;
  }

  appendOutput(session: TranscriptSessionRef, data: string): void {
    if (!data) {
      return;
    }

    const transcriptPath = this.getTranscriptPath(session);
    const previous = this.pendingWrites.get(transcriptPath) || Promise.resolve();

    // Only stat once per ~1MB appended rather than on every PTY chunk.
    const appended =
      (this.appendedSinceCheck.get(transcriptPath) || 0) + Buffer.byteLength(data, 'utf8');
    const shouldCheckSize = appended >= 1024 * 1024;
    this.appendedSinceCheck.set(transcriptPath, shouldCheckSize ? 0 : appended);

    const next = previous.then(async () => {
      await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.promises.appendFile(transcriptPath, data, 'utf8');
      if (shouldCheckSize) {
        await this.truncateHeadIfOversized(transcriptPath);
      }
    });

    this.pendingWrites.set(transcriptPath, next.catch(() => undefined));

    void next.catch((error) => {
      console.error(`Failed to append transcript for session ${session.id}:`, error);
    });
  }

  async readTranscriptChunks(session: TranscriptSessionRef): Promise<string[]> {
    const transcriptPath = this.getTranscriptPath(session);
    await this.flush(transcriptPath);

    let contents = '';
    try {
      // Read only the tail: an unbounded transcript would otherwise be
      // materialised in full and shipped in one WebSocket frame on every join.
      const handle = await fs.promises.open(transcriptPath, 'r');
      try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - this.replayLimitBytes);
        const length = size - start;
        if (length > 0) {
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, start);
          contents = buffer.toString('utf8');
        }
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    if (!contents) {
      return [];
    }

    return chunkString(contents, this.replayChunkSize);
  }

  /** Drop the oldest half once a transcript exceeds the cap. */
  private async truncateHeadIfOversized(transcriptPath: string): Promise<void> {
    try {
      const { size } = await fs.promises.stat(transcriptPath);
      if (size <= this.maxTranscriptBytes) {
        return;
      }

      const keep = Math.floor(this.maxTranscriptBytes / 2);
      const handle = await fs.promises.open(transcriptPath, 'r');
      let tail: Buffer;
      try {
        tail = Buffer.alloc(keep);
        await handle.read(tail, 0, keep, size - keep);
      } finally {
        await handle.close();
      }

      const tmpPath = `${transcriptPath}.${process.pid}.tmp`;
      await fs.promises.writeFile(
        tmpPath,
        `[... earlier output trimmed ...]\n${tail.toString('utf8')}`,
        'utf8',
      );
      await fs.promises.rename(tmpPath, transcriptPath);
    } catch (error) {
      console.error(`Failed to trim transcript ${transcriptPath}:`, error);
    }
  }

  async deleteTranscript(session: TranscriptSessionRef): Promise<void> {
    const transcriptPath = this.getTranscriptPath(session);
    await this.flush(transcriptPath);

    try {
      await fs.promises.rm(transcriptPath, { force: true });
    } catch (error) {
      console.error(`Failed to delete transcript for session ${session.id}:`, error);
    } finally {
      this.pendingWrites.delete(transcriptPath);
    }
  }

  private async flush(transcriptPath: string): Promise<void> {
    const pending = this.pendingWrites.get(transcriptPath);
    if (pending) {
      await pending.catch(() => undefined);
    }
  }
}

function chunkString(value: string, chunkSize: number): string[] {
  if (!value) {
    return [];
  }

  if (value.length <= chunkSize) {
    return [value];
  }

  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

export default TranscriptStore;
