// The bridge between the imperative App and the React shell.
//
// App, SessionTabManager and the terminal modules stay in charge of sessions,
// PTY transport and xterm. React only renders chrome, and reads it from here.
// Keeping the flow one-directional is what stops a re-render from being able to
// disturb a live terminal: the shell never owns session state, it mirrors it.
//
// Every surface the app has — tab strip, dialogs, overlay, toasts, banner,
// mobile bar — is now rendered from this one snapshot. The imperative modules
// that used to call `document.getElementById(...).classList.add('active')` call
// `shellStore.setState({ ... })` instead and keep the rest of their logic.

import type { NotifySettings, SessionListItem } from '../types';
import type { ConversationAttention } from '../../shared/chat-alerts';
import type { ConfirmRequest } from '../ui/confirm';
import { DEFAULT_CHAT_VIEW, type ChatViewSettings } from '../chat/view-settings';

export type ShellTabStatus = 'running' | 'error' | 'idle';

export interface ShellTab {
  id: string;
  title: string;
  status: ShellTabStatus;
  /** Which runtime this session is. Not yet plumbed through from the server. */
  kind: string;
  workingDir: string | null;
  unread: boolean;
  /**
   * Whether this conversation has stopped and is waiting on a person.
   *
   * A scalar rather than an object because tabs are compared one level deep
   * (see `shallowEqual`), and because it is the one thing about a conversation
   * a tab strip can usefully say: this is not progress, it is a stop that only
   * the user can end. Null for terminals and for conversations that are working
   * or idle.
   */
  attention: ConversationAttention | null;
  /**
   * Which surface this session runs on, fixed when it was started.
   *
   * Defaults to terminal until the server says otherwise, which it does from
   * the session list, from `session_joined` and from `chat_started`.
   */
  surface: 'terminal' | 'chat';
}

/**
 * The chat surface's slice.
 *
 * Holds a live controller object rather than plain data, which is unusual for
 * this store but correct here: the transcript is mutated thousands of times per
 * turn and has its own subscription, so putting its contents in the shell state
 * would re-render the whole shell per token. The store carries only the handle.
 */
export interface ShellChat {
  /** True when the session in focus runs on the chat surface. */
  active: boolean;
  /** Which conversation is on screen. Empty when the terminal is showing. */
  sessionId: string;
  controller: unknown | null;
  runtime: string;
  runtimeLabel: string;
  workingDir: string;
  /**
   * Bumped every time this slice is republished, so that it always is.
   *
   * The store's `shallowEqual` guard exists to stop a redundant patch waking
   * every subscriber, and it is right about almost everything here. It was wrong
   * about this slice in one specific and invisible way: a controller announcing
   * that something it owns has changed republishes the *same* six values — same
   * controller object, same session id, same runtime — so the guard saw no
   * change and told nobody.
   *
   * What that cost was every piece of conversation state living on the
   * controller rather than on the transcript: the model override, the effort
   * level, and above all the feedback line that reports what the server actually
   * did with a change. Those only ever redrew when something else happened to
   * move the transcript in the same moment, which is why a `live` switch looked
   * fine and a `cleared` or `pending` one left the previous answer on screen —
   * the runtime emits an event for the first and nothing at all for the others.
   *
   * A counter rather than dropping the guard for this slice, because the guard
   * is load-bearing everywhere else and "this republication is meaningful" is a
   * claim the caller should have to make rather than a property of the shape.
   */
  revision: number;
}

/*
 * The approval mode is deliberately absent here.
 *
 * It used to be one field on this store, set when a chat launched — so a browser
 * with several conversations open showed whichever one launched last, and a
 * `session_joined` for a different chat left the previous chat's answer in place.
 * It lives on each conversation's transcript now, hydrated from the server
 * snapshot, which is the only thing that knows the mode of a conversation whose
 * process is gone. See ChatTranscript.bypassing.
 */

export interface ShellConnection {
  state: 'connected' | 'connecting' | 'disconnected';
  workingDir: string | null;
}

/**
 * Which single-purpose panel the connection overlay is showing.
 *
 * `null` is "no overlay". The three views are the same three the old
 * `#overlay > .overlay-content` switched between, so `showOverlay()` keeps its
 * meaning and all of its call sites.
 */
export type OverlayView = 'loading' | 'start' | 'error' | null;

export interface ShellDialogs {
  settings: boolean;
  /** Per-runtime launch configuration: model, args, env, tiers. */
  runtimeProfiles: boolean;
  /** The per-user environment size picker; only reachable when the server has environments. */
  environment: boolean;
  newSession: boolean;
  terminalOptions: boolean;
  /** The session list, reachable from the mobile bar and the palette. */
  sessions: boolean;
  /**
   * Every conversation this user has, grouped by project and searchable.
   *
   * Separate from `sessions` because they answer different questions: that one
   * lists what is running on the server right now and offers to join or delete
   * it, this one lists conversations — including the ones nothing is running and
   * the ones whose tab was closed — and offers to reopen them.
   */
  conversations: boolean;
  /** The mobile tab switcher sheet. */
  tabs: boolean;
  /** The mobile "More" sheet. */
  more: boolean;
  /** Session id being renamed, or null. Doubles as the open flag. */
  rename: string | null;
  /** The chat surface's own presentation settings. */
  chatSettings: boolean;
  /** The token/cost accounting dashboard. */
  usage: boolean;
}

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderState {
  open: boolean;
  path: string | null;
  parentPath: string | null;
  entries: FolderEntry[];
  showHidden: boolean;
  loading: boolean;
  /** True while the inline "new folder" row is open. */
  creating: boolean;
}

export type ToastVariant = 'info' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

/**
 * The update banner, flattened to exactly what it paints.
 *
 * `update-banner.ts` still owns polling, the apply request and the restart
 * poll; it derives this and hands it over. `log` is pre-joined so the whole
 * object stays one level deep, which is all `shallowEqual` below compares.
 */
export interface BannerView {
  tone: string;
  text: string;
  actionLabel: string | null;
  showLog: boolean;
  logOpen: boolean;
  dismissible: boolean;
  log: string;
}

export type InstallState =
  | 'installed'
  | 'available'
  | 'ios'
  | 'insecure'
  | 'blocked'
  | 'unsupported';

export interface ShellState {
  tabs: ShellTab[];
  activeId: string | null;
  connection: ShellConnection;
  paletteOpen: boolean;
  theme: 'dark' | 'light';
  /** Set once at boot from `detectMobile()`; drives the bottom bar. */
  isMobile: boolean;
  /** Whether the on-screen terminal key strip is showing (mobile only). */
  keysVisible: boolean;
  /**
   * One-shot Ctrl latch for the key strip: the next terminal input is sent
   * as its control code. In the store so both the strip (paint) and the
   * terminal's onData path (transform) can reach it.
   */
  ctrlLatched: boolean;
  dialogs: ShellDialogs;
  folder: FolderState;
  overlay: OverlayView;
  /** Replaces the loading view's default line; empty means use the default. */
  overlayMessage: string;
  errorText: string;
  chat: ShellChat;
  /** Formatted plan text, or null when the plan dialog is closed. */
  plan: string | null;
  toasts: ToastItem[];
  /** Backing list for the sessions sheet. */
  sessionList: SessionListItem[];
  /**
   * The open yes/no question, or null.
   *
   * Held here rather than owned by whoever asked, because the code that needs
   * to ask is largely not React — a service-worker callback, the update banner
   * — and the store is how every other imperative module reaches the shell.
   */
  confirm: ConfirmRequest | null;
  banner: BannerView | null;
  /** GitHub login of the signed-in user, when the server reports one. */
  user: string | null;
  /** Sign-out URL, when the deployment has auth enabled. */
  logoutUrl: string | null;
  /**
   * Whether this window can become an installed app.
   *
   * `available` means a deferred `beforeinstallprompt` is in hand. `ios` means
   * the browser can install but only through its own share sheet, so the UI has
   * to explain rather than offer a button.
   *
   * `insecure` is the one people actually hit here: this server is normally
   * reached at http://<host>:32352 from another machine, and a plain-http
   * origin that is not localhost gets no service worker and no install prompt
   * however capable the browser is. It is separate from `unsupported` because
   * the two need opposite advice — one is fixed by changing the URL, the other
   * cannot be fixed at all.
   *
   * `blocked` is the https version of the same trap: the page loads, the scheme
   * says secure, and the browser still refuses the service worker because it
   * does not trust the certificate. Nothing about that is visible from the page
   * except that the worker never becomes ready.
   */
  install: InstallState;
  /**
   * Whether a web chat launched now would skip tool approvals.
   *
   * Mirrored out of AppSettings so the launcher can label the button that acts
   * on it. Reading storage separately in both places is how a control ends up
   * promising something other than what it does.
   */
  chatBypassPermissions: boolean;
  /**
   * When a conversation may interrupt the user, mirrored out of AppSettings.
   *
   * Read on every chat event of every conversation this browser watches, which
   * is why it is here rather than parsed out of localStorage at the point of
   * use. Six flat booleans, so the store's one-level equality check still sees
   * a no-op patch for what it is.
   */
  notifications: NotifySettings;
  /** Which chat panels are shown, and what the transcript renders. */
  chatView: ChatViewSettings;
}


const INITIAL: ShellState = {
  tabs: [],
  activeId: null,
  connection: { state: 'disconnected', workingDir: null },
  paletteOpen: false,
  theme: 'dark',
  isMobile: false,
  keysVisible: true,
  ctrlLatched: false,
  dialogs: {
    settings: false,
    runtimeProfiles: false,
    environment: false,
    newSession: false,
    terminalOptions: false,
    sessions: false,
    conversations: false,
    tabs: false,
    more: false,
    rename: null,
    chatSettings: false,
    usage: false,
  },
  folder: {
    open: false,
    path: null,
    parentPath: null,
    entries: [],
    showHidden: false,
    loading: false,
    creating: false,
  },
  overlay: null,
  overlayMessage: '',
  errorText: '',
  chat: {
    active: false,
    sessionId: '',
    controller: null,
    runtime: '',
    runtimeLabel: '',
    workingDir: '',
    revision: 0,
  },
  plan: null,
  toasts: [],
  sessionList: [],
  confirm: null,
  banner: null,
  user: null,
  logoutUrl: null,
  install: 'unsupported',
  chatBypassPermissions: false,
  // Replaced by `applySettings` during boot, before the first render. On until
  // then so a conversation that finishes during startup is not silently missed
  // by a store that had not read the user's choice yet.
  notifications: {
    enabled: true,
    finished: true,
    failed: true,
    approval: true,
    question: true,
    details: true,
  },
  chatView: DEFAULT_CHAT_VIEW,
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
   * Merge a patch into one nested slice.
   *
   * `setState({ dialogs: { settings: true } })` would drop every other dialog
   * flag, so each caller would otherwise have to spread the current slice by
   * hand. Doing it here means a caller that only knows about its own field
   * cannot silently close somebody else's panel.
   */
  patchSlice<K extends 'dialogs' | 'folder'>(key: K, patch: Partial<ShellState[K]>): void {
    const merged = { ...this.state[key], ...patch };
    this.setState({ [key]: merged } as Partial<ShellState>);
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
