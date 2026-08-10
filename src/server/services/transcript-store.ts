import fs from 'node:fs';
import path from 'node:path';
import { SessionRecord } from '../types.js';
import {
  ensureWorkspaceSessionDirectory,
  hasWorkspaceSessionStorage,
  workspaceSessionAccessDirectory,
  workspaceSessionDirectory,
  WorkspaceSessionStorageRef,
} from './workspace-session-storage.js';
import {
  appendSessionFile,
  openSessionFileForRead,
  replaceSessionFile,
  statSessionFile,
  unlinkSessionEntry,
} from './safe-session-file.js';

export interface TranscriptStoreOptions {
  storageDir: string;
  replayChunkSize?: number;
  /** Max bytes replayed to a client on join. */
  replayLimitBytes?: number;
  /** Transcript size above which the head is discarded on disk. */
  maxTranscriptBytes?: number;
}

export type TranscriptSessionRef = Pick<SessionRecord, 'id' | 'ownerUserId'> & WorkspaceSessionStorageRef;

export interface TranscriptStoreLike {
  ensureTranscript(session: TranscriptSessionRef): Promise<string>;
  appendOutput(session: TranscriptSessionRef, data: string): void;
  flush?(session: TranscriptSessionRef): Promise<void>;
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
  private readonly writeErrors = new Map<string, unknown>();
  private readonly appendedSinceCheck: Map<string, number>;
  private readonly pendingBatches = new Map<string, { session: TranscriptSessionRef; chunks: Buffer[]; check: boolean }>();

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
    const workspaceDir = workspaceSessionDirectory(session);
    if (workspaceDir) {
      return path.join(workspaceDir, 'transcript.md');
    }
    return path.join(
      this.transcriptDir,
      String(session.ownerUserId),
      `${session.id}.md`,
    );
  }

  private getTranscriptAccessPath(session: TranscriptSessionRef): string {
    const workspaceDir = workspaceSessionAccessDirectory(session);
    return workspaceDir
      ? path.join(workspaceDir, 'transcript.md')
      : this.getTranscriptPath(session);
  }

  async ensureTranscript(session: TranscriptSessionRef): Promise<string> {
    const visiblePath = this.getTranscriptPath(session);
    const transcriptPath = this.getTranscriptAccessPath(session);
    await ensureWorkspaceSessionDirectory(session);
    if (!hasWorkspaceSessionStorage(session)) {
      await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
    }
    await appendSessionFile(transcriptPath, '');
    this.writeErrors.delete(transcriptPath);
    return visiblePath;
  }

  appendOutput(session: TranscriptSessionRef, data: string): void {
    if (!data) {
      return;
    }
    if (session.persistenceUnavailable) {
      console.error(`Refusing transcript append for session ${session.id}: ${session.persistenceUnavailable}`);
      return;
    }

    const transcriptPath = this.getTranscriptAccessPath(session);
    const buffered = this.pendingBatches.get(transcriptPath);
    const previous = this.pendingWrites.get(transcriptPath)?.catch(() => undefined)
      || Promise.resolve();

    // Only stat once per ~1MB appended rather than on every PTY chunk.
    const appended =
      (this.appendedSinceCheck.get(transcriptPath) || 0) + Buffer.byteLength(data, 'utf8');
    const shouldCheckSize = appended >= 1024 * 1024;
    this.appendedSinceCheck.set(transcriptPath, shouldCheckSize ? 0 : appended);

    if (buffered) {
      buffered.chunks.push(Buffer.from(data, 'utf8'));
      buffered.check ||= shouldCheckSize;
      return;
    }
    this.pendingBatches.set(transcriptPath, {
      session, chunks: [Buffer.from(data, 'utf8')], check: shouldCheckSize,
    });

    const next = previous.then(async () => {
      // Coalesce all output delivered in the same event-loop turn. On the cwd
      // helper backend this avoids a blocking process launch/fsync per PTY
      // chunk while retaining the existing per-session ordering contract.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const batch = this.pendingBatches.get(transcriptPath);
      if (!batch) return;
      this.pendingBatches.delete(transcriptPath);
      await ensureWorkspaceSessionDirectory(session);
      if (!hasWorkspaceSessionStorage(session)) {
        await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
      }
      const bytes = Buffer.concat(batch.chunks);
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        await appendSessionFile(transcriptPath, bytes.subarray(offset, offset + 1024 * 1024));
      }
      if (batch.check) {
        await this.truncateHeadIfOversized(transcriptPath);
      }
    });

    this.pendingWrites.set(transcriptPath, next);

    void next.then(
      () => this.writeErrors.delete(transcriptPath),
      (error) => {
        this.writeErrors.set(transcriptPath, error);
        console.error(`Failed to append transcript for session ${session.id}:`, error);
      },
    );
  }

  async readTranscriptChunks(session: TranscriptSessionRef): Promise<string[]> {
    const transcriptPath = this.getTranscriptAccessPath(session);
    await this.flushPath(transcriptPath);

    let contents = '';
    try {
      // Read only the tail: an unbounded transcript would otherwise be
      // materialised in full and shipped in one WebSocket frame on every join.
      const handle = await openSessionFileForRead(transcriptPath);
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
      const stat = await statSessionFile(transcriptPath);
      if (!stat) return;
      const { size } = stat;
      if (size <= this.maxTranscriptBytes) {
        return;
      }

      const keep = Math.floor(this.maxTranscriptBytes / 2);
      const handle = await openSessionFileForRead(transcriptPath);
      let tail: Buffer;
      try {
        tail = Buffer.alloc(keep);
        await handle.read(tail, 0, keep, size - keep);
      } finally {
        await handle.close();
      }

      await replaceSessionFile(
        transcriptPath,
        `[... earlier output trimmed ...]\n${tail.toString('utf8')}`,
        'utf8',
      );
    } catch (error) {
      console.error(`Failed to trim transcript ${transcriptPath}:`, error);
    }
  }

  async deleteTranscript(session: TranscriptSessionRef): Promise<void> {
    const transcriptPath = this.getTranscriptAccessPath(session);
    await this.flushPath(transcriptPath);

    try {
      await unlinkSessionEntry(transcriptPath);
    } catch (error) {
      console.error(`Failed to delete transcript for session ${session.id}:`, error);
    } finally {
      this.pendingWrites.delete(transcriptPath);
      this.writeErrors.delete(transcriptPath);
    }
  }

  async flush(session: TranscriptSessionRef): Promise<void> {
    await this.flushPath(this.getTranscriptAccessPath(session));
  }

  private async flushPath(transcriptPath: string): Promise<void> {
    const pending = this.pendingWrites.get(transcriptPath);
    if (pending) await pending;
    const failed = this.writeErrors.get(transcriptPath);
    if (failed) throw failed;
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
