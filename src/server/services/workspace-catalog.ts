import fs from 'node:fs';
import path from 'node:path';

interface SettingsStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

interface CatalogEntry {
  ownerKey: string;
  roots: string[];
}

const SETTING = 'session_workspace_roots.v1';
const OWNER_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Installation-local discovery contains paths only. Conversation ids, titles,
 * activity, runtimes and tab state remain exclusively inside each workspace.
 */
export class WorkspaceCatalog {
  constructor(private readonly settings: SettingsStore) {}

  roots(ownerKey: string): string[] {
    requireOwnerKey(ownerKey);
    const entries = this.read();
    const owned = entries.find((entry) => entry.ownerKey === ownerKey)?.roots ?? [];
    // A workspace contains plaintext transcripts and terminal history by
    // design. POSIX modes isolate operating-system users, not two web accounts
    // served by the same process, so one canonical root may be authorised to
    // exactly one immutable account identity. Legacy duplicate catalog rows
    // fail closed for every claimant until an administrator resolves them.
    return owned.filter((root) => {
      const claim = canonicalClaim(root);
      return !entries.some((entry) => (
        entry.ownerKey !== ownerKey
        && entry.roots.some((candidate) => rootsOverlap(claim, canonicalClaim(candidate)))
      ));
    });
  }

  /** Register an already-authorised real directory without following aliases. */
  register(ownerKey: string, root: string): string {
    requireOwnerKey(ownerKey);
    const canonical = canonicalExistingRoot(root);
    const entries = this.read();
    const conflictingOwner = entries.find((candidate) => (
      candidate.ownerKey !== ownerKey
      && candidate.roots.some((registered) => (
        rootsOverlap(canonical, canonicalClaim(registered))
      ))
    ));
    if (conflictingOwner) {
      throw Object.assign(
        new Error('workspace root is already assigned to another account'),
        { code: 'WORKSPACE_OWNER_CONFLICT' },
      );
    }
    let entry = entries.find((candidate) => candidate.ownerKey === ownerKey);
    if (!entry) {
      entry = { ownerKey, roots: [] };
      entries.push(entry);
    }
    if (!entry.roots.includes(canonical)) {
      entry.roots.push(canonical);
      this.write(entries);
    }
    return canonical;
  }

  unregister(ownerKey: string, root: string): void {
    requireOwnerKey(ownerKey);
    const resolved = path.resolve(root);
    const entries = this.read();
    const entry = entries.find((candidate) => candidate.ownerKey === ownerKey);
    if (!entry) return;
    const next = entry.roots.filter((candidate) => candidate !== resolved);
    if (next.length === entry.roots.length) return;
    entry.roots = next;
    this.write(entries.filter((candidate) => candidate.roots.length > 0));
  }

  private read(): CatalogEntry[] {
    const raw = this.settings.getSetting(SETTING);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const entries: CatalogEntry[] = [];
      for (const value of parsed) {
        if (!value || typeof value !== 'object') continue;
        const ownerKey = (value as { ownerKey?: unknown }).ownerKey;
        const roots = (value as { roots?: unknown }).roots;
        if (typeof ownerKey !== 'string' || !OWNER_KEY.test(ownerKey) || !Array.isArray(roots)) continue;
        const clean = roots
          .filter((candidate): candidate is string => typeof candidate === 'string' && path.isAbsolute(candidate))
          .map((candidate) => path.resolve(candidate))
          .filter((candidate) => candidate !== path.parse(candidate).root);
        entries.push({ ownerKey, roots: [...new Set(clean)] });
      }
      return entries;
    } catch {
      return [];
    }
  }

  private write(entries: CatalogEntry[]): void {
    this.settings.setSetting(SETTING, JSON.stringify(entries));
  }
}

/** Reject symlinked roots and roots reached through a symlinked component. */
export function canonicalExistingRoot(value: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error('workspace root must be absolute');
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error('filesystem root cannot be a workspace');
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('workspace root must be a real directory');
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error('workspace root cannot be reached through a symlink');
  return real;
}

/** Equal, ancestor or descendant, without confusing `/work/a` with `/work/ab`. */
export function rootsOverlap(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return pathContains(resolvedLeft, resolvedRight) || pathContains(resolvedRight, resolvedLeft);
}

function pathContains(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  );
}

/**
 * Compare legacy claims by their real target when it still exists. Missing
 * roots retain their component-normalised name so an unavailable parent cannot
 * be re-registered to another owner and become ambiguous when it reappears.
 */
function canonicalClaim(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function requireOwnerKey(value: string): void {
  if (!OWNER_KEY.test(value)) throw new Error('invalid workspace owner key');
}
