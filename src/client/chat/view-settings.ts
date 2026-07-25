/**
 * What the chat surface shows — and nothing else.
 *
 * Deliberately separate from AppSettings, which is about the terminal: font,
 * colourway, install, runtime profiles. Those are properties of the whole app
 * and several of them mean nothing inside a conversation, so pointing the chat
 * header's gear at that dialog offered a page of controls that could not change
 * what was on screen. This is the chat's own: which side panels exist, and how
 * much of each message the transcript renders.
 *
 * Presentation only, on purpose. Nothing here changes what the agent may do —
 * that is a launch decision and it lives in AppSettings, where it can be found
 * next to the rest of the choices that have consequences.
 *
 * No store import: `shell/store` reads the type from here, and a runtime edge
 * back would make that a cycle. The caller publishes the value.
 */

export type ChatPanelId = 'files' | 'changes' | 'github' | 'agents' | 'links' | 'status';

export const CHAT_PANEL_IDS: ChatPanelId[] = ['files', 'changes', 'github', 'agents', 'links', 'status'];

export const CHAT_PANEL_LABELS: Record<ChatPanelId, string> = {
  files: 'Files',
  changes: 'Changes',
  github: 'GitHub',
  agents: 'Agents',
  links: 'Links',
  status: 'Status',
};

export const CHAT_PANEL_ICONS: Record<ChatPanelId, string> = {
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
export const PANEL_DEFAULT_WIDTH = 320;

export interface ChatViewSettings {
  /** Whether the workspace rail is open beside the conversation. */
  panelOpen: boolean;
  /** How wide the rail is, in px. Dragged by its edge, kept across sessions. */
  panelWidth: number;
  /** Which rail tab is showing. */
  panelTab: ChatPanelId;
  /** Which rail tabs exist at all. A disabled panel is not fetched. */
  panels: Record<ChatPanelId, boolean>;
  /** Reasoning blocks. Collapsed either way; this removes them entirely. */
  showThinking: boolean;
  /** Tool call cards. Off leaves prose only. */
  showToolCalls: boolean;
  /** The token/cost readout in the header. */
  showUsage: boolean;
  /** The plan rail beside the transcript. */
  showPlan: boolean;
}

export const DEFAULT_CHAT_VIEW: ChatViewSettings = {
  // Closed by default: the conversation is the surface, and a rail that opens
  // itself takes half the width of a laptop before the user has asked for it.
  panelOpen: false,
  panelWidth: PANEL_DEFAULT_WIDTH,
  panelTab: 'changes',
  panels: { files: true, changes: true, github: true, agents: true, links: true, status: true },
  showThinking: true,
  showToolCalls: true,
  showUsage: true,
  showPlan: true,
};

const STORAGE_KEY = 'cc-web-chat-view';

function isPanelId(value: unknown): value is ChatPanelId {
  return typeof value === 'string' && (CHAT_PANEL_IDS as string[]).includes(value);
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

  const wanted = isPanelId(input.panelTab) ? input.panelTab : DEFAULT_CHAT_VIEW.panelTab;

  return {
    panelOpen: input.panelOpen === true,
    panelWidth: clampPanelWidth(input.panelWidth),
    // A stored tab whose panel has since been switched off would open the rail
    // on nothing; fall back to the first one that is actually enabled.
    panelTab: panels[wanted] ? wanted : CHAT_PANEL_IDS.find((id) => panels[id]) ?? wanted,
    panels,
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
