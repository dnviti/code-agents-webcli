import * as React from 'react';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Badge, BadgeVariant } from '../../ui/relay/Badge.js';
import { PHONE_SPACE, PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';

/**
 * A browser for a session's working tree, shown beside the conversation.
 *
 * Mirrors the shape src/server/routes/folders.ts already returns (name, path,
 * isDirectory) rather than inventing a second directory-listing contract — the
 * server route this panel's `onExpand` should call back onto lists exactly
 * these fields.
 */
export interface FileTreeEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
}

export type FileChangeKind = 'create' | 'update' | 'delete' | 'rename';

export interface FileTreePanelProps {
  root: string;
  entries: FileTreeEntry[];
  onExpand: (path: string) => Promise<FileTreeEntry[]>;
  onOpen?: (path: string) => void;
  changed?: Record<string, FileChangeKind>;
  loading?: boolean;
  onRefresh?: () => void;
}

/**
 * Rendered nodes per directory level. A repo checkout can hand back tens of
 * thousands of entries in one folder (node_modules, a build output dir); an
 * unbounded map over that on every keystroke or expand is what makes a file
 * tree infamous for tab-lockup bug reports. Capping and offering "show more"
 * keeps first paint and re-render bounded without pulling in a virtualization
 * library the rest of this app doesn't otherwise depend on.
 */
const RENDER_CAP = 300;

interface NodeState {
  expanded: boolean;
  /** null = never fetched. Distinct from `[]`, which is a fetched empty dir. */
  children: FileTreeEntry[] | null;
  loading: boolean;
  error: string | null;
  /** Set once the user asks to see everything past RENDER_CAP for this node. */
  capOverride?: number;
}

const DEFAULT_NODE: NodeState = { expanded: false, children: null, loading: false, error: null };

const CHANGE_LETTER: Record<FileChangeKind, string> = {
  create: 'A',
  update: 'M',
  delete: 'D',
  rename: 'R',
};

const CHANGE_VARIANT: Record<FileChangeKind, BadgeVariant> = {
  create: 'success',
  update: 'warning',
  delete: 'destructive',
  // Badge has no dedicated "info" variant; outline plus an explicit colour
  // override reuses the token rather than inventing a seventh badge variant
  // for one call site.
  rename: 'outline',
};

const CHANGE_STYLE: Record<FileChangeKind, React.CSSProperties | undefined> = {
  create: undefined,
  update: undefined,
  delete: undefined,
  rename: { color: 'var(--info)', borderColor: 'color-mix(in oklab, var(--info) 38%, transparent)' },
};

/**
 * `:focus-visible` is unsupported in some older engines and in jsdom, where
 * `matches` throws on the selector. Failing open shows the ring rather than
 * silently stranding keyboard users with no focus indicator at all.
 */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

function sortEntries(list: FileTreeEntry[]): FileTreeEntry[] {
  return [...list].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function visibleSlice(
  list: FileTreeEntry[],
  node: NodeState,
): { shown: FileTreeEntry[]; remaining: number } {
  const sorted = sortEntries(list);
  const cap = node.capOverride ?? RENDER_CAP;
  return { shown: sorted.slice(0, cap), remaining: Math.max(0, sorted.length - cap) };
}

function formatSize(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return null;
  if (bytes < 1024) return `${bytes}B`;
  const units = ['K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

/** Count of changed paths under a directory, for the collapsed roll-up marker. */
function descendantChangeCount(changed: Record<string, FileChangeKind> | undefined, dirPath: string): number {
  if (!changed) return 0;
  const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  let count = 0;
  for (const p in changed) {
    if (p.startsWith(prefix)) count += 1;
  }
  return count;
}

/** Flat, keyboard-addressable projection of the tree, used only for arrow-key math. */
type NavRow =
  | { kind: 'entry'; navKey: string; entry: FileTreeEntry; level: number; parentPath: string }
  | { kind: 'more'; navKey: string; parentPath: string; level: number; remaining: number };

function buildNavRows(
  list: FileTreeEntry[],
  level: number,
  parentPath: string,
  nodes: Record<string, NodeState>,
): NavRow[] {
  const parentNode = nodes[parentPath] ?? DEFAULT_NODE;
  const { shown, remaining } = visibleSlice(list, parentNode);
  const rows: NavRow[] = [];
  for (const entry of shown) {
    rows.push({ kind: 'entry', navKey: entry.path, entry, level, parentPath });
    if (entry.isDirectory) {
      const node = nodes[entry.path] ?? DEFAULT_NODE;
      if (node.expanded && node.children) {
        rows.push(...buildNavRows(node.children, level + 1, entry.path, nodes));
      }
    }
  }
  if (remaining > 0) {
    rows.push({ kind: 'more', navKey: `${parentPath}\u0000more`, parentPath, level, remaining: remaining });
  }
  return rows;
}

interface RowContext {
  nodes: Record<string, NodeState>;
  changed?: Record<string, FileChangeKind>;
  activeKey: string;
  registerRef: (key: string, el: HTMLDivElement | null) => void;
  onActivate: (row: NavRow) => void;
  onFocusKey: (key: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>, row: NavRow) => void;
}

function ChangeBadge({ kind, roundUp }: { kind: FileChangeKind | null; roundUp: number }) {
  const isPhone = usePhone();
  // Badge is a desktop-density primitive — 18px tall at `--text-2xs` — and it
  // takes no phone of its own. Overridden here rather than there because the
  // letter it draws is the only thing in the row that says a file changed, and
  // at 10px on a phone it is a smudge beside a 15px name.
  const scale: React.CSSProperties | null = isPhone
    ? { height: TOUCH_TARGET / 2, padding: `0 ${PHONE_SPACE.inline}px`, fontSize: PHONE_TEXT.meta }
    : null;
  if (kind) {
    return (
      <Badge variant={CHANGE_VARIANT[kind]} dot style={{ ...CHANGE_STYLE[kind], flex: '0 0 auto', ...scale }}>
        {CHANGE_LETTER[kind]}
      </Badge>
    );
  }
  if (roundUp > 0) {
    // Badge takes no `title` prop; the tooltip belongs on a wrapper so hover
    // still spells out what the collapsed count means.
    return (
      <span title={`${roundUp} changed file${roundUp === 1 ? '' : 's'} inside`}>
        <Badge variant="neutral" dot style={{ flex: '0 0 auto', ...scale }}>
          {roundUp}
        </Badge>
      </span>
    );
  }
  return null;
}

function EntryRow({
  entry,
  level,
  parentPath,
  ctx,
}: {
  entry: FileTreeEntry;
  level: number;
  parentPath: string;
  ctx: RowContext;
}) {
  const node = ctx.nodes[entry.path] ?? DEFAULT_NODE;
  const [hover, setHover] = React.useState(false);
  const [keyboardFocus, setKeyboardFocus] = React.useState(false);
  const isPhone = usePhone();
  const navRow: NavRow = { kind: 'entry', navKey: entry.path, entry, level, parentPath };
  const directChange = ctx.changed ? ctx.changed[entry.path] ?? null : null;
  const rollup = entry.isDirectory && !directChange ? descendantChangeCount(ctx.changed, entry.path) : 0;
  const size = !entry.isDirectory ? formatSize(entry.size) : null;
  const active = ctx.activeKey === entry.path;

  return (
    <div
      ref={(el) => ctx.registerRef(entry.path, el)}
      role="treeitem"
      aria-level={level}
      aria-expanded={entry.isDirectory ? node.expanded : undefined}
      // Declared, not wired: the app's right-click menu reads these off
      // whatever was under the pointer, so this row gets Download and Upload
      // without the tree knowing a menu exists or the menu knowing about trees.
      data-workspace-path={entry.path}
      data-workspace-kind={entry.isDirectory ? 'directory' : 'file'}
      tabIndex={active ? 0 : -1}
      onFocus={(event) => {
        ctx.onFocusKey(entry.path);
        setKeyboardFocus(isKeyboardFocus(event.currentTarget));
      }}
      onBlur={() => setKeyboardFocus(false)}
      onKeyDown={(event) => ctx.onKeyDown(event, navRow)}
      onClick={(event) => {
        event.stopPropagation();
        ctx.onFocusKey(entry.path);
        ctx.onActivate(navRow);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={entry.path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: isPhone ? PHONE_SPACE.inline : 6,
        height: isPhone ? TOUCH_TARGET : 26,
        minHeight: isPhone ? TOUCH_TARGET : 26,
        // The row *is* the target, and rows stack. Sized alone they are one
        // continuous strip with invisible seams, and which file opens is
        // decided by which half of a seam the thumb landed in — so the gap
        // goes between them, and the radius is what makes it look deliberate.
        marginBottom: isPhone ? TOUCH_GAP : undefined,
        borderRadius: isPhone ? 'var(--radius)' : undefined,
        paddingLeft: (isPhone ? PHONE_SPACE.edge : 6) + (level - 1) * 16,
        paddingRight: isPhone ? PHONE_SPACE.edge : 8,
        cursor: 'pointer',
        outline: 'none',
        background: hover ? 'var(--accent)' : 'transparent',
        boxShadow: keyboardFocus ? 'var(--shadow-focus)' : 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          width: isPhone ? 18 : 13,
          height: isPhone ? 18 : 13,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--muted-foreground)',
          transform: entry.isDirectory && node.expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform var(--duration-fast) var(--ease-standard)',
        }}
      >
        {entry.isDirectory ? <Icon name="chevron-right" size={isPhone ? 16 : 12} /> : null}
      </span>
      <Icon
        name="folder"
        size={isPhone ? 18 : 14}
        style={{
          flex: '0 0 auto',
          color: entry.isDirectory ? 'var(--info)' : 'var(--muted-foreground)',
          display: entry.isDirectory ? 'inline-block' : 'none',
        }}
      />
      {!entry.isDirectory ? (
        <Icon
          name="file-text"
          size={isPhone ? 18 : 14}
          style={{ flex: '0 0 auto', color: 'var(--muted-foreground)' }}
        />
      ) : null}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-sm)',
          color: 'var(--foreground)',
        }}
      >
        {entry.name}
      </span>
      {size ? (
        <span
          style={{
            flex: '0 0 auto',
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {size}
        </span>
      ) : null}
      <ChangeBadge kind={directChange} roundUp={rollup} />
    </div>
  );
}

function StatusRow({ level, text, tone }: { level: number; text: string; tone: 'muted' | 'destructive' }) {
  const isPhone = usePhone();
  return (
    <div
      role="presentation"
      style={{
        display: 'flex',
        alignItems: 'center',
        height: isPhone ? TOUCH_TARGET : 24,
        paddingLeft: (isPhone ? PHONE_SPACE.edge : 6) + level * 16,
        fontFamily: 'var(--font-sans)',
        fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
        color: tone === 'destructive' ? 'var(--destructive)' : 'var(--muted-foreground)',
      }}
    >
      {text}
    </div>
  );
}

function MoreRow({ parentPath, level, remaining, ctx }: { parentPath: string; level: number; remaining: number; ctx: RowContext }) {
  const navKey = `${parentPath}\u0000more`;
  const row: NavRow = { kind: 'more', navKey, parentPath, level, remaining };
  const active = ctx.activeKey === navKey;
  const [hover, setHover] = React.useState(false);
  const [keyboardFocus, setKeyboardFocus] = React.useState(false);
  const isPhone = usePhone();
  return (
    <div
      ref={(el) => ctx.registerRef(navKey, el)}
      role="treeitem"
      aria-level={level}
      tabIndex={active ? 0 : -1}
      onFocus={(event) => {
        ctx.onFocusKey(navKey);
        setKeyboardFocus(isKeyboardFocus(event.currentTarget));
      }}
      onBlur={() => setKeyboardFocus(false)}
      onKeyDown={(event) => ctx.onKeyDown(event, row)}
      onClick={(event) => {
        event.stopPropagation();
        ctx.onFocusKey(navKey);
        ctx.onActivate(row);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: isPhone ? TOUCH_TARGET : 24,
        marginBottom: isPhone ? TOUCH_GAP : undefined,
        borderRadius: isPhone ? 'var(--radius)' : undefined,
        // Lines up with the *names* above it, not with their twisties: the
        // indent is the rows' own plus the twisty and the gap after it, both
        // of which grow with the scale.
        paddingLeft: (isPhone ? PHONE_SPACE.edge : 6) + (level - 1) * 16 + (isPhone ? 26 : 19),
        cursor: 'pointer',
        outline: 'none',
        background: hover ? 'var(--accent)' : 'transparent',
        boxShadow: keyboardFocus ? 'var(--shadow-focus)' : 'none',
        color: 'var(--info)',
        fontFamily: 'var(--font-sans)',
        fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
      }}
    >
      Show {remaining} more…
    </div>
  );
}

/** Recursively renders one directory's children, nesting expanded subtrees in a real `role="group"` so the DOM structure — not just aria-level — carries the hierarchy. */
function TreeChildren({
  list,
  level,
  parentPath,
  ctx,
}: {
  list: FileTreeEntry[];
  level: number;
  parentPath: string;
  ctx: RowContext;
}) {
  const parentNode = ctx.nodes[parentPath] ?? DEFAULT_NODE;
  const { shown, remaining } = visibleSlice(list, parentNode);
  return (
    <>
      {shown.map((entry) => {
        const node = ctx.nodes[entry.path] ?? DEFAULT_NODE;
        return (
          <React.Fragment key={entry.path}>
            <EntryRow entry={entry} level={level} parentPath={parentPath} ctx={ctx} />
            {entry.isDirectory && node.expanded ? (
              <div role="group">
                {node.loading ? <StatusRow level={level} text="Loading…" tone="muted" /> : null}
                {!node.loading && node.error ? (
                  <StatusRow level={level} text={node.error} tone="destructive" />
                ) : null}
                {!node.loading && !node.error && node.children && node.children.length === 0 ? (
                  <StatusRow level={level} text="Empty directory" tone="muted" />
                ) : null}
                {!node.loading && !node.error && node.children && node.children.length > 0 ? (
                  <TreeChildren list={node.children} level={level + 1} parentPath={entry.path} ctx={ctx} />
                ) : null}
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
      {remaining > 0 ? <MoreRow parentPath={parentPath} level={level} remaining={remaining} ctx={ctx} /> : null}
    </>
  );
}

export function FileTreePanel({
  root,
  entries,
  onExpand,
  onOpen,
  changed,
  loading = false,
  onRefresh,
}: FileTreePanelProps): React.JSX.Element {
  const [nodes, setNodes] = React.useState<Record<string, NodeState>>({});
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const refs = React.useRef(new Map<string, HTMLDivElement>());
  const isPhone = usePhone();

  const registerRef = React.useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  }, []);

  const navRows = React.useMemo(
    () => (loading ? [] : buildNavRows(entries, 1, root, nodes)),
    [entries, nodes, root, loading],
  );

  // The active row can vanish out from under a stale key (its parent just
  // collapsed, or a fetch replaced its list) — fall back to the first row
  // rather than leaving roving tabindex pointing at nothing focusable.
  const effectiveActiveKey =
    (activeKey && navRows.some((r) => r.navKey === activeKey) ? activeKey : navRows[0]?.navKey) ?? '';

  const toggle = (entry: FileTreeEntry) => {
    const current = nodes[entry.path] ?? DEFAULT_NODE;
    if (current.expanded) {
      setNodes((prev) => ({ ...prev, [entry.path]: { ...(prev[entry.path] ?? DEFAULT_NODE), expanded: false } }));
      return;
    }
    if (current.children !== null) {
      setNodes((prev) => ({ ...prev, [entry.path]: { ...(prev[entry.path] ?? DEFAULT_NODE), expanded: true } }));
      return;
    }
    // First expansion of this directory: fetch, and only this once — the
    // fetched list is cached in `children` so re-collapsing and reopening it
    // does not hit the server again.
    setNodes((prev) => ({
      ...prev,
      [entry.path]: { ...(prev[entry.path] ?? DEFAULT_NODE), expanded: true, loading: true, error: null },
    }));
    onExpand(entry.path)
      .then((children) => {
        setNodes((prev) => ({ ...prev, [entry.path]: { ...(prev[entry.path] ?? DEFAULT_NODE), loading: false, children } }));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load directory';
        setNodes((prev) => ({ ...prev, [entry.path]: { ...(prev[entry.path] ?? DEFAULT_NODE), loading: false, error: message } }));
      });
  };

  const showAll = (path: string) => {
    setNodes((prev) => ({ ...prev, [path]: { ...(prev[path] ?? DEFAULT_NODE), capOverride: Number.MAX_SAFE_INTEGER } }));
  };

  const activate = (row: NavRow) => {
    if (row.kind === 'more') {
      showAll(row.parentPath);
      return;
    }
    if (row.entry.isDirectory) {
      toggle(row.entry);
      return;
    }
    onOpen?.(row.entry.path);
  };

  const focusRow = (row: NavRow) => {
    setActiveKey(row.navKey);
    refs.current.get(row.navKey)?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, row: NavRow) => {
    const index = navRows.findIndex((r) => r.navKey === row.navKey);
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = navRows[index + 1];
        if (next) focusRow(next);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = navRows[index - 1];
        if (prev) focusRow(prev);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (row.kind === 'entry' && row.entry.isDirectory) {
          const node = nodes[row.entry.path] ?? DEFAULT_NODE;
          if (!node.expanded) {
            toggle(row.entry);
          } else {
            const next = navRows[index + 1];
            if (next && next.parentPath === row.entry.path) focusRow(next);
          }
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (row.kind === 'entry' && row.entry.isDirectory) {
          const node = nodes[row.entry.path] ?? DEFAULT_NODE;
          if (node.expanded) {
            toggle(row.entry);
            break;
          }
        }
        if (row.parentPath === root) break;
        const parentRow = navRows.find((r) => r.kind === 'entry' && r.entry.path === row.parentPath);
        if (parentRow) focusRow(parentRow);
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (navRows[0]) focusRow(navRows[0]);
        break;
      }
      case 'End': {
        event.preventDefault();
        if (navRows.length) focusRow(navRows[navRows.length - 1]);
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        activate(row);
        break;
      }
      default:
        break;
    }
  };

  const ctx: RowContext = {
    nodes,
    changed,
    activeKey: effectiveActiveKey,
    registerRef,
    onActivate: activate,
    onFocusKey: setActiveKey,
    onKeyDown: handleKeyDown,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isPhone ? TOUCH_GAP : 6,
          // Room for what is in it: IconButton takes the touch floor on a
          // phone by itself, and a 34px strip left the refresh control hanging
          // five pixels out of both ends of its own border.
          height: isPhone ? TOUCH_TARGET + TOUCH_GAP : 34,
          minHeight: isPhone ? TOUCH_TARGET + TOUCH_GAP : 34,
          padding: isPhone ? `0 ${TOUCH_GAP}px 0 ${PHONE_SPACE.edge}px` : '0 6px 0 10px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Icon
          name="hard-drive"
          size={isPhone ? 18 : 13}
          style={{ flex: '0 0 auto', color: 'var(--muted-foreground)' }}
        />
        <span
          title={root}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {root}
        </span>
        {onRefresh ? (
          <IconButton label="Refresh file tree" size={isPhone ? 'lg' : 'sm'} onClick={onRefresh} disabled={loading}>
            <Icon name="refresh-cw" size={isPhone ? 18 : 13} />
          </IconButton>
        ) : null}
      </div>
      <div
        role="tree"
        aria-label={`Files in ${root}`}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: isPhone ? `${TOUCH_GAP}px 0` : '4px 0',
        }}
      >
        {loading ? (
          <div
            style={{
              padding: '10px 12px',
              fontFamily: 'var(--font-sans)',
              fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-sm)',
              color: 'var(--muted-foreground)',
            }}
          >
            Loading files…
          </div>
        ) : entries.length === 0 ? (
          <div
            style={{
              padding: '10px 12px',
              fontFamily: 'var(--font-sans)',
              fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-sm)',
              color: 'var(--muted-foreground)',
            }}
          >
            No files here
          </div>
        ) : (
          <TreeChildren list={entries} level={1} parentPath={root} ctx={ctx} />
        )}
      </div>
    </div>
  );
}
