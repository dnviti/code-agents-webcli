import * as React from 'react';

import {
  DEFAULT_CONVERSATION_TIER,
  MODEL_TIERS,
  ModelTier,
  RuntimeProfile,
  RuntimeProfilesConfig,
  isBlockedEnvKey,
  resolveConversationRung,
} from '../../../shared/runtime-profiles';
import type { AgentKind } from '../../types';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Input } from '../../ui/relay/Input';
import { Select } from '../../ui/relay/Select';
import { controllerFetch } from '../../controller/transport';

/**
 * Runtimes a profile can target. `terminal` is excluded: it spawns the user's
 * shell, which has no model, no agent tiers and an environment the user already
 * controls from their own dotfiles.
 */
const RUNTIMES: Array<{ value: AgentKind; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'agent', label: 'Cursor Agent' },
  { value: 'pi', label: 'pi' },
  { value: 'grok', label: 'Grok Build' },
  { value: 'qwen', label: 'Qwen Code' },
  { value: 'kimi', label: 'Kimi Code' },
  { value: 'omp', label: 'Oh My Pi' },
  { value: 'antigravity', label: 'Antigravity CLI' },
];

const TIER_HINT: Record<ModelTier, string> = {
  floor: 'Cheapest. Search, recon, reading noisy output.',
  mid: 'The workhorse. Most implementation and tests.',
  high: 'Strong reasoning. Tricky debugging, review.',
  top: 'Most capable. Hard design, critical review.',
};

export interface TierWriteReport {
  written: string[];
  /** Files that were the user's and were replaced anyway (#171). */
  replaced: { file: string; reason: string }[];
  unsupported: boolean;
  /** Set when the files land per session rather than on save. */
  deferred?: string;
  /** Set when the write-through failed outright. */
  failed?: string;
  /** Launch arguments the tier wiring contributes (e.g. claude's --agents). */
  args?: string[];
}

export interface RuntimeProfilesDialogProps {
  open: boolean;
  onClose(): void;
}

interface LoadState {
  config: RuntimeProfilesConfig;
  tierCapableRuntimes: string[];
  canEdit: boolean;
  /**
   * This reader's own standing model per runtime.
   *
   * A standing choice outranks the ladder, and a ladder that has been overridden
   * looks exactly like a ladder that is working — which is the half of #171 the
   * settings page is responsible for saying out loud.
   */
  standingModels: Record<string, string>;
}

function newId(): string {
  // Only needs to be unique within one config and match the id pattern the
  // server validates; not a security boundary.
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-2xs)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-caps)',
  color: 'var(--muted-foreground)',
  marginBottom: 4,
};

const noteStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--muted-foreground)',
  lineHeight: 'var(--leading-snug)',
};

export function RuntimeProfilesDialog({
  open,
  onClose,
}: RuntimeProfilesDialogProps): React.JSX.Element {
  const [state, setState] = React.useState<LoadState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [report, setReport] = React.useState<Record<string, TierWriteReport> | null>(null);

  // Re-fetch each time it opens: profiles are app-wide, so another admin (or
  // another tab) may have changed them since this page loaded.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setReport(null);
    controllerFetch('/api/runtime-profiles', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        setState({
          config: data.config ?? { profiles: [], active: {} },
          tierCapableRuntimes: data.tierCapableRuntimes ?? [],
          canEdit: data.canEdit === true,
          standingModels: data.standingModels ?? {},
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Could not load profiles: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const config = state?.config ?? { profiles: [], active: {} };
  const readOnly = !state?.canEdit;

  const patch = (next: Partial<RuntimeProfilesConfig>): void => {
    if (!state) return;
    setState({ ...state, config: { ...state.config, ...next } });
  };

  const updateProfile = (id: string, changes: Partial<RuntimeProfile>): void => {
    patch({
      profiles: config.profiles.map((p) => (p.id === id ? { ...p, ...changes } : p)),
    });
  };

  const addProfile = (): void => {
    const profile: RuntimeProfile = { id: newId(), name: 'New profile', runtime: 'pi' };
    patch({ profiles: [...config.profiles, profile] });
  };

  const removeProfile = (id: string): void => {
    const active = { ...config.active };
    for (const [runtime, profileId] of Object.entries(active)) {
      if (profileId === id) delete active[runtime];
    }
    patch({ profiles: config.profiles.filter((p) => p.id !== id), active });
  };

  const save = (): void => {
    if (!state) return;
    setSaving(true);
    setError(null);
    controllerFetch('/api/runtime-profiles', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: state.config }),
    })
      .then((res) =>
        res.ok ? res.json() : res.json().then((b) => Promise.reject(new Error(b.error || `HTTP ${res.status}`))),
      )
      .then((data) => {
        // The server normalizes on save — it drops blocked env keys and
        // over-long values — so the form is replaced with what was actually
        // stored rather than what was typed.
        setState({ ...state, config: data.config });
        setReport(data.tierResults ?? {});
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open={open}
      title="Runtime profiles"
      description="Per-runtime launch configuration: a model, extra arguments, environment variables, and capability tiers. Model names are passed through untouched, so any provider works."
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={readOnly || saving || !state} onClick={save}>
            {saving ? 'Saving…' : 'Save profiles'}
          </Button>
        </>
      }
    >
      {error ? (
        <div
          role="alert"
          style={{ ...noteStyle, color: 'var(--destructive)', marginBottom: 12 }}
        >
          {error}
        </div>
      ) : null}

      {state && readOnly ? (
        <div style={{ ...noteStyle, marginBottom: 12 }}>
          Profiles change how agents launch for everyone on this server, so only the
          account that installed it can edit them. You can see the current configuration
          below.
        </div>
      ) : null}

      {!state && !error ? <div style={noteStyle}>Loading…</div> : null}

      {state ? (
        <>
          <ActiveSection
            config={config}
            readOnly={readOnly}
            onChange={(runtime, profileId) => {
              const active = { ...config.active };
              if (profileId) active[runtime] = profileId;
              else delete active[runtime];
              patch({ active });
            }}
          />

          {config.profiles.map((profile) => (
            <ProfileEditor
              key={profile.id}
              profile={profile}
              readOnly={readOnly}
              tierCapable={state.tierCapableRuntimes.includes(profile.runtime)}
              standingModel={state.standingModels[profile.runtime]}
              report={report?.[profile.id]}
              onChange={(changes) => updateProfile(profile.id, changes)}
              onRemove={() => removeProfile(profile.id)}
            />
          ))}

          <div style={{ marginTop: 16 }}>
            <Button variant="secondary" disabled={readOnly} onClick={addProfile}>
              Add profile
            </Button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}

function ActiveSection({
  config,
  readOnly,
  onChange,
}: {
  config: RuntimeProfilesConfig;
  readOnly: boolean;
  onChange(runtime: string, profileId: string | null): void;
}): React.JSX.Element | null {
  const runtimesWithProfiles = RUNTIMES.filter((r) =>
    config.profiles.some((p) => p.runtime === r.value),
  );
  if (!runtimesWithProfiles.length) {
    return (
      <div style={{ ...noteStyle, marginBottom: 16 }}>
        No profiles yet. Add one to pin a model, pass extra arguments, set environment
        variables, or define capability tiers for a runtime.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={labelStyle}>Active per runtime</div>
      {runtimesWithProfiles.map((runtime) => (
        <div
          key={runtime.value}
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}
        >
          <div style={{ flex: '0 0 130px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)' }}>
            {runtime.label}
          </div>
          <div style={{ flex: 1 }}>
            <Select
              aria-label={`Active profile for ${runtime.label}`}
              disabled={readOnly}
              value={config.active[runtime.value] ?? ''}
              onChange={(e) => onChange(runtime.value, e.target.value || null)}
              options={[
                { value: '', label: 'None — launch unmodified' },
                ...config.profiles
                  .filter((p) => p.runtime === runtime.value)
                  .map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProfileEditor({
  profile,
  readOnly,
  tierCapable,
  standingModel,
  report,
  onChange,
  onRemove,
}: {
  profile: RuntimeProfile;
  readOnly: boolean;
  tierCapable: boolean;
  /** This reader's standing model for the runtime, when they have one. */
  standingModel?: string;
  report?: TierWriteReport;
  onChange(changes: Partial<RuntimeProfile>): void;
  onRemove(): void;
}): React.JSX.Element {
  const envRows = Object.entries(profile.env ?? {});

  const setEnv = (rows: Array<[string, string]>): void => {
    const env: Record<string, string> = {};
    for (const [k, v] of rows) if (k) env[k] = v;
    onChange({ env: Object.keys(env).length ? env : undefined });
  };

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 14,
        marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>Name</div>
          <Input
            aria-label="Profile name"
            disabled={readOnly}
            value={profile.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <div style={{ flex: '0 0 180px' }}>
          <div style={labelStyle}>Runtime</div>
          <Select
            aria-label="Profile runtime"
            disabled={readOnly}
            value={profile.runtime}
            onChange={(e) => onChange({ runtime: e.target.value })}
            options={RUNTIMES.map((r) => ({ value: r.value, label: r.label }))}
          />
        </div>
        <Button variant="secondary" disabled={readOnly} onClick={onRemove}>
          Remove
        </Button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>Model</div>
        <Input
          aria-label="Model"
          mono
          placeholder="whatever this CLI accepts, e.g. provider/model-name"
          disabled={readOnly}
          value={profile.model ?? ''}
          onChange={(e) => onChange({ model: e.target.value || undefined })}
        />
        <div style={{ ...noteStyle, marginTop: 4 }}>
          Passed as <code>--model &lt;value&gt;</code>. Never interpreted here, so any
          provider or gateway id works.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>Extra arguments</div>
        <Input
          aria-label="Extra arguments"
          mono
          placeholder="--think hard --no-color"
          disabled={readOnly}
          value={(profile.args ?? []).join(' ')}
          onChange={(e) => {
            const args = e.target.value.split(/\s+/).filter(Boolean);
            onChange({ args: args.length ? args : undefined });
          }}
        />
        <div style={{ ...noteStyle, marginTop: 4 }}>
          Space separated, appended after the app&apos;s own flags. Use this for a CLI
          that spells its model flag differently.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>Environment</div>
        {envRows.map(([key, value], index) => {
          const blocked = key !== '' && isBlockedEnvKey(key);
          return (
            <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <div style={{ flex: '0 0 220px' }}>
                <Input
                  aria-label={`Environment variable ${index + 1} name`}
                  mono
                  invalid={blocked}
                  disabled={readOnly}
                  value={key}
                  onChange={(e) => {
                    const rows = envRows.map(([k, v], i) =>
                      i === index ? ([e.target.value, v] as [string, string]) : ([k, v] as [string, string]),
                    );
                    setEnv(rows);
                  }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Input
                  aria-label={`Environment variable ${index + 1} value`}
                  mono
                  disabled={readOnly}
                  value={value}
                  onChange={(e) => {
                    const rows = envRows.map(([k, v], i) =>
                      i === index ? ([k, e.target.value] as [string, string]) : ([k, v] as [string, string]),
                    );
                    setEnv(rows);
                  }}
                />
              </div>
              <Button
                variant="secondary"
                disabled={readOnly}
                onClick={() => setEnv(envRows.filter((_, i) => i !== index))}
              >
                ✕
              </Button>
            </div>
          );
        })}
        {envRows.some(([k]) => k && isBlockedEnvKey(k)) ? (
          <div style={{ ...noteStyle, color: 'var(--destructive)' }}>
            Highlighted names change which code the process loads rather than how the
            agent behaves, and are dropped when saved.
          </div>
        ) : null}
        <Button
          variant="secondary"
          disabled={readOnly}
          onClick={() => setEnv([...envRows, ['', '']])}
        >
          Add variable
        </Button>
      </div>

      <div>
        <div style={labelStyle}>Capability tiers</div>
        {tierCapable ? (
          <>
            {MODEL_TIERS.map((tier) => (
              <div key={tier} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <div
                  style={{
                    flex: '0 0 60px',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--text-ui)',
                    textTransform: 'capitalize',
                  }}
                >
                  {tier}
                </div>
                <div style={{ flex: 1 }}>
                  <Input
                    aria-label={`${tier} tier model`}
                    mono
                    placeholder={TIER_HINT[tier]}
                    disabled={readOnly}
                    value={profile.tiers?.[tier] ?? ''}
                    onChange={(e) => {
                      const tiers = { ...(profile.tiers ?? {}) };
                      if (e.target.value) tiers[tier] = e.target.value;
                      else delete tiers[tier];
                      onChange({ tiers: Object.keys(tiers).length ? tiers : undefined });
                    }}
                  />
                </div>
              </div>
            ))}
            <div
              style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}
            >
              <div
                style={{
                  flex: '0 0 60px',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--text-ui)',
                }}
              >
                Runs on
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  aria-label="Rung the conversation runs on"
                  disabled={readOnly}
                  value={profile.conversationTier ?? DEFAULT_CONVERSATION_TIER}
                  onChange={(e) => onChange({ conversationTier: e.target.value as ModelTier })}
                  options={MODEL_TIERS.map((tier) => ({ value: tier, label: tier }))}
                />
              </div>
            </div>
            <div style={{ ...noteStyle, marginTop: 4 }}>
              The rung the conversation itself answers from. The other three configure the
              helpers the agent delegates to. Written into this runtime&apos;s own config when
              you save — a file you wrote yourself is replaced, with a copy kept beside it.
            </div>
            <LadderOverride profile={profile} standingModel={standingModel} />
          </>
        ) : (
          <div style={noteStyle}>
            This runtime has no way to express capability tiers, so tiers set here would
            not be applied. Use Model and Extra arguments instead.
          </div>
        )}

        {report ? <TierReport report={report} /> : null}
      </div>
    </section>
  );
}

/**
 * What is beating this ladder, when something is.
 *
 * The failure this exists for is silent by construction: the four boxes are
 * filled in, the profile is active, the page says it saved — and every
 * conversation opens on something else entirely, because a model was typed into
 * the box above or because this account picked one in a chat six weeks ago
 * (#171). Nothing on screen said so.
 */
function LadderOverride({
  profile,
  standingModel,
}: {
  profile: RuntimeProfile;
  standingModel?: string;
}): React.JSX.Element | null {
  const rung = resolveConversationRung(profile);
  if (!rung) return null;

  // In precedence order, because only the first one is actually in force.
  const beating = standingModel
    ? `your standing choice for this runtime (${standingModel})`
    : profile.model
      ? `the model typed above (${profile.model})`
      : null;

  if (!beating) {
    const fell = rung.requested
      ? ` The ${rung.requested} rung is blank, so the nearest filled one answers.`
      : '';
    return (
      <div style={{ ...noteStyle, marginTop: 6 }}>
        Conversations open on <code>{rung.model}</code>.{fell}
      </div>
    );
  }

  return (
    <div style={{ ...noteStyle, marginTop: 6, color: 'var(--destructive)' }}>
      This ladder does not decide the conversation&apos;s model: {beating} outranks it.
      Conversations still delegate to the rungs above.
    </div>
  );
}

function TierReport({ report }: { report: TierWriteReport }): React.JSX.Element | null {
  if (report.unsupported) {
    return (
      <div style={{ ...noteStyle, marginTop: 8, color: 'var(--destructive)' }}>
        Tiers were not applied: this runtime has no tier configuration.
      </div>
    );
  }
  if (report.deferred) {
    return <div style={{ ...noteStyle, marginTop: 8 }}>{report.deferred}</div>;
  }
  if (report.failed) {
    return (
      <div style={{ ...noteStyle, marginTop: 8, color: 'var(--destructive)' }}>
        {report.failed} Sessions still start, on the runtime&apos;s own model.
      </div>
    );
  }
  const replaced = report.replaced ?? [];
  if (!report.written.length && !replaced.length) {
    // claude's ladder travels as launch arguments rather than files, so there
    // is nothing to list — but a ladder that went somewhere should say so,
    // exactly like the writers that do land files.
    if (report.args?.length) {
      return (
        <div style={{ ...noteStyle, marginTop: 8 }}>
          Applied on launch: the rung agents ride on the command line.
        </div>
      );
    }
    return null;
  }

  return (
    <div style={{ ...noteStyle, marginTop: 8 }}>
      {report.written.length ? <div>Wrote {report.written.length} file(s).</div> : null}
      {/* Reported rather than silent: this is the one operation here that
          destroys something the user made. The profile winning over a
          hand-written config is deliberate (#171), and being deliberate is not
          the same as being invisible. */}
      {replaced.map((s) => (
        <div key={s.file} style={{ color: 'var(--destructive)' }}>
          Replaced <code>{s.file}</code> — {s.reason}
        </div>
      ))}
    </div>
  );
}
