const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { MessageProcessor } = require('../dist/server/websocket/messages.js');

function harness(answerQuestion) {
  const sent = [];
  const record = { id: 'chat-1', ownerUserId: 7, surface: 'chat' };
  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: new Map([['chat-1', record]]),
    webSocketConnections: new Map([['socket-1', {
      id: 'socket-1',
      ws: {
        readyState: WebSocket.OPEN,
        send(payload) { sent.push(JSON.parse(payload)); },
      },
      userId: 7,
      githubLogin: 'tester',
      claudeSessionId: 'chat-1',
      chatSessionIds: new Set(['chat-1']),
      created: new Date(),
    }]]),
    chatManager: { answerQuestion },
  });
  return { processor, sent };
}

describe('chat question answer acknowledgements', function () {
  let client;
  let clientBundle;

  before(function () {
    const root = path.join(__dirname, '..');
    clientBundle = path.join(os.tmpdir(), `question-answer-ack-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: {
        contents: `export { ChatController } from ${JSON.stringify(path.join(root, 'src/client/chat/controller'))};`,
        resolveDir: root,
        loader: 'ts',
        sourcefile: 'question-answer-ack.ts',
      },
      bundle: true,
      outfile: clientBundle,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      logLevel: 'silent',
    });
    client = require(clientBundle);
  });

  after(function () {
    if (clientBundle) fs.rmSync(clientBundle, { force: true });
  });

  it('correlates an accepted answer with the client submission id', async function () {
    const calls = [];
    const { processor, sent } = harness((...args) => {
      calls.push(args);
      return true;
    });

    await processor.handleMessage('socket-1', {
      type: 'chat_question_answer',
      sessionId: 'chat-1',
      requestId: 'question-1',
      submissionId: 'answer-1',
      optionIds: ['yes'],
      skipped: false,
    });

    assert.deepStrictEqual(calls, [['chat-1', 'question-1', ['yes'], false, undefined]]);
    assert.deepStrictEqual(sent, [{
      type: 'chat_question_answer_ack',
      sessionId: 'chat-1',
      requestId: 'question-1',
      submissionId: 'answer-1',
      accepted: true,
    }]);
  });

  it('negatively acknowledges a duplicate or otherwise rejected answer', async function () {
    const { processor, sent } = harness(() => false);

    await processor.handleMessage('socket-1', {
      type: 'chat_question_answer',
      sessionId: 'chat-1',
      requestId: 'already-answered',
      submissionId: 'answer-duplicate',
      optionIds: ['yes'],
    });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].accepted, false);
    assert.strictEqual(sent[0].submissionId, 'answer-duplicate');
  });

  it('does not acknowledge until the manager durability barrier resolves', async function () {
    let release;
    const { processor, sent } = harness(() => new Promise((resolve) => { release = resolve; }));
    const handling = processor.handleMessage('socket-1', {
      type: 'chat_question_answer',
      sessionId: 'chat-1',
      requestId: 'question-durable',
      submissionId: 'answer-durable',
      optionIds: ['yes'],
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(sent, [], 'a positive ack before persistence can be lost on restart');
    release(true);
    await handling;
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].accepted, true);
  });

  it('keeps the submission pending when the canonical event arrives before its ack', async function () {
    const frames = [];
    const controller = new client.ChatController('chat-1', { send: (frame) => frames.push(frame) });
    let settled = false;
    const accepted = controller.answerQuestion('question-order', ['yes']).then((value) => {
      settled = true;
      return value;
    });
    const submissionId = frames[0].submissionId;

    controller.handle({
      type: 'chat_event',
      sessionId: 'chat-1',
      event: {
        t: 'question_resolved', seq: 1, ts: 1,
        requestId: 'question-order', optionIds: ['yes'],
      },
    });
    await Promise.resolve();
    assert.strictEqual(settled, false, 'the broadcast is authoritative history, not this submission ack');

    controller.handle({
      type: 'chat_question_answer_ack',
      sessionId: 'chat-1',
      requestId: 'question-order',
      submissionId,
      accepted: true,
    });
    assert.strictEqual(await accepted, true);
  });
});
