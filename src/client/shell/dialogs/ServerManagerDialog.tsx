import * as React from 'react';

import type { DiscoveredServerCandidate, ServerTarget } from '../../controller/types';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { IconButton } from '../../ui/relay/IconButton';
import { Input } from '../../ui/relay/Input';
import { PHONE_TEXT, TOUCH_GAP, usePhone } from '../../ui/touch';
import { ServerTargetBadge } from '../ServerTargetBadge';

export interface ServerManagerDialogProps {
  open: boolean;
  targets: ServerTarget[];
  candidates?: DiscoveredServerCandidate[];
  onClose(): void;
  onAdd?(target: { name: string; origin: string }): ServerManagerMutationResult | void | Promise<ServerManagerMutationResult | void>;
  onEdit?(id: string, target: { name: string; origin?: string }): ServerManagerMutationResult | void | Promise<ServerManagerMutationResult | void>;
  onTest?(id: string): void;
  onRetry?(id: string): void;
  onSignIn?(id: string): void;
  onSignOut?(id: string): void;
  onRemove?(target: Pick<ServerTarget, 'id' | 'name' | 'runningWorkCount'>): void;
  /** Persist a fingerprint override only after the warning below has been read. */
  onOverrideCertificate?(id: string, fingerprint?: string): void;
  /** Remove a previously approved exception and return to normal CA validation. */
  onRequireValidCertificate?(id: string): void;
  onFindServers?(): void;
  onAddCandidate?(candidate: DiscoveredServerCandidate): void;
}

export interface ServerManagerMutationResult {
  success: boolean;
  requiresApproval?: boolean;
  target?: ServerTarget;
  message?: string;
}

export interface HttpsOriginValidation {
  origin: string | null;
  error: string | null;
}

interface FormErrors {
  name?: string;
  origin?: string;
}

const fieldStyle: React.CSSProperties = { display: 'grid', gap: 5 };
const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--muted-foreground)',
};
const errorStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--destructive)',
  fontSize: 'var(--text-sm)',
};
const helperStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--muted-foreground)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.45,
};

/**
 * Accept only an HTTPS origin, never a page URL or a URL carrying credentials.
 * A non-default port is part of the origin and is deliberately preserved.
 */
export function validateHttpsOrigin(value: string): HttpsOriginValidation {
  const trimmed = value.trim();
  if (!trimmed) return { origin: null, error: 'Enter the server HTTPS address.' };
  if (!trimmed.startsWith('https://')) {
    return { origin: null, error: 'Use an HTTPS address beginning with https://.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { origin: null, error: 'Enter a valid HTTPS origin, such as https://server.example:8443.' };
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return { origin: null, error: 'Use an HTTPS address beginning with https://.' };
  }
  if (parsed.username || parsed.password) {
    return { origin: null, error: 'Do not include a username or password in the server address.' };
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { origin: null, error: 'Enter only the server origin, without a path, query, or fragment.' };
  }

  return { origin: parsed.origin, error: null };
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function validateName(value: string, targets: ServerTarget[], excludingId?: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a unique friendly name.';
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) return 'The name cannot contain control characters.';
  if (trimmed.length > 120) return 'Use no more than 120 characters.';
  if (targets.some((target) => target.id !== excludingId && sameName(target.name, trimmed))) {
    return 'That server name is already in use.';
  }
  return null;
}

function validateUniqueOrigin(
  value: string,
  targets: ServerTarget[],
  excludingId?: string,
): HttpsOriginValidation {
  const validation = validateHttpsOrigin(value);
  if (!validation.origin) return validation;
  const duplicate = targets.some((target) => {
    if (target.id === excludingId || !target.origin) return false;
    return validateHttpsOrigin(target.origin).origin === validation.origin;
  });
  return duplicate
    ? { origin: null, error: 'That server address is already saved.' }
    : validation;
}

export function certificateWarningText(target: Pick<ServerTarget, 'name' | 'origin'>): string {
  return `Ignoring certificate errors for ${target.name} could allow an attacker to intercept `
    + 'commands, files, credentials, approvals, and session content. '
    + `The exception applies only to ${target.origin ?? 'this exact server'} and its currently presented certificate. `
    + 'If the server presents a replacement certificate, the connection stops and requires renewed approval.';
}

export function removalDescription(target: Pick<ServerTarget, 'name' | 'runningWorkCount'>): string {
  const running = target.runningWorkCount ?? 0;
  const visibility = running > 0
    ? ` ${running} running session${running === 1 ? '' : 's'} will keep running remotely, but you will lose visibility of ${running === 1 ? 'it' : 'them'}.`
    : '';
  return `Remove ${target.name} from this desktop?${visibility} `
    + 'Its saved connection, remembered sign-in, certificate approval, and cached session metadata will be cleared. '
    + 'Nothing on the remote server will be stopped or deleted.';
}

export function ServerManagerDialog(props: ServerManagerDialogProps): React.JSX.Element | null {
  const isPhone = usePhone();
  const baseId = React.useId();

  const [query, setQuery] = React.useState('');
  const [name, setName] = React.useState('');
  const [origin, setOrigin] = React.useState('');
  const [addErrors, setAddErrors] = React.useState<FormErrors>({});
  const [addBusy, setAddBusy] = React.useState(false);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState('');
  const [editOrigin, setEditOrigin] = React.useState('');
  const [editErrors, setEditErrors] = React.useState<FormErrors>({});
  const [editBusy, setEditBusy] = React.useState(false);

  const [certificateTarget, setCertificateTarget] = React.useState<ServerTarget | null>(null);
  const [removalTarget, setRemovalTarget] = React.useState<ServerTarget | null>(null);

  if (!props.open) return null;

  const filtered = props.targets.filter((target) => (
    `${target.name} ${target.origin ?? ''} ${target.connection}`.toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  ));

  const submitAdd = async (): Promise<void> => {
    const nameError = validateName(name, props.targets);
    const originValidation = validateUniqueOrigin(origin, props.targets);
    const errors = { name: nameError ?? undefined, origin: originValidation.error ?? undefined };
    setAddErrors(errors);
    if (nameError || !originValidation.origin) return;
    setAddBusy(true);
    try {
      const result = await props.onAdd?.({ name: name.trim(), origin: originValidation.origin });
      if (result?.success === false) {
        setAddErrors({
          origin: result.message
            || `${name.trim()} could not be verified. Check its HTTPS address, server version, or connection and try again.`,
        });
        if (result.requiresApproval && result.target) setCertificateTarget(result.target);
        return;
      }
      setName('');
      setOrigin('');
      setAddErrors({});
    } finally {
      setAddBusy(false);
    }
  };

  const beginEdit = (target: ServerTarget): void => {
    if (target.kind !== 'remote') return;
    setEditingId(target.id);
    setEditName(target.name);
    setEditOrigin(target.origin ?? '');
    setEditErrors({});
  };

  const submitEdit = async (target: ServerTarget): Promise<void> => {
    const nameError = validateName(editName, props.targets, target.id);
    const originValidation = validateUniqueOrigin(editOrigin, props.targets, target.id);
    const errors = { name: nameError ?? undefined, origin: originValidation.error ?? undefined };
    setEditErrors(errors);
    if (nameError || !originValidation.origin) return;
    setEditBusy(true);
    try {
      const result = await props.onEdit?.(target.id, { name: editName.trim(), origin: originValidation.origin });
      if (result?.success === false) {
        setEditErrors({ origin: result.message || `${editName.trim()} could not be verified. Check the new address and try again.` });
        if (result.requiresApproval && result.target) {
          setCertificateTarget(result.target);
          setEditingId(null);
        }
        return;
      }
      setEditingId(null);
    } finally {
      setEditBusy(false);
    }
  };

  const addNameErrorId = `${baseId}-add-name-error`;
  const addOriginErrorId = `${baseId}-add-origin-error`;

  return (
    <>
      <Dialog
        open
        title="Servers"
        description="Connect this desktop to local and remote Code Agents servers. Credentials remain isolated per server and are never shown here."
        onClose={props.onClose}
        width={680}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: isPhone ? TOUCH_GAP : 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              aria-label="Search servers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              prefix={<Icon name="search" size={14} />}
              placeholder="Search servers"
              style={{ minWidth: isPhone ? 0 : 220 }}
            />
            <Button
              variant="secondary"
              onClick={() => props.onFindServers?.()}
              disabled={!props.onFindServers}
            >
              Find servers
            </Button>
          </div>

          {props.candidates?.length ? (
            <section aria-label="Found servers" style={{ display: 'grid', gap: 6 }}>
              <strong style={{ fontSize: 'var(--text-sm)' }}>Found on your network</strong>
              {props.candidates.map((candidate) => (
                <div
                  key={candidate.id}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: isPhone ? 'wrap' : 'nowrap',
                    fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-sm)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {candidate.name}{' '}
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)' }}>
                      {candidate.origin}
                    </span>
                    <span style={{ display: 'block', color: candidate.compatibility === 'incompatible' ? 'var(--destructive)' : 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
                      {candidate.statusDetail || `Version ${candidate.version || 'unknown'} · protocol ${candidate.protocolVersion ?? 'unknown'}`}
                      {candidate.capabilities?.length ? ` · ${candidate.capabilities.join(', ')}` : ''}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setName(candidate.name);
                      setOrigin(candidate.origin);
                      setAddErrors({});
                    }}
                  >
                    Review and add
                  </Button>
                </div>
              ))}
            </section>
          ) : null}

          <div
            style={{ display: 'grid', gap: 8, maxHeight: '38vh', overflowY: 'auto' }}
            aria-label="Configured servers"
          >
            {filtered.map((target) => {
              const isLocal = target.kind === 'local';
              const editNameErrorId = `${baseId}-${target.id}-edit-name-error`;
              const editOriginErrorId = `${baseId}-${target.id}-edit-origin-error`;
              const addressChanged = validateHttpsOrigin(editOrigin).origin !== target.origin;

              return (
                <section
                  key={target.id}
                  aria-label={`${target.name} server`}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    padding: '10px 12px',
                    display: 'grid',
                    gap: 7,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <ServerTargetBadge target={target} />
                    <span
                      title={target.origin}
                      style={{
                        flex: 1,
                        minWidth: 120,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'var(--font-mono)',
                        fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
                      }}
                    >
                      {target.origin ?? 'This computer'}
                    </span>
                    {isLocal ? (
                      <span style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
                        <Icon name="home" size={11} /> Permanent
                      </span>
                    ) : null}
                    {target.insecure || target.certificate === 'overridden' ? (
                      <span
                        role="note"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: 'var(--warning)',
                          fontSize: 'var(--text-xs)',
                        }}
                      >
                        <Icon name="shield" size={11} /> Insecure connection
                      </span>
                    ) : null}
                  </div>

                  <div style={{ fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
                    {target.statusDetail ?? `Authentication: ${target.auth}. Compatibility: ${target.compatibility}.`}
                    {target.lastContact ? ` Last contact: ${new Date(target.lastContact).toLocaleString()}.` : ''}
                    {target.compatibility === 'incompatible'
                      ? ' Upgrade this server to a controller-compatible version, then retry.' : ''}
                  </div>

                  <div style={{ display: 'flex', gap: isPhone ? TOUCH_GAP : 6, flexWrap: 'wrap' }}>
                    {target.canRetry ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => props.onRetry?.(target.id)}
                        disabled={!props.onRetry || target.connection === 'connecting'}
                      >
                        Retry
                      </Button>
                    ) : null}

                    {!isLocal && target.canTest !== false ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => props.onTest?.(target.id)}
                        disabled={!props.onTest}
                      >
                        Test
                      </Button>
                    ) : null}

                    {target.canSignIn ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => props.onSignIn?.(target.id)}
                        disabled={!props.onSignIn || target.certificate === 'untrusted' || target.certificate === 'changed'}
                      >
                        Sign in
                      </Button>
                    ) : null}

                    {/* Local computer is permanent and its embedder identity is
                        not an account the controller can sign out. */}
                    {!isLocal && target.canSignOut ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => props.onSignOut?.(target.id)}
                        disabled={!props.onSignOut}
                      >
                        Sign out
                      </Button>
                    ) : null}

                    {!isLocal && target.canEdit !== false ? (
                      <IconButton
                        label={`Edit ${target.name}`}
                        onClick={() => beginEdit(target)}
                        disabled={!props.onEdit}
                      >
                        <Icon name="pencil" size={14} />
                      </IconButton>
                    ) : null}

                    {!isLocal && target.canRemove !== false ? (
                      <IconButton
                        label={`Remove ${target.name}`}
                        onClick={() => setRemovalTarget(target)}
                        disabled={!props.onRemove}
                      >
                        <Icon name="trash-2" size={14} />
                      </IconButton>
                    ) : null}

                    {!isLocal && (target.certificate === 'untrusted' || target.certificate === 'changed') ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setCertificateTarget(target)}
                      >
                        Certificate warning
                      </Button>
                    ) : null}

                    {!isLocal && target.certificate === 'overridden' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => props.onRequireValidCertificate?.(target.id)}
                        disabled={!props.onRequireValidCertificate}
                      >
                        Require valid certificate
                      </Button>
                    ) : null}
                  </div>

                  {editingId === target.id ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: isPhone ? '1fr' : 'minmax(130px, 1fr) minmax(220px, 2fr)',
                        gap: 8,
                        paddingTop: 4,
                        borderTop: '1px solid var(--border)',
                      }}
                    >
                      <label style={fieldStyle}>
                        <span style={labelStyle}>Friendly name</span>
                        <Input
                          value={editName}
                          invalid={Boolean(editErrors.name)}
                          aria-invalid={Boolean(editErrors.name)}
                          aria-describedby={editErrors.name ? editNameErrorId : undefined}
                          onChange={(event) => {
                            setEditName(event.target.value);
                            if (editErrors.name) setEditErrors((current) => ({ ...current, name: undefined }));
                          }}
                        />
                        {editErrors.name ? <p id={editNameErrorId} role="alert" style={errorStyle}>{editErrors.name}</p> : null}
                      </label>

                      <label style={fieldStyle}>
                        <span style={labelStyle}>HTTPS address</span>
                        <Input
                          mono
                          value={editOrigin}
                          invalid={Boolean(editErrors.origin)}
                          aria-invalid={Boolean(editErrors.origin)}
                          aria-describedby={editErrors.origin ? editOriginErrorId : undefined}
                          onChange={(event) => {
                            setEditOrigin(event.target.value);
                            if (editErrors.origin) setEditErrors((current) => ({ ...current, origin: undefined }));
                          }}
                        />
                        {editErrors.origin ? <p id={editOriginErrorId} role="alert" style={errorStyle}>{editErrors.origin}</p> : null}
                      </label>

                      <p style={{ ...helperStyle, gridColumn: '1 / -1' }}>
                        Changing the address creates a new destination. Saving it clears this server's remembered sign-in,
                        certificate approval, and cached session metadata, then verifies the new address again.
                        {addressChanged ? ' The address has changed.' : ''}
                      </p>

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, gridColumn: '1 / -1' }}>
                        <Button size="sm" variant="secondary" disabled={editBusy} onClick={() => setEditingId(null)}>Cancel</Button>
                        <Button size="sm" disabled={editBusy} onClick={() => void submitEdit(target)}>{editBusy ? 'Verifying…' : 'Save changes'}</Button>
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>

          {filtered.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>
              No servers match this search. You can still add a remote server while another server is offline.
            </p>
          ) : null}

          <section
            aria-label="Add server"
            style={{
              display: 'grid',
              gridTemplateColumns: isPhone ? '1fr' : 'minmax(120px, 1fr) minmax(200px, 2fr) auto',
              gap: 8,
              alignItems: 'start',
              paddingTop: 4,
              borderTop: '1px solid var(--border)',
            }}
          >
            <label style={fieldStyle}>
              <span style={labelStyle}>Unique name</span>
              <Input
                aria-label="Server name"
                value={name}
                invalid={Boolean(addErrors.name)}
                aria-invalid={Boolean(addErrors.name)}
                aria-describedby={addErrors.name ? addNameErrorId : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  if (addErrors.name) setAddErrors((current) => ({ ...current, name: undefined }));
                }}
                placeholder="Office"
              />
              {addErrors.name ? <p id={addNameErrorId} role="alert" style={errorStyle}>{addErrors.name}</p> : null}
            </label>

            <label style={fieldStyle}>
              <span style={labelStyle}>HTTPS address</span>
              <Input
                aria-label="HTTPS address"
                mono
                value={origin}
                invalid={Boolean(addErrors.origin)}
                aria-invalid={Boolean(addErrors.origin)}
                aria-describedby={addErrors.origin ? addOriginErrorId : undefined}
                onChange={(event) => {
                  setOrigin(event.target.value);
                  if (addErrors.origin) setAddErrors((current) => ({ ...current, origin: undefined }));
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitAdd();
                  }
                }}
                placeholder="https://server.example:8443"
              />
              {addErrors.origin ? <p id={addOriginErrorId} role="alert" style={errorStyle}>{addErrors.origin}</p> : null}
            </label>

            <Button onClick={() => void submitAdd()} disabled={!props.onAdd || addBusy} style={{ marginTop: isPhone ? 0 : 23 }}>
              {addBusy ? 'Verifying…' : 'Add server'}
            </Button>
          </section>

          {certificateTarget ? (
            <div
              role="alert"
              style={{
                border: '1px solid var(--warning)',
                padding: 12,
                borderRadius: 'var(--radius)',
                fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-sm)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Icon name="shield" size={16} style={{ color: 'var(--warning)', marginTop: 2 }} />
                <div>
                  <strong>Certificate interception risk</strong>
                  <p style={{ margin: '4px 0 0', lineHeight: 1.5 }}>
                    {certificateWarningText(certificateTarget)}
                  </p>
                  <p style={{ ...helperStyle, marginTop: 5 }}>
                    Presented fingerprint:{' '}
                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                      {certificateTarget.certificateFingerprint ?? 'Not reported'}
                    </span>
                  </p>
                </div>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Button size="sm" variant="secondary" onClick={() => setCertificateTarget(null)}>Cancel</Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!props.onOverrideCertificate || !certificateTarget.certificateFingerprint}
                  onClick={() => {
                    props.onOverrideCertificate?.(
                      certificateTarget.id,
                      certificateTarget.certificateFingerprint,
                    );
                    setCertificateTarget(null);
                  }}
                >
                  Ignore errors for this certificate
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(removalTarget)}
        title="Remove server"
        description={removalTarget ? removalDescription(removalTarget) : undefined}
        onClose={() => setRemovalTarget(null)}
        width={440}
        footer={
          removalTarget ? (
            <>
              <Button variant="secondary" onClick={() => setRemovalTarget(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  props.onRemove?.(removalTarget);
                  setRemovalTarget(null);
                }}
              >
                Remove server
              </Button>
            </>
          ) : null
        }
      />
    </>
  );
}
