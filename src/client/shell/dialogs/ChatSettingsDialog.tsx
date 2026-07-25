import * as React from 'react';

import {
  CHAT_PANEL_IDS,
  CHAT_PANEL_LABELS,
  type ChatViewSettings,
} from '../../chat/view-settings';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { SettingRow } from '../../ui/relay/SettingRow';
import { Switch } from '../../ui/relay/Switch';

/**
 * The chat surface's own settings.
 *
 * The gear in the chat header used to open the app Settings dialog — font size,
 * colourway, terminal typeface, install, runtime profiles — none of which
 * changes anything you can see in a conversation. This is the chat's: which
 * workspace panels exist, and how much of each message the transcript shows.
 *
 * Everything here is presentation. Nothing in this dialog changes what an agent
 * is allowed to do; that is a launch decision and it lives in the app Settings
 * dialog beside the rest of the choices with consequences. Turning off the tool
 * cards hides them from you — it does not stop the tools running, and the copy
 * says so rather than letting the switch imply otherwise.
 */

const PANEL_DESCRIPTIONS: Record<string, string> = {
  files: 'Browse the session\'s working directory.',
  changes: 'Uncommitted changes, with a diff per file.',
  github: 'Open pull requests and issues, via the `gh` CLI on the server.',
  agents: 'Subagents and workflows this conversation has started.',
  links: 'Local servers the agent mentioned, as links you can open.',
};

export interface ChatSettingsDialogProps {
  open: boolean;
  settings: ChatViewSettings;
  onChange(next: ChatViewSettings): void;
  onClose(): void;
}

export function ChatSettingsDialog({
  open,
  settings,
  onChange,
  onClose,
}: ChatSettingsDialogProps): React.JSX.Element | null {
  if (!open) return null;

  // Applied immediately rather than on a Save button. Every control here is
  // visible in the pane behind the dialog, so the change *is* the preview and a
  // confirm step would only put a round trip between the switch and its effect.
  const update = (patch: Partial<ChatViewSettings>): void => {
    onChange({ ...settings, ...patch });
  };

  const togglePanel = (id: string, enabled: boolean): void => {
    update({ panels: { ...settings.panels, [id]: enabled } });
  };

  return (
    <Dialog
      open={open}
      title="Chat display"
      description="What this conversation shows. These settings apply to every web chat and are saved in this browser."
      onClose={onClose}
      width={520}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <SettingRow
        label="Workspace panel"
        description="The rail beside the conversation, with files, changes and repository details."
      >
        <Switch
          checked={settings.panelOpen}
          ariaLabel="Show the workspace panel"
          onChange={(checked) => update({ panelOpen: checked })}
        />
      </SettingRow>

      <div
        style={{
          padding: '14px 0 4px',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-2xs)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-caps)',
          color: 'var(--muted-foreground)',
        }}
      >
        Panels
      </div>

      {CHAT_PANEL_IDS.map((id) => (
        <SettingRow
          key={id}
          label={CHAT_PANEL_LABELS[id]}
          description={PANEL_DESCRIPTIONS[id]}
        >
          <Switch
            checked={settings.panels[id]}
            ariaLabel={`Show the ${CHAT_PANEL_LABELS[id]} panel`}
            onChange={(checked) => togglePanel(id, checked)}
          />
        </SettingRow>
      ))}

      <div
        style={{
          padding: '14px 0 4px',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-2xs)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-caps)',
          color: 'var(--muted-foreground)',
        }}
      >
        Transcript
      </div>

      <SettingRow
        label="Reasoning"
        description="Show the model's own working, collapsed, above its answer."
      >
        <Switch
          checked={settings.showThinking}
          ariaLabel="Show reasoning blocks"
          onChange={(checked) => update({ showThinking: checked })}
        />
      </SettingRow>

      <SettingRow
        label="Tool calls"
        description="Show a card for each tool the agent runs. Hiding them changes the view only — the tools still run, and approvals still appear."
      >
        <Switch
          checked={settings.showToolCalls}
          ariaLabel="Show tool call cards"
          onChange={(checked) => update({ showToolCalls: checked })}
        />
      </SettingRow>

      <SettingRow label="Plan" description="The agent's to-do list, beside the conversation.">
        <Switch
          checked={settings.showPlan}
          ariaLabel="Show the plan panel"
          onChange={(checked) => update({ showPlan: checked })}
        />
      </SettingRow>

      <SettingRow
        label="Usage"
        description="Tokens and cost in the header, when the runtime reports them."
        style={{ borderBottom: 'none', paddingBottom: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="cpu" size={13} style={{ color: 'var(--muted-foreground)' }} />
          <Switch
            checked={settings.showUsage}
            ariaLabel="Show the usage meter"
            onChange={(checked) => update({ showUsage: checked })}
          />
        </div>
      </SettingRow>
    </Dialog>
  );
}
