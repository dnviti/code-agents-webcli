const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Issue #139, one surface over: a delegation nothing will report on again has to
 * stop reading as in flight in the popup too.
 *
 * #139 gave the reducer a fourth status, `unknown`, for a call whose runtime went
 * away or whose turn ended while it was still open, and taught the tool-status
 * table, the Agents panel and the workflow popup that it means "over". The agent
 * popup keeps its own copy of that list and was missed, so the row and the window
 * it opens disagreed: the row said "no longer reporting" while the popup put a
 * live dot on that very badge and offered "Waiting for this agent to report its
 * first step…" about a wait that had already ended.
 *
 * Rendered through the real ChatTranscript and the real popup — the same reason
 * test/chat-workflow-popup.test.js does: the claim is "given the events the
 * reducer produces, this is what someone sees", not "given the block I imagined".
 */

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

describe('the popup for a delegation that stopped reporting (#139)', function () {
  let bundle;
  let mod;

  before(function () {
    this.timeout(60000);

    const contents = [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { AgentPopup } from ${JSON.stringify(path.join(CHAT_DIR, 'AgentPopup'))};`,
      `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'chat', 'transcript'))};`,
      `export { RELAY_ICONS } from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'ui', 'relay', 'Icon'))};`,
    ].join('\n');

    bundle = path.join(os.tmpdir(), `agent-popup-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'agent-popup.tsx' },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      target: ['node20'],
      logLevel: 'silent',
    });

    mod = require(bundle);
  });

  after(function () {
    if (bundle) fs.rmSync(bundle, { force: true });
  });

  /** One delegated Task, then whatever the runtime went on to say about it. */
  function paint(events) {
    const { React, renderToStaticMarkup, ChatTranscript, AgentPopup } = mod;
    const transcript = new ChatTranscript();
    transcript.apply({ t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
    transcript.apply({
      t: 'block_start',
      seq: 2,
      ts: 2,
      msgId: 'm1',
      index: 0,
      block: {
        kind: 'tool',
        toolId: 'a1',
        name: 'Task',
        toolKind: 'task',
        status: 'running',
        input: { description: 'audit the release', subagent_type: 'general-purpose' },
      },
    });
    let seq = 3;
    for (const event of events) transcript.apply({ ts: seq, ...event, seq: seq++ });
    return renderToStaticMarkup(
      React.createElement(AgentPopup, {
        open: true,
        transcript,
        toolId: 'a1',
        onClose: () => {},
      }),
    );
  }

  // What the reducer's own sweep does to a call still open when the turn ends:
  // `turn_end` settles it as `unknown` rather than inventing an outcome for it.
  const stopped = () => ({ t: 'turn_end', turnId: 't1', stopReason: 'end_turn' });

  it('does not offer to wait for a first step that will never come', function () {
    const html = paint([stopped()]);
    assert.ok(
      !html.includes('Waiting for this agent to report its first step'),
      'the popup is still waiting on an agent nothing will report on again',
    );
  });

  it('says the same thing the row that opened it says', function () {
    const html = paint([stopped()]);
    assert.ok(
      html.includes('no longer reporting'),
      'the popup does not name the state the Agents row named',
    );
  });

  it('still waits while the delegation is genuinely running', function () {
    // The other half of the rule, so "settled" cannot be fixed by settling
    // everything: a call with no terminal event is still in flight.
    const html = paint([
      { t: 'agent_progress', parentToolId: 'a1', patch: { status: 'running' } },
    ]);
    assert.ok(
      html.includes('Waiting for this agent to report its first step'),
      'a running delegation stopped saying it is running',
    );
  });

  it('reads as done when the delegation actually finished', function () {
    const html = paint([
      { t: 'tool', toolId: 'a1', patch: { status: 'completed', output: 'done' } },
    ]);
    assert.ok(
      !html.includes('Waiting for this agent to report its first step'),
      'a finished delegation is still being waited on',
    );
  });
});
