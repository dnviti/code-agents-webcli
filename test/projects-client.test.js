const assert = require('assert');
const fs = require('fs');
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
    assert.doesNotMatch(store, /projects: ProjectSummary\[\]/);
  });
});
