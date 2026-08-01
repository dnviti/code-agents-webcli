/**
 * A Markdown link that names a file in the active chat workspace.
 *
 * Agents use absolute paths because that is what their file tools report, and
 * append `:line` when they are pointing at one place in the file. Sent to the
 * browser as an ordinary href, that path becomes an Express request and ends
 * at `Cannot GET /home/.../file.ts:123`; this is the small routing contract
 * that keeps those links inside the application instead.
 */
export interface WorkspaceFileTarget {
  path: string;
  line?: number;
}

interface NormalPath {
  value: string;
  windows: boolean;
}

/** A final decimal location, deliberately narrower than a filename colon. */
const LINE_SUFFIX = /:([0-9]+)$/;

/**
 * Map a literal link target to a file inside `workingDir`.
 *
 * This is a routing check, not an authorization boundary. The workspace route
 * repeats containment after resolving symlinks and owns the final decision;
 * the browser only needs to distinguish a project file from an ordinary URL.
 */
export function workspaceFileTarget(
  rawHref: string,
  workingDir: string,
): WorkspaceFileTarget | null {
  let href = String(rawHref || '').trim();
  if (!href || href.includes('\0')) return null;

  // Markdown often percent-escapes spaces in an absolute path. `getAttribute`
  // returns that spelling rather than the browser-decoded pathname, so decode
  // it before comparing it with the session's real working directory.
  try {
    href = decodeURIComponent(href);
  } catch {
    return null;
  }
  if (href.includes('\0')) return null;

  let line: number | undefined;
  const suffix = LINE_SUFFIX.exec(href);
  if (suffix) {
    line = Number(suffix[1]);
    if (!Number.isSafeInteger(line) || line < 1) return null;
    href = href.slice(0, suffix.index);
  }

  const target = normalPath(href);
  const root = normalPath(String(workingDir || ''));
  if (!target || !root || target.windows !== root.windows) return null;

  const targetValue = target.windows ? target.value.toLowerCase() : target.value;
  const rootValue = root.windows ? root.value.toLowerCase() : root.value;
  const rootPrefix = rootValue.endsWith('/') ? rootValue : `${rootValue}/`;
  const inside = targetValue === rootValue || targetValue.startsWith(rootPrefix);
  if (!inside) return null;

  return line === undefined ? { path: href } : { path: href, line };
}

/**
 * Lexically normalise POSIX, drive-letter and UNC paths without pulling Node's
 * `path` module into the browser bundle.
 */
function normalPath(input: string): NormalPath | null {
  const source = input.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(source);
  const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(source);
  const windows = Boolean(drive || unc);
  if (!windows && !source.startsWith('/')) return null;

  const prefix = drive
    ? `${drive[1].toUpperCase()}:`
    : unc
      ? `//${unc[1]}/${unc[2]}`
      : '';
  const body = drive
    ? source.slice(drive[0].length)
    : unc
      ? source.slice(unc[0].length)
      : source.slice(1);
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return {
    value: windows
      ? `${prefix}${parts.length ? `/${parts.join('/')}` : drive ? '/' : ''}`
      : `/${parts.join('/')}`,
    windows,
  };
}
