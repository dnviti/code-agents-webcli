import * as React from 'react';

import type { AppSettings, TerminalFontFamilyId, ThemePresetId } from '../../types';
import type { InstallState } from '../store';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Select } from '../../ui/relay/Select';
import { Icon } from '../../ui/relay/Icon';
import { SettingRow } from '../../ui/relay/SettingRow';
import { Switch } from '../../ui/relay/Switch';

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

export function SettingsDialog({
  open,
  settings,
  onPreview,
  onSave,
  onClose,
  install,
  onInstall,
  onOpenRuntimeProfiles,
}: SettingsDialogProps): React.JSX.Element | null {
  const [draft, setDraft] = React.useState<AppSettings>(settings);

  // Keyed on `open` alone, deliberately: while the dialog is open the caller is
  // being fed previews and re-renders with them, so following `settings` here
  // would fight the user's own edits. Re-seeding on each closed→open edge is
  // what makes a cancel-then-reopen show the persisted values, not stale ones.
  React.useEffect(() => {
    if (open) setDraft(settings);
  }, [open]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>): void => {
    const next: AppSettings = { ...draft, ...patch };
    setDraft(next);
    onPreview(next);
  };

  // A native range with `accent-color` rather than a hand-drawn track: the
  // browser keeps the thumb sizing, keyboard stepping and RTL behaviour, and
  // the accent is the only part that has to match the theme.
  const sliderStyle: React.CSSProperties = {
    width: 150,
    height: 4,
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
            ? 'New web chats will run every tool without asking — including shell commands and file writes. Conversations already running keep the setting they started with.'
            : 'New web chats ask before each tool call. Turn this off to let them read, write and run commands unattended.'
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

      <SettingRow
        label="Runtime profiles"
        description="Pin a model, pass extra arguments, set environment variables, or define capability tiers for each agent. Works with any provider."
      >
        <Button variant="secondary" onClick={onOpenRuntimeProfiles}>
          Configure
        </Button>
      </SettingRow>

      <SettingRow
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
      </SettingRow>
    </Dialog>
  );
}
