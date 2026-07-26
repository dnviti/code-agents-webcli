const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The three pure functions the workspace panel is built on. They are the parts
// worth testing directly: everything above them is fetch plumbing, and
// everything below them is git and gh, which do not need re-testing here.
//
// The git fixtures are real output shapes — `-z` porcelain and `git diff`'s
// unified format — because the whole point of parsing the machine format is
// that it is a contract, and a fixture invented by hand tests the invention.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { parseGitStatus, parseUnifiedDiff } from ${JSON.stringify(path.join(ROOT, 'src/shared/git-status'))};`,
    `export { detectServerLinks, rewriteForBrowser } from ${JSON.stringify(path.join(ROOT, 'src/shared/detect-links'))};`,
    `export { collectAgentActivity, countRunning, findToolBlock, parseWorkflowLog } from ${JSON.stringify(path.join(ROOT, 'src/shared/agent-activity'))};`,
    `export { languageForFile, basename } from ${JSON.stringify(path.join(ROOT, 'src/shared/file-language'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `workspace-parsers-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'workspace-parsers.ts' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

// ---------------------------------------------------------------------------
// git status
// ---------------------------------------------------------------------------

describe('parseGitStatus', function () {
  const Z = (...fields) => fields.join('\0') + '\0';

  it('reads the branch, its upstream and how far it has diverged', function () {
    const status = mod.parseGitStatus(Z('## main...origin/main [ahead 2, behind 5]'));
    assert.strictEqual(status.branch, 'main');
    assert.strictEqual(status.upstream, 'origin/main');
    assert.strictEqual(status.ahead, 2);
    assert.strictEqual(status.behind, 5);
    assert.strictEqual(status.detached, false);
  });

  it('reads a branch with no upstream', function () {
    const status = mod.parseGitStatus(Z('## feat/panels'));
    assert.strictEqual(status.branch, 'feat/panels');
    assert.strictEqual(status.upstream, null);
    assert.strictEqual(status.ahead, 0);
  });

  it('recognises a detached HEAD and a repository with no commits', function () {
    assert.strictEqual(mod.parseGitStatus(Z('## HEAD (no branch)')).detached, true);
    assert.strictEqual(mod.parseGitStatus(Z('## No commits yet on main')).branch, 'main');
  });

  it('separates what is staged from what is not', function () {
    const status = mod.parseGitStatus(
      Z('## main', 'M  src/staged.ts', ' M src/dirty.ts', 'MM src/both.ts', '?? src/new.ts'),
    );

    assert.deepStrictEqual(
      status.changes.map((c) => [c.path, c.staged, c.unstaged, c.untracked]),
      [
        ['src/staged.ts', true, false, false],
        ['src/dirty.ts', false, true, false],
        ['src/both.ts', true, true, false],
        ['src/new.ts', false, false, true],
      ],
    );
  });

  it('consumes a rename’s source path instead of listing it as its own change', function () {
    // This is the shape that makes `-z` worth parsing properly: a rename is two
    // NUL-separated fields, and reading them as two records invents a change.
    const status = mod.parseGitStatus(Z('## main', 'R  new/name.ts', 'old/name.ts', 'M  other.ts'));

    assert.strictEqual(status.changes.length, 2);
    assert.strictEqual(status.changes[0].path, 'new/name.ts');
    assert.strictEqual(status.changes[0].oldPath, 'old/name.ts');
    assert.strictEqual(status.changes[0].kind, 'rename');
    assert.strictEqual(status.changes[1].path, 'other.ts');
  });

  it('handles a path containing a newline, which is why -z is used at all', function () {
    const status = mod.parseGitStatus(Z('## main', 'M  weird\nname.txt'));
    assert.deepStrictEqual(status.changes.map((c) => c.path), ['weird\nname.txt']);
  });

  it('flags an unmerged path as conflicted', function () {
    const status = mod.parseGitStatus(Z('## main', 'UU src/conflict.ts'));
    assert.strictEqual(status.changes[0].conflicted, true);
  });

  it('returns an empty, well-formed status for an empty repository', function () {
    const status = mod.parseGitStatus('');
    assert.deepStrictEqual(status.changes, []);
    assert.strictEqual(status.branch, null);
  });
});

// ---------------------------------------------------------------------------
// unified diff
// ---------------------------------------------------------------------------

describe('parseUnifiedDiff', function () {
  const MODIFY = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,6 +10,7 @@ export class App {',
    '   constructor() {',
    '-    this.chat = null;',
    '+    this.chats = new Map();',
    '+    this.ready = true;',
    '   }',
    '',
  ].join('\n');

  it('reads the path, the hunk header and the line counts', function () {
    const [diff] = mod.parseUnifiedDiff(MODIFY);
    assert.strictEqual(diff.path, 'src/app.ts');
    assert.strictEqual(diff.kind, 'update');
    assert.strictEqual(diff.added, 2);
    assert.strictEqual(diff.removed, 1);
    assert.strictEqual(diff.hunks.length, 1);
    assert.deepStrictEqual(
      [diff.hunks[0].oldStart, diff.hunks[0].oldLines, diff.hunks[0].newStart, diff.hunks[0].newLines],
      [10, 6, 10, 7],
    );
  });

  it('separates several files in one diff', function () {
    const both = `${MODIFY}diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;
    assert.deepStrictEqual(
      mod.parseUnifiedDiff(both).map((d) => d.path),
      ['src/app.ts', 'README.md'],
    );
  });

  it('recognises creates, deletes and renames from their headers', function () {
    const created = mod.parseUnifiedDiff(
      [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
        '',
      ].join('\n'),
    );
    assert.strictEqual(created[0].kind, 'create');
    assert.strictEqual(created[0].added, 2);

    const deleted = mod.parseUnifiedDiff(
      ['diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '@@ -1 +0,0 @@', '-x', ''].join('\n'),
    );
    assert.strictEqual(deleted[0].kind, 'delete');

    const renamed = mod.parseUnifiedDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 96%',
        'rename from old.ts',
        'rename to new.ts',
        '',
      ].join('\n'),
    );
    assert.strictEqual(renamed[0].kind, 'rename');
    assert.strictEqual(renamed[0].path, 'new.ts');
    assert.strictEqual(renamed[0].oldPath, 'old.ts');
  });

  it('marks a binary file rather than pretending it has no changes', function () {
    const [diff] = mod.parseUnifiedDiff(
      [
        'diff --git a/logo.png b/logo.png',
        'index aaa..bbb 100644',
        'Binary files a/logo.png and b/logo.png differ',
        '',
      ].join('\n'),
    );
    assert.strictEqual(diff.binary, true);
    assert.deepStrictEqual(diff.hunks, []);
  });

  it('keeps the no-newline marker without counting it as a change', function () {
    const [diff] = mod.parseUnifiedDiff(
      ['diff --git a/a b/a', '@@ -1 +1 @@', '-x', '+y', '\\ No newline at end of file', ''].join('\n'),
    );
    assert.strictEqual(diff.added, 1);
    assert.strictEqual(diff.removed, 1);
    assert.ok(diff.hunks[0].lines.includes('\\ No newline at end of file'));
  });

  it('returns nothing for empty input rather than a phantom file', function () {
    assert.deepStrictEqual(mod.parseUnifiedDiff(''), []);
  });
});

// ---------------------------------------------------------------------------
// detected links
// ---------------------------------------------------------------------------

describe('detectServerLinks', function () {
  it('finds a dev server address in ordinary tool output', function () {
    const output = [
      '  VITE v5.4.2  ready in 312 ms',
      '',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: http://192.168.1.42:5173/',
    ].join('\n');

    const links = mod.detectServerLinks(output, 'localhost');
    assert.deepStrictEqual(links.map((l) => l.label), ['localhost:5173', '192.168.1.42:5173']);
  });

  it('re-points a loopback address at the host the page came from', function () {
    // The reason this exists: the agent runs on the server, the browser is very
    // often a phone, and "localhost" on the phone is the phone.
    const [link] = mod.detectServerLinks('Server running at http://localhost:3000', '192.168.1.10');
    assert.strictEqual(link.url, 'http://192.168.1.10:3000/');
    assert.strictEqual(link.original, 'http://localhost:3000');
  });

  it('re-points a bind-any address even when the browser is local', function () {
    // 0.0.0.0 is never reachable as a destination, so it is wrong everywhere.
    const [link] = mod.detectServerLinks('Listening on http://0.0.0.0:8080/', 'localhost');
    assert.strictEqual(link.url, 'http://localhost:8080/');
  });

  it('leaves an address alone when the browser really is on that machine', function () {
    const [link] = mod.detectServerLinks('http://localhost:4000/app', 'localhost');
    assert.strictEqual(link.url, 'http://localhost:4000/app');
    assert.strictEqual(link.original, link.url);
  });

  it('keeps the scheme the agent printed rather than inheriting the page’s', function () {
    // Inheriting https would produce a link that fails the handshake against a
    // plain-http dev server.
    const [link] = mod.detectServerLinks('http://localhost:3000', '10.0.0.5');
    assert.ok(link.url.startsWith('http://'));
  });

  it('ignores addresses that are not a local server', function () {
    const text = [
      'See https://docs.example.com/guide for details',
      'and https://github.com/dnviti/code-agents-webcli/pull/26',
      'bare http://localhost without a port is prose, not a server',
    ].join('\n');
    assert.deepStrictEqual(mod.detectServerLinks(text, 'localhost'), []);
  });

  it('ignores a privileged port, which is never a dev server worth a button', function () {
    assert.deepStrictEqual(mod.detectServerLinks('http://localhost:22', 'localhost'), []);
  });

  it('drops sentence punctuation that is not part of the address', function () {
    const [link] = mod.detectServerLinks('Open http://localhost:3000/admin.', 'localhost');
    assert.strictEqual(link.url, 'http://localhost:3000/admin');
  });

  it('drops markdown emphasis wrapped around the address', function () {
    // Observed in a real transcript: an agent writing the URL in bold produced
    // a link to a path with two asterisks on the end.
    const [link] = mod.detectServerLinks('Running at **http://localhost:5173/**', 'localhost');
    assert.strictEqual(link.url, 'http://localhost:5173/');

    const [tick] = mod.detectServerLinks('Open `http://localhost:8080/`', 'localhost');
    assert.strictEqual(tick.url, 'http://localhost:8080/');
  });

  it('reports each address once however many times it was printed', function () {
    const links = mod.detectServerLinks(
      'http://localhost:3000 ... http://localhost:3000 ... http://localhost:3001',
      'localhost',
    );
    assert.strictEqual(links.length, 2);
  });
});

// ---------------------------------------------------------------------------
// agent activity
// ---------------------------------------------------------------------------

describe('collectAgentActivity', function () {
  const toolMessage = (ts, ...tools) => ({
    id: `m${ts}`,
    seq: ts,
    turnId: 't',
    role: 'assistant',
    ts,
    blocks: tools.map((tool) => ({ kind: 'tool', toolKind: 'task', ...tool })),
  });

  it('finds a subagent and reads what it was asked to do', function () {
    const [entry] = mod.collectAgentActivity([
      toolMessage(1, {
        toolId: 'toolu_1',
        name: 'Agent',
        status: 'running',
        input: { subagent_type: 'Explore', description: 'Map the chat surface' },
      }),
    ]);

    assert.strictEqual(entry.kind, 'agent');
    assert.strictEqual(entry.name, 'Explore');
    assert.strictEqual(entry.description, 'Map the chat surface');
    assert.strictEqual(entry.running, true);
  });

  it('tells a workflow apart from a subagent', function () {
    const [entry] = mod.collectAgentActivity([
      toolMessage(1, { toolId: 'w1', name: 'Workflow', status: 'pending', input: { name: 'review' } }),
    ]);
    assert.strictEqual(entry.kind, 'workflow');
  });

  it('does not mistake ordinary tools for delegation', function () {
    // The trap this guards: `TodoWrite`, `TaskList` and `MultiEdit` all contain
    // a word that looks like delegation and none of them delegates anything.
    const activity = mod.collectAgentActivity([
      toolMessage(
        1,
        { toolId: 'a', name: 'TodoWrite', status: 'completed' },
        { toolId: 'b', name: 'TaskList', status: 'completed' },
        { toolId: 'c', name: 'Bash', status: 'completed' },
        { toolId: 'd', name: 'Read', status: 'completed' },
      ),
    ]);
    assert.deepStrictEqual(activity, []);
  });

  it('counts only what is still going', function () {
    const activity = mod.collectAgentActivity([
      toolMessage(
        1,
        { toolId: 'a', name: 'Task', status: 'running' },
        { toolId: 'b', name: 'Task', status: 'completed' },
        { toolId: 'c', name: 'Task', status: 'failed' },
        { toolId: 'd', name: 'Task', status: 'pending' },
      ),
    ]);
    assert.strictEqual(activity.length, 4);
    assert.strictEqual(mod.countRunning(activity), 2);
  });

  it('reports one entry per call, not one per update', function () {
    const first = toolMessage(1, { toolId: 'dup', name: 'Agent', status: 'running' });
    const activity = mod.collectAgentActivity([first, first]);
    assert.strictEqual(activity.length, 1);
  });

  it('survives a call whose arguments are still a partial JSON string', function () {
    const [entry] = mod.collectAgentActivity([
      toolMessage(1, { toolId: 'x', name: 'Agent', status: 'pending', inputPartial: '{"desc' }),
    ]);
    assert.strictEqual(entry.name, null);
    assert.strictEqual(entry.description, null);
  });

  it('truncates a prompt used as a description rather than pasting an essay', function () {
    const [entry] = mod.collectAgentActivity([
      toolMessage(1, { toolId: 'x', name: 'Agent', status: 'running', input: { prompt: 'x'.repeat(400) } }),
    ]);
    assert.ok(entry.description.length <= 140);
    assert.ok(entry.description.endsWith('...'));
  });
});

// ---------------------------------------------------------------------------
// workflow popup: finding the live block, reading its log
// ---------------------------------------------------------------------------

describe('findToolBlock', function () {
  const toolMessage = (ts, ...tools) => ({
    id: `m${ts}`,
    seq: ts,
    turnId: 't',
    role: 'assistant',
    ts,
    blocks: tools.map((tool) => ({ kind: 'tool', toolKind: 'task', ...tool })),
  });

  it('finds the block by id, wherever it sits', function () {
    const second = toolMessage(2, { toolId: 'w1', name: 'Workflow', status: 'running' });
    const block = mod.findToolBlock(
      [toolMessage(1, { toolId: 'other', name: 'Bash', status: 'completed' }), second],
      'w1',
    );
    assert.strictEqual(block, second.blocks[0]);
  });

  it('returns null for an id the transcript never held', function () {
    const block = mod.findToolBlock([toolMessage(1, { toolId: 'a', name: 'Bash', status: 'completed' })], 'missing');
    assert.strictEqual(block, null);
  });
});

describe('parseWorkflowLog', function () {
  it('reads narrator headings into sections', function () {
    const sections = mod.parseWorkflowLog('▸ Review\nchecking file a\nchecking file b\n▸ Verify\nall clear');
    assert.deepStrictEqual(sections, [
      { title: 'Review', lines: ['checking file a', 'checking file b'] },
      { title: 'Verify', lines: ['all clear'] },
    ]);
  });

  it('keeps a preamble before the first heading, title null', function () {
    const sections = mod.parseWorkflowLog('starting up\n▸ Review\nlooking around');
    assert.strictEqual(sections[0].title, null);
    assert.deepStrictEqual(sections[0].lines, ['starting up']);
    assert.strictEqual(sections[1].title, 'Review');
  });

  it('falls back to one flat section when nothing looks like a heading', function () {
    const sections = mod.parseWorkflowLog('just some plain output\nmore of the same');
    assert.strictEqual(sections.length, 1);
    assert.strictEqual(sections[0].title, null);
    assert.deepStrictEqual(sections[0].lines, ['just some plain output', 'more of the same']);
  });

  it('returns nothing for output that never arrived', function () {
    assert.deepStrictEqual(mod.parseWorkflowLog(undefined), []);
    assert.deepStrictEqual(mod.parseWorkflowLog(''), []);
  });
});

// ---------------------------------------------------------------------------
// file language
// ---------------------------------------------------------------------------

describe('languageForFile', function () {
  it('reads the language off the extension', function () {
    const cases = {
      'src/app.ts': 'ts',
      'src/App.tsx': 'tsx',
      'a/b/c.js': 'js',
      'main.py': 'python',
      'main.go': 'go',
      'lib.rs': 'rust',
      'run.sh': 'shell',
      'package.json': 'json',
      'docker-compose.yml': 'yml',
      'styles.css': 'css',
      'index.html': 'html',
      'schema.sql': 'sql',
      'README.md': 'markdown',
      'fix.patch': 'diff',
    };
    for (const [file, language] of Object.entries(cases)) {
      assert.strictEqual(mod.languageForFile(file), language, file);
    }
  });

  it('is case-insensitive about the extension', function () {
    assert.strictEqual(mod.languageForFile('README.MD'), 'markdown');
    assert.strictEqual(mod.languageForFile('Main.PY'), 'python');
  });

  it('recognises the files whose whole name is the language', function () {
    assert.strictEqual(mod.languageForFile('Dockerfile'), 'shell');
    assert.strictEqual(mod.languageForFile('/repo/Makefile'), 'shell');
    assert.strictEqual(mod.languageForFile('.gitignore'), 'shell');
    // A suffixed variant is still the same kind of file.
    assert.strictEqual(mod.languageForFile('Dockerfile.dev'), 'shell');
    assert.strictEqual(mod.languageForFile('.env.local'), 'shell');
  });

  it('answers null rather than guessing', function () {
    // Guessing wrong colours the wrong words, which reads as a broken editor.
    for (const file of ['LICENSE', 'notes', 'image.png', 'archive.tar.gz', '', 'trailing.']) {
      assert.strictEqual(mod.languageForFile(file), null, file);
    }
  });

  it('takes the leaf of a path in either separator style', function () {
    assert.strictEqual(mod.basename('/a/b/c.ts'), 'c.ts');
    assert.strictEqual(mod.basename('a\\b\\c.ts'), 'c.ts');
    assert.strictEqual(mod.basename('/a/b/'), 'b');
    assert.strictEqual(mod.basename('bare.ts'), 'bare.ts');
  });
});
