import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Input } from '../../ui/relay/Input';
import { Select } from '../../ui/relay/Select';

/**
 * Deploy targets: the places this server runs containers, edited by the
 * installer from the browser instead of from startup flags.
 *
 * Secrets here are write-only. The server never sends a stored host,
 * kubeconfig or TLS blob back, so the form cannot show what is stored — it
 * can only say that something is and offer to replace or clear it.
 */

type EngineKind = 'docker' | 'podman' | 'kubernetes';

interface TargetSummary {
  id: string;
  name: string;
  engine: EngineKind;
  image: string | null;
  hasHost: boolean;
  hasKubernetesConfig: boolean;
  /** Non-secret Kubernetes fields, shown as current values in the edit form. */
  kubernetesContext: string | null;
  kubernetesNamespace: string | null;
  kubernetesStorageClaim: string | null;
  kubernetesServiceAccount: string | null;
  cpus: string | null;
  memory: string | null;
  setupCommand: string | null;
  idleTimeoutMinutes: number;
  caveats: string[];
  lastCheck: { ok: boolean; error?: string | null; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface LoadState {
  targets: TargetSummary[];
  activeTargetId: string | null;
  canEdit: boolean;
  legacyContainersEnabled: boolean;
  engineCaveats: Record<EngineKind, string[]>;
}

export interface DeployTargetsDialogProps {
  open: boolean;
  onClose(): void;
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

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 72,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-sm)',
  color: 'var(--foreground)',
  background: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: 8,
  resize: 'vertical',
};

interface FormState {
  /** Null when adding a new target. */
  id: string | null;
  name: string;
  engine: EngineKind;
  image: string;
  cpus: string;
  memory: string;
  idleTimeoutMinutes: string;
  setupCommand: string;
  host: string;
  tlsCa: string;
  tlsCert: string;
  tlsKey: string;
  clearHost: boolean;
  kubeconfig: string;
  context: string;
  namespace: string;
  storageClaim: string;
  serviceAccount: string;
  clearKubernetes: boolean;
}

function emptyForm(): FormState {
  return {
    id: null,
    name: '',
    engine: 'docker',
    image: '',
    cpus: '',
    memory: '',
    idleTimeoutMinutes: '',
    setupCommand: '',
    host: '',
    tlsCa: '',
    tlsCert: '',
    tlsKey: '',
    clearHost: false,
    kubeconfig: '',
    context: '',
    namespace: '',
    storageClaim: '',
    serviceAccount: '',
    clearKubernetes: false,
  };
}

function formFor(target: TargetSummary): FormState {
  return {
    ...emptyForm(),
    id: target.id,
    name: target.name,
    engine: target.engine,
    image: target.image ?? '',
    cpus: target.cpus ?? '',
    memory: target.memory ?? '',
    idleTimeoutMinutes: target.idleTimeoutMinutes ? String(target.idleTimeoutMinutes) : '',
    setupCommand: target.setupCommand ?? '',
    // Not secret, so shown as their current values; only actual edits are sent.
    context: target.kubernetesContext ?? '',
    namespace: target.kubernetesNamespace ?? '',
    storageClaim: target.kubernetesStorageClaim ?? '',
    serviceAccount: target.kubernetesServiceAccount ?? '',
  };
}

export function DeployTargetsDialog({
  open,
  onClose,
}: DeployTargetsDialogProps): React.JSX.Element {
  const [state, setState] = React.useState<LoadState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** Per-target check outcomes, shown next to the Check button. */
  const [checks, setChecks] = React.useState<Record<string, { ok: boolean; error?: string }>>({});

  const load = React.useCallback((): void => {
    fetch('/api/admin/deploy-targets', { credentials: 'same-origin' })
      .then((res) => {
        if (res.status === 403) {
          // The panel is installer-only end to end; anyone else gets nothing.
          return Promise.reject(
            new Error('only the account that installed this server can view deploy targets'),
          );
        }
        return res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`));
      })
      .then((data) => {
        setState({
          targets: data.targets ?? [],
          activeTargetId: data.activeTargetId ?? null,
          canEdit: data.canEdit === true,
          legacyContainersEnabled: data.legacyContainersEnabled === true,
          engineCaveats: data.engineCaveats ?? { docker: [], podman: [], kubernetes: [] },
        });
      })
      .catch((err: Error) => setError(`Could not load deploy targets: ${err.message}`));
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setForm(null);
    setChecks({});
    load();
  }, [open, load]);

  const readOnly = !state?.canEdit;

  const request = (url: string, method: string, body?: unknown): Promise<Record<string, unknown>> =>
    fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { message?: string; error?: string }).message
          || (data as { error?: string }).error
          || `HTTP ${res.status}`);
      }
      return data as Record<string, unknown>;
    });

  const saveForm = (): void => {
    if (!form || !state) return;
    setBusy(true);
    setError(null);

    const body: Record<string, unknown> = {
      name: form.name,
      image: form.image || null,
      cpus: form.cpus || null,
      memory: form.memory || null,
      idleTimeoutMinutes: form.idleTimeoutMinutes ? Number(form.idleTimeoutMinutes) : 0,
      setupCommand: form.setupCommand || null,
    };
    if (form.engine === 'kubernetes') {
      // Only the subfields that actually changed are sent: the server merges
      // them into the stored secret, and sending the untouched ones as blank
      // would wipe companion material — the kubeconfig above all.
      const editing = state.targets.find((t) => t.id === form.id) ?? null;
      const secret: Record<string, string | null> = {};
      if (form.kubeconfig) {
        secret.kubeconfig = form.kubeconfig;
      }
      const nonSecret: Array<[string, string | null, string]> = [
        ['context', editing?.kubernetesContext ?? null, form.context],
        ['namespace', editing?.kubernetesNamespace ?? null, form.namespace],
        ['storageClaim', editing?.kubernetesStorageClaim ?? null, form.storageClaim],
        ['serviceAccount', editing?.kubernetesServiceAccount ?? null, form.serviceAccount],
      ];
      for (const [key, stored, value] of nonSecret) {
        if (value !== (stored ?? '')) {
          secret[key] = value || null;
        }
      }
      if (Object.keys(secret).length > 0) {
        body.kubernetesSecret = secret;
      } else if (form.clearKubernetes) {
        body.kubernetesSecret = null;
      }
    } else {
      if (form.host) {
        // TLS only rides along when something was entered; an absent tls key
        // keeps the stored material rather than clearing it.
        body.hostSecret = form.tlsCa || form.tlsCert || form.tlsKey
          ? { host: form.host, tls: { ca: form.tlsCa, cert: form.tlsCert, key: form.tlsKey } }
          : { host: form.host };
      } else if (form.clearHost) {
        body.hostSecret = null;
      }
    }

    const isNew = form.id === null;
    if (isNew) body.engine = form.engine;
    request(
      isNew ? '/api/admin/deploy-targets' : `/api/admin/deploy-targets/${form.id}`,
      isNew ? 'POST' : 'PUT',
      body,
    )
      .then(() => {
        setForm(null);
        setNotice(isNew ? 'Target saved.' : 'Target updated.');
        load();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const checkTarget = (id: string): void => {
    setError(null);
    request(`/api/admin/deploy-targets/${id}/check`, 'POST', {})
      .then((result) => {
        setChecks((prev) => ({
          ...prev,
          [id]: { ok: result.ok === true, error: result.error as string | undefined },
        }));
        load();
      })
      .catch((err: Error) => setError(err.message));
  };

  const deleteTarget = (target: TargetSummary): void => {
    setError(null);
    setNotice(null);
    request(`/api/admin/deploy-targets/${target.id}`, 'DELETE')
      .then(() => {
        setNotice(`Target "${target.name}" deleted.`);
        load();
      })
      .catch((err: Error) => setError(err.message));
  };

  const setActive = (targetId: string): void => {
    setError(null);
    setNotice(null);
    request('/api/admin/deploy-targets/active', 'PUT', { targetId: targetId || null })
      .then((data) => {
        setNotice(typeof data.message === 'string' ? data.message : null);
        load();
      })
      .catch((err: Error) => setError(err.message));
  };

  return (
    <Dialog
      open={open}
      title="Deploy targets"
      description="Where this server runs containers. The active target receives every new environment; targets no longer active keep the work they already run."
      onClose={onClose}
      width={720}
      footer={
        <>
          {form ? (
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {form ? (
            <Button variant="primary" disabled={readOnly || busy || !form.name.trim()} onClick={saveForm}>
              {busy ? 'Saving…' : form.id ? 'Save target' : 'Add target'}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? (
        <div role="alert" style={{ ...noteStyle, color: 'var(--destructive)', marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      {notice ? <div style={{ ...noteStyle, marginBottom: 12 }}>{notice}</div> : null}

      {!state && !error ? <div style={noteStyle}>Loading…</div> : null}

      {state && !form ? (
        <>
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Active target</div>
            <Select
              aria-label="Active deploy target"
              disabled={readOnly}
              value={state.activeTargetId ?? ''}
              onChange={(e) => setActive(e.target.value)}
              options={[
                { value: '', label: 'None — new work cannot start' },
                ...state.targets.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
            <div style={{ ...noteStyle, marginTop: 4 }}>
              Switching moves new work only: environments already running stay on the target
              they started on until they stop.
            </div>
          </div>

          {state.targets.length === 0 ? (
            <div style={{ ...noteStyle, marginBottom: 16 }}>
              {state.legacyContainersEnabled
                ? 'No targets yet — the startup configuration still decides where containers run. Add a target to manage placement from here.'
                : 'No targets yet. Add one to run environments in containers; until then everything runs on this machine.'}
            </div>
          ) : null}

          {state.targets.map((target) => (
            <section
              key={target.id}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: 14,
                marginBottom: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)' }}>
                  {target.name}
                  {target.id === state.activeTargetId ? (
                    <span style={{ color: 'var(--muted-foreground)' }}> — active</span>
                  ) : null}
                </div>
                <div style={{ ...noteStyle }}>{target.engine}</div>
              </div>
              <div style={{ ...noteStyle, marginBottom: 8 }}>
                {target.lastCheck
                  ? target.lastCheck.ok
                    ? `Last check passed (${new Date(target.lastCheck.at).toLocaleString()}).`
                    : `Last check failed: ${target.lastCheck.error ?? 'unknown error'}`
                  : 'Never checked.'}
              </div>
              {checks[target.id] ? (
                <div
                  style={{
                    ...noteStyle,
                    marginBottom: 8,
                    color: checks[target.id].ok ? 'var(--ansi-green)' : 'var(--destructive)',
                  }}
                >
                  {checks[target.id].ok
                    ? 'Check passed: the engine answers.'
                    : `Check failed: ${checks[target.id].error ?? 'the engine is not answering'}`}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" disabled={readOnly} onClick={() => setForm(formFor(target))}>
                  Edit
                </Button>
                <Button variant="secondary" disabled={readOnly} onClick={() => checkTarget(target.id)}>
                  Check
                </Button>
                <Button variant="secondary" disabled={readOnly} onClick={() => deleteTarget(target)}>
                  Delete
                </Button>
              </div>
            </section>
          ))}

          <Button variant="secondary" disabled={readOnly} onClick={() => setForm(emptyForm())}>
            Add target
          </Button>
        </>
      ) : null}

      {state && form ? (
        <TargetForm
          form={form}
          readOnly={readOnly}
          engineCaveats={state.engineCaveats}
          editing={state.targets.find((t) => t.id === form.id) ?? null}
          onChange={(changes) => setForm({ ...form, ...changes })}
        />
      ) : null}
    </Dialog>
  );
}

function TargetForm({
  form,
  readOnly,
  engineCaveats,
  editing,
  onChange,
}: {
  form: FormState;
  readOnly: boolean;
  engineCaveats: Record<EngineKind, string[]>;
  /** The stored target being edited, so secret fields can say "stored". */
  editing: TargetSummary | null;
  onChange(changes: Partial<FormState>): void;
}): React.JSX.Element {
  const isNew = form.id === null;
  const caveats = engineCaveats[form.engine] ?? [];

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>Name</div>
          <Input
            aria-label="Target name"
            disabled={readOnly}
            value={form.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <div style={{ flex: '0 0 180px' }}>
          <div style={labelStyle}>Engine</div>
          <Select
            aria-label="Target engine"
            disabled={readOnly || !isNew}
            value={form.engine}
            onChange={(e) => onChange({ engine: e.target.value as EngineKind })}
            options={[
              { value: 'docker', label: 'Docker' },
              { value: 'podman', label: 'Podman' },
              { value: 'kubernetes', label: 'Kubernetes' },
            ]}
          />
        </div>
      </div>

      {/* Stated before anything is saved: a caveat discovered after save is a
          caveat discovered by every user at once. */}
      {caveats.map((caveat) => (
        <div key={caveat} style={{ ...noteStyle, marginBottom: 6 }}>
          {caveat}
        </div>
      ))}

      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>Image</div>
        <Input
          aria-label="Container image"
          mono
          placeholder="leave empty for the default image"
          disabled={readOnly}
          value={form.image}
          onChange={(e) => onChange({ image: e.target.value })}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>CPUs</div>
          <Input
            aria-label="CPUs"
            placeholder="e.g. 2"
            disabled={readOnly}
            value={form.cpus}
            onChange={(e) => onChange({ cpus: e.target.value })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>Memory</div>
          <Input
            aria-label="Memory"
            placeholder="e.g. 4g"
            disabled={readOnly}
            value={form.memory}
            onChange={(e) => onChange({ memory: e.target.value })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>Idle minutes</div>
          <Input
            aria-label="Idle timeout in minutes"
            placeholder="0 = never"
            disabled={readOnly}
            value={form.idleTimeoutMinutes}
            onChange={(e) => onChange({ idleTimeoutMinutes: e.target.value })}
          />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>Setup command</div>
        <Input
          aria-label="Setup command"
          mono
          placeholder="runs once when an environment is created"
          disabled={readOnly}
          value={form.setupCommand}
          onChange={(e) => onChange({ setupCommand: e.target.value })}
        />
      </div>

      {form.engine === 'kubernetes' ? (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Kubeconfig</div>
            <textarea
              aria-label="Kubeconfig"
              style={textareaStyle}
              placeholder={
                editing?.hasKubernetesConfig ? 'stored, enter to replace' : 'paste the kubeconfig file'
              }
              disabled={readOnly}
              value={form.kubeconfig}
              onChange={(e) => onChange({ kubeconfig: e.target.value })}
            />
            {editing?.hasKubernetesConfig ? (
              <label style={{ ...noteStyle, display: 'block', marginTop: 4 }}>
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={form.clearKubernetes}
                  onChange={(e) => onChange({ clearKubernetes: e.target.checked })}
                />{' '}
                Remove the stored kubeconfig
              </label>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Context</div>
              <Input
                aria-label="Kubernetes context"
                disabled={readOnly}
                value={form.context}
                onChange={(e) => onChange({ context: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Namespace</div>
              <Input
                aria-label="Kubernetes namespace"
                placeholder="default"
                disabled={readOnly}
                value={form.namespace}
                onChange={(e) => onChange({ namespace: e.target.value })}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Storage claim</div>
              <Input
                aria-label="Storage claim"
                placeholder="cawc-environments"
                disabled={readOnly}
                value={form.storageClaim}
                onChange={(e) => onChange({ storageClaim: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Service account</div>
              <Input
                aria-label="Service account"
                disabled={readOnly}
                value={form.serviceAccount}
                onChange={(e) => onChange({ serviceAccount: e.target.value })}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Host</div>
            <Input
              aria-label="Engine host"
              mono
              placeholder={
                editing?.hasHost ? 'stored, enter to replace' : 'leave empty for the local engine'
              }
              disabled={readOnly}
              value={form.host}
              onChange={(e) => onChange({ host: e.target.value })}
            />
            {editing?.hasHost ? (
              <label style={{ ...noteStyle, display: 'block', marginTop: 4 }}>
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={form.clearHost}
                  onChange={(e) => onChange({ clearHost: e.target.checked })}
                />{' '}
                Remove the stored host
              </label>
            ) : null}
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>TLS (only for a host that requires it)</div>
            <textarea
              aria-label="TLS CA"
              style={textareaStyle}
              placeholder="CA certificate (PEM)"
              disabled={readOnly}
              value={form.tlsCa}
              onChange={(e) => onChange({ tlsCa: e.target.value })}
            />
            <textarea
              aria-label="TLS certificate"
              style={{ ...textareaStyle, marginTop: 6 }}
              placeholder="Client certificate (PEM)"
              disabled={readOnly}
              value={form.tlsCert}
              onChange={(e) => onChange({ tlsCert: e.target.value })}
            />
            <textarea
              aria-label="TLS key"
              style={{ ...textareaStyle, marginTop: 6 }}
              placeholder="Client key (PEM)"
              disabled={readOnly}
              value={form.tlsKey}
              onChange={(e) => onChange({ tlsKey: e.target.value })}
            />
          </div>
        </>
      )}

      <div style={noteStyle}>
        Secrets are encrypted at rest and never shown again: a stored value can be replaced
        by entering a new one, or cleared with the checkbox.
      </div>
    </div>
  );
}
