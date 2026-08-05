const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('project folder browser client namespace', function () {
  let built;
  let mod;

  before(function () {
    built = path.join(os.tmpdir(), `project-folder-client-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: {
        contents: [
          `export { FolderBrowser } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/folder-browser'))};`,
          `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
        ].join('\n'),
        resolveDir: ROOT,
        loader: 'ts',
        sourcefile: 'project-folder-client.ts',
      },
      bundle: true,
      outfile: built,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(built);
  });

  after(function () {
    fs.rmSync(built, { force: true });
  });

  it('does not carry a project container path into the next legacy folder request', async function () {
    const requests = [];
    const app = {
      currentFolderPath: '/home/legacy',
      selectedWorkingDir: null,
      currentClaudeSessionId: 'project-session',
      isCreatingNewSession: false,
      authFetch: async (url) => {
        requests.push(String(url));
        const project = String(url).includes('projectId=project-1');
        return {
          ok: true,
          json: async () => project
            ? {
                currentPath: '/tmp/project-only', parentPath: '/tmp', folders: [],
                workingDirKind: 'container', lifetime: 'disposable',
              }
            : {
                currentPath: '/home/legacy', parentPath: '/home', folders: [],
                workingDirKind: 'host',
              },
        };
      },
    };
    const browser = new mod.FolderBrowser(app);

    mod.shellStore.setState({
      activeId: 'project-session',
      tabs: [{ id: 'project-session', projectId: 'project-1', workingDir: '/host/checkout' }],
    });
    await browser.show();
    assert.match(requests[0], /projectId=project-1/);
    assert.match(requests[0], /sessionId=project-session/);
    assert.strictEqual(app.currentFolderPath, '/home/legacy');

    mod.shellStore.setState({
      activeId: 'legacy-session',
      tabs: [{ id: 'legacy-session', projectId: null, workingDir: '/home/legacy' }],
    });
    await browser.show();
    assert.doesNotMatch(requests[1], /projectId=/);
    assert.match(requests[1], /path=%2Fhome%2Flegacy/);
    assert.doesNotMatch(requests[1], /project-only/);
  });

  it('captures the confirmed new-session server and never sends another server path to it', async function () {
    const requests = [];
    const app = {
      currentFolderPath: '/from/previous-server',
      selectedWorkingDir: '/from/previous-server',
      currentClaudeSessionId: null,
      isCreatingNewSession: true,
      startPromptRequested: false,
      authFetch: async (url, options = {}, serverId = null) => {
        requests.push({ url: String(url), options, serverId });
        if (String(url).startsWith('/api/folders?')) {
          return {
            ok: true,
            json: async () => ({
              currentPath: '/remote/home', parentPath: '/remote', folders: [],
              workingDirKind: 'host',
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            sessionId: 'qualified-session',
            session: { name: 'home', workingDir: '/remote/home' },
          }),
        };
      },
      sessionTabManager: {
        addTab() {},
        async switchToTab() {},
      },
      loadSessions() {},
    };
    const browser = new mod.FolderBrowser(app);

    mod.shellStore.setState({ activeId: null, tabs: [] });
    await browser.show({ host: true, serverId: 'remote' });
    assert.strictEqual(requests[0].serverId, 'remote');
    assert.doesNotMatch(requests[0].url, /from%2Fprevious-server/);
    assert.strictEqual(app.currentFolderPath, '/remote/home');

    await browser.selectCurrentFolder();
    assert.strictEqual(requests[1].serverId, 'remote');
    assert.deepStrictEqual(JSON.parse(requests[1].options.body), {
      name: 'home',
      workingDir: '/remote/home',
      serverId: 'remote',
    });
  });

  it('queries resumable conversations by the active tab project and namespace', function () {
    const source = fs.readFileSync(path.join(ROOT, 'src/client/shell/mount.tsx'), 'utf8');
    assert.match(source, /const active = state\.tabs\.find\(\(tab\) => tab\.id === state\.activeId\)/);
    assert.match(source, /query\.set\('projectId', location\.projectId\)/);
    assert.match(source, /query\.set\('workingDirKind', location\.workingDirKind \|\| 'host'\)/);
    assert.match(source, /fetchResumable\(app, \{ workingDir, projectId, workingDirKind \}\)/);
    assert.match(source, /conversation\.projectId,[\s\S]*conversation\.projectName,[\s\S]*conversation\.workingDirKind/);
  });
});
