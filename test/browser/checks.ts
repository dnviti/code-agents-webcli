/**
 * Client-side checks that only a real browser can answer: whether a renderer is
 * actually obtained, whether the viewport really reaches the bottom, and
 * whether the history viewer pages as you scroll.
 *
 * Run with `npm run test:browser` (needs Google Chrome).
 *
 * Two headless limitations are worked around explicitly rather than hidden:
 * headless Chrome dispatches no native `scroll` events, so scrolling is driven
 * with synthetic ones; and with no compositor the DOM renderer never paints
 * glyphs, so content is asserted against the terminal buffer — the source of
 * truth for what gets displayed — not against DOM text.
 */

import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { ChatController } from '../../src/client/chat/controller';
import { ChatView } from '../../src/client/shell/chat/ChatView';
import { DEFAULT_CHAT_VIEW } from '../../src/client/chat/view-settings';
import { createTerminalController, LIVE_SCROLLBACK_LINES } from '../../src/client/terminal/controller';
import { HistoryView } from '../../src/client/terminal/history-view';
import { Dialog } from '../../src/client/ui/relay/Dialog';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ` :: ${detail}` : ''}`);
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const scroll = (el: HTMLElement, top: number): void => {
  el.scrollTop = top;
  el.dispatchEvent(new Event('scroll'));
};

async function run(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:800px;height:400px;position:absolute;top:0;left:0';
  document.body.appendChild(host);

  const controller = createTerminalController({ fontSize: 14 });
  controller.open(host);
  await wait(200);

  check(
    'terminal opens with a usable geometry',
    controller.terminal.cols > 10 && controller.terminal.rows > 5,
    `${controller.terminal.cols}x${controller.terminal.rows}`,
  );
  check(
    'an accelerated renderer is obtained (or cleanly falls back)',
    ['webgl', 'dom'].includes(controller.rendererKind()),
    controller.rendererKind(),
  );

  // Issue #19 (copy from the terminal), asserted at the real layer: the
  // controller must intercept a right-click when there is a selection to copy,
  // and leave the native menu alone when there is not. select() makes a
  // deterministic selection without depending on rendered glyphs or the
  // Clipboard API (unavailable in a headless file:// context).
  controller.terminal.select(0, 0, 5);
  const menuWithSelection = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  host.dispatchEvent(menuWithSelection);
  check('right-click with a selection is intercepted for copy', menuWithSelection.defaultPrevented);

  controller.terminal.clearSelection();
  const menuNoSelection = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  host.dispatchEvent(menuNoSelection);
  check('right-click with no selection leaves the native menu', !menuNoSelection.defaultPrevented);

  let text = '';
  for (let i = 0; i < 3000; i++) {
    text += `riga ${i}\r\n`;
  }
  controller.write(text);
  await wait(600);

  const buffer = controller.terminal.buffer.active;
  check('output written through the batching path arrives', buffer.baseY > 0, `baseY=${buffer.baseY}`);
  check('the viewport stays pinned to the newest output', controller.isAtBottom());

  // The live buffer must be *bounded*, because everything older is the server's
  // job to page back in. Asserting that against the real 20k limit would need
  // 20k lines of output to say anything, so it is asserted against a small
  // explicit limit on a throwaway terminal — the limit is a parameter, and what
  // is under test is that the parameter is honoured — plus one assertion that
  // the default is the constant the rest of the app reasons about.
  const boundedHost = document.createElement('div');
  boundedHost.style.cssText = 'width:800px;height:400px;position:absolute;top:0;left:0';
  document.body.appendChild(boundedHost);
  const bounded = createTerminalController({ fontSize: 14, scrollback: 500 });
  bounded.open(boundedHost);
  let overflow = '';
  for (let i = 0; i < 1500; i++) {
    overflow += `riga ${i}\r\n`;
  }
  bounded.write(overflow);
  await wait(400);
  const boundedBuffer = bounded.terminal.buffer.active;
  check(
    'the live scrollback stays bounded',
    boundedBuffer.baseY === 500,
    `baseY=${boundedBuffer.baseY} after 1500 lines into a 500-line buffer`,
  );
  check(
    'and the default bound is the one the app pages against',
    LIVE_SCROLLBACK_LINES === 20000,
    `LIVE_SCROLLBACK_LINES=${LIVE_SCROLLBACK_LINES}`,
  );
  bounded.dispose();
  boundedHost.remove();

  let reachedTop = 0;
  controller.onReachedTop(() => {
    reachedTop += 1;
  });

  controller.terminal.scrollToTop();
  await wait(80);
  check('scrolling up leaves the bottom', !controller.isAtBottom());
  check('reaching the top signals the hand-off to history', reachedTop > 0, `fired ${reachedTop}x`);

  // Already parked at the top: there is no scroll left to emit an event, so
  // the wheel gesture itself has to keep working.
  const atTop = reachedTop;
  host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  await wait(80);
  check(
    'scrolling up again while already at the top still signals',
    reachedTop > atTop,
    `fired ${reachedTop}x total`,
  );

  controller.terminal.scrollToBottom();
  await wait(60);
  const after = controller.terminal.buffer.active;
  check(
    'scrolling back down reaches the very bottom',
    controller.isAtBottom() && after.viewportY === after.baseY,
    `viewportY=${after.viewportY} baseY=${after.baseY}`,
  );

  // --- history viewer ---
  const historyHost = document.createElement('div');
  historyHost.style.cssText = 'width:800px;height:400px;position:relative';
  document.body.appendChild(historyHost);

  const requested: Array<{ from: number; count: number }> = [];
  let exited = 0;
  const view = new HistoryView({
    container: historyHost,
    fontSize: 14,
    fontFamily: 'monospace',
    theme: { background: '#0d1117', foreground: '#f0f6fc' },
    fetchPage: async (from, count) => {
      requested.push({ from, count });
      return Array.from({ length: count }, (_, index) => `storia ${from + index}`);
    },
    onExit: () => {
      exited += 1;
    },
  });

  const TOTAL = 100_000;
  view.setRange({ firstLine: 0, totalLines: TOTAL });
  view.open(50_000);
  await wait(300);

  check('history view opens', view.isOpen);
  check(
    'it asks for a page at the anchor',
    requested.length > 0 && requested[0].from < 50_000 && requested[0].from > 49_000,
    JSON.stringify(requested[0]),
  );
  check(
    'it asks for one screenful, not the whole session',
    requested[0].count > 0 && requested[0].count < 100,
    `count=${requested[0].count}`,
  );

  const historyBuffer = (view as unknown as { terminal: { buffer: { active: any } } }).terminal.buffer
    .active;
  const firstRow = historyBuffer.getLine(0)?.translateToString(true);
  check('the fetched page lands in the terminal', firstRow === `storia ${requested[0].from}`, String(firstRow));

  const status = historyHost.querySelector('.history-view__status') as HTMLElement;
  const statusText = status.textContent || '';
  check(
    'the status line reports the real position',
    // The whole session, not the page: a viewer that says "1–19 of 19" tells
    // the user they have reached the end of a 100k-line history.
    statusText.includes(`of ${TOTAL}`) && statusText.includes(String(requested[0].from + 1)),
    JSON.stringify(statusText),
  );

  const spacer = historyHost.querySelector('.history-view__spacer') as HTMLElement;
  const scroller = historyHost.querySelector('.history-view__scroller') as HTMLElement;
  check('the scrollbar spans the whole session', spacer.clientHeight > 100_000, `${spacer.clientHeight}px`);

  const before = requested.length;
  scroll(scroller, Math.max(0, scroller.scrollTop - 200_000));
  await wait(300);
  const newer = requested.slice(before);
  check(
    'scrolling up pages further back',
    newer.length > 0 && newer[newer.length - 1].from < requested[0].from,
    JSON.stringify(newer[newer.length - 1] ?? null),
  );

  // The top of the range must be reachable, not just approachable.
  scroll(scroller, 0);
  await wait(300);
  check(
    'the oldest line is reachable',
    requested[requested.length - 1].from === 0,
    JSON.stringify(requested[requested.length - 1]),
  );

  // And so must the bottom: this is where the viewer hands back to the live
  // terminal, and a coordinate mismatch here strands the user in history.
  scroll(scroller, spacer.clientHeight);
  await wait(200);
  check('scrolling past the newest line returns to live', exited > 0 && !view.isOpen, `exited=${exited}`);

  await checkModeQueriesDoNotKillTheTerminal();
  await checkATallDialogStaysOnScreen();
  await checkTheComposerShrinksWithTheWorkspaceRail();

  const pre = document.createElement('pre');
  pre.id = 'results';
  pre.textContent = results.join('\n');
  document.body.appendChild(pre);
}

/**
 * A program that asks the terminal what it supports must not be able to stop it
 * rendering.
 *
 * DECRQM (`CSI ? <mode> $p`) is how a modern TUI probes for synchronized
 * output, in-band resize and friends before it draws anything. xterm answers it
 * from a handler that runs inside the write loop, so an exception there does
 * not just drop the reply: it tears down the loop, and every later write — from
 * this program or any other sharing the terminal — is silently discarded. The
 * screen simply stops at whatever was on it, which for a program that probes
 * before its first frame is nothing at all.
 *
 * That is not hypothetical; it is what shipped. The build settings turned
 * xterm's reply-code enum into an assignment to an undeclared name, which
 * throws in a strict-mode bundle. This check is written against the behaviour
 * rather than the sequence so it keeps its meaning if the cause ever changes.
 */
async function checkModeQueriesDoNotKillTheTerminal(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:800px;height:400px;position:absolute;top:0;left:600px';
  document.body.appendChild(host);

  const controller = createTerminalController({ fontSize: 14 });
  controller.open(host);
  await wait(200);

  const replies: string[] = [];
  controller.terminal.onData((data) => replies.push(data));

  const errors: string[] = [];
  const onError = (event: ErrorEvent): void => { errors.push(event.message); };
  window.addEventListener('error', onError);

  // The five modes a real agent CLI probes at startup, each followed by the
  // primary-device-attributes query it uses to detect "no answer".
  const queries = [2026, 2048, 2031, 1010, 1011]
    .map((mode) => `\x1b[?${mode}$p\x1b[c`)
    .join('');
  controller.terminal.write(queries);
  await wait(200);

  check(
    'a mode query is answered',
    replies.some((reply) => reply.includes('$y')),
    JSON.stringify(replies.slice(0, 6)),
  );
  check('a mode query throws nothing', errors.length === 0, errors.join(' | '));

  // The real damage was here: everything written afterwards vanished.
  const marker = 'still-alive-after-mode-query';
  controller.terminal.write(`\r\n${marker}\r\n`);
  await wait(200);

  const buffer = controller.terminal.buffer.active;
  let rendered = false;
  for (let row = 0; row < buffer.length; row++) {
    if (buffer.getLine(row)?.translateToString(true).includes(marker)) {
      rendered = true;
      break;
    }
  }
  check('the terminal still renders after a mode query', rendered);

  window.removeEventListener('error', onError);
  controller.dispose();
  host.remove();
}

/**
 * A dialog with more content than fits must scroll, not overflow the window.
 *
 * The overlay centres the panel, so an uncapped panel that outgrows the
 * viewport hangs off *both* edges — the title row ends up above the top of the
 * window, and since the overlay is `position: fixed` there is nothing to scroll
 * to reach it. The runtime-profiles dialog hit this as soon as it had more than
 * a couple of profiles in it.
 *
 * Only a real layout engine can answer this, which is why it lives here rather
 * than in the jsdom suite: it is entirely about measured geometry.
 */
async function checkATallDialogStaysOnScreen(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const rows = Array.from({ length: 60 }, (_, index) =>
    React.createElement('p', { key: index, style: { height: 48, margin: 0 } }, `row ${index}`),
  );
  createRoot(host).render(
    React.createElement(
      Dialog,
      {
        open: true,
        title: 'Tall dialog',
        description: 'More content than the window can hold',
        footer: React.createElement('button', { type: 'button' }, 'Save'),
        onClose: () => {},
        width: 720,
      },
      React.createElement('div', null, ...rows),
    ),
  );
  await wait(250);

  const panel = document.querySelector('[role="dialog"]') as HTMLElement | null;
  if (!panel) {
    check('a tall dialog renders', false);
    return;
  }

  const box = panel.getBoundingClientRect();
  check(
    'a tall dialog fits inside the window',
    box.height <= window.innerHeight,
    `panel ${Math.round(box.height)}px vs viewport ${window.innerHeight}px`,
  );
  // The failure that actually bites: content centred past the top edge is
  // unreachable, so the title and the close button are simply gone.
  check('its title stays reachable', box.top >= 0, `top=${Math.round(box.top)}px`);
  check(
    'its footer stays reachable',
    box.bottom <= window.innerHeight,
    `bottom=${Math.round(box.bottom)}px of ${window.innerHeight}px`,
  );

  // Header, body, footer — the body is the middle one and the only scroller.
  const body = panel.children[1] as HTMLElement | undefined;
  check(
    'the overflow moves into the body',
    !!body && body.scrollHeight > body.clientHeight,
    body ? `scrollHeight=${body.scrollHeight} clientHeight=${body.clientHeight}` : 'no body',
  );

  // Header and footer must keep their own height rather than being squeezed
  // away to make room — that is what flex would do to them by default.
  const header = panel.children[0] as HTMLElement | undefined;
  const footer = panel.children[2] as HTMLElement | undefined;
  check(
    'the header and footer are not squeezed',
    !!header && header.clientHeight > 20 && !!footer && footer.clientHeight > 20,
    `header=${header?.clientHeight} footer=${footer?.clientHeight}`,
  );

  // And scrolling the body actually moves it.
  if (body) {
    body.scrollTop = body.scrollHeight;
    await wait(50);
    check('the body scrolls to the end', body.scrollTop > 0, `scrollTop=${body.scrollTop}`);
  }

  host.remove();
}


/**
 * The composer belongs to the conversation column, and must shrink with it.
 *
 * Two defects in one check, both of which static markup renders as passing:
 *
 *   1. The composer used to be a sibling of the row holding the workspace rail,
 *      so it ran the full width of the surface and the rail was simply drawn on
 *      top of its left end.
 *   2. Moving it into the column was not enough. The region holding it is a CSS
 *      grid, and a grid item has `min-width: auto` exactly the way a flex item
 *      does — so the implicit track refused to go below the composer's
 *      min-content width and a wide rail pushed it off the right edge instead.
 *      Only a layout engine can tell those apart from a correct layout, which
 *      is why this check lives here.
 */
async function checkTheComposerShrinksWithTheWorkspaceRail(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:360px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const controller = new ChatController('browser-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'browser-check',
    snapshot: {
      sessionId: 'browser-check',
      runtime: 'claude',
      state: 'thinking',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: true, commands: [{ name: 'clear' }],
      },
      messages: [],
      pendingPermissions: [],
      queued: [{ id: 'q1', text: 'a message waiting its turn', ts: 1 }],
      firstSeq: 1,
      replayFrom: 1,
      cursor: 1,
      live: true,
      bypassPermissions: false,
    },
  } as never);

  const root = createRoot(host);
  const paint = (panelWidth: number): void => {
    root.render(
      React.createElement(ChatView, {
        controller,
        runtime: 'claude',
        runtimeLabel: 'Claude Code',
        workingDir: '/tmp/project',
        view: { ...DEFAULT_CHAT_VIEW, panelOpen: true, panelTab: 'files', panelWidth },
        onViewChange: () => {},
      } as never),
    );
  };

  // Wide enough that the rail takes most of the surface, which is the case that
  // broke: at the default 320 the column had room to spare and both defects
  // looked fine.
  for (const panelWidth of [320, 560]) {
    paint(panelWidth);
    await wait(250);

    const rail = host.querySelector('aside[aria-label="Workspace"]') as HTMLElement | null;
    const textarea = host.querySelector('textarea') as HTMLElement | null;
    if (!rail || !textarea) {
      check(`the composer renders beside a ${panelWidth}px rail`, false);
      continue;
    }

    const railBox = rail.getBoundingClientRect();
    const inputBox = textarea.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();

    check(
      `a ${panelWidth}px rail starts before the composer does`,
      inputBox.left >= railBox.right,
      `rail ends ${Math.round(railBox.right)}, composer starts ${Math.round(inputBox.left)}`,
    );
    check(
      `a ${panelWidth}px rail leaves the composer inside the surface`,
      inputBox.right <= hostBox.right + 1,
      `composer ends ${Math.round(inputBox.right)}, surface ends ${Math.round(hostBox.right)}`,
    );
  }

  root.unmount();
  host.remove();
}

run().catch((error: unknown) => {
  const pre = document.createElement('pre');
  pre.id = 'results';
  pre.textContent = `FAIL :: threw :: ${error instanceof Error ? error.stack : String(error)}`;
  document.body.appendChild(pre);
});
