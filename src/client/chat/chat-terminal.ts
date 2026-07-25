/**
 * A shell, in the conversation's own working directory.
 *
 * Not a second terminal implementation: this is the same xterm controller, the
 * same ANSI filter and the same socket protocol the main terminal surface uses,
 * wired up per pane the way `splits/split-container.ts` already does it for a
 * side-by-side split. What is new is only *where* it is mounted and *which* cwd
 * it opens in.
 *
 * Each pane is a real session on the server — created through the same
 * `/api/sessions/create` route as any other, then started as a `terminal`
 * runtime — so its scrollback is stored, its history is pageable and it
 * survives the browser going away. It is deliberately its own session rather
 * than a second process inside the chat's: the chat session's slot is occupied
 * by the agent, and the server refuses a second process in one session.
 *
 * DOM-owning and imperative, like the rest of the terminal layer. React mounts
 * the element this creates; it never re-parents it.
 */

import { createTerminalController, type TerminalController } from '../terminal/controller.js';
import { stripUnsupportedTerminalSequences } from '../terminal/text.js';
import { attachImageDrop, attachImagePaste, type ImagePasteTarget } from '../terminal/paste.js';
import { withCtrlLatch } from '../ui/mobile.js';
import { relayTerminalTheme } from '../shell/terminal-theme.js';

export type ChatTerminalPhase = 'starting' | 'live' | 'exited' | 'error';

export interface ChatTerminalInit {
  workingDir: string;
  /** Shown on the tab. */
  label: string;
  fontSize?: number;
  /** Called whenever anything a tab strip renders has changed. */
  onChange: () => void;
}

let seq = 0;

export class ChatTerminal {
  readonly id = `chat-term-${++seq}`;
  /** The node React mounts. Created here so the buffer survives a re-render. */
  readonly element: HTMLDivElement;

  label: string;
  phase: ChatTerminalPhase = 'starting';
  error: string | null = null;
  sessionId: string | null = null;
  cols = 0;
  rows = 0;

  private controller: TerminalController | null = null;
  private socket: WebSocket | null = null;
  private closing = false;
  private readonly workingDir: string;
  /**
   * Mutable, not readonly.
   *
   * Panes outlive the component that mounts them (see the registry below), so
   * the callback captured at construction belongs to a React tree that has
   * since unmounted. Calling it after the split is reopened updates nothing —
   * the tab strip's live dot and its cols×rows readout simply stop moving.
   * `attach()` re-points it at whichever mount is currently showing this pane.
   */
  private onChange: () => void;

  constructor(init: ChatTerminalInit) {
    this.label = init.label;
    this.workingDir = init.workingDir;
    this.onChange = init.onChange;

    this.element = document.createElement('div');
    this.element.style.width = '100%';
    this.element.style.height = '100%';
    this.element.style.minHeight = '0';

    this.controller = createTerminalController({
      fontSize: init.fontSize ?? 13,
      theme: relayTerminalTheme() ?? undefined,
    });
    this.controller.open(this.element);

    const terminal = this.controller.terminal;

    terminal.onData((data: string) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      // The Ctrl latch lives at onData, the one path every input method reaches
      // — Android keyboards type through IME composition and never fire a
      // usable keydown — so it has to apply here too or the latch silently dies
      // in this pane.
      const filtered = stripUnsupportedTerminalSequences(withCtrlLatch(data));
      if (filtered) this.socket.send(JSON.stringify({ type: 'input', data: filtered }));
    });

    terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      this.cols = cols;
      this.rows = rows;
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
      this.onChange();
    });

    // This pane owns its own socket, so it needs its own sender; everything
    // else about the image-paste path is shared with the main terminal.
    const pasteTarget: ImagePasteTarget = {
      element: this.element,
      getSessionId: () => this.sessionId,
      sendText: (text) => this.socket?.send(JSON.stringify({ type: 'input', data: text })),
      pasteText: (text) => this.controller?.terminal.paste(text),
      isConnected: () => this.socket?.readyState === WebSocket.OPEN,
    };
    attachImagePaste(pasteTarget);
    attachImageDrop(pasteTarget);
  }

  /** Point this pane at the mount currently rendering it. */
  attach(onChange: () => void): void {
    this.onChange = onChange;
  }

  /**
   * Attach to a session that already exists.
   *
   * Used when the split is reopened after a page reload: the pty is still
   * running on the server, and creating a second one beside it would leave the
   * first with nothing on screen referring to it.
   */
  attachExisting(sessionId: string): void {
    this.sessionId = sessionId;
    this.connect(sessionId);
  }

  /** Create the session, join it, and start a shell in it. */
  async start(): Promise<void> {
    try {
      const response = await fetch('/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.label, workingDir: this.workingDir }),
      });
      if (!response.ok) {
        throw new Error(await describe(response));
      }
      const data = (await response.json()) as { sessionId?: string };
      if (!data.sessionId) throw new Error('The server created no session.');
      if (this.closing) return;
      this.sessionId = data.sessionId;
      this.connect(data.sessionId);
    } catch (error) {
      // The bare message is often "Failed to fetch", which names the API and
      // not the thing the user was doing. The sentence has to start with that.
      const detail = error instanceof Error ? error.message : String(error);
      this.fail(`The terminal could not be started — ${detail}`);
    }
  }

  private connect(sessionId: string): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(
      `${protocol}//${location.host}?sessionId=${encodeURIComponent(sessionId)}`,
    );
    this.socket = socket;

    socket.onopen = () => {
      const terminal = this.controller?.terminal;
      if (!terminal) return;
      const { cols, rows } = terminal;
      this.cols = cols;
      this.rows = rows;
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      socket.send(JSON.stringify({ type: 'start_terminal', options: { cols, rows } }));
    };

    socket.onmessage = (event: MessageEvent) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        // A frame this pane cannot parse is one the main surface would have
        // ignored too; dropping it must not take the pane down.
        return;
      }
      this.handle(message);
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.closing) return;
      // No reconnect loop here on purpose. The pane is a disclosure the user
      // opened; a socket that quietly retries for a shell nobody is watching is
      // a socket that outlives its reason to exist. Closing and reopening the
      // split starts a fresh one.
      if (this.phase !== 'error') this.phase = 'exited';
      this.onChange();
    };

    socket.onerror = () => {
      if (!this.closing) this.fail('The connection to this terminal failed.');
    };
  }

  private handle(message: Record<string, unknown>): void {
    const type = String(message.type || '');
    switch (type) {
      case 'output':
        this.controller?.write(stripUnsupportedTerminalSequences(String(message.data ?? '')));
        break;

      case 'session_joined': {
        const buffer = message.outputBuffer;
        this.controller?.terminal.reset();
        if (Array.isArray(buffer) && buffer.length) {
          this.controller?.write(stripUnsupportedTerminalSequences(buffer.join('')));
        }
        this.fit();
        break;
      }

      case 'exit':
        this.controller?.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
        this.phase = 'exited';
        this.onChange();
        break;

      case 'error':
        this.fail(String(message.message || 'The terminal reported an error.'));
        break;

      default:
        // Every runtime announces itself with its own `<kind>_started`; the
        // shell is live from the first of them, whichever it is.
        if (type.endsWith('_started')) {
          this.phase = 'live';
          this.error = null;
          this.onChange();
        }
        break;
    }
  }

  private fail(message: string): void {
    this.phase = 'error';
    this.error = message;
    this.controller?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    this.onChange();
  }

  fit(): void {
    this.controller?.fit();
  }

  focus(): void {
    this.controller?.terminal.focus();
  }

  /** True when the pty, not the page, owns the keyboard. */
  hasFocus(): boolean {
    return this.element.contains(document.activeElement);
  }

  clear(): void {
    this.controller?.terminal.clear();
  }

  applyTheme(): void {
    const theme = relayTerminalTheme();
    if (!theme || !this.controller) return;
    this.controller.terminal.options.theme = theme;
    this.controller.restoreViewport();
  }

  /**
   * Let go of the browser's half.
   *
   * The session on the server stays: it is a real session with a real pty, it
   * appears in the tab strip like any other, and a long-running process in it
   * must not die because a panel was collapsed. `close()` is the other verb.
   */
  dispose(): void {
    this.closing = true;
    try {
      this.socket?.close();
    } catch {
      // Already closing; there is nothing left to release on this side.
    }
    this.socket = null;
    this.controller?.dispose();
    this.controller = null;
    this.element.remove();
  }

  /**
   * End it for good: the user closed the tab.
   *
   * Without this every open of the split would leave a pty behind that nothing
   * on screen refers to — after an afternoon of toggling, a dozen shells
   * holding a working directory open and a row each in the session list.
   */
  close(): void {
    const sessionId = this.sessionId;
    this.dispose();
    if (!sessionId) return;
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {
      // The pane is gone either way; a session that outlives it is a tidiness
      // problem, not something worth an error in the user's face.
    });
  }
}

/**
 * The shells belonging to each conversation.
 *
 * Held outside React so collapsing the split — which unmounts the whole pane —
 * does not kill a `npm run dev` the user left running in it, and re-opening it
 * shows the same scrollback rather than a brand-new session.
 *
 * Bounded, because each pane holds an xterm (with a WebGL context) and an open
 * socket: past `MAX_CHATS` conversations the least recently touched one has its
 * browser-side panes released. The *sessions* stay — they are ordinary tabs and
 * reopening the split rejoins them — so nothing the user started is killed by
 * the cap; only this page's copy of the terminal is let go.
 */
const BY_CHAT = new Map<string, ChatTerminal[]>();
const MAX_CHATS = 4;

/**
 * Which server sessions a conversation's panes are attached to.
 *
 * Session storage, so a reload reattaches rather than opening a second pty
 * beside the one it left running — the same leak the registry fixes for a
 * collapse, one level up. Session-scoped rather than local: a shell from a
 * browser session that has ended is not something to reconnect to a week later.
 */
const REMEMBERED = 'cc-web-chat-terminals';

function readRemembered(): Record<string, string[]> {
  try {
    const raw = sessionStorage.getItem(REMEMBERED);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** The sessions this conversation's panes were attached to, if any. */
export function rememberedTerminals(chatSessionId: string): string[] {
  const ids = readRemembered()[chatSessionId];
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

export function rememberTerminals(chatSessionId: string, sessionIds: string[]): void {
  try {
    const all = readRemembered();
    if (sessionIds.length) all[chatSessionId] = sessionIds;
    else delete all[chatSessionId];
    sessionStorage.setItem(REMEMBERED, JSON.stringify(all));
  } catch {
    // Without storage the split simply opens a fresh shell after a reload,
    // which is the behaviour it had before this existed.
  }
}

export function terminalsFor(chatSessionId: string): ChatTerminal[] {
  const existing = BY_CHAT.get(chatSessionId);
  if (existing) {
    // Re-insert so Map iteration order is least-recently-used first.
    BY_CHAT.delete(chatSessionId);
    BY_CHAT.set(chatSessionId, existing);
    return existing;
  }

  const panes: ChatTerminal[] = [];
  BY_CHAT.set(chatSessionId, panes);

  while (BY_CHAT.size > MAX_CHATS) {
    const oldest = BY_CHAT.keys().next().value;
    if (oldest === undefined) break;
    for (const pane of BY_CHAT.get(oldest) ?? []) pane.dispose();
    BY_CHAT.delete(oldest);
  }

  return panes;
}

/** Drop a pane from its conversation's list, ending the session behind it. */
export function closeTerminal(chatSessionId: string, id: string): void {
  const panes = terminalsFor(chatSessionId);
  const at = panes.findIndex((pane) => pane.id === id);
  if (at < 0) return;
  panes[at].close();
  panes.splice(at, 1);
}

async function describe(response: Response): Promise<string> {
  const detail = await response
    .json()
    .then((body: { error?: string; message?: string }) => body.error || body.message)
    .catch(() => null);
  return detail || `The server refused to create a session (${response.status}).`;
}
