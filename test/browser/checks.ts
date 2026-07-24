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

import { createTerminalController } from '../../src/client/terminal/controller';
import { HistoryView } from '../../src/client/terminal/history-view';

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
  check('the live scrollback stays bounded', buffer.baseY <= 2000, `baseY=${buffer.baseY}`);
  check('the viewport stays pinned to the newest output', controller.isAtBottom());

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
  check(
    'the status line reports the real position',
    /di 100000/.test(status.textContent || ''),
    JSON.stringify(status.textContent),
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

  const pre = document.createElement('pre');
  pre.id = 'results';
  pre.textContent = results.join('\n');
  document.body.appendChild(pre);
}

run().catch((error: unknown) => {
  const pre = document.createElement('pre');
  pre.id = 'results';
  pre.textContent = `FAIL :: threw :: ${error instanceof Error ? error.stack : String(error)}`;
  document.body.appendChild(pre);
});
