const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The workspace rail and the chat's own settings dialog, rendered the way the
// rest of the chat components are tested: bundled with esbuild and rendered to
// static markup, which is what catches a bad import, a lookup table that
// returns undefined for a real value, or a hook misuse — none of which tsc
// alone would notice.
//
// Static rendering runs no effects, so the fetch-backed panels are asserted on
// what they show before their first response. That is deliberate: those states
// are the ones a user actually meets on a slow disk or a large repository, and
// they are the ones most likely to be left as a blank pane.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

let mod;
let bundle;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { WorkspacePanel } from ${JSON.stringify(path.join(CHAT_DIR, 'WorkspacePanel'))};`,
    `export { AgentsPanel } from ${JSON.stringify(path.join(CHAT_DIR, 'AgentsPanel'))};`,
    `export { LinksPanel } from ${JSON.stringify(path.join(CHAT_DIR, 'LinksPanel'))};`,
    `export { GitHubPanel } from ${JSON.stringify(path.join(CHAT_DIR, 'GitHubPanel'))};`,
    `export { GitChangesPanel } from ${JSON.stringify(path.join(CHAT_DIR, 'GitChangesPanel'))};`,
    `export { ChatSettingsDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/ChatSettingsDialog'))};`,
    `export { CodeEditor } from ${JSON.stringify(path.join(CHAT_DIR, 'CodeEditor'))};`,
    `export { MonacoEditor } from ${JSON.stringify(path.join(CHAT_DIR, 'MonacoEditor'))};`,
    `export { FileEditorDialog } from ${JSON.stringify(path.join(CHAT_DIR, 'FileEditorDialog'))};`,
    `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/transcript'))};`,
    `export * as viewSettings from ${JSON.stringify(path.join(ROOT, 'src/client/chat/view-settings'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-workspace-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-workspace.tsx' },
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

function render(name, props) {
  const { renderToStaticMarkup, React } = mod;
  return renderToStaticMarkup(React.createElement(mod[name], props));
}

function transcript(messages, state = 'idle') {
  const t = new mod.ChatTranscript();
  t.hydrate({
    sessionId: 's1',
    runtime: 'claude',
    messages,
    state,
    capabilities: t.capabilities,
    pendingPermissions: [],
    firstSeq: 1,
    replayFrom: 1,
    cursor: messages.length,
    live: true,
    bypassPermissions: false,
  });
  return t;
}

function assistant(id, blocks) {
  return { id, seq: 1, turnId: 't', role: 'assistant', ts: 1, blocks };
}

const VIEW = () => ({ ...mod.viewSettings.DEFAULT_CHAT_VIEW, panelOpen: true });

// ---------------------------------------------------------------------------
// view settings
// ---------------------------------------------------------------------------

describe('chat view settings', function () {
  it('fills in everything a partial or corrupt stored value leaves out', function () {
    const settings = mod.viewSettings.normalizeChatView({ panelOpen: true, panels: { files: false } });
    assert.strictEqual(settings.panelOpen, true);
    assert.strictEqual(settings.panels.files, false);
    assert.strictEqual(settings.panels.changes, true);
    assert.strictEqual(settings.showThinking, true);
  });

  it('survives junk without throwing', function () {
    for (const junk of [null, undefined, 42, 'nonsense', [], { panels: 'no' }]) {
      const settings = mod.viewSettings.normalizeChatView(junk);
      assert.strictEqual(typeof settings.panelOpen, 'boolean');
      assert.strictEqual(Object.keys(settings.panels).length, mod.viewSettings.CHAT_PANEL_IDS.length);
    }
  });

  it('never selects a tab whose panel is switched off', function () {
    // Otherwise the rail opens on nothing and looks broken.
    const settings = mod.viewSettings.normalizeChatView({
      panelTab: 'github',
      panels: { github: false },
    });
    assert.notStrictEqual(settings.panelTab, 'github');
    assert.strictEqual(settings.panels[settings.panelTab], true);
  });

  it('reports the enabled panels in their canonical order', function () {
    // Every panel named, including the ones being switched off: a panel left
    // out of this map defaults to on, so an incomplete fixture would break
    // every time a panel is added rather than testing the ordering it is about.
    const settings = mod.viewSettings.normalizeChatView({
      panels: {
        files: true,
        changes: false,
        github: true,
        agents: false,
        links: true,
        status: false,
      },
    });
    assert.deepStrictEqual(mod.viewSettings.enabledPanels(settings), ['files', 'github', 'links']);
  });
});

// ---------------------------------------------------------------------------
// the rail
// ---------------------------------------------------------------------------

describe('WorkspacePanel', function () {
  it('renders a tab for every enabled panel and none for the rest', function () {
    const html = render('WorkspacePanel', {
      sessionId: 's1',
      workingDir: '/home/dev/project',
      transcript: transcript([]),
      settings: { ...VIEW(), panels: { files: true, changes: true, github: false, agents: true, links: false } },
      onSelectTab() {},
      onClose() {},
    });

    assert.ok(/role="tab"/.test(html));
    assert.ok(/Files/.test(html));
    assert.ok(/Agents/.test(html));
    assert.ok(!/GitHub/.test(html), 'a disabled panel must not get a tab');
    assert.ok(!/>Links</.test(html));
  });

  it('says so rather than rendering an empty box when every panel is off', function () {
    const html = render('WorkspacePanel', {
      sessionId: 's1',
      workingDir: '/p',
      transcript: transcript([]),
      settings: {
        ...VIEW(),
        panels: { files: false, changes: false, github: false, agents: false, links: false },
      },
      onSelectTab() {},
      onClose() {},
    });
    assert.ok(/switched off/.test(html));
  });

  it('falls back to an enabled tab when the selected one is disabled', function () {
    const html = render('WorkspacePanel', {
      sessionId: 's1',
      workingDir: '/p',
      transcript: transcript([]),
      settings: {
        ...VIEW(),
        panelTab: 'github',
        panels: { files: true, changes: false, github: false, agents: false, links: false },
      },
      onSelectTab() {},
      onClose() {},
    });
    assert.ok(/aria-selected="true"/.test(html));
    assert.ok(/Files in \/p/.test(html), 'the first enabled panel should be showing');
  });

  it('applies the stored width and offers a keyboard-operable resize handle', function () {
    const html = render('WorkspacePanel', {
      sessionId: 's1',
      workingDir: '/p',
      transcript: transcript([]),
      settings: { ...VIEW(), panelWidth: 480 },
      onSelectTab() {},
      onClose() {},
      onResize() {},
    });

    assert.ok(/width:480px/.test(html.replace(/\s/g, '')), 'the stored width should be applied');
    assert.ok(/role="separator"/.test(html));
    assert.ok(/aria-orientation="vertical"/.test(html));
    assert.ok(/aria-valuenow="480"/.test(html));
    // A resize only a mouse can perform is a resize half this app's users
    // cannot perform, so the handle is focusable and takes arrow keys.
    assert.ok(/tabindex="0"/.test(html));
    assert.ok(/aria-valuemin="220"/.test(html) && /aria-valuemax="760"/.test(html));
  });

  it('clamps a stored width that is out of range or not a number', function () {
    const wide = render('WorkspacePanel', {
      sessionId: 's1', workingDir: '/p', transcript: transcript([]),
      settings: { ...VIEW(), panelWidth: 9999 }, onSelectTab() {}, onClose() {},
    });
    assert.ok(/aria-valuenow="760"/.test(wide));

    const broken = render('WorkspacePanel', {
      sessionId: 's1', workingDir: '/p', transcript: transcript([]),
      settings: { ...VIEW(), panelWidth: Number.NaN }, onSelectTab() {}, onClose() {},
    });
    // NaN would render `width: NaNpx`, which the browser drops entirely — the
    // rail would have no width at all.
    assert.ok(/aria-valuenow="320"/.test(broken));
    assert.ok(!/NaN/.test(broken));
  });

  it('drops the handle on a phone, where the rail is the whole screen', function () {
    const html = render('WorkspacePanel', {
      sessionId: 's1', workingDir: '/p', transcript: transcript([]),
      settings: VIEW(), onSelectTab() {}, onClose() {}, isMobile: true,
    });
    assert.ok(!/role="separator"/.test(html));
  });

  it('offers a way out of the panel', function () {
    const html = render('WorkspacePanel', {
      sessionId: 's1',
      workingDir: '/p',
      transcript: transcript([]),
      settings: VIEW(),
      onSelectTab() {},
      onClose() {},
    });
    assert.ok(/aria-label="Close workspace panel"/.test(html));
  });
});

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

describe('AgentsPanel', function () {
  const agentBlock = (toolId, name, status, input) => ({
    kind: 'tool',
    toolId,
    name,
    toolKind: 'task',
    status,
    input,
  });

  it('invites rather than showing a blank pane when nothing is delegated', function () {
    const html = render('AgentsPanel', { transcript: transcript([]) });
    assert.ok(/Nothing delegated yet/.test(html));
  });

  it('lists running agents above finished ones', function () {
    const html = render('AgentsPanel', {
      transcript: transcript([
        assistant('m1', [
          agentBlock('a', 'Agent', 'completed', { subagent_type: 'Explore' }),
          agentBlock('b', 'Agent', 'running', { subagent_type: 'Reviewer', description: 'Check the diff' }),
        ]),
      ]),
    });

    assert.ok(html.indexOf('Reviewer') < html.indexOf('Explore'), 'running work belongs at the top');
    assert.ok(/Check the diff/.test(html));
    assert.ok(/running/.test(html));
    assert.ok(/Finished/.test(html));
  });

  it('marks a workflow with a different icon than a subagent', function () {
    const workflow = render('AgentsPanel', {
      transcript: transcript([assistant('m1', [agentBlock('w', 'Workflow', 'running', { name: 'review' })])]),
    });
    const agent = render('AgentsPanel', {
      transcript: transcript([assistant('m1', [agentBlock('a', 'Agent', 'running', {})])]),
    });
    assert.notStrictEqual(workflow, agent);
  });

  it('renders every tool status without falling through to undefined', function () {
    for (const status of ['pending', 'running', 'completed', 'failed', 'denied', 'canceled']) {
      const html = render('AgentsPanel', {
        transcript: transcript([assistant('m1', [agentBlock('x', 'Agent', status, {})])]),
      });
      assert.ok(!/undefined/.test(html), `status ${status} rendered undefined`);
    }
  });
});

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

describe('LinksPanel', function () {
  it('explains itself when the agent has not started anything', function () {
    const html = render('LinksPanel', { transcript: transcript([]), pageHost: 'localhost' });
    assert.ok(/No local servers mentioned yet/.test(html));
  });

  it('turns a dev server address printed by a tool into a link', function () {
    const html = render('LinksPanel', {
      transcript: transcript([
        assistant('m1', [
          {
            kind: 'tool',
            toolId: 't1',
            name: 'Bash',
            toolKind: 'execute',
            status: 'completed',
            output: '  ➜  Local:   http://localhost:5173/',
          },
        ]),
      ]),
      pageHost: '192.168.1.10',
    });

    assert.ok(/href="http:\/\/192\.168\.1\.10:5173\/"/.test(html));
    assert.ok(/target="_blank"/.test(html));
    // target="_blank" without both of these is a tabnabbing hole.
    assert.ok(/rel="noreferrer noopener"/.test(html));
    // The swap is stated, not silent.
    assert.ok(/printed as http:\/\/localhost:5173\//.test(html));
  });

  it('ignores what the user typed, and reads what the agent said', function () {
    const html = render('LinksPanel', {
      transcript: transcript([
        { id: 'u', seq: 1, turnId: 't', role: 'user', ts: 1, blocks: [{ kind: 'text', text: 'try http://localhost:9999' }] },
      ]),
      pageHost: 'localhost',
    });
    assert.ok(/No local servers mentioned yet/.test(html));
  });
});

// ---------------------------------------------------------------------------
// fetch-backed panels, before their first response
// ---------------------------------------------------------------------------

describe('panels that fetch', function () {
  it('GitChangesPanel shows a header and a loading line, not a blank pane', function () {
    const html = render('GitChangesPanel', { sessionId: 's1' });
    assert.ok(/Changes/.test(html));
    assert.ok(/aria-label="Refresh changes"/.test(html));
  });

  it('GitHubPanel shows a header and a refresh control', function () {
    const html = render('GitHubPanel', { sessionId: 's1' });
    assert.ok(/GitHub/.test(html));
    assert.ok(/aria-label="Refresh github"/.test(html));
  });
});

// ---------------------------------------------------------------------------
// the chat's own settings
// ---------------------------------------------------------------------------

describe('ChatSettingsDialog', function () {
  it('renders nothing when closed', function () {
    assert.strictEqual(render('ChatSettingsDialog', {
      open: false,
      settings: VIEW(),
      onChange() {},
      onClose() {},
    }), '');
  });

  it('offers only display choices — nothing that changes what an agent may do', function () {
    const html = render('ChatSettingsDialog', {
      open: true,
      settings: VIEW(),
      onChange() {},
      onClose() {},
    });

    for (const label of ['Workspace panel', 'Files', 'Changes', 'GitHub', 'Agents', 'Links', 'Reasoning', 'Tool calls', 'Plan', 'Usage']) {
      assert.ok(html.includes(label), `missing "${label}"`);
    }

    // The app-wide dialog's controls must not have followed it here.
    for (const stray of ['Font size', 'Colorway', 'Terminal font', 'Runtime profiles', 'Install app']) {
      assert.ok(!html.includes(stray), `"${stray}" belongs to the app settings dialog`);
    }
    // And nothing here may look like it grants an agent permission.
    assert.ok(!/bypass/i.test(html), 'approvals are a launch decision, not a display one');
  });

  it('says out loud that hiding tool cards does not stop the tools', function () {
    const html = render('ChatSettingsDialog', {
      open: true,
      settings: VIEW(),
      onChange() {},
      onClose() {},
    });
    assert.ok(/the tools still run/.test(html));
  });

  it('names every switch for a screen reader', function () {
    const html = render('ChatSettingsDialog', {
      open: true,
      settings: VIEW(),
      onChange() {},
      onClose() {},
    });
    const switches = (html.match(/role="switch"/g) || []).length;
    const labelled = (html.match(/role="switch"[^>]*aria-label="/g) || []).length;
    assert.ok(switches >= 9, `expected a switch per setting, found ${switches}`);
    assert.strictEqual(labelled, switches, 'every switch needs an accessible name');
  });
});

// ---------------------------------------------------------------------------
// the file editor
// ---------------------------------------------------------------------------

describe('CodeEditor', function () {
  it('lays the highlight and the textarea out identically', function () {
    // The whole illusion rests on this: if the two layers disagree about font,
    // size, line height, padding or wrapping, the highlight slides out from
    // under the caret and it reads as a rendering bug.
    const html = render('CodeEditor', { value: 'const a = 1;\n', language: 'ts' });

    const pre = html.match(/<pre[^>]*style="([^"]*)"/);
    const textarea = html.match(/<textarea[^>]*style="([^"]*)"/);
    assert.ok(pre && textarea, 'both layers should render');

    for (const property of ['font-family', 'font-size', 'line-height', 'padding', 'white-space', 'tab-size']) {
      const from = (style) => (style.match(new RegExp(`${property}:([^;]*)`)) || [])[1];
      assert.strictEqual(from(pre[1]), from(textarea[1]), `${property} must match`);
    }
  });

  it('hides the textarea text and keeps its caret visible', function () {
    const html = render('CodeEditor', { value: 'x', language: null });
    const textarea = html.match(/<textarea[^>]*style="([^"]*)"/)[1];
    assert.ok(/color:transparent/.test(textarea.replace(/\s/g, '')));
    assert.ok(/caret-color/.test(textarea));
  });

  it('highlights through the shared token roles, not its own colours', function () {
    const html = render('CodeEditor', { value: 'const a = 1;', language: 'ts' });
    assert.ok(/var\(--ansi-/.test(html), 'colours come from the terminal palette');
  });

  it('numbers every line, including the last', function () {
    const html = render('CodeEditor', { value: 'a\nb\nc', language: null });
    const gutter = html.match(/<div[^>]*aria-hidden="true"[^>]*>([\s\S]*?)<\/div>/);
    assert.ok(gutter && /1/.test(gutter[1]) && /3/.test(gutter[1]));
  });

  it('renders a huge file plain rather than tokenising it per keystroke', function () {
    const html = render('CodeEditor', { value: 'const a = 1;\n'.repeat(12000), language: 'ts' });
    assert.ok(!/var\(--ansi-/.test(html), 'past the limit it should not highlight');
  });

  it('marks a read-only file as such for assistive tech', function () {
    const html = render('CodeEditor', { value: 'x', readOnly: true });
    assert.ok(/readonly/i.test(html));
  });

  it('moves the highlight by transform, not by scrolling it', function () {
    // Setting scrollLeft on the <pre> clamps to *its* maximum, which is smaller
    // than the textarea's by the width of the textarea's scrollbar — so at the
    // end of a long line the highlight came to rest right of the caret.
    const html = render('CodeEditor', { value: 'a'.repeat(400), language: null });
    const pre = html.match(/<pre[^>]*style="([^"]*)"/)[1].replace(/\s/g, '');
    assert.ok(/will-change:transform/.test(pre), 'the pre is translated, so it must say so');
    assert.ok(!/overflow:hidden/.test(pre), 'the pre must not clip its own content');
  });
});

describe('FileEditorDialog', function () {
  it('renders nothing when closed', function () {
    assert.strictEqual(
      render('FileEditorDialog', { open: false, sessionId: 's1', filePath: '/p/a.ts', onClose() {} }),
      '',
    );
  });

  it('anchors to the bottom on a phone, where a centred footer is unreachable', function () {
    const phone = render('FileEditorDialog', {
      open: true, sessionId: 's1', filePath: '/p/a.ts', onClose() {}, isMobile: true,
    });
    const desktop = render('FileEditorDialog', {
      open: true, sessionId: 's1', filePath: '/p/a.ts', onClose() {},
    });
    // The bottom sheet keeps its safe-area padding; the centred panel does not.
    assert.ok(/safe-area-inset-bottom/.test(phone));
    assert.ok(!/safe-area-inset-bottom/.test(desktop));
  });

  it('names the file it is opening while it loads', function () {
    const html = render('FileEditorDialog', {
      open: true, sessionId: 's1', filePath: '/p/src/app.ts', onClose() {},
    });
    assert.ok(/role="dialog"/.test(html));
    assert.ok(/app\.ts/.test(html));
    // Not a blank modal with a spinner and no explanation.
    assert.ok(/Opening/.test(html));
  });
});

/**
 * The Monaco wrapper, before its chunk has arrived.
 *
 * Static rendering runs no effects, so this is exactly the state a real browser
 * is in for the moment between opening a file and 4.6 MB landing — and the
 * state it stays in for good when the fetch fails, which on a LAN-hosted app
 * updated by restarting a service is not hypothetical. Either way the file has
 * to be readable and editable, so the built-in editor is what fills it.
 */
describe('MonacoEditor', function () {
  it('shows the built-in editor rather than a blank rectangle while Monaco loads', function () {
    const html = render('MonacoEditor', {
      value: 'const a = 1;\n',
      language: 'ts',
      path: 'src/a.ts',
      ariaLabel: 'Contents of src/a.ts',
    });

    assert.ok(html.includes('data-monaco-host="loading"'), 'the host Monaco attaches to must exist first');
    assert.ok(html.includes('<textarea'), 'and the fallback editor must be what is on screen until it does');
    assert.ok(html.includes('aria-label="Contents of src/a.ts"'), 'the fallback carries the same label');
    assert.ok(html.includes('const'), 'the file contents are readable immediately');
  });

  it('passes read-only through to the fallback', function () {
    const html = render('MonacoEditor', { value: 'x', readOnly: true });
    assert.ok(/<textarea[^>]*readonly/i.test(html), 'a read-only file must not be editable in the fallback either');
  });

  it('renders without a path, which is what an unsaved buffer has', function () {
    const html = render('MonacoEditor', { value: 'plain text' });
    assert.ok(html.includes('plain text'));
  });
});
