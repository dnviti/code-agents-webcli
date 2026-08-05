const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// What a typed query narrows a conversation list to, and what a delete leaves.
//
// These rules live in src/shared/conversations.ts rather than inside the dialog
// for exactly this reason: "matches on what was asked, the conversation's name,
// and the folder it lives in" is a decision, and it can be asserted without
// standing up a React tree, a browser or a server (#127).
//
// The dialog's *loaded* appearance is asserted in the browser checks instead —
// it arrives through an effect, and renderToStaticMarkup runs no effects, so a
// unit test here could only ever see the placeholder it starts on. What is
// checked of it here is the two states that need no data.

const ROOT = path.join(__dirname, '..');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export * as model from ${JSON.stringify(path.join(ROOT, 'src/shared/conversations'))};`,
    `export { ConversationsDialog, ConversationRow } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/ConversationsDialog'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `conversations-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'conversations.tsx' },
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

function conversation(over = {}) {
  return {
    id: 'c1',
    name: 'Session 25/07/2026, 21:35',
    firstMessage: 'aggiorna lo script di release',
    runtime: 'claude',
    runtimeLabel: 'Claude',
    lastActivity: '2026-07-25T21:35:00.000Z',
    workingDir: '/home/dev/projects/webcli',
    events: 42,
    canResume: true,
    running: false,
    bypassPermissions: false,
    ...over,
  };
}

function project(dir, conversations) {
  return {
    dir,
    name: mod.model.projectName(dir),
    lastActivity: conversations[0].lastActivity,
    conversations,
  };
}

describe('what a conversation list is made of', function () {
  it('calls a project by the leaf of its path', function () {
    const { projectName } = mod.model;
    assert.strictEqual(projectName('/home/dev/projects/webcli'), 'webcli');
    assert.strictEqual(projectName('/home/dev/projects/webcli/'), 'webcli');
    assert.strictEqual(projectName('C:\\work\\api'), 'api');
    // A conversation at the filesystem root still needs something to be called.
    assert.strictEqual(projectName('/'), '/');
    assert.strictEqual(projectName(''), '/');
  });

  it('labels a row by what was asked, never by when it happened', function () {
    const { conversationLabel } = mod.model;
    assert.strictEqual(
      conversationLabel(conversation()),
      'aggiorna lo script di release',
      'the opening question is what a person recognises a conversation by',
    );
    // No opening in the retained head of the log. The name is the fallback, and
    // for a conversation nobody renamed that is the timestamp — which is why it
    // is the fallback and not the label.
    assert.strictEqual(
      conversationLabel(conversation({ firstMessage: null })),
      'Session 25/07/2026, 21:35',
    );
    assert.strictEqual(
      conversationLabel(conversation({ firstMessage: '   ', name: '' })),
      'Conversation',
    );
  });

  it('matches a query against what was asked', function () {
    const { matchesConversation } = mod.model;
    assert.strictEqual(matchesConversation(conversation(), 'release'), true);
    assert.strictEqual(matchesConversation(conversation(), 'RELEASE'), true, 'case must not matter');
    assert.strictEqual(matchesConversation(conversation(), 'kubernetes'), false);
  });

  it('matches it against the conversation’s name and its folder too', function () {
    const { matchesConversation } = mod.model;
    const named = conversation({ firstMessage: null, name: 'Release work' });
    assert.strictEqual(matchesConversation(named, 'release work'), true);
    // The folder is one of the three things people remember about a conversation
    // they are trying to find.
    assert.strictEqual(matchesConversation(conversation(), 'webcli'), true);
    assert.strictEqual(matchesConversation(conversation(), 'claude'), true);
  });

  it('keeps everything when nothing has been typed', function () {
    const { matchesConversation } = mod.model;
    assert.strictEqual(matchesConversation(conversation(), ''), true);
    assert.strictEqual(matchesConversation(conversation(), '   '), true);
  });

  it('drops a group with no match, so a search across projects reads as a short list', function () {
    const { filterConversations, countConversations } = mod.model;
    const projects = [
      project('/p/alpha', [conversation({ id: 'a', firstMessage: 'alpha release' })]),
      project('/p/beta', [conversation({ id: 'b', firstMessage: 'beta migrazione' })]),
      project('/p/gamma', [
        conversation({ id: 'g1', firstMessage: 'gamma release' }),
        conversation({ id: 'g2', firstMessage: 'gamma tests' }),
      ]),
    ];

    const found = filterConversations(projects, 'release');
    assert.deepStrictEqual(
      found.map((entry) => entry.dir),
      ['/p/alpha', '/p/gamma'],
      'beta has no match and must not survive as an empty heading',
    );
    assert.deepStrictEqual(found[1].conversations.map((c) => c.id), ['g1']);
    assert.strictEqual(countConversations(found), 2);
    assert.strictEqual(countConversations(projects), 4);
  });

  it('leaves the list untouched when nothing has been typed', function () {
    const { filterConversations } = mod.model;
    const projects = [project('/p/alpha', [conversation()])];
    assert.strictEqual(filterConversations(projects, ''), projects);
  });

  it('removes a deleted conversation, and its project when it was the last one', function () {
    const { withoutConversation } = mod.model;
    const list = {
      projects: [
        project('/p/alpha', [conversation({ id: 'a1' }), conversation({ id: 'a2' })]),
        project('/p/solo', [conversation({ id: 's1' })]),
      ],
      total: 3,
      truncated: false,
    };

    const afterOne = withoutConversation(list, 'a1');
    assert.deepStrictEqual(afterOne.projects[0].conversations.map((c) => c.id), ['a2']);
    assert.strictEqual(afterOne.total, 2);

    const afterLast = withoutConversation(afterOne, 's1');
    assert.deepStrictEqual(
      afterLast.projects.map((entry) => entry.dir),
      ['/p/alpha'],
      'a group is made of the conversations in it; an empty heading is not a group',
    );
    assert.strictEqual(afterLast.total, 1);
  });

  it('leaves the list alone when the id is not in it', function () {
    const { withoutConversation } = mod.model;
    const list = { projects: [project('/p/alpha', [conversation({ id: 'a1' })])], total: 1, truncated: false };
    const after = withoutConversation(list, 'nope');
    assert.strictEqual(after.total, 1);
    assert.strictEqual(after.projects.length, 1);
  });
});

describe('the conversations dialog before its list arrives', function () {
  function render(props = {}) {
    const { renderToStaticMarkup, React, ConversationsDialog } = mod;
    return renderToStaticMarkup(
      React.createElement(ConversationsDialog, {
        open: true,
        load: async () => ({ projects: [], total: 0, truncated: false }),
        onOpen() {},
        async onDelete() { return false; },
        onClose() {},
        ...props,
      }),
    );
  }

  it('renders nothing at all when it is closed', function () {
    assert.strictEqual(render({ open: false }), '');
  });

  it('says it is looking rather than claiming there are none', function () {
    // The distinction matters: "No conversations yet" shown while the list is
    // still being read is the app telling the user their conversations are gone.
    const html = render();
    assert.ok(html.includes('Looking for your conversations'), html.slice(0, 400));
    assert.ok(!html.includes('No conversations yet'));
  });

  it('offers somewhere to type from the moment it opens', function () {
    const html = render();
    assert.ok(html.includes('aria-label="Search conversations"'), html.slice(0, 600));
  });
});

describe('a rollback recovery row', function () {
  it('cannot be opened but keeps its definitive Delete action enabled', function () {
    const { renderToStaticMarkup, React, ConversationRow } = mod;
    const html = renderToStaticMarkup(React.createElement(ConversationRow, {
      conversation: conversation({
        rollbackRecoveryPending: true,
        events: 0,
        firstMessage: null,
        canResume: false,
      }),
      hasTab: false,
      isActive: false,
      onOpen() {},
      onDelete() {},
    }));

    assert.match(html, /rollback cleanup pending/i);
    assert.match(html, /Delete this recovery entry to retry cleanup/i);
    const buttons = html.match(/<button\b[^>]*>/g) || [];
    assert.strictEqual(buttons.length, 2, html);
    assert.match(buttons[0], /disabled=""/);
    assert.match(buttons[1], /aria-label="Delete/);
    assert.doesNotMatch(buttons[1], /disabled=/);
  });
});
