const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The highlighter's load-bearing property is that it is lossless: whatever it
// is handed comes back out, character for character, just partitioned into
// roles. A tokenizer that drops a character silently corrupts code the user is
// about to copy out of the chat, and it would do it in exactly the languages
// nobody tested. So the round-trip is asserted for every sample below, and for
// every prefix of the streaming ones.

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'client', 'chat', 'highlight.ts');

let bundle;
let hl;

before(function () {
  this.timeout(60000);
  bundle = path.join(os.tmpdir(), `chat-highlight-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(SOURCE)};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'chat-highlight-entry.ts',
    },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  hl = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

const SAMPLES = {
  ts: `export async function refresh(token: Token): Promise<void> {\n  // clock skew\n  if (token.exp < now() + SKEW) {\n    await fetch(\`/api/\${token.id}\`, { method: "POST" });\n  }\n}`,
  python: `def refresh(token):\n    """Refresh it."""\n    if token.exp < now() + SKEW:  # skew\n        return {'ok': True, 'n': 0x1f}`,
  shell: `#!/usr/bin/env bash\nset -euo pipefail\nfor f in *.ts; do\n  echo "\${f}" | grep -q 'x' && rm -- "$f"\ndone`,
  json: `{"name": "x", "n": -1.5e3, "ok": true, "sub": {"a": [1, 2]}}`,
  yaml: `services:\n  web:\n    image: "nginx:1.2"  # comment\n    ports: [80, 443]`,
  css: `:root { --brand: #ff0000; }\n.card:hover { padding: 12px; color: var(--brand); }`,
  html: `<div class="card" data-id='3'><!-- note --><span>hi</span></div>`,
  sql: `SELECT id, count(*) FROM users WHERE name = 'x' GROUP BY id LIMIT 10;`,
  go: `func main() {\n\t// go\n\tif err != nil {\n\t\treturn fmt.Errorf("bad: %w", err)\n\t}\n}`,
  rust: `#[derive(Debug)]\npub fn main() -> Result<(), Error> {\n    let x = vec![1, 2];\n    Ok(())\n}`,
  diff: `diff --git a/auth.ts b/auth.ts\n@@ -1,4 +1,4 @@\n-  if (t.exp < now)\n+  if (t.exp < now + SKEW)\n   return x;`,
  markdown: `# Title\n\n- item with \`code\`\n- **bold**`,
};

function roundTrip(source, lang) {
  const tokens = hl.highlight(source, lang);
  return tokens.map((t) => t.text).join('');
}

describe('chat syntax highlighter', function () {
  describe('lossless tokenization', function () {
    for (const [lang, source] of Object.entries(SAMPLES)) {
      it(`reproduces ${lang} source exactly`, function () {
        assert.strictEqual(roundTrip(source, lang), source);
      });
    }

    it('reproduces source for an unknown language', function () {
      const source = 'weird ~~~ !! stuff';
      assert.strictEqual(roundTrip(source, 'brainfuck'), source);
      assert.strictEqual(roundTrip(source, null), source);
    });

    it('stays lossless on every prefix, as a block streams in', function () {
      for (const [lang, source] of Object.entries(SAMPLES)) {
        for (let i = 0; i <= source.length; i++) {
          const prefix = source.slice(0, i);
          assert.strictEqual(
            roundTrip(prefix, lang),
            prefix,
            `${lang} lost characters at prefix ${i}`,
          );
        }
      }
    });

    it('terminates on pathological input', function () {
      // An unterminated string or comment must consume to end of input rather
      // than failing to advance, which would hang the render loop.
      for (const source of ['"never closed', '/* open', '`tpl', "'x", '#{']) {
        assert.strictEqual(roundTrip(source, 'ts'), source);
      }
    });
  });

  describe('classification', function () {
    it('marks keywords, strings and comments in TypeScript', function () {
      const tokens = hl.highlight('const x = "hi"; // note', 'ts');
      const roles = new Set(tokens.map((t) => t.role));
      assert.ok(roles.has('keyword'), 'const should be a keyword');
      assert.ok(roles.has('string'), 'the literal should be a string');
      assert.ok(roles.has('comment'), 'the trailing // should be a comment');
    });

    it('does not treat a keyword inside a string as a keyword', function () {
      const tokens = hl.highlight('const s = "return false";', 'ts');
      const inString = tokens.find((t) => t.text.includes('return false'));
      assert.strictEqual(inString.role, 'string');
    });

    it('classifies diff lines by their marker', function () {
      const tokens = hl.highlight(SAMPLES.diff, 'diff');
      const added = tokens.filter((t) => t.role === 'added');
      const removed = tokens.filter((t) => t.role === 'removed');
      const meta = tokens.filter((t) => t.role === 'meta');
      assert.strictEqual(added.length, 1);
      assert.strictEqual(removed.length, 1);
      assert.ok(meta.length >= 2, 'the --- and @@ lines are metadata');
    });

    it('marks JSON keys apart from JSON strings', function () {
      const tokens = hl.highlight('{"key": "value"}', 'json');
      assert.ok(tokens.some((t) => t.role === 'property' && t.text.includes('key')));
      assert.ok(tokens.some((t) => t.role === 'string' && t.text.includes('value')));
    });
  });

  describe('language resolution', function () {
    it('resolves the aliases agents actually write', function () {
      assert.strictEqual(hl.normalizeLanguage('TSX'), 'js');
      assert.strictEqual(hl.normalizeLanguage('bash'), 'shell');
      assert.strictEqual(hl.normalizeLanguage('yml'), 'yaml');
      assert.strictEqual(hl.normalizeLanguage('patch'), 'diff');
      assert.strictEqual(hl.normalizeLanguage('nonsense'), null);
      assert.strictEqual(hl.normalizeLanguage(undefined), null);
    });

    it('reports what it can highlight', function () {
      assert.strictEqual(hl.canHighlight('python'), true);
      assert.strictEqual(hl.canHighlight('cobol'), false);
    });
  });

  describe('theming', function () {
    it('maps every role to a CSS variable that the theme defines', function () {
      const tokensCss = fs.readFileSync(
        path.join(ROOT, 'src', 'public', 'css', 'relay', 'tokens', 'colors.css'),
        'utf8',
      );
      for (const [role, cssVar] of Object.entries(hl.ROLE_COLOR_VAR)) {
        assert.ok(
          tokensCss.includes(`${cssVar}:`),
          `${role} points at ${cssVar}, which colors.css does not define`,
        );
      }
    });
  });
});
