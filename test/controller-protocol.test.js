'use strict';

const assert = require('node:assert');
const {
  parseQualifiedSessionId,
  qualifyOwnedAttachment,
  qualifyServerMessage,
  qualifySessionId,
  qualifySessionList,
  resolveClientMessage,
  splitSessionsByServer,
} = require('../desktop/controller-protocol.js');

describe('desktop controller protocol', function () {
  it('round-trips arbitrary server-local ids without allowing alternate encodings', function () {
    const qualified = qualifySessionId('server:one', '../same/session?id=1');
    assert.deepStrictEqual(parseQualifiedSessionId(qualified), {
      serverId: 'server:one',
      sessionId: '../same/session?id=1',
    });
    assert.strictEqual(parseQualifiedSessionId('ordinary-server-session-id'), null);
    assert.strictEqual(parseQualifiedSessionId(`${qualified}=`), null);
    assert.throws(() => qualifySessionId('', 'session'), /Server id/);
  });

  it('keeps colliding session ids distinct in aggregate lists', function () {
    const local = qualifySessionList(
      { id: 'local', name: 'Local computer', status: 'ready' },
      [{ id: 'same', name: 'Local work', lastActivity: 1 }],
    );
    const remote = qualifySessionList(
      { id: 'remote', name: 'Build host', status: 'offline', insecure: true },
      [{ id: 'same', name: 'Remote work', lastActivity: 2 }],
    );
    assert.notStrictEqual(local[0].id, remote[0].id);
    assert.strictEqual(local[0].serverName, 'Local computer');
    assert.strictEqual(local[0].offline, false);
    assert.strictEqual(remote[0].serverName, 'Build host');
    assert.strictEqual(remote[0].offline, true);
    assert.strictEqual(remote[0].serverInsecure, true);
  });

  it('qualifies only protocol-level session fields on upstream messages', function () {
    const message = qualifyServerMessage('remote', {
      type: 'session_tabs_reordered',
      sessionId: 'one',
      sessionIds: ['one', 'two'],
      project: { id: 'must-not-change' },
    });
    assert.deepStrictEqual(parseQualifiedSessionId(message.sessionId), {
      serverId: 'remote', sessionId: 'one',
    });
    assert.deepStrictEqual(message.sessionIds.map(parseQualifiedSessionId), [
      { serverId: 'remote', sessionId: 'one' },
      { serverId: 'remote', sessionId: 'two' },
    ]);
    assert.deepStrictEqual(message.project, { id: 'must-not-change' });
    assert.strictEqual(message.serverId, 'remote');
  });

  it('routes one client message to the server that owns its session', function () {
    const sessionId = qualifySessionId('remote', 'upstream-id');
    assert.deepStrictEqual(resolveClientMessage({
      type: 'chat_send', sessionId, text: 'hello', serverId: 'remote',
    }), {
      serverId: 'remote',
      message: { type: 'chat_send', sessionId: 'upstream-id', text: 'hello' },
    });
    assert.deepStrictEqual(resolveClientMessage({ type: 'input', data: 'x' }, 'local'), {
      serverId: 'local', message: { type: 'input', data: 'x' },
    });
    assert.throws(
      () => resolveClientMessage({ type: 'input', data: 'x' }),
      /target server/,
    );
    assert.throws(
      () => resolveClientMessage({ type: 'join_session', sessionId, serverId: 'local' }),
      /does not own/,
    );
  });

  it('qualifies attachment URLs for display and restores them for the owning server', function () {
    const message = qualifyServerMessage('remote', {
      type: 'chat_snapshot',
      sessionId: 'same/id',
      nested: { attachments: [{ url: '/api/sessions/same%2Fid/chat-attachments/image.png', name: 'image' }] },
    });
    const url = message.nested.attachments[0].url;
    assert.match(url, /^\/api\/sessions\/ccs1\./);
    assert.deepStrictEqual(resolveClientMessage({
      type: 'chat_send',
      sessionId: message.sessionId,
      attachments: [{ url }],
    }), {
      serverId: 'remote',
      message: {
        type: 'chat_send',
        sessionId: 'same/id',
        attachments: [{ url: '/api/sessions/same%2Fid/chat-attachments/image.png' }],
      },
    });
    assert.throws(() => resolveClientMessage({
      type: 'chat_send',
      sessionId: message.sessionId,
      attachments: [{ url: `/api/sessions/${encodeURIComponent(qualifySessionId('other', 'same/id'))}/chat-attachments/image.png` }],
    }), /does not own/);
  });

  it('rejects upstream attachment capabilities outside the message session', function () {
    const base = { type: 'chat_snapshot', sessionId: 'same/id' };
    for (const url of [
      '/api/sessions/other/chat-attachments/image.png',
      '/api/sessions/same%2fid/chat-attachments/image.png',
      `/api/sessions/${encodeURIComponent(qualifySessionId('remote', 'same/id'))}/chat-attachments/image.png`,
      `/api/sessions/${encodeURIComponent(qualifySessionId('other', 'same/id'))}/chat-attachments/image.png`,
    ]) {
      assert.throws(() => qualifyServerMessage('remote', {
        ...base, attachments: [{ url }],
      }), /attachment URL|qualified session id/i);
    }
    assert.throws(() => qualifyServerMessage('remote', {
      type: 'chat_snapshot', attachments: [{ url: '/api/sessions/same%2Fid/chat-attachments/image.png' }],
    }), /message session/i);
  });

  it('accepts only the exact uploaded session capability from a target', function () {
    const value = qualifyOwnedAttachment('remote', 'same/id', {
      url: '/api/sessions/same%2Fid/chat-attachments/stored-image.png',
      name: 'image.png', mime: 'image/png', size: 3,
    });
    const qualifiedId = decodeURIComponent(/^\/api\/sessions\/([^/]+)/.exec(value.url)[1]);
    assert.deepStrictEqual(parseQualifiedSessionId(qualifiedId), {
      serverId: 'remote', sessionId: 'same/id',
    });
    for (const url of [
      'http://127.0.0.1:9999/private',
      '/api/sessions/other/chat-attachments/stored-image.png',
      `/api/sessions/${encodeURIComponent(qualifySessionId('other', 'same/id'))}/chat-attachments/stored-image.png`,
      '/api/sessions/same%2Fid/chat-attachments/stored-image.png?target=other',
      '/api/sessions/same%2Fid/chat-attachments/%2Fetc',
    ]) {
      assert.throws(() => qualifyOwnedAttachment('remote', 'same/id', {
        url, name: 'image.png', mime: 'image/png', size: 3,
      }), /attachment URL/i);
    }
  });

  it('rejects cross-server writes while allowing a visual order to split locally', function () {
    const local = qualifySessionId('local', 'one');
    const remote = qualifySessionId('remote', 'two');
    assert.throws(
      () => resolveClientMessage({ type: 'reorder_tabs', sessionIds: [local, remote] }),
      /cross-server/,
    );
    assert.deepStrictEqual(
      Array.from(splitSessionsByServer([remote, local, qualifySessionId('remote', 'three')])),
      [['remote', ['two', 'three']], ['local', ['one']]],
    );
  });
});
