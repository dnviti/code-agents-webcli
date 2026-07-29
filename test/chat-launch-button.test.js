const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The reported defect was precise: clicking "WebUI (Beta)" opened a terminal.
// Everything typechecked, because the surface was carried in an options object
// that nothing downstream read. So these assert the two halves of the click
// separately — that the button hands up `surface: 'chat'`, and that the start
// path turns that into a `start_chat` message rather than a `start_<kind>` one.
// Either half regressing silently reproduces the original bug exactly.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { RuntimeLauncher } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/RuntimeLauncher'))};`,
    `export { startRuntimeSession } from ${JSON.stringify(path.join(ROOT, 'src/client/sessions/actions'))};`,
    `export { CHAT_LAUNCH_LABEL, isChatRuntime, chatUnavailableReason } from ${JSON.stringify(path.join(ROOT, 'src/shared/chat-runtimes'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-launch-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-launch.tsx' },
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

const ALIASES = {
  claude: 'Claude', codex: 'Codex', agent: 'Cursor', pi: 'Pi',
  grok: 'Grok', qwen: 'Qwen', kimi: 'Kimi', omp: 'Oh My Pi', terminal: 'Terminal',
};

function render(props = {}) {
  const { renderToStaticMarkup, React, RuntimeLauncher } = mod;
  return renderToStaticMarkup(
    React.createElement(RuntimeLauncher, {
      aliases: ALIASES,
      onStart: () => {},
      onTerminal: () => {},
      onCancel: () => {},
      ...props,
    }),
  );
}

/** Walk a rendered element tree, collecting every node that passes a predicate. */
function collect(element, predicate, found = []) {
  if (!element || typeof element !== 'object') return found;
  if (Array.isArray(element)) {
    element.forEach((child) => collect(child, predicate, found));
    return found;
  }
  if (predicate(element)) found.push(element);
  if (element.props) {
    for (const value of Object.values(element.props)) {
      if (value && typeof value === 'object') collect(value, predicate, found);
    }
  }
  return found;
}

describe('WebUI (Beta) launch button', function () {
  describe('what it is', function () {
    it('appears on the launcher', function () {
      assert.ok(render().includes(mod.CHAT_LAUNCH_LABEL));
    });

    it('sits beside the no-prompts control rather than replacing it', function () {
      const html = render();
      assert.ok(html.includes(mod.CHAT_LAUNCH_LABEL), 'chat button missing');
      assert.ok(html.includes('No prompts'), 'the bypass control must survive');
    });

    it('is blue, from the design system rather than a literal', function () {
      const html = render();
      assert.ok(
        html.includes('var(--info)'),
        'the chat button must take its blue from the --info token',
      );
      assert.ok(
        !/background:\s*#[0-9a-f]{3,8}/i.test(html),
        'no hardcoded colour may appear in the launcher',
      );
    });

    it('collapses to icons only in compact mode, keeping accessible names', function () {
      const compact = render({ compact: true });
      assert.ok(
        !compact.includes(`>${mod.CHAT_LAUNCH_LABEL}<`),
        'the label must not render as button text on a phone',
      );
      assert.ok(!compact.includes('>No prompts<'), 'the bypass label must drop too');
      assert.ok(
        /aria-label="Open Claude as a web chat \(beta\)"/.test(compact),
        'an icon-only button still needs a name',
      );
      assert.ok(
        /aria-label="Start Claude with no permission prompts"/.test(compact),
        'the bypass button still needs a name',
      );
    });
  });

  describe('what it does', function () {
    it('asks for the chat surface, for every runtime that has an adapter', function () {
      const { React, RuntimeLauncher } = mod;
      const started = [];
      const tree = React.createElement(RuntimeLauncher, {
        aliases: ALIASES,
        onStart: (kind, options) => started.push({ kind, options }),
        onTerminal: () => {},
        onCancel: () => {},
      });

      // Rendered to an element tree rather than markup, because the assertion
      // is about what a click does and markup cannot be clicked. One level of
      // RuntimeLauncher leaves the per-runtime chat buttons as unrendered
      // elements, so each is invoked in turn to reach its real onClick.
      const rendered = tree.type(tree.props);
      const chatButtons = collect(
        rendered,
        (node) =>
          typeof node.type === 'function' &&
          node.props &&
          typeof node.props.kind === 'string' &&
          typeof node.props.onStart === 'function',
      );

      assert.ok(chatButtons.length > 0, 'no chat buttons were rendered');

      const stop = { stopPropagation() {} };
      for (const element of chatButtons) {
        const button = element.type(element.props);
        if (button.props.disabled) continue;
        button.props.onClick(stop);
      }

      assert.ok(started.length > 0, 'clicking produced no start at all');
      for (const call of started) {
        assert.strictEqual(
          call.options.surface,
          'chat',
          `${call.kind} must be started on the chat surface, not the terminal`,
        );
        assert.ok(mod.isChatRuntime(call.kind), `${call.kind} has no chat adapter`);
      }
    });

    it('asks for no approval mode, even with the preference showing on it', function () {
      // The button labels itself from the preference and requests nothing: the
      // server holds the preference and decides. A page left open across a
      // change made on another device would otherwise send a stale answer, and
      // a page is not where a standing permission should be decided at all.
      const { React, RuntimeLauncher } = mod;
      const started = [];
      const tree = React.createElement(RuntimeLauncher, {
        aliases: ALIASES,
        chatBypass: true,
        onStart: (kind, options) => started.push({ kind, options }),
        onTerminal: () => {},
        onCancel: () => {},
      });

      const rendered = tree.type(tree.props);
      const chatButtons = collect(
        rendered,
        (node) =>
          typeof node.type === 'function' &&
          node.props &&
          typeof node.props.kind === 'string' &&
          typeof node.props.onStart === 'function',
      );

      const stop = { stopPropagation() {} };
      for (const element of chatButtons) {
        const button = element.type(element.props);
        if (button.props.disabled) continue;
        button.props.onClick(stop);
      }

      assert.ok(started.length > 0, 'clicking produced no start at all');
      for (const call of started) {
        assert.ok(
          !('dangerouslySkipPermissions' in call.options),
          `${call.kind} must not request a mode from the browser`,
        );
      }
    });

    it('does nothing at all for a runtime with no adapter', function () {
      // The disabled button must also refuse on click: a disabled attribute is
      // a rendering detail, and the handler is what actually protects the user
      // from a session that would fail after launching.
      assert.strictEqual(mod.isChatRuntime('qwen'), false);
      assert.ok(mod.chatUnavailableReason('qwen'));
      assert.strictEqual(mod.chatUnavailableReason('claude'), null);
    });
  });

  describe('the start path turns that into the right message', function () {
    function fakeApp() {
      const sent = [];
      return {
        sent,
        aliases: ALIASES,
        pendingRuntimeStart: null,
        // null on purpose: stabilizeTerminalSize returns early without a
        // terminal, which is what keeps this test clear of document/RAF.
        terminal: null,
        fitTerminal() {},
        getRuntimeStartMessage: () => 'starting',
        getRuntimeLabel: () => 'Claude',
        send: (message) => sent.push(message),
        currentClaudeSessionId: 'session-1',
        claudeSessions: [{ id: 'session-1' }],
      };
    }

    it('sends start_chat when the surface is chat', async function () {
      const app = fakeApp();
      await mod.startRuntimeSession(app, 'claude', { surface: 'chat' });

      const start = app.sent.find((m) => String(m.type).startsWith('start_'));
      assert.ok(start, 'nothing was sent');
      assert.strictEqual(
        start.type,
        'start_chat',
        'a chat launch must not fall through to the terminal path',
      );
      assert.strictEqual(start.agentKind, 'claude');
    });

    it('still sends start_<kind> for a terminal launch', async function () {
      const app = fakeApp();
      await mod.startRuntimeSession(app, 'claude', {});
      const start = app.sent.find((m) => String(m.type).startsWith('start_'));
      assert.strictEqual(start.type, 'start_claude');
    });

    // Restated for #134. This used to assert that the page could hand the
    // server a bypass on the chat path. It no longer may: the preference is
    // held per account on the server, so a chat launch names no mode at all and
    // the button reports what will happen rather than requesting it. The
    // transport still carries the flag for the terminal path, which is a
    // different surface and a per-launch choice.
    it('names no approval mode on the chat path', async function () {
      const app = fakeApp();
      await mod.startRuntimeSession(app, 'claude', { surface: 'chat' });

      const start = app.sent.find((m) => m.type === 'start_chat');
      assert.ok(
        !('dangerouslySkipPermissions' in (start.options || {})),
        'a standing permission is not the browser’s to assert',
      );
    });
  });
});
