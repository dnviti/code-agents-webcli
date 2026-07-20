/**
 * Types and copy shared by the update checker (server) and the banner (client).
 *
 * The copy mapping lives here rather than in the client bundle so it is
 * reachable from the mocha suite: CI runs `mocha test/*.test.js` only, and the
 * browser checks are out of band, which would otherwise leave every banner
 * state untested.
 *
 * Deliberately dependency-free.
 */

export type UpdateState =
  | 'never_checked'
  | 'up_to_date'
  | 'behind'
  | 'unknown_build'
  | 'dev_build'
  | 'rate_limited'
  | 'offline';

export interface UpdateStatus {
  state: UpdateState;
  installed: {
    sha: string | null;
    short: string | null;
    commitDate: string | null;
    version: string;
    dirty: boolean;
    source: string;
  };
  remote: {
    sha: string | null;
    short: string | null;
    commitDate: string | null;
    subject: string | null;
  };
  /** null means "behind, but the distance is unknown". */
  behindBy: number | null;
  checkedAt: number | null;
  nextCheckAllowedAt: number;
  message: string | null;
}

export type UpdateMode =
  | 'systemd'
  | 'foreground'
  | 'ephemeral'
  | 'container'
  | 'source'
  | 'unwritable_prefix'
  | 'npm_unavailable';

export interface InterruptedUpdate {
  startedAt: number;
  targetSha: string | null;
}

export interface UpdateStatusResponse {
  status: UpdateStatus;
  mode: UpdateMode;
  canTrigger: boolean;
  isInstaller: boolean;
  running: boolean;
  runnerState: 'idle' | 'running' | 'restarting';
  activeSessions: number;
  interrupted: InterruptedUpdate | null;
  logTail: string[];
}

export const INSTALL_COMMAND = 'npm i -g --allow-git=all github:dnviti/code-agents-webcli';
export const REBUILD_COMMAND = 'npm rebuild --prefix "$(npm root -g)/code-agents-webcli"';
export const UNIT_RESTART_COMMAND = 'systemctl --user restart code-agents-webcli.service';

/** What the banner should look like right now. */
export interface UpdateBannerView {
  /** false hides the banner entirely. */
  visible: boolean;
  tone: 'neutral' | 'available' | 'busy' | 'error' | 'success';
  text: string;
  /** Label for the primary button, or null for no button. */
  action: 'update' | 'retry' | 'copy-command' | null;
  actionLabel: string | null;
  /** The banner can be dismissed until a newer commit appears. */
  dismissible: boolean;
  /** Show the expandable log pane. */
  showLog: boolean;
}

function describeInstalled(status: UpdateStatus): string {
  const short = status.installed.short;
  if (!short) {
    return 'unknown commit';
  }
  return status.installed.dirty ? `${short} (modified)` : short;
}

function refusalText(mode: UpdateMode): string | null {
  switch (mode) {
    case 'ephemeral':
      return (
        'Running from the npx cache, so there is nothing to update in place — '
        + `the next npx run already fetches the latest commit. To install it durably: ${INSTALL_COMMAND}`
      );
    case 'container':
      return 'Running in a container. Update the image with docker pull and recreate the container.';
    case 'source':
      return 'Running from a source checkout. Update it with git pull && npm run build.';
    case 'unwritable_prefix':
      return (
        'The global npm prefix is not writable by this user, so the update cannot be applied '
        + `from here. Run it from a shell instead: ${INSTALL_COMMAND}`
      );
    case 'npm_unavailable':
      return 'npm could not be run, so the update cannot be applied from here.';
    default:
      return null;
  }
}

/**
 * Map a status response to what the banner shows.
 *
 * Pure and total: every state has copy, including the ones a user only reaches
 * on a bad day.
 */
export function describeUpdate(
  response: UpdateStatusResponse,
  now: number = Date.now(),
): UpdateBannerView {
  const { status, mode } = response;

  if (response.runnerState === 'restarting') {
    return {
      visible: true,
      tone: 'busy',
      text: 'Update installed — restarting the service. Agent sessions have ended and will need restarting.',
      action: null,
      actionLabel: null,
      dismissible: false,
      showLog: true,
    };
  }

  if (response.running) {
    return {
      visible: true,
      tone: 'busy',
      text: 'Updating. Do not reload this page until it finishes.',
      action: null,
      actionLabel: null,
      dismissible: false,
      showLog: true,
    };
  }

  if (response.interrupted) {
    return {
      visible: true,
      tone: 'error',
      text:
        'A previous update did not finish, so this installation may be incomplete. '
        + `Reinstall from a shell: ${INSTALL_COMMAND} then ${REBUILD_COMMAND}`,
      action: null,
      actionLabel: null,
      dismissible: true,
      showLog: false,
    };
  }

  switch (status.state) {
    case 'never_checked':
      return {
        visible: false,
        tone: 'neutral',
        text: 'Update status not checked yet.',
        action: 'retry',
        actionLabel: 'Check now',
        dismissible: true,
        showLog: false,
      };

    case 'up_to_date':
      return {
        visible: false,
        tone: 'success',
        text: `Up to date — ${describeInstalled(status)}.`,
        action: null,
        actionLabel: null,
        dismissible: true,
        showLog: false,
      };

    case 'unknown_build':
      return {
        visible: true,
        tone: 'neutral',
        text:
          'This build carries no commit identity, so updates cannot be checked. '
          + `Reinstalling enables it: ${INSTALL_COMMAND}`,
        action: null,
        actionLabel: null,
        dismissible: true,
        showLog: false,
      };

    case 'dev_build':
      return {
        visible: true,
        tone: 'neutral',
        text:
          `Running a modified local build (${describeInstalled(status)}). `
          + 'Update checks are informational only — updating would discard the local changes.',
        action: null,
        actionLabel: null,
        dismissible: true,
        showLog: false,
      };

    case 'rate_limited': {
      const waitMinutes = Math.max(1, Math.ceil((status.nextCheckAllowedAt - now) / 60000));
      return {
        visible: true,
        tone: 'neutral',
        text: `GitHub's rate limit was reached. Retrying in about ${waitMinutes} min.`,
        action: null,
        actionLabel: null,
        dismissible: true,
        showLog: false,
      };
    }

    case 'offline':
      return {
        visible: true,
        tone: 'neutral',
        text: status.message ?? 'Could not reach GitHub to check for updates.',
        action: 'retry',
        actionLabel: 'Retry',
        dismissible: true,
        showLog: false,
      };

    case 'behind': {
      const distance =
        status.behindBy === null
          ? 'this build is not on main any more'
          : `${status.behindBy} commit${status.behindBy === 1 ? '' : 's'} behind main`;
      const versions = `${describeInstalled(status)} → ${status.remote.short ?? 'unknown'}`;

      const refusal = refusalText(mode);
      if (refusal) {
        return {
          visible: true,
          tone: 'available',
          text: `Update available — ${distance} (${versions}). ${refusal}`,
          action: mode === 'ephemeral' ? 'copy-command' : null,
          actionLabel: mode === 'ephemeral' ? 'Copy command' : null,
          dismissible: true,
          showLog: false,
        };
      }

      if (!response.canTrigger) {
        return {
          visible: true,
          tone: 'available',
          text:
            `Update available — ${distance} (${versions}). `
            + 'Only the account that installed this server can apply it.',
          action: null,
          actionLabel: null,
          dismissible: true,
          showLog: false,
        };
      }

      const warning =
        response.activeSessions > 0 && mode === 'systemd'
          ? ` Applying it restarts the service and ends ${response.activeSessions} running agent session${
            response.activeSessions === 1 ? '' : 's'
          }.`
          : '';

      return {
        visible: true,
        tone: 'available',
        text: `Update available — ${distance} (${versions}).${warning}`,
        action: 'update',
        actionLabel: 'Update now',
        dismissible: true,
        showLog: false,
      };
    }

    default:
      return {
        visible: false,
        tone: 'neutral',
        text: '',
        action: null,
        actionLabel: null,
        dismissible: true,
        showLog: false,
      };
  }
}
