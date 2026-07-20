const assert = require('assert');
const { UpdateChecker } = require('../dist/server/services/update-check.js');

const INSTALLED = '4a48e81f0000000000000000000000000000abcd';
const REMOTE = 'd79d6d716aa66b0bcb6cfd1323fce6de56399e14';

function buildInfo(overrides = {}) {
  return {
    version: '4.1.0',
    sha: INSTALLED,
    commitDate: '2026-07-19T10:00:00Z',
    dirty: false,
    source: 'git',
    builtAt: '2026-07-19T10:05:00Z',
    ...overrides,
  };
}

/** Records every outbound call and answers from a queue. No real network. */
function recorder(responses) {
  const calls = [];
  const queue = [...responses];

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected request to ${url}`);
    }
    if (next.throws) {
      throw next.throws;
    }

    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(next.headers ?? {}),
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) {
                return { done: true, value: undefined };
              }
              sent = true;
              return { done: false, value: new TextEncoder().encode(body) };
            },
            async cancel() {},
          };
        },
      },
    };
  };

  return { calls, fetchImpl };
}

function settings() {
  const store = {};
  return {
    store,
    getSetting: (key) => (key in store ? store[key] : null),
    setSetting: (key, value) => {
      store[key] = value;
    },
  };
}

function commitBody(sha, message = 'a commit') {
  return { sha, commit: { message, committer: { date: '2026-07-20T14:31:26Z' } } };
}

describe('UpdateChecker', function () {
  it('reports up to date and never calls compare when the shas match', async function () {
    const { calls, fetchImpl } = recorder([{ body: commitBody(INSTALLED) }]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'up_to_date');
    assert.strictEqual(calls.length, 1, 'a matching sha needs exactly one request');
  });

  it('counts how far behind the build is', async function () {
    const { calls, fetchImpl } = recorder([
      { body: commitBody(REMOTE) },
      { body: { status: 'ahead', ahead_by: 4, total_commits: 4 } },
    ]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'behind');
    assert.strictEqual(status.behindBy, 4);
    assert.strictEqual(status.remote.short, 'd79d6d7');
    assert.strictEqual(calls.length, 2);
    // base = installed, head = main.
    assert.match(calls[1].url, /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/);
    assert.ok(calls[1].url.includes(`${INSTALLED}...${REMOTE}`));
  });

  it('still reports behind when compare 404s on a vanished commit', async function () {
    const { fetchImpl } = recorder([
      { body: commitBody(REMOTE) },
      { status: 404, body: { message: 'Not Found' } },
    ]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'behind');
    assert.strictEqual(status.behindBy, null);
    assert.match(status.message, /no longer on the remote/);
  });

  it('reports behind with no count when the history diverged', async function () {
    const { fetchImpl } = recorder([
      { body: commitBody(REMOTE) },
      { body: { status: 'diverged', ahead_by: 3 } },
    ]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'behind');
    assert.strictEqual(status.behindBy, null);
  });

  it('treats an identical compare as up to date', async function () {
    const { fetchImpl } = recorder([
      { body: commitBody(REMOTE) },
      { body: { status: 'identical' } },
    ]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    assert.strictEqual((await checker.check(true)).state, 'up_to_date');
  });

  it('makes no request at all when the build has no commit identity', async function () {
    const { calls, fetchImpl } = recorder([]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo({ sha: null, source: 'unknown' }),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'unknown_build');
    assert.strictEqual(calls.length, 0);
  });

  it('never offers an update for a modified working tree', async function () {
    const { calls, fetchImpl } = recorder([{ body: commitBody(REMOTE) }]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo({ dirty: true }),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'dev_build');
    // Reinstalling would discard the local changes, so there is no point
    // spending a second request working out the distance.
    assert.strictEqual(calls.length, 1);
  });

  it('resolves to offline instead of rejecting when the network fails', async function () {
    const { fetchImpl } = recorder([{ throws: new Error('ENOTFOUND api.github.com') }]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'offline');
    assert.match(status.message, /Could not reach GitHub/);
  });

  it('does not throw on a malformed body', async function () {
    const { fetchImpl } = recorder([{ body: 'not json at all' }]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'offline');
  });

  it('backs off until the reset time when rate limited, keeping the last result', async function () {
    const now = 1_000_000;
    // The second check happens 20 minutes later, so the reset has to be
    // relative to *that* moment, not to the first one.
    const secondCheckAt = now + 20 * 60 * 1000;
    const { fetchImpl } = recorder([
      { body: commitBody(REMOTE) },
      { body: { status: 'ahead', ahead_by: 2 } },
      {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(secondCheckAt / 1000) + 900),
        },
        body: { message: 'API rate limit exceeded' },
      },
    ]);
    const clock = { value: now };
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => clock.value,
    });

    const first = await checker.check(true);
    assert.strictEqual(first.state, 'behind');

    // Past the interval floor, so the next forced check really goes out.
    clock.value = now + 20 * 60 * 1000;
    const limited = await checker.check(true);
    assert.strictEqual(limited.state, 'rate_limited');
    assert.ok(limited.nextCheckAllowedAt > clock.value);
    // A quota bump must not erase a known-good "update available".
    assert.strictEqual(limited.behindBy, 2);
    assert.strictEqual(limited.remote.sha, REMOTE);
  });

  it('reuses the previous verdict on a 304', async function () {
    const now = 1_000_000;
    const store = settings();
    const { calls, fetchImpl } = recorder([
      { body: commitBody(REMOTE), headers: { etag: 'W/"abc"' } },
      { body: { status: 'ahead', ahead_by: 3 } },
      { status: 304 },
    ]);
    const clock = { value: now };
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: store,
      fetchImpl,
      now: () => clock.value,
    });

    await checker.check(true);
    clock.value = now + 20 * 60 * 1000;
    const unchanged = await checker.check(true);

    assert.strictEqual(unchanged.state, 'behind');
    assert.strictEqual(unchanged.behindBy, 3);
    assert.strictEqual(unchanged.checkedAt, clock.value);
    assert.strictEqual(calls[2].init.headers['If-None-Match'], 'W/"abc"');
    // 304 means nothing changed, so there is nothing to compare.
    assert.strictEqual(calls.length, 3);
  });

  it('holds a minimum interval between outbound calls however often it is asked', async function () {
    const now = 1_000_000;
    const { calls, fetchImpl } = recorder([
      { body: commitBody(INSTALLED) },
      { body: commitBody(INSTALLED) },
    ]);
    const clock = { value: now };
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => clock.value,
    });

    await checker.check(true);
    await checker.check(true);
    await checker.check(true);
    // The floor is the rate-limit budget: any signed-in user can press Check.
    assert.strictEqual(calls.length, 1);

    clock.value = now + 16 * 60 * 1000;
    await checker.check(true);
    assert.strictEqual(calls.length, 2);
  });

  it('sends no credentials', async function () {
    const { calls, fetchImpl } = recorder([{ body: commitBody(INSTALLED) }]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    await checker.check(true);
    const headers = JSON.stringify(calls[0].init.headers);
    assert.doesNotMatch(headers, /authorization|bearer|token/i);
    assert.match(headers, /code-agents-webcli/);
  });

  it('strips escapes and truncates the commit subject', async function () {
    const hostile = `[31mpwned[0m ${'x'.repeat(200)}\nsecond line`;
    const { fetchImpl } = recorder([
      { body: commitBody(REMOTE, hostile) },
      { body: { status: 'ahead', ahead_by: 1 } },
    ]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.ok(!status.remote.subject.includes(''));
    assert.ok(status.remote.subject.length <= 100);
    assert.ok(!status.remote.subject.includes('second line'));
  });

  it('never surfaces a URL supplied by the API response', async function () {
    const { fetchImpl } = recorder([
      {
        body: {
          ...commitBody(REMOTE),
          html_url: 'https://evil.example/pwned',
          url: 'https://evil.example/api',
        },
      },
      { body: { status: 'ahead', ahead_by: 1, html_url: 'https://evil.example/compare' } },
    ]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.ok(!JSON.stringify(status).includes('evil.example'));
  });

  it('rejects an oversized body declared by content-length', async function () {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const { fetchImpl } = recorder([
      { body: huge, headers: { 'content-length': String(huge.length) } },
    ]);
    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'offline');
    // Asserting the reason, not just the state: unparseable JSON also yields
    // 'offline', so without this the test would pass with the cap removed.
    assert.match(status.message, /larger than the allowed maximum/);
  });

  it('stops reading an oversized body that declares no length', async function () {
    // The realistic hostile shape: no content-length, bytes just keep coming.
    // res.text() would buffer all of it before any check could run.
    let cancelled = false;
    let chunksServed = 0;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({}),
      body: {
        getReader() {
          return {
            async read() {
              chunksServed += 1;
              if (chunksServed > 200) {
                return { done: true, value: undefined };
              }
              return { done: false, value: new Uint8Array(64 * 1024) };
            },
            async cancel() {
              cancelled = true;
            },
          };
        },
      },
    });

    const checker = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: settings(),
      fetchImpl,
      now: () => 1000,
    });

    const status = await checker.check(true);
    assert.strictEqual(status.state, 'offline');
    assert.match(status.message, /larger than the allowed maximum/);
    assert.ok(cancelled, 'the reader must be cancelled rather than drained');
    assert.ok(chunksServed < 200, 'reading must stop at the cap');
  });

  it('drops the stored ETag when the installed build changes', async function () {
    const store = settings();
    const { calls, fetchImpl } = recorder([
      { body: commitBody(REMOTE), headers: { etag: 'W/"abc"' } },
      { body: { status: 'ahead', ahead_by: 3 } },
      { body: commitBody(REMOTE) },
      { body: { status: 'identical' } },
    ]);

    const before = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: store,
      fetchImpl,
      now: () => 1000,
    });
    await before.check(true);

    // The self-update installed what main was pointing at, and the process
    // restarted onto the new build.
    const after = new UpdateChecker({
      buildInfo: buildInfo({ sha: REMOTE }),
      settings: store,
      fetchImpl,
      now: () => 2000,
    });
    const status = await after.check(true);

    // Sending the old ETag would earn a 304, and the 304 branch reaffirms the
    // current status — which the build change had just reset to never_checked.
    // The banner would then read "not checked yet" forever.
    assert.strictEqual(calls[2].init.headers['If-None-Match'], undefined);
    assert.strictEqual(status.state, 'up_to_date');
  });

  it('restores a persisted status without spending a request', async function () {
    const store = settings();
    const { calls, fetchImpl } = recorder([
      { body: commitBody(REMOTE) },
      { body: { status: 'ahead', ahead_by: 7 } },
    ]);

    const first = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: store,
      fetchImpl,
      now: () => 1000,
    });
    await first.check(true);
    assert.strictEqual(calls.length, 2);

    // A restart should redraw the same banner, not burn a fresh request.
    const second = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: store,
      fetchImpl,
      now: () => 2000,
    });
    assert.strictEqual(second.getStatus().state, 'behind');
    assert.strictEqual(second.getStatus().behindBy, 7);
  });

  it('discards a persisted status that describes a different build', async function () {
    const store = settings();
    const { fetchImpl } = recorder([
      { body: commitBody(REMOTE) },
      { body: { status: 'ahead', ahead_by: 7 } },
    ]);

    const first = new UpdateChecker({
      buildInfo: buildInfo(),
      settings: store,
      fetchImpl,
      now: () => 1000,
    });
    await first.check(true);

    // After a successful update the installed sha changes; the stored verdict
    // belongs to the build that was replaced.
    const upgraded = new UpdateChecker({
      buildInfo: buildInfo({ sha: REMOTE }),
      settings: store,
      fetchImpl,
      now: () => 2000,
    });
    assert.strictEqual(upgraded.getStatus().state, 'never_checked');
  });
});
