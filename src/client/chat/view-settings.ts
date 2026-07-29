/**
 * What the chat surface shows — and nothing else.
 *
 * Deliberately separate from AppSettings, which is about the terminal: font,
 * colourway, install, runtime profiles. Those are properties of the whole app
 * and several of them mean nothing inside a conversation, so pointing the chat
 * header's gear at that dialog offered a page of controls that could not change
 * what was on screen. This is the chat's own: which side panels exist, how the
 * three zones are arranged, and how much of each message the transcript renders.
 *
 * Presentation only, on purpose. Nothing here changes what the agent may do —
 * that is a launch decision and it lives in AppSettings, where it can be found
 * next to the rest of the choices that have consequences.
 *
 * No store import: `shell/store` reads the type from here, and a runtime edge
 * back would make that a cycle. The caller publishes the value.
 */

import { PHONE_TEXT } from '../ui/touch.js';

export type ChatPanelId = 'trace' | 'files' | 'changes' | 'github' | 'agents' | 'links' | 'status';

export const CHAT_PANEL_IDS: ChatPanelId[] = [
  // First, and the default. Since the redesign moved reasoning and tool calls
  // out of the transcript, this tab is where the agent's working is — a rail
  // that opened on "Changes" would hide the machinery behind a second click.
  'trace',
  'files',
  'changes',
  'github',
  'agents',
  'links',
  'status',
];

export const CHAT_PANEL_LABELS: Record<ChatPanelId, string> = {
  trace: 'Trace',
  files: 'Files',
  changes: 'Changes',
  github: 'GitHub',
  agents: 'Agents',
  links: 'Links',
  status: 'Status',
};

export const CHAT_PANEL_ICONS: Record<ChatPanelId, string> = {
  trace: 'list-todo',
  files: 'hard-drive',
  changes: 'file-diff',
  github: 'git-branch',
  agents: 'bot',
  links: 'wifi',
  status: 'gauge',
};

/** Rail width bounds, in px. Narrower is unreadable; wider crowds the chat. */
export const PANEL_MIN_WIDTH = 220;
export const PANEL_MAX_WIDTH = 760;
/** The trace rail's designed width. */
export const PANEL_DEFAULT_WIDTH = 344;

/** Turn-index width, and the icon rail it collapses to below 1280px. */
export const INDEX_WIDTH = 196;
export const INDEX_COLLAPSED_WIDTH = 44;

/**
 * Terminal-split bounds, in px.
 *
 * The floor is a usable shell; the ceiling is recomputed against the viewport at
 * render time (`clampTerminalHeight`) so the transcript can never be squeezed
 * below a readable height by a value restored from storage.
 */
export const TERMINAL_MIN_HEIGHT = 140;
export const TERMINAL_MAX_HEIGHT = 560;
export const TERMINAL_DEFAULT_HEIGHT = 300;
/** Header + ribbon + composer + a readable floor for the transcript. */
export const TERMINAL_VIEWPORT_RESERVE = 380;

export type ProseWidth = 'column' | 'full';
export type ProseDensity = 'compact' | 'comfortable';
export type ActivityFilterId = 'all' | 'tools' | 'reasoning' | 'files';

const PROSE_WIDTHS: ProseWidth[] = ['column', 'full'];
const DENSITIES: ProseDensity[] = ['compact', 'comfortable'];
const ACTIVITY_FILTERS: ActivityFilterId[] = ['all', 'tools', 'reasoning', 'files'];

export interface ChatViewSettings {
  /** Whether the trace/workspace rail is open beside the conversation. */
  panelOpen: boolean;
  /** How wide the rail is, in px. Dragged by its edge, kept across sessions. */
  panelWidth: number;
  /** Which rail tab is showing. */
  panelTab: ChatPanelId;
  /** Which rail tabs exist at all. A disabled panel is not fetched. */
  panels: Record<ChatPanelId, boolean>;
  /** The turn index down the left-hand side. */
  indexOpen: boolean;
  /** The pty split at the bottom of the conversation column. */
  terminalOpen: boolean;
  terminalHeight: number;
  /** Prose column: a 74ch measure, or the full width of the centre column. */
  proseWidth: ProseWidth;
  /** Body type: 13px/1.5, or 14px/1.62 for longer reading. */
  density: ProseDensity;
  /** Which slice of the activity timeline the rail is showing. */
  activityFilter: ActivityFilterId;
  /** Reasoning blocks. Off keeps them out of the timeline entirely. */
  showThinking: boolean;
  /** Tool calls. Off leaves prose only, in the transcript and in the rail. */
  showToolCalls: boolean;
  /** The token/cost readout in the header. */
  showUsage: boolean;
  /** The plan block at the top of the trace rail. */
  showPlan: boolean;
}

export const DEFAULT_CHAT_VIEW: ChatViewSettings = {
  // Open, unlike before the redesign. The rail used to hold optional extras
  // beside a transcript that already showed everything; it now holds the
  // reasoning and the tool calls themselves, and a surface that starts with
  // them hidden is a surface that looks like the agent did nothing.
  panelOpen: true,
  panelWidth: PANEL_DEFAULT_WIDTH,
  panelTab: 'trace',
  panels: {
    trace: true,
    files: true,
    changes: true,
    github: true,
    agents: true,
    links: true,
    status: true,
  },
  indexOpen: true,
  terminalOpen: false,
  terminalHeight: TERMINAL_DEFAULT_HEIGHT,
  proseWidth: 'column',
  density: 'compact',
  activityFilter: 'all',
  showThinking: true,
  showToolCalls: true,
  showUsage: true,
  showPlan: true,
};

const STORAGE_KEY = 'cc-web-chat-view';

function isPanelId(value: unknown): value is ChatPanelId {
  return typeof value === 'string' && (CHAT_PANEL_IDS as string[]).includes(value);
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/**
 * A width the rail can actually be.
 *
 * Storage is not a trusted input — it survives downgrades, hand edits and a
 * half-written value from a crashed tab — and a NaN here would resolve to a
 * `width: NaNpx` the browser drops, leaving a rail with no width at all.
 */
export function clampPanelWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
}

/** The stored height, sanitised. Independent of the viewport. */
export function clampStoredTerminalHeight(value: unknown): number {
  const height = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(height)) return TERMINAL_DEFAULT_HEIGHT;
  return Math.round(Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, height)));
}

/**
 * The height the split may actually take on *this* viewport.
 *
 * A 560px terminal restored onto an 800px window would leave the transcript
 * with nothing, so the ceiling is whatever is left after the bars around it.
 * The floor wins over the ceiling on a very short window: a 40px terminal is
 * not a terminal, and the surface is better off scrolling than pretending.
 */
export function clampTerminalHeight(value: unknown, viewportHeight: number): number {
  const stored = clampStoredTerminalHeight(value);
  const room = Math.max(TERMINAL_MIN_HEIGHT, viewportHeight - TERMINAL_VIEWPORT_RESERVE);
  return Math.min(stored, room);
}

/** Coerce anything storage hands back into a complete, valid settings object. */
export function normalizeChatView(raw: unknown): ChatViewSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatViewSettings> & {
    panels?: Partial<Record<string, unknown>>;
  };

  const panels = { ...DEFAULT_CHAT_VIEW.panels };
  for (const id of CHAT_PANEL_IDS) {
    const value = input.panels?.[id];
    if (typeof value === 'boolean') panels[id] = value;
  }
  // Trace is not optional. The other six panels are extras beside a transcript
  // that stands on its own; this one holds the reasoning and the tool calls
  // themselves, and switching it off would leave no surface in the app that can
  // show them at all. The rail can still be closed — that is a different thing,
  // and one keystroke undoes it.
  panels.trace = true;

  const wanted = isPanelId(input.panelTab) ? input.panelTab : DEFAULT_CHAT_VIEW.panelTab;

  return {
    // A settings object written before the redesign has no `panelOpen: true` in
    // it, and reading its absence as "closed" would hide the trace from every
    // existing user exactly once, with no way to know why.
    panelOpen: input.panelOpen === undefined ? DEFAULT_CHAT_VIEW.panelOpen : input.panelOpen === true,
    panelWidth: clampPanelWidth(input.panelWidth),
    // A stored tab whose panel has since been switched off would open the rail
    // on nothing; fall back to the first one that is actually enabled.
    panelTab: panels[wanted] ? wanted : CHAT_PANEL_IDS.find((id) => panels[id]) ?? wanted,
    panels,
    indexOpen: input.indexOpen !== false,
    terminalOpen: input.terminalOpen === true,
    terminalHeight: clampStoredTerminalHeight(input.terminalHeight),
    proseWidth: oneOf(input.proseWidth, PROSE_WIDTHS, DEFAULT_CHAT_VIEW.proseWidth),
    density: oneOf(input.density, DENSITIES, DEFAULT_CHAT_VIEW.density),
    activityFilter: oneOf(input.activityFilter, ACTIVITY_FILTERS, DEFAULT_CHAT_VIEW.activityFilter),
    showThinking: input.showThinking !== false,
    showToolCalls: input.showToolCalls !== false,
    showUsage: input.showUsage !== false,
    showPlan: input.showPlan !== false,
  };
}

export function loadChatView(): ChatViewSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { ...DEFAULT_CHAT_VIEW };
    return normalizeChatView(JSON.parse(saved));
  } catch {
    // Unparseable or unreadable storage is not worth a broken chat surface.
    return { ...DEFAULT_CHAT_VIEW };
  }
}

export function saveChatView(next: ChatViewSettings): ChatViewSettings {
  const settings = normalizeChatView(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing refuses writes. Applying anyway is right: the change
    // works for this session, it just will not survive a reload.
  }
  return settings;
}

/** The panels that are switched on, in their canonical order. */
export function enabledPanels(settings: ChatViewSettings): ChatPanelId[] {
  return CHAT_PANEL_IDS.filter((id) => settings.panels[id]);
}

/**
 * The CSS custom properties the prose settings publish.
 *
 * Written onto the chat root so components read a token rather than a prop —
 * which keeps `MessageBubble` out of the re-render path when the reading width
 * changes, and lets a code block opt out of the measure with plain CSS.
 */
export function proseVariables(
  settings: ChatViewSettings,
  phone = false,
): Record<string, string> {
  const comfortable = settings.density === 'comfortable';
  return {
    '--chat-prose-width': settings.proseWidth === 'full' ? 'none' : '74ch',
    // The one thing this never took account of, which is how the message ended
    // up the smallest text on a phone (#92): every piece of chrome around it
    // was made phone-aware and raised, and the prose itself was not. See the
    // scale in `PHONE_TEXT`.
    '--chat-prose-size': phone
      ? `${comfortable ? PHONE_TEXT.proseComfortable : PHONE_TEXT.prose}px`
      : comfortable
        ? '14px'
        : 'var(--text-ui)',
    '--chat-prose-leading': comfortable ? '1.62' : phone ? '1.5' : '1.55',
  };
}
