import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export function optionalFlag(value: number | undefined): number {
  return typeof value === 'number' ? value : 0;
}

export function sameCanonicalPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function sameFileIdentity(left: Awaited<ReturnType<FileHandle['stat']>>, right: typeof left): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  // Some Windows filesystem providers report a zero inode. Birth time is the
  // conservative file-id fallback; accepting every entry on the same volume
  // would make the pathname swap checks meaningless there.
  return left.birthtimeMs === right.birthtimeMs;
}

export function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
