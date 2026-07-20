// Terminal initialization: create xterm instance, addons, and event handlers

import type { App } from '../app';
import { createTerminalController, DEFAULT_THEME } from './controller';
import { HistoryView } from './history-view';
import { stripUnsupportedTerminalSequences } from './text';
import { attachImageDrop, attachImagePaste, type ImagePasteTarget } from './paste';

export function setupTerminal(app: App): void {
  const isMobile = app.isMobile;
  const fontSize = isMobile ? 12 : 14;
  app.terminalController = createTerminalController({ fontSize });
  app.terminal = app.terminalController.terminal;

  const terminalEl = document.getElementById('terminal');
  if (terminalEl) {
    app.terminalController.open(terminalEl);

    const pasteTarget: ImagePasteTarget = {
      element: terminalEl,
      getSessionId: () => app.currentClaudeSessionId,
      sendText: (text) => app.send({ type: 'input', data: text }),
      isConnected: () => app.socket?.readyState === WebSocket.OPEN,
    };
    attachImagePaste(pasteTarget);
    attachImageDrop(pasteTarget);
    app.imagePasteTarget = pasteTarget;
  }

  const historyHost = document.querySelector('.terminal-wrapper') as HTMLElement | null;
  if (historyHost) {
    app.historyView = new HistoryView({
      container: historyHost,
      fontSize,
      fontFamily: 'JetBrains Mono, Fira Code, Monaco, Consolas, monospace',
      theme: DEFAULT_THEME as Record<string, string>,
      fetchPage: (fromLine, count) => requestHistoryPage(app, fromLine, count),
      onExit: () => {
        app.fitTerminal();
        app.terminal?.scrollToBottom();
      },
      onExport: () => {
        if (app.currentClaudeSessionId) {
          window.location.href = `/api/sessions/${app.currentClaudeSessionId}/export.md`;
        }
      },
    });

    // Reaching the top of the live buffer is the hand-off point: everything
    // above it lives on the server, one page at a time.
    app.terminalController.onReachedTop(() => {
      if (app.historyView?.isOpen || !app.terminal) {
        return;
      }
      const anchor = app.historyRange.totalLines - app.terminal.buffer.active.baseY;
      app.historyView?.open(Math.max(app.historyRange.firstLine, anchor));
    });
  }

  app.terminal.onData((data: string) => {
    if (app.socket && app.socket.readyState === WebSocket.OPEN) {
      const filteredData = stripUnsupportedTerminalSequences(data);
      if (filteredData) {
        app.send({ type: 'input', data: filteredData });
      }
    }
  });

  app.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    if (app.socket && app.socket.readyState === WebSocket.OPEN) {
      app.send({ type: 'resize', cols, rows });
    }
  });
}

export function fitTerminal(app: App): void {
  app.terminalController?.fit();
  app.historyView?.fit();
}

const HISTORY_TIMEOUT_MS = 8000;

function requestHistoryPage(app: App, fromLine: number, count: number): Promise<string[]> {
  const sessionId = app.currentClaudeSessionId;
  if (!sessionId || !app.socket || app.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve([]);
  }

  const requestId = `h${++app.historyRequestSeq}`;

  return new Promise<string[]>((resolve) => {
    // Never leave the viewer waiting forever on a reply that will not come
    // (socket dropped mid-request, server error): resolve empty and let the
    // next scroll retry.
    const timer = window.setTimeout(() => {
      app.historyRequests.delete(requestId);
      resolve([]);
    }, HISTORY_TIMEOUT_MS);

    app.historyRequests.set(requestId, (lines) => {
      window.clearTimeout(timer);
      resolve(lines);
    });

    app.send({ type: 'history_request', sessionId, fromLine, count, requestId });
  });
}
