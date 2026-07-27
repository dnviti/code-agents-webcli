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
import { PhoneContext } from '../../src/client/ui/touch';
import { FloatingMenu, type FloatingMenuAction } from '../../src/client/shell/FloatingMenu';
import { BottomNav } from '../../src/client/shell/BottomNav';
import { MoreSheet } from '../../src/client/shell/MoreSheet';
import { ChatSettingsDialog } from '../../src/client/shell/dialogs/ChatSettingsDialog';
import { SessionsDialog } from '../../src/client/shell/dialogs/SessionsDialog';
import { UsageDashboardDialog } from '../../src/client/shell/dialogs/UsageDashboardDialog';
import { TabSwitcherSheet } from '../../src/client/shell/TabSwitcherSheet';
import { TabBar } from '../../src/client/ui/relay/TabBar';

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
  await checkAWorkflowPopupBehavesLikeTheFilePopup();
  await checkAnAgentPopupShowsWhatTheAgentIsDoing();
  await checkATallDialogStaysOnScreen();
  await checkTheComposerShrinksWithTheWorkspaceRail();
  await checkTheFixedBarsNeverWrap();
  await checkALiveAnswerAppearsAsItStreams();
  await checkSilentStepsLeaveNoRowButKeepTheirTrace();
  await checkAQuestionIsAnsweredByClicking();
  await checkThePhoneLayoutIsUsable();
  await checkThePhoneShellSurfacesAreUsable();
  await checkALongTabNameStaysInsideTheStrip();
  await checkAnUnreportedFigureIsNeverDrawnAsZero();

  const pre = document.createElement('pre');
  pre.id = 'results';
  pre.textContent = results.join('\n');
  document.body.appendChild(pre);
}

/**
 * A question the model asked is answered by clicking, and stays as a record.
 *
 * Here rather than in a unit test because every claim is about the rendered
 * conversation: that the card appears *inside* the transcript at the call that
 * asked (not in a tray under it), that a multi-select needs a confirm and a
 * single-select does not, and that the card survives the answer instead of
 * vanishing. A jsdom assertion on props would pass for a card rendered into
 * nowhere.
 */
async function checkAQuestionIsAnsweredByClicking(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:700px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const sent: Array<Record<string, unknown>> = [];
  const controller = new ChatController('browser-check', {
    send: (message: Record<string, unknown>) => {
      sent.push(message);
    },
  } as never);

  const askBlock = (toolId: string, input: unknown): Record<string, unknown> => ({
    kind: 'tool',
    toolId,
    name: 'mcp__ccweb__ask_user_question',
    toolKind: 'other',
    status: 'running',
    input,
  });

  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'browser-check',
    snapshot: {
      sessionId: 'browser-check',
      runtime: 'claude',
      state: 'awaiting_answer',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        questions: true, interrupt: true, resume: true, fork: false, attachments: true,
        usage: true, cost: true, plan: false,
      },
      messages: [
        {
          id: 'm1', seq: 1, turnId: 't1', role: 'user', ts: 1,
          blocks: [{ kind: 'text', text: 'Fix the parser.' }],
        },
        {
          id: 'm2', seq: 2, turnId: 't1', role: 'assistant', ts: 2,
          blocks: [
            askBlock('tool-single', {
              question: 'Which approach should I take?',
              header: 'Approach',
              multiSelect: false,
              options: [
                { label: 'Rewrite it', description: 'Slower but cleaner' },
                { label: 'Patch it', description: 'Faster, more debt' },
              ],
            }),
          ],
        },
        {
          id: 'm3', seq: 3, turnId: 't1', role: 'assistant', ts: 3,
          blocks: [
            askBlock('tool-multi', {
              question: 'Which rules should I apply?',
              multiSelect: true,
              options: [{ label: 'semicolons' }, { label: 'trailing commas' }, { label: 'single quotes' }],
            }),
          ],
        },
      ],
      pendingPermissions: [],
      pendingQuestions: [
        {
          requestId: 'q-single', toolId: 'tool-single', question: 'Which approach should I take?',
          header: 'Approach', multiSelect: false, ts: 2,
          options: [
            { optionId: 'opt-0', label: 'Rewrite it', description: 'Slower but cleaner' },
            { optionId: 'opt-1', label: 'Patch it', description: 'Faster, more debt' },
          ],
        },
        {
          requestId: 'q-multi', toolId: 'tool-multi', question: 'Which rules should I apply?',
          multiSelect: true, ts: 3,
          options: [
            { optionId: 'opt-0', label: 'semicolons' },
            { optionId: 'opt-1', label: 'trailing commas' },
            { optionId: 'opt-2', label: 'single quotes' },
          ],
        },
      ],
      firstSeq: 1,
      replayFrom: 1,
      cursor: 3,
      live: true,
      bypassPermissions: false,
    },
  } as never);

  const root = createRoot(host);
  root.render(
    React.createElement(ChatView, {
      controller,
      runtime: 'claude',
      runtimeLabel: 'Claude Code',
      workingDir: '/tmp/project',
      view: DEFAULT_CHAT_VIEW,
      onViewChange: () => {},
    } as never),
  );
  await wait(400);

  const cards = Array.from(host.querySelectorAll('[data-question-card]')) as HTMLElement[];
  check('both questions render as cards', cards.length === 2, `found ${cards.length}`);
  if (cards.length !== 2) return;

  const [single, multi] = cards;

  // Inside the conversation, at the call that asked — the thing that makes the
  // exchange still read as a conversation when scrolled back to. A card in a
  // pinned tray would be outside this element entirely.
  const inTranscript = single.closest('[data-message-id="m2"]');
  check('the card sits in the message that asked', !!inTranscript);

  const optionText = (card: HTMLElement): string => card.textContent || '';
  check(
    'the single-choice card offers every option',
    optionText(single).includes('Rewrite it') && optionText(single).includes('Patch it'),
  );
  check('option descriptions are shown', optionText(single).includes('Slower but cleaner'));

  // A single-choice question answers on the click itself; a multi-select must
  // not, or the first tick would send the answer and the rest would go nowhere.
  const singleButtons = Array.from(single.querySelectorAll('button')) as HTMLButtonElement[];
  const patch = singleButtons.find((b) => (b.textContent || '').includes('Patch it'));
  check('each option is its own control', !!patch);

  const boxes = Array.from(multi.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
  check('the multi-select card offers checkboxes', boxes.length === 3, `found ${boxes.length}`);
  const confirm = (Array.from(multi.querySelectorAll('button')) as HTMLButtonElement[])
    .find((b) => (b.textContent || '').trim() === 'Confirm');
  check('the multi-select card has a confirm', !!confirm);
  check('confirm is disabled before anything is picked', !!confirm && confirm.disabled);

  if (boxes.length === 3 && confirm) {
    boxes[0].click();
    boxes[2].click();
    await wait(150);
    check('confirm becomes available once something is picked', !confirm.disabled);
    check('picking a checkbox does not answer on its own', sent.length === 0, `${sent.length} sent`);
    confirm.click();
    await wait(150);
  }

  if (patch) {
    patch.click();
    await wait(200);
  }

  const answers = sent.filter((m) => m.type === 'chat_question_answer');
  check('both answers reach the server', answers.length === 2, `${answers.length} sent`);
  const multiAnswer = answers.find((m) => m.requestId === 'q-multi');
  const singleAnswer = answers.find((m) => m.requestId === 'q-single');
  check(
    'the multi-select answer carries every pick',
    !!multiAnswer && JSON.stringify(multiAnswer.optionIds) === JSON.stringify(['opt-0', 'opt-2']),
    JSON.stringify(multiAnswer?.optionIds),
  );
  check(
    'the single-choice answer carries the one pick',
    !!singleAnswer && JSON.stringify(singleAnswer.optionIds) === JSON.stringify(['opt-1']),
    JSON.stringify(singleAnswer?.optionIds),
  );

  await wait(200);
  const after = Array.from(host.querySelectorAll('[data-question-card]')) as HTMLElement[];
  // The card must not vanish on being answered: scrolling back past a decision
  // should show the decision, which is the acceptance criterion a tray-based
  // card fails.
  check('the cards stay in the conversation after answering', after.length === 2, `${after.length} left`);
  check(
    'an answered card stops offering buttons',
    after.every((card) => card.getAttribute('data-question-card') === 'answered'),
    after.map((c) => c.getAttribute('data-question-card')).join(','),
  );
  check('the answered card still shows what was asked', (after[0].textContent || '').includes('Which approach'));
  check('the answered card shows what was chosen', (after[0].textContent || '').includes('Patch it'));

  root.unmount();
  host.remove();
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
 * Issue #45: a running workflow opens in a popup that behaves like the file
 * editor's — movable and expandable — and keeps showing its log live and
 * after the run ends.
 *
 * Driven through the whole `ChatView`, not a bare `AgentsPanel`. Two of the
 * things asked for here only exist in the composition: that a `tool` patch
 * (which never reaches the panel's own `subscribe` tier) still reaches the
 * popup — true only if the popup really is on `subscribeContent` — and that
 * selecting another rail tab does not take the popup down with the panel that
 * opened it. Rendering the panel alone passed both while the second was false.
 */
async function checkAWorkflowPopupBehavesLikeTheFilePopup(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:1100px;height:600px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const controller = new ChatController('workflow-check', { send: () => {} });
  const transcript = controller.transcript;
  transcript.apply({ t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
  transcript.apply({
    t: 'block_start',
    seq: 2,
    ts: 2,
    msgId: 'm1',
    index: 0,
    block: {
      kind: 'tool',
      toolId: 'wf1',
      name: 'Workflow',
      toolKind: 'task',
      status: 'running',
      input: { name: 'review-changes' },
      output: '▸ Review\nchecking file a',
    },
  });

  const root = createRoot(host);
  const paint = (panelTab: string): void => {
    root.render(
      React.createElement(ChatView, {
        controller,
        runtime: 'claude',
        runtimeLabel: 'Claude Code',
        workingDir: '/tmp/project',
        view: { ...DEFAULT_CHAT_VIEW, panelOpen: true, panelTab, panelWidth: 420 },
        onViewChange: () => {},
      } as never),
    );
  };

  paint('agents');
  await wait(200);

  const rail = host.querySelector('aside[aria-label="Workspace"]') as HTMLElement | null;
  const row = rail?.querySelector('[role="button"]') as HTMLElement | null;
  check('a workflow row is clickable', !!row);
  row?.click();
  await wait(50);

  const panel = host.querySelector('[role="dialog"]') as HTMLElement | null;
  check('clicking the workflow row opens a popup', !!panel);
  if (!panel) {
    root.unmount();
    host.remove();
    return;
  }

  check('the popup names the workflow', !!panel.textContent?.includes('review-changes'));
  check('the popup shows the running stage so far', !!panel.textContent?.includes('checking file a'));

  // Movable, like the file popup: a resize grip is present and dragging it
  // changes the panel's own size rather than the content scrolling instead.
  const grip = panel.querySelector('[title="Drag to resize"]') as HTMLElement | null;
  check('the popup has a resize grip', !!grip);
  const before = panel.getBoundingClientRect();
  if (grip) {
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: before.right, clientY: before.bottom }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: before.right + 120, clientY: before.bottom + 120 }));
    window.dispatchEvent(new PointerEvent('pointerup', {}));
    await wait(50);
  }
  const afterResize = panel.getBoundingClientRect();
  check(
    'dragging the grip resizes the popup',
    afterResize.width > before.width && afterResize.height > before.height,
    `${Math.round(before.width)}x${Math.round(before.height)} -> ${Math.round(afterResize.width)}x${Math.round(afterResize.height)}`,
  );

  const maximise = panel.querySelector('[aria-label="Fill the window"]') as HTMLElement | null;
  check('the popup can be expanded to fill the screen', !!maximise);
  maximise?.click();
  await wait(50);
  const maximised = panel.getBoundingClientRect();
  check(
    'expanding it fills most of the viewport',
    maximised.width > window.innerWidth - 40,
    `${Math.round(maximised.width)}px vs viewport ${window.innerWidth}px`,
  );

  // Live: a `tool` patch is the wire event a running workflow actually gets
  // patched with (see chat-reducer.ts), and it must reach this popup even
  // though it never reaches the panel's own `subscribe` tier.
  transcript.apply({
    t: 'block_delta',
    seq: 3,
    ts: 3,
    msgId: 'm1',
    index: 0,
    text: '\n▸ Verify\nall clear',
  });
  await wait(50);
  check(
    'new output streamed into the workflow appears live',
    !!panel.textContent?.includes('all clear'),
  );

  // And it survives completion, for review afterward.
  transcript.apply({ t: 'tool', seq: 4, ts: 4, toolId: 'wf1', patch: { status: 'completed' } });
  await wait(50);
  check('the popup still shows the log once the workflow finishes', !!panel.textContent?.includes('all clear'));
  check('the popup reflects the finished status', !!panel.textContent?.toLowerCase().includes('done'));

  // The file popup is mounted by the rail, not by the tab that opened it, so
  // it outlives a tab change. The workflow popup has to do the same, or a
  // workflow you opened to watch disappears the moment you look at anything
  // else — and "still there for review afterward" only holds if you never
  // touched the rail in between.
  paint('links');
  await wait(200);
  const afterSwitch = host.querySelector('[role="dialog"]') as HTMLElement | null;
  check(
    'the popup survives selecting another rail tab',
    !!afterSwitch && !!afterSwitch.textContent?.includes('all clear'),
    afterSwitch ? 'still open' : 'unmounted with the agents tab',
  );

  root.unmount();
  host.remove();
}

/**
 * Issue #44: opening a delegated agent shows its own steps — live while it
 * works, still there once it is done, and with a failure inside its work
 * spelled out rather than reduced to a badge.
 *
 * The events replayed here are the ones the claude adapter emits for real
 * sub-agent traffic (see test/chat-claude.test.js, which replays a captured
 * run through the adapter to prove that shape). This check starts where that
 * one stops: given those events, what does someone actually see?
 */
async function checkAnAgentPopupShowsWhatTheAgentIsDoing(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:1100px;height:600px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const controller = new ChatController('agent-check', { send: () => {} });
  const transcript = controller.transcript;
  transcript.apply({ t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
  transcript.apply({
    t: 'block_start',
    seq: 2,
    ts: 2,
    msgId: 'm1',
    index: 0,
    block: {
      kind: 'tool',
      toolId: 'ag1',
      name: 'Agent',
      toolKind: 'task',
      status: 'running',
      input: { subagent_type: 'general-purpose', description: 'Find the magic word' },
    },
  });

  const root = createRoot(host);
  root.render(
    React.createElement(ChatView, {
      controller,
      runtime: 'claude',
      runtimeLabel: 'Claude Code',
      workingDir: '/tmp/project',
      view: { ...DEFAULT_CHAT_VIEW, panelOpen: true, panelTab: 'agents', panelWidth: 420 },
      onViewChange: () => {},
    } as never),
  );
  await wait(200);

  const rail = host.querySelector('aside[aria-label="Workspace"]') as HTMLElement | null;
  const row = rail?.querySelector('[role="button"]') as HTMLElement | null;
  check('a sub-agent row is clickable, not just a workflow', !!row);
  row?.click();
  await wait(50);

  const panel = host.querySelector('[role="dialog"]') as HTMLElement | null;
  check('clicking a sub-agent row opens its detail view', !!panel);
  if (!panel) {
    root.unmount();
    host.remove();
    return;
  }

  // Nothing reported yet: the view has to say so rather than look broken.
  check(
    'an agent with nothing reported yet says it is waiting',
    !!panel.textContent?.toLowerCase().includes('waiting'),
  );

  // Progress within its own work — the thing a status badge cannot say.
  transcript.apply({
    t: 'agent_progress',
    seq: 3,
    ts: 3,
    parentToolId: 'ag1',
    patch: { activity: 'Reading hello.txt', lastTool: 'Read', toolUses: 1, totalTokens: 21853 },
  });
  await wait(50);
  check(
    'the detail view shows what the agent is doing right now',
    !!panel.textContent?.includes('Reading hello.txt'),
  );

  // A step it took, live, with no refresh.
  transcript.apply({
    t: 'agent_step',
    seq: 4,
    ts: 4,
    parentToolId: 'ag1',
    step: {
      id: 's1',
      name: 'Read',
      toolKind: 'read',
      status: 'running',
      input: { file_path: '/tmp/project/hello.txt' },
      ts: 4,
    },
  });
  await wait(50);
  check(
    "a step appears in the running agent's view without a refresh",
    !!panel.textContent?.includes('Read') && !!panel.textContent?.includes('hello.txt'),
  );

  // The closing half must not overwrite the tool's name with a placeholder —
  // the reducer merges only what a patch actually carries.
  transcript.apply({
    t: 'agent_step',
    seq: 5,
    ts: 5,
    parentToolId: 'ag1',
    step: { id: 's1', status: 'completed', output: 'The magic word is BANANAPHONE.' },
  });
  await wait(50);
  check(
    'completing a step keeps the tool name it was opened with',
    !!panel.textContent?.includes('Read'),
  );

  // A failure *inside* the agent's work, which the row's badge cannot show.
  transcript.apply({
    t: 'agent_step',
    seq: 6,
    ts: 6,
    parentToolId: 'ag1',
    step: {
      id: 's2',
      name: 'Bash',
      toolKind: 'execute',
      status: 'failed',
      error: 'grep: missing.txt: No such file or directory',
      ts: 6,
    },
  });
  await wait(50);
  check(
    'a failure inside the agent shows its actual message',
    !!panel.textContent?.includes('No such file or directory'),
  );

  // And the whole sequence survives the run finishing, for review.
  transcript.apply({
    t: 'agent_progress',
    seq: 7,
    ts: 7,
    parentToolId: 'ag1',
    // Shaped the way the adapter really emits it: the keys it has nothing to
    // say about are present and undefined, not absent. A merge that assigns
    // blindly erases them, which a patch with the keys simply omitted would
    // never have caught.
    patch: { status: 'completed', durationMs: 3921, activity: undefined, lastTool: undefined },
  });
  transcript.apply({
    t: 'tool',
    seq: 8,
    ts: 8,
    toolId: 'ag1',
    patch: { status: 'completed', output: 'The magic word is BANANAPHONE.' },
  });
  await wait(50);
  const text = panel.textContent || '';
  check(
    'the finished agent still lists every step it took',
    text.includes('Read') && text.includes('Bash') && text.includes('No such file or directory'),
  );
  check('the finished agent shows what it reported back', text.includes('BANANAPHONE'));
  // That last progress report named only a status and a duration. A merge that
  // wrote absent keys back as undefined would have blanked the activity line
  // the report before it established.
  check(
    'a later progress report does not erase what an earlier one said',
    text.includes('Reading hello.txt'),
  );

  root.unmount();
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

/**
 * Issue #46 — a step that only ran commands leaves no row, and the next reply
 * speaks for it.
 *
 * A static render can count rows but cannot click, and the half of this that
 * matters is the click: the pill on the reply has to open the trace *at the
 * start* of the stretch it counts, not at its own first call. That is a real
 * event handler feeding real state into the rail, so it needs a real browser.
 */
async function checkSilentStepsLeaveNoRowButKeepTheirTrace(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:1280px;height:760px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const tool = (id: string, command: string, output: string): unknown => ({
    kind: 'tool', toolId: id, name: 'bash', toolKind: 'execute',
    status: 'completed', input: { command }, output, durationMs: 1200,
  });

  const controller = new ChatController('silent-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'silent-check',
    snapshot: {
      sessionId: 'silent-check', runtime: 'claude', state: 'idle',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: true, commands: [],
      },
      messages: [
        {
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'run the tests' }],
        },
        // Two steps that said nothing at all — the rows #46 removes.
        {
          id: 'a1', seq: 2, turnId: 't1', role: 'assistant', ts: Date.now(),
          blocks: [tool('x1', 'npm run lint', 'THE-FIRST-SILENT-STEP')],
        },
        {
          id: 'a2', seq: 3, turnId: 't1', role: 'assistant', ts: Date.now(),
          blocks: [tool('x2', 'npm run typecheck', 'THE-SECOND-SILENT-STEP')],
        },
        // …and the reply that finally arrives, which has to speak for them.
        {
          id: 'a3', seq: 4, turnId: 't1', role: 'assistant', ts: Date.now(),
          blocks: [
            { kind: 'text', text: 'all green' },
            tool('x3', 'npm test', 'ITS-OWN-STEP'),
          ],
        },
      ],
      pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1, cursor: 4,
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

  const rows = (): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>('[aria-label="Assistant message"]'));

  check(
    'a step that only ran commands gets no row of its own',
    rows().length === 1,
    `${rows().length} assistant rows: ${rows().map((r) => (r.textContent || '').slice(0, 24)).join(' | ')}`,
  );

  const reply = rows()[0];
  const replyText = reply ? reply.textContent || '' : '';
  check(
    'the reply that follows them counts the whole stretch',
    replyText.includes('all green') && replyText.includes('3 commands'),
    replyText.slice(0, 160),
  );

  // The trace never lost any of it — the rail is the record, and it is open.
  const railText = (): string => host.textContent || '';
  check(
    'every silent step is still on the trace',
    railText().includes('npm run lint') && railText().includes('npm run typecheck'),
    'looked for both suppressed commands on the rail',
  );

  const pill = Array.from(host.querySelectorAll<HTMLElement>('button'))
    .find((node) => (node.textContent || '').includes('show work'));
  check('the reply carries a way into the trace', Boolean(pill), pill ? 'work pill found' : 'no work pill on the reply');
  pill?.click();
  await wait(300);

  // Focusing a row expands it, so the first silent step's output is the proof
  // that the pill landed at the start of the stretch rather than on its own call.
  check(
    'it opens the trace at the first silent step, not at the reply’s own call',
    railText().includes('THE-FIRST-SILENT-STEP'),
    railText().includes('THE-FIRST-SILENT-STEP')
      ? 'the first silent step is expanded'
      : railText().includes('ITS-OWN-STEP')
        ? 'the pill focused the reply’s own call'
        : 'nothing was expanded',
  );

  // And live: a silent step arriving mid-stream must not add a row either.
  const event = (payload: unknown): void =>
    controller.handle({ type: 'chat_event', sessionId: 'silent-check', event: payload } as never);
  event({ t: 'msg_start', id: 'u2', seq: 5, turnId: 't2', role: 'user', ts: Date.now() });
  event({ t: 'block_start', msgId: 'u2', index: 0, block: { kind: 'text', text: 'and again' } });
  event({ t: 'msg_end', msgId: 'u2' });
  event({ t: 'msg_start', id: 'a4', seq: 6, turnId: 't2', role: 'assistant', ts: Date.now() });
  event({
    t: 'block_start',
    msgId: 'a4',
    index: 0,
    block: tool('x4', 'npm run build', 'A-LIVE-SILENT-STEP'),
  });
  await wait(300);

  check(
    'a silent step arriving live adds no row while it runs',
    rows().length === 1,
    `${rows().length} assistant row(s) while the second turn is only tools`,
  );

  event({ t: 'msg_end', msgId: 'a4' });
  event({ t: 'msg_start', id: 'a5', seq: 7, turnId: 't2', role: 'assistant', ts: Date.now() });
  event({ t: 'block_start', msgId: 'a5', index: 0, block: { kind: 'text', text: 'built' } });
  await wait(300);

  const live = rows()[1];
  const liveText = live ? live.textContent || '' : '';
  check(
    'the reply appears with the live step already counted on it',
    liveText.includes('built') && liveText.includes('1 command'),
    liveText.slice(0, 160) || 'the streamed reply never rendered',
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
/**
 * Above this size on the axis they touch, two neighbours need no gap.
 *
 * The gap exists so the seam between two targets is findable. That is a real
 * problem at the floor — two 44px buttons touching present one 88px strip with
 * an invisible join — and not one above it: a bottom bar's segments are 78px
 * wide with a label in the middle of each, which is how every phone in the
 * world draws a tab bar, and inserting gaps into one would make it read as five
 * loose buttons rather than one bar.
 */
const PHONE_GAP_EXEMPT_AT = PHONE_TARGET * 1.5;
/**
 * The most vertical room the chrome may take from the conversation, at rest.
 *
 * The point of the floating menu and the collapsing header and composer is that
 * the transcript gets the screen. Nothing else here would notice a redesign
 * that quietly gave the chrome its room back — every other rule is about the
 * chrome being *big enough*, which pushes the other way.
 *
 * A pixel budget rather than a share of the screen: the chrome is a fixed
 * number of pixels, so its share grows as the screen shortens, and a share
 * would fail in landscape for a layout that had given up nothing at all.
 *
 * The budget covers the header strip, the live ribbon, the collapsed composer
 * and the bottom bar together — about 160px of surface plus the bar's 57. It
 * does not cover the floating menu, which floats.
 *
 * The bar is not counted out for the keyboard-open viewport even though the app
 * hides it there: that hiding is driven by `visualViewport`, which a fixture in
 * a sized div cannot move. So this measures the harder case in that one.
 */
const PHONE_CHAT_CHROME = 220;

/** Visible, non-decorative, and not a screen-reader-only clone. */
/** The view a node actually lives in — this page's, or an iframe's. */
function viewOf(node: Element): Window {
  return node.ownerDocument?.defaultView ?? window;
}

/**
 * Jump every entrance animation to its end state.
 *
 * Headless Chrome does not advance animation frames here, so a sheet that
 * arrives from `opacity: 0` stays at 0 for as long as the fixture lives. It
 * still lays out, which is why the geometry rules read it happily while the
 * panel was, by the browser's own account, not on screen. Finishing the
 * animations makes the measured frame the settled one instead of the first.
 * An infinite animation (the spinner, the composer sweep) cannot finish and
 * throws — those have no end state to wait for, so leaving them running is
 * the right answer.
 */
function settle(doc: Document): void {
  for (const animation of doc.getAnimations()) {
    try {
      animation.finish();
    } catch {
      /* infinite: no end to jump to */
    }
  }
}

function isPainted(node: Element): boolean {
  const box = node.getBoundingClientRect();
  if (box.width <= 2 || box.height <= 2) return false;
  if (node.closest('[aria-hidden="true"]')) return false;
  const view = viewOf(node);
  const styles = view.getComputedStyle(node);
  if (styles.visibility === 'hidden' || styles.display === 'none') return false;
  // opacity does not inherit, so a faded-out ancestor still computes to 1 here.
  // A sheet mid-transition would otherwise be measured as if it were on screen.
  for (let el: Element | null = node; el; el = el.parentElement) {
    if (view.getComputedStyle(el).opacity === '0') return false;
  }
  return true;
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

/**
 * A control's laid-out size, ignoring transforms.
 *
 * `getBoundingClientRect()` reports the painted box, which a dialog's entrance
 * animation scales — so a 44px button measures 43.12px for as long as the
 * animation is mid-flight, and headless Chrome does not always finish one. How
 * big a control *is* is a layout question; where it is on screen is the one the
 * rect answers, and that is what the spacing and overflow checks use.
 */
function laidOutSize(node: HTMLElement): { width: number; height: number } {
  return { width: node.offsetWidth, height: node.offsetHeight };
}

/**
 * Which of the named live figures has been seen on screen at all.
 *
 * A collapsed layout is allowed to hide a figure; it is not allowed to make it
 * unreachable. Filled as the states are walked, asserted once at the end.
 */
const seenLive = new Set<string>();

/** Whether any ancestor up to the host deliberately scrolls this node sideways. */
function scrollsSideways(node: Element): boolean {
  for (let at: Element | null = node.parentElement; at; at = at.parentElement) {
    const overflowX = viewOf(at).getComputedStyle(at).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') return true;
  }
  return false;
}

/**
 * The nearest ancestor that scrolls this node, if any.
 *
 * Two controls in different scroll containers have no fixed distance from each
 * other — one of them moves when its container is scrolled, and either can be
 * clipped to a sliver at the boundary. Measuring the space between them says
 * nothing about whether they can be mistapped for each other.
 */
function scrollBoxOf(node: Element): Element | null {
  for (let at: Element | null = node.parentElement; at; at = at.parentElement) {
    const styles = viewOf(at).getComputedStyle(at);
    if (/(auto|scroll)/.test(styles.overflowY) || /(auto|scroll)/.test(styles.overflowX)) return at;
  }
  return null;
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
 * The chat surface as a phone actually composes it.
 *
 * The menu is inside `ChatView` on a phone — it has to be, because it is
 * anchored above the composer and the shell does not know where that ends — so
 * this only has to supply what the shell would contribute to it.
 */
function PhoneSurface({ controller }: { controller: ChatController }): React.ReactElement {
  // Real view state, not a frozen object with a no-op setter.
  //
  // `DEFAULT_CHAT_VIEW.panelOpen` is true — a desktop preference — and on a
  // phone the rail *replaces* the transcript, so a fixture that cannot write
  // the setting back renders a surface with no conversation in it at all and
  // every measurement below is of the panel. The app clears it on mount; a
  // fixture that swallows the write never sees that happen.
  // Seeded shut, which is what the shell hands a phone: `panelOpen` is a
  // desktop preference and on a phone the rail replaces the conversation, so
  // AppShell keeps its own session-scoped answer and starts it false. A fixture
  // that passes the stored default straight through renders the panel and
  // measures that instead of the conversation.
  const [view, setView] = React.useState({ ...DEFAULT_CHAT_VIEW, panelOpen: false });
  const onViewChange = React.useCallback((next: typeof DEFAULT_CHAT_VIEW) => setView(next), []);
  const go = React.useCallback(
    (next: Partial<typeof DEFAULT_CHAT_VIEW>) => setView((current) => ({ ...current, ...next })),
    [],
  );

  // Both bands: the budget below is about what the chrome costs the
  // conversation, and the bar is chrome.
  return React.createElement(
    'div',
    { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
    // The surface in a box that can shrink, exactly as AppShell holds it. Given
    // the column directly, `height: 100%` on the surface takes the bar's 56px
    // as well and the transcript is squeezed to nothing.
    React.createElement(
      'div',
      { style: { flex: 1, minHeight: 0, display: 'flex' } },
      React.createElement(ChatView, {
        controller,
        runtime: 'claude',
        runtimeLabel: 'Claude Code',
        workingDir: '/home/dev/projects/a-rather-deeply-nested-working-directory',
        isMobile: true,
        view,
        onViewChange,
        // What the shell contributes. The surface adds its own inside.
        menuActions: [
          { id: 'new', label: 'New session', icon: 'plus', onPress: () => {} },
          { id: 'more', label: 'More…', icon: 'ellipsis', expands: true, onPress: () => {} },
        ],
      } as never),
    ),
    React.createElement(BottomNav, {
      destinations: [
        {
          id: 'chat', label: 'Chat', icon: 'message-square',
          current: !view.panelOpen && !view.terminalOpen,
          onGo: () => go({ panelOpen: false, terminalOpen: false }),
        },
        {
          id: 'trace', label: 'Trace', icon: 'list-todo',
          current: view.panelOpen && view.panelTab === 'trace',
          onGo: () => go({ panelOpen: true, panelTab: 'trace', terminalOpen: false }),
        },
        {
          id: 'files', label: 'Files', icon: 'hard-drive',
          current: view.panelOpen && view.panelTab !== 'trace',
          onGo: () => go({ panelOpen: true, panelTab: 'files', terminalOpen: false }),
        },
        {
          id: 'terminal', label: 'Shell', icon: 'terminal',
          current: view.terminalOpen,
          onGo: () => go({ panelOpen: false, terminalOpen: true }),
        },
        { id: 'sessions', label: 'Sessions', icon: 'layout-list', onGo: () => {} },
      ],
    } as never),
  );
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
function assertPhoneSurface(host: HTMLElement, where: string, atRest = false): void {
  const hostBox = host.getBoundingClientRect();

  // 1. Every control a finger is meant to hit.
  const controls = paintedControls(host);
  const small = controls.filter((node) => {
    const box = laidOutSize(node);
    return box.width < PHONE_TARGET || box.height < PHONE_TARGET;
  });
  check(
    `every control is at least ${PHONE_TARGET}px in ${where}`,
    small.length === 0,
    small.length
      ? small
          .slice(0, 8)
          .map((n) => {
            const b = laidOutSize(n);
            return `${describe(n)}=${b.width}x${b.height}`;
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
      // Only controls that share a scroll container have a fixed distance from
      // each other — see scrollBoxOf.
      if (scrollBoxOf(byLeft[i]) !== scrollBoxOf(byLeft[j])) continue;
      // Both comfortably over the floor on the axis they meet on — see
      // PHONE_GAP_EXEMPT_AT.
      if (a.width >= PHONE_GAP_EXEMPT_AT && b.width >= PHONE_GAP_EXEMPT_AT) continue;
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

  // 4. The live session figures — whichever of them this state is showing.
  //
  //    Not "all of them, always": the header and the composer collapse now, so
  //    most of these sit behind a disclosure. What has to hold is that when one
  //    is on screen it is legible, and that every one of them is reachable in
  //    *some* state — asserted once at the end, against `seenLive`.
  const live: Array<[string, HTMLElement | null]> = [
    ['the state', host.querySelector('header [role="status"]')],
    ['the cost and tokens', host.querySelector('[aria-label="Session usage"]')],
    ['the approvals state', host.querySelector('[aria-label="Approvals bypassed"]')],
    ['the model', host.querySelector('[aria-label="Change model"]')],
  ];
  for (const [label, node] of live) {
    if (!node) continue;
    seenLive.add(label);
    const size = parseFloat(viewOf(node).getComputedStyle(node).fontSize) || 0;
    check(
      `${label} is at least ${PHONE_LIVE_TEXT}px in ${where}`,
      size >= PHONE_LIVE_TEXT - 0.01,
      `${size}px`,
    );
  }

  // And the model control shows the model, not the word "model".
  //
  // Asserted because the size check above cannot tell the difference: the chip
  // falls back to a placeholder when nothing reported a model, and a fixture
  // that fails to deliver one measures the placeholder and passes.
  const modelChip = host.querySelector('[aria-label="Change model"]') as HTMLElement | null;
  if (modelChip) {
    check(
      `the model control names the model in ${where}`,
      (modelChip.textContent || '').includes('claude-opus-4-6'),
      (modelChip.textContent || '').trim() || 'empty',
    );
  }

  // 5. And each of them says which control it is.
  //
  //    The issue's wording is "identified without pressing" — on a touch screen
  //    there is no hover, so `title` reveals nothing and `aria-label` is only
  //    read aloud to somebody who has turned a screen reader on. A drawn word
  //    is the only thing that answers the question for everybody.
  const header = host.querySelector('header') as HTMLElement | null;
  const composer = (host.querySelector('textarea')?.parentElement ?? null) as HTMLElement | null;
  for (const [region, box] of [['the header', header], ['the composer row', composer]] as Array<
    [string, HTMLElement | null]
  >) {
    if (!box) continue;
    const mute = paintedControls(box).filter((node) => {
      if (node.tagName === 'TEXTAREA') return false;
      // A field's placeholder is drawn text saying what the field is for, which
      // is the same answer a button's label gives.
      if (node.tagName === 'INPUT' && (node as HTMLInputElement).placeholder.trim()) return false;
      return !(node.textContent || '').trim();
    });
    check(
      `every control in ${region} is identifiable without pressing it in ${where}`,
      mute.length === 0,
      mute.length ? mute.slice(0, 8).map((n) => describe(n)).join(' | ') : 'all labelled',
    );
  }

  // 6. Nothing is pushed off the side. Vertical overflow inside the
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

  // 7. And the conversation has most of the screen.
  //
  //    Only in the resting state: opening the details or the composer's other
  //    controls is the user asking for that room, and taking it back the moment
  //    they do would make the disclosure useless.
  if (atRest) {
    const scroller = host.querySelector('[data-message-id]')?.closest('[style*="overflow"]') as HTMLElement | null;
    const surface = host.getBoundingClientRect();
    if (scroller && surface.height > 0) {
      const chrome = surface.height - scroller.getBoundingClientRect().height;
      check(
        `the chrome takes no more than ${PHONE_CHAT_CHROME}px from the conversation in ${where}`,
        chrome <= PHONE_CHAT_CHROME,
        `${Math.round(chrome)}px of ${Math.round(surface.height)}px`
          + ` (${Math.round((1 - chrome / surface.height) * 100)}% left to the conversation)`,
      );
    }
  }

  // 8. The regions do not overlap.
  //
  //    Every rule above is satisfiable by a layout whose bands sit on top of
  //    each other: a control can be the right size, in the right type, inside
  //    the surface, and still be underneath the ribbon.
  //
  //    Asserted between the *regions*, not their contents. The conversation is
  //    a scroller, so it clips its own children — a turn scrolled half out of
  //    view has a box that extends above the scroller and is painted nowhere
  //    near there, and comparing that box to the header reports an overlap that
  //    does not exist on screen.
  const conversation = host.querySelector('[data-message-id]')?.closest('[style*="overflow"]') as HTMLElement | null;
  const bands: Array<[string, HTMLElement | null]> = [
    ['the header', host.querySelector('header')],
    ['the status ribbon', host.querySelector('[role="status"][aria-live="polite"]:not(header *)')],
  ];
  for (const [label, band] of bands) {
    if (!band || !conversation || band.contains(conversation) || conversation.contains(band)) continue;
    const bandBox = band.getBoundingClientRect();
    const box = conversation.getBoundingClientRect();
    check(
      `the conversation and ${label} do not overlap in ${where}`,
      box.top >= bandBox.bottom - 1 || box.bottom <= bandBox.top + 1,
      `conversation ${Math.round(box.top)}-${Math.round(box.bottom)}, ${label} ${Math.round(bandBox.top)}-${Math.round(bandBox.bottom)}`,
    );
  }

  // 9. The composer is the one thing that must survive every viewport: a
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

  // The model reaches the composer through a `session` event, not through the
  // snapshot and not through a prop — a `model` field on either is quietly
  // ignored, which is how a fixture ends up asserting the size of the word
  // "model" instead of the size of a model name.
  controller.handle({
    type: 'chat_event',
    sessionId: 'phone-check',
    event: {
      // seq 3, not 0: the reducer drops anything at or below the cursor the
      // snapshot left behind, so a seq-0 session event is silently a no-op.
      t: 'session', seq: 3, ts: Date.now(), model: 'claude-opus-4-6',
      // Repeated in full: a `session` event replaces the capabilities rather
      // than merging into them, so a short one here would quietly take the
      // model list and the interrupt away from everything below.
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: true, commands: [{ name: 'clear' }],
        models: [{ name: 'claude-opus-4-6', value: 'claude-opus-4-6' }],
      },
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
  const states: Array<[string, string[], boolean?]> = [
    ['', []],
    // Scrolled back, because a control only exists in that state: the
    // "Jump to latest" pill floats over the transcript when it is not pinned.
    // It shipped at 34px — a hardcoded height overriding the touch floor its
    // own primitive applies — and every run that happened to leave the
    // transcript pinned reported the phone clean.
    ['scrolled back through the conversation', [], true],
    // Each is now reached through the floating menu: open it, then press the
    // row. Driving it the way a thumb does is the only way to know the route
    // still exists — the controls left the header when the menu arrived.
    ['with the session details open', ['[aria-label="Show the session details"]']],
    ['with the other composer controls open', ['[aria-label="Show the other controls"]']],
    ['with the menu open', ['[aria-label="Open the menu"]']],
  ];

  for (const [name, width, height] of viewports) {
    for (const [state, opens, scrollBack] of states) {
      // A fresh mount per state, not a toggle: closing a sheet is its own
      // control, and a second click on the opener left the previous sheet up
      // and reported its offences against every state after it.
      host.style.cssText = `width:${width}px;height:${height}px;position:absolute;top:0;left:0;display:flex;overflow:hidden`;
      const root = createRoot(host);
      root.render(React.createElement(PhoneSurface, { controller }));
      await wait(400);

      const where = state ? `${name} ${state}` : name;

      if (scrollBack) {
        const scroller = host.querySelector('[data-message-id]')?.closest('[style*="overflow"]') as HTMLElement | null;
        if (scroller) {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event('scroll'));
          await wait(250);
        }
      }

      let reached = true;
      for (const selector of opens) {
        const opener = host.querySelector(selector) as HTMLElement | null;
        if (!opener) {
          check(`the phone surface can open ${state} in ${name}`, false, `no ${selector}`);
          reached = false;
          break;
        }
        opener.click();
        await wait(250);
        settle(host.ownerDocument);
      }
      if (!reached) {
        root.unmount();
        continue;
      }

      // The menu has to be *legible*, not merely present. It was animating in
      // from `opacity: 0` and headless Chrome never advanced the frame, so
      // every rule below skipped the panel as invisible and reported the state
      // as clean — a check that covered the menu by name and nothing by fact.
      if (state.includes('menu')) {
        const panel = host.querySelector('[role="menu"]') as HTMLElement | null;
        const styles = panel ? viewOf(panel).getComputedStyle(panel) : null;
        check(
          `the menu is actually on screen in ${name}`,
          Boolean(panel) && styles!.opacity === '1' && !/rgba\(.*,\s*0\)/.test(styles!.backgroundColor),
          panel ? `opacity=${styles!.opacity} background=${styles!.backgroundColor}` : 'no panel',
        );

        // And the button that dismisses it is still the thing under the finger.
        // Its scrim and it were on the same layer, so which one a tap reached
        // was decided by document order.
        const button = host.querySelector('[aria-label="Close the menu"][aria-haspopup="menu"]') as HTMLElement | null;
        const box = button?.getBoundingClientRect();
        const hit = box
          ? host.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          : null;
        check(
          `the menu button is not covered by its own scrim in ${name}`,
          Boolean(button) && Boolean(hit) && button!.contains(hit as Node),
          hit ? `${(hit as HTMLElement).tagName.toLowerCase()}:${(hit as HTMLElement).getAttribute('aria-label') || '?'}` : 'nothing there',
        );
      }
      assertPhoneSurface(host, where, opens.length === 0);
      root.unmount();
    }
  }

  // The bar is a set of destinations, and pressing one has to go there.
  //
  // Asserted by driving it, because the parts that could be wrong are all on
  // the far side of a press: which item paints as current, and whether the
  // surface actually changed. Static markup shows a bar that looks right and
  // navigates nowhere.
  {
    host.style.cssText = 'width:390px;height:740px;position:absolute;top:0;left:0;display:flex;overflow:hidden';
    const root = createRoot(host);
    root.render(React.createElement(PhoneSurface, { controller }));
    await wait(400);

    const bar = host.querySelector('nav[aria-label="Go to"]') as HTMLElement | null;
    const current = (): string =>
      (bar?.querySelector('[aria-current="page"]')?.textContent || '').trim();

    check('the bar starts on the conversation', current() === 'Chat', current() || 'nothing current');

    for (const [label, expect] of [
      ['Trace', 'a rail'],
      ['Files', 'a rail'],
      ['Chat', 'the transcript'],
    ] as Array<[string, string]>) {
      const item = Array.from(bar?.querySelectorAll('button') ?? []).find(
        (node) => (node.textContent || '').trim() === label,
      ) as HTMLElement | undefined;
      if (!item) {
        check(`the bar offers ${label}`, false, 'not found');
        continue;
      }
      item.click();
      await wait(300);

      check(`pressing ${label} marks it as where you are`, current() === label, current() || 'nothing current');

      const showsRail = Boolean(host.querySelector('aside[aria-label="Workspace"]'));
      const showsTranscript = Boolean(host.querySelector('[data-message-id]'));
      check(
        `pressing ${label} actually shows ${expect}`,
        expect === 'a rail' ? showsRail : showsTranscript && !showsRail,
        `rail=${showsRail} transcript=${showsTranscript}`,
      );
    }

    root.unmount();
  }

  // Reachable, not merely legible wherever it happened to be drawn. Collapsing
  // the header and the composer is what this asserts the price of: every figure
  // the issue names by hand still has a state that shows it.
  for (const label of ['the state', 'the cost and tokens', 'the approvals state', 'the model']) {
    check(
      `${label} is reachable somewhere on a phone`,
      seenLive.has(label),
      seenLive.has(label) ? 'shown' : 'never on screen in any state',
    );
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
 * The floating menu is mounted *open*, because shut it is one button and the
 * question is whether the list behind it can be read and hit.
 *
 * The terminal's key strip is deliberately not here. It is the terminal's own
 * on-screen controls, which issue #51 lists as a non-goal — they were sized
 * for a thumb when they were added, under their own issue.
 */
async function checkThePhoneShellSurfacesAreUsable(): Promise<void> {
  const noop = (): void => {};
  const surfaces: Array<[string, () => React.ReactElement]> = [
    ['the floating menu', () =>
      React.createElement(OpenFloatingMenu, {
        actions: [
          { id: 'search', label: 'Search this conversation', icon: 'search', onPress: noop, expands: true, group: 'surface' },
          { id: 'trace', label: 'Trace rail', icon: 'panel-right', onPress: noop, toggle: true, active: true, group: 'surface' },
          { id: 'sessions', label: 'Sessions', icon: 'layout-list', onPress: noop, expands: true, group: 'session' },
          { id: 'new', label: 'New', icon: 'plus', onPress: noop, group: 'session' },
          { id: 'more', label: 'More', icon: 'ellipsis', onPress: noop, expands: true, group: 'session' },
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
    ['the chat settings dialog', () =>
      React.createElement(ChatSettingsDialog, {
        open: true, settings: DEFAULT_CHAT_VIEW, onChange: noop, onClose: noop,
      } as never)],
    ['the sessions dialog', () =>
      React.createElement(SessionsDialog, {
        open: true,
        sessions: [
          { id: 's1', title: 'a session with a fairly long name', runtime: 'claude', workingDir: '/tmp/a' },
          { id: 's2', title: 'another one', runtime: 'codex', workingDir: '/tmp/b' },
        ],
        activeId: 's1', onJoin: noop, onLeave: noop, onDelete: noop, onNew: noop, onClose: noop,
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
    // Inside a provider, because two of these are the app's ordinary dialogs
    // rather than phone-only surfaces: they take their sizing from the shell's
    // `isMobile`, the same way every other component below AppShell does, and
    // outside one they would correctly render at desktop sizes.
    root.render(React.createElement(PhoneContext.Provider, { value: true }, render()));
    await wait(300);
    settle(doc);

    const target = host;
    const controls = paintedControls(target);
    if (controls.length === 0) {
      check(`${name} renders on a phone`, false, 'no controls found');
      root.unmount();
      frame.remove();
      continue;
    }

    const small = controls.filter((node) => {
      const box = laidOutSize(node);
      return box.width < PHONE_TARGET || box.height < PHONE_TARGET;
    });
    check(
      `every control in ${name} is at least ${PHONE_TARGET}px`,
      small.length === 0,
      small.length
        ? small.slice(0, 8).map((n) => {
            const b = laidOutSize(n);
            return `${describe(n)}=${b.width}x${b.height}`;
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

/**
 * A name the user chose can be any length (issue #54).
 *
 * Names used to live only in the page that typed them, so nothing longer than
 * a session id ever survived to be looked at twice. Now a name is stored and
 * comes back on every page load, on every device — including the 300-character
 * one somebody pasted in — so the strip has to keep it inside its own row
 * instead of stretching until the tabs beside it are unreachable.
 */
async function checkALongTabNameStaysInsideTheStrip(): Promise<void> {
  const LONG = 'a session name that somebody pasted in from a commit message and never shortened, '
    + 'complete with a path /home/dev/projects/deeply/nested/thing and a ticket reference #54';

  const host = document.createElement('div');
  host.style.cssText = 'width:900px;position:absolute;top:0;left:0';
  document.body.appendChild(host);

  const root = createRoot(host);
  root.render(
    React.createElement(TabBar, {
      tabs: [
        { id: 't1', title: LONG, status: 'running' },
        { id: 't2', title: 'short', status: 'idle' },
        { id: 't3', title: 'also short', status: 'idle' },
      ],
      activeId: 't1',
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      ariaLabel: 'Sessions',
    } as never),
  );
  await wait(200);

  const strip = host.querySelector('[role="tablist"][aria-label="Sessions"]') as HTMLElement;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
  const stripBox = strip.getBoundingClientRect();

  check(
    'a very long tab name does not widen its tab past the strip’s limit',
    tabs[0].getBoundingClientRect().width <= 209,
    `${Math.round(tabs[0].getBoundingClientRect().width)}px`,
  );
  check(
    'the tabs beside it are still on screen',
    tabs.length === 3 && tabs[2].getBoundingClientRect().right <= stripBox.right + 1,
    `${tabs.length} tabs, last right=${Math.round(tabs[2]?.getBoundingClientRect().right ?? -1)} strip right=${Math.round(stripBox.right)}`,
  );
  check(
    'the strip is still one row tall',
    host.getBoundingClientRect().height <= 37,
    `${Math.round(host.getBoundingClientRect().height)}px`,
  );

  root.unmount();
  host.remove();

  // And the same name in the phone's tab switcher, where the row is the whole
  // width of the screen and there is nowhere for an overflow to hide.
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

  const sheetRoot = createRoot(doc.body);
  sheetRoot.render(
    React.createElement(
      PhoneContext.Provider,
      { value: true },
      React.createElement(TabSwitcherSheet, {
        open: true,
        tabs: [
          { id: 't1', title: LONG, kind: 'chat' },
          { id: 't2', title: 'short', kind: 'terminal' },
        ],
        activeId: 't1',
        onSelect: () => {}, onCloseTab: () => {}, onNew: () => {},
        onAllSessions: () => {}, onClose: () => {},
      } as never),
    ),
  );
  await wait(300);
  settle(doc);

  const spilling = Array.from(doc.body.querySelectorAll<HTMLElement>('*')).filter((node) => {
    if (!isPainted(node) || scrollsSideways(node)) return false;
    const box = node.getBoundingClientRect();
    return box.right > 391 || box.left < -1;
  });
  check(
    'a very long tab name does not push the phone tab switcher off the side',
    spilling.length === 0,
    spilling.length ? spilling.slice(0, 6).map((n) => describe(n)).join(' | ') : 'nothing overflowing',
  );

  sheetRoot.unmount();
  frame.remove();
}

/** The floating menu with its own button already pressed. */
function OpenFloatingMenu({ actions }: { actions: FloatingMenuAction[] }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    (ref.current?.querySelector('[aria-label="Open the menu"]') as HTMLElement | null)?.click();
  }, []);
  return React.createElement(
    'div',
    { ref, style: { position: 'relative', width: '100%', height: '100%' } },
    React.createElement(FloatingMenu, { actions } as never),
  );
}

/**
 * The one acceptance criterion of issue #56 that only a browser can answer.
 *
 * "An agent that reports no usage or no cost is shown as not reported and never
 * as zero" is a claim about pixels, not about types: every layer underneath
 * keeps the null intact, and it would take exactly one `?? 0` or one
 * `.toFixed(2)` in a cell to turn the whole distinction into a confident
 * $0.00 that nobody would ever question. So this renders the real dialog
 * against a real response and reads what came out.
 */
async function checkAnUnreportedFigureIsNeverDrawnAsZero(): Promise<void> {
  const totals = (over: Record<string, number>) => ({
    jobs: 0, turns: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, costUsd: 0,
    tokensReportedJobs: 0, costReportedJobs: 0,
    ...over,
  });

  // codex reports tokens and never reports cost; claude reports both. A
  // dashboard that renders these two the same way is the bug.
  const dashboard = {
    scope: 'self', canSeeEveryone: false, period: 'day',
    from: '2026-07-27T00:00:00.000Z', to: '2026-07-28T00:00:00.000Z',
    totals: totals({ jobs: 4, turns: 9, toolCalls: 12, totalTokens: 5000, costUsd: 1.25, tokensReportedJobs: 4, costReportedJobs: 2 }),
    series: [{ key: '2026-07-27T09:00', totals: totals({ jobs: 4, totalTokens: 5000, costUsd: 1.25, tokensReportedJobs: 4, costReportedJobs: 2 }) }],
    byAgent: [
      { key: 'claude', totals: totals({ jobs: 2, totalTokens: 3000, costUsd: 1.25, tokensReportedJobs: 2, costReportedJobs: 2 }) },
      { key: 'codex', totals: totals({ jobs: 2, totalTokens: 2000, tokensReportedJobs: 2, costReportedJobs: 0 }) },
    ],
    byModel: [], effortByAgent: [], effortByModel: [], topTools: [], topToolsByAgent: [],
  };

  const realFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    const body = url.includes('/api/usage/dashboard') ? dashboard : { jobs: [], total: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;

  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1100px;height:800px;position:absolute;top:0;left:0;border:0';
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

  const root = createRoot(doc.body);
  root.render(React.createElement(UsageDashboardDialog, { open: true, onClose: () => {} } as never));
  await wait(600);

  const text = (doc.body.textContent || '').replace(/\s+/g, ' ');

  check(
    'the usage dashboard renders its figures at all',
    text.includes('1.25') && /5[.,]0k|5,?000/.test(text),
    text.slice(0, 200) || 'nothing rendered',
  );

  check(
    'a cost no agent reported is not drawn as zero',
    !/\$0\.00/.test(text),
    /\$0\.00/.test(text) ? `found $0.00 in: ${text.slice(0, 300)}` : 'no confident zero on screen',
  );

  check(
    'a cost no agent reported says so in words',
    /not reported|cannot report|n\/a/i.test(text),
    text.includes('not reported') ? 'says not reported' : text.slice(0, 300),
  );

  check(
    'a bucket label on the trend line is a date, not Invalid Date',
    !/Invalid Date/.test(text),
    /Invalid Date/.test(text) ? text.slice(0, 300) : 'every label parsed',
  );

  check(
    'a partly-reported total says how much of it was measured',
    /2 of 4|of 4 jobs/i.test(text),
    /2 of 4/.test(text) ? 'qualified' : text.slice(0, 300),
  );

  const spilling = Array.from(doc.body.querySelectorAll<HTMLElement>('*')).filter((node) => {
    if (!isPainted(node) || scrollsSideways(node)) return false;
    const box = node.getBoundingClientRect();
    return box.right > 1101 || box.left < -1;
  });
  check(
    'the usage dashboard stays inside the window',
    spilling.length === 0,
    spilling.length ? spilling.slice(0, 6).map((n) => describe(n)).join(' | ') : 'nothing overflowing',
  );

  root.unmount();
  frame.remove();
  window.fetch = realFetch;
}
