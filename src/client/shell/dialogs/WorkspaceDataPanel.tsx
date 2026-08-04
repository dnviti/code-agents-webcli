import * as React from 'react';

import { Badge } from '../../ui/relay/Badge';
import { Button } from '../../ui/relay/Button';
import { Icon } from '../../ui/relay/Icon';
import { Input } from '../../ui/relay/Input';
import { showConfirm } from '../../ui/confirm';
import { usePhone } from '../../ui/touch';
import {
  clearStorageCache,
  getAdminStorageUsage,
  getGitIdentity,
  getStorageUsage,
  putGitIdentity,
  type GitIdentity,
  type StorageUsageReport,
} from '../composition-api.js';

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: 12,
};

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unit);
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function storageWarningKind(report: StorageUsageReport): 'user' | 'admin' | 'warning' | null {
  if (Array.isArray(report.warnings)) return report.warnings.length > 0 ? 'warning' : null;
  if (report.warnings && typeof report.warnings === 'object') {
    const warnings = report.warnings as Record<string, unknown>;
    if (warnings.user === true) return 'user';
    if (warnings.admin === true) return 'admin';
    return Object.entries(warnings).some(([key, value]) => !key.toLowerCase().includes('threshold') && value === true)
      ? 'warning' : null;
  }
  return report.warnings ? 'warning' : null;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function categoryLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function filesystemFree(report: StorageUsageReport): number | null {
  const value = report.filesystem;
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const free = rows.map((row) => Number((row as { freeBytes?: unknown; availableBytes?: unknown }).freeBytes
    ?? (row as { availableBytes?: unknown }).availableBytes)).filter(Number.isFinite);
  return free.length ? Math.min(...free) : null;
}

function identityComplete(identity: GitIdentity): boolean {
  return identity.name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email.trim());
}

function BreakdownBar({ report }: { report: StorageUsageReport }): React.JSX.Element {
  const homeSegments = Object.entries(report.home.categories)
    .filter(([, bytes]) => bytes > 0)
    .map(([name, bytes]) => ({ name: categoryLabel(name), bytes }));
  const projectSegments = report.projects.filter((project) => project.totalBytes > 0)
    .map((project) => ({ name: project.name, bytes: project.totalBytes }));
  const segments = [...homeSegments, ...projectSegments];
  const colors = ['var(--primary)', 'var(--ansi-blue)', 'var(--ansi-cyan)', 'var(--ansi-magenta)', 'var(--ansi-yellow)', 'var(--success)'];
  return (
    <div>
      <div role="img" aria-label={`Storage breakdown totaling ${formatStorageBytes(report.totalBytes)}`} style={{ display: 'flex', height: 9, overflow: 'hidden', borderRadius: 'var(--radius-full)', background: 'var(--muted)', margin: '10px 0' }}>
        {segments.map((segment, index) => (
          <span
            key={`${segment.name}-${index}`}
            title={`${segment.name}: ${formatStorageBytes(segment.bytes)}`}
            style={{ width: `${report.totalBytes ? Math.max(1, (segment.bytes / report.totalBytes) * 100) : 0}%`, background: colors[index % colors.length] }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 12px' }}>
        {segments.map((segment, index) => (
          <span key={`${segment.name}-label-${index}`} style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
            <span aria-hidden="true" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 'var(--radius-full)', background: colors[index % colors.length], marginRight: 5 }} />
            {segment.name} · {formatStorageBytes(segment.bytes)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceDataPanel(): React.JSX.Element {
  const isPhone = usePhone();
  const [report, setReport] = React.useState<StorageUsageReport | null>(null);
  const [adminReports, setAdminReports] = React.useState<StorageUsageReport[] | null>(null);
  const [identity, setIdentity] = React.useState<GitIdentity>({ name: '', email: '' });
  const [busy, setBusy] = React.useState<'load' | 'refresh' | 'cleanup-downloads' | 'cleanup-versions' | 'identity' | null>('load');
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async (refresh = false): Promise<void> => {
    setBusy(refresh ? 'refresh' : 'load'); setError(null);
    if (refresh) {
      try { setReport(await getStorageUsage(true)); }
      catch (loadError) { setError(errorText(loadError, 'Could not refresh storage usage.')); }
      finally { setBusy(null); }
      return;
    }
    const [usage, globalIdentity, installerUsage] = await Promise.allSettled([
      getStorageUsage(false),
      getGitIdentity(),
      getAdminStorageUsage(),
    ]);
    const failures: string[] = [];
    if (usage.status === 'fulfilled') setReport(usage.value);
    else failures.push(errorText(usage.reason, 'Could not load storage usage.'));
    if (globalIdentity.status === 'fulfilled') setIdentity(globalIdentity.value || { name: '', email: '' });
    else failures.push(errorText(globalIdentity.reason, 'Could not load the global Git identity.'));
    if (installerUsage.status === 'fulfilled') setAdminReports(installerUsage.value);
    else failures.push(errorText(installerUsage.reason, 'Could not load installation storage.'));
    setError(failures.length ? failures.join(' ') : null);
    setBusy(null);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const cleanup = async (): Promise<void> => {
    if (!await showConfirm({
      title: 'Clear runtime download cache?',
      description: 'Downloaded installer archives can be fetched again. Installed runtimes, project setup, user files, and workspaces are not removed.',
      confirmLabel: 'Clear cache',
      tone: 'danger',
    })) return;
    setBusy('cleanup-downloads'); setError(null); setNotice(null);
    try {
      setReport(await clearStorageCache('miseDownloads'));
      setNotice('Runtime download cache cleared.');
    } catch (cleanupError) {
      setError(errorText(cleanupError, 'Could not clear the runtime download cache.'));
    } finally { setBusy(null); }
  };

  const cleanupUnusedVersions = async (): Promise<void> => {
    if (!await showConfirm({
      title: 'Remove unused runtime versions?',
      description: 'Versions referenced by the latest, active, or applied project recipes—and versions currently installing—are kept. Removed app-installed versions can be installed again when selected later.',
      confirmLabel: 'Remove unused versions',
      tone: 'danger',
    })) return;
    setBusy('cleanup-versions'); setError(null); setNotice(null);
    try {
      setReport(await clearStorageCache('unusedToolVersions'));
      setNotice('Unused runtime versions removed. Referenced versions were kept.');
    } catch (cleanupError) {
      setError(errorText(cleanupError, 'Could not remove unused runtime versions.'));
    } finally { setBusy(null); }
  };

  const saveIdentity = async (): Promise<void> => {
    if (!identityComplete(identity)) return;
    setBusy('identity'); setError(null); setNotice(null);
    try {
      setIdentity(await putGitIdentity({ name: identity.name.trim(), email: identity.email.trim() }));
      setNotice('Global Git identity saved. Project overrides still win in their own repositories.');
    } catch (identityError) {
      setError(errorText(identityError, 'Could not save the global Git identity.'));
    } finally { setBusy(null); }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error ? <p role="alert" style={{ color: 'var(--destructive)', margin: 0 }}>{error}</p> : null}
      {notice ? <p role="status" style={{ color: 'var(--muted-foreground)', margin: 0 }}>{notice}</p> : null}

      <section aria-labelledby="global-identity-title" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <h3 id="global-identity-title" style={{ margin: 0, fontSize: 'var(--text-md)' }}>Global Git identity</h3>
          <Badge variant={identityComplete(identity) ? 'success' : 'warning'}>{identityComplete(identity) ? identity.source === 'provider' ? 'Provider default' : identity.source === 'global' ? 'Global override' : 'Complete' : 'Required'}</Badge>
        </div>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>Used for commits and preservation unless a project has its own override.</p>
        <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
          <label><span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>Name</span><Input aria-label="Global Git name" value={identity.name} onChange={(event) => setIdentity({ ...identity, name: event.currentTarget.value })} /></label>
          <label><span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>Email</span><Input aria-label="Global Git email" type="email" value={identity.email} onChange={(event) => setIdentity({ ...identity, email: event.currentTarget.value })} /></label>
          <Button variant="secondary" disabled={busy !== null || !identityComplete(identity)} onClick={() => void saveIdentity()}>{busy === 'identity' ? 'Saving identity…' : 'Save identity'}</Button>
        </div>
      </section>

      <section aria-labelledby="storage-title" style={{ ...card, borderTop: '3px solid var(--primary)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
          <div>
            <h3 id="storage-title" style={{ margin: 0, fontSize: 'var(--text-md)' }}>Durable storage</h3>
            <p style={{ color: 'var(--muted-foreground)', margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>Measured and reported, never used as a quota.</p>
          </div>
          <strong style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{report ? formatStorageBytes(report.totalBytes) : '—'}</strong>
        </div>
        {busy === 'load' && !report ? <p role="status"><Icon name="loader-circle" size={13} /> Measuring storage…</p> : null}
        {report ? (
          <>
            <BreakdownBar report={report} />
            {storageWarningKind(report) ? (
              <p role="status" style={{ color: 'var(--warning)', display: 'flex', gap: 6, alignItems: 'center' }}>
                <Icon name="circle-alert" size={14} /> {storageWarningKind(report) === 'user' ? 'Your storage is above the user warning point.' : storageWarningKind(report) === 'admin' ? 'Storage is above the installer warning point.' : 'Storage is above a configured warning point.'} This is informational; running and building remain available.
              </p>
            ) : null}
            {!report.complete || report.errors.length ? (
              <div role="status" style={{ color: 'var(--warning)' }}>
                <strong>Partial measurement</strong>
                <p style={{ margin: '4px 0' }}>Some paths could not be measured; totals may be low.</p>
                {report.errors.slice(0, 3).map((message, index) => <div key={index} style={{ fontSize: 'var(--text-xs)' }}>{message}</div>)}
              </div>
            ) : null}
            <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
              User home {formatStorageBytes(report.home.totalBytes)}
              {filesystemFree(report) !== null ? ` · Filesystem free ${formatStorageBytes(filesystemFree(report) || 0)}` : ''}
              {' · '}measured {report.measuredAt ? new Date(report.measuredAt).toLocaleString() : 'just now'}
            </p>
            <div style={{ display: 'grid', gap: 6 }}>
              {report.projects.map((project) => (
                <div key={project.projectId} style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'minmax(0, 1fr) auto auto auto', gap: isPhone ? 2 : 12, paddingTop: 7, borderTop: '1px solid var(--border)' }}>
                  <strong>{project.name}</strong>
                  <span style={{ color: 'var(--muted-foreground)' }}>Workspace {formatStorageBytes(project.workspaceBytes)}</span>
                  <span style={{ color: 'var(--muted-foreground)' }}>Project setup {formatStorageBytes(project.overlayBytes)}</span>
                  <span>{formatStorageBytes(project.totalBytes)}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <Button variant="secondary" disabled={busy !== null} onClick={() => void load(true)}>{busy === 'refresh' ? 'Refreshing measurement…' : 'Refresh measurement'}</Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => void cleanup()}>{busy === 'cleanup-downloads' ? 'Clearing cache…' : 'Clear download cache'}</Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => void cleanupUnusedVersions()}>{busy === 'cleanup-versions' ? 'Removing versions…' : 'Remove unused runtime versions'}</Button>
        </div>
      </section>

      <div style={{ ...card, background: 'var(--muted)' }}>
        <strong>Storage lifetimes</strong>
        <p style={{ color: 'var(--muted-foreground)', margin: '5px 0 0' }}>User home keeps agents, sign-ins, skills, settings, and shared runtimes. Project setup is private to one project. Repository workspaces are preserved to Git when possible before replacement; no-repository workspaces are discarded.</p>
      </div>

      {adminReports ? (
        <section aria-labelledby="installation-storage-title" style={card}>
          <h3 id="installation-storage-title" style={{ margin: '0 0 4px', fontSize: 'var(--text-md)' }}>Installation storage</h3>
          <p style={{ color: 'var(--muted-foreground)', margin: '0 0 8px', fontSize: 'var(--text-sm)' }}>Visible only to the installer account.</p>
          {!adminReports.length ? <p style={{ color: 'var(--muted-foreground)' }}>No user storage reports are available.</p> : null}
          {adminReports.map((user, index) => (
            <div key={user.userId ?? `${user.login}-${index}`} style={{ display: 'flex', flexDirection: isPhone ? 'column' : 'row', justifyContent: 'space-between', gap: isPhone ? 3 : 12, borderTop: '1px solid var(--border)', padding: '7px 0' }}>
              <span>{user.login || `User ${user.userId ?? index + 1}`}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                {storageWarningKind(user) ? <Badge variant="warning">Warning</Badge> : null}
                {!user.complete ? <Badge variant="outline">Partial</Badge> : null}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{formatStorageBytes(user.totalBytes)}</span>
              </span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
