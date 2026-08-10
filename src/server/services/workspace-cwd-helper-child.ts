import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_REQUEST_BYTES = 34 * 1024 * 1024;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_FINGERPRINT_BYTES = 512 * 1024 * 1024;
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const NON_BLOCK = (fs.constants as unknown as Record<string, number>).O_NONBLOCK ?? 0;

type Request = {
  version: 1;
  expectedDev: string;
  expectedIno: string;
  operation: 'mkdir' | 'ensure-directory' | 'inspect-directory' | 'create' | 'rename' | 'publish' | 'claim' | 'retire' | 'isolate'
    | 'reconcile-publish' | 'reconcile-rename' | 'recover-publish' | 'fingerprint'
    | 'read' | 'authority-read' | 'stat' | 'list' | 'write' | 'append' | 'truncate' | 'harden' | 'cleanup-create'
    | 'migration-retire' | 'recover-migration-retire'
    | 'verify-absent' | 'unlink' | 'rmdir';
  name: string;
  target?: string;
  data?: string;
  mode?: number;
  expectedEntryDev?: string;
  expectedEntryIno?: string;
  maximumBytes?: number;
  offset?: number;
  length?: number;
  createIfMissing?: boolean;
  harden?: boolean;
  expectedBytes?: number;
  expectedSha256?: string;
};

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE' });
}

function component(value: unknown): string {
  if (typeof value !== 'string') fail('helper component must be a string');
  const text = value;
  if (!SAFE_COMPONENT.test(text) || text === '.' || text === '..' || path.basename(text) !== text) {
    fail('helper accepts direct basename components only');
  }
  return text;
}

function inspectedDirectoryComponent(value: unknown): string {
  if (typeof value !== 'string' || value === '.' || value === '..' || value.includes('\0')
    || path.basename(value) !== value || Buffer.byteLength(value, 'utf8') > 255
    || (process.platform === 'win32' && (
      /[<>:"/\\|?*]/.test(value) || /[. ]$/.test(value)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    ))) fail('helper refuses unsafe inspected directory component');
  return value;
}

function regular(name: string): fs.BigIntStats {
  const stat = fs.lstatSync(name, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    fail('helper refuses symlink, special, or multiply-linked file entries');
  }
  return stat;
}

function directory(name: string): fs.BigIntStats {
  const stat = fs.lstatSync(name, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('helper refuses non-directory entries');
  return stat;
}

function decode(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) {
    fail('helper payload is missing or too large');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== data) {
    fail('helper payload is invalid or too large');
  }
  return bytes;
}

function createOpen(name: string, bytes: Buffer, mode: number): number {
  const fd = fs.openSync(
    name,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW | NON_BLOCK,
    mode,
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) fail('helper created an unsafe file entry');
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function verifyOpenName(name: string, fd: number): fs.BigIntStats {
  const opened = fs.fstatSync(fd, { bigint: true });
  const visible = regular(name);
  if (opened.dev !== visible.dev || opened.ino !== visible.ino) fail('helper entry changed during publication');
  return visible;
}

function verifyOpenAuthorityName(name: string, fd: number): fs.BigIntStats {
  const opened = fs.fstatSync(fd, { bigint: true });
  const visible = fs.lstatSync(name, { bigint: true });
  if (!opened.isFile() || visible.isSymbolicLink() || !visible.isFile()
    || visible.nlink < 1n || visible.nlink > 3n || !sameIdentity(opened, visible)) {
    fail('helper authority entry changed during recovery');
  }
  return visible;
}

function fsyncCwd(): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync('.', fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Win32 pins a process cwd against rename/removal, but Node/libuv cannot
    // FlushFileBuffers on a directory handle. File contents are fsynced before
    // this point; tolerate only the documented unsupported-directory family.
    if (process.platform !== 'win32'
      || !new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']).has(String(code))) {
      throw error;
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function quarantineName(purpose = 'entry'): string {
  return `.ccweb-quarantine-${purpose}-${process.pid}-${randomBytes(12).toString('hex')}`;
}

function publishPurpose(target: string): string {
  return `publish-${createHash('sha256').update(target).digest('hex').slice(0, 24)}`;
}

function migrationRetirePurpose(name: string): string {
  return `migration-retire-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
}

function testCutpoint(name: string): void {
  // The production broker starts the child with a minimal empty environment,
  // so this native-test crash seam cannot be selected by application input.
  if (process.env.CODE_AGENTS_WEBCLI_HELPER_TEST_CUTPOINT === name) {
    fs.writeSync(2, `CODE_AGENTS_WEBCLI_HELPER_TEST_CUTPOINT:${name}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}

function matchesExpected(stat: fs.BigIntStats, request: Request): boolean {
  return request.expectedEntryDev !== undefined && request.expectedEntryIno !== undefined
    && String(stat.dev) === request.expectedEntryDev && String(stat.ino) === request.expectedEntryIno;
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensureBlockingName(name: string, directoryEntry = false): void {
  try { fs.lstatSync(name, { bigint: true }); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    if (directoryEntry) fs.mkdirSync(name, { mode: 0o700 });
    else {
      const fd = createOpen(name, Buffer.alloc(0), 0o600);
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function failQuarantined(message: string, fixedName: string, directoryEntry = false): never {
  ensureBlockingName(fixedName, directoryEntry);
  fsyncCwd();
  fail(message);
}

function exactQuarantines(request: Request): Array<{ name: string; stat: fs.BigIntStats }> {
  if (request.expectedEntryDev === undefined || request.expectedEntryIno === undefined) {
    fail('helper quarantine reconciliation lacks an expected identity');
  }
  const names = fs.readdirSync('.').filter((entry) => entry.startsWith('.ccweb-quarantine-'));
  if (names.length > 128) fail('helper refuses an excessive quarantine set');
  return names.flatMap((entry) => {
    const stat = fs.lstatSync(entry, { bigint: true });
    return String(stat.dev) === request.expectedEntryDev && String(stat.ino) === request.expectedEntryIno
      ? [{ name: entry, stat }] : [];
  });
}

function removeExactQuarantines(request: Request, directoryEntry = false): void {
  for (const entry of exactQuarantines(request)) {
    const current = fs.lstatSync(entry.name, { bigint: true });
    if (!sameIdentity(entry.stat, current)) fail('helper quarantine changed during recovery');
    if (directoryEntry) {
      if (!current.isDirectory() || current.isSymbolicLink()) fail('helper directory quarantine is unsafe');
      fs.rmdirSync(entry.name);
    } else {
      if ((!current.isFile() && !current.isSymbolicLink())
        || (current.isFile() && current.nlink < 1n)) fail('helper file quarantine is unsafe');
      fs.unlinkSync(entry.name);
    }
  }
}

function quarantineExactName(
  name: string,
  expected: fs.BigIntStats,
  directoryEntry = false,
  purpose = 'entry',
): string {
  const quarantine = quarantineName(purpose);
  fs.renameSync(name, quarantine);
  const claimed = fs.lstatSync(quarantine, { bigint: true });
  const safeType = directoryEntry
    ? claimed.isDirectory() && !claimed.isSymbolicLink()
    : (claimed.isFile() || claimed.isSymbolicLink());
  if (!safeType || !sameIdentity(expected, claimed)) {
    failQuarantined('helper fixed entry changed during private claim', name, directoryEntry);
  }
  return quarantine;
}

function removeExactPrivate(name: string, expected: fs.BigIntStats, directoryEntry = false): void {
  const current = fs.lstatSync(name, { bigint: true });
  if (!sameIdentity(expected, current)) fail('helper private entry changed before removal');
  if (directoryEntry) fs.rmdirSync(name);
  else fs.unlinkSync(name);
}

function fingerprintNamedRegular(name: string): { bytes: number; sha256: string; stat: fs.BigIntStats } {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  try {
    const before = verifyOpenName(name, fd);
    if (before.size > BigInt(MAX_FINGERPRINT_BYTES)) fail('helper migration retirement exceeds its bound');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (bytes === 0) break;
      offset += bytes;
      hash.update(chunk.subarray(0, bytes));
    }
    const after = verifyOpenName(name, fd);
    if (!sameIdentity(before, after) || BigInt(offset) !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail('helper migration retirement changed while hashing');
    }
    return { bytes: offset, sha256: hash.digest('hex'), stat: after };
  } finally { fs.closeSync(fd); }
}

function lstatMaybe(name: string): fs.BigIntStats | null {
  try { return fs.lstatSync(name, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function main(raw: string): void {
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) fail('helper request is too large');
  const request = JSON.parse(raw) as Request;
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.getPrototypeOf(request) !== Object.prototype || request.version !== 1) {
    fail('unsupported helper request');
  }
  if (!/^\d+$/.test(request.expectedDev) || !/^\d+$/.test(request.expectedIno)
    || ((request.expectedEntryDev === undefined) !== (request.expectedEntryIno === undefined))
    || (request.expectedEntryDev !== undefined && !/^\d+$/.test(request.expectedEntryDev))
    || (request.expectedEntryIno !== undefined && !/^\d+$/.test(request.expectedEntryIno))) {
    fail('helper identity fields are invalid');
  }
  const cwd = fs.statSync('.', { bigint: true });
  if (
    !cwd.isDirectory()
    || cwd.dev.toString() !== request.expectedDev
    || cwd.ino.toString() !== request.expectedIno
  ) fail('helper cwd identity does not match the authorised parent');

  const name = request.operation === 'inspect-directory'
    ? inspectedDirectoryComponent(request.name)
    : component(request.name);
  const mode = request.mode === 0o700 ? 0o700 : 0o600;
  let published: fs.BigIntStats | null = null;
  let fingerprint: { bytes: string; sha256: string } | null = null;
  let readResult: Record<string, string> | null = null;
  switch (request.operation) {
    case 'mkdir':
      fs.mkdirSync(name, { mode: 0o700 });
      published = directory(name);
      break;
    case 'inspect-directory': {
      const before = directory(name);
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const after = directory(name);
        if (!opened.isDirectory() || !sameIdentity(before, opened) || !sameIdentity(opened, after)) {
          fail('helper inspected directory changed while opening');
        }
        published = after;
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'ensure-directory': {
      if (typeof request.createIfMissing !== 'boolean' || typeof request.harden !== 'boolean') {
        fail('helper directory policy is missing');
      }
      let before: fs.BigIntStats;
      try {
        before = directory(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !request.createIfMissing) throw error;
        fs.mkdirSync(name, { mode: 0o700 });
        before = directory(name);
      }
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const visible = directory(name);
        if (!opened.isDirectory() || !sameIdentity(before, opened)
          || !sameIdentity(opened, visible)) fail('helper directory changed while opening');
        if (request.expectedEntryDev !== undefined && !matchesExpected(opened, request)) {
          fail('helper directory does not match expected identity');
        }
        if (request.harden) {
          fs.fchmodSync(fd, 0o700);
          try { fs.fsyncSync(fd); } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (process.platform !== 'win32'
              || !new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']).has(String(code))) throw error;
          }
        }
        published = directory(name);
        if (!sameIdentity(opened, published)) fail('helper directory changed while hardening');
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'create': {
      const fd = createOpen(name, decode(request.data), mode);
      try { published = verifyOpenName(name, fd); } finally { fs.closeSync(fd); }
      break;
    }
    case 'rename': {
      const target = component(request.target);
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
      try {
        const source = verifyOpenName(name, fd);
        if (!matchesExpected(source, request)) {
          fail('helper rename source does not match parent authority');
        }
        const privateClaim = quarantineName('rename');
        fs.renameSync(name, privateClaim);
        testCutpoint('rename-private-link');
        const claimed = fs.lstatSync(privateClaim, { bigint: true });
        if (claimed.isSymbolicLink() || !claimed.isFile()
          || !sameIdentity(source, claimed) || claimed.nlink !== 1n) {
          ensureBlockingName(name);
          fail('helper rename private claim is ambiguous');
        }
        // Do not evacuate the fixed target. The verified private inode is
        // atomically renamed over it, so every crash leaves either the old or
        // new complete target at its authoritative name with nlink=1.
        fs.renameSync(privateClaim, target);
        testCutpoint('rename-target-rename');
        published = verifyOpenName(target, fd);
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    case 'publish': {
      const target = component(request.target);
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
      const privateClaim = quarantineName(publishPurpose(target));
      try {
        const source = verifyOpenName(name, fd);
        if (!matchesExpected(source, request)) {
          fail('helper publish source does not match parent authority');
        }
        fs.renameSync(name, privateClaim);
        testCutpoint('publish-private-link');
        const claim = fs.lstatSync(privateClaim, { bigint: true });
        if (!sameIdentity(source, claim) || claim.nlink !== 1n) {
          ensureBlockingName(name);
          fail('helper publish private claim changed');
        }
        fs.linkSync(privateClaim, target);
        testCutpoint('publish-target-link');
        const linked = fs.lstatSync(target, { bigint: true });
        if (!linked.isFile() || linked.isSymbolicLink()
          || !sameIdentity(linked, source) || linked.nlink !== 2n) {
          fail('helper publish link is ambiguous');
        }
        testCutpoint('publish-source-quarantine');
        removeExactPrivate(privateClaim, source);
        published = verifyOpenName(target, fd);
        if (published.nlink !== 1n) fail('helper published entry is not isolated');
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    case 'recover-publish': {
      const prefix = `.ccweb-quarantine-${publishPurpose(name)}-`;
      const pattern = new RegExp(`^${prefix}[0-9]+-[a-f0-9]{24}$`);
      const recoveries = fs.readdirSync('.').filter((entry) => pattern.test(entry));
      if (recoveries.length > 32) fail('helper refuses an excessive publication recovery set');
      for (const recovery of recoveries) {
        const source = fs.lstatSync(recovery, { bigint: true });
        if (source.isSymbolicLink() || !source.isFile()
          || (source.nlink !== 1n && source.nlink !== 2n)) {
          fail('helper publication recovery entry is unsafe');
        }
        if (source.nlink === 2n) {
          const target = fs.lstatSync(name, { bigint: true });
          if (target.isSymbolicLink() || !target.isFile() || target.nlink !== 2n
            || !sameIdentity(source, target)) fail('helper publication recovery target is ambiguous');
        }
        removeExactPrivate(recovery, source);
      }
      const target = lstatMaybe(name);
      if (target) {
        if (target.isSymbolicLink() || !target.isFile() || target.nlink !== 1n) {
          fail('helper recovered publication target is unsafe');
        }
        published = target;
      }
      break;
    }
    case 'fingerprint': {
      const maximum = request.maximumBytes ?? MAX_FINGERPRINT_BYTES;
      if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_FINGERPRINT_BYTES) {
        fail('helper fingerprint bound is invalid');
      }
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
      try {
        const before = verifyOpenName(name, fd);
        if (request.expectedEntryDev !== undefined && !matchesExpected(before, request)) {
          fail('helper fingerprint entry does not match expected identity');
        }
        if (before.size > BigInt(maximum)) fail('helper fingerprint file exceeds its bound');
        const hash = createHash('sha256');
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        for (;;) {
          const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maximum + 1 - offset), offset);
          if (bytes === 0) break;
          offset += bytes;
          if (offset > maximum) fail('helper fingerprint file exceeds its bound');
          hash.update(chunk.subarray(0, bytes));
        }
        const after = verifyOpenName(name, fd);
        if (!sameIdentity(before, after) || before.size !== after.size
          || BigInt(offset) !== after.size || before.mtimeNs !== after.mtimeNs
          || before.ctimeNs !== after.ctimeNs) fail('helper fingerprint file changed while reading');
        published = after;
        fingerprint = { bytes: String(offset), sha256: hash.digest('hex') };
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'authority-read':
    case 'read':
    case 'stat': {
      const offset = request.operation === 'read' ? request.offset : 0;
      const length = request.operation === 'authority-read' ? 16_384
        : request.operation === 'read' ? request.length : 0;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || Number(offset) < 0 || Number(length) < 0 || Number(length) > MAX_FILE_BYTES) {
        fail('helper read range is invalid');
      }
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
      try {
        const before = request.operation === 'authority-read'
          ? verifyOpenAuthorityName(name, fd)
          : verifyOpenName(name, fd);
        if (request.operation === 'authority-read' && before.size > 16_384n) {
          fail('helper writer authority claim exceeds its bound');
        }
        if (request.expectedEntryDev !== undefined && !matchesExpected(before, request)) {
          fail('helper read entry does not match expected identity');
        }
        const data = Buffer.allocUnsafe(Number(length));
        const bytes = request.operation === 'read' || request.operation === 'authority-read'
          ? fs.readSync(fd, data, 0, data.length, Number(offset)) : 0;
        const after = request.operation === 'authority-read'
          ? verifyOpenAuthorityName(name, fd)
          : verifyOpenName(name, fd);
        if (!sameIdentity(before, after) || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || (request.operation === 'authority-read' && BigInt(bytes) !== after.size)) {
          fail('helper file changed while reading');
        }
        published = after;
        readResult = {
          data: data.subarray(0, bytes).toString('base64'),
          size: String(after.size), nlink: String(after.nlink), mode: String(after.mode),
          mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
          birthtimeNs: String(after.birthtimeNs),
        };
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'list': {
      const names = fs.readdirSync('.');
      if (names.length > 10_000) fail('helper directory entry count exceeds its bound');
      const entries = names.map((entry) => {
        component(entry);
        const stat = fs.lstatSync(entry, { bigint: true });
        return {
          name: entry, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
          nlink: String(stat.nlink), mode: String(stat.mode),
          type: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'special',
        };
      });
      readResult = { entries: JSON.stringify(entries) };
      break;
    }
    case 'append': {
      const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW | NON_BLOCK);
      try {
        const before = verifyOpenName(name, fd);
        if (request.expectedEntryDev !== undefined && !matchesExpected(before, request)) {
          fail('helper append entry does not match expected identity');
        }
        fs.writeFileSync(fd, decode(request.data));
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
        published = verifyOpenName(name, fd);
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'write': {
      if (!Number.isSafeInteger(request.offset) || Number(request.offset) < 0) fail('helper write offset is invalid');
      const fd = fs.openSync(name, fs.constants.O_WRONLY | NO_FOLLOW | NON_BLOCK);
      try {
        const before = verifyOpenName(name, fd);
        if (!matchesExpected(before, request)) fail('helper write entry does not match expected identity');
        const data = decode(request.data);
        let written = 0;
        while (written < data.length) {
          written += fs.writeSync(fd, data, written, data.length - written, Number(request.offset) + written);
        }
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
        published = verifyOpenName(name, fd);
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'truncate':
    case 'harden': {
      if (request.operation === 'truncate'
        && (!Number.isSafeInteger(request.length) || Number(request.length) < 0
          || Number(request.length) > MAX_FINGERPRINT_BYTES)) fail('helper truncate length is invalid');
      const fd = fs.openSync(
        name,
        (request.operation === 'truncate' ? fs.constants.O_WRONLY : fs.constants.O_RDWR)
          | NO_FOLLOW | NON_BLOCK,
      );
      try {
        const before = verifyOpenName(name, fd);
        if (request.expectedEntryDev !== undefined && !matchesExpected(before, request)) {
          fail(`helper ${request.operation} entry does not match expected identity`);
        }
        if (request.operation === 'truncate') fs.ftruncateSync(fd, Number(request.length));
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
        published = verifyOpenName(name, fd);
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'cleanup-create': {
      const source = lstatMaybe(name);
      if (!source) break;
      const expectedData = decode(request.data);
      if (source.isSymbolicLink() || !source.isFile() || source.nlink !== 1n
        || source.size !== BigInt(expectedData.length)) fail('helper created-file recovery is ambiguous');
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
      try {
        const opened = verifyOpenName(name, fd);
        if (!sameIdentity(source, opened)) fail('helper created-file recovery changed while opening');
        const actual = Buffer.alloc(expectedData.length);
        const bytes = fs.readSync(fd, actual, 0, actual.length, 0);
        if (bytes !== actual.length || !actual.equals(expectedData)) {
          fail('helper created-file recovery contents are ambiguous');
        }
        const quarantine = quarantineExactName(name, source);
        removeExactPrivate(quarantine, source);
      } finally { fs.closeSync(fd); }
      break;
    }
    case 'claim': {
      const target = component(request.target);
      const fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
      const privateClaim = quarantineName();
      try {
        let source = verifyOpenAuthorityName(name, fd);
        if (!matchesExpected(source, request)) fail('helper claim source does not match parent authority');
        removeExactQuarantines(request);
        const completed = lstatMaybe(target);
        if (completed) {
          const currentSource = fs.lstatSync(name, { bigint: true });
          if (!sameIdentity(source, completed) || !sameIdentity(source, currentSource)
            || completed.nlink !== 2n || currentSource.nlink !== 2n) {
            fail('helper existing authority claim is ambiguous');
          }
          published = completed;
          break;
        }
        source = verifyOpenName(name, fd);
        fs.linkSync(name, privateClaim);
        testCutpoint('claim-private-link');
        const privatelyClaimed = fs.lstatSync(privateClaim, { bigint: true });
        const stillNamed = fs.lstatSync(name, { bigint: true });
        if (!sameIdentity(source, privatelyClaimed) || !sameIdentity(source, stillNamed)
          || privatelyClaimed.nlink !== 2n || stillNamed.nlink !== 2n) {
          try { removeExactPrivate(privateClaim, source); } catch { /* Preserve ambiguous state. */ }
          fail('helper authority private claim is ambiguous');
        }
        fs.linkSync(privateClaim, target);
        testCutpoint('claim-target-link');
        const fixedClaim = fs.lstatSync(target, { bigint: true });
        const finalSource = fs.lstatSync(name, { bigint: true });
        if (!sameIdentity(source, fixedClaim) || !sameIdentity(source, finalSource)
          || fixedClaim.nlink !== 3n || finalSource.nlink !== 3n) {
          fail('helper authority fixed claim is ambiguous');
        }
        removeExactPrivate(privateClaim, source);
      } finally {
        fs.closeSync(fd);
      }
      const claim = fs.lstatSync(target, { bigint: true });
      const source = fs.lstatSync(name, { bigint: true });
      if (!sameIdentity(claim, source) || claim.nlink !== 2n || source.nlink !== 2n) {
        fail('helper authority claim is ambiguous');
      }
      published = claim;
      break;
    }
    case 'retire': {
      const target = component(request.target);
      for (const fixed of [name, target]) {
        const source = lstatMaybe(fixed);
        if (!source) continue;
        if (!source.isFile() || source.isSymbolicLink() || !matchesExpected(source, request)) {
          fail('helper authority retirement is ambiguous');
        }
        quarantineExactName(fixed, source, false, 'retire');
        testCutpoint(`retire-${fixed === name ? 'source' : 'claim'}-quarantine`);
      }
      removeExactQuarantines(request);
      if (lstatMaybe(name) || lstatMaybe(target)) fail('helper authority retirement names reappeared');
      break;
    }
    case 'isolate': {
      const target = component(request.target);
      const source = lstatMaybe(name);
      if (source) {
        if (!source.isFile() || source.isSymbolicLink() || !matchesExpected(source, request)) {
          fail('helper publication isolation source is ambiguous');
        }
        quarantineExactName(name, source);
        testCutpoint('isolate-source-quarantine');
      }
      removeExactQuarantines(request);
      published = regular(target);
      if (!matchesExpected(published, request)) fail('helper publication target is ambiguous');
      break;
    }
    case 'reconcile-publish':
    case 'reconcile-rename': {
      const target = component(request.target);
      if (request.expectedEntryDev === undefined || request.expectedEntryIno === undefined) {
        fail('helper publication reconciliation lacks an expected identity');
      }
      // A crash can leave either the private publication link or the retired
      // source link behind. Both are unguessable siblings of the exact
      // expected inode, so remove only those exact residual links first.
      removeExactQuarantines(request);
      const targetStat = fs.lstatSync(target, { bigint: true });
      if (targetStat.isSymbolicLink() || !targetStat.isFile()
        || String(targetStat.dev) !== request.expectedEntryDev
        || String(targetStat.ino) !== request.expectedEntryIno) {
        fail('helper publication target does not match parent authority');
      }
      const source = lstatMaybe(name);
      if (source) {
        if (!source.isFile() || source.isSymbolicLink() || !matchesExpected(source, request)) {
          fail('helper publication source does not match parent authority');
        }
        quarantineExactName(name, source);
      }
      removeExactQuarantines(request);
      published = regular(target);
      if (!matchesExpected(published, request)) fail('helper publication reconciliation is ambiguous');
      break;
    }
    case 'verify-absent':
      removeExactQuarantines(request, request.mode === 0o700);
      try {
        fs.lstatSync(name, { bigint: true });
        fail('helper expected an absent entry');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      break;
    case 'migration-retire': {
      const source = lstatMaybe(name);
      if (!source || !source.isFile() || source.isSymbolicLink() || source.nlink !== 1n
        || !matchesExpected(source, request)) fail('helper migration retirement source is unsafe');
      const quarantine = quarantineExactName(name, source, false, migrationRetirePurpose(name));
      testCutpoint('migration-retire-quarantine');
      removeExactPrivate(quarantine, source);
      if (lstatMaybe(name)) fail('helper migration retirement source reappeared');
      break;
    }
    case 'recover-migration-retire': {
      if (!Number.isSafeInteger(request.expectedBytes) || Number(request.expectedBytes) < 0
        || Number(request.expectedBytes) > MAX_FINGERPRINT_BYTES
        || typeof request.expectedSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(request.expectedSha256)) {
        fail('helper migration retirement recovery fingerprint is invalid');
      }
      const prefix = `.ccweb-quarantine-${migrationRetirePurpose(name)}-`;
      const candidates = fs.readdirSync('.').filter((entry) => entry.startsWith(prefix));
      if (candidates.length === 0) break;
      if (candidates.length !== 1) fail('helper migration retirement recovery is ambiguous');
      const recovered = fingerprintNamedRegular(candidates[0]);
      if (recovered.bytes !== request.expectedBytes || recovered.sha256 !== request.expectedSha256) {
        fail('helper migration retirement recovery bytes do not match authority');
      }
      const fixed = lstatMaybe(name);
      if (fixed) {
        const fixedFingerprint = fingerprintNamedRegular(name);
        if (fixedFingerprint.bytes !== request.expectedBytes
          || fixedFingerprint.sha256 !== request.expectedSha256) {
          fail('helper restored migration retirement source conflicts with quarantine');
        }
      }
      removeExactPrivate(candidates[0], recovered.stat);
      break;
    }
    case 'unlink': {
      const source = lstatMaybe(name);
      if (source) {
        if (!source.isFile() && !source.isSymbolicLink()) fail('helper refuses special unlink source');
        if (source.isFile() && source.nlink !== 1n) fail('helper refuses multiply-linked unlink source');
        if (!matchesExpected(source, request)) fail('helper unlink source does not match parent authority');
        const quarantine = quarantineExactName(name, source);
        testCutpoint('unlink-quarantine');
        removeExactPrivate(quarantine, source);
      }
      if (lstatMaybe(name)) fail('helper unlinked name reappeared');
      break;
    }
    case 'rmdir': {
      const source = lstatMaybe(name);
      if (source) {
        if (!source.isDirectory() || source.isSymbolicLink() || !matchesExpected(source, request)) {
          fail('helper rmdir source does not match parent authority');
        }
        const quarantine = quarantineExactName(name, source, true);
        testCutpoint('rmdir-quarantine');
        try { removeExactPrivate(quarantine, source, true); } catch (error) {
          ensureBlockingName(name, true);
          throw error;
        }
      }
      if (lstatMaybe(name)) {
        fail('helper rmdir source does not match parent authority');
      }
      break;
    }
    default:
      fail('unsupported helper operation');
  }
  const after = fs.statSync('.', { bigint: true });
  if (after.dev.toString() !== request.expectedDev || after.ino.toString() !== request.expectedIno) {
    fail('helper cwd identity changed');
  }
  fsyncCwd();
  const durableAfter = fs.statSync('.', { bigint: true });
  if (durableAfter.dev.toString() !== request.expectedDev
    || durableAfter.ino.toString() !== request.expectedIno) fail('helper cwd identity changed after sync');
  const origin = __filename.includes('app.asar') ? 'app.asar' : 'source';
  process.stdout.write(`${JSON.stringify({
    ok: true,
    origin,
    ...(published ? { dev: String(published.dev), ino: String(published.ino) } : {}),
    ...(fingerprint ?? {}),
    ...(readResult ?? {}),
  })}\n`);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) fail('helper request is too large');
});
process.stdin.on('end', () => {
  try {
    main(input);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'HELPER_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    process.exitCode = 1;
  }
});
