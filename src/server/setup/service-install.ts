import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PromptSession } from './prompts.js';

export const UNIT_NAME = 'code-agents-webcli.service';

export interface LaunchTarget {
  /** Absolute node binary that will run the service. */
  execPath: string;
  /** Absolute path to bin/cc-web.js in a durable location. */
  scriptPath: string;
  /**
   * True when the code lives in npm's npx cache, which npm garbage-collects
   * and `npm cache clean` deletes outright. A unit pointing there dies later
   * with a non-obvious 203/EXEC.
   */
  ephemeral: boolean;
}

export interface ServiceInstallRequest {
  port: number;
  /** Bounds the folder browser: everything under it is reachable from the UI. */
  workingDirectory: string;
  target: LaunchTarget;
  dataDir: string | null;
}

/** Resolve where this process's CLI entry point actually lives on disk. */
export function resolveLaunchTarget(): LaunchTarget {
  const candidates = [
    require.main?.filename,
    // dist/server/setup/service-install.js -> package root
    path.resolve(__dirname, '..', '..', '..', 'bin', 'cc-web.js'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  let scriptPath = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    try {
      // A global install exposes bin/cc-web as a symlink; the unit must name
      // the real file.
      const real = fs.realpathSync(candidate);
      if (path.basename(real) === 'cc-web.js') {
        scriptPath = real;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }

  const segments = scriptPath.split(path.sep);
  return {
    execPath: process.execPath,
    scriptPath,
    ephemeral: segments.includes('_npx') || segments.includes('_cacache'),
  };
}

export function isSystemdUserAvailable(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    // `is-system-running` reports failure in the very common "degraded" state,
    // so query the version instead: it succeeds whenever the user manager is
    // reachable at all.
    execFileSync('systemctl', ['--user', 'show', '--property=Version', '--value'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function unitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME);
}

/** Reject values that would let a newline inject extra systemd directives. */
function assertUnitSafe(label: string, value: string): void {
  if (/[\n\r]/.test(value)) {
    throw new Error(`${label} must not contain a line break.`);
  }
}

/**
 * systemd expands `%` specifiers (%h, %i, ...) inside unit values, so a literal
 * percent in a path has to be doubled or the unit silently means something
 * else.
 */
function escapeUnitValue(value: string): string {
  return value.replace(/%/g, '%%');
}

export function renderUnit(request: ServiceInstallRequest): string {
  assertUnitSafe('Working directory', request.workingDirectory);
  assertUnitSafe('Node path', request.target.execPath);
  assertUnitSafe('Script path', request.target.scriptPath);
  if (request.dataDir) {
    assertUnitSafe('Data directory', request.dataDir);
  }

  // Inherit this process's PATH so the PTY-spawned agent CLIs stay reachable,
  // with node's own directory first. systemd --user does not source nvm.
  const nodeDir = path.dirname(request.target.execPath);
  const seen = new Set<string>([nodeDir]);
  const pathEntries = [nodeDir];
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!entry || seen.has(entry)) continue;
    if (entry.split(path.sep).includes('_npx')) continue; // ephemeral
    seen.add(entry);
    pathEntries.push(entry);
  }

  const args = [
    JSON.stringify(escapeUnitValue(request.target.scriptPath)),
    '--port',
    String(request.port),
    '--no-open',
  ];
  const dataDirEnv = request.dataDir
    ? `Environment=CODE_AGENTS_WEBCLI_DATA_DIR=${escapeUnitValue(request.dataDir)}\n`
    : '';

  // Credentials deliberately never appear here: they live in SQLite, written
  // by the wizard. A unit file (and `systemctl --user cat`) is world-readable
  // in spirit, and ExecStart is visible in `ps` to every local user.
  return `[Unit]
Description=Code Agents Web CLI - Claude/Codex/Cursor via browser
Documentation=https://github.com/dnviti/code-agents-webcli
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Bounds the folder browser: only this directory and its subdirectories are
# reachable from the web UI.
WorkingDirectory=${escapeUnitValue(request.workingDirectory)}
ExecStart=${escapeUnitValue(request.target.execPath)} ${args.join(' ')}
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
Environment=NODE_ENV=production
Environment=PATH=${escapeUnitValue(pathEntries.join(path.delimiter))}
${dataDirEnv}# Agent CLIs run as PTY children; SIGTERM the main process, then clean up
# the cgroup after TimeoutStopSec.
KillMode=mixed

[Install]
WantedBy=default.target
`;
}

function runSystemctl(args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
}

/** True when a unit of this name is currently running. */
function isUnitActive(): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', UNIT_NAME], {
      encoding: 'utf8',
    });
    return out.trim() === 'active';
  } catch {
    return false;
  }
}

export interface ServiceInstallOutcome {
  installed: boolean;
  started: boolean;
  unitPath: string;
  notes: string[];
}

/**
 * Write and enable the user unit, asking before touching anything that already
 * exists. Never restarts a running service implicitly: that would kill live
 * agent sessions.
 */
export async function installUserService(
  request: ServiceInstallRequest,
  prompt: PromptSession,
): Promise<ServiceInstallOutcome> {
  const notes: string[] = [];
  const target = unitPath();
  const contents = renderUnit(request);

  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (existing !== null && existing !== contents) {
    prompt.note(`\nA unit already exists at ${target} and differs from the one just generated.`);
    prompt.note('Existing ExecStart / WorkingDirectory:');
    for (const line of existing.split('\n')) {
      if (/^(ExecStart|WorkingDirectory)=/.test(line)) {
        prompt.note(`  ${line}`);
      }
    }
    prompt.note('Proposed:');
    for (const line of contents.split('\n')) {
      if (/^(ExecStart|WorkingDirectory)=/.test(line)) {
        prompt.note(`  ${line}`);
      }
    }

    const overwrite = await prompt.confirm('Overwrite the existing unit?', false);
    if (!overwrite) {
      notes.push(`Left the existing unit at ${target} untouched.`);
      return { installed: false, started: false, unitPath: target, notes };
    }

    const backup = `${target}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(target, backup);
    notes.push(`Backed up the previous unit to ${backup}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  notes.push(`Wrote ${target}`);

  runSystemctl(['daemon-reload']);

  // Without lingering the service stops at logout and never starts at boot.
  // Call with no username: passing one routes to a polkit action that can
  // demand an administrator password.
  try {
    execFileSync('loginctl', ['enable-linger'], { stdio: 'ignore' });
  } catch {
    notes.push('Could not enable lingering; the service may not start until you log in.');
  }

  const wasActive = isUnitActive();
  runSystemctl(['enable', UNIT_NAME]);
  notes.push('Enabled at boot.');

  let started = false;
  if (wasActive) {
    // Restarting would SIGTERM live agent PTYs, so make it the user's call.
    const restart = await prompt.confirm(
      'The service is already running. Restart it now (this ends any running agent sessions)?',
      false,
    );
    if (restart) {
      runSystemctl(['restart', UNIT_NAME]);
      started = true;
    } else {
      notes.push(`Restart later with: systemctl --user restart ${UNIT_NAME}`);
    }
  } else {
    runSystemctl(['start', UNIT_NAME]);
    started = true;
  }

  return { installed: true, started, unitPath: target, notes };
}
