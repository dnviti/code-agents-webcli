// The bridge between the imperative App and the React shell.
//
// App, SessionTabManager and the terminal modules stay in charge of sessions,
// PTY transport and xterm. React only renders chrome, and reads it from here.
// Keeping the flow one-directional is what stops a re-render from being able to
// disturb a live terminal: the shell never owns session state, it mirrors it.

export type ShellTabStatus = 'running' | 'error' | 'idle';

export interface ShellTab {
  id: string;
  title: string;
  status: ShellTabStatus;
  /** Which runtime this session is, used to group the sidebar. */
  kind: string;
  workingDir: string | null;
  unread: boolean;
}

export interface ShellConnection {
  state: 'connected' | 'connecting' | 'disconnected';
  workingDir: string | null;
}

export interface ShellState {
  tabs: ShellTab[];
  activeId: string | null;
  connection: ShellConnection;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  theme: 'dark' | 'light';
}

const INITIAL: ShellState = {
  tabs: [],
  activeId: null,
  connection: { state: 'disconnected', workingDir: null },
  sidebarOpen: true,
  paletteOpen: false,
  theme: 'dark',
};

export class ShellStore {
  private state: ShellState = INITIAL;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): ShellState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Replace the parts of the state that changed.
   *
   * Bails out when nothing actually differs. Session code calls sync() from
   * several places for the same logical event (a tab switch also touches
   * history, order and status), and without this each of those would be a
   * separate render.
   */
  setState(patch: Partial<ShellState>): void {
    let changed = false;
    const next: ShellState = { ...this.state };

    for (const key of Object.keys(patch) as (keyof ShellState)[]) {
      if (this.applyKey(next, key, patch)) changed = true;
    }

    if (!changed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /**
   * Copy one key across, keeping the key and its value tied to the same type
   * parameter. Written as a generic rather than inlined because indexing a
   * union of keys loses the correspondence and only a cast would satisfy it.
   */
  private applyKey<K extends keyof ShellState>(
    next: ShellState,
    key: K,
    patch: Partial<ShellState>,
  ): boolean {
    const value = patch[key];
    if (value === undefined) return false;
    if (shallowEqual(this.state[key], value)) return false;
    next[key] = value;
    return true;
  }
}

/** One level deep, which is all the shapes above ever need. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => shallowEqual(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    return (
      ak.length === bk.length &&
      ak.every(
        (k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k],
      )
    );
  }
  return false;
}

export const shellStore = new ShellStore();
