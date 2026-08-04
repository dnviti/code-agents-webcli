const assert = require('assert');
const { describeUpdate } = require('../dist/shared/update.js');

// The banner lives in the client bundle, which CI never loads: ci.yml runs
// `npm test` (mocha test/*.test.js) and not the browser checks. Keeping the
// state -> copy mapping pure and shared is what makes it testable here.

const BASE_STATUS = {
  state: 'behind',
  installed: {
    sha: 'a'.repeat(40),
    short: 'aaaaaaa',
    commitDate: null,
    version: '4.1.0',
    dirty: false,
    source: 'git',
  },
  remote: { sha: 'b'.repeat(40), short: 'bbbbbbb', commitDate: null, subject: null },
  behindBy: 4,
  checkedAt: 1000,
  nextCheckAllowedAt: 2000,
  message: null,
};

const BASE_RESPONSE = {
  mode: 'systemd',
  canTrigger: true,
  isInstaller: true,
  running: false,
  runnerState: 'idle',
  activeSessions: 0,
  interrupted: null,
  logTail: [],
};

function response(overrides = {}) {
  return {
    ...BASE_RESPONSE,
    ...overrides,
    // Merged separately so a test can override one status field without
    // having to restate the whole object.
    status: { ...BASE_STATUS, ...(overrides.status ?? {}) },
  };
}

describe('describeUpdate', function () {
  it('offers the update to the installer', function () {
    const view = describeUpdate(response());
    assert.strictEqual(view.visible, true);
    assert.strictEqual(view.action, 'update');
    assert.match(view.text, /4 commits behind main/);
    assert.match(view.text, /aaaaaaa → bbbbbbb/);
  });

  it('warns how many sessions a restart will end', function () {
    const view = describeUpdate(response({ activeSessions: 3 }));
    assert.match(view.text, /ends 3 running agent sessions/);
  });

  it('gets the singular right for one session', function () {
    const view = describeUpdate(response({ activeSessions: 1 }));
    assert.match(view.text, /ends 1 running agent session\./);
  });

  it('gets the singular right for one commit', function () {
    const view = describeUpdate(response({ status: { behindBy: 1 } }));
    assert.match(view.text, /1 commit behind main/);
  });

  it('tells a non-installer who can apply it, with no button', function () {
    const view = describeUpdate(response({ canTrigger: false }));
    assert.strictEqual(view.visible, true);
    assert.strictEqual(view.action, null);
    assert.match(view.text, /Only the account that installed this server/);
  });

  it('explains an npx install rather than offering a dead button', function () {
    const view = describeUpdate(response({ mode: 'ephemeral', canTrigger: false }));
    assert.strictEqual(view.action, 'copy-command');
    assert.match(view.text, /npx cache/);
    assert.match(view.text, /npm i -g --allow-git=all/);
  });

  it('points a container at docker pull', function () {
    const view = describeUpdate(response({ mode: 'container', canTrigger: false }));
    assert.strictEqual(view.action, null);
    assert.match(view.text, /docker pull/);
  });

  it('points a desktop install at release installers', function () {
    const view = describeUpdate(response({ mode: 'desktop', canTrigger: false }));
    assert.strictEqual(view.action, null);
    assert.match(view.text, /newer desktop build/);
    assert.match(view.text, /github\.com\/dnviti\/code-agents-webcli\/releases/);
  });

  it('points a source checkout at git pull', function () {
    // A clean dev clone: state is 'behind' and dirty is false, so only the mode
    // stops a global install that would not replace the running code.
    const view = describeUpdate(response({ mode: 'source', canTrigger: false }));
    assert.strictEqual(view.action, null);
    assert.match(view.text, /git pull/);
  });

  it('names the sudo problem for an unwritable prefix', function () {
    const view = describeUpdate(response({ mode: 'unwritable_prefix', canTrigger: false }));
    assert.match(view.text, /not writable/);
  });

  it('hides the banner when up to date', function () {
    const view = describeUpdate(response({ status: { state: 'up_to_date' } }));
    assert.strictEqual(view.visible, false);
  });

  it('hides the banner before the first check', function () {
    const view = describeUpdate(response({ status: { state: 'never_checked' } }));
    assert.strictEqual(view.visible, false);
    // Still has copy: the state is reachable through the manual Check button.
    assert.ok(view.text.length > 0);
  });

  it('explains a build with no commit identity', function () {
    const view = describeUpdate(response({ status: { state: 'unknown_build' } }));
    assert.strictEqual(view.visible, true);
    assert.strictEqual(view.action, null);
    assert.match(view.text, /no commit identity/);
  });

  it('marks a modified local build informational', function () {
    const view = describeUpdate(response({
      status: { state: 'dev_build', installed: { short: 'aaaaaaa', dirty: true } },
    }));
    assert.strictEqual(view.action, null);
    assert.match(view.text, /modified/);
    assert.match(view.text, /discard the local changes/);
  });

  it('counts down the rate limit', function () {
    const view = describeUpdate(
      response({ status: { state: 'rate_limited', nextCheckAllowedAt: 600_000 } }),
      0,
    );
    assert.match(view.text, /rate limit/);
    assert.match(view.text, /10 min/);
  });

  it('offers a retry when offline', function () {
    const view = describeUpdate(response({
      status: { state: 'offline', message: 'Could not reach GitHub: ENOTFOUND' },
    }));
    assert.strictEqual(view.action, 'retry');
    assert.match(view.text, /ENOTFOUND/);
  });

  it('shows a non-dismissible busy state while updating', function () {
    const view = describeUpdate(response({ running: true }));
    assert.strictEqual(view.tone, 'busy');
    assert.strictEqual(view.dismissible, false);
    assert.strictEqual(view.showLog, true);
    assert.strictEqual(view.action, null, 'there is no safe way to cancel a running install');
  });

  it('warns everyone that a restart ends their sessions', function () {
    const view = describeUpdate(response({ runnerState: 'restarting' }));
    assert.strictEqual(view.tone, 'busy');
    assert.strictEqual(view.dismissible, false);
    assert.match(view.text, /Agent sessions have ended/);
  });

  it('surfaces an interrupted update with recovery commands', function () {
    const view = describeUpdate(response({
      interrupted: { startedAt: 1, targetSha: 'b'.repeat(40) },
    }));
    assert.strictEqual(view.tone, 'error');
    assert.match(view.text, /did not finish/);
    // A single reinstall is the whole recovery. It used to be followed by an
    // `npm rebuild`, which went away with the last native dependency — telling
    // someone to run a command that no longer does anything is worse than
    // saying nothing.
    assert.match(view.text, /npm i -g --allow-git=all github:dnviti\/code-agents-webcli/);
    assert.doesNotMatch(view.text, /npm rebuild/);
  });

  it('says the build is off main when the distance is unknown', function () {
    const view = describeUpdate(response({ status: { behindBy: null } }));
    assert.match(view.text, /not on main any more/);
  });

  it('keeps the attacker-influenced commit subject out of the banner entirely', function () {
    // The subject is whatever text landed on main — a hostile PR title reaches
    // it. The banner renders with textContent, so markup would be inert
    // anyway, but the copy simply never includes the subject: the shortest
    // path to safe is not carrying the string at all.
    const hostile = '<img src=x onerror=alert(1)> pwned';
    const view = describeUpdate(response({
      status: {
        remote: { sha: 'b'.repeat(40), short: 'bbbbbbb', commitDate: null, subject: hostile },
      },
    }));

    assert.ok(!view.text.includes('pwned'));
    assert.ok(!view.text.includes('<img'));
  });
});
