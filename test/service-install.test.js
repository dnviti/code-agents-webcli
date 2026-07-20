const assert = require('assert');
const path = require('path');
const {
  renderUnit,
  resolveLaunchTarget,
  unitPath,
  UNIT_NAME,
} = require('../dist/server/setup/service-install.js');

const baseRequest = {
  port: 32352,
  workingDirectory: '/home/someone/projects',
  target: {
    execPath: '/opt/node/bin/node',
    scriptPath: '/opt/app/bin/cc-web.js',
    ephemeral: false,
  },
  dataDir: null,
};

describe('service-install', function () {
  describe('renderUnit', function () {
    it('points ExecStart at the resolved node binary and script', function () {
      const unit = renderUnit(baseRequest);
      assert.match(unit, /^ExecStart=\/opt\/node\/bin\/node .*cc-web\.js.* --port 32352 --no-open$/m);
    });

    it('uses the chosen working directory, which bounds the file browser', function () {
      const unit = renderUnit(baseRequest);
      assert.match(unit, /^WorkingDirectory=\/home\/someone\/projects$/m);
    });

    it('never puts credentials in the unit', function () {
      const unit = renderUnit({
        ...baseRequest,
        dataDir: '/home/someone/.code-agents-webcli',
      });
      // Secrets live in SQLite: a unit file is readable via `systemctl --user cat`
      // and ExecStart shows up in `ps` for every local user.
      assert.doesNotMatch(unit, /client[-_]?secret/i);
      assert.doesNotMatch(unit, /--github-client/i);
      assert.doesNotMatch(unit, /token/i);
    });

    it('does not pass --setup, which would loop under systemd', function () {
      // The wizard demands a TTY; systemd never provides one, so a unit with
      // --setup would crash-loop on Restart=on-failure.
      assert.doesNotMatch(renderUnit(baseRequest), /--setup/);
    });

    it('puts the node directory first on PATH', function () {
      const unit = renderUnit(baseRequest);
      const line = unit.split('\n').find((l) => l.startsWith('Environment=PATH='));
      assert.ok(line, 'expected a PATH line');
      const first = line.replace('Environment=PATH=', '').split(path.delimiter)[0];
      assert.strictEqual(first, '/opt/node/bin');
    });

    it('carries the data directory when one is configured', function () {
      const unit = renderUnit({ ...baseRequest, dataDir: '/var/lib/cawc' });
      assert.match(unit, /^Environment=CODE_AGENTS_WEBCLI_DATA_DIR=\/var\/lib\/cawc$/m);
    });

    it('rejects values containing a line break', function () {
      // Otherwise a crafted directory name could inject extra systemd directives.
      assert.throws(
        () => renderUnit({
          ...baseRequest,
          workingDirectory: '/tmp/evil\nExecStartPost=/bin/rm -rf /',
        }),
        /must not contain a line break/,
      );
    });
  });

  describe('resolveLaunchTarget', function () {
    it('returns an absolute node path and a cc-web.js entry point', function () {
      const target = resolveLaunchTarget();
      assert.strictEqual(target.execPath, process.execPath);
      assert.ok(path.isAbsolute(target.scriptPath));
      assert.strictEqual(path.basename(target.scriptPath), 'cc-web.js');
    });

    it('reports a normal checkout as durable', function () {
      assert.strictEqual(resolveLaunchTarget().ephemeral, false);
    });
  });

  describe('unitPath', function () {
    it('targets the per-user systemd directory', function () {
      assert.ok(unitPath().endsWith(path.join('.config', 'systemd', 'user', UNIT_NAME)));
    });
  });
});
