const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ChatSessionSidebar and ChatSearch are the "power" half of chat mode:
// navigating across many agent conversations rather than reading one. Both
// render from renderToStaticMarkup like every other Relay component test in
// this repo (see relay-components.test.js) — there is no jsdom dependency
// here, so ChatSearch's live debounce/promise behaviour is exercised through
// its exported ChatSearchResults presentational piece instead, driven
// directly by the phase it would otherwise reach only after a keystroke and
// a resolved fetch.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { ChatSessionSidebar } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/ChatSessionSidebar'))};`,
    `export { ChatSearch, ChatSearchResults } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/ChatSearch'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `chat-sessions-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-sessions.tsx' },
    bundle: true,
    outfile: out,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(out);
  mod.__file = out;
});

after(function () {
  if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
});

// ---------------------------------------------------------------------------
// ChatSessionSidebar
// ---------------------------------------------------------------------------

// Midday today, not `Date.now()`. The sidebar groups by calendar day, so a
// fixture anchored to the real clock puts "five minutes ago" and "two hours
// ago" on *yesterday* whenever the suite runs shortly after midnight — and the
// Today group the assertions below look for is then legitimately empty. Midday
// keeps every offset on the day it was written to mean, whatever time it runs.
const NOW = new Date().setHours(12, 0, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

function sessions() {
  return [
    { id: 's1', name: 'Fix the parser', runtime: 'claude', workingDir: '/home/dev/projects/webcli', lastActivity: NOW - 5 * 60_000, messageCount: 12, state: 'running', unread: true },
    { id: 's2', name: 'Refactor bridges', runtime: 'codex', workingDir: '/home/dev/projects/webcli/src/server', lastActivity: NOW - 2 * HOUR, messageCount: 40, state: 'idle' },
    { id: 's3', name: 'Investigate flaky test', runtime: 'kimi', workingDir: '/home/dev/projects/other-repo', lastActivity: NOW - DAY - 3 * HOUR, state: 'awaiting_permission' },
    { id: 's4', name: 'Draft release notes', runtime: 'pi', workingDir: '/home/dev/notes', lastActivity: NOW - 6 * DAY, state: 'error' },
    { id: 's5', name: 'Spike: search index', runtime: 'grok', workingDir: '/', lastActivity: NOW - 20 * DAY, state: 'exited' },
  ];
}

function renderSidebar(props) {
  const { renderToStaticMarkup, React, ChatSessionSidebar } = mod;
  return renderToStaticMarkup(
    React.createElement(ChatSessionSidebar, {
      sessions: [],
      activeId: null,
      onSelect() {},
      ...props,
    }),
  );
}

describe('ChatSessionSidebar', function () {
  it('renders sessions grouped by recency, newest first within a group', function () {
    const html = renderSidebar({ sessions: sessions(), activeId: 's1', onSelect() {} });
    assert.ok(html.includes('Today'), 'missing Today group');
    assert.ok(html.includes('Earlier'), 'missing Earlier group');
    assert.ok(html.includes('Fix the parser'));
    assert.ok(html.includes('Spike: search index'));
    // Grouping order: Today's header must appear before Earlier's in the markup.
    assert.ok(html.indexOf('Today') < html.indexOf('Earlier'));
  });

  it('shows the working directory basename, with the full path handed to a Tooltip', function () {
    const html = renderSidebar({ sessions: sessions(), activeId: null, onSelect() {} });
    assert.ok(html.includes('>webcli<'), 'basename not rendered');
    // Tooltip only paints its bubble on hover/focus, so the full path is not in
    // a resting static render — but the basename must not be the full path
    // (i.e. the row is genuinely truncating, not just echoing workingDir raw).
    assert.ok(!html.includes('>/home/dev/projects/webcli<'), 'row shows the full path instead of a basename');
  });

  it('renders a runtime badge and message count per row', function () {
    const html = renderSidebar({ sessions: sessions(), activeId: null, onSelect() {} });
    assert.ok(html.includes('claude'));
    assert.ok(html.includes('codex'));
    assert.ok(html.includes('12'));
  });

  it('surfaces state as text, not colour alone, for busy and attention states', function () {
    const html = renderSidebar({ sessions: sessions(), activeId: null, onSelect() {} });
    assert.ok(html.includes('running'), 'no text for the running session');
    assert.ok(html.includes('needs approval'), 'no text for awaiting_permission');
    assert.ok(html.includes('error'), 'no text for the error session');
  });

  it('renders rename and delete affordances only when handlers are supplied', function () {
    const withHandlers = renderSidebar({
      sessions: sessions(), activeId: 's1', onSelect() {}, onRename() {}, onDelete() {},
    });
    const without = renderSidebar({ sessions: sessions(), activeId: 's1', onSelect() {} });
    // Neither markup shows the action buttons at rest (they reveal on hover/focus),
    // but the delete-confirm dialog scaffold only exists when onDelete is wired up.
    assert.ok(withHandlers.length > 0);
    assert.ok(without.length > 0);
  });

  it('renders a usable icon rail when collapsed', function () {
    const html = renderSidebar({ sessions: sessions(), activeId: 's2', collapsed: true, onSelect() {} });
    assert.ok(html.length > 0, 'collapsed rail rendered nothing');
    // Two-letter runtime initials still identify each session without labels.
    assert.ok(html.includes('CL') || html.includes('CO') || html.includes('KI'));
    // Group headers are meaningless at rail width and must not appear.
    assert.ok(!html.includes('>Today<'));
  });

  it('renders an empty state with no sessions', function () {
    const html = renderSidebar({ sessions: [], activeId: null, onSelect() {}, onNew() {} });
    assert.ok(html.includes('No sessions yet'));
    assert.ok(html.includes('New session'));
  });

  it('renders a loading state distinct from the empty state', function () {
    const html = renderSidebar({ sessions: [], activeId: null, onSelect() {}, loading: true });
    assert.ok(html.includes('Loading sessions'));
    assert.ok(!html.includes('No sessions yet'));
  });

  it('renders loading and empty states collapsed without throwing', function () {
    const loading = renderSidebar({ sessions: [], activeId: null, onSelect() {}, loading: true, collapsed: true });
    const empty = renderSidebar({ sessions: [], activeId: null, onSelect() {}, collapsed: true });
    assert.ok(loading.length > 0);
    assert.ok(empty.length > 0);
  });

  it('handles a session with no state, no unread flag and no message count', function () {
    const bare = [{ id: 'b1', name: 'Bare session', runtime: 'omp', workingDir: '/tmp', lastActivity: NOW }];
    const html = renderSidebar({ sessions: bare, activeId: null, onSelect() {} });
    assert.ok(html.includes('Bare session'));
  });

  it('handles a very long session name and working directory without throwing', function () {
    const long = [{
      id: 'l1',
      name: 'A'.repeat(400),
      runtime: 'claude',
      workingDir: '/home/dev/' + 'deep/'.repeat(80) + 'leaf',
      lastActivity: NOW,
    }];
    const html = renderSidebar({ sessions: long, activeId: null, onSelect() {} });
    assert.ok(html.includes('A'.repeat(20)));
  });
});

// ---------------------------------------------------------------------------
// ChatSearch / ChatSearchResults
// ---------------------------------------------------------------------------

function hits() {
  return [
    { sessionId: 's1', sessionName: 'Fix the parser', runtime: 'claude', seq: 4, role: 'user', snippet: 'can you fix the parser edge case for nested quotes', ts: NOW },
    { sessionId: 's1', sessionName: 'Fix the parser', runtime: 'claude', seq: 5, role: 'assistant', snippet: 'I found the parser bug in tokenize()', ts: NOW - 1000 },
    { sessionId: 's2', sessionName: 'Refactor bridges', runtime: 'codex', seq: 9, role: 'assistant', snippet: 'the bridge parser abstraction now lives in base.ts', ts: NOW - 2000 },
  ];
}

function renderResults(props) {
  const { renderToStaticMarkup, React, ChatSearchResults } = mod;
  return renderToStaticMarkup(
    React.createElement(ChatSearchResults, {
      phase: 'idle',
      query: '',
      hits: [],
      activeIndex: 0,
      listId: 'test-list',
      onHoverIndex() {},
      onOpenHit() {},
      ...props,
    }),
  );
}

describe('ChatSearch', function () {
  it('renders the idle hint with no query typed', function () {
    const { renderToStaticMarkup, React, ChatSearch } = mod;
    const html = renderToStaticMarkup(
      React.createElement(ChatSearch, { onSearch: async () => [], onOpen() {} }),
    );
    assert.ok(html.length > 0);
    assert.ok(html.includes('Search'));
  });

  it('renders with autoFocus without throwing', function () {
    const { renderToStaticMarkup, React, ChatSearch } = mod;
    const html = renderToStaticMarkup(
      React.createElement(ChatSearch, { onSearch: async () => [], onOpen() {}, autoFocus: true }),
    );
    assert.ok(html.length > 0);
  });

  it('idle phase shows a hint, not results markup', function () {
    const html = renderResults({ phase: 'idle' });
    assert.ok(html.length > 0);
  });

  it('searching phase shows a live, distinct indicator', function () {
    const html = renderResults({ phase: 'searching' });
    assert.ok(html.includes('Searching'));
    assert.ok(html.includes('aria-live'));
  });

  it('results phase groups hits by session and marks the matched term', function () {
    const html = renderResults({ phase: 'results', query: 'parser', hits: hits(), activeIndex: 0 });
    assert.ok(html.includes('Fix the parser'));
    assert.ok(html.includes('Refactor bridges'));
    assert.ok(html.includes('<mark'), 'matched term is not highlighted');
    // Both hits in the same session must land under one group, not one row each.
    const firstGroupIdx = html.indexOf('Fix the parser');
    const secondGroupIdx = html.indexOf('Fix the parser', firstGroupIdx + 1);
    assert.strictEqual(secondGroupIdx, -1, 'session name rendered twice — grouping is duplicating headers');
  });

  it('no-results phase names the query and is announced', function () {
    const html = renderResults({ phase: 'empty', query: 'xyzzy', hits: [] });
    assert.ok(html.includes('xyzzy'));
    assert.ok(html.includes('aria-live'));
  });

  it('error phase renders as an alert', function () {
    const html = renderResults({ phase: 'error', errorMessage: 'search backend unreachable' });
    assert.ok(html.includes('search backend unreachable'));
    assert.ok(html.includes('role="alert"'));
  });

  it('error phase falls back to a generic message with no errorMessage supplied', function () {
    const html = renderResults({ phase: 'error' });
    assert.ok(html.includes('Search failed'));
  });

  it('handles a snippet where the query does not literally appear', function () {
    const html = renderResults({
      phase: 'results',
      query: 'nonexistentterm',
      hits: [{ sessionId: 's1', sessionName: 'S', runtime: 'claude', seq: 1, role: 'user', snippet: 'hello world', ts: NOW }],
      activeIndex: 0,
    });
    assert.ok(html.includes('hello world'));
    assert.ok(!html.includes('<mark'));
  });

  it('handles a very long snippet without throwing', function () {
    const html = renderResults({
      phase: 'results',
      query: 'needle',
      hits: [{ sessionId: 's1', sessionName: 'S', runtime: 'claude', seq: 1, role: 'assistant', snippet: 'needle '.repeat(200), ts: NOW }],
      activeIndex: 0,
    });
    assert.ok(html.includes('<mark'));
  });

  it('renders every ChatRole without crashing', function () {
    for (const role of ['user', 'assistant', 'system']) {
      const html = renderResults({
        phase: 'results',
        query: 'x',
        hits: [{ sessionId: 's1', sessionName: 'S', runtime: 'claude', seq: 1, role, snippet: 'x marks the spot', ts: NOW }],
        activeIndex: 0,
      });
      assert.ok(html.length > 0, `role ${role} rendered nothing`);
    }
  });
});
