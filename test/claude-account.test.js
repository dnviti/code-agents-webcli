const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCachedClaudeAccount } = require('../dist/server/services/claude-account.js');

/**
 * Issue #137: the fallback that reads Claude Code's own config file.
 *
 * The shape below is copied from a real `~/.claude.json` on the machine this
 * was written against — same key names, same nesting, same integer-percentage
 * units, same `limit_dollars: null` — with the identifying fields replaced by
 * obvious fakes precisely so the tests can assert those never come back out.
 */

const REAL_SHAPE = {
  oauthAccount: {
    accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    emailAddress: 'someone@example.com',
    displayName: 'Someone',
    organizationName: "Someone's Org",
    organizationUuid: '11111111-2222-3333-4444-555555555555',
    organizationRole: 'admin',
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_20x',
  },
  cachedUsageUtilization: {
    fetchedAtMs: 0,
    accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    utilization: {
      five_hour: {
        utilization: 46,
        resets_at: null,
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day: {
        utilization: 23,
        resets_at: null,
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day_opus: null,
      extra_usage: { is_enabled: false, utilization: null },
    },
  },
};

describe('the Claude CLI config reader', function () {
  let dir;
  let now;
  let previous;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-claude-account-'));
    previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    now = Date.now();
  });

  afterEach(function () {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(overrides) {
    const config = JSON.parse(JSON.stringify(REAL_SHAPE));
    config.cachedUsageUtilization.fetchedAtMs = now - 60_000;
    config.cachedUsageUtilization.utilization.five_hour.resets_at =
      new Date(now + 3 * 3_600_000).toISOString();
    config.cachedUsageUtilization.utilization.seven_day.resets_at =
      new Date(now + 4 * 24 * 3_600_000).toISOString();
    overrides?.(config);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(config));
  }

  it('honours CLAUDE_CONFIG_DIR', function () {
    write();
    assert.ok(readCachedClaudeAccount(now));

    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'elsewhere');
    assert.strictEqual(readCachedClaudeAccount(now), null);
  });

  it('reports the tier and both windows as fractions', function () {
    write();
    const account = readCachedClaudeAccount(now);

    assert.strictEqual(account.planName, 'claude max 20x');
    const byKind = Object.fromEntries(account.windows.map((w) => [w.kind, w]));
    // Stored as an integer percentage in the file; the shared type means a
    // fraction, because that is what the protocol event states.
    assert.strictEqual(byKind.five_hour.utilization, 0.46);
    assert.strictEqual(byKind.seven_day.utilization, 0.23);
    assert.strictEqual(account.asOf, new Date(now - 60_000).toISOString());
  });

  it('never returns an identity, only a tier and percentages', function () {
    write();
    // Asserted on the serialised result rather than field by field, so a field
    // added here in future fails this test instead of quietly leaking.
    const serialised = JSON.stringify(readCachedClaudeAccount(now));
    for (const secret of [
      'someone@example.com',
      'Someone',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '11111111-2222-3333-4444-555555555555',
      'admin',
    ]) {
      assert.ok(!serialised.includes(secret), `${secret} leaked into ${serialised}`);
    }
    assert.deepStrictEqual(
      Object.keys(JSON.parse(serialised)).sort(),
      ['asOf', 'planName', 'windows'],
    );
  });

  it('drops a reading older than the shortest window it describes', function () {
    write((config) => {
      // 26.7 hours, which is how old the copy on the machine this was written
      // against actually was. A five-hour window from yesterday is not a
      // reading of today's.
      config.cachedUsageUtilization.fetchedAtMs = now - 26.7 * 3_600_000;
    });
    assert.strictEqual(readCachedClaudeAccount(now), null);
  });

  it('drops a window that has already refilled rather than showing its last percentage', function () {
    write((config) => {
      config.cachedUsageUtilization.utilization.five_hour.resets_at =
        new Date(now - 60_000).toISOString();
    });
    const account = readCachedClaudeAccount(now);
    assert.deepStrictEqual(account.windows.map((w) => w.kind), ['seven_day']);
  });

  it('ignores the null windows the file is mostly made of', function () {
    write();
    const account = readCachedClaudeAccount(now);
    assert.deepStrictEqual(account.windows.map((w) => w.kind).sort(), ['five_hour', 'seven_day']);
  });

  it('drops a window that states utilization: null rather than calling it 0%', function () {
    // `extra_usage` in the shape above really does carry `utilization: null`,
    // and it is skipped today only because that particular block happens to
    // carry no reset time either. Give it one — which is all a Claude Code
    // release has to change for this to arrive — and a `Number(null)` coercion
    // would put a 0% row and an empty meter on the panel for a window the file
    // explicitly declined to measure.
    write((config) => {
      config.cachedUsageUtilization.utilization.extra_usage = {
        is_enabled: false,
        utilization: null,
        resets_at: new Date(now + 2 * 3_600_000).toISOString(),
      };
    });
    const account = readCachedClaudeAccount(now);
    assert.deepStrictEqual(account.windows.map((w) => w.kind).sort(), ['five_hour', 'seven_day']);
  });

  it('returns null for a missing file, and for one that is not JSON', function () {
    assert.strictEqual(readCachedClaudeAccount(now), null);
    fs.writeFileSync(path.join(dir, '.claude.json'), '{not json');
    assert.strictEqual(readCachedClaudeAccount(now), null);
  });

  it('returns null when the cache block is missing entirely', function () {
    write((config) => {
      delete config.cachedUsageUtilization;
    });
    assert.strictEqual(readCachedClaudeAccount(now), null);
  });

  it('never opens a credentials file', function () {
    // The stated rule: this app reads a CLI's config and never its credentials.
    // A credentials file placed where the reader is pointed must be untouched,
    // and the source must not name it.
    write();
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ token: 'sekrit' }));
    const serialised = JSON.stringify(readCachedClaudeAccount(now));
    assert.ok(!serialised.includes('sekrit'));

    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'server', 'services', 'claude-account.ts'),
      'utf8',
    );
    // Named only inside the comment that explains why it is never read.
    const reads = source.split('\n').filter(
      (line) => /readFileSync|createReadStream|open\(/.test(line),
    );
    assert.deepStrictEqual(
      reads.filter((line) => /credentials|auth\.json/.test(line)),
      [],
    );
  });
});
