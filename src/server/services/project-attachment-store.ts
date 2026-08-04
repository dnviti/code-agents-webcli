import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { ChatAttachment } from '../../shared/chat-events.js';
import {
  ATTACHMENT_DIR,
  ATTACHMENT_SUBDIR,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ATTACHMENTS,
  attachmentUrlFor,
  displayMime,
  safeName,
  serveKind,
  storedAttachmentNameFromUrl,
  type AttachmentInput,
  type AttachmentSessionRef,
  type AttachmentStoreLike,
  type ServeKind,
  type StoredAttachment,
} from './attachment-store.js';
import { ProjectContainerFiles } from './projects/container-files.js';
import {
  registerUnverifiedProjectProcess,
  releaseProjectSessionLease,
  restoreProjectWorkingDir,
  type ProjectSessionLease,
  type ProjectsSessionApi,
} from './projects/working-dir.js';

function errno(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Route chat attachments through the namespace that owns the session.
 *
 * Ordinary sessions keep the inode-bound host store. Project sessions first
 * acquire the same manager lease as the workspace routes; host checkouts use
 * that store only after admission, while container-only paths use fixed,
 * binary-safe project file helpers. No container path is ever interpreted as a
 * path on the web server.
 */
export class ProjectAwareAttachmentStore implements AttachmentStoreLike {
  constructor(
    private readonly host: AttachmentStoreLike,
    private readonly projects: ProjectsSessionApi,
    private readonly saveSessionsToDisk: () => Promise<boolean | void>,
  ) {}

  async save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment> {
    if (!session.projectId) return this.host.save(session, input);
    return this.withProjectStore(session, (store, admitted) => store.save(admitted, input));
  }

  async resolve(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }> {
    if (!session.projectId) return this.host.resolve(session, storedName);
    return this.withProjectStore(session, (store, admitted) => store.resolve(admitted, storedName));
  }

  async resolveForTurn(
    session: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    if (!session.projectId) return this.host.resolveForTurn(session, attachment);
    return this.withProjectStore(
      session,
      (store, admitted) => store.resolveForTurn(admitted, attachment),
    );
  }

  async openForDownload(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ stream: Readable; serve: ServeKind; bytes: number }> {
    if (!session.projectId) return this.host.openForDownload(session, storedName);

    // A returned host stream would outlive the project lease. Materialise the
    // bounded attachment while admitted, then serve the owned bytes after the
    // lease has been released. The upload route caps every file at 20 MiB.
    return this.withProjectStore(session, async (store, admitted) => {
      const opened = await store.openForDownload(admitted, storedName);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of opened.stream) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > DEFAULT_MAX_ATTACHMENT_BYTES) {
          opened.stream.destroy();
          throw errno('NOT_FOUND', 'attachment exceeded its stored limit');
        }
        chunks.push(value);
      }
      return { stream: Readable.from(Buffer.concat(chunks)), serve: opened.serve, bytes };
    });
  }

  private async withProjectStore<T>(
    session: AttachmentSessionRef,
    operation: (store: AttachmentStoreLike, admitted: AttachmentSessionRef) => Promise<T>,
  ): Promise<T> {
    const projectId = session.projectId;
    if (!projectId || !this.projects.getForUser(session.ownerUserId, projectId)) {
      throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', 'project is unavailable');
    }

    let lease: ProjectSessionLease | undefined;
    let retainLease = false;
    try {
      const prepared = await this.projects.ensureForSession(session.ownerUserId, projectId);
      if (!prepared.ok) {
        throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', `project is ${prepared.reason}`);
      }
      lease = { ownerUserId: session.ownerUserId, projectId, leaseId: prepared.leaseId };
      const cwd = await restoreProjectWorkingDir(
        this.projects,
        prepared,
        session.workingDir,
        session.projectWorkingDirKind,
      );
      const changed = session.workingDir !== cwd.workingDir
        || session.projectWorkingDirKind !== cwd.kind;
      session.workingDir = cwd.workingDir;
      session.projectWorkingDirKind = cwd.kind;
      if (changed) await this.saveSessionsToDisk();
      this.projects.touchActivity(projectId);

      if (cwd.kind === 'container') {
        const files = new ProjectContainerFiles(this.projects, prepared, cwd.workingDir);
        return operation(new ContainerAttachmentStore(files), session);
      }

      // The host store intentionally rejects project-shaped references. The
      // manager admission above is the authority that permits this exact host
      // checkout, so erase only the namespace flags for the delegated call.
      return operation(this.host, {
        id: session.id,
        ownerUserId: session.ownerUserId,
        workingDir: cwd.workingDir,
        projectId: undefined,
        projectWorkingDirKind: undefined,
      });
    } catch (error) {
      retainLease = registerUnverifiedProjectProcess(this.projects, lease, error);
      throw error;
    } finally {
      if (!retainLease) releaseProjectSessionLease(this.projects, lease);
    }
  }
}

class ContainerAttachmentStore implements AttachmentStoreLike {
  constructor(private readonly files: ProjectContainerFiles) {}

  async save(_session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment> {
    if (!input.bytes.length) throw errno('EMPTY_BODY', 'the upload had no body');
    if (input.bytes.length > DEFAULT_MAX_ATTACHMENT_BYTES) {
      throw errno('FILE_TOO_LARGE', 'attachment exceeded its stored limit');
    }

    const relativeDir = path.posix.join(ATTACHMENT_DIR, ATTACHMENT_SUBDIR);
    const usage = await this.usage(relativeDir);
    if (usage.files >= DEFAULT_MAX_ATTACHMENTS || usage.bytes + input.bytes.length > DEFAULT_ATTACHMENT_QUOTA_BYTES) {
      throw errno('QUOTA_EXCEEDED', 'this session is at its attachment quota');
    }

    const name = safeName(input.filename);
    const storedName = `${randomBytes(6).toString('hex')}-${name}`;
    const relativePath = path.posix.join(relativeDir, storedName);
    const absolutePath = await this.files.writeBinary(relativePath, input.bytes);
    return {
      name,
      storedName,
      absolutePath,
      relativePath,
      mime: displayMime(input.bytes, input.declaredMime),
      bytes: input.bytes.length,
    };
  }

  async resolve(
    _session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }> {
    const relativePath = this.relative(storedName);
    const confined = await this.files.confineExisting(relativePath);
    if (!confined.path) throw errno('NOT_FOUND', 'no such attachment');
    const stat = await this.files.stat(confined.path);
    if (!stat || stat.type !== 'file' || stat.size > DEFAULT_MAX_ATTACHMENT_BYTES) {
      throw errno('NOT_FOUND', 'no such attachment');
    }
    const head = await this.files.readHead(confined.path, Math.min(64, stat.size));
    return { absolutePath: confined.path, serve: serveKind(head, storedName), bytes: stat.size };
  }

  async resolveForTurn(
    session: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    const storedName = storedAttachmentNameFromUrl(attachment.url, session.id);
    if (!storedName) throw errno('NOT_FOUND', 'attachment URL does not belong to this session');
    const resolved = await this.resolve(session, storedName);
    return {
      url: attachmentUrlFor(session.id, storedName),
      name: resolved.serve.filename,
      mime: resolved.serve.contentType,
      size: resolved.bytes,
      path: resolved.absolutePath,
    };
  }

  async openForDownload(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ stream: Readable; serve: ServeKind; bytes: number }> {
    const resolved = await this.resolve(session, storedName);
    const bytes = await this.files.readBuffer(resolved.absolutePath, DEFAULT_MAX_ATTACHMENT_BYTES);
    return { stream: Readable.from(bytes), serve: resolved.serve, bytes: bytes.length };
  }

  private relative(storedName: string): string {
    // Reuse the canonical URL parser as the single stored-name grammar.
    const parsed = storedAttachmentNameFromUrl(attachmentUrlFor('s', storedName), 's');
    if (!parsed) throw errno('NOT_FOUND', 'no such attachment');
    return path.posix.join(ATTACHMENT_DIR, ATTACHMENT_SUBDIR, parsed);
  }

  private async usage(relativeDir: string): Promise<{ files: number; bytes: number }> {
    const confined = await this.files.confineExisting(relativeDir);
    if (!confined.path) {
      if (confined.missing) return { files: 0, bytes: 0 };
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment directory escaped the session');
    }
    const stat = await this.files.stat(confined.path);
    if (!stat || stat.type !== 'directory') {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment directory is not a directory');
    }
    const listed = await this.files.list(confined.path, DEFAULT_MAX_ATTACHMENTS + 1, true);
    let files = 0;
    let bytes = 0;
    for (const entry of listed.entries) {
      if (entry.isDirectory || typeof entry.size !== 'number') continue;
      files += 1;
      bytes += entry.size;
    }
    if (listed.truncated) files = DEFAULT_MAX_ATTACHMENTS;
    return { files, bytes };
  }
}
