import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PromptSession, isInteractiveTerminal } from './prompts.js';
import {
  UNIT_NAME,
  installUserService,
  isSystemdUserAvailable,
  resolveLaunchTarget,
} from './service-install.js';

/**
 * What the caller should do once the wizard returns.
 *
 * `installed-service` means the server is (or will be) run by systemd, so the
 * wizard process must NOT go on to bind the same port itself.
 */
export type PostSetupAction = 'run-foreground' | 'installed-service';

export interface RunModeWizardOptions {
  port: number;
  dataDir: string | null;
  /** Current working directory, used as the default folder-browser root. */
  cwd: string;
}

function describeExposure(workingDirectory: string): string {
  return `Everything under ${workingDirectory} will be browsable, and agents will run with your permissions.`;
}

/**
 * Ask whether to run in the foreground or install a background service, then
 * act on the answer.
 *
 * Only ever called after the OAuth configuration has been persisted: installing
 * a service first would enable a unit that cannot start, because the server
 * demands a TTY when it is unconfigured and systemd never provides one.
 */
export async function runRunModeWizard(
  options: RunModeWizardOptions,
  prompt: PromptSession,
): Promise<PostSetupAction> {
  const target = resolveLaunchTarget();
  const systemdAvailable = isSystemdUserAvailable();

  prompt.note('\n--- How should Code Agents Web CLI run? ---');

  if (!systemdAvailable) {
    prompt.note(
      process.platform === 'linux'
        ? 'No systemd user manager is available here, so only foreground mode is offered.'
        : `Background-service installation is only implemented for systemd (this is ${process.platform}), so only foreground mode is offered.`,
    );
    return 'run-foreground';
  }

  if (target.ephemeral) {
    // The npx cache is not a durable install location.
    prompt.note('This copy is running from npm\'s npx cache, which npm can delete at any time.');
    prompt.note('A background service pointing there would break later, so install it durably first:');
    prompt.note('');
    prompt.note('  npm i -g --allow-git=all github:dnviti/code-agents-webcli');
    prompt.note('  npm rebuild --prefix "$(npm root -g)/code-agents-webcli"');
    prompt.note('  cc-web --setup');
    prompt.note('');
    prompt.note('Continuing in foreground mode for now.');
    return 'run-foreground';
  }

  const mode = await prompt.select(
    'Run mode:',
    [
      { key: 'f', label: 'Foreground - run now in this terminal (stops when you close it)' },
      { key: 's', label: `Service - install a systemd user service (${UNIT_NAME}), starts at boot` },
    ],
    'f',
  );

  if (mode === 'f') {
    return 'run-foreground';
  }

  // The working directory is a security boundary, not an implementation
  // detail, so it is always asked explicitly and never silently inherited.
  prompt.note('\nThe working directory bounds the file browser in the web UI.');
  prompt.note(`Your home directory exposes dotfiles such as ~/.ssh and ~/.config.`);

  let workingDirectory = '';
  for (;;) {
    const answer = await prompt.value('Working directory', options.cwd, true);
    const resolved = path.resolve(answer.replace(/^~(?=$|\/)/, os.homedir()));

    if (resolved === path.parse(resolved).root) {
      prompt.note('Refusing to expose the filesystem root. Choose a narrower directory.');
      continue;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      prompt.note(`Not a directory: ${resolved}`);
      continue;
    }

    prompt.note(describeExposure(resolved));
    if (await prompt.confirm('Use this directory?', true)) {
      workingDirectory = resolved;
      break;
    }
  }

  const outcome = await installUserService(
    {
      port: options.port,
      workingDirectory,
      target,
      dataDir: options.dataDir,
    },
    prompt,
  );

  prompt.note('');
  for (const note of outcome.notes) {
    prompt.note(`  ${note}`);
  }

  if (!outcome.installed) {
    prompt.note('\nService not installed; continuing in foreground mode.');
    return 'run-foreground';
  }

  prompt.note('');
  prompt.note(`  Status:  systemctl --user status ${UNIT_NAME}`);
  prompt.note(`  Logs:    journalctl --user -u ${UNIT_NAME} -f`);
  prompt.note(`  Stop:    systemctl --user stop ${UNIT_NAME}`);
  if (outcome.started) {
    prompt.note(`\nRunning at http://localhost:${options.port}`);
  }

  return 'installed-service';
}

export { isInteractiveTerminal };
