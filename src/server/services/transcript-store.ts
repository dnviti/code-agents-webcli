import fs from 'node:fs';
import path from 'node:path';
import { SessionRecord } from '../types.js';

export interface TranscriptStoreOptions {
  storageDir: string;
  replayChunkSize?: number;
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
  private readonly pendingWrites: Map<string, Promise<void>>;

  constructor(options: TranscriptStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.transcriptDir = path.join(this.storageDir, 'transcripts');
    this.replayChunkSize = options.replayChunkSize || 64 * 1024;
    this.pendingWrites = new Map();
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
    const next = previous.then(async () => {
      await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.promises.appendFile(transcriptPath, data, 'utf8');
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
      contents = await fs.promises.readFile(transcriptPath, 'utf8');
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
