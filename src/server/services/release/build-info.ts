import fs from 'node:fs';
import path from 'node:path';

export interface BuildInfo {
  version: string;
  /** 40-hex commit this build came from, or null when it could not be determined. */
  sha: string | null;
  commitDate: string | null;
  /** The working tree had uncommitted changes when this was built. */
  dirty: boolean;
  source: 'git' | 'env' | 'unknown';
  builtAt: string | null;
}

/** Written by scripts/build.js next to the compiled server. */
export const DEFAULT_BUILD_INFO_PATH = path.join(__dirname, '..', '..', '..', 'build-info.json');

const cache = new Map<string, BuildInfo>();

/** Test seam: the cache is keyed by path, so fixtures never bleed between cases. */
export function resetBuildInfoCache(): void {
  cache.clear();
}

function packageVersion(): string {
  try {
    // dist/server/services/release/build-info.js -> package root
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Read the baked build identity.
 *
 * Never throws: a missing or corrupt file degrades to "commit unknown", which
 * the UI reports as "cannot check for updates" rather than taking the server
 * down over a metadata file.
 */
export function readBuildInfo(filePath: string = DEFAULT_BUILD_INFO_PATH): BuildInfo {
  const key = path.resolve(filePath);
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const fallback: BuildInfo = {
    version: packageVersion(),
    sha: null,
    commitDate: null,
    dirty: false,
    source: 'unknown',
    builtAt: null,
  };

  let info: BuildInfo;
  try {
    const raw = JSON.parse(fs.readFileSync(key, 'utf8')) as Record<string, unknown>;
    info = {
      version: typeof raw.version === 'string' ? raw.version : fallback.version,
      // Re-validated on read, not just on write: this value is interpolated
      // into a GitHub API path. The typeof guard is load-bearing — RegExp.test
      // stringifies its argument, so a one-element array would otherwise pass
      // and be stored as an array.
      sha: typeof raw.sha === 'string' && /^[0-9a-f]{40}$/.test(raw.sha) ? raw.sha : null,
      commitDate: typeof raw.commitDate === 'string' ? raw.commitDate : null,
      dirty: raw.dirty === true,
      source: raw.source === 'git' || raw.source === 'env' ? raw.source : 'unknown',
      builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
    };
  } catch {
    info = fallback;
  }

  cache.set(key, info);
  return info;
}

export function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}
