import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Select } from '../../ui/relay/Select';
import { SettingRow } from '../../ui/relay/SettingRow';

/** One size the server is willing to hand out. */
export interface EnvironmentTierOption {
  id: string;
  label: string;
  cpus: string;
  memory: string;
}

export interface EnvironmentInfo {
  enabled: boolean;
  canChoose?: boolean;
  tiers?: EnvironmentTierOption[];
  defaultTier?: string;
  /** What the user picked: a tier id, `auto`, or null for the default. */
  tier?: string | null;
  /** What it is running at now. */
  appliedTier?: string | null;
  /** What it would be built at if it started now. */
  intendedTier?: string | null;
  /** A change waiting for this user to stop working. */
  pendingTier?: string | null;
  running?: boolean;
}

export interface EnvironmentDialogProps {
  open: boolean;
  info: EnvironmentInfo | null;
  /** Null while the first read is in flight; a message when it failed. */
  error: string | null;
  busy: boolean;
  /** The last thing the server said about a save, if anything. */
  notice: string | null;
  onApply(tier: string): void;
  onClose(): void;
}

const AUTO = 'auto';

function describe(tier: EnvironmentTierOption): string {
  const cores = Number.parseFloat(tier.cpus);
  const coreLabel = Number.isFinite(cores) && cores === 1 ? '1 core' : `${tier.cpus} cores`;
  return `${coreLabel}, ${tier.memory.toUpperCase()} memory`;
}

/**
 * Choosing how big your own environment is.
 *
 * Two things are deliberately visible that a settings dialog would normally
 * hide: what the environment is running at *now*, which can differ from what
 * was chosen while automatic sizing is in charge, and whether a change is
 * waiting. A size that silently disagrees with the one on screen is the kind of
 * thing people file bugs about, and both cases are ordinary here.
 */
export function EnvironmentDialog({
  open,
  info,
  error,
  busy,
  notice,
  onApply,
  onClose,
}: EnvironmentDialogProps): React.JSX.Element | null {
  const [choice, setChoice] = React.useState<string>(AUTO);

  // Re-seeded on each closed→open edge, and again when the first read lands,
  // so the select shows what the server actually holds rather than a default
  // that would overwrite it if the user pressed Apply without touching it.
  React.useEffect(() => {
    if (open && info) {
      setChoice(info.tier || info.defaultTier || AUTO);
    }
  }, [open, info]);

  if (!open) return null;

  const tiers = info?.tiers || [];
  const options = [
    { value: AUTO, label: 'Automatic — follows your load' },
    ...tiers.map((tier) => ({ value: tier.id, label: `${tier.label} — ${describe(tier)}` })),
  ];

  const applied = tiers.find((tier) => tier.id === info?.appliedTier) || null;
  const pending = tiers.find((tier) => tier.id === info?.pendingTier) || null;
  const canChoose = Boolean(info?.canChoose);

  const statusStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-sm)',
    color: 'var(--muted-foreground)',
  };

  return (
    <Dialog
      open={open}
      title="Workspace environment"
      description="Your terminals, agents and files run in a container of your own. This is how big it is."
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={!canChoose || busy || !info?.enabled}
            onClick={() => onApply(choice)}
          >
            {busy ? 'Applying…' : 'Apply size'}
          </Button>
        </>
      }
    >
      {error ? (
        <div role="alert" style={{ ...statusStyle, color: 'var(--destructive)', paddingBottom: 12 }}>
          <Icon name="circle-alert" size={14} />
          {error}
        </div>
      ) : null}

      {info && !info.enabled ? (
        <div style={{ ...statusStyle, paddingBottom: 12 }}>
          <Icon name="info" size={14} />
          This server runs everything directly on its own machine, so there is no separate
          environment to size.
        </div>
      ) : null}

      {info?.enabled ? (
        <>
          <SettingRow
            label="Size"
            description={
              canChoose
                ? 'Automatic starts from the default and moves up when you are working it hard, back down when you are not.'
                : 'An administrator sets the size of every environment on this server.'
            }
          >
            <Select
              aria-label="Environment size"
              options={options}
              value={choice}
              disabled={!canChoose || busy}
              onChange={(event) => setChoice(event.target.value)}
              style={{ minWidth: 260 }}
            />
          </SettingRow>

          <SettingRow
            label="Running at"
            description={
              pending
                ? `A change to ${pending.label} is waiting for you to stop working — it needs to rebuild the environment, and doing that now would end whatever is running in it.`
                : 'What your environment has right now. With automatic sizing this follows your load rather than a setting.'
            }
            style={pending ? undefined : { borderBottom: 'none', paddingBottom: 0 }}
          >
            <span style={statusStyle}>
              {applied ? (
                <>
                  <Icon name="check" size={13} />
                  {applied.label} · {describe(applied)}
                </>
              ) : (
                <>
                  <Icon name="circle" size={13} />
                  Not running
                </>
              )}
            </span>
          </SettingRow>

          {pending ? (
            <SettingRow
              label="Waiting to apply"
              description="It takes effect the next time you start a session."
              style={{ borderBottom: 'none', paddingBottom: 0 }}
            >
              <span style={{ ...statusStyle, color: 'var(--warning)' }}>
                <Icon name="clock" size={13} />
                {pending.label}
              </span>
            </SettingRow>
          ) : null}

          {notice ? (
            <div style={{ ...statusStyle, paddingTop: 12 }} role="status">
              <Icon name="info" size={13} />
              {notice}
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
