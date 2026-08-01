const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The markdown parser is client code: it never reaches dist/, esbuild bundles
// it straight into app.bundle.js. Bundling it for Node here is the only way to
// assert on its behaviour rather than merely on whether it compiles.
//
// Two things are being protected. The first is that agent output streams, so
// the parser is handed truncated input several times a second and must have a
// defined answer for every prefix. The second is that its output is a node
// tree with no HTML in it anywhere, which is what makes model text unable to
// become markup — these tests fail if that property is ever weakened.

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'client', 'chat', 'markdown.ts');

let bundle;
let md;

before(function () {
  this.timeout(60000);

  bundle = path.join(os.tmpdir(), `chat-markdown-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(SOURCE)};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'chat-markdown-entry.ts',
    },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });

  md = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

/** Every text leaf in a tree, so a test can assert nothing survived as markup. */
function allText(nodes) {
  const out = [];
  const walk = (list) => {
    for (const node of list || []) {
      if (node.type === 'text' || node.type === 'codespan') out.push(node.value);
      if (node.children) walk(node.children);
      if (node.items) node.items.forEach((item) => walk(item.children));
      if (node.head) node.head.forEach(walk);
      if (node.rows) node.rows.forEach((row) => row.forEach(walk));
      if (node.type === 'code') out.push(node.text);
    }
  };
  walk(nodes);
  return out;
}

function nodeTypes(nodes) {
  return nodes.map((n) => n.type);
}

describe('chat markdown parser', function () {
  describe('blocks', function () {
    it('parses headings with their level', function () {
      const nodes = md.parseMarkdown('# One\n\n### Three');
      assert.deepStrictEqual(nodeTypes(nodes), ['heading', 'heading']);
      assert.strictEqual(nodes[0].level, 1);
      assert.strictEqual(nodes[1].level, 3);
    });

    it('parses a fenced code block with its language', function () {
      const nodes = md.parseMarkdown('```ts\nconst x = 1;\n```');
      assert.strictEqual(nodes[0].type, 'code');
      assert.strictEqual(nodes[0].lang, 'ts');
      assert.strictEqual(nodes[0].text, 'const x = 1;');
      assert.strictEqual(nodes[0].complete, true);
    });

    it('parses unordered, ordered and task lists', function () {
      const bullets = md.parseMarkdown('- one\n- two');
      assert.strictEqual(bullets[0].type, 'list');
      assert.strictEqual(bullets[0].ordered, false);
      assert.strictEqual(bullets[0].items.length, 2);

      const ordered = md.parseMarkdown('3. three\n4. four');
      assert.strictEqual(ordered[0].ordered, true);
      assert.strictEqual(ordered[0].start, 3);

      const tasks = md.parseMarkdown('- [ ] todo\n- [x] done');
      assert.strictEqual(tasks[0].items[0].checked, false);
      assert.strictEqual(tasks[0].items[1].checked, true);
    });

    it('parses a table with alignment', function () {
      const nodes = md.parseMarkdown('| a | b |\n| :- | -: |\n| 1 | 2 |');
      assert.strictEqual(nodes[0].type, 'table');
      assert.deepStrictEqual(nodes[0].align, ['left', 'right']);
      assert.strictEqual(nodes[0].rows.length, 1);
    });

    it('parses blockquotes and rules', function () {
      const nodes = md.parseMarkdown('> quoted\n\n---');
      assert.deepStrictEqual(nodeTypes(nodes), ['quote', 'rule']);
    });
  });

  describe('inline', function () {
    it('parses emphasis, strong and strikethrough', function () {
      const nodes = md.parseInline('*a* **b** ~~c~~');
      const kinds = nodes.map((n) => n.type).filter((t) => t !== 'text');
      assert.deepStrictEqual(kinds, ['em', 'strong', 'strike']);
    });

    it('leaves snake_case identifiers alone', function () {
      // Italicising half of `some_var_name` is worse than not supporting _em_.
      const nodes = md.parseInline('call some_var_name now');
      assert.deepStrictEqual(nodes.map((n) => n.type), ['text']);
      assert.strictEqual(nodes[0].value, 'call some_var_name now');
    });

    it('does not find emphasis inside a code span', function () {
      const nodes = md.parseInline('`a * b * c` after');
      assert.strictEqual(nodes[0].type, 'codespan');
      assert.strictEqual(nodes[0].value, 'a * b * c');
    });

    it('parses links and images', function () {
      const link = md.parseInline('[text](https://example.com)');
      assert.strictEqual(link[0].type, 'link');
      assert.strictEqual(link[0].href, 'https://example.com');

      const image = md.parseInline('![alt](https://example.com/x.png)');
      assert.strictEqual(image[0].type, 'image');
      assert.strictEqual(image[0].alt, 'alt');
    });

    it('preserves absolute Windows paths as inert file-link nodes', function () {
      const drive = String.raw`C:\dev\webcli\src\app.ts:31`;
      const driveLink = md.parseInline(`[app](${drive})`);
      assert.strictEqual(driveLink[0].type, 'filelink');
      assert.strictEqual(driveLink[0].href, drive);

      const unc = String.raw`\\buildbox\work\webcli\src\app.ts:44`;
      const uncLink = md.parseInline(`[app](${unc})`);
      assert.strictEqual(uncLink[0].type, 'filelink');
      assert.strictEqual(uncLink[0].href, unc);
    });

    it('does not treat a drive-relative path as a file link', function () {
      const nodes = md.parseInline(String.raw`[app](C:src\app.ts:31)`);
      assert.strictEqual(nodes.some((node) => node.type === 'filelink'), false);
      assert.ok(allText(nodes).join('').includes('app'));
    });
  });

  describe('streaming input', function () {
    it('renders an unterminated fence as an incomplete code block', function () {
      const nodes = md.parseMarkdown('```py\nprint(1)');
      assert.strictEqual(nodes[0].type, 'code');
      assert.strictEqual(nodes[0].complete, false);
      assert.strictEqual(nodes[0].text, 'print(1)');
    });

    it('never throws on any prefix of a realistic response', function () {
      const full = [
        '# Fixing the race',
        '',
        'I will `read` **auth.ts** and [check](https://example.com) it:',
        '',
        '```ts',
        'if (token.exp < now + SKEW) {',
        '  refresh();',
        '}',
        '```',
        '',
        '| file | change |',
        '| --- | --- |',
        '| auth.ts | +12 -3 |',
        '',
        '- [x] trace refresh',
        '- [ ] add a test',
        '  - nested detail',
        '',
        '> note: clock skew matters',
      ].join('\n');

      for (let i = 0; i <= full.length; i++) {
        const prefix = full.slice(0, i);
        assert.doesNotThrow(() => md.parseMarkdown(prefix), `threw on prefix length ${i}`);
      }
    });

    it('never loses the tail of a partially written line', function () {
      const nodes = md.parseMarkdown('Here is the answ');
      assert.ok(allText(nodes).join('').includes('answ'));
    });
  });

  describe('markup can never be produced from model text', function () {
    it('has no node type that carries raw HTML', function () {
      const nodes = md.parseMarkdown('<script>alert(1)</script>\n\n<img onerror=x>');
      // The parser has no 'html' node at all; angle brackets are just text.
      for (const node of nodes) {
        assert.notStrictEqual(node.type, 'html');
      }
      const text = allText(nodes).join('');
      assert.ok(text.includes('<script>'), 'angle brackets survive as literal text');
    });

    it('refuses javascript: and data: URLs, degrading them to text', function () {
      const dangerous = [
        '[click](javascript:alert(1))',
        '[click](JaVaScRiPt:alert(1))',
        '[click](data:text/html;base64,PHNjcmlwdD4=)',
        '[click](vbscript:msgbox)',
        '[click](//evil.example.com)',
      ];

      for (const source of dangerous) {
        const nodes = md.parseInline(source);
        const links = nodes.filter((n) => n.type === 'link' || n.type === 'filelink');
        assert.strictEqual(links.length, 0, `${source} must not become a link`);
        // It still shows: hiding the attempt would be worse than refusing it.
        assert.ok(allText(nodes).join('').includes('click'));
      }
    });

    it('refuses a non-image data: URL as an image source', function () {
      const nodes = md.parseInline('![x](data:text/html;base64,PHNjcmlwdD4=)');
      assert.strictEqual(nodes.filter((n) => n.type === 'image').length, 0);
    });

    it('allows the schemes an agent legitimately produces', function () {
      for (const url of [
        'https://example.com',
        'http://example.com',
        'mailto:a@b.co',
        '/relative/path',
        './sibling',
        '#anchor',
      ]) {
        const nodes = md.parseInline(`[t](${url})`);
        assert.strictEqual(
          nodes.filter((n) => n.type === 'link').length,
          1,
          `${url} should be linkable`,
        );
      }
    });

    it('allows only image data URLs as images', function () {
      const nodes = md.parseInline('![x](data:image/png;base64,iVBORw0KGgo=)');
      assert.strictEqual(nodes[0].type, 'image');
    });
  });

  describe('markdownToText', function () {
    it('flattens a tree back to readable text', function () {
      const text = md.markdownToText(md.parseMarkdown('# Title\n\n- one\n- two'));
      assert.ok(text.includes('Title'));
      assert.ok(text.includes('one'));
    });

    it('flattens a Windows file link to its visible label', function () {
      const text = md.markdownToText(
        md.parseMarkdown(String.raw`Open [app.ts](C:\dev\webcli\src\app.ts:31)`),
      );
      assert.strictEqual(text, 'Open app.ts');
    });
  });
});
