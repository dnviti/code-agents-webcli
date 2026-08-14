import * as crypto from 'crypto';
import * as path from 'path';

import {
  assertDirectory,
  atomicEncrypted,
  directoryRef,
  openChildDirectory,
  readEncrypted,
  safeUnlink,
  withDirectory,
} from './fs.js';
import {
  aad,
  AAD_PREFIX,
  cancelName,
  ClientLayout,
  DEFAULT_POLL_MS,
  FileCallbackClientOptions,
  FileCallbackEndpoint,
  FileCallbackKind,
  FileCallbackReply,
  FileCallbackRequest,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  OpenDirectory,
  replyName,
  requestName,
} from './types.js';

async function captureClientLayout(directory: string): Promise<ClientLayout> {
  const base = await directoryRef(path.dirname(directory));
  return withDirectory(base, 'read', async (openedBase) => {
    const openedEndpoint = await openChildDirectory(openedBase, path.basename(directory));
    try {
      const endpoint = { path: directory, ...openedEndpoint.identity };
      const openedChildren: OpenDirectory[] = [];
      try {
        for (const name of ['requests', 'replies', 'cancelled']) {
          openedChildren.push(await openChildDirectory(openedEndpoint, name));
        }
        return {
          base,
          endpoint,
          requests: { path: path.join(directory, 'requests'), ...openedChildren[0].identity },
          replies: { path: path.join(directory, 'replies'), ...openedChildren[1].identity },
          cancelled: { path: path.join(directory, 'cancelled'), ...openedChildren[2].identity },
        };
      } finally {
        await Promise.all(openedChildren.map((opened) => opened.handle.close()));
      }
    } finally {
      await openedEndpoint.handle.close();
    }
  });
}

async function assertClientLayout(layout: ClientLayout): Promise<void> {
  await Promise.all([
    assertDirectory(layout.base),
    assertDirectory(layout.endpoint),
    assertDirectory(layout.requests),
    assertDirectory(layout.replies),
    assertDirectory(layout.cancelled),
  ]);
}

/** Runtime-side half; safe to use from a generated stdio MCP bridge. */
export async function requestFileCallback(
  endpoint: FileCallbackEndpoint,
  kind: FileCallbackKind,
  payload: unknown,
  options: FileCallbackClientOptions = {},
): Promise<unknown> {
  const layout = await captureClientLayout(endpoint.directory);
  await assertClientLayout(layout);
  const id = crypto.randomBytes(16).toString('base64url');
  const request = path.join(layout.requests.path, requestName(id));
  const reply = path.join(layout.replies.path, replyName(id));
  const cancel = path.join(layout.cancelled.path, cancelName(id));
  const heartbeat = path.join(layout.replies.path, 'heartbeat.json');
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs;
  let stopped = false;
  let requestWritten = false;
  let succeeded = false;
  const cancelRequest = () => {
    if (!stopped) {
      void atomicEncrypted(
        layout.cancelled,
        cancel,
        endpoint.token,
        aad('cancel', id),
        { id, cancelledAt: Date.now() },
        options.testHooks?.afterDirectoryOpened,
      ).catch(() => undefined);
    }
  };
  options.signal?.addEventListener('abort', cancelRequest, { once: true });
  let lastPulse: number | null = null;
  let lastPulseChange = Date.now();
  // A generic legacy timeout must never become a human-think-time deadline.
  // Tests and non-question operations may still opt into a finite ceiling.
  const deadline = kind === 'question' || timeoutMs === undefined ? null : Date.now() + timeoutMs;
  let nextLivenessCheck = Date.now() + HEARTBEAT_STALE_MS;
  try {
    requestWritten = true;
    await atomicEncrypted(
      layout.requests,
      request,
      endpoint.token,
      aad('request', id),
      { id, kind, payload, createdAt: Date.now() } satisfies FileCallbackRequest,
      options.testHooks?.afterDirectoryOpened,
    );
    const initialPulse = await readEncrypted(
      layout.replies,
      heartbeat,
      endpoint.token,
      `${AAD_PREFIX}heartbeat`,
      options.testHooks?.afterDirectoryOpened,
    ) as { ts?: unknown } | null;
    lastPulse = typeof initialPulse?.ts === 'number' ? initialPulse.ts : null;
    while (deadline === null || Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error('file callback cancelled');
      const raw = await readEncrypted(
        layout.replies,
        reply,
        endpoint.token,
        aad('reply', id),
        options.testHooks?.afterDirectoryOpened,
      ) as
        Partial<FileCallbackReply> | null;
      if (raw) {
        if (raw.id !== id) throw new Error('file callback received an invalid reply');
        if (raw.cancelled) throw new Error('file callback cancelled');
        if (raw.error) throw new Error(raw.error);
        succeeded = true;
        return raw.result;
      }
      if (Date.now() >= nextLivenessCheck) {
        const pulse = await readEncrypted(
          layout.replies,
          heartbeat,
          endpoint.token,
          `${AAD_PREFIX}heartbeat`,
          options.testHooks?.afterDirectoryOpened,
        ) as { ts?: unknown } | null;
        if (!pulse || typeof pulse.ts !== 'number') {
          throw new Error('file callback server is unavailable');
        }
        if (pulse.ts !== lastPulse) {
          lastPulse = pulse.ts;
          lastPulseChange = Date.now();
        } else if (Date.now() - lastPulseChange >= HEARTBEAT_STALE_MS) {
          throw new Error('file callback server is unavailable');
        }
        nextLivenessCheck = Date.now() + HEARTBEAT_MS;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error('file callback timed out');
  } finally {
    stopped = true;
    options.signal?.removeEventListener('abort', cancelRequest);
    if (requestWritten && !succeeded) {
      await atomicEncrypted(
        layout.cancelled,
        cancel,
        endpoint.token,
        aad('cancel', id),
        { id, cancelledAt: Date.now() },
        options.testHooks?.afterDirectoryOpened,
      ).catch(() => undefined);
    }
    await safeUnlink(layout.requests, request, options.testHooks?.afterDirectoryOpened).catch(() => undefined);
    await safeUnlink(layout.replies, reply, options.testHooks?.afterDirectoryOpened).catch(() => undefined);
  }
}
