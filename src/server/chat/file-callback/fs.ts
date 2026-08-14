import * as crypto from 'crypto';
import { constants as fsConstants } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

import {
  CALLBACK_VERSION,
  EncryptedEnvelope,
  FileCallbackFilesystemOperation,
  FileCallbackTestHooks,
  InvalidCallbackEnvelopeError,
  MAX_ENVELOPE_BYTES,
  OpenDirectory,
  sameDirectory,
  UnsafeCallbackPathError,
  DirectoryIdentity,
  DirectoryRef,
} from './types.js';

async function openDirectory(
  directory: string,
  expected?: DirectoryIdentity,
): Promise<OpenDirectory> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw new UnsafeCallbackPathError(directory);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new UnsafeCallbackPathError(directory);
    const identity = { dev: stat.dev, ino: stat.ino };
    if (expected && !sameDirectory(identity, expected)) throw new UnsafeCallbackPathError(directory);
    const accessPath = fdAccessPath(handle);
    const anchored = await fsp.stat(accessPath).catch(() => null);
    if (!anchored || !anchored.isDirectory()
      || anchored.dev !== identity.dev || anchored.ino !== identity.ino) {
      throw new UnsafeCallbackPathError(directory);
    }
    return { handle, identity, accessPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function fdAccessPath(handle: fsp.FileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  // BSDs and macOS commonly expose the same descriptor-anchored namespace.
  // If this host does not, openDirectory's stat check fails closed.
  return `/dev/fd/${handle.fd}`;
}

function childName(file: string): string {
  const name = path.basename(file);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new UnsafeCallbackPathError(file);
  }
  return name;
}

export function childAccessPath(opened: OpenDirectory, file: string): string {
  return path.join(opened.accessPath, childName(file));
}

async function verifyVisibleDirectory(ref: DirectoryRef, opened: OpenDirectory): Promise<void> {
  const visible = await openDirectory(ref.path, ref).catch(() => null);
  if (!visible) throw new UnsafeCallbackPathError(ref.path);
  try {
    const current = await opened.handle.stat();
    if (!sameDirectory(current, visible.identity)) throw new UnsafeCallbackPathError(ref.path);
  } finally {
    await visible.handle.close();
  }
}

export async function withDirectory<T>(
  ref: DirectoryRef,
  operation: FileCallbackFilesystemOperation,
  callback: (opened: OpenDirectory) => Promise<T>,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<T> {
  const opened = await openDirectory(ref.path, ref);
  try {
    await hook?.(operation, ref.path);
    const result = await callback(opened);
    await verifyVisibleDirectory(ref, opened);
    return result;
  } finally {
    await opened.handle.close();
  }
}

export async function directoryRef(directory: string, expected?: DirectoryIdentity): Promise<DirectoryRef> {
  const opened = await openDirectory(directory, expected);
  await opened.handle.close();
  return { path: directory, ...opened.identity };
}

export async function assertDirectory(ref: DirectoryRef): Promise<void> {
  await withDirectory(ref, 'read', async () => undefined);
}

export async function setDirectoryMode(ref: DirectoryRef, mode: number): Promise<void> {
  await withDirectory(ref, 'cleanup', async (opened) => {
    await opened.handle.chmod(mode);
  });
}

export async function makeChildDirectory(
  parent: DirectoryRef,
  name: string,
  allowExisting: boolean,
): Promise<DirectoryRef> {
  return withDirectory(parent, 'write', async (openedParent) => {
    const target = childAccessPath(openedParent, name);
    try {
      await fsp.mkdir(target, { mode: 0o700 });
    } catch (error: unknown) {
      if (!allowExisting || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const child = await openChildDirectory(openedParent, name);
    try {
      await child.handle.chmod(0o700);
      return { path: path.join(parent.path, childName(name)), ...child.identity };
    } finally {
      await child.handle.close();
    }
  });
}

export async function writeExclusivePlain(directory: DirectoryRef, name: string, contents: string): Promise<void> {
  await withDirectory(directory, 'write', async (opened) => {
    await fsp.writeFile(childAccessPath(opened, name), contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  });
}

function encryptionKey(token: string): Buffer {
  return crypto.createHash('sha256').update('ccweb-file-callback-key-v1\0').update(token).digest();
}

function encrypt(token: string, associatedData: string, value: unknown): EncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(token), iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    v: CALLBACK_VERSION,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decrypt(token: string, associatedData: string, value: unknown): unknown {
  try {
    const envelope = value as Partial<EncryptedEnvelope> | null;
    if (!envelope || envelope.v !== CALLBACK_VERSION || typeof envelope.iv !== 'string'
      || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
      throw new InvalidCallbackEnvelopeError();
    }
    const iv = Buffer.from(envelope.iv, 'base64url');
    const tag = Buffer.from(envelope.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new InvalidCallbackEnvelopeError();
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(token), iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (error) {
    if (error instanceof InvalidCallbackEnvelopeError) throw error;
    throw new InvalidCallbackEnvelopeError();
  }
}

export async function atomicEncrypted(
  directory: DirectoryRef,
  file: string,
  token: string,
  associatedData: string,
  value: unknown,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<void> {
  await withDirectory(directory, 'write', async (opened) => {
    const targetName = childName(file);
    const temporaryName = `${targetName}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    const target = childAccessPath(opened, targetName);
    const temporary = childAccessPath(opened, temporaryName);
    try {
      await fsp.writeFile(temporary, JSON.stringify(encrypt(token, associatedData, value)), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }, hook);
}

export async function readEncrypted(
  directory: DirectoryRef,
  file: string,
  token: string,
  associatedData: string,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<unknown | null> {
  return withDirectory(directory, 'read', async (opened) => {
    const target = childAccessPath(opened, file);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new UnsafeCallbackPathError(file);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ENVELOPE_BYTES) throw new InvalidCallbackEnvelopeError();
      const serialized = await handle.readFile({ encoding: 'utf8' });
      return decrypt(token, associatedData, JSON.parse(serialized));
    } catch (error) {
      if (error instanceof UnsafeCallbackPathError || error instanceof InvalidCallbackEnvelopeError) throw error;
      throw new InvalidCallbackEnvelopeError();
    } finally {
      await handle.close();
    }
  }, hook);
}

export async function safeUnlink(
  directory: DirectoryRef,
  file: string,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<void> {
  await withDirectory(directory, 'unlink', async (opened) => {
    try {
      await fsp.unlink(childAccessPath(opened, file));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }, hook);
}

export async function safeCleanupFlat(
  directory: DirectoryRef,
  before?: number,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
  keep?: (entry: string) => boolean,
): Promise<void> {
  await withDirectory(directory, 'cleanup', async (opened) => {
    await cleanupOpenedFlat(opened, before, keep);
  }, hook);
}

export async function cleanupOpenedFlat(
  opened: OpenDirectory,
  before?: number,
  keep?: (entry: string) => boolean,
): Promise<void> {
  const entries = await fsp.readdir(opened.accessPath);
  for (const entry of entries) {
    if (keep?.(entry)) continue;
    const file = childAccessPath(opened, entry);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat || stat.isDirectory() || (before !== undefined && stat.mtimeMs >= before)) continue;
    await fsp.unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function openChildDirectory(
  parent: OpenDirectory,
  name: string,
  expected?: DirectoryIdentity,
): Promise<OpenDirectory> {
  return openDirectory(childAccessPath(parent, name), expected);
}

export async function safeRmdir(
  parent: DirectoryRef,
  name: string,
  expected: DirectoryIdentity,
): Promise<void> {
  await withDirectory(parent, 'cleanup', async (openedParent) => {
    const openedChild = await openChildDirectory(openedParent, name, expected);
    try {
      await fsp.rmdir(childAccessPath(openedParent, name)).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code || '')) throw error;
      });
    } finally {
      await openedChild.handle.close();
    }
  });
}
