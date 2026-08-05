const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('projects client integration', function () {
  it('propagates late project identity through every websocket session path', function () {
    const messages = read('src/client/terminal/message-handler.ts');
    const tabs = read('src/client/sessions/tab-manager.ts');
    const types = read('src/client/types.ts');

    assert.match(messages, /case 'session_opened':[\s\S]*projectId: message\.projectId,[\s\S]*projectName: message\.projectName/);
    assert.match(messages, /private onSessionCreated[\s\S]*message\.projectId,[\s\S]*message\.projectName/);
    assert.match(messages, /private onSessionJoined[\s\S]*message\.projectId,[\s\S]*message\.projectName/);
    assert.match(tabs, /const existing = this\.tabs\.get\(sessionId\);[\s\S]*existing\.projectId = projectId;[\s\S]*existing\.projectName = projectName;/);
    assert.match(types, /interface WsSessionOpenedMessage[\s\S]*projectId\?: string \| null;[\s\S]*projectName\?: string \| null;/);
  });

  it('keeps keyed build streams and guards uncertain creates from automatic retry', function () {
    const dialog = read('src/client/shell/dialogs/ProjectsDialog.tsx');
    const store = read('src/client/shell/store.ts');

    assert.match(dialog, /sourcesRef = React\.useRef\(new Map<string, EventSource>\(\)\)/);
    assert.match(dialog, /if \(seen\.has\(key\)\) return;/);
    assert.match(dialog, /Project creation has an unknown outcome\. No automatic retry was sent/);
    assert.match(dialog, /disabled=\{mutation\.busy \|\| unknownCreate !== null/);
    assert.match(dialog, /No matching project exists\. It is safe to submit this create again/);
    assert.doesNotMatch(dialog, /Clear without retrying/);
    assert.match(dialog, /credentialRetryRef\.current = null;[\s\S]*setCredentialHost\(null\);[\s\S]*setToken\(''\)/);
    assert.doesNotMatch(store, /projects: ProjectSummary\[\]/);
  });

  it('hydrates durable preservation events from every project list without duplicating SSE history', function () {
    const built = path.join(os.tmpdir(), `projects-events-${process.pid}.js`);
    try {
      require('esbuild').buildSync({
        entryPoints: [path.join(ROOT, 'src/client/shell/projects-types.ts')],
        bundle: true,
        outfile: built,
        format: 'cjs',
        platform: 'node',
        target: ['node20'],
        logLevel: 'silent',
      });
      const { mergeProjectBuildEvents, normalizeProjectAvailability } = require(built);
      const preserved = {
        t: 'preserve',
        branch: 'cc-web/wip/project-1-20260801-2',
        commit: '0123456789abcdef',
        at: '2026-08-01T12:00:00.000Z',
      };
      const live = { t: 'progress', percent: 75, at: '2026-08-01T11:59:00.000Z' };
      const listed = [{
        id: 'project-1',
        buildLog: [
          // Different key order from the SSE object: dedupe is semantic, not
          // dependent on JSON property insertion order.
          { at: preserved.at, commit: preserved.commit, branch: preserved.branch, t: 'preserve' },
        ],
      }];

      const once = mergeProjectBuildEvents({ 'project-1': [live, preserved] }, listed);
      const twice = mergeProjectBuildEvents(once, listed);
      assert.deepStrictEqual(twice['project-1'], [live, preserved]);
      assert.strictEqual(twice['project-1'][1].branch, 'cc-web/wip/project-1-20260801-2');
      assert.strictEqual(twice['project-1'][1].commit, '0123456789abcdef');
      assert.deepStrictEqual(
        normalizeProjectAvailability({ available: true, defaultExecutionKind: 'container' }),
        { available: true, defaultExecutionKind: 'container' },
      );

      const dialog = read('src/client/shell/dialogs/ProjectsDialog.tsx');
      const types = read('src/client/shell/projects-types.ts');
      assert.match(dialog, /mergeListedEventLogs\(projects\)/);
      assert.match(dialog, /for \(const event of project\.buildLog \|\| \[\]\) seen\.add\(buildEventKey\(event\)\)/);
      assert.match(dialog, /Preserved work on \$\{event\.branch\}/);
      assert.match(types, /lastPreservedBranch: string \| null;/);
      assert.match(types, /lastPreservedCommit: string \| null;/);
      assert.match(dialog, /project\.lastPreservedBranch[\s\S]*Recovery branch:[\s\S]*project\.lastPreservedBranch/);
      assert.match(dialog, /project\.lastPreservedCommit[\s\S]*project\.lastPreservedCommit/);
      assert.match(dialog, /\['blocked', 'reclaiming'\]\.includes\(project\.state\)[\s\S]*Retry recovery[\s\S]*Discard/);
      assert.match(dialog, /Retry recovery<\/Button><Button[^>]*disabled=\{mutation\.busy \|\| project\.hasActiveWork\}[\s\S]*>Discard<\/Button>/);
    } finally {
      fs.rmSync(built, { force: true });
    }
  });

  it('states disposable work up front and exposes installer project limits', function () {
    const projects = read('src/client/shell/dialogs/ProjectsDialog.tsx');
    const targets = read('src/client/shell/dialogs/DeployTargetsDialog.tsx');

    assert.match(projects, /This project has no repository\.[\s\S]*permanently discards/);
    assert.match(projects, /!repoUrl\.trim\(\) && !acknowledgeDisposable/);
    assert.match(projects, /targetName[\s\S]*last used/);
    assert.match(projects, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}[\s\S]*'PUT'/);
    assert.match(projects, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/retry/);
    assert.match(projects, /Change repository/);
    assert.match(projects, /Projects need a deploy target/);
    assert.match(projects, /!availability\.available/);
    assert.match(projects, /<strong>Local Projects<\/strong>/);
    assert.match(projects, /local: attempt\.local/);
    assert.match(projects, /project\.executionKind === 'host'/);
    assert.match(targets, /\/api\/admin\/deploy-settings/);
    assert.match(targets, /Running projects per user/);
    assert.match(targets, /Save project settings/);
    assert.match(targets, /idleReclaimMinutes <= settings\.idleStopMinutes/);
    assert.match(targets, /keep None to run them on this machine/);
    assert.match(projects, /stopActive: project\.hasActiveWork/);
    assert.doesNotMatch(projects, /project\.state !== 'running' \|\| project\.hasActiveWork/);
    assert.doesNotMatch(projects, /mutation\.busy \|\| project\.hasActiveWork \|\| project\.state === 'inspecting'/);
  });

  it('offers projects or the normal directory picker when a new tab opens', function () {
    const chooser = read('src/client/shell/dialogs/WorkspaceChooserDialog.tsx');
    const tabs = read('src/client/sessions/tab-manager.ts');
    const app = read('src/client/app.ts');

    assert.match(tabs, /workspaceChooser: true/);
    assert.match(chooser, /controllerFetch\('\/api\/projects'/);
    assert.match(chooser, /listed\.length === 0[\s\S]*onDirectory\(\)/);
    assert.match(chooser, /Choose directory…/);
    assert.match(chooser, /onProject\(project\.id, draftServerId \|\| undefined\)/);
    assert.match(chooser, /This choice applies only after you confirm a project or directory/);
    assert.match(chooser, /disabled: Boolean\(unavailable\)/);
    const mount = read('src/client/shell/mount.tsx');
    assert.match(mount, /createProjectSession\(app: App, projectId: string, serverId\?: string\)/);
    assert.match(mount, /app\.authFetch\('\/api\/sessions\/create',[\s\S]*}, serverId\)/);
    assert.match(mount, /rememberNewSessionServer\(serverId\)/);
    assert.match(chooser, /Show local projects/);
    assert.match(chooser, /project\.executionKind === 'host'/);
    assert.match(app, /this\.sessionTabManager\.createNewSession\(\)/);
  });
});
