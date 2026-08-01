const assert = require('assert');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

describe('MessageProcessor', function() {
  it('replays transcript-backed history when joining a session', async function() {
    const sentMessages = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send(payload) {
        sentMessages.push(JSON.parse(payload));
      },
    };

    const session = createSessionRecord({
      id: 'session-1',
      ownerUserId: 7,
      projectId: 'project-1',
      outputBuffer: ['recent output'],
    });

    const processor = new MessageProcessor({
      dev: false,
      claudeSessions: new Map([[session.id, session]]),
      webSocketConnections: new Map([
        ['ws-1', {
          id: 'ws-1',
          ws,
          userId: 7,
          githubLogin: 'tester',
          claudeSessionId: null,
          created: new Date(),
        }],
      ]),
      baseFolder: '/tmp',
      sessionDurationHours: 5,
      aliases: { claude: 'Claude', codex: 'Codex', agent: 'Cursor' },
      validatePath() {
        return { valid: true, path: '/tmp' };
      },
      getSelectedWorkingDir() {
        return '/tmp';
      },
      createSessionRecord(params) {
        return createSessionRecord(params);
      },
      getRuntimeBridge() {
        return null;
      },
      saveSessionsToDisk() {
        return Promise.resolve();
      },
      projectsManager: {
        getForUser() {
          return { id: 'project-1', name: 'Project One' };
        },
        ensureForSession() {
          return Promise.resolve({ ok: false, reason: 'building' });
        },
      },
      historyStore: {
        append() {},
        stat() {
          return Promise.resolve({ firstLine: 0, totalLines: 0 });
        },
        read() {
          return Promise.resolve({ firstLine: 0, totalLines: 0, fromLine: 0, lines: [] });
        },
        deleteHistory() {
          return Promise.resolve();
        },
      },
      transcriptStore: {
        ensureTranscript() {
          return Promise.resolve('/tmp/session-1.md');
        },
        appendOutput() {},
        readTranscriptChunks() {
          return Promise.resolve(['saved transcript']);
        },
        deleteTranscript() {
          return Promise.resolve();
        },
      },
      usageReader: {
        getCurrentSessionStats() {
          return Promise.resolve(null);
        },
        calculateBurnRate() {
          return Promise.resolve(null);
        },
        detectOverlappingSessions() {
          return Promise.resolve([]);
        },
        getUsageStats() {
          return Promise.resolve(null);
        },
      },
      usageAnalytics: {
        startSession() {},
        addUsageData() {},
        getAnalytics() {
          return {};
        },
      },
    });

    await processor.joinSession('ws-1', 'session-1');

    const joinedMessage = sentMessages.find((message) => message.type === 'session_joined');
    assert(joinedMessage);
    assert.deepStrictEqual(joinedMessage.outputBuffer, ['saved transcript']);
    assert.strictEqual(joinedMessage.projectId, 'project-1');
    assert.strictEqual(joinedMessage.projectName, 'Project One');

    processor.deps.createSessionRecord = (params) => createSessionRecord({
      ...params,
      projectId: 'project-1',
    });
    await processor.createAndJoinSession('ws-1', 'Created', '/tmp');
    const createdMessage = sentMessages.find((message) => message.type === 'session_created');
    assert(createdMessage);
    assert.strictEqual(createdMessage.projectId, 'project-1');
    assert.strictEqual(createdMessage.projectName, 'Project One');
  });
});

function createSessionRecord(overrides = {}) {
  const created = new Date();

  return {
    id: 'session-1',
    ownerUserId: 1,
    name: 'Test Session',
    created,
    lastActivity: created,
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    terminalOptions: null,
    stopRequested: false,
    workingDir: '/tmp',
    connections: new Set(),
    outputBuffer: [],
    sessionStartTime: null,
    sessionUsage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalCost: 0,
      models: {},
    },
    maxBufferSize: 1000,
    ...overrides,
  };
}
