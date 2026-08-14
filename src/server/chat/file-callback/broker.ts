import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';

import {
  assertBrokerLayout,
  pruneStaleEndpoints,
  removeKnownEndpoint,
} from './broker-layout.js';
import {
  atomicEncrypted,
  directoryRef,
  makeChildDirectory,
  readEncrypted,
  safeCleanupFlat,
  safeUnlink,
  setDirectoryMode,
  withDirectory,
  writeExclusivePlain,
} from './fs.js';
import {
  aad,
  AAD_PREFIX,
  BrokerLayout,
  cancelName,
  DEFAULT_CLEANUP_MS,
  DEFAULT_POLL_MS,
  FileCallbackBrokerOptions,
  FileCallbackEndpoint,
  FileCallbackHandler,
  FileCallbackRequest,
  FileCallbackReply,
  HEARTBEAT_MS,
  ID,
  InvalidCallbackEnvelopeError,
  MAX_LEASE_MS,
  replyName,
} from './types.js';

/** Host-side half. Keep one instance per chat session. */
export class FileCallbackBroker {
  private endpoint_: FileCallbackEndpoint | null = null;
  private layout: BrokerLayout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, AbortController>();
  private polling = false;
  private compromised = false;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly cleanupAfterMs: number;
  private readonly testHooks: FileCallbackBrokerOptions['testHooks'];

  constructor(private readonly sharedHome: string, options: FileCallbackBrokerOptions = {}) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.cleanupAfterMs = options.cleanupAfterMs ?? DEFAULT_CLEANUP_MS;
    this.testHooks = options.testHooks;
  }

  get endpoint(): FileCallbackEndpoint | null { return this.endpoint_; }

  async listen(handler: FileCallbackHandler): Promise<FileCallbackEndpoint> {
    if (this.endpoint_) return this.endpoint_;
    const home = await directoryRef(path.resolve(this.sharedHome));
    const base = await makeChildDirectory(home, '.ccweb-callback', true);
    await pruneStaleEndpoints(base, Date.now() - this.cleanupAfterMs);
    const endpoint = await makeChildDirectory(base, crypto.randomBytes(16).toString('hex'), false);
    const [requests, replies, cancelled] = await Promise.all([
      makeChildDirectory(endpoint, 'requests', false),
      makeChildDirectory(endpoint, 'replies', false),
      makeChildDirectory(endpoint, 'cancelled', false),
    ]);
    const pi = await makeChildDirectory(endpoint, '.pi', false);
    const piCcweb = await makeChildDirectory(pi, 'ccweb', false);
    this.layout = { base, endpoint, requests, replies, cancelled, pi, piCcweb };
    await writeExclusivePlain(piCcweb, 'ask-user.ts', '');
    await writeExclusivePlain(
      piCcweb,
      '.gitignore',
      [
        '# Written by code-agents-webcli: generated tools for this session.',
        '# Regenerated on every launch; nothing here is yours to keep.',
        '*',
        '',
      ].join('\n'),
    );
    await setDirectoryMode(this.layout.pi, 0o500);
    // Runtime artifacts are populated later, but their names are claimed now.
    // Sealing the parent here removes the validation-to-open window in which a
    // filesystem peer could replace requests/replies/cancelled. The bridge is
    // subsequently filled through this pre-created, O_NOFOLLOW file.
    await writeExclusivePlain(endpoint, 'ccweb-mcp.mjs', '');
    await setDirectoryMode(this.layout.piCcweb, 0o500);
    await setDirectoryMode(this.layout.endpoint, 0o500);
    this.endpoint_ = { directory: endpoint.path, token: crypto.randomBytes(32).toString('base64url') };
    await this.heartbeat();
    await this.lease();
    this.timer = setInterval(() => {
      void this.poll(handler).catch((error) => this.failClosed(error));
    }, this.pollMs);
    this.timer.unref();
    // Kept separate from the request poll: a question handler can intentionally
    // remain pending for hours, but a runtime must still be able to distinguish
    // that healthy wait from a server that disappeared underneath it.
    this.heartbeatTimer = setInterval(() => {
      if (this.active.size > 0) {
        void this.heartbeat().catch((error) => this.failClosed(error));
      }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
    // An idle but live chat must not look like a crashed endpoint to another
    // server sharing the same persistent home. Keep a low-frequency lease;
    // aggressive cleanup intervals used by tests get a proportionally shorter
    // lease so the invariant remains true there as well.
    const leaseMs = Math.max(10, Math.min(MAX_LEASE_MS, Math.floor(this.cleanupAfterMs / 3)));
    this.leaseTimer = setInterval(() => {
      void this.lease().catch((error) => this.failClosed(error));
    }, leaseMs);
    this.leaseTimer.unref();
    await this.poll(handler);
    return this.endpoint_;
  }

  async close(): Promise<void> {
    this.stopTimers();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    const layout = this.layout;
    this.endpoint_ = null;
    this.layout = null;
    if (layout) await removeKnownEndpoint(layout).catch(() => undefined);
  }

  private stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    this.leaseTimer = null;
  }

  private failClosed(_error: unknown): void {
    if (this.compromised) return;
    this.compromised = true;
    this.stopTimers();
    for (const controller of this.active.values()) controller.abort();
  }

  private async heartbeat(): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout || this.compromised) return;
    await assertBrokerLayout(layout);
    await atomicEncrypted(
      layout.replies,
      path.join(layout.replies.path, 'heartbeat.json'),
      endpoint.token,
      `${AAD_PREFIX}heartbeat`,
      { ts: Date.now() },
    );
  }

  private async lease(): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout || this.compromised) return;
    await assertBrokerLayout(layout);
    await atomicEncrypted(
      layout.replies,
      path.join(layout.replies.path, 'lease.json'),
      endpoint.token,
      `${AAD_PREFIX}lease`,
      { ts: Date.now() },
    );
  }

  private async poll(handler: FileCallbackHandler): Promise<void> {
    if (this.polling || !this.endpoint_ || !this.layout || this.compromised) return;
    this.polling = true;
    try {
      const endpoint = this.endpoint_;
      const layout = this.layout;
      await assertBrokerLayout(layout);
      const entries = await withDirectory(
        layout.requests,
        'read',
        async (opened) => fsp.readdir(opened.accessPath),
      );
      await Promise.all(entries.filter((entry) => entry.endsWith('.json')).map(async (entry) => {
        const id = entry.slice(0, -5);
        if (!ID.test(id) || this.active.has(id)) return;
        const file = path.join(layout.requests.path, entry);
        let raw: Partial<FileCallbackRequest> | null;
        try {
          raw = await readEncrypted(layout.requests, file, endpoint.token, aad('request', id)) as
            Partial<FileCallbackRequest> | null;
        } catch (error) {
          if (error instanceof InvalidCallbackEnvelopeError) {
            await safeUnlink(layout.requests, file);
            return;
          }
          throw error;
        }
        if (!raw || raw.id !== id || typeof raw.kind !== 'string' || typeof raw.createdAt !== 'number') {
          await safeUnlink(layout.requests, file);
          return;
        }
        // A request left by a stopped pod must never be revived by a later
        // session merely because it happens to be scanning the same home.
        if (raw.createdAt < Date.now() - this.cleanupAfterMs) {
          await safeUnlink(layout.requests, file);
          return;
        }
        const controller = new AbortController();
        this.active.set(id, controller);
        void this.handleRequest(
          handler,
          { id, kind: raw.kind, payload: raw.payload, createdAt: raw.createdAt },
          controller,
          file,
          path.join(layout.cancelled.path, cancelName(id)),
        ).catch((error) => this.failClosed(error));
      }));
      await Promise.all([
        safeCleanupFlat(
          layout.requests,
          Date.now() - this.cleanupAfterMs,
          this.testHooks?.afterDirectoryOpened,
          (entry) => entry.endsWith('.json') && this.active.has(entry.slice(0, -5)),
        ),
        safeCleanupFlat(
          layout.replies,
          Date.now() - this.cleanupAfterMs,
          this.testHooks?.afterDirectoryOpened,
        ),
        safeCleanupFlat(
          layout.cancelled,
          Date.now() - this.cleanupAfterMs,
          this.testHooks?.afterDirectoryOpened,
        ),
      ]);
    } finally {
      this.polling = false;
    }
  }

  private async handleRequest(
    handler: FileCallbackHandler,
    request: FileCallbackRequest,
    controller: AbortController,
    requestFile: string,
    cancelFile: string,
  ): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout) return;
    const checkCancellation = async () => {
      try {
        const marker = await readEncrypted(
          layout.cancelled,
          cancelFile,
          endpoint.token,
          aad('cancel', request.id),
        ) as { id?: unknown } | null;
        if (marker?.id === request.id) controller.abort();
      } catch (error) {
        if (error instanceof InvalidCallbackEnvelopeError) {
          await safeUnlink(layout.cancelled, cancelFile);
          return;
        }
        controller.abort();
        this.failClosed(error);
      }
    };
    const cancelPoll = setInterval(() => { void checkCancellation(); }, this.pollMs);
    cancelPoll.unref();
    const timeout = request.kind === 'question' || this.requestTimeoutMs === undefined
      ? null
      : setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout?.unref();
    try {
      const result = await Promise.race([
        handler(request, controller.signal),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener(
          'abort', () => reject(new Error('file callback cancelled')), { once: true },
        )),
      ]);
      await this.reply(request.id, controller.signal.aborted ? { cancelled: true } : { result });
    } catch (error: unknown) {
      await this.reply(request.id, controller.signal.aborted
        ? { cancelled: true }
        : { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(cancelPoll);
      if (timeout) clearTimeout(timeout);
      this.active.delete(request.id);
      await safeUnlink(layout.requests, requestFile).catch(() => undefined);
      await safeUnlink(layout.cancelled, cancelFile).catch(() => undefined);
    }
  }

  private async reply(id: string, reply: Omit<FileCallbackReply, 'id'>): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout) return;
    await atomicEncrypted(
      layout.replies,
      path.join(layout.replies.path, replyName(id)),
      endpoint.token,
      aad('reply', id),
      { id, ...reply },
    );
  }
}
