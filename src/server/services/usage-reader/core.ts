import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream } from 'fs';

import { READ_CONCURRENCY, mapWithConcurrency } from './utils.js';
import type {
  OverlappingSession,
  UsageEntry,
  UsageStats,
} from './types.js';

/**
 * Bottom layer of the `UsageReader` inheritance chain: owns every instance
 * field plus the transcript-file discovery / parsing / caching primitives the
 * stats- and session-facing layers build on.
 */
export abstract class UsageReaderCore {
  protected claudeProjectsPath: string;
  protected cache: UsageStats | null = null;
  protected cacheTime: number | null = null;
  protected cacheTimeout: number = 5000;
  protected sessionDurationHours: number;
  protected overlappingSessions: Array<{
    session1: OverlappingSession;
    session2: OverlappingSession;
    overlapStart: Date;
    overlapEnd: Date;
  }> = [];

  /** Parsed entries per file, invalidated when the file's mtime or size changes. */
  protected fileCache = new Map<
    string,
    { mtimeMs: number; size: number; entries: UsageEntry[] }
  >();
  protected entriesCache: UsageEntry[] | null = null;
  protected entriesCacheTime = 0;
  protected entriesCacheTimeout = 5000;
  protected entriesCachePromise: Promise<UsageEntry[]> | null = null;

  constructor(sessionDurationHours: number = 5) {
    this.claudeProjectsPath = path.join(
      process.env.HOME || '',
      '.claude',
      'projects',
    );
    this.sessionDurationHours = sessionDurationHours;
  }

  /**
   * Read the whole corpus once and slice by cutoff in memory. Every usage poll
   * used to trigger four independent full scans that streamed and JSON.parsed
   * every line of every project transcript.
   */
  async getAllEntries(): Promise<UsageEntry[]> {
    const now = Date.now();
    if (
      this.entriesCache &&
      now - this.entriesCacheTime < this.entriesCacheTimeout
    ) {
      return this.entriesCache;
    }
    if (this.entriesCachePromise) {
      return this.entriesCachePromise;
    }

    this.entriesCachePromise = (async () => {
      try {
        const files = await this.findJsonlFiles();
        // Bounded concurrency: one read stream per file at once would exhaust
        // file descriptors (EMFILE) on a large corpus and spike latency.
        const perFile = await mapWithConcurrency(
          files,
          READ_CONCURRENCY,
          (file) => this.readJsonlFileCached(file),
        );

        // Deduplicate across the whole corpus: the same message can appear in
        // more than one transcript, and a per-file set double counts it.
        const seen = new Set<string>();
        const entries: UsageEntry[] = [];
        for (const fileEntries of perFile) {
          for (const entry of fileEntries) {
            const hash =
              entry.messageId && entry.requestId
                ? `${entry.messageId}:${entry.requestId}`
                : null;
            if (hash) {
              if (seen.has(hash)) continue;
              seen.add(hash);
            }
            entries.push(entry);
          }
        }

        entries.sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const live = new Set(files);
        for (const key of this.fileCache.keys()) {
          if (!live.has(key)) this.fileCache.delete(key);
        }

        this.entriesCache = entries;
        this.entriesCacheTime = Date.now();
        return entries;
      } finally {
        this.entriesCachePromise = null;
      }
    })();

    return this.entriesCachePromise;
  }

  /** Re-parse a transcript only when it actually changed. */
  protected async readJsonlFileCached(filePath: string): Promise<UsageEntry[]> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const cached = this.fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries;
    }

    const entries = await this.readJsonlFile(filePath, new Date(0));
    this.fileCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries,
    });
    return entries;
  }

  normalizeModelName(model: string | undefined | null): string {
    if (!model || typeof model !== 'string') {
      return 'unknown';
    }

    const modelLower = model.toLowerCase();

    if (modelLower.includes('opus')) {
      return 'opus';
    } else if (modelLower.includes('sonnet')) {
      return 'sonnet';
    } else if (modelLower.includes('haiku')) {
      return 'haiku';
    }

    return 'unknown';
  }

  createUniqueHash(
    entry: Record<string, unknown>,
  ): string | null {
    const messageId =
      (entry.message_id as string) ||
      (entry.messageId as string) ||
      ((entry.message as Record<string, unknown>)?.id as string) ||
      null;

    const requestId =
      (entry.request_id as string) ||
      (entry.requestId as string) ||
      null;

    if (messageId && requestId) {
      return `${messageId}:${requestId}`;
    }

    return null;
  }

  async readAllEntries(cutoffTime: Date): Promise<UsageEntry[]> {
    try {
      const all = await this.getAllEntries();
      const cutoff = cutoffTime.getTime();
      return all.filter(
        (entry) => new Date(entry.timestamp).getTime() >= cutoff,
      );
    } catch (error) {
      console.error('Error reading entries:', error);
      return [];
    }
  }

  async readRecentEntries(
    cutoffTime: Date,
  ): Promise<UsageEntry[]> {
    try {
      // Same corpus and same cache; the cutoff already restricts the range.
      return await this.readAllEntries(cutoffTime);
    } catch (error) {
      console.error('Error reading recent entries:', error);
      return [];
    }
  }

  async getMostRecentSessionFile(): Promise<string | null> {
    try {
      const cwd = process.cwd();
      const projectDirName = cwd.replace(/\//g, '-');
      const projectPath = path.join(
        this.claudeProjectsPath,
        projectDirName,
      );

      try {
        await fs.access(projectPath);
      } catch {
        console.log(
          `Project directory not found: ${projectPath}`,
        );
        return null;
      }

      const files = await fs.readdir(projectPath);
      const jsonlFiles = files.filter((f) =>
        f.endsWith('.jsonl'),
      );

      if (jsonlFiles.length === 0) {
        return null;
      }

      let mostRecentFile: string | null = null;
      let mostRecentTime = 0;

      for (const file of jsonlFiles) {
        const filePath = path.join(projectPath, file);
        const stat = await fs.stat(filePath);

        if (stat.mtime.getTime() > mostRecentTime) {
          mostRecentTime = stat.mtime.getTime();
          mostRecentFile = filePath;
        }
      }

      return mostRecentFile;
    } catch (error) {
      console.error(
        'Error finding most recent session file:',
        error,
      );
      return null;
    }
  }

  async findJsonlFiles(
    onlyRecent: boolean = false,
  ): Promise<string[]> {
    const files: string[] = [];

    // Walk the tree: subagent transcripts live in nested directories and a
    // single-level scan silently excluded them from every usage number.
    const walk = async (dir: string): Promise<void> => {
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // One unreadable directory must not abort the whole scan.
        return;
      }

      // Bounded concurrency here too: an unbounded recursive fan-out would
      // issue a stat per file across the whole tree at once.
      await mapWithConcurrency(dirents, READ_CONCURRENCY, async (dirent) => {
        const entryPath = path.join(dir, dirent.name);

        if (dirent.isDirectory()) {
          await walk(entryPath);
          return;
        }

        if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) {
          return;
        }

        if (!onlyRecent) {
          files.push(entryPath);
          return;
        }

        try {
          const fileStat = await fs.stat(entryPath);
          const hoursSinceModified =
            (Date.now() - fileStat.mtime.getTime()) / (1000 * 60 * 60);
          if (hoursSinceModified <= 24) {
            files.push(entryPath);
          }
        } catch {
          // Skip files that vanished mid-scan.
        }
      });
    };

    try {
      await walk(this.claudeProjectsPath);
    } catch (error) {
      console.error('Error finding JSONL files:', error);
    }

    return files;
  }

  async readJsonlFile(
    filePath: string,
    cutoffTime: Date,
  ): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];
    const fileProcessedEntries = new Set<string>();

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      rl.on('line', (line: string) => {
        try {
          const entry = JSON.parse(line) as Record<
            string,
            unknown
          >;

          if (
            entry.timestamp &&
            new Date(entry.timestamp as string) >= cutoffTime
          ) {
            const uniqueHash = this.createUniqueHash(entry);
            if (
              uniqueHash &&
              fileProcessedEntries.has(uniqueHash)
            ) {
              return;
            }

            const message = entry.message as
              | Record<string, unknown>
              | undefined;
            const usage = (entry.usage ||
              (message && message.usage)) as
              | Record<string, number>
              | undefined;
            const rawModel =
              (entry.model as string) ||
              (message && (message.model as string)) ||
              'unknown';
            const model = this.normalizeModelName(rawModel);

            const isAssistant =
              entry.type === 'assistant' ||
              (message && message.role === 'assistant');

            if (isAssistant && usage) {
              const inputTokens =
                usage.input_tokens || 0;
              const outputTokens =
                usage.output_tokens || 0;
              const cacheCreationTokens =
                usage.cache_creation_input_tokens || 0;
              const cacheReadTokens =
                usage.cache_read_input_tokens || 0;

              let totalCost = 0;
              if (model === 'opus') {
                totalCost =
                  inputTokens * 0.000015 +
                  outputTokens * 0.000075;
                totalCost +=
                  cacheCreationTokens * 0.000015 +
                  cacheReadTokens * 0.0000015;
              } else if (model === 'sonnet') {
                totalCost =
                  inputTokens * 0.000003 +
                  outputTokens * 0.000015;
                totalCost +=
                  cacheCreationTokens * 0.000003 +
                  cacheReadTokens * 0.0000003;
              } else if (model === 'haiku') {
                totalCost =
                  inputTokens * 0.00000025 +
                  outputTokens * 0.00000125;
                totalCost +=
                  cacheCreationTokens * 0.00000025 +
                  cacheReadTokens * 0.000000025;
              }

              let finalCost = totalCost;
              if (usage.total_cost !== undefined) {
                finalCost =
                  usage.total_cost > 1
                    ? usage.total_cost / 100
                    : usage.total_cost;
              }

              const processedEntry: UsageEntry = {
                timestamp: entry.timestamp as string,
                model,
                inputTokens,
                outputTokens,
                cacheCreationTokens,
                cacheReadTokens,
                totalCost: finalCost,
                sessionId: entry.sessionId as
                  | string
                  | undefined,
                messageId:
                  (entry.message_id as string) ||
                  (entry.messageId as string) ||
                  (message &&
                    (message.id as string)) ||
                  null,
                requestId:
                  (entry.request_id as string) ||
                  (entry.requestId as string) ||
                  null,
              };

              entries.push(processedEntry);

              if (uniqueHash) {
                fileProcessedEntries.add(uniqueHash);
              }
            }
          }
        } catch {
          // Ignore malformed lines
        }
      });

      rl.on('close', () => {
        resolve(entries);
      });

      rl.on('error', (error: Error) => {
        console.error('Error reading file:', filePath, error);
        resolve(entries);
      });
    });
  }
}
