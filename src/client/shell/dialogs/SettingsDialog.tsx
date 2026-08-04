import * as React from 'react';

import type { AppSettings, NotifySettings, TerminalFontFamilyId, ThemePresetId } from '../../types';
import type { InstallState } from '../store';
import type { ServerTarget } from '../../controller/types';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Select } from '../../ui/relay/Select';
import { Icon } from '../../ui/relay/Icon';
import { SettingRow } from '../../ui/relay/SettingRow';
import { Switch } from '../../ui/relay/Switch';
import { TOUCH_TARGET, usePhone } from '../../ui/touch';
import { notifyPermission, requestNotifyPermission, type NotifyPermission } from '../../ui/notify';

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;

// Typed against the id unions so a mistyped preset is a compile error rather
// than a select that silently falls back to the default at runtime.
const THEMES: Array<{ value: ThemePresetId; label: string }> = [
  { value: 'github-dark', label: 'GitHub Dark' },
  { value: 'github-dark-dimmed', label: 'GitHub Dark Dimmed' },
  { value: 'github-dark-high-contrast', label: 'GitHub Dark High Contrast' },
  { value: 'github-light', label: 'GitHub Light' },
  { value: 'github-light-high-contrast', label: 'GitHub Light High Contrast' },
];

const TERMINAL_FONTS: Array<{ value: TerminalFontFamilyId; label: string }> = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'source-code-pro', label: 'Source Code Pro' },
  { value: 'ibm-plex-mono', label: 'IBM Plex Mono' },
  { value: 'cascadia-code-nf', label: 'Cascadia Code NF' },
  { value: 'hack-nf', label: 'Hack Nerd Font' },
  { value: 'meslo-nf', label: 'Meslo Nerd Font' },
  { value: 'sauce-code-pro-nf', label: 'Sauce Code Pro NF' },
];

export interface SettingsDialogProps {
  open: boolean;
  /** The persisted settings, used to seed the form each time the dialog opens. */
  settings: AppSettings;
  /** Called on every edit so the caller can live-preview against the terminal. */
  onPreview(next: AppSettings): void;
  /** Save and close. */
  onSave(next: AppSettings): void;
  /** Close without saving; the caller re-applies `settings`. */
  onClose(): void;
  /** Whether this window can become an installed app. */
  install: InstallState;
  onInstall(): void;
  /** Open the runtime profile editor, which is its own dialog. */
  onOpenRuntimeProfiles(): void;
  /** Open the deploy target editor, which is its own dialog. */
  onOpenDeployTargets(): void;
  /** Whether the operator opted this installation into deploy targets. */
  deployTargetsEnabled: boolean;
  /** Whether this server gives each user their own environment. */
  environmentsEnabled: boolean;
  /** Open the environment size picker, which is its own dialog. */
  onOpenEnvironment(): void;
  /** Open project containers and their lifecycle controls. */
  onOpenProjects(): void;
  /** Present only in the desktop controller; browser/PWA keeps its install flow. */
  controllerTargets?: ServerTarget[];
  onOpenServerManager?: () => void;
  /** Electron owns its package installation, so a PWA install offer is meaningless there. */
  isElectronController?: boolean;
}

/**
 * What the install row says in each state.
 *
 * There is deliberately no state in which a button is shown that cannot work.
 * `beforeinstallprompt` never fires on iOS and never fires again once the app
 * is installed, so a row that always rendered an enabled button would sit there
 * doing nothing on exactly the platforms where people look hardest for it.
 */
const INSTALL_COPY: Record<InstallState, { description: string; action: string | null }> = {
  installed: {
    description: 'This window is already running as an installed app.',
    action: null,
  },
  available: {
    description: 'Adds it to your launcher and opens it in its own window, without browser chrome.',
    action: 'Install',
  },
  ios: {
    description: 'On iOS, open the browser share menu and choose "Add to Home Screen".',
    action: null,
  },
  insecure: {
    description:
      'Installing needs a secure origin. This page is plain http on a host that is not '
      + 'localhost, so the browser will not register a service worker and never offers an '
      + 'install. Open the app from the machine it runs on, or start the server with --cert '
      + 'and --key to serve it over HTTPS.',
    action: null,
  },
  blocked: {
    description:
      'This page loaded, but the browser refused to register its service worker — which is '
      + 'what an install needs. That happens when the browser does not trust this server\'s '
      + 'certificate: open /ca.crt, install it, then restart the browser completely. A '
      + 'browser that was already running when the certificate was trusted has not read it '
      + 'yet.',
    action: null,
  },
  unsupported: {
    description:
      'This browser is not offering an install right now. That usually means the app is '
      + 'already installed; otherwise the browser has no install support. Chrome, Edge and '
      + 'Safari do.',
    action: null,
  },
};

/**
 * What the notification row says, given what the browser will actually do.
 *
 * Same principle as the install row above: there is no state in which a button
 * is offered that could not work. A refused permission is the one that needs
 * saying out loud — nothing in the page can ask again once it has happened, so
 * a row that quietly showed a switch would be promising delivery it cannot make.
 */
const NOTIFY_COPY: Record<NotifyPermission, { description: string; action: string | null }> = {
  granted: {
    description:
      'A conversation that finishes, or stops to ask you something, reaches you in another '
      + 'window, another application, or the installed app. Never the one you are looking at.',
    action: null,
  },
  default: {
    description:
      'The browser has not been asked yet. Allow notifications and a conversation that '
      + 'finishes, or stops to ask you something, can reach you outside this window.',
    action: 'Allow',
  },
  denied: {
    description:
      'This browser is blocking notifications for this site, and only its own site settings '
      + 'can undo that — the page cannot ask again. Until then a waiting conversation is still '
      + 'marked in the tab strip and the session list.',
    action: null,
  },
  unsupported: {
    description:
      'This browser has no notification support, so waiting conversations are marked in the '
      + 'tab strip and the session list instead.',
    action: null,
  },
};

export function SettingsDialog({
  open,
  settings,
  onPreview,
  onSave,
  onClose,
  install,
  onInstall,
  onOpenRuntimeProfiles,
  onOpenDeployTargets,
  deployTargetsEnabled,
  environmentsEnabled,
  onOpenEnvironment,
  onOpenProjects,
  controllerTargets,
  onOpenServerManager,
  isElectronController,
}: SettingsDialogProps): React.JSX.Element | null {
  const [draft, setDraft] = React.useState<AppSettings>(settings);
  const isPhone = usePhone();
  // The current controller bootstrap only exists in Electron. The explicit
  // flag lets a browser-hosted test or future browser controller say otherwise
  // without making the presence of server data hide a browser feature.
  const electronController = isElectronController ?? controllerTargets !== undefined;

  // Keyed on `open` alone, deliberately: while the dialog is open the caller is
  // being fed previews and re-renders with them, so following `settings` here
  // would fight the user's own edits. Re-seeding on each closed→open edge is
  // what makes a cancel-then-reopen show the persisted values, not stale ones.
  React.useEffect(() => {
    if (open) setDraft(settings);
  }, [open]);

  /**
   * What the browser currently permits, which is not a setting.
   *
   * Re-read on each open because it can change from outside the app entirely —
   * site settings, a profile reset — and held in state because granting it
   * from the button below has to redraw this row without saving anything.
   */
  const [permission, setPermission] = React.useState<NotifyPermission>(notifyPermission);
  React.useEffect(() => {
    if (open) setPermission(notifyPermission());
  }, [open]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>): void => {
    const next: AppSettings = { ...draft, ...patch };
    setDraft(next);
    onPreview(next);
  };

  const updateNotify = (patch: Partial<NotifySettings>): void => {
    update({ notifications: { ...draft.notifications, ...patch } });
  };

  /**
   * Ask the browser, from the click that got us here.
   *
   * Outside the draft on purpose: a permission is granted to the browser, not
   * saved by this dialog, so Cancel cannot take it back and pretending
   * otherwise would be the confusing half. Switching the feature on asks too —
   * that is the same gesture, and making somebody find a second button to
   * finish the thing they just switched on is how a feature ends up looking
   * broken.
   */
  const askPermission = (): void => {
    void requestNotifyPermission().then(setPermission);
  };

  // A native range with `accent-color` rather than a hand-drawn track: the
  // browser keeps the thumb sizing, keyboard stepping and RTL behaviour, and
  // the accent is the only part that has to match the theme.
  const sliderStyle: React.CSSProperties = {
    width: 150,
    // The element's box *is* the hit area of a native range, and a 4px one is
    // half a millimetre of screen: on a phone the only way to change the font
    // size was to land a fingertip on a hairline. The track still paints thin —
    // the browser centres it in whatever height it is given — so this costs
    // nothing on a desktop, where the pointer is exact and the row is tight.
    height: isPhone ? TOUCH_TARGET : 4,
    margin: 0,
    accentColor: 'var(--primary)',
    background: 'var(--border)',
    borderRadius: 'var(--radius-full)',
    cursor: 'pointer',
  };

  const readoutStyle: React.CSSProperties = {
    minWidth: 38,
    textAlign: 'right',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-sm)',
    color: 'var(--muted-foreground)',
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <Dialog
      open={open}
      title="Settings"
      description="Choose a GitHub-inspired colorway and terminal typography. The terminal palette follows the selected app theme automatically."
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            Save settings
          </Button>
        </>
      }
    >
      <SettingRow label="Font size" description="Scales the terminal text and reflows the grid to fit.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="range"
            aria-label="Font size"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={draft.fontSize}
            onChange={(event) => update({ fontSize: Number(event.target.value) })}
            style={sliderStyle}
          />
          <span style={readoutStyle}>{draft.fontSize}px</span>
        </div>
      </SettingRow>

      <SettingRow label="Colorway" description="Sets the terminal palette and the light/dark side of the app chrome.">
        <Select
          aria-label="Colorway"
          options={THEMES}
          value={draft.theme}
          onChange={(event) => update({ theme: event.target.value as ThemePresetId })}
          style={{ minWidth: 220 }}
        />
      </SettingRow>

      <SettingRow
        label="Projects"
        description="Create and manage repository projects in their own containers."
      >
        <Button variant="secondary" size="sm" onClick={onOpenProjects}>Manage projects</Button>
      </SettingRow>
      <SettingRow
        label="Terminal font"
        description="Nerd Font entries add the powerline and icon glyphs prompts expect."
      >
        <Select
          aria-label="Terminal font"
          options={TERMINAL_FONTS}
          value={draft.terminalFontFamily}
          onChange={(event) => update({ terminalFontFamily: event.target.value as TerminalFontFamilyId })}
          style={{ minWidth: 220 }}
        />
      </SettingRow>

      <SettingRow
        label="Web chat approvals"
        description={
          draft.chatBypassPermissions
            ? 'Every new web chat runs tools without asking — including shell commands and file writes — on all your devices. That covers a chat from the launcher, a branch, and starting over. A conversation already running keeps the mode it began in; start a new one to change it.'
            : 'New web chats ask before each tool call, on all your devices. A conversation already running keeps the mode it began in.'
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {draft.chatBypassPermissions ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-sm)',
                color: 'var(--warning)',
                whiteSpace: 'nowrap',
              }}
            >
              <Icon name="circle-alert" size={13} />
              Bypassed
            </span>
          ) : null}
          <Switch
            checked={draft.chatBypassPermissions}
            ariaLabel="Bypass tool approvals in new web chats"
            onChange={(checked) => update({ chatBypassPermissions: checked })}
          />
        </div>
      </SettingRow>

      <SettingRow label="Conversation notifications" description={NOTIFY_COPY[permission].description}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {NOTIFY_COPY[permission].action ? (
            <Button variant="secondary" onClick={askPermission}>
              {NOTIFY_COPY[permission].action}
            </Button>
          ) : null}
          <Switch
            checked={draft.notifications.enabled}
            disabled={permission === 'unsupported'}
            ariaLabel="Notify me about conversations"
            onChange={(checked) => {
              updateNotify({ enabled: checked });
              if (checked && permission === 'default') askPermission();
            }}
          />
        </div>
      </SettingRow>

      <SettingRow
        label="Notify me when"
        description="Each of these is a separate moment a conversation stops needing the machine and starts needing you."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'flex-start' }}>
          <Switch
            label="Work finishes"
            checked={draft.notifications.finished}
            disabled={!draft.notifications.enabled}
            onChange={(checked) => updateNotify({ finished: checked })}
          />
          <Switch
            label="A turn or workflow fails"
            checked={draft.notifications.failed}
            disabled={!draft.notifications.enabled}
            onChange={(checked) => updateNotify({ failed: checked })}
          />
          <Switch
            label="An approval is needed"
            checked={draft.notifications.approval}
            disabled={!draft.notifications.enabled}
            onChange={(checked) => updateNotify({ approval: checked })}
          />
          <Switch
            label="A question is asked"
            checked={draft.notifications.question}
            disabled={!draft.notifications.enabled}
            onChange={(checked) => updateNotify({ question: checked })}
          />
        </div>
      </SettingRow>

      <SettingRow
        label="What notifications say"
        description={
          draft.notifications.details
            ? 'They name the conversation and quote what happened — the command waiting for approval, the question asked.'
            : 'Reduced to "a conversation needs you". Nothing about the work leaves the app; opening the notification still takes you to it.'
        }
      >
        <Switch
          checked={draft.notifications.details}
          disabled={!draft.notifications.enabled}
          ariaLabel="Include the conversation name and what happened"
          onChange={(checked) => updateNotify({ details: checked })}
        />
      </SettingRow>

      <SettingRow
        label="Runtime profiles"
        description="Pin a model, pass extra arguments, set environment variables, or define capability tiers for each agent. Works with any provider."
      >
        <Button variant="secondary" onClick={onOpenRuntimeProfiles}>
          Configure
        </Button>
      </SettingRow>

      {deployTargetsEnabled ? (
        <SettingRow
          label="Deploy targets"
          description="Choose where containers run: this machine, a remote Docker or Podman host, or a Kubernetes cluster. Only the account that installed this server can view or change them."
        >
          <Button variant="secondary" onClick={onOpenDeployTargets}>
            Configure
          </Button>
        </SettingRow>
      ) : null}

      {/* Left out entirely rather than shown disabled: on a server that runs
          everything on its own machine there is no environment to size, and a
          greyed-out row would imply a feature that could be turned on here. */}
      {environmentsEnabled ? (
        <SettingRow
          label="Workspace environment"
          description="Your terminals, agents and files run in a container of your own. Choose how big it is, or let it follow your load."
        >
          <Button variant="secondary" onClick={onOpenEnvironment}>
            Configure
          </Button>
        </SettingRow>
      ) : null}

      {controllerTargets ? <SettingRow
        label="Servers"
        description={`${controllerTargets.length} configured server${controllerTargets.length === 1 ? '' : 's'}. Manage connections, sign-in and certificate trust on this desktop.`}
        style={electronController ? { borderBottom: 'none', paddingBottom: 0 } : undefined}
      >
        <Button variant="secondary" onClick={onOpenServerManager} disabled={!onOpenServerManager}>Manage servers</Button>
      </SettingRow> : null}

      {!electronController ? <SettingRow
        label="Install app"
        description={INSTALL_COPY[install].description}
        style={{ borderBottom: 'none', paddingBottom: 0 }}
      >
        {INSTALL_COPY[install].action ? (
          <Button
            variant="secondary"
            onClick={onInstall}
            iconLeft={<Icon name="download" size={14} />}
          >
            {INSTALL_COPY[install].action}
          </Button>
        ) : (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-sm)',
              color: 'var(--muted-foreground)',
            }}
          >
            {install === 'installed' ? <Icon name="check" size={13} /> : null}
            {/* Named by cause rather than a flat "Not available", which reads
                as a limitation of the app when it is a property of the URL. */}
            {install === 'installed' ? 'Installed' : null}
            {install === 'insecure' ? 'Needs HTTPS' : null}
            {install === 'blocked' ? 'Certificate not trusted' : null}
            {install === 'ios' ? 'Use Share' : null}
            {install === 'unsupported' ? 'Not offered' : null}
          </span>
        )}
      </SettingRow> : null}
    </Dialog>
  );
}
