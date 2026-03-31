// Terminal initialization: create xterm instance, addons, and event handlers

import type { App } from '../app';
import { createTerminalController } from './controller';
import { stripUnsupportedTerminalSequences } from './text';

export function setupTerminal(app: App): void {
  const isMobile = app.isMobile;
  const fontSize = isMobile ? 12 : 14;
  app.terminalController = createTerminalController({ fontSize });
  app.terminal = app.terminalController.terminal;

  const terminalEl = document.getElementById('terminal');
  if (terminalEl) {
    app.terminalController.open(terminalEl);
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
}
