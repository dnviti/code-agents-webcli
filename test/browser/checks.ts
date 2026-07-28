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
import { MonacoEditor } from '../../src/client/shell/chat/MonacoEditor';
import { monacoStylesApplied } from '../../src/client/chat/monaco';

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
  await checkAMessageThatCouldNotBeSentSaysSoAndCanBeRetried();
  await checkTheFixedBarsNeverWrap();
  await checkALiveAnswerAppearsAsItStreams();
  await checkSilentStepsLeaveNoRowButKeepTheirTrace();
  await checkAQuestionIsAnsweredByClicking();
  await checkThePhoneLayoutIsUsable();
  await checkThePhoneShellSurfacesAreUsable();
  await checkALongTabNameStaysInsideTheStrip();
  await checkAnUnreportedFigureIsNeverDrawnAsZero();
  await checkTheUsageChartsAreInteractive();
  await checkAServerOlderThanThePageSaysSo();
  await checkUnattributedWorkCanBeAttributedByHand();
  await checkTheHistoryListsConversationsRatherThanRequests();
  await checkTheCommandMenuIsFullBeforeTheFirstMessage();
  await checkANewConversationCanBeStartedFromTheComposer();
  await checkTheFileEditorShowsTheFile();
  await checkAReadOnlyFileStaysReadOnly();
  await checkATurnsBadgeSaysHowItEnded();
  await checkAWaitingMessageCanBeSentNow();
  await checkALongQueueCollapsesToOneRow();
  await checkFoldedHistoryIsNotBuiltUntilItIsOpened();
  await checkAConversationTellsOneStoryAboutItsTokens();
  await checkTheModelShownIsTheModelThatRan();
  await checkTheContextReadingIsHonestAboutItsCeiling();
  await checkTheTurnIndexListsTheWholeConversation();

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
    // Answers only. Opening a conversation also asks for its turn index (#86),
    // which is not an answer to anything and must not read as one.
    const answersSoFar = sent.filter((m) => m.type === 'chat_question_answer');
    check(
      'picking a checkbox does not answer on its own',
      answersSoFar.length === 0,
      `${answersSoFar.length} sent`,
    );
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
/**
 * A queued message that could not be delivered, as the person who typed it sees it.
 *
 * The failure this belongs to (#89) is silent by nature: the message left the
 * queue, appeared in the conversation and was never answered, and the whole
 * point of queueing is that nobody is watching while it happens. So the row
 * that says otherwise has to be real — visible text giving the reason, the
 * message itself still there to be recovered, and a button that actually asks
 * the server to try again. Every part of that is a rendering question, which
 * is why it is checked here rather than in a unit test.
 */
async function checkAMessageThatCouldNotBeSentSaysSoAndCanBeRetried(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:420px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const sent: Array<Record<string, unknown>> = [];
  const controller = new ChatController('browser-check', { send: (message) => sent.push(message) });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'browser-check',
    snapshot: {
      sessionId: 'browser-check',
      runtime: 'claude',
      state: 'idle',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: true, commands: [],
      },
      messages: [],
      pendingPermissions: [],
      queued: [
        {
          id: 'q-failed',
          text: 'the one that did not go',
          ts: 1,
          error: 'the pi process was still busy 15s after the last turn ended',
          attempts: 1,
        },
        { id: 'q-waiting', text: 'the one still waiting', ts: 2 },
      ],
      firstSeq: 1,
      replayFrom: 1,
      cursor: 1,
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
  await wait(250);

  const rows = Array.from(
    host.querySelectorAll('[aria-label="Messages waiting to be sent"] [role="listitem"]'),
  ) as HTMLElement[];
  check('both queued messages are on screen', rows.length === 2, `${rows.length} rows`);

  const failedRow = rows[0];
  const waitingRow = rows[1];
  const failedText = failedRow?.textContent ?? '';

  check(
    'the message that could not be sent is still there to be recovered, not retyped',
    failedText.includes('the one that did not go'),
    failedText.slice(0, 160),
  );
  check(
    'and it says, in words, that it was not sent and why',
    failedText.includes('Not sent') && failedText.includes('still busy'),
    failedText.slice(0, 160),
  );

  // Announced rather than merely coloured: nobody is looking at the composer
  // while a queue works through, which is the whole reason the queue exists.
  check(
    'the reason is announced, not only drawn',
    Boolean(failedRow?.querySelector('[role="alert"]')),
  );

  const retry = Array.from(failedRow?.querySelectorAll('button') ?? []).find((button) =>
    (button.textContent ?? '').includes('Try again'),
  ) as HTMLButtonElement | undefined;
  check('the row offers a way to try it again', Boolean(retry));
  check(
    'and it is a real button, so it can be reached from the keyboard',
    retry?.tagName === 'BUTTON' && !retry.disabled,
  );

  const before = sent.length;
  retry?.click();
  await wait(150);
  const asked = sent.slice(before).find((message) => message.type === 'chat_queue_retry');
  check(
    'pressing it asks the server to send that exact message again',
    Boolean(asked) && asked?.queuedId === 'q-failed',
    JSON.stringify(sent.slice(before)),
  );

  // The offer belongs to the failure, not to the queue: a message that is
  // simply waiting its turn has nothing to retry.
  const waitingText = waitingRow?.textContent ?? '';
  check(
    'a message that is merely waiting is not dressed up as a failure',
    !waitingText.includes('Not sent') && !waitingText.includes('Try again'),
    waitingText.slice(0, 160),
  );

  root.unmount();
  host.remove();
}

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

/**
 * The index beside a conversation lists all of it, not the part that is loaded.
 *
 * The defect this covers is invisible to a unit test of the merge: a browser
 * holding the last two turns of a hundred-turn conversation used to draw an
 * index of two, numbered 1 and 2, in the one case where an index is the only
 * way to navigate (#86). So this asserts what is actually on screen — the count,
 * the numbering, and that each row is titled with what the *user* asked.
 */
async function checkTheTurnIndexListsTheWholeConversation(): Promise<void> {
  const frame = document.createElement('div');
  frame.style.cssText = 'width:1400px;height:800px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(frame);

  const sent: Array<Record<string, unknown>> = [];
  const controller = new ChatController('browser-check', {
    send: (message: Record<string, unknown>) => sent.push(message),
  } as never);

  // What a browser actually holds after opening a long conversation: the tail.
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'browser-check',
    snapshot: {
      sessionId: 'browser-check',
      runtime: 'claude',
      state: 'idle',
      capabilities: { streaming: true, questions: false },
      // The replay landed *inside* the last turn, which is what a reload of a
      // long conversation actually gives you: the ask that opened it is not in
      // the window, only the answer to it.
      messages: [
        {
          id: 'a40', seq: 80, turnId: 't40', role: 'assistant', ts: 80,
          blocks: [{ kind: 'text', text: 'the discovery that simplified it' }],
        },
      ],
      pendingPermissions: [],
      pendingQuestions: [],
      firstSeq: 1,
      replayFrom: 79,
      cursor: 80,
      live: true,
      bypassPermissions: false,
    },
  } as never);

  check(
    'opening a conversation asks for its whole turn index',
    sent.some((message) => message.type === 'chat_turn_index_request'),
    sent.map((message) => String(message.type)).join(' | ') || 'nothing was asked for',
  );

  // What the server answers with: every turn, from the first.
  const recorded = Array.from({ length: 40 }, (_, i) => ({
    id: `u${i + 1}`,
    turnId: `t${i + 1}`,
    index: i + 1,
    label:
      i === 0 ? 'set up the parser' : i === 39 ? 'and now the changelog' : `ask ${i + 1}`,
    startedAt: (i + 1) * 1000,
    outcome: 'done',
  }));
  // One with no user prompt behind it, which must say so rather than quote the
  // model — the tail of a resumed conversation is the ordinary case.
  recorded[1] = { ...recorded[1], label: null } as never;

  controller.handle({
    type: 'chat_turn_index',
    sessionId: 'browser-check',
    turns: recorded,
    firstSeq: 1,
    complete: true,
  } as never);
  await wait(50);

  const root = createRoot(frame);
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

  // The number on the strip over the conversation, which is what a reload
  // actually shows you: holding the last turn of forty, it must say 40. It said
  // "TURN 1" until the whole history had been paged in, because the number came
  // from the position in the loaded window rather than from the conversation.
  // Read off the strip itself rather than the page text: the index panel also
  // shows a count, and a check that matched anywhere would pass on that.
  const strip = frame.querySelector('[data-turn-id]');
  const stripText = (strip?.textContent || '').replace(/\s+/g, ' ');
  const foldLabel = strip
    ?.querySelector('[aria-label^="Collapse turn"], [aria-label^="Expand turn"]')
    ?.getAttribute('aria-label');
  check(
    'the turn on screen is numbered by the conversation, not by the window',
    foldLabel === 'Collapse turn 40' || foldLabel === 'Expand turn 40',
    foldLabel || 'no turn strip on screen',
  );
  check(
    'the conversation is on screen under that number',
    stripText.length > 0,
    stripText.slice(0, 80) || 'the strip is empty',
  );

  const list = frame.querySelector('[aria-label="Conversation turns"]');
  const rows = list ? Array.from(list.querySelectorAll('[role="option"]')) : [];
  check(
    'the index lists every turn, not only the ones loaded',
    rows.length === 40,
    `${rows.length} rows for a 40-turn conversation holding 1`,
  );
  check(
    'and it starts at the first turn rather than part way through',
    (rows[0]?.textContent || '').includes('set up the parser'),
    (rows[0]?.textContent || '').slice(0, 80) || 'no first row',
  );
  check(
    'a turn with no prompt behind it says so instead of quoting the model',
    (rows[1]?.textContent || '').includes('no prompt'),
    (rows[1]?.textContent || '').slice(0, 80) || 'no second row',
  );
  // The turn on screen, whose opening ask is not in the window. It reads "no
  // prompt" if the label is taken from the loaded messages — which is what the
  // index showed for the turn the user was looking at (#86).
  check(
    'a half-loaded turn is titled from the recording, not "no prompt"',
    (rows[39]?.textContent || '').includes('and now the changelog'),
    (rows[39]?.textContent || '').slice(0, 80) || 'no last row',
  );

  // A transcript this short is already scrolled to its top, so the list asks
  // for a page on its own. Settle that one first, or the click below would be
  // measured against a request it did not make.
  controller.handle({
    type: 'chat_page',
    sessionId: 'browser-check',
    events: [],
    firstSeq: 1,
    from: 40,
    cursor: 80,
  } as never);
  await wait(200);

  // Choosing one from before what is loaded has to take the user there, which
  // means fetching it first. Asserted on the outcome rather than on the request
  // — a transcript this short is at its own top and asks for pages unprompted,
  // so counting requests would measure the scroll position, not the click.
  (rows[0] as HTMLElement | undefined)?.click();
  await wait(200);
  check(
    'and the entry stays selected while it is being fetched',
    rows[0]?.getAttribute('aria-selected') === 'true',
    String(rows[0]?.getAttribute('aria-selected')),
  );

  controller.handle({
    type: 'chat_page',
    sessionId: 'browser-check',
    events: [
      { t: 'msg_start', seq: 1, ts: 1, id: 'u1', role: 'user', turnId: 't1' },
      { t: 'block_start', seq: 2, ts: 1, msgId: 'u1', index: 0, block: { kind: 'text', text: 'set up the parser' } },
      { t: 'msg_end', seq: 3, ts: 1, msgId: 'u1' },
      { t: 'turn_end', seq: 4, ts: 1, turnId: 't1', stopReason: 'end_turn' },
    ],
    firstSeq: 1,
    from: 1,
    cursor: 80,
  } as never);
  await wait(400);

  const transcriptText = frame.textContent || '';
  check(
    'selecting an older entry brings that turn into the conversation',
    transcriptText.includes('set up the parser'),
    transcriptText.includes('set up the parser') ? 'the turn is here' : 'the turn never arrived',
  );

  root.unmount();
  frame.remove();
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
      + '<link rel="stylesheet" href="/css/relay/relay.css">'
      + '<link rel="stylesheet" href="/css/main.css">'
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
    + '<link rel="stylesheet" href="/css/relay/relay.css">'
    + '<link rel="stylesheet" href="/css/main.css">'
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
    turns: 0, modelTurns: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, costUsd: 0,
    tokensReportedTurns: 0, costReportedTurns: 0, modelTurnsReportedTurns: 0,
    ...over,
  });

  // codex reports tokens and never reports cost; claude reports both. A
  // dashboard that renders these two the same way is the bug.
  const dashboard = {
    scope: 'self', canSeeEveryone: false, period: 'day',
    from: '2026-07-27T00:00:00.000Z', to: '2026-07-28T00:00:00.000Z',
    bucket: 'hour', filters: {},
    totals: totals({ turns: 4, modelTurns: 9, toolCalls: 12, totalTokens: 5000, costUsd: 1.25, tokensReportedTurns: 4, costReportedTurns: 2 }),
    // Two buckets, not one: the second reported nothing at all, and half of
    // what these checks are for is that it does not come out looking like an
    // hour that cost zero.
    series: [
      { key: '2026-07-27T09:00', totals: totals({ turns: 4, totalTokens: 5000, costUsd: 1.25, tokensReportedTurns: 4, costReportedTurns: 2 }) },
      { key: '2026-07-27T10:00', totals: totals({ turns: 2, totalTokens: 900, tokensReportedTurns: 2, costReportedTurns: 0 }) },
    ],
    byProject: [
      { key: 'billing-api', totals: totals({ turns: 3, totalTokens: 4000, costUsd: 1.25, tokensReportedTurns: 3, costReportedTurns: 2 }) },
      // The sentinel the server sends for work recorded before projects
      // existed. Spelled out here rather than imported, because the point of
      // the check is that the browser renders whatever the wire actually says —
      // which is exactly how a mismatch between this literal and the constant
      // caught the sentinel being an unprintable control character.
      { key: '//unattributed', totals: totals({ turns: 1, totalTokens: 1000, tokensReportedTurns: 1, costReportedTurns: 0 }) },
    ],
    byAgent: [
      { key: 'claude', totals: totals({ turns: 2, totalTokens: 3000, costUsd: 1.25, tokensReportedTurns: 2, costReportedTurns: 2 }) },
      { key: 'codex', totals: totals({ turns: 2, totalTokens: 2000, tokensReportedTurns: 2, costReportedTurns: 0 }) },
    ],
    // A job whose runtime never named a model groups under the empty key —
    // the breakdown must label that, not leave the cell blank.
    byModel: [
      { key: 'claude-opus-5', totals: totals({ turns: 2, totalTokens: 3000, costUsd: 1.25, tokensReportedTurns: 2, costReportedTurns: 2 }) },
      { key: '', totals: totals({ turns: 2, totalTokens: 2000, tokensReportedTurns: 2, costReportedTurns: 0 }) },
    ],
    effortByAgent: [], effortByModel: [], topTools: [], topToolsByAgent: [],
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
    + '<link rel="stylesheet" href="/css/relay/relay.css">'
    + '<link rel="stylesheet" href="/css/main.css">'
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

  // A dollar figure on a subscription plan is a list price, not a bill, and
  // nothing in the data says which plan an account is on — so the caveat has
  // to be on screen, not on hover, where a tooltip check would pass while a
  // viewer read the totals as money they had spent.
  check(
    'the dashboard says on screen that cost is a list price, not a bill',
    /subscription/i.test(text) && /would have cost|not as what you were charged/i.test(text),
    /subscription/i.test(text) ? 'caveat is visible' : text.slice(0, 400),
  );

  const blankLabels = Array.from(doc.querySelectorAll('tbody tr')).filter(
    (row) => !(row.querySelector('td')?.textContent || '').trim(),
  );
  check(
    'a breakdown row for an unnamed model is labelled, not blank',
    blankLabels.length === 0,
    blankLabels.length === 0
      ? 'every breakdown row has a label'
      : `${blankLabels.length} row(s) with an empty first cell`,
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

/**
 * Issue #66's acceptance criteria, which are all claims about pixels and
 * events rather than about types.
 *
 * "The charts are interactive" survives a typecheck no matter how it is built:
 * an SVG `<title>` compiles, renders, and is unreachable by a finger, by the
 * keyboard and by a screen reader. So this drives the real dialog against a
 * real response and checks the things a viewer actually does — focus a bar,
 * press it, press a breakdown row — and, crucially, checks what went back to
 * the *server* as a result. A selection that highlights a bar without
 * re-asking the question is a chart that only looks interactive.
 */
async function checkTheUsageChartsAreInteractive(): Promise<void> {
  const totals = (over: Record<string, number>) => ({
    turns: 0, modelTurns: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, costUsd: 0,
    tokensReportedTurns: 0, costReportedTurns: 0, modelTurnsReportedTurns: 0,
    ...over,
  });

  const dashboard = {
    scope: 'self', canSeeEveryone: false, period: 'day',
    from: '2026-07-27T00:00:00.000Z', to: '2026-07-28T00:00:00.000Z',
    bucket: 'hour', filters: {},
    totals: totals({ turns: 6, modelTurns: 11, toolCalls: 14, totalTokens: 5900, costUsd: 1.25, tokensReportedTurns: 6, costReportedTurns: 2 }),
    series: [
      { key: '2026-07-27T09:00', totals: totals({ turns: 4, modelTurns: 8, toolCalls: 10, totalTokens: 5000, costUsd: 1.25, tokensReportedTurns: 4, costReportedTurns: 2 }) },
      // Reported nothing on cost. Must not be drawn as a bar of height zero.
      { key: '2026-07-27T10:00', totals: totals({ turns: 2, modelTurns: 3, toolCalls: 4, totalTokens: 900, tokensReportedTurns: 2, costReportedTurns: 0 }) },
    ],
    byProject: [
      { key: 'billing-api', totals: totals({ turns: 3, totalTokens: 4000, costUsd: 1.25, tokensReportedTurns: 3, costReportedTurns: 2 }) },
      { key: 'web', totals: totals({ turns: 3, totalTokens: 1900, tokensReportedTurns: 3, costReportedTurns: 0 }) },
    ],
    byAgent: [
      { key: 'claude', totals: totals({ turns: 4, totalTokens: 5000, costUsd: 1.25, tokensReportedTurns: 4, costReportedTurns: 2 }) },
      { key: 'codex', totals: totals({ turns: 2, totalTokens: 900, tokensReportedTurns: 2, costReportedTurns: 0 }) },
    ],
    byModel: [{ key: 'claude-opus-5', totals: totals({ turns: 6, totalTokens: 5900, costUsd: 1.25, tokensReportedTurns: 6, costReportedTurns: 2 }) }],
    effortByAgent: [], effortByModel: [], topTools: [], topToolsByAgent: [],
  };

  const asked: string[] = [];
  const realFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    asked.push(url);
    const body = url.includes('/api/usage/dashboard') ? dashboard : { jobs: [], total: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;

  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1100px;height:900px;position:absolute;top:0;left:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument as Document;
  doc.open();
  doc.write(
    '<!doctype html><html><head>'
    + '<link rel="stylesheet" href="/css/relay/relay.css">'
    + '<link rel="stylesheet" href="/css/main.css">'
    + '</head><body style="margin:0"></body></html>',
  );
  doc.close();
  await wait(150);

  const root = createRoot(doc.body);
  root.render(React.createElement(UsageDashboardDialog, { open: true, onClose: () => {} } as never));
  await wait(600);

  const bars = (): HTMLButtonElement[] =>
    Array.from(doc.querySelectorAll<HTMLButtonElement>('[role="group"] button'));

  check(
    'every point on the trend is a real control, not a decoration',
    bars().length === 2 && bars().every((b) => b.tagName === 'BUTTON'),
    `${bars().length} control(s) on the trend`,
  );

  check(
    'a point announces its own figures to a screen reader',
    bars().some((b) => /1\.25/.test(b.getAttribute('aria-label') || '')),
    bars().map((b) => b.getAttribute('aria-label')).join(' | ').slice(0, 200),
  );

  // No pointer, no hover: just reaching the control, the way a keyboard tab
  // stop or a tap on a touch screen does.
  bars()[1].focus();
  await wait(120);
  const live = doc.querySelector('[aria-live="polite"]') as HTMLElement | null;
  check(
    'reaching a point reveals its figures without a mouse',
    Boolean(live && /not reported/i.test(live.textContent || '')),
    live ? (live.textContent || '').slice(0, 160) : 'no readout region',
  );

  // The two facts this dashboard exists to keep apart, one pixel from each
  // other on a chart: an hour that reported no cost, and an hour that cost
  // nothing. If both bars paint the same, the chart is lying about one.
  const fills = bars().map((b) => {
    const span = b.querySelector('span') as HTMLElement;
    const style = (frame.contentWindow as Window).getComputedStyle(span);
    return `${style.backgroundColor}/${style.borderTopStyle}`;
  });
  check(
    'a bucket nothing reported is drawn differently from one that cost zero',
    fills[0] !== fills[1],
    fills.join(' vs '),
  );

  const measureTab = Array.from(doc.querySelectorAll<HTMLElement>('button, [role="tab"]')).find(
    (el) => (el.textContent || '').trim() === 'Tokens',
  );
  check('the trend offers a measure other than cost', Boolean(measureTab), measureTab ? 'found' : 'no Tokens control');
  measureTab?.click();
  await wait(200);
  check(
    'switching the measure redraws the chart against it',
    bars().some((b) => /Tokens/i.test(b.getAttribute('aria-label') || '')),
    bars().map((b) => b.getAttribute('aria-label')).join(' | ').slice(0, 200),
  );

  // Selecting a breakdown row must reach the server, not merely tint a row.
  const before = asked.length;
  const projectButton = Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.textContent || '').trim() === 'billing-api',
  );
  check('a breakdown row can be selected', Boolean(projectButton), projectButton ? 'found' : 'no billing-api row');
  projectButton?.click();
  await wait(400);
  const sinceRow = asked.slice(before);
  check(
    'selecting a project re-asks the whole dashboard for that project',
    sinceRow.some((u) => u.includes('/api/usage/dashboard') && u.includes('project=billing-api')),
    sinceRow.join(' | ').slice(0, 300) || 'nothing was re-requested',
  );
  check(
    // The list underneath is the conversations one (#88); the claim is
    // unchanged — a narrowing reaches it, rather than leaving it answering a
    // different question from the charts above.
    'and narrows the list underneath it by the same thing',
    sinceRow.some((u) => u.includes('/api/usage/conversations') && u.includes('project=billing-api')),
    sinceRow.filter((u) => u.includes('/conversations')).join(' | ').slice(0, 300)
      || 'the conversation list was not re-requested',
  );

  const chipText = (doc.querySelector('[aria-label="Active filters"]') as HTMLElement | null)?.textContent || '';
  check(
    'the narrowing says on screen what it is',
    /billing-api/.test(chipText),
    chipText.slice(0, 160) || 'no filter chips',
  );

  // Pressing a bar narrows to that hour — the drill-down from the chart.
  const beforeBar = asked.length;
  bars()[0].click();
  await wait(400);
  const sinceBar = asked.slice(beforeBar);
  check(
    'selecting a point on the trend narrows the range to it',
    sinceBar.some((u) => u.includes('/api/usage/dashboard') && u.includes('from=') && u.includes('to=')),
    sinceBar.join(' | ').slice(0, 300) || 'nothing was re-requested',
  );

  // And it must be undoable in one action, from the chip rather than by
  // finding precisely the same bar again.
  const beforeClear = asked.length;
  const clearAll = Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.textContent || '').trim() === 'Clear all',
  );
  check('there is one control that clears everything', Boolean(clearAll), clearAll ? 'found' : 'no Clear all');
  clearAll?.click();
  await wait(400);
  check(
    'clearing puts the unnarrowed question back',
    asked.slice(beforeClear).some((u) => u.includes('/api/usage/dashboard') && !u.includes('project=')),
    asked.slice(beforeClear).join(' | ').slice(0, 300) || 'nothing was re-requested',
  );

  const sortButton = Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
    // "Jobs" until #86, when the unit got the name it always was: a turn.
    (b) => (b.getAttribute('aria-label') || '') === 'Sort by Turns',
  );
  check('a breakdown can be re-sorted by another measure', Boolean(sortButton), sortButton ? 'found' : 'no sort control');

  // Phone width: the whole point of dropping the fixed-width SVG.
  frame.style.width = '390px';
  await wait(300);
  const spilling = Array.from(doc.body.querySelectorAll<HTMLElement>('*')).filter((node) => {
    if (!isPainted(node) || scrollsSideways(node)) return false;
    const box = node.getBoundingClientRect();
    return box.right > 391 || box.left < -1;
  });
  check(
    'the charts stay inside a phone-width window',
    spilling.length === 0,
    spilling.length ? spilling.slice(0, 6).map((n) => describe(n)).join(' | ') : 'nothing overflowing',
  );

  root.unmount();
  frame.remove();
  window.fetch = realFetch;
}

/**
 * The page served out of `dist/public` by a server process that started before
 * the build that produced it.
 *
 * A real crash, and an easy one to hit: rebuilding refreshes the bundle a
 * running server hands out without refreshing the routes it answers with, so
 * the browser gets a response one version behind the code reading it. The
 * breakdown it expects is simply absent, and spreading `undefined` took the
 * whole dialog down — including any chance of saying why. Guarding the table
 * alone would have been worse: an absent breakdown would then draw as a
 * project list with nothing in it, which is a different and more believable
 * lie.
 */
/**
 * The history reads as conversations, and one of them opens onto its requests.
 *
 * The claim #88 makes is about what is on screen, and a typecheck cannot see
 * any of it: a dashboard that asked for conversations and then drew the flat
 * job list compiles perfectly. So this renders the real dialog against real
 * responses and asks four things a person would ask — is the list the tabs
 * rather than the requests, does an entry carry enough to recognise it, does a
 * conversation that used two agents say so instead of naming one, and is the
 * detail still reachable underneath.
 */
async function checkTheHistoryListsConversationsRatherThanRequests(): Promise<void> {
  const totals = (over: Record<string, number>) => ({
    turns: 0, modelTurns: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, costUsd: 0,
    tokensReportedTurns: 0, costReportedTurns: 0, modelTurnsReportedTurns: 0,
    ...over,
  });

  const dashboard = {
    scope: 'self', canSeeEveryone: false, period: 'day',
    from: '2026-07-27T00:00:00.000Z', to: '2026-07-28T00:00:00.000Z',
    bucket: 'hour', filters: {},
    totals: totals({ turns: 41, totalTokens: 90_000, costUsd: 7.5, tokensReportedTurns: 41, costReportedTurns: 41 }),
    series: [], byProject: [], byAgent: [], byModel: [],
    effortByAgent: [], effortByModel: [], topTools: [], topToolsByAgent: [],
  };

  // Two tabs, forty-one requests between them. The first is the case the issue
  // is about: a morning's work in one tab, which used to be forty rows.
  const conversations = {
    total: 2,
    conversations: [
      {
        sessionId: 'tab-morning',
        name: 'Refactoring the parser',
        agents: ['claude', 'codex'],
        models: ['claude-opus-5', 'gpt-5'],
        projects: ['billing-api'],
        startedAt: '2026-07-27T09:00:00.000Z',
        lastActiveAt: '2026-07-27T12:30:00.000Z',
        totals: totals({ turns: 40, totalTokens: 88_000, costUsd: 7.25, tokensReportedTurns: 40, costReportedTurns: 40 }),
      },
      {
        // No name: this tab has been closed, and the entry survives it.
        sessionId: 'aa11bb22-cc33-dd44',
        name: null,
        agents: ['claude'],
        models: [],
        projects: [],
        startedAt: '2026-07-27T08:00:00.000Z',
        lastActiveAt: '2026-07-27T08:05:00.000Z',
        totals: totals({ turns: 1, totalTokens: 2000, costUsd: 0.25, tokensReportedTurns: 1, costReportedTurns: 1 }),
      },
    ],
  };

  const job = (id: string, turnId: string) => ({
    id, sessionId: 'tab-morning', nativeSessionId: null, turnId,
    userId: 1, userLogin: 'octocat', agent: 'claude', model: 'claude-opus-5',
    project: 'billing-api', projectSource: 'observed',
    startedAt: '2026-07-27T09:00:00.000Z', endedAt: '2026-07-27T09:01:00.000Z',
    durationMs: 60_000, outcome: 'completed', modelTurns: 2, toolCalls: 3,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 150, costUsd: 0.2,
    reportsUsage: true, reportsCost: true,
  });

  const asked: string[] = [];
  const realFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    asked.push(url);
    const body = url.includes('/api/usage/dashboard')
      ? dashboard
      : url.includes('/api/usage/conversations')
        ? conversations
        : url.includes('/api/usage/jobs')
          ? { total: 2, jobs: [job('tab-morning:t1', 't1'), job('tab-morning:t2', 't2')] }
          : { agents: [], models: [], projects: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;

  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1100px;height:900px;position:absolute;top:0;left:0;border:0';
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
  await wait(700);

  const text = (): string => (doc.body.textContent || '').replace(/\s+/g, ' ');

  check(
    'the history asks the server for conversations, not for every request',
    asked.some((url) => url.includes('/api/usage/conversations')),
    asked.join(' | ').slice(0, 300) || 'nothing was requested',
  );

  check(
    // Otherwise the headline covers a day and the list covers all time, and
    // the entries visibly fail to add up to the figure above them.
    'over the same range the figures above it were computed for',
    asked.some(
      (url) =>
        url.includes('/api/usage/conversations')
        && url.includes(`from=${encodeURIComponent(dashboard.from)}`)
        && url.includes(`to=${encodeURIComponent(dashboard.to)}`),
    ),
    asked.filter((u) => u.includes('/conversations')).join(' | ').slice(0, 300),
  );

  // Read the row, not the page: every figure on this screen is a run of digits
  // next to another one, and a regexp over the whole document would find "40"
  // inside the headline totals whether or not the row rendered at all.
  const entryRow = (): HTMLElement | undefined =>
    (Array.from(doc.querySelectorAll('tbody tr')) as HTMLElement[]).find((row) =>
      (row.textContent || '').includes('Refactoring the parser'),
    );
  const cells = (row: HTMLElement | undefined): string[] =>
    Array.from(row?.querySelectorAll('td') ?? []).map((cell) => (cell.textContent || '').trim());

  check(
    'a tab used forty times is one entry carrying all forty',
    cells(entryRow()).includes('40'),
    cells(entryRow()).join(' | ') || 'the conversation row did not render',
  );

  check(
    'and the entry says enough to recognise it — project, agent, when it ran',
    /billing-api/.test(text()) && /claude/.test(text()) && /2026|27\/0?7|0?7\/27/.test(text()),
    text().slice(0, 400),
  );

  check(
    'a conversation that used two agents is not shown as having used one',
    /claude\s*\+1/.test(text()),
    text().slice(0, 400),
  );

  check(
    'a conversation whose tab is gone still appears, named by what is left',
    /Conversation aa11bb22/.test(text()),
    text().slice(0, 400),
  );

  // The detail below the entry: open the first conversation and the requests
  // inside it must be what is asked for, narrowed to that conversation.
  const entry = entryRow();
  check('the conversation entry is a row that can be opened', Boolean(entry), 'no such row');
  entry?.click();
  await wait(400);

  check(
    'opening it asks for that conversation\'s own requests',
    asked.some((url) => url.includes('/api/usage/jobs') && url.includes('sessionId=tab-morning')),
    asked.filter((u) => u.includes('/jobs')).join(' | ').slice(0, 300) || 'no job request was made',
  );

  const backButton = Array.from(doc.querySelectorAll('button')).find(
    (b) => /all conversations/i.test(b.textContent || ''),
  );
  check(
    'and there is a way back to the list',
    Boolean(backButton),
    Array.from(doc.querySelectorAll('button')).map((b) => b.textContent).join(' | ').slice(0, 200),
  );

  root.unmount();
  frame.remove();
  window.fetch = realFetch;
}

async function checkAServerOlderThanThePageSaysSo(): Promise<void> {
  const totals = {
    turns: 1, modelTurns: 1, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 100, costUsd: 0.5,
    tokensReportedTurns: 1, costReportedTurns: 1,
  };
  // Exactly what 5.3.0 answered with: no `byProject`, no `bucket`, no `filters`.
  const oldShape = {
    scope: 'self', canSeeEveryone: false, period: 'day',
    from: '2026-07-27T00:00:00.000Z', to: '2026-07-28T00:00:00.000Z',
    totals,
    series: [{ key: '2026-07-27T09:00', totals }],
    byAgent: [{ key: 'claude', totals }],
    byModel: [{ key: 'claude-opus-5', totals }],
    effortByAgent: [], effortByModel: [], topTools: [], topToolsByAgent: [],
  };

  const realFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    const body = url.includes('/api/usage/dashboard') ? oldShape : { jobs: [], total: 0 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;

  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:900px;height:600px;position:absolute;top:0;left:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument as Document;
  doc.open();
  doc.write(
    '<!doctype html><html><head>'
    + '<link rel="stylesheet" href="/css/relay/relay.css">'
    + '<link rel="stylesheet" href="/css/main.css">'
    + '</head><body style="margin:0"></body></html>',
  );
  doc.close();
  await wait(150);

  let crashed: string | null = null;
  (frame.contentWindow as Window).addEventListener('error', (event) => {
    crashed = String((event as ErrorEvent).message || 'error');
  });

  const root = createRoot(doc.body);
  root.render(React.createElement(UsageDashboardDialog, { open: true, onClose: () => {} } as never));
  await wait(600);

  const text = (doc.body.textContent || '').replace(/\s+/g, ' ');
  check(
    'a response from an older server does not take the dialog down',
    crashed === null && text.length > 0,
    crashed ?? (text ? 'still rendering' : 'nothing on screen'),
  );
  check(
    'and says the server is behind the page, rather than showing empty figures',
    /older than this page/i.test(text) && /restart the server/i.test(text),
    text.slice(0, 240) || 'nothing on screen',
  );
  check(
    'and does not draw the missing breakdown as a project list with nothing in it',
    !/Nothing here yet/.test(text),
    text.slice(0, 240),
  );

  root.unmount();
  frame.remove();
  window.fetch = realFetch;
}

/**
 * Attributing work to a project by hand, from the job it belongs to.
 *
 * The claim is not "a form exists" — it is that pressing Save sends the right
 * assertion for the right job, and that the interface never offers to edit a
 * project that was actually observed. Both are invisible to a typecheck: an
 * edit control rendered for an observed job compiles perfectly and produces a
 * button whose only possible outcome is the server refusing it.
 */
async function checkUnattributedWorkCanBeAttributedByHand(): Promise<void> {
  const totals = (over: Record<string, number>) => ({
    turns: 0, modelTurns: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, costUsd: 0,
    tokensReportedTurns: 0, costReportedTurns: 0, modelTurnsReportedTurns: 0,
    ...over,
  });
  const one = totals({ turns: 1, totalTokens: 100, costUsd: 0.5, tokensReportedTurns: 1, costReportedTurns: 1 });

  const dashboard = {
    scope: 'self', canSeeEveryone: false, period: 'day',
    from: '2026-07-27T00:00:00.000Z', to: '2026-07-28T00:00:00.000Z',
    bucket: 'hour', filters: {},
    totals: one,
    series: [{ key: '2026-07-27T09:00', totals: one }],
    byProject: [
      { key: 'billing-api', totals: one },
      { key: '//unattributed', totals: one },
    ],
    byAgent: [{ key: 'claude', totals: one }],
    byModel: [{ key: 'claude-opus-5', totals: one }],
    effortByAgent: [], effortByModel: [], topTools: [], topToolsByAgent: [],
  };

  const jobFields = {
    sessionId: 'sess-1', nativeSessionId: null, turnId: 't1', userId: 7, userLogin: 'dnviti',
    agent: 'claude', model: 'claude-opus-5',
    startedAt: '2026-07-27T09:14:02.000Z', endedAt: '2026-07-27T09:14:41.000Z',
    durationMs: 39000, outcome: 'completed', modelTurns: 3, toolCalls: 5,
    inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: null, totalTokens: 100, costUsd: 0.5,
    reportsUsage: true, reportsCost: true,
  };
  const unattributed = { ...jobFields, id: 'sess-1:t1', project: null, projectSource: null };
  const observed = { ...jobFields, id: 'sess-2:t9', sessionId: 'sess-2', project: 'billing-api', projectSource: 'observed' };

  const posted: Array<{ url: string; body: unknown }> = [];
  let openId = 'sess-1:t1';
  const realFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    if ((init?.method || 'GET').toUpperCase() === 'POST') {
      posted.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ updated: 2, project: 'billing-api' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/usage/dashboard')) {
      return new Response(JSON.stringify(dashboard), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/api\/usage\/jobs\/[^?]/.test(url)) {
      const body = url.includes('sess-2') ? observed : unattributed;
      // The second job ran on two models, the way a delegating turn does. The
      // first carries no `models` key at all — which is also what a server
      // older than this page answers, and must not blank the dialog. (#75)
      const models = url.includes('sess-2')
        ? [
            { model: 'claude-opus-5', calls: 3, inputTokens: 800, outputTokens: 150, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.75 },
            { model: 'claude-haiku-4-5', calls: 1, inputTokens: 200, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.25 },
          ]
        : undefined;
      return new Response(
        JSON.stringify({ ...body, tools: [], ...(models ? { models } : {}) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ jobs: [openId === 'sess-2:t9' ? observed : unattributed], total: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof window.fetch;

  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1100px;height:900px;position:absolute;top:0;left:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument as Document;
  doc.open();
  doc.write(
    '<!doctype html><html><head>'
    + '<link rel="stylesheet" href="/css/relay/relay.css">'
    + '<link rel="stylesheet" href="/css/main.css">'
    + '</head><body style="margin:0"></body></html>',
  );
  doc.close();
  await wait(150);

  const root = createRoot(doc.body);
  root.render(React.createElement(UsageDashboardDialog, { open: true, onClose: () => {} } as never));
  await wait(600);

  const text = () => (doc.body.textContent || '').replace(/\s+/g, ' ');
  const byLabel = (label: string) =>
    Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent || '').trim() === label,
    );

  check(
    'the dashboard says where unattributed work can be fixed',
    /attribute it/i.test(text()),
    text().slice(0, 2000),
  );

  // The history opens on conversations now (#88), and a single job is a level
  // below that. Attribution is a per-request question, so this check takes the
  // Requests view — which is exactly the reason that view still exists.
  const requestsTab = Array.from(doc.querySelectorAll<HTMLElement>('[role="tab"], button')).find(
    (el) => (el.textContent || '').trim() === 'Requests',
  );
  check('the history offers the requests behind the conversations', Boolean(requestsTab), 'no Requests control');
  requestsTab?.click();
  await wait(400);

  // Open the unattributed job from the history — the last table on the page.
  // Not `tbody tr`, which is the first breakdown row four panels above it.
  const historyRow = (): HTMLElement | null => {
    const tables = Array.from(doc.querySelectorAll('table'));
    return (tables[tables.length - 1]?.querySelector('tbody tr') as HTMLElement | null) ?? null;
  };
  historyRow()?.click();
  await wait(400);
  check('a job opens from the history', /Job detail/i.test(text()), text().slice(0, 160));

  const attributeButton = byLabel('Attribute…');
  check(
    'an unattributed job offers to be attributed',
    Boolean(attributeButton),
    attributeButton ? 'found' : 'no attribute control',
  );
  attributeButton?.click();
  await wait(200);

  const field = doc.querySelector('input[aria-label="Project name"]') as HTMLInputElement | null;
  check('the form asks for a project name', Boolean(field), field ? 'found' : 'no input');

  const suggestions = Array.from(doc.querySelectorAll('datalist option')).map((o) => (o as HTMLOptionElement).value);
  check(
    'and suggests the projects already in use, so a name is not retyped by guess',
    suggestions.includes('billing-api') && !suggestions.some((v) => v.includes('unattributed')),
    suggestions.join(', ') || 'no suggestions',
  );

  const sessionBox = doc.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  check(
    'the whole conversation is the default, since that is the unit people fix',
    Boolean(sessionBox && sessionBox.checked),
    sessionBox ? `checked=${sessionBox.checked}` : 'no checkbox',
  );

  if (field) {
    const setter = Object.getOwnPropertyDescriptor(
      (frame.contentWindow as Window & typeof globalThis).HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(field, 'billing-api');
    field.dispatchEvent(new (frame.contentWindow as Window & typeof globalThis).Event('input', { bubbles: true }));
  }
  await wait(150);
  byLabel('Save')?.click();
  await wait(400);

  check(
    'saving sends the attribution for that job',
    posted.length === 1 && posted[0].url.includes('sess-1%3At1/project'),
    posted.map((p) => p.url).join(' | ') || 'nothing was sent',
  );
  check(
    'and sends the name and the whole-conversation choice with it',
    posted.length === 1
      && (posted[0].body as { project: string }).project === 'billing-api'
      && (posted[0].body as { applyToSession: boolean }).applyToSession === true,
    JSON.stringify(posted[0]?.body ?? null),
  );
  check(
    'and reports how much work it actually changed',
    /2 job\(s\) attributed/.test(text()),
    text().slice(0, 240),
  );

  // Now the other half of the claim: an observed project offers no edit at all.
  // A fresh mount rather than a re-render — re-rendering the same tree keeps
  // the open-job state, so the "second" job never actually opened and the
  // check passed by looking at the first one.
  root.unmount();
  await wait(100);
  openId = 'sess-2:t9';
  const second = createRoot(doc.body);
  second.render(React.createElement(UsageDashboardDialog, { open: true, onClose: () => {} } as never));
  await wait(600);
  // A fresh mount is back on the conversation list, so the requests view has to
  // be taken again — the state that was reset is exactly why this is a remount.
  Array.from(doc.querySelectorAll<HTMLElement>('[role="tab"], button'))
    .find((el) => (el.textContent || '').trim() === 'Requests')
    ?.click();
  await wait(400);
  historyRow()?.click();
  await wait(400);

  check(
    'the second job opened',
    /Job detail/i.test(text()) && /billing-api/.test(text()),
    text().slice(0, 200),
  );

  check(
    'a job that ran on two models shows both, with each one own spend (#75)',
    /claude-haiku-4-5/.test(text()) && /\$0\.7500/.test(text()) && /\$0\.2500/.test(text()),
    text().slice(0, 400),
  );

  check(
    'a project that was observed offers no way to overwrite it',
    !byLabel('Attribute…') && !byLabel('Change'),
    byLabel('Change') || byLabel('Attribute…')
      ? 'an edit control was offered for a measured value'
      : 'no edit offered',
  );

  second.unmount();
  frame.remove();
  window.fetch = realFetch;
}

/**
 * Issue #71 — the `/` menu is complete before a word has been typed.
 *
 * A layout engine is needed for this and a props assertion is not: the claim is
 * that a person opening a brand-new conversation can *see* their skills, both
 * by typing a slash and by pressing the control that says it offers commands
 * and skills. Every part of that — that the popup renders at all with no
 * messages behind it, that it carries the descriptions, that the button opens
 * the same list — is a rendered fact.
 */
async function checkTheCommandMenuIsFullBeforeTheFirstMessage(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:600px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const controller = new ChatController('browser-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'browser-check',
    snapshot: {
      sessionId: 'browser-check',
      runtime: 'claude',
      state: 'idle',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: false, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: false,
        commands: [
          { name: 'clear', description: 'Start a new conversation, forgetting everything above' },
          { name: 'complex-work', description: 'Orchestrate a complex, multi-phase engineering task' },
          { name: 'figma:figma-use', description: 'Write a design into Figma' },
          { name: 'undocumented-skill' },
        ],
      },
      // The whole point: nothing has been sent yet.
      messages: [],
      pendingPermissions: [],
      queued: [],
      firstSeq: 1,
      replayFrom: 1,
      cursor: 1,
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
  await wait(250);

  const menu = (): HTMLElement | null =>
    host.querySelector('[role="listbox"][aria-label="Slash commands"]');

  const textarea = host.querySelector('textarea') as HTMLTextAreaElement | null;
  check('the composer is on screen in a conversation with no messages', Boolean(textarea));
  if (!textarea) {
    root.unmount();
    host.remove();
    return;
  }

  const type = (value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  textarea.focus();
  type('/');
  await wait(200);

  const typed = menu();
  const typedText = typed?.textContent ?? '';
  check('typing a slash opens the menu before any message has been sent', Boolean(typed));
  check(
    'and it lists the skills installed for this session, not just the built-ins',
    typedText.includes('complex-work') && typedText.includes('figma:figma-use'),
    typedText.slice(0, 200) || 'nothing listed',
  );
  check(
    'each entry carries the description its author wrote',
    typedText.includes('Orchestrate a complex, multi-phase engineering task'),
    typedText.slice(0, 240),
  );
  check(
    'and an entry with no description is shown plainly, with no invented one',
    typedText.includes('undocumented-skill') && !/no description/i.test(typedText),
    typedText.slice(0, 240),
  );

  // Narrowing has to reach the skills too — a menu that filters only the
  // built-ins would look right until the first keystroke after the slash.
  type('/comp');
  await wait(200);
  const narrowedText = menu()?.textContent ?? '';
  check(
    'typing narrows to the matching skill',
    narrowedText.includes('complex-work') && !narrowedText.includes('figma:figma-use'),
    narrowedText.slice(0, 200) || 'nothing listed',
  );

  type('');
  await wait(150);
  check('clearing the line closes the menu', !menu());

  const button = host.querySelector('[aria-label="Slash commands and skills"]') as HTMLElement | null;
  check('the composer offers a control for commands and skills', Boolean(button));
  button?.click();
  await wait(200);
  const openedText = menu()?.textContent ?? '';
  check(
    'and pressing it shows the same list, with no message sent first',
    openedText.includes('complex-work') && openedText.includes('clear'),
    openedText.slice(0, 200) || 'nothing listed',
  );

  // Picking an entry has to put the command in the line, which is what makes
  // it behave exactly as typing its name does.
  const rows = Array.from(host.querySelectorAll('[role="listbox"][aria-label="Slash commands"] [role="option"]'));
  const pick = rows.find((row) => (row.textContent ?? '').includes('complex-work')) as HTMLElement | undefined;
  pick?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await wait(200);
  check(
    'choosing an entry puts that command in the line, ready to run',
    textarea.value.trim().startsWith('/complex-work'),
    JSON.stringify(textarea.value),
  );

  root.unmount();
  host.remove();
}

/**
 * Issue #77: the file editor, read the way a person reads it.
 *
 * Every check this app had around this editor confirmed that its *parts* were
 * built — that the host element exists, that the fallback textarea carries the
 * right label, that a read-only file arrives read-only. All of them passed
 * while the editor on screen drew files in an order they are not in, with a
 * bare textarea over the first line, because none of them ever looked at a
 * rendered editor. They could not: the checks used to run from a `file://`
 * page, where the chunk this fetches by absolute path can never arrive.
 *
 * So this one loads the real chunk over HTTP, opens a real file in it, and
 * compares what is on the screen against the file.
 */
async function checkTheFileEditorShowsTheFile(): Promise<void> {
  const lines = Array.from({ length: 200 }, (_, i) => `line-${i + 1} const value${i + 1} = ${i + 1};`);
  const text = lines.join('\n');

  const host = document.createElement('div');
  // Stacked above whatever earlier checks left on the page — the terminal from
  // the first check is still mounted at the same corner, and "is anything drawn
  // over the first line" is a question about *this* editor.
  host.style.cssText = 'width:900px;height:500px;position:absolute;top:0;left:0;z-index:9999';
  document.body.appendChild(host);

  const root = createRoot(host);
  root.render(
    React.createElement(MonacoEditor, {
      value: text,
      path: '/tmp/browser-check/sample.ts',
      language: 'ts',
      ariaLabel: 'Contents of sample.ts',
    } as never),
  );

  // The chunk is several megabytes and is fetched, parsed and started here, so
  // this waits for the editor rather than for a fixed delay.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await wait(100);
    ready = host.querySelector('[data-monaco-host="ready"]') !== null;
  }
  check('the real code editor loads and attaches', ready, host.innerHTML.slice(0, 120));
  if (!ready) {
    root.unmount();
    host.remove();
    return;
  }

  /** The rendered lines, top to bottom — which is the order a reader gets. */
  const onScreen = (): { text: string; top: number }[] =>
    Array.from(host.querySelectorAll('.view-line'))
      .map((node) => ({
        text: (node.textContent ?? '').replace(/ /g, ' ').trimEnd(),
        top: node.getBoundingClientRect().top,
      }))
      .sort((a, b) => a.top - b.top);

  const rendered = onScreen();
  check('it renders the file, not an empty frame', rendered.length > 5, `${rendered.length} lines`);

  // The heart of the report. Every rendered line must be the line the file has
  // at that position — so a window that is complete but shuffled fails here.
  const firstShown = lines.indexOf(rendered[0]?.text ?? '');
  const inFileOrder =
    firstShown !== -1 && rendered.every((line, i) => line.text === lines[firstShown + i]);
  check(
    'the file is shown in the file’s own order',
    inFileOrder,
    inFileOrder ? `from line ${firstShown + 1}` : rendered.slice(0, 8).map((l) => l.text.split(' ')[0]).join(','),
  );

  const numbers = Array.from(host.querySelectorAll('.line-numbers'))
    .map((node) => ({ text: (node.textContent ?? '').trim(), top: node.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top)
    .map((entry) => entry.text);
  check(
    'the line numbers say what the lines beside them are',
    numbers.length > 0 && numbers.every((n, i) => Number(n) === firstShown + i + 1),
    numbers.slice(0, 6).join(','),
  );

  // The stylesheet, asked of the layout engine rather than of the network: this
  // one rule is what positions every line, and losing it is what produced both
  // halves of the report at once.
  const firstLine = host.querySelector('.view-line') as HTMLElement | null;
  check(
    'the editor’s own stylesheet is in effect',
    firstLine !== null && getComputedStyle(firstLine).position === 'absolute',
    firstLine ? getComputedStyle(firstLine).position : 'no line',
  );

  // The stray box: Monaco's hidden input area, drawn as an ordinary resizable
  // textarea whenever those rules are missing.
  const boxes = Array.from(host.querySelectorAll('textarea')).filter(
    (node) => getComputedStyle(node).resize !== 'none',
  );
  check('nothing in the editor is a resizable box', boxes.length === 0, `${boxes.length} found`);

  const lineBox = firstLine?.getBoundingClientRect();
  const covering = lineBox
    ? (document.elementFromPoint(lineBox.left + 4, lineBox.top + lineBox.height / 2) as HTMLElement | null)
    : null;
  check(
    'nothing is drawn over the first line',
    covering !== null && host.contains(covering) && covering.closest('.view-lines') !== null,
    covering ? `${covering.tagName}.${String(covering.className).slice(0, 40)}` : 'nothing at that point',
  );

  // Scrolled, because that is where the fault showed itself worst: Monaco
  // reuses its line elements, so with the positioning rules missing the order
  // on screen becomes the order they happen to sit in — which looks fine at
  // first paint and comes apart the moment you move.
  // Scrolled, because that is where the fault showed itself worst: Monaco
  // reuses its line elements, so with the positioning rules missing the order
  // on screen becomes the order they happen to sit in — which looks right at
  // first paint and comes apart the moment the view moves.
  //
  // What is asserted is the invariant, not the movement: this page runs on
  // virtual time with no compositor, so whether a synthetic wheel actually
  // carries the viewport anywhere is up to the engine and not worth a flaky
  // check. Whatever is on screen must be a contiguous run of the file in the
  // file's order, at rest and after the view is pushed around — which is
  // exactly what the report showed it was not.
  const scrollable = host.querySelector('.monaco-scrollable-element') as HTMLElement | null;
  const wheel = (delta: number): void => {
    scrollable?.dispatchEvent(
      new WheelEvent('wheel', { deltaY: delta, deltaMode: 0, bubbles: true, cancelable: true }),
    );
  };
  const stillInOrder = (label: string): void => {
    const shown = onScreen();
    const from = lines.indexOf(shown[0]?.text ?? '');
    check(
      label,
      from !== -1 && shown.every((line, i) => line.text === lines[from + i]),
      `from line ${from + 1}: ${shown.slice(0, 6).map((l) => l.text.split(' ')[0]).join(',')}`,
    );
  };

  for (let i = 0; i < 8; i++) wheel(240);
  await wait(600);
  stillInOrder('what is on screen after scrolling down is the file, in order');

  for (let i = 0; i < 12; i++) wheel(-240);
  await wait(600);
  stillInOrder('and after scrolling back it is still the file, in order');

  // The light theme, since the fault was reported as visible in one theme: the
  // editor is rebuilt from the live palette on a theme change, and a rendering
  // that only survives in the dark is not a fix.
  document.documentElement.classList.add('light');
  await wait(400);
  const light = onScreen();
  const lightFirst = lines.indexOf(light[0]?.text ?? '');
  check(
    'and it is still the file, in order, in the light theme',
    lightFirst !== -1 && light.every((line, i) => line.text === lines[lightFirst + i]),
    light.slice(0, 4).map((l) => l.text.split(' ')[0]).join(','),
  );
  document.documentElement.classList.remove('light');
  await wait(200);

  // The guard that keeps this from coming back silently. Removing the
  // stylesheet is exactly the state a failed fetch leaves the page in, and the
  // loader has to be able to tell — otherwise it hands over an editor that
  // renders a file in an order it is not in, which is the failure that made
  // this a bug report rather than a nuisance.
  const sheet = document.querySelector('link[href="/monaco.bundle.css"]');
  check('the editor’s stylesheet is loaded by its own loader', sheet !== null);
  if (sheet) {
    check('and while it is there, the loader says the rules are in effect', monacoStylesApplied());
    document.head.removeChild(sheet);
    await wait(100);
    check(
      'with it gone, the loader notices instead of rendering anyway',
      !monacoStylesApplied(),
      'this is what a failed stylesheet fetch leaves behind',
    );
    document.head.appendChild(sheet);
    await wait(100);
  }

  root.unmount();
  host.remove();
}

/**
 * A file opened read-only cannot be typed into — asked of the editor that is
 * actually on screen, not of the fallback.
 */
async function checkAReadOnlyFileStaysReadOnly(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:700px;height:300px;position:absolute;top:0;left:0';
  document.body.appendChild(host);

  let changes = 0;
  const root = createRoot(host);
  root.render(
    React.createElement(MonacoEditor, {
      value: 'const readOnly = true;\nconst second = 2;\n',
      path: '/tmp/browser-check/locked.ts',
      language: 'ts',
      readOnly: true,
      onChange: () => { changes += 1; },
      ariaLabel: 'Contents of locked.ts',
    } as never),
  );

  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await wait(100);
    ready = host.querySelector('[data-monaco-host="ready"]') !== null;
  }
  check('the read-only file opens in the real editor too', ready);
  if (!ready) {
    root.unmount();
    host.remove();
    return;
  }

  // The host reports ready as soon as the editor is created; the first lines
  // land a frame or two later — and by this point in the suite the page is
  // frugal with frames, so the editor is nudged into laying itself out rather
  // than waited on indefinitely. `automaticLayout` watches the host's size.
  //
  // A frame is awaited as well as a timer, and that is the part that matters:
  // Monaco draws its lines from `requestAnimationFrame`, and under the headless
  // harness's virtual clock a timer can come back without one ever having run —
  // which made this check pass or fail on the timing of the suite ahead of it
  // rather than on anything about the editor.
  for (let i = 0; i < 40 && host.querySelector('.view-line') === null; i++) {
    host.style.width = `${700 + (i % 2)}px`;
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await wait(100);
  }

  const input = host.querySelector('textarea') as HTMLTextAreaElement | null;
  check('a read-only file cannot be typed into', input !== null && input.readOnly, String(input?.readOnly));
  check('and nothing reported a change', changes === 0, `${changes} changes`);

  const shown = Array.from(host.querySelectorAll('.view-line'))
    .map((node) => (node.textContent ?? '').replace(/ /g, ' ').trimEnd());
  check(
    'the read-only view shows the file as it is',
    shown[0] === 'const readOnly = true;' && shown[1] === 'const second = 2;',
    shown.length ? shown.join(' / ') : `no lines; editor=${Boolean(host.querySelector('.monaco-editor'))} html=${host.innerHTML.slice(0, 200)}`,
  );

  root.unmount();
  host.remove();
}

/**
 * Starting a new conversation is a control, not a piece of folklore (#69).
 *
 * The check is about the healthy case on purpose. There has always been a
 * "Start a new chat" button, but only inside the recovery notice — so the one
 * state it could not be pressed in was the ordinary one, and the only way to
 * ask while things were working was to know that `/clear` existed and type it.
 * Rendered rather than asserted on props: what matters is that it is on screen
 * over a live conversation and that pressing it sends the same command.
 */
async function checkANewConversationCanBeStartedFromTheComposer(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:600px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const sent: Array<Record<string, unknown>> = [];
  const controller = new ChatController('browser-check', {
    send: (message: Record<string, unknown>) => {
      sent.push(message);
    },
  } as never);

  const snapshot = (state: string): Record<string, unknown> => ({
    type: 'chat_snapshot',
    sessionId: 'browser-check',
    snapshot: {
      sessionId: 'browser-check',
      runtime: 'claude',
      state,
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: false, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: false, commands: [{ name: 'clear' }],
      },
      messages: [
        {
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: 1,
          blocks: [{ kind: 'text', text: 'that is the parser sorted, thanks' }],
        },
        {
          id: 'a1', seq: 2, turnId: 't1', role: 'assistant', ts: 2,
          blocks: [{ kind: 'text', text: 'glad it helped.' }],
        },
      ],
      pendingPermissions: [],
      queued: [],
      firstSeq: 1,
      replayFrom: 1,
      cursor: 2,
      live: true,
      bypassPermissions: false,
    },
  });

  controller.handle(snapshot('idle') as never);

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
  await wait(250);

  const find = (): HTMLButtonElement | null =>
    host.querySelector('button[aria-label^="Start a new conversation"]');

  const button = find();
  check('the composer offers a way to start a new conversation', Boolean(button));
  if (!button) {
    root.unmount();
    host.remove();
    return;
  }

  check(
    'it says what it does before it is pressed',
    (button.getAttribute('title') || '').toLowerCase().includes('new conversation'),
    button.getAttribute('title') || 'no title',
  );
  check(
    'and it is a button, so the keyboard alone can reach and press it',
    button.tagName === 'BUTTON' && !button.disabled && button.tabIndex >= 0,
    `${button.tagName} disabled=${button.disabled} tabIndex=${button.tabIndex}`,
  );
  check(
    'it is offered while the conversation is healthy, not only once it has failed',
    !host.querySelector('[role="alert"]') && Boolean(find()),
  );

  button.click();
  await wait(150);
  const chatSends = sent.filter((message) => message.type === 'chat_send');
  check(
    'pressing it asks for exactly what typing the command asks for',
    chatSends.length === 1 && chatSends[0].text === '/clear',
    JSON.stringify(chatSends),
  );

  // What the server sends back for a clear: a line under the conversation,
  // then a process starting and going idle. The tab has to come out of that
  // sequence empty and ready — not read-only, and with nothing offering to
  // recover a session that is running.
  for (const event of [
    { t: 'marker', kind: 'cleared', seq: 3, ts: 3 },
    { t: 'state', state: 'starting', seq: 4, ts: 4 },
    { t: 'state', state: 'idle', seq: 5, ts: 5 },
  ]) {
    controller.handle({ type: 'chat_event', sessionId: 'browser-check', event } as never);
  }
  await wait(250);

  const surface = host.textContent ?? '';
  check(
    'after clearing, the window holds none of the conversation it left',
    !surface.includes('that is the parser sorted'),
    surface.slice(0, 200),
  );
  check(
    'and nothing says it ended, is read-only, or offers to recover it',
    !host.querySelector('[role="alert"]') && !/read-only|no longer running|has exited/i.test(surface),
    surface.slice(0, 240),
  );
  const composer = host.querySelector('textarea') as HTMLTextAreaElement | null;
  check(
    'a message can be typed straight away',
    Boolean(composer) && composer?.disabled === false,
    composer ? `disabled=${composer.disabled}` : 'no composer',
  );

  // Mid-answer too: the process the turn is running in is the one being
  // replaced, so there is nothing to wait for.
  controller.handle(snapshot('thinking') as never);
  await wait(200);
  const busyButton = find();
  check(
    'and it stays pressable while the agent is still answering',
    Boolean(busyButton) && busyButton?.disabled === false,
    busyButton ? `disabled=${busyButton.disabled}` : 'gone while busy',
  );

  root.unmount();
  host.remove();
}

/**
 * A turn's badge says how the turn ended, and says the same thing everywhere.
 *
 * Here rather than in a unit test because the claim is about two surfaces
 * agreeing on screen: `groupTurns` is one function, but the rail on the left
 * and the turn's own header are separate components reading it separately, and
 * "the list disagrees with the header" is a defect that only exists rendered.
 *
 * The turn strip only draws its badge while the turn is folded — the open one
 * has its body to speak for it — so the turns under test are past ones, with a
 * fourth left open to fold them (issue #74).
 */
async function checkATurnsBadgeSaysHowItEnded(): Promise<void> {
  const host = document.createElement('div');
  // Wide enough for the turn index to be a rail rather than a sheet.
  host.style.cssText = 'width:1600px;height:900px;position:absolute;top:0;left:0;display:flex;z-index:9999';
  document.body.appendChild(host);

  const at = Date.now();
  const controller = new ChatController('badge-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'badge-check',
    snapshot: {
      sessionId: 'badge-check',
      runtime: 'claude',
      state: 'idle',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: false, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: false,
      },
      messages: [
        // The turn the issue is about: long, several steps went wrong, and it
        // finished and answered.
        {
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: at,
          blocks: [{ kind: 'text', text: 'alpha' }], turnOutcome: 'done',
        },
        {
          id: 'a1', seq: 2, turnId: 't1', role: 'assistant', ts: at,
          blocks: [
            { kind: 'tool', toolId: 'x1', name: 'grep', toolKind: 'search', status: 'failed', error: 'no matches' },
            { kind: 'tool', toolId: 'x2', name: 'bash', toolKind: 'execute', status: 'failed', error: 'exit 1' },
            { kind: 'error', text: 'could not read notes.txt' },
            { kind: 'tool', toolId: 'x3', name: 'bash', toolKind: 'execute', status: 'completed' },
            { kind: 'text', text: 'all green now' },
          ],
          turnOutcome: 'done',
        },
        // One that really did fail: the runtime ended it as an error.
        {
          id: 'u2', seq: 3, turnId: 't2', role: 'user', ts: at,
          blocks: [{ kind: 'text', text: 'beta' }], turnOutcome: 'failed',
        },
        {
          id: 'a2', seq: 4, turnId: 't2', role: 'assistant', ts: at,
          blocks: [{ kind: 'error', text: 'rate limited', fatal: true }], turnOutcome: 'failed',
        },
        // An ordinary one, so the check is reading three different answers.
        {
          id: 'u3', seq: 5, turnId: 't3', role: 'user', ts: at,
          blocks: [{ kind: 'text', text: 'gamma' }], turnOutcome: 'done',
        },
        {
          id: 'a3', seq: 6, turnId: 't3', role: 'assistant', ts: at,
          blocks: [{ kind: 'text', text: 'here you are' }], turnOutcome: 'done',
        },
        // Left open, which is what folds the three above it.
        {
          id: 'u4', seq: 7, turnId: 't4', role: 'user', ts: at,
          blocks: [{ kind: 'text', text: 'delta' }],
        },
      ],
      pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1, cursor: 7,
      live: true, bypassPermissions: false,
    },
  } as never);

  const root = createRoot(host);
  root.render(
    React.createElement(ChatView, {
      controller,
      runtime: 'claude',
      runtimeLabel: 'Claude Code',
      workingDir: '/work',
      view: { ...DEFAULT_CHAT_VIEW, terminalOpen: false },
      onViewChange: () => {},
    } as never),
  );
  await wait(400);

  const rows = Array.from(host.querySelectorAll('nav[aria-label="Turns"] [role="option"]')) as HTMLElement[];
  const strips = Array.from(host.querySelectorAll('[data-turn-id]')) as HTMLElement[];

  check(
    'the turn index lists every turn',
    rows.length === 4 && strips.length === 4,
    `rows=${rows.length} strips=${strips.length}`,
  );
  if (rows.length !== 4 || strips.length !== 4) {
    root.unmount();
    host.remove();
    return;
  }

  // The word behind the glyph — the last child of the row, and what anything
  // that cannot see a colour reads.
  const wordOf = (row: HTMLElement): string => (row.lastElementChild?.textContent ?? '').trim();
  // The badge itself, which is a coloured icon and nothing else. Read as a
  // computed colour so the two surfaces are compared on what is drawn rather
  // than on which component drew it.
  const colourOf = (element: HTMLElement): string => {
    // The strip carries a fold/unfold control of its own, and its icon comes
    // first in the DOM — so the badge is the icon that is *not* a control. The
    // rail's whole row is one button, where the badge is the only icon at all.
    const icons = Array.from(element.querySelectorAll('.ricon'));
    const icon = icons.find((node) => !node.closest('button')) ?? icons[0];
    const span = icon?.parentElement as HTMLElement | null;
    return span ? getComputedStyle(span).color : '';
  };

  check(
    'a long turn with failed steps in it still reads as done',
    wordOf(rows[0]) === 'done',
    `${wordOf(rows[0])} for a turn holding 2 failed steps and an error it moved past`,
  );
  check(
    'a turn the runtime ended as an error reads as failed',
    wordOf(rows[1]) === 'failed',
    wordOf(rows[1]),
  );
  check('an ordinary turn reads as done', wordOf(rows[2]) === 'done', wordOf(rows[2]));

  const failedColour = colourOf(rows[1]);
  const doneColour = colourOf(rows[0]);
  check(
    'failed and done are drawn in different colours',
    Boolean(failedColour) && Boolean(doneColour) && failedColour !== doneColour,
    `done=${doneColour} failed=${failedColour}`,
  );

  for (const index of [0, 1, 2]) {
    const rail = colourOf(rows[index]);
    const strip = colourOf(strips[index]);
    check(
      `the list and the turn's own header agree about turn ${index + 1}`,
      Boolean(strip) && strip === rail,
      `rail=${rail} strip=${strip}`,
    );
  }

  // And the steps that failed are still failed where the step is shown: this
  // was never about hiding them, only about not promoting them to a verdict.
  // Opening the turn is what a reader does to find out why, so that is what
  // this does.
  const expand = host.querySelector('[aria-label="Expand turn 1"]') as HTMLElement | null;
  expand?.click();
  await wait(300);
  // Read from the word rather than the colour: the timeline states a step's
  // outcome for anything that cannot see one, which is the same reason the
  // turn's own badge carries a word.
  const activity = host.querySelector('[aria-label="Activity"]');
  const said = Array.from(activity?.querySelectorAll('span') ?? [])
    .map((node) => (node.textContent ?? '').trim())
    .filter(Boolean);
  check(
    'a failed step inside a done turn is still marked failed where it happened',
    said.filter((word) => word === 'Failed').length >= 2,
    `${said.filter((word) => word === 'Failed').length} steps said Failed`,
  );

  root.unmount();
  host.remove();
}

/**
 * A message waiting in line can be sent now, and the record says why.
 *
 * On screen rather than in a unit test because every claim is about what the
 * two controls on a queued row are to a person using them: that there are two
 * of them and they are told apart by their labels, that a finger can hit both
 * on a phone, that pressing one twice presses it once, and that the control is
 * absent exactly when it would do nothing. A props assertion would pass for a
 * pair of buttons drawn on top of each other with the same name.
 */
async function checkAWaitingMessageCanBeSentNow(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:700px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const outbound: Array<Record<string, unknown>> = [];
  const controller = new ChatController('queue-check', {
    send: (message: unknown) => { outbound.push(message as Record<string, unknown>); },
  });
  const snapshot = (state: string, live = true, interrupt = true): void => {
    controller.handle({
      type: 'chat_snapshot',
      sessionId: 'queue-check',
      snapshot: {
        sessionId: 'queue-check',
        runtime: 'claude',
        state,
        capabilities: {
          streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
          interrupt, resume: true, fork: false, attachments: true, usage: true,
          cost: true, plan: false, commands: [],
        },
        messages: [{
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: 1,
          blocks: [{ kind: 'text', text: 'refactor the auth module' }],
        }],
        pendingPermissions: [],
        queued: [
          { id: 'q1', text: 'and then update the docs', ts: 1 },
          { id: 'q2', text: 'stop — you are editing the wrong file', ts: 2 },
        ],
        firstSeq: 1, replayFrom: 1, cursor: 1, live, bypassPermissions: false,
      },
    } as never);
  };

  const root = createRoot(host);
  const paint = async (state: string, phone = false, interrupt = true): Promise<void> => {
    snapshot(state, true, interrupt);
    const view = React.createElement(ChatView, {
      controller,
      runtime: 'claude',
      runtimeLabel: 'Claude Code',
      workingDir: '/tmp/project',
      view: { ...DEFAULT_CHAT_VIEW, panelOpen: false },
      onViewChange: () => {},
      ...(phone ? { isMobile: true } : {}),
    } as never);
    root.render(phone ? React.createElement(PhoneContext.Provider, { value: true }, view) : view);
    await wait(250);
  };

  const button = (label: RegExp): HTMLButtonElement | undefined =>
    Array.from(host.querySelectorAll('button')).find((node) =>
      label.test(node.getAttribute('aria-label') ?? '')) as HTMLButtonElement | undefined;

  await paint('thinking');

  // Two waiting messages collapse to the newest one (#79), so opening the list
  // is what puts both of them on screen. Every claim below is about the newest
  // row, which is the one on show either way.
  const disclosure = button(/waiting message/);
  disclosure?.click();
  await wait(200);
  const rows = host.querySelectorAll('[role="list"][aria-label="Messages waiting to be sent"] [role="listitem"]');
  check('both waiting messages are on screen while the agent works', rows.length === 2, `${rows.length} rows`);

  const sendNow = button(/^Send queued message 2 now/);
  const remove = button(/^Remove queued message 2$/);
  check('a waiting message offers a control to send it now', Boolean(sendNow));
  check('alongside the one that removes it', Boolean(remove));
  check(
    'and the two are told apart by their labels, not only by their glyphs',
    Boolean(sendNow && remove) && sendNow!.getAttribute('aria-label') !== remove!.getAttribute('aria-label'),
    `${sendNow?.getAttribute('aria-label')} / ${remove?.getAttribute('aria-label')}`,
  );
  check(
    'the control is a button, so the keyboard alone can reach and press it',
    Boolean(sendNow) && sendNow!.tagName === 'BUTTON' && !sendNow!.disabled
      && sendNow!.tabIndex >= 0,
    `${sendNow?.tagName} tabIndex=${sendNow?.tabIndex}`,
  );

  sendNow?.click();
  await wait(150);
  sendNow?.click();
  await wait(150);
  const promotions = outbound.filter((m) => m.type === 'chat_queue_send_now');
  check(
    'pressing it asks the server for that message, by id',
    promotions.length >= 1 && promotions[0].queuedId === 'q2',
    JSON.stringify(promotions[0] ?? null),
  );
  check(
    'and pressing it twice in quick succession sends it once',
    promotions.length === 1,
    `${promotions.length} requests`,
  );

  // Nothing to cut in front of: the line is already moving.
  await paint('idle');
  check(
    'an idle agent is not offered a control that would change nothing',
    !button(/^Send queued message 1 now/),
  );
  check('while the control that withdraws a message stays', Boolean(button(/^Remove queued message 1$/)));

  // Waiting on a person is still a turn in flight — and the one a correction
  // most often needs to get in front of.
  await paint('awaiting_permission');
  check(
    'a turn waiting on an approval can still be interrupted by a waiting message',
    Boolean(button(/^Send queued message 1 now/)),
  );

  // A runtime that cannot be stopped cannot be cut in front of, and the server
  // refuses — so the row must not offer it.
  await paint('thinking', false, false);
  check(
    'a runtime that cannot be interrupted is not offered the control',
    !button(/^Send queued message 1 now/),
  );
  check(
    'though its queue can still be edited',
    Boolean(button(/^Remove queued message 1$/)),
  );

  // A phone remount starts collapsed again, so the row on show is the newest.
  await paint('thinking', true);
  const phoneSendNow = button(/^Send queued message 2 now/);
  const phoneRemove = button(/^Remove queued message 2$/);
  const size = phoneSendNow ? laidOutSize(phoneSendNow) : { width: 0, height: 0 };
  check(
    'on a phone the new control is big enough to hit',
    size.width >= 44 && size.height >= 44,
    `${size.width}x${size.height}`,
  );
  if (phoneSendNow && phoneRemove) {
    const a = phoneSendNow.getBoundingClientRect();
    const b = phoneRemove.getBoundingClientRect();
    // The clear space between the two, whichever order they are drawn in — not
    // the distance between two arbitrary edges, which is large for any pair and
    // would pass for two buttons directly on top of each other.
    const gap = Math.max(b.left - a.right, a.left - b.right);
    check(
      'and far enough from the one that throws the message away',
      gap >= PHONE_GAP,
      `gap ${Math.round(gap)}px`,
    );
  }

  // The record of what happened, drawn in the conversation.
  await paint('thinking');
  controller.handle({
    type: 'chat_event',
    sessionId: 'queue-check',
    event: { t: 'marker', seq: 2, ts: 2, kind: 'interrupted', detail: '“stop — you are editing the wrong file”' },
  } as never);
  await wait(250);
  const rule = Array.from(host.querySelectorAll('[role="separator"]')).find((node) =>
    (node.getAttribute('aria-label') ?? '').includes('Interrupted'));
  check('the conversation says the turn was cut short', Boolean(rule));
  check(
    'and which message did it',
    (rule?.getAttribute('aria-label') ?? '').includes('editing the wrong file'),
    JSON.stringify(rule?.getAttribute('aria-label') ?? null),
  );

  root.unmount();
  host.remove();
}

/**
 * A long queue takes one row, and opens.
 *
 * Every claim here is a measurement of the laid-out composer, which is the only
 * place they can be made: that twenty collapsed rows are no taller than one,
 * that the opened list scrolls inside its own space instead of pushing the
 * composer off a phone, and that the conversation is still visible behind it. A
 * unit test on the component's props would pass for a list rendered at four
 * thousand pixels tall.
 */
async function checkALongQueueCollapsesToOneRow(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const outbound: Array<Record<string, unknown>> = [];
  const controller = new ChatController('queue-size-check', {
    send: (message: unknown) => { outbound.push(message as Record<string, unknown>); },
  });
  const turn = (n: number): Record<string, unknown> => ({
    id: `q${n}`, text: `waiting message number ${n}, long enough to fill the row it is drawn in`, ts: n,
  });
  const snapshot = (count: number): void => {
    controller.handle({
      type: 'chat_snapshot',
      sessionId: 'queue-size-check',
      snapshot: {
        sessionId: 'queue-size-check',
        runtime: 'claude',
        state: 'thinking',
        capabilities: {
          streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
          interrupt: true, resume: true, fork: false, attachments: true, usage: true,
          cost: true, plan: false, commands: [],
        },
        messages: [{
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: 1,
          blocks: [{ kind: 'text', text: 'work through the list' }],
        }],
        pendingPermissions: [],
        queued: Array.from({ length: count }, (_, i) => turn(i + 1)),
        firstSeq: 1, replayFrom: 1, cursor: 1, live: true, bypassPermissions: false,
      },
    } as never);
  };

  const root = createRoot(host);
  const paint = async (count: number, phone: boolean): Promise<void> => {
    snapshot(count);
    const view = React.createElement(ChatView, {
      controller,
      runtime: 'claude',
      runtimeLabel: 'Claude Code',
      workingDir: '/tmp/project',
      view: { ...DEFAULT_CHAT_VIEW, panelOpen: false },
      onViewChange: () => {},
      ...(phone ? { isMobile: true } : {}),
    } as never);
    root.render(phone ? React.createElement(PhoneContext.Provider, { value: true }, view) : view);
    await wait(250);
  };
  // A count only: the queue arriving on its own, without a re-render of the
  // whole view, is what must not disturb an open or a closed list.
  const enqueue = async (count: number): Promise<void> => {
    snapshot(count);
    await wait(200);
  };

  const list = (): HTMLElement | null =>
    host.querySelector('[role="list"][aria-label="Messages waiting to be sent"]');
  const rowCount = (): number => list()?.querySelectorAll('[role="listitem"]').length ?? 0;
  const toggle = (): HTMLButtonElement | undefined =>
    Array.from(host.querySelectorAll('button')).find((node) =>
      /waiting message/.test(node.getAttribute('aria-label') ?? '')) as HTMLButtonElement | undefined;
  const status = (): string =>
    Array.from(host.querySelectorAll('[role="status"]'))
      .map((node) => node.textContent ?? '')
      .find((text) => text.includes('waiting to be sent')) ?? '';

  host.style.cssText = 'width:900px;height:700px;position:absolute;top:0;left:0;display:flex';

  // One message is left exactly as it was: no count, no control to press.
  await paint(1, false);
  const oneRow = list()?.getBoundingClientRect().height ?? 0;
  check('a single waiting message is drawn as it always was', rowCount() === 1, `${rowCount()} rows`);
  check('with nothing to open, because there is nothing behind it', !toggle());

  await paint(20, false);
  check('twenty waiting messages collapse to one row', rowCount() === 1, `${rowCount()} rows`);
  const twentyRows = list()?.getBoundingClientRect().height ?? 0;
  check(
    'and take no more room than a single message does',
    twentyRows <= oneRow + 1,
    `${Math.round(twentyRows)}px vs ${Math.round(oneRow)}px`,
  );
  check(
    'the row on show is the one just typed, not the one about to be sent',
    (list()?.textContent ?? '').includes('number 20'),
    JSON.stringify((list()?.textContent ?? '').slice(0, 60)),
  );
  check(
    'the control says how many are behind it',
    (toggle()?.getAttribute('aria-label') ?? '').includes('19'),
    JSON.stringify(toggle()?.getAttribute('aria-label') ?? null),
  );
  check(
    'and a screen reader is told the same, in a region that announces changes',
    status().includes('20') && status().includes('19 hidden'),
    JSON.stringify(status()),
  );
  check(
    'the control is a button the keyboard alone can reach and press',
    Boolean(toggle()) && toggle()!.tagName === 'BUTTON' && toggle()!.tabIndex >= 0
      && toggle()!.getAttribute('aria-expanded') === 'false',
    `${toggle()?.tagName} tabIndex=${toggle()?.tabIndex} expanded=${toggle()?.getAttribute('aria-expanded')}`,
  );

  // Opened: everything, in order.
  toggle()?.click();
  await wait(250);
  check('opening it shows every waiting message', rowCount() === 20, `${rowCount()} rows`);
  check('in the order they will be sent', (() => {
    const texts = Array.from(list()?.querySelectorAll('[role="listitem"]') ?? [])
      .map((node) => node.textContent ?? '');
    return texts[0].includes('number 1,') && texts[19].includes('number 20');
  })());
  check(
    'and says so, rather than leaving the control reading the same either way',
    toggle()?.getAttribute('aria-expanded') === 'true' && status().includes('all shown'),
    `${toggle()?.getAttribute('aria-expanded')} / ${JSON.stringify(status())}`,
  );
  const opened = list()?.getBoundingClientRect().height ?? 0;
  check(
    'the opened list is bounded and scrolls in its own space',
    opened <= 300 && (list()?.scrollHeight ?? 0) > (list()?.clientHeight ?? 0),
    `${Math.round(opened)}px tall, ${list()?.scrollHeight}px of content`,
  );
  // The control that closes it again rides the newest row, which is the last
  // one in a box that scrolls — so opening has to land there rather than at the
  // top of twenty messages with the way back off screen.
  {
    const listNode = list();
    const control = toggle();
    const box = listNode?.getBoundingClientRect();
    const seat = control?.getBoundingClientRect();
    check(
      'and the control that closes it is still where it was left',
      Boolean(box && seat) && seat!.top >= box!.top - 1 && seat!.bottom <= box!.bottom + 1,
      box && seat
        ? `${Math.round(seat.top)}–${Math.round(seat.bottom)} in ${Math.round(box.top)}–${Math.round(box.bottom)}`
        : 'no control',
    );
    check(
      'with the message it belongs to, the list having opened upwards out of it',
      Boolean(listNode && control)
        && (Array.from(listNode!.querySelectorAll('[role="listitem"]'))
          .find((row) => row.contains(control!))?.textContent ?? '').includes('number 20'),
    );
  }

  // #70's control and the one that withdraws a message are still on the rows
  // that are on screen — collapsing must not cost the queue what it could do.
  const removeFirst = Array.from(host.querySelectorAll('button')).find((node) =>
    (node.getAttribute('aria-label') ?? '') === 'Remove queued message 1') as HTMLButtonElement | undefined;
  check('a message can still be withdrawn from the opened list', Boolean(removeFirst));
  check(
    'and sent now from it',
    Boolean(Array.from(host.querySelectorAll('button')).find((node) =>
      /^Send queued message 1 now/.test(node.getAttribute('aria-label') ?? ''))),
  );
  removeFirst?.click();
  await wait(150);
  check(
    'removing one asks the server to drop that message, by id',
    outbound.some((m) => m.type === 'chat_queue_cancel' && m.queuedId === 'q1'),
    JSON.stringify(outbound.filter((m) => m.type === 'chat_queue_cancel')),
  );

  // A list the user opened must survive the queue changing under it, in both
  // directions — this is the criterion a naive `useEffect` on length breaks.
  await enqueue(21);
  check('a message arriving while the list is open leaves it open', rowCount() === 21, `${rowCount()} rows`);
  check('and the count follows it', status().includes('21'), JSON.stringify(status()));

  toggle()?.click();
  await wait(200);
  check('closing it returns to the single row', rowCount() === 1, `${rowCount()} rows`);
  await enqueue(22);
  check('and a message arriving while it is closed does not spring it open', rowCount() === 1, `${rowCount()} rows`);

  // Draining back down: the plain form returns without the user closing
  // anything, and without the count lingering.
  await enqueue(1);
  check('draining to one message returns to the plain form', rowCount() === 1 && !toggle(), `${rowCount()} rows`);
  check('with no count left announcing a queue that is gone', status() === '', JSON.stringify(status()));

  // The phone is where this stops being cosmetic: twenty full-width rows are
  // taller than the screen, so the input, the send control and the
  // conversation all go with them.
  host.style.cssText = 'width:390px;height:740px;position:absolute;top:0;left:0;display:flex;overflow:hidden';
  const withinScreen = (where: string): void => {
    const frame = host.getBoundingClientRect();
    const field = host.querySelector('textarea') as HTMLElement | null;
    const send = Array.from(host.querySelectorAll('button')).find((node) =>
      /^(Send message|Queue this message)$/.test(node.getAttribute('aria-label') ?? '')) as HTMLElement | undefined;
    const bubble = host.querySelector('[data-message-id]') as HTMLElement | null;
    const box = field?.getBoundingClientRect();
    const sendBox = send?.getBoundingClientRect();
    check(
      `${where}, the box you would type in is still on screen`,
      Boolean(box) && box!.bottom <= frame.bottom + 1 && box!.top >= frame.top - 1 && box!.height > 0,
      box ? `${Math.round(box.top)}–${Math.round(box.bottom)} in ${Math.round(frame.bottom)}` : 'no field',
    );
    check(
      `${where}, so is the control that sends it`,
      Boolean(sendBox) && sendBox!.bottom <= frame.bottom + 1 && sendBox!.height >= PHONE_TARGET,
      sendBox ? `${Math.round(sendBox.bottom)} in ${Math.round(frame.bottom)}, ${Math.round(sendBox.height)}px` : 'none',
    );
    const seen = bubble?.getBoundingClientRect();
    check(
      `${where}, and the conversation is still visible above it`,
      Boolean(seen) && seen!.height > 0 && seen!.bottom > frame.top && seen!.top < frame.bottom,
      seen ? `${Math.round(seen.top)}–${Math.round(seen.bottom)}` : 'nothing rendered',
    );
  };

  await paint(20, true);
  check('a phone collapses the queue to one row too', rowCount() === 1, `${rowCount()} rows`);
  withinScreen('collapsed on a phone');

  const phoneToggle = toggle();
  const size = phoneToggle ? laidOutSize(phoneToggle) : { width: 0, height: 0 };
  check(
    'the control that opens it is big enough for a finger',
    size.width >= PHONE_TARGET && size.height >= PHONE_TARGET,
    `${size.width}x${size.height}`,
  );
  const phoneRemove = Array.from(host.querySelectorAll('button')).find((node) =>
    (node.getAttribute('aria-label') ?? '') === 'Remove queued message 20') as HTMLElement | undefined;
  if (phoneToggle && phoneRemove) {
    const a = phoneToggle.getBoundingClientRect();
    const b = phoneRemove.getBoundingClientRect();
    const gap = Math.max(b.left - a.right, a.left - b.right);
    check(
      'and far enough from the one that throws the message away',
      gap >= PHONE_GAP,
      `gap ${Math.round(gap)}px`,
    );
  }

  phoneToggle?.click();
  await wait(250);
  check('opening it on a phone still shows every message', rowCount() === 20, `${rowCount()} rows`);
  const phoneOpened = list()?.getBoundingClientRect().height ?? 0;
  check(
    'and keeps them inside their own scrolling space rather than the screen',
    phoneOpened > 0 && phoneOpened <= 740 * 0.45 && (list()?.scrollHeight ?? 0) > (list()?.clientHeight ?? 0),
    `${Math.round(phoneOpened)}px of a 740px screen, ${list()?.scrollHeight}px of content`,
  );
  withinScreen('opened on a phone');

  root.unmount();
  host.remove();
}

/* -------------------------------------------------------------------------
 * Folded history is not built until it is opened (issue #81)
 *
 * The whole backlog used to be rendered and then hidden, so entering a
 * conversation paid for every code block, diff and diagram in it — none of
 * which was on screen, because everything but the newest turn is folded by
 * default. The proof has to be at the DOM, not at the policy: `retain` is unit
 * tested on its own, and a list that computes the right retained set and then
 * mounts everything anyway would pass that and fail the user.
 *
 * The bound is asserted the same way — by opening more heavy turns than the
 * budget allows and looking for the earliest one's content to be gone.
 */
async function checkFoldedHistoryIsNotBuiltUntilItIsOpened(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:1280px;height:760px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const capabilities = {
    streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
    interrupt: true, resume: true, fork: false, attachments: true, usage: true,
    cost: true, plan: true, commands: [],
  };

  /**
   * `count` turns, each carrying `chars` of assistant prose and its own marker.
   *
   * Split into 2k blocks rather than one long one, so that a heavier turn is
   * heavier in the document too. A single 60k-character paragraph renders as
   * exactly as many elements as a 2k one, which would make the comparison
   * below pass whether or not anything was fixed.
   */
  const conversation = (count: number, chars: number): unknown[] => {
    const messages: unknown[] = [];
    for (let i = 1; i <= count; i++) {
      const blocks = Array.from({ length: Math.max(1, Math.round(chars / 2000)) }, (_, b) => ({
        kind: 'text',
        text: `${b === 0 ? `MARKER-${i} ` : `part ${b} `}${'filler '.repeat(280)}`,
      }));
      messages.push({
        id: `u${i}`, seq: messages.length + 1, turnId: `t${i}`, role: 'user', ts: 1,
        blocks: [{ kind: 'text', text: `question number ${i}` }],
      });
      messages.push({
        id: `a${i}`, seq: messages.length + 1, turnId: `t${i}`, role: 'assistant', ts: 2,
        blocks,
      });
    }
    return messages;
  };

  const mount = async (id: string, messages: unknown[]) => {
    const controller = new ChatController(id, { send: () => {} });
    controller.handle({
      type: 'chat_snapshot',
      sessionId: id,
      snapshot: {
        sessionId: id, runtime: 'claude', state: 'idle', capabilities,
        messages,
        pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1,
        cursor: messages.length, live: true, bypassPermissions: false,
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
    await wait(500);
    return { controller, root };
  };

  const bubbles = (): number => host.querySelectorAll('[data-message-id]').length;
  const nodes = (): number => host.querySelectorAll('*').length;
  const shows = (marker: string): boolean => (host.textContent || '').includes(marker);
  const press = (label: string): void => {
    const button = host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
    button?.click();
  };

  // ------------------------------------------- what a folded turn costs
  //
  // Measured as the difference between a 3-turn and a 40-turn conversation of
  // the same content, so the one turn that *is* open cancels out and what is
  // left is the price of 37 folded ones. Run at two very different content
  // weights: if folded turns were still being built, the heavy figure would be
  // a multiple of the light one.
  const overheadPerFoldedTurn = async (label: string, chars: number): Promise<number> => {
    let small = await mount(`${label}-3`, conversation(3, chars));
    const smallNodes = nodes();
    small.root.unmount();
    await wait(80);
    const big = await mount(`${label}-40`, conversation(40, chars));
    const bigNodes = nodes();
    big.root.unmount();
    await wait(80);
    return (bigNodes - smallNodes) / 37;
  };

  const lightPerTurn = await overheadPerFoldedTurn('fold-light', 2000);
  const heavyPerTurn = await overheadPerFoldedTurn('fold-heavy', 60_000);

  let mounted = await mount('fold-long', conversation(40, 2000));
  const longBubbles = bubbles();

  check(
    'with history folded, the browser has not built those turns',
    longBubbles === 2,
    `${longBubbles} message bubbles mounted for a 40-turn conversation`,
  );
  // A folded turn is not free — it still has a strip and an index row, which
  // is what keeps the conversation navigable. What it must not cost is its
  // *contents*.
  check(
    'so entering the tab costs a strip per turn, not that turn’s contents',
    lightPerTurn < 40,
    `${lightPerTurn.toFixed(1)} DOM nodes per folded turn`,
  );
  // Thirty times the content behind the fold, and the same price per turn.
  check(
    'and it does not follow how heavy the folded turns are',
    Math.abs(heavyPerTurn - lightPerTurn) < 5,
    `${heavyPerTurn.toFixed(1)} nodes per folded turn at 60k characters against ${lightPerTurn.toFixed(1)} at 2k`,
  );
  check(
    'and the folded turns’ contents are nowhere in the document',
    !shows('MARKER-1') && !shows('MARKER-20'),
    'looked for turn 1 and turn 20 in a 40-turn conversation',
  );
  check(
    'while the turn on screen is fully built',
    shows('MARKER-40'),
    'the newest turn is open, as it always was',
  );
  // Every turn's strip is still there — the conversation is navigable, and
  // nothing has been made unreachable.
  check(
    'every turn still has its strip, so nothing is out of reach',
    host.querySelectorAll('[data-turn-id]').length === 40,
    `${host.querySelectorAll('[data-turn-id]').length} strips for 40 turns`,
  );

  // ------------------------------------------------- opening one builds it
  press('Expand turn 12');
  await wait(300);
  check(
    'opening a folded turn shows its contents',
    shows('MARKER-12'),
    shows('MARKER-12') ? 'turn 12 is on screen' : 'turn 12 opened empty',
  );

  // Stamped on the node itself: if re-opening rebuilt the turn, React would
  // have mounted a fresh element and the stamp would be gone. This is the
  // behaviour hiding-rather-than-unmounting used to buy, and the one thing
  // this change was most likely to lose.
  const stamp = host.querySelector('#turn-body-u12 [data-message-id]') as (HTMLElement & { seen?: number }) | null;
  if (stamp) stamp.seen = 1;
  press('Collapse turn 12');
  await wait(200);
  press('Expand turn 12');
  await wait(200);
  const again = host.querySelector('#turn-body-u12 [data-message-id]') as (HTMLElement & { seen?: number }) | null;
  check(
    're-folding and re-opening it does not build it a second time',
    Boolean(again) && again?.seen === 1,
    again ? (again.seen === 1 ? 'the same element' : 'a rebuilt element') : 'nothing there at all',
  );

  // ------------------------------- a turn that kept running while folded
  const event = (payload: unknown): void =>
    mounted.controller.handle({ type: 'chat_event', sessionId: 'fold-long', event: payload } as never);
  press('Collapse turn 40');
  await wait(150);
  event({ t: 'msg_start', id: 'late', seq: 999, turnId: 't40', role: 'assistant', ts: 3 });
  event({ t: 'block_start', msgId: 'late', index: 0, block: { kind: 'text', text: 'ARRIVED-WHILE-FOLDED' } });
  event({ t: 'msg_end', msgId: 'late' });
  await wait(200);
  press('Expand turn 40');
  await wait(250);
  check(
    'a turn that kept running while folded opens on its current state',
    shows('ARRIVED-WHILE-FOLDED'),
    shows('ARRIVED-WHILE-FOLDED') ? 'the late message is there' : 'opened on a stale snapshot',
  );

  mounted.root.unmount();
  await wait(80);

  // ------------------------------------------------------ the kept bound
  //
  // Six turns of 60k characters against a 200k budget: the three most recently
  // opened are kept by the floor, one more fits, and the rest are released.
  mounted = await mount('fold-heavy', conversation(8, 60_000));
  for (const turn of [1, 2, 3, 4, 5, 6]) {
    press(`Expand turn ${turn}`);
    await wait(200);
    press(`Collapse turn ${turn}`);
    await wait(120);
  }
  check(
    'a conversation that keeps growing does not keep growing what is kept',
    !shows('MARKER-1') && !shows('MARKER-2'),
    `turn 1 ${shows('MARKER-1') ? 'still built' : 'released'}, turn 2 ${shows('MARKER-2') ? 'still built' : 'released'}`,
  );
  check(
    'while the ones just looked at are still there',
    shows('MARKER-6') && shows('MARKER-5'),
    `turn 6 ${shows('MARKER-6') ? 'kept' : 'gone'}, turn 5 ${shows('MARKER-5') ? 'kept' : 'gone'}`,
  );

  // ------------------------------------------- jumping to a released turn
  // Found by its label rather than by a turn id: the index row's terse title
  // is only used when the index is collapsed, and this is a 1280px window.
  const option = Array.from(host.querySelectorAll('[role="option"]'))
    .find((row) => (row.textContent || '').includes('question number 1')) as HTMLElement | undefined;
  option?.click();
  await wait(350);
  check(
    'jumping to a released turn from the index lands on shown content',
    shows('MARKER-1'),
    option ? (shows('MARKER-1') ? 'turn 1 is built and on screen' : 'landed on an empty turn') : 'no index row for turn 1',
  );

  mounted.root.unmount();
  host.remove();
}

/**
 * That a conversation tells one story about how many tokens it has used.
 *
 * Issue #80. Three surfaces answered the same question differently: the
 * composer's session line added the input to the output and stopped there, the
 * header meter added the cache buckets too, and the historical dashboard filed
 * only a total the runtime had volunteered — which Claude never does. The
 * figures below are one real turn out of `claude-oneshot.jsonl`, where the
 * cache is 63,689 of the 63,790 tokens, so a readout that leaves it out is not
 * slightly low, it is the wrong order of magnitude.
 */
async function checkAConversationTellsOneStoryAboutItsTokens(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:1000px;height:700px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const controller = new ChatController('tokens-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'tokens-check',
    snapshot: {
      sessionId: 'tokens-check',
      runtime: 'claude',
      state: 'idle',
      capabilities: {
        streaming: true, thinking: true, toolCalls: true, diffs: false, permissions: true,
        interrupt: true, resume: true, fork: false, attachments: true, usage: true,
        cost: true, plan: false,
      },
      messages: [],
      pendingPermissions: [],
      queued: [],
      firstSeq: 1,
      replayFrom: 1,
      cursor: 1,
      live: true,
      bypassPermissions: false,
    },
  } as never);

  const push = (event: Record<string, unknown>, seq: number): void => {
    controller.handle({
      type: 'chat_event',
      sessionId: 'tokens-check',
      event: { seq, ts: 1_700_000_000_000 + seq, ...event },
    } as never);
  };

  push({ t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' }, 1);
  push({ t: 'block_start', msgId: 'u1', index: 0, block: { kind: 'text', text: 'go' } }, 2);
  push({ t: 'msg_end', msgId: 'u1' }, 3);
  push({ t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' }, 4);
  push({ t: 'block_start', msgId: 'a1', index: 0, block: { kind: 'text', text: 'done' } }, 5);
  // What Claude reports for this turn: four buckets, and no total at all.
  push({
    t: 'msg_end',
    msgId: 'a1',
    usage: { inputTokens: 4, outputTokens: 97, cacheWriteTokens: 16402, cacheReadTokens: 47287 },
  }, 6);
  push({ t: 'turn_end', turnId: 'turn-1', usage: { costUsd: 0.1901 } }, 7);

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
  await wait(300);

  const meter = host.querySelector('[role="group"][aria-label="Session usage"]');
  const meterText = (meter?.textContent ?? '').replace(/\s+/g, ' ');
  check(
    'the session meter counts a Claude turn’s cache, which is almost all of it',
    /63\.8k tok/.test(meterText),
    meterText || 'no session meter on screen',
  );

  // The composer's own line, which is the figure most often glanced at and was
  // the one leaving the cache out.
  // Anything but the meter above: the two are separate readouts of one number,
  // and a selector that could match either would pass on the meter twice.
  const readout = Array.from(host.querySelectorAll('span')).find(
    (span) =>
      /\d+(\.\d+)?k? tok/.test(span.textContent ?? '')
      && !span.querySelector('span')
      && !meter?.contains(span),
  );
  const readoutText = (readout?.textContent ?? '').replace(/\s+/g, ' ');
  check(
    'and the composer’s session line says the same thing, not input plus output alone',
    /64k tok/.test(readoutText),
    readoutText || 'no session line on screen',
  );
  check(
    'so the two readouts are not two different answers about one conversation',
    !/101 tok/.test(readoutText) && !/101 tok/.test(meterText),
    `${meterText} | ${readoutText}`,
  );

  root.unmount();
  host.remove();
}

/**
 * The model the conversation shows is the one that ran, and its menu is usable.
 *
 * Three things this covers that no unit test can (#75): a grok conversation
 * opens naming no model and is renamed by the turn that finishes, a turn split
 * across models says so on the chip rather than picking one, and a runtime that
 * publishes hundreds of models produces a list somebody can actually find one
 * in.
 */
async function checkTheModelShownIsTheModelThatRan(): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:600px;position:absolute;top:0;left:0;display:flex';
  document.body.appendChild(host);

  const capabilities = {
    streaming: true, thinking: true, toolCalls: false, diffs: false, permissions: false,
    interrupt: true, resume: true, fork: false, attachments: false, usage: true,
    cost: true, plan: false,
    models: [
      { value: 'grok-build', name: 'grok-build', description: 'default' },
      { value: 'grok-4.5', name: 'grok-4.5' },
      { value: 'sxs-claude-opus-4-6', name: 'sxs-claude-opus-4-6' },
    ],
  };

  const controller = new ChatController('model-check', { send: () => {} });
  controller.handle({
    type: 'chat_snapshot',
    sessionId: 'model-check',
    snapshot: {
      sessionId: 'model-check',
      runtime: 'grok',
      state: 'idle',
      capabilities,
      messages: [
        {
          id: 'u1', seq: 1, turnId: 't1', role: 'user', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'what model are you' }],
        },
        {
          id: 'a1', seq: 2, turnId: 't1', role: 'assistant', ts: Date.now(),
          blocks: [{ kind: 'text', text: 'answering' }],
        },
      ],
      pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1, cursor: 2,
      live: true, bypassPermissions: false,
    },
  } as never);

  const root = createRoot(host);
  root.render(
    React.createElement(ChatView, {
      controller,
      runtime: 'grok',
      runtimeLabel: 'Grok',
      workingDir: '/tmp/project',
      view: DEFAULT_CHAT_VIEW,
      onViewChange: () => {},
    } as never),
  );
  await wait(250);

  const chip = (): HTMLElement | null => host.querySelector('[aria-label="Change model"]');
  const chipText = (): string => (chip()?.textContent ?? '').trim();

  // A grok conversation that has run no turn knows no model, and the app does
  // not fill the gap with the one it asked for.
  check(
    'a conversation whose runtime has not named a model does not invent one',
    !/grok-(build|4\.5)/.test(chipText()),
    chipText() || 'empty',
  );

  // The turn that finishes is what names it.
  controller.handle({
    type: 'chat_event',
    sessionId: 'model-check',
    event: {
      t: 'turn_end', seq: 3, ts: Date.now(), turnId: 't1',
      models: [{ model: 'grok-build', calls: 1, usage: { costUsd: 0.0128 } }],
    },
  } as never);
  await wait(200);
  check(
    'the turn that finishes names the model that ran',
    chipText().includes('grok-build'),
    chipText() || 'empty',
  );

  // A turn split across models is not shown as one model.
  controller.handle({
    type: 'chat_event',
    sessionId: 'model-check',
    event: {
      t: 'msg_start', seq: 4, ts: Date.now(), id: 'a2', role: 'assistant', turnId: 't2',
      model: 'grok-build',
    },
  } as never);
  controller.handle({
    type: 'chat_event',
    sessionId: 'model-check',
    event: {
      t: 'turn_end', seq: 5, ts: Date.now(), turnId: 't2',
      models: [
        { model: 'grok-build', calls: 3 },
        { model: 'sxs-claude-opus-4-6', calls: 1 },
      ],
    },
  } as never);
  await wait(200);
  check(
    'a turn that ran on two models says so instead of naming one',
    chipText().includes('grok-build') && chipText().includes('+1'),
    chipText() || 'empty',
  );
  check(
    'and the other model is named where there is room for it',
    (chip()?.getAttribute('title') ?? '').includes('sxs-claude-opus-4-6'),
    chip()?.getAttribute('title') ?? 'no title',
  );

  // The menu: what the runtime published, and findable.
  chip()?.click();
  await wait(200);
  const list = (): HTMLElement | null => host.querySelector('[role="listbox"][aria-label="Models"]');
  const options = (): string[] =>
    Array.from(list()?.querySelectorAll('[role="option"]') ?? []).map(
      (row) => (row.textContent ?? '').trim(),
    );
  check(
    'the picker offers the models the runtime published',
    options().some((row) => row.includes('grok-4.5'))
      && options().some((row) => row.includes('sxs-claude-opus-4-6')),
    options().join(' | ').slice(0, 200) || 'nothing listed',
  );

  const field = list()?.querySelector('input') as HTMLInputElement | null;
  check('and a field to find one in', Boolean(field));
  if (field) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, 'opus');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    check(
      'typing narrows the list rather than only offering to send what was typed',
      options().some((row) => row.includes('sxs-claude-opus-4-6'))
        && !options().some((row) => row.includes('grok-4.5')),
      options().join(' | ').slice(0, 200) || 'nothing listed',
    );
    // And a model the runtime never listed is still reachable, which is the
    // whole reason this is one field and not two.
    setter?.call(field, 'something-unlisted');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);
    const use = Array.from(list()?.querySelectorAll('button') ?? []).find(
      (button) => (button.textContent ?? '').trim() === 'Use',
    ) as HTMLElement | undefined;
    check(
      'a model that matches nothing listed can still be sent',
      Boolean(use) && !(use as HTMLButtonElement).disabled,
      use ? 'enabled' : 'no Use control',
    );
  }

  root.unmount();
  host.remove();
}
import { UsageMeter } from '../../src/client/shell/chat/UsageMeter';
import { StatusPanel } from '../../src/client/shell/chat/StatusPanel';

/**
 * Issue #82: what a person actually sees about the context window.
 *
 * Three states, because they are three different answers and the product is
 * only useful if they are told apart. Measured against a real ceiling; measured
 * against no ceiling at all; and near enough to the edge that it has to say so
 * while there is still room to act.
 *
 * Rendered through the real stylesheets, because every figure here is a
 * `var(--...)` away from being unreadable.
 */
async function checkTheContextReadingIsHonestAboutItsCeiling(): Promise<void> {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:520px;height:900px;position:absolute;top:0;left:0;border:0';
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

  const capabilities = { usage: true, cost: true } as never;
  const render = (usage: Record<string, unknown>) => {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(UsageMeter, { usage: usage as never, capabilities }));
    return { host, root };
  };

  // A window the agent reported, comfortably below the line.
  const calm = render({
    totalTokens: 40000,
    contextWindow: 1000000,
    contextUsed: 40000,
    contextWindowSource: 'agent',
  });
  await wait(150);
  const calmText = (calm.host.textContent || '').replace(/\s+/g, ' ');
  check(
    'a measured context reads as used of total',
    calmText.includes('40.0k') && calmText.includes('1.0M') && calmText.includes('4%'),
    calmText || 'nothing rendered',
  );
  check(
    'and does not shout about a window that is nearly empty',
    !/almost full|filling up/i.test(calmText),
    calmText,
  );

  // The same conversation, near the edge.
  const full = render({
    totalTokens: 190000,
    contextWindow: 200000,
    contextUsed: 190000,
    contextWindowSource: 'agent',
  });
  await wait(150);
  const fullText = (full.host.textContent || '').replace(/\s+/g, ' ');
  check(
    'a context near its limit says so, and says how much is left',
    /almost full/i.test(fullText) && fullText.includes('10.0k'),
    fullText || 'nothing rendered',
  );
  check(
    'and tells the user what to do about it before the limit is reached',
    /compact|new conversation/i.test(fullText),
    fullText,
  );

  // An agent that reports occupancy and no ceiling, and whose provider had no
  // entry either. The reading must say that rather than going quiet.
  const unknown = render({ totalTokens: 8074, contextUsed: 8074 });
  await wait(150);
  const unknownText = (unknown.host.textContent || '').replace(/\s+/g, ' ');
  check(
    'an unestablished capacity is stated, not left blank',
    /size unknown/i.test(unknownText),
    unknownText || 'nothing rendered',
  );
  check(
    'and the figure that is known is still shown',
    unknownText.includes('8.1k'),
    unknownText,
  );
  check(
    'and no bar is drawn against a number nobody stands behind',
    !unknown.host.querySelector('[role="progressbar"]'),
    String(unknown.host.innerHTML).slice(0, 200),
  );

  // The panel, which is where the provenance and the warning are spelled out.
  const panelHost = doc.createElement('div');
  doc.body.appendChild(panelHost);
  const transcript = {
    subscribe: () => () => {},
    getVersion: () => 0,
    usage: {
      totalTokens: 190000,
      contextWindow: 200000,
      contextUsed: 190000,
      contextWindowSource: 'provider',
    },
  };
  const panelRoot = createRoot(panelHost);
  panelRoot.render(
    React.createElement(StatusPanel, { sessionId: '', transcript: transcript as never }),
  );
  await wait(300);
  const panelText = (panelHost.textContent || '').replace(/\s+/g, ' ');
  check(
    'the status panel warns when the context is nearly gone',
    /almost full/i.test(panelText),
    panelText.slice(0, 300) || 'nothing rendered',
  );
  check(
    'and says a looked-up window came from the provider, not the agent',
    /provider/i.test(panelText),
    panelText.slice(0, 300),
  );

  // Legibility: this is the readout someone glances at mid-session, and a
  // 10px warning is one nobody acts on.
  const warning = Array.from(panelHost.querySelectorAll('*')).find((node) =>
    /almost full/i.test(node.textContent || '') && node.children.length === 0,
  ) as HTMLElement | undefined;
  const size = warning ? parseFloat(doc.defaultView!.getComputedStyle(warning).fontSize) : 0;
  check(
    'the warning is set large enough to read',
    size >= 12,
    `${size}px`,
  );

  calm.root.unmount();
  full.root.unmount();
  unknown.root.unmount();
  panelRoot.unmount();
  frame.remove();
}
