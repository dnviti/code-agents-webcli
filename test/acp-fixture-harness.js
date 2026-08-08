'use strict';

/**
 * Drive fixture captures through the real ACP adapter on a stubbed pipe.
 *
 * The captures under `test/fixtures/chat` are the bytes that came off a real
 * wire, with response ids numbered for the calls that run actually made. The
 * adapter mints its own ids, so a harness has to deliver each captured
 * response at the id this run's call used. omp's handshake authenticates
 * (its `agent` auth method), which is one call the pre-auth captures do not
 * account for; these helpers keep that re-pointing in one place.
 *
 * - `wire` replaces the pipe: it records what the adapter wrote and answers
 *   `authenticate` straight back with an empty result. omp only asks for the
 *   round trip — the adapter does not read the reply — so this is exactly what
 *   a client that already holds the credentials would do.
 * - `repoint` shifts a captured response id up by one when, and only when,
 *   this run authenticated, so `session/new` and the prompt result land on the
 *   ids they actually hold. Only responses to the adapter's own asks are
 *   moved: a notification carries no id, and a request from the agent is
 *   answered rather than re-pointed.
 * - `feed` replays a run of captured lines through the adapter, re-pointing
 *   each response as it goes. Runnings that never authenticate (grok, kimi)
 *   are replayed byte for byte, exactly as before.
 */

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Stub `writeLine`, recording every message and answering `authenticate`. */
function wire(adapter, sent = []) {
  adapter.writeLine = (payload) => {
    sent.push(payload);
    if (payload.method === 'authenticate') {
      adapter.handleMessage({ jsonrpc: '2.0', id: payload.id, result: {} });
    }
  };
  return sent;
}

/** Deliver a captured line at the id the adapter's own call actually used. */
function repoint(sent, line) {
  if (!sent.some((message) => message.method === 'authenticate')) return line;
  if (line.id === undefined) return line; // a notification
  if (line.result === undefined && line.error === undefined) return line; // a request, not a response
  return { ...line, id: Number(line.id) + 1 };
}

/** Replay captured lines through the adapter, re-pointing as needed. */
async function feed(adapter, lines, sent = []) {
  for (const line of lines) {
    adapter.handleMessage(repoint(sent, line));
    await flush();
  }
}

module.exports = { flush, wire, repoint, feed };
