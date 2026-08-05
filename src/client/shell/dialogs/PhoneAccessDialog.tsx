import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';

import type { PhoneAccessMode, PhoneAccessStatus } from '../../controller/types';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Input } from '../../ui/relay/Input';
import { Select } from '../../ui/relay/Select';
import { TabBar } from '../../ui/relay/TabBar';

export interface PhoneAccessDialogProps {
  open: boolean;
  status: PhoneAccessStatus | null;
  onClose(): void;
  onRefresh(): Promise<void>;
  onStart(value: { mode: PhoneAccessMode; address?: string; port: number }): Promise<void>;
  onPair(origin?: string): Promise<void>;
  onRevoke(id: string): Promise<void>;
  onStop(): Promise<void>;
  onCheckTailscale(): Promise<void>;
  onSetTailscaleOrigin(origin: string): Promise<void>;
  onExportCa(): Promise<void>;
}

const note: React.CSSProperties = { margin: 0, color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)', lineHeight: 1.45 };
const endpoint: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', wordBreak: 'break-all', userSelect: 'all' };
const PHONE_ACCESS_GUIDE = 'https://github.com/dnviti/code-agents-webcli/blob/main/docs/phone-access.md';

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Copy is unavailable. Select the text and copy it manually.');
}

function pairingTimeLeft(expiresAt: string | number | undefined, now: number): string | null {
  if (expiresAt === undefined) return null;
  const expires = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return null;
  const seconds = Math.max(0, Math.ceil((expires - now) / 1_000));
  if (seconds === 0) return 'Pairing code expired';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `Pairing code expires in ${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function PhoneAccessDialog(props: PhoneAccessDialogProps): React.JSX.Element | null {
  const [mode, setMode] = React.useState<PhoneAccessMode>('lan');
  const [address, setAddress] = React.useState('');
  const [port, setPort] = React.useState('32354');
  const [away, setAway] = React.useState(false);
  const [tailscaleOrigin, setTailscaleOrigin] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const status = props.status;
  React.useEffect(() => {
    if (!props.open || busy) return undefined;
    let disposed = false;
    let refreshing = false;
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        await props.onRefresh();
        if (!disposed) setRefreshError(null);
      } catch (error) {
        if (!disposed) setRefreshError(
          error instanceof Error ? error.message : 'Phone access status could not be read.',
        );
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [busy, props.open, props.onRefresh]);
  React.useEffect(() => {
    if (status?.mode) {
      setMode(status.mode);
      if (status.mode === 'tailscale') setAway(true);
      if (status.mode === 'lan') setAway(false);
    }
    if (status?.port) setPort(String(status.port));
  }, [status?.mode, status?.port]);
  React.useEffect(() => {
    if (!props.open || !status?.pairing?.expiresAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.open, status?.pairing?.expiresAt]);
  if (!props.open) return null;
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setActionError(null);
    try { await work(); } catch (error) { setActionError(error instanceof Error ? error.message : 'Phone access could not be updated.'); } finally { setBusy(false); }
  };
  const running = status?.state === 'running';
  const currentOrigin = away ? status?.origins.tailscale : status?.origins.lan;
  const pairingUrl = status?.pairing
    && (!status.pairing.origin || status.pairing.origin === currentOrigin)
    ? status.pairing.url
    : undefined;
  const pairingExpiry = pairingUrl ? pairingTimeLeft(status?.pairing?.expiresAt, now) : null;
  const interfaces = status?.interfaces ?? [];
  const parsedPort = Number(port);
  const selectedTailscaleOrigin = tailscaleOrigin || status?.tailscale?.origin || '';
  const tailscaleReady = status?.tailscale?.installed === true
    && status.tailscale.online === true
    && status.tailscale.serve === true
    && status.tailscale.funnel !== true
    && Boolean(status.tailscale.origin)
    && selectedTailscaleOrigin === status.tailscale.origin;
  const selectedLanInterfaceAvailable = address
    ? interfaces.some((item) => item.address === address)
    : interfaces.length === 1;
  const needsLanInterface = (mode === 'lan' || mode === 'both')
    && !selectedLanInterfaceAvailable;
  const routeTabs = mode === 'lan'
    ? [{ id: 'lan', title: 'Same network' }]
    : mode === 'tailscale'
      ? [{ id: 'away', title: 'Away from LAN' }]
      : [{ id: 'lan', title: 'Same network' }, { id: 'away', title: 'Away from LAN' }];
  const copy = async (label: string, value: string): Promise<void> => {
    await copyText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => current === label ? null : current), 2_000);
  };

  return <Dialog open title="Open on phone" description="Create a short-lived, device-specific connection to this desktop." onClose={props.onClose} width={560}>
    <div style={{ display: 'grid', gap: 16 }}>
      {status?.state === 'unavailable' ? <p role="alert" style={note}>Phone access is unavailable in this desktop build.</p> : null}
      {status?.state === 'error' ? <p role="alert" style={{ ...note, color: 'var(--destructive)' }}>{status.error || 'Phone access could not start.'}</p> : null}
      {refreshError ? <p role="alert" style={{ ...note, color: 'var(--destructive)' }}>{refreshError}</p> : null}
      {actionError ? <p role="alert" style={{ ...note, color: 'var(--destructive)' }}>{actionError}</p> : null}
      {status?.state === 'starting' || (busy && !running) ? <p role="status" aria-live="polite" style={note}>Starting secure phone access…</p> : null}
      {!running ? <>
        <div style={{ display: 'grid', gap: 8 }}>
          <label style={note}>Connection</label>
          <Select aria-label="Phone access connection" value={mode} onChange={(event) => setMode(event.target.value as PhoneAccessMode)} options={[
            { value: 'lan', label: 'Same network (LAN)' }, { value: 'tailscale', label: 'Away from LAN (Tailscale)' }, { value: 'both', label: 'Both' },
          ]} />
          {(mode === 'lan' || mode === 'both') ? <><label style={note}>Network interface</label><Select aria-label="Network interface" value={address} onChange={(event) => setAddress(event.target.value)} options={[{ value: '', label: 'Choose automatically' }, ...interfaces.map((item) => ({ value: item.address, label: `${item.name} · ${item.address}` }))]} /></> : null}
          <label style={note}>Port<Input aria-label="Phone access port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} /></label>
        </div>
        <p style={note}>A paired phone can read files and run commands as your desktop user. Only pair devices you control. Anyone with a pairing link can request access until it expires; revoke devices or stop access at any time.</p>
        {needsLanInterface ? <p role="alert" style={note}>{address ? 'The selected private network interface is no longer available.' : interfaces.length ? 'Choose the private network interface to share.' : 'No private LAN interface is currently available.'}</p> : null}
        <Button disabled={busy || !Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535 || needsLanInterface || status?.state === 'unavailable'} onClick={() => void run(() => props.onStart({ mode, address: address || undefined, port: parsedPort }))}>Start phone access</Button>
      </> : <>
        <TabBar ariaLabel="Phone access routes" tabs={routeTabs} activeId={away ? 'away' : 'lan'} onSelect={(id) => setAway(id === 'away')} />
        {away ? <section style={{ display: 'grid', gap: 9 }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>Tailscale</strong>
          <p style={note}>Install and connect Tailscale on both devices, accept the phone VPN permission, and make sure both devices can reach each other under your tailnet access rules. Shields Up can block inbound access.</p>
          <p style={note}>Run <code style={endpoint}>tailscale serve {status.port || 32354}</code> on this computer. Keep it in the foreground while sharing, then stop it with Ctrl-C.</p>
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => copy('command', `tailscale serve ${status.port || 32354}`))}>{copied === 'command' ? 'Command copied' : 'Copy Serve command'}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void run(props.onCheckTailscale)}>Check setup</Button>
          {status.tailscale?.message ? <p role={status.tailscale.funnel ? 'alert' : 'status'} style={note}>{status.tailscale.message}</p> : null}
          <label style={note}>Your exact ts.net address<Input aria-label="Tailscale origin" mono placeholder="https://machine.tailnet.ts.net" value={selectedTailscaleOrigin} onChange={(event) => setTailscaleOrigin(event.target.value)} /></label>
          <Button variant="secondary" disabled={busy || !tailscaleReady} onClick={() => void run(() => props.onSetTailscaleOrigin(selectedTailscaleOrigin))}>Confirm checked address</Button>
          {!tailscaleReady ? <p style={note}>Check setup first. Confirmation unlocks only when this computer is online, Serve targets the selected loopback port, and Funnel is off.</p> : null}
          <p role="note" style={note}><a href="https://tailscale.com/docs/features/tailscale-funnel" target="_blank" rel="noreferrer">Tailscale Funnel</a> makes this public. It is outside this feature and is never enabled automatically. The desktop must stay awake.</p>
          <p style={note}><a href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">Tailscale Serve guide</a> · <a href="https://tailscale.com/docs/reference/tailscale-cli/serve" target="_blank" rel="noreferrer">Serve CLI</a> · <a href="https://tailscale.com/docs/features/access-control" target="_blank" rel="noreferrer">Access controls</a> · <a href="https://tailscale.com/docs/features/magicdns" target="_blank" rel="noreferrer">MagicDNS</a></p>
        </section> : <section style={{ display: 'grid', gap: 8 }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>1. Trust this desktop’s private CA</strong>
          <p style={note}>Install it only on a phone you control, compare the SHA-256 fingerprint with this trusted desktop, and remove it when you no longer need LAN access.</p>
          {status.ca?.fingerprint ? <code style={endpoint}>{status.ca.fingerprint}</code> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" disabled={busy} onClick={() => void run(props.onExportCa)}>Export CA from this desktop</Button>
            {status.ca?.downloadUrl ? <a href={status.ca.downloadUrl} target="_blank" rel="noreferrer" style={note}>Secondary /ca.crt route</a> : null}
            <a href={PHONE_ACCESS_GUIDE} target="_blank" rel="noreferrer" style={note}>Trust and removal guide</a>
          </div>
          <strong style={{ fontSize: 'var(--text-sm)', marginTop: 4 }}>2. Pair this phone</strong>
          <p style={note}>Keep your phone on the same trusted network, then scan the access QR below.</p>
        </section>}
        {currentOrigin ? <section style={{ display: 'grid', gap: 8, padding: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius)', textAlign: 'center' }}>
          {pairingUrl ? <QRCodeSVG value={pairingUrl} size={176} level="M" includeMargin aria-label="QR code for phone access" style={{ justifySelf: 'center', background: 'white', padding: 8 }} /> : null}
          <strong style={{ fontSize: 'var(--text-sm)' }}>Open this endpoint</strong>
          <a href={pairingUrl || currentOrigin} target="_blank" rel="noreferrer" style={endpoint}>{pairingUrl || currentOrigin}</a>
          {pairingExpiry ? <p aria-live="off" style={note}>{pairingExpiry}</p> : null}
          <p style={note}>{pairingUrl ? 'Scan the QR code, or copy/open the selectable link.' : 'Create a pairing code for this route before opening it on a phone.'}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Button variant="secondary" disabled={busy} onClick={() => void run(() => copy('link', pairingUrl || currentOrigin))}>{copied === 'link' ? 'Link copied' : 'Copy link'}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => window.open(pairingUrl || currentOrigin, '_blank', 'noopener,noreferrer')}>Open link</Button>
          </div>
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => props.onPair(currentOrigin))}>Create another code</Button>
        </section> : <p style={note}>Confirm a reachable route to create a phone link.</p>}
        <section style={{ display: 'grid', gap: 6 }} aria-label="Paired devices"><strong style={{ fontSize: 'var(--text-sm)' }}>Paired devices ({status.devices.length})</strong>{status.devices.length ? status.devices.map((device) => <div key={device.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1, ...note }}>{device.label || device.id}{device.lastSeen ? ` · ${new Date(device.lastSeen).toLocaleString()}` : ''}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => props.onRevoke(device.id))}>Revoke</Button></div>) : <p style={note}>No devices have paired yet.</p>}</section>
        <Button variant="destructive" disabled={busy} onClick={() => {
          if (window.confirm('Stop phone access and disconnect every paired device?')) void run(props.onStop);
        }}>Stop phone access</Button>
      </>}
    </div>
  </Dialog>;
}
