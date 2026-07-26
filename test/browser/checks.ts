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
import { MobileBar } from '../../src/client/shell/MobileBar';
import { MoreSheet } from '../../src/client/shell/MoreSheet';
import { TabSwitcherSheet } from '../../src/client/shell/TabSwitcherSheet';

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
  await checkTheFixedBarsNeverWrap();
  await checkALiveAnswerAppearsAsItStreams();
  await checkThePhoneLayoutIsUsable();
  await checkThePhoneShellSurfacesAreUsable();

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

    // The rail sits to the *right* of the conversation since the redesign, so
    // the test of "neither is drawn over the other" runs the other way: the
    // composer has to end before the rail begins.
    check(
      `a ${panelWidth}px rail starts after the composer ends`,
      inputBox.right <= railBox.left + 1,
      `composer ends ${Math.round(inputBox.right)}, rail starts ${Math.round(railBox.left)}`,
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

/**
 * The fixed-height bars must never wrap, at any width the app is used at.
 *
 * Acceptance criterion §7.5 of the design spec, and the one defect class this
 * layout is most exposed to: the header, the turn strips and the terminal tab
 * bar are all a fixed height with a money figure or a token count on the right.
 * One item that refuses to shrink pushes the row to two lines — which changes
 * the height of everything below it — or clips the number, which is worse than
 * not showing it. Static markup renders both as passing; only a layout engine
 * knows.
 *
 * The rule the components implement, asserted here rather than described: the
 * low-value items shrink (`min-width: 0` + ellipsis) and the numbers do not.
 */
async function checkTheFixedBarsNeverWrap(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const controller = new ChatController('bar-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'bar-check',
    snapshot: {
      sessionId: 'bar-check',
      runtime: 'claude',
      state: 'running',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: true, commands: [{ name: 'clear' }],
      },
      // Deliberately the widest realistic values: six-figure token counts, a
      // four-decimal cost, a long branch name and a deep working directory.
      usage: { totalTokens: 987654, costUsd: 1234.5678, contextWindow: 200000, contextUsed: 190000 },
      messages: [
        {
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'please refactor the authentication middleware so that it validates the bearer token against the new issuer, then update every call site that still assumes the old claim shape, and make sure the integration tests cover the expired-token path as well as the malformed-header path' }],
        },
        {
          id: 'a1', seq: 2, turnId: 't1', role: 'assistant', ts: Date.now(),
          blocks: [
            { kind: 'text', text: 'an answer' },
            { kind: 'thinking', text: 'working' },
            {
              kind: 'tool', toolId: 'x1', name: 'bash', toolKind: 'execute',
              status: 'completed', input: { command: 'npm test' }, durationMs: 754321,
            },
          ],
          usage: { inputTokens: 123456, outputTokens: 98765, costUsd: 1234.5678 },
        },
        {
          id: 'u2', seq: 3, turnId: 't2', role: 'user', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'and now a second turn, so the first one folds' }],
        },
        {
          id: 'a2', seq: 4, turnId: 't2', role: 'assistant', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'done' }],
        },
      ],
      pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1, cursor: 2,
      live: true, bypassPermissions: true,
    },
  } as never);

  // A fresh mount per width rather than one root re-rendered three times: the
  // surface measures itself with a ResizeObserver to decide which zones fit,
  // and re-rendering a live tree into a resized box is not the same thing as
  // opening it at that size — which is what a user actually does.
  for (const width of [924, 1280, 1600]) {
    host.style.cssText = `width:${width}px;height:760px;position:absolute;top:0;left:0;display:flex`;
    const root = createRoot(host);
    root.render(
      React.createElement(ChatView, {
        controller,
        runtime: 'claude',
        runtimeLabel: 'Claude Code',
        workingDir: '/home/dev/projects/a-rather-deeply-nested-working-directory',
        branch: 'feature/a-long-enough-branch-name-to-crowd-the-bar',
        view: { ...DEFAULT_CHAT_VIEW, terminalOpen: true },
        onViewChange: () => {},
      } as never),
    );
    await wait(400);

    const bars: Array<[string, HTMLElement | null]> = [
      ['session header', host.querySelector('header')],
      ['turn strip', host.querySelector('[data-turn-id]')],
      ['turn index header', host.querySelector('nav[aria-label="Turns"] div')],
      ['activity filter row', host.querySelector('[aria-label="Activity"] [role="tablist"]')],
      ['terminal tab bar', host.querySelector('[role="tablist"][aria-label="Terminals"]')],
    ];

    for (const [name, bar] of bars) {
      if (!bar) {
        // The turn index is a rail only above 1024px; below that it is a sheet
        // and its header legitimately is not on screen.
        if (name === 'turn index header' && width < 1024) continue;
        check(
          `${name} renders at ${width}px`,
          false,
          `not found; navs=${host.querySelectorAll('nav').length} tablists=${host.querySelectorAll('[role="tablist"]').length}`,
        );
        continue;
      }
      // One line, not two: a wrapped bar is taller than the box it was given.
      check(
        `the ${name} does not wrap at ${width}px`,
        bar.scrollHeight <= bar.clientHeight + 1,
        `scrollHeight=${bar.scrollHeight} clientHeight=${bar.clientHeight}`,
      );
    }

    // And the figures people came to read are inside their bar, not clipped
    // off its right edge.
    const header = host.querySelector('header') as HTMLElement | null;
    if (header) {
      const headerBox = header.getBoundingClientRect();
      const overflowing = Array.from(header.querySelectorAll('*')).filter((node) => {
        const box = (node as HTMLElement).getBoundingClientRect();
        return box.width > 0 && box.right > headerBox.right + 1;
      });
      check(
        `nothing in the header is clipped at ${width}px`,
        overflowing.length === 0,
        overflowing.length
          ? overflowing
              .map((n) => `${n.tagName.toLowerCase()}:${(n.textContent || '').trim().slice(0, 18) || (n as HTMLElement).getAttribute('aria-label') || '?'}`)
              .join(' | ')
          : '0 overflowing',
      );
    }

    root.unmount();
  }

  host.remove();
}

/**
 * The chat has to show the answer while it is being written.
 *
 * Every layer under this was already covered — the reducer applies the events,
 * the transcript bumps its version, the strips re-render — and the chat still
 * went blank in 5.1.2, because the list looked its messages up in a map that
 * was built once and never rebuilt. Nothing short of mounting the real view
 * and streaming into it catches that, so this asserts the only thing that
 * actually matters: the words reach the screen.
 */
async function checkALiveAnswerAppearsAsItStreams(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:1280px;height:760px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const controller = new ChatController('live-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'live-check',
    snapshot: {
      sessionId: 'live-check', runtime: 'claude', state: 'idle',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: true, commands: [],
      },
      messages: [
        {
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'the question already in the transcript' }],
        },
      ],
      pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1, cursor: 1,
      live: true, bypassPermissions: false,
    },
  } as never);

  const root = createRoot(host);
  root.render(
    React.createElement(ChatView, {
      controller,
      runtime: 'claude',
      runtimeLabel: 'Claude Code',
      workingDir: '/home/dev/project',
      branch: 'main',
      view: { ...DEFAULT_CHAT_VIEW },
      onViewChange: () => {},
    } as never),
  );
  await wait(400);

  // Exactly what arrives from the socket while an answer is being written:
  // a new turn opens, then text lands in it a delta at a time.
  const event = (payload: unknown): void =>
    controller.handle({ type: 'chat_event', sessionId: 'live-check', event: payload } as never);

  // Read from the rendered messages only. The turn strip repeats the opening
  // question as its label, so asserting against the whole subtree would pass
  // on the strip alone while the body it names is empty — which is the exact
  // bug being guarded against.
  const bodyText = (): string =>
    Array.from(host.querySelectorAll('[data-message-id]'))
      .map((node) => node.textContent || '')
      .join(' ');

  event({ t: 'msg_start', id: 'u2', seq: 2, turnId: 't2', role: 'user', ts: Date.now() });
  event({ t: 'block_start', msgId: 'u2', index: 0, block: { kind: 'text', text: '' } });
  event({ t: 'block_delta', msgId: 'u2', index: 0, text: 'a question typed while the app is open' });
  event({ t: 'msg_end', msgId: 'u2' });
  await wait(250);

  check(
    'a message sent while the app is open shows up',
    bodyText().includes('a question typed while the app is open'),
    'the user\'s own turn never rendered',
  );

  event({ t: 'msg_start', id: 'a2', seq: 3, turnId: 't2', role: 'assistant', ts: Date.now() });
  event({ t: 'block_start', msgId: 'a2', index: 0, block: { kind: 'text', text: '' } });
  await wait(120);
  event({ t: 'block_delta', msgId: 'a2', index: 0, text: 'the answer as it ' });
  await wait(120);
  event({ t: 'block_delta', msgId: 'a2', index: 0, text: 'is being written' });
  await wait(250);

  const text = bodyText();
  check(
    'the answer is on screen before it has finished',
    text.includes('the answer as it is being written'),
    text.includes('the answer as it')
      ? 'the first delta rendered but later ones did not'
      : 'the streaming turn body stayed empty',
  );

  // And the transcript really did receive it — so a failure above is the view
  // not rendering, not the events being wrong.
  check(
    'the transcript itself holds the streamed message',
    controller.transcript.messages.some((m: { id: string }) => m.id === 'a2'),
    `ids=${controller.transcript.messages.map((m: { id: string }) => m.id).join(',')}`,
  );

  root.unmount();
  host.remove();
}

/* -------------------------------------------------------------------------
 * The phone (issue #51)
 *
 * Every check above runs at a desktop width, which is how the phone layout
 * shipped for four minor versions as a shrunken desktop: nothing that ran had
 * a viewport small enough to see it. These thresholds are written out here
 * rather than imported from `src/client/ui/touch.ts` on purpose — a check that
 * imports the app's own constants proves the app agrees with itself, not that
 * a finger can hit the button or that an eye can read the label.
 * ------------------------------------------------------------------------- */

/** The floor for anything rendered as text on a phone. */
const PHONE_MIN_TEXT = 12;
/** Live session information is never set below the body text. */
const PHONE_LIVE_TEXT = 15;
/** Hit area, not ink: a 20px glyph in a 44px button passes. */
const PHONE_TARGET = 44;
/** Clear space between two neighbouring targets. */
const PHONE_GAP = 8;

/** Visible, non-decorative, and not a screen-reader-only clone. */
/** The view a node actually lives in — this page's, or an iframe's. */
function viewOf(node: Element): Window {
  return node.ownerDocument?.defaultView ?? window;
}

function isPainted(node: Element): boolean {
  const box = node.getBoundingClientRect();
  if (box.width <= 2 || box.height <= 2) return false;
  if (node.closest('[aria-hidden="true"]')) return false;
  const styles = viewOf(node).getComputedStyle(node);
  return styles.visibility !== 'hidden' && styles.display !== 'none' && styles.opacity !== '0';
}

/**
 * The controls, and only the controls.
 *
 * A control nested inside another control is dropped: the outer one is what a
 * finger aims at, and counting both reports a 0px gap between a chip and its
 * own icon every time.
 */
function paintedControls(root: HTMLElement): HTMLElement[] {
  const rootBox = root.getBoundingClientRect();
  const all = Array.from(
    root.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="tab"], [role="option"], a[href]'),
  ).filter(isPainted).filter((node) => {
    // A sheet's scrim is a control by markup and a gesture by intent: it is the
    // empty half of the screen you tap to dismiss, so it abuts the sheet on
    // purpose and has no size of its own to meet. Recognised by what it is —
    // an empty element covering most of the surface — rather than by a name.
    const box = node.getBoundingClientRect();
    const empty = !(node.textContent || '').trim() && node.childElementCount === 0;
    return !(empty && box.width * box.height > rootBox.width * rootBox.height * 0.2);
  });
  return all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
}

/** Whether any ancestor up to the host deliberately scrolls this node sideways. */
function scrollsSideways(node: Element): boolean {
  for (let at: Element | null = node.parentElement; at; at = at.parentElement) {
    const overflowX = viewOf(at).getComputedStyle(at).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') return true;
  }
  return false;
}

/** Elements that render a word of their own, with the size that word is set at. */
function paintedText(root: HTMLElement): Array<{ node: HTMLElement; size: number; text: string }> {
  const out: Array<{ node: HTMLElement; size: number; text: string }> = [];
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const own = Array.from(node.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => (child.textContent || '').trim())
      .join(' ')
      .trim();
    if (!own || !isPainted(node)) continue;
    out.push({ node, size: parseFloat(viewOf(node).getComputedStyle(node).fontSize) || 0, text: own });
  }
  return out;
}

function describe(node: HTMLElement, text?: string): string {
  const label = (text || node.getAttribute('aria-label') || node.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${node.tagName.toLowerCase()}${label ? `:${label.slice(0, 24)}` : ''}`;
}

/**
 * A phone is not a narrow desktop.
 *
 * Three viewports, because the failures differ: portrait is the ordinary case,
 * the short one stands in for the on-screen keyboard eating half the screen
 * (headless Chrome has no `visualViewport` to resize, and the layout question —
 * does the composer survive losing the height — is the same either way), and
 * landscape is where a row that only wrapped by luck stops wrapping.
 */
/**
 * Every phone rule, against whatever is currently on screen.
 *
 * Separate from the mount so it can be run again with a sheet open — see the
 * loop in the caller. `where` names the state, so a failure says which one.
 */
function assertPhoneSurface(host: HTMLElement, where: string): void {
  const hostBox = host.getBoundingClientRect();

  // 1. Every control a finger is meant to hit.
  const controls = paintedControls(host);
  const small = controls.filter((node) => {
    const box = node.getBoundingClientRect();
    return box.width < PHONE_TARGET - 0.5 || box.height < PHONE_TARGET - 0.5;
  });
  check(
    `every control is at least ${PHONE_TARGET}px in ${where}`,
    small.length === 0,
    small.length
      ? small
          .slice(0, 8)
          .map((n) => {
            const b = n.getBoundingClientRect();
            return `${describe(n)}=${Math.round(b.width)}x${Math.round(b.height)}`;
          })
          .join(' | ')
      : `${controls.length} controls`,
  );

  // 2. And far enough from the one next to it. Only pairs that actually sit
  //    side by side on the same line can be mistapped for each other.
  const byLeft = [...controls].sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
  );
  const crowded: string[] = [];
  for (let i = 0; i < byLeft.length; i++) {
    const a = byLeft[i].getBoundingClientRect();
    for (let j = i + 1; j < byLeft.length; j++) {
      const b = byLeft[j].getBoundingClientRect();
      const sameLine = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.height, b.height) / 2;
      if (!sameLine) continue;
      // A control clipped by a sideways scroller has a box that no longer says
      // where it is on screen, so measuring it against one outside the scroller
      // reports a gap that is not there.
      if (scrollsSideways(byLeft[i]) !== scrollsSideways(byLeft[j])) continue;
      const gap = b.left - a.right;
      // Only the nearest neighbour to the right matters; anything further is
      // separated by that one.
      if (gap < -0.5) continue;
      if (gap < PHONE_GAP - 0.5) {
        crowded.push(`${describe(byLeft[i])}↔${describe(byLeft[j])}=${Math.round(gap)}px`);
      }
      break;
    }
  }
  check(
    `neighbouring controls are at least ${PHONE_GAP}px apart in ${where}`,
    crowded.length === 0,
    crowded.length ? crowded.slice(0, 8).join(' | ') : 'no crowded pairs',
  );

  // 3. Nothing is set in text too small to read.
  const texts = paintedText(host);
  const tiny = texts.filter((t) => t.size < PHONE_MIN_TEXT - 0.01);
  check(
    `no text is smaller than ${PHONE_MIN_TEXT}px in ${where}`,
    tiny.length === 0,
    tiny.length
      ? tiny.slice(0, 8).map((t) => `${describe(t.node, t.text)}@${t.size}px`).join(' | ')
      : `${texts.length} text nodes`,
  );

  // 4. The live session figures specifically — the ones somebody reads
  //    mid-session and the issue names one by one.
  const live: Array<[string, HTMLElement | null]> = [
    ['the state', host.querySelector('header [role="status"]')],
    ['the cost and tokens', host.querySelector('[aria-label="Session usage"]')],
    ['the approvals state', host.querySelector('[aria-label="Approvals bypassed"]')],
    ['the model', host.querySelector('[aria-label="Change model"]')],
  ];
  for (const [label, node] of live) {
    if (!node) {
      check(`${label} is on screen in ${where}`, false, 'not found');
      continue;
    }
    const size = parseFloat(viewOf(node).getComputedStyle(node).fontSize) || 0;
    check(
      `${label} is at least ${PHONE_LIVE_TEXT}px in ${where}`,
      size >= PHONE_LIVE_TEXT - 0.01,
      `${size}px`,
    );
  }

  // 5. Nothing is pushed off the side. Vertical overflow inside the
  //    conversation is scrolling and expected; horizontal overflow is a row
  //    that refused to wrap, which is the defect.
  const offscreen = Array.from(host.querySelectorAll<HTMLElement>('*')).filter((node) => {
    if (!isPainted(node)) return false;
    // Popovers and sheets are allowed to be positioned relative to the
    // viewport rather than this host.
    if (viewOf(node).getComputedStyle(node).position === 'fixed') return false;
    // Nor is a row that deliberately scrolls sideways off-screen: the workspace
    // tab strip is a scroller with a way back to what it is hiding. What this
    // is looking for is content pushed out of a box that does not scroll.
    if (scrollsSideways(node)) return false;
    const box = node.getBoundingClientRect();
    return box.right > hostBox.right + 1 || box.left < hostBox.left - 1;
  });
  check(
    `nothing is pushed off the side in ${where}`,
    offscreen.length === 0,
    offscreen.length ? offscreen.slice(0, 8).map((n) => describe(n)).join(' | ') : 'nothing overflowing',
  );

  // 6. The composer is the one thing that must survive every viewport: a
  //    phone with no way to type is not a degraded layout, it is a dead app.
  const textarea = host.querySelector('textarea') as HTMLElement | null;
  if (!textarea) {
    check(`the composer is reachable in ${where}`, false, 'no textarea');
  } else {
    const box = textarea.getBoundingClientRect();
    check(
      `the composer is fully on screen in ${where}`,
      box.top >= hostBox.top - 1 && box.bottom <= hostBox.bottom + 1 && box.height > 0,
      `composer ${Math.round(box.top)}–${Math.round(box.bottom)}, surface ${Math.round(hostBox.top)}–${Math.round(hostBox.bottom)}`,
    );
  }

}

async function checkThePhoneLayoutIsUsable(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const controller = new ChatController('phone-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'phone-check',
    snapshot: {
      sessionId: 'phone-check',
      runtime: 'claude',
      state: 'running',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: true, commands: [{ name: 'clear' }],
        models: [{ name: 'claude-opus-4-6', value: 'claude-opus-4-6' }],
      },
      usage: { totalTokens: 987654, costUsd: 12.3456, contextWindow: 200000, contextUsed: 150000 },
      // On the snapshot, not as a prop: the model and the branch reach the
      // composer through the transcript and a workspace fetch respectively,
      // and a prop named `model` on ChatView would be quietly ignored.
      model: 'claude-opus-4-6',
      messages: [
        {
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'rework the mobile layout so the controls are reachable' }],
        },
        {
          id: 'a1', seq: 2, turnId: 't1', role: 'assistant', ts: Date.now(),
          blocks: [
            { kind: 'text', text: 'here is what I changed' },
            {
              kind: 'tool', toolId: 'x1', name: 'bash', toolKind: 'execute',
              status: 'completed', input: { command: 'npm test' }, durationMs: 4321,
            },
          ],
          usage: { inputTokens: 12345, outputTokens: 6789, costUsd: 0.4321 },
        },
      ],
      pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1, cursor: 2,
      live: true, bypassPermissions: true,
    },
  } as never);

  const viewports: Array<[string, number, number]> = [
    ['portrait', 390, 740],
    ['with the keyboard open', 390, 380],
    ['landscape', 740, 390],
  ];

  /**
   * The base surface, and the same surface with each of the phone's own
   * overlays open.
   *
   * A check only ever covers what its fixture reaches. The trace rail, the turn
   * index and the model list are all sheets on a phone, and asserting the
   * closed state alone is how a layout ends up correct in the chrome and
   * untouched everywhere behind it.
   */
  const states: Array<[string, string | null]> = [
    ['', null],
    ['with the trace rail open', '[aria-label="Show the trace rail"]'],
    ['with the turn index open', '[aria-label="Show the turn index"]'],
    ['with the model list open', '[aria-label="Change model"]'],
  ];

  for (const [name, width, height] of viewports) {
    for (const [state, opens] of states) {
      // A fresh mount per state, not a toggle: closing a sheet is its own
      // control, and a second click on the opener left the previous sheet up
      // and reported its offences against every state after it.
      host.style.cssText = `width:${width}px;height:${height}px;position:absolute;top:0;left:0;display:flex;overflow:hidden`;
      const root = createRoot(host);
      root.render(
        React.createElement(ChatView, {
          controller,
          runtime: 'claude',
          runtimeLabel: 'Claude Code',
          workingDir: '/home/dev/projects/a-rather-deeply-nested-working-directory',
          isMobile: true,
          view: { ...DEFAULT_CHAT_VIEW },
          onViewChange: () => {},
        } as never),
      );
      await wait(400);

      const where = state ? `${name} ${state}` : name;
      if (opens) {
        const opener = host.querySelector(opens) as HTMLElement | null;
        if (!opener) {
          check(`the phone surface can open the sheet ${state} in ${name}`, false, `no ${opens}`);
          root.unmount();
          continue;
        }
        opener.click();
        await wait(300);
      }

      assertPhoneSurface(host, where);
      root.unmount();
    }
  }

  host.remove();
}

run().catch((error: unknown) => {
  const pre = document.createElement('pre');
  pre.id = 'results';
  pre.textContent = `FAIL :: threw :: ${error instanceof Error ? error.stack : String(error)}`;
  document.body.appendChild(pre);
});

/**
 * The chat surface is not the whole phone (issue #51).
 *
 * The bottom bar, its more sheet and the tab switcher live in the app shell,
 * above and beside every conversation — none of them is reachable from a
 * ChatView fixture, so they need their own mount or they go the way the phone
 * layout went: untested and therefore unchanged.
 *
 * The terminal's key strip is deliberately not here. It is the terminal's own
 * on-screen controls, which issue #51 lists as a non-goal — they were sized
 * for a thumb when they were added, under their own issue.
 */
async function checkThePhoneShellSurfacesAreUsable(): Promise<void> {
  const noop = (): void => {};
  const surfaces: Array<[string, () => React.ReactElement]> = [
    ['the bottom bar', () =>
      React.createElement(MobileBar, {
        actions: [
          { id: 'sessions', label: 'Sessions', icon: 'layers', onPress: noop, expands: true },
          { id: 'keys', label: 'Keys', icon: 'keyboard', onPress: noop, toggle: true },
          { id: 'chat', label: 'Chat', icon: 'message-square', onPress: noop, active: true },
          { id: 'esc', label: 'Esc', icon: 'corner-up-left', onPress: noop },
          { id: 'more', label: 'More', icon: 'ellipsis', onPress: noop, expands: true },
        ],
      } as never)],
    ['the more sheet', () =>
      React.createElement(MoreSheet, {
        open: true, theme: 'dark', logoutUrl: '/logout', canCloseSession: true,
        install: { supported: true, reason: null } as never,
        onInstall: noop, onClose: noop, onReconnect: noop, onClearTerminal: noop,
        onSwitchMode: noop, onCloseSession: noop, onOpenSettings: noop,
        onToggleTheme: noop, onRename: noop,
      } as never)],
    ['the tab switcher', () =>
      React.createElement(TabSwitcherSheet, {
        open: true,
        tabs: [
          { id: 't1', title: 'a session with a fairly long name', kind: 'terminal' },
          { id: 't2', title: 'another one', kind: 'chat' },
        ],
        activeId: 't1',
        onSelect: noop, onCloseTab: noop, onNew: noop, onAllSessions: noop, onClose: noop,
      } as never)],
  ];

  for (const [name, render] of surfaces) {
    // An iframe, not a sized div.
    //
    // Two of these four surfaces are `Dialog`s, and a Dialog portals to
    // `document.body` and positions itself against the *viewport*. Measured
    // inside this page it would be 800px wide whatever the host div says — so
    // the one thing being asked ("does it fit a phone?") would be answered
    // about a desktop. An iframe has a viewport of its own.
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:390px;height:740px;position:absolute;top:0;left:0;border:0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument as Document;
    doc.open();
    doc.write(
      '<!doctype html><html><head>'
      + '<link rel="stylesheet" href="../../dist/public/css/relay/relay.css">'
      + '<link rel="stylesheet" href="../../dist/public/css/main.css">'
      + '</head><body style="margin:0"></body></html>',
    );
    doc.close();
    await wait(150);

    const host = doc.body;
    const root = createRoot(host);
    root.render(render());
    await wait(300);

    const target = host;
    const controls = paintedControls(target);
    if (controls.length === 0) {
      check(`${name} renders on a phone`, false, 'no controls found');
      root.unmount();
      frame.remove();
      continue;
    }

    const small = controls.filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width < PHONE_TARGET - 0.5 || box.height < PHONE_TARGET - 0.5;
    });
    check(
      `every control in ${name} is at least ${PHONE_TARGET}px`,
      small.length === 0,
      small.length
        ? small.slice(0, 8).map((n) => {
            const b = n.getBoundingClientRect();
            return `${describe(n)}=${Math.round(b.width)}x${Math.round(b.height)}`;
          }).join(' | ')
        : `${controls.length} controls`,
    );

    const tiny = paintedText(target).filter((t) => t.size < PHONE_MIN_TEXT - 0.01);
    check(
      `no text in ${name} is smaller than ${PHONE_MIN_TEXT}px`,
      tiny.length === 0,
      tiny.length
        ? tiny.slice(0, 8).map((t) => `${describe(t.node, t.text)}@${t.size}px`).join(' | ')
        : 'all legible',
    );

    const offscreen = Array.from(target.querySelectorAll<HTMLElement>('*')).filter((node) => {
      if (!isPainted(node) || scrollsSideways(node)) return false;
      const box = node.getBoundingClientRect();
      return box.right > 391 || box.left < -1;
    });
    check(
      `nothing in ${name} is pushed off the side`,
      offscreen.length === 0,
      offscreen.length ? offscreen.slice(0, 6).map((n) => describe(n)).join(' | ') : 'nothing overflowing',
    );

    root.unmount();
    frame.remove();
  }
}
