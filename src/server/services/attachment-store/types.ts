import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import type { ChatAttachment } from '../../../shared/chat-events.js';
import type { SessionStorageScope } from '../../types.js';
import type { WorkspaceEntryMutationPolicy } from '../workspace-session-storage.js';

export interface AttachmentSessionRef {
  id: string;
  ownerUserId: number;
  workingDir: string;
  /** Required explicitly so a caller cannot accidentally erase the namespace while reshaping a record. */
  projectId: string | null | undefined;
  /** Project paths use a different namespace and need a container-aware store. */
  projectWorkingDirKind: 'host' | 'container' | undefined;
  /** Immutable workspace that owns the attachment bytes named by global metadata. */
  storageScope?: SessionStorageScope;
  persistenceUnavailable?: string;
}

export interface StoredAttachment {
  /** The name the user's file had, sanitised. What the UI shows. */
  name: string;
  /** The name on disk, which is also the URL segment. Unguessable prefix. */
  storedName: string;
  absolutePath: string;
  /** Relative to the working directory, for prompts that quote a path. */
  relativePath: string;
  mime: string;
  bytes: number;
}

export interface AttachmentInput {
  filename: string;
  /** What the browser claimed. Trusted for display only, never for serving. */
  declaredMime: string;
  bytes: Buffer;
}

export interface AttachmentDeleteOptions {
  /** The caller already owns the ProjectManager lifecycle gate. */
  projectLifecycleExclusive?: boolean;
}

export interface AttachmentStoreLike {
  save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment>;
  flush?(session: AttachmentSessionRef): Promise<void>;
  /**
   * Copy one durable source attachment into a freshly-created branch namespace.
   *
   * Only the canonical source URL is used to select bytes. In particular,
   * `attachment.path` is never consulted: it came over the websocket and is
   * not authority for either workspace. The returned metadata is rebuilt from
   * the verified source inode and the newly-created target file.
   */
  cloneForBranch(
    source: AttachmentSessionRef,
    target: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment>;
  /** Remove only this owner/session namespace after a definitive session delete. */
  deleteSessionAttachments(
    session: AttachmentSessionRef,
    options?: AttachmentDeleteOptions,
  ): Promise<void>;
  resolve(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }>;
  /** Resolve wire metadata to the server-owned file it names; never accepts `attachment.path`. */
  resolveForTurn(
    session: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment>;
  /** Open the verified inode the response will stream; callers must not reopen `absolutePath`. */
  openForDownload(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ stream: Readable; serve: ServeKind; bytes: number }>;
}

/**
 * How a stored file may be handed back to a browser.
 *
 * Two outcomes only. A file whose bytes really are an image gets that image's
 * own type and renders inline, because a transcript with a picture in it is the
 * entire point of attaching one. Everything else is an opaque download, whatever
 * the uploader called it — serving a user-supplied `text/html` from the app's
 * own origin would be a stored XSS with a file picker in front of it.
 */
export interface ServeKind {
  contentType: string;
  inline: boolean;
  filename: string;
}

export interface AttachmentStoreOptions {
  maxBytes?: number;
  quotaBytes?: number;
  maxFiles?: number;
  randomId?: () => string;
  /** Force a backend in tests; an explicit pathname backend remains read-only. */
  directoryBackend?: AttachmentDirectoryBackend;
  /** Deterministic race injection for security tests; never set by production composition. */
  testHooks?: {
    afterDirectoryOpened?(operation: 'save' | 'resolve' | 'download' | 'delete'): void | Promise<void>;
    afterUsageScanned?(usage: { files: number; bytes: number }): void | Promise<void>;
    afterBranchCloneChunk?(pass: 'copy' | 'verify', bytesRead: number): void | Promise<void>;
    afterBranchCloneRead?(pass: 'copy' | 'verify'): void | Promise<void>;
  };
}

export type AttachmentDirectoryBackend = 'auto' | 'descriptor' | 'path';

export type ResolvedAttachmentDirectoryBackend = Exclude<AttachmentDirectoryBackend, 'auto'>;

export type CwdAttachmentStat = {
  identity: { dev: bigint; ino: bigint };
  size: number;
  nlink: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};

export interface AttachmentStorageIdentity {
  workspaceRoot: string;
  ownerKey: string;
  sessionId: string;
}

export interface AttachmentFileDirectory {
  backend: ResolvedAttachmentDirectoryBackend;
  descriptorRoot: string | null;
  mutationPolicy: WorkspaceEntryMutationPolicy;
  attachments: FileHandle;
  visibleDir: string;
}

export interface OpenAttachmentDirectory extends AttachmentFileDirectory {
  working: FileHandle;
  container: FileHandle;
  attachmentRoot: FileHandle;
  owner: FileHandle;
}

export interface OpenLegacyAttachmentDirectory extends AttachmentFileDirectory {
  working: FileHandle;
  container: FileHandle;
}

export type ReadableAttachmentDirectory = OpenAttachmentDirectory | OpenLegacyAttachmentDirectory;
