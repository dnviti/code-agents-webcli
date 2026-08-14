/** Partial class: git identities, storage usage reporting, and usage warnings. */

import { randomUUID } from 'node:crypto';
import type { GitIdentity, StorageUsageBreakdown, StorageUsageSnapshot } from './types.js';
import {
  SETTING_USAGE_WARN_ADMIN,
  SETTING_USAGE_WARN_USER,
} from './types.js';
import {
  nonNegativeIntSetting,
  setOptionalByteSetting,
  toGitIdentity,
  toStorageUsageSnapshot,
  type GitIdentityRow,
  type StorageUsageSnapshotRow,
} from './rows.js';
import { immediateTransaction } from './immediate-transaction.js';
import { ProjectStoreCompositions } from './compositions.js';

export abstract class ProjectStoreReporting extends ProjectStoreCompositions {
  upsertGitIdentity(input: { userId: number; projectId?: string | null; name: string; email: string }): GitIdentity {
    if (!input.name.trim() || !input.email.trim()) throw new Error('git identity requires a name and email');
    if (input.projectId && !this.getProjectForUser(input.projectId, input.userId)) throw new Error('project not found');
    const now = new Date().toISOString(); const projectId = input.projectId ?? null;
    const existing = this.db.raw.prepare('SELECT id FROM git_identities WHERE user_id = ? AND project_id IS ?').get(input.userId, projectId) as { id: string } | undefined;
    if (existing) this.db.raw.prepare('UPDATE git_identities SET name = ?, email = ?, updated_at = ? WHERE id = ?').run(input.name.trim(), input.email.trim(), now, existing.id);
    else this.db.raw.prepare('INSERT INTO git_identities (id, user_id, project_id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), input.userId, projectId, input.name.trim(), input.email.trim(), now, now);
    return this.getGitIdentity(input.userId, projectId) as GitIdentity;
  }

  getGitIdentity(userId: number, projectId: string | null = null): GitIdentity | null {
    const row = this.db.raw.prepare('SELECT * FROM git_identities WHERE user_id = ? AND project_id IS ?').get(userId, projectId) as GitIdentityRow | undefined;
    return row ? toGitIdentity(row) : null;
  }

  /** Project override, then global override, then caller-provided provider default. */
  resolveGitIdentity(input: { userId: number; projectId?: string | null; providerDefault?: { name: string; email: string } | null }): { identity: GitIdentity | { name: string; email: string; source: 'provider' } | null; source: 'project' | 'global' | 'provider' | 'incomplete' } {
    const project = input.projectId ? this.getGitIdentity(input.userId, input.projectId) : null;
    if (project) return { identity: project, source: 'project' };
    const global = this.getGitIdentity(input.userId);
    if (global) return { identity: global, source: 'global' };
    if (input.providerDefault?.name.trim() && input.providerDefault.email.trim()) return { identity: { ...input.providerDefault, source: 'provider' }, source: 'provider' };
    return { identity: null, source: 'incomplete' };
  }

  recordStorageUsageSnapshot(input: { userId?: number | null; totalBytes: number; breakdown: StorageUsageBreakdown; errors?: string[]; freeBytes?: number | null }): StorageUsageSnapshot {
    if (!Number.isFinite(input.totalBytes) || input.totalBytes < 0) throw new Error('storage total must be a non-negative number');
    return immediateTransaction(this.db.raw, () => {
      const id = randomUUID(); const now = new Date().toISOString(); const userId = input.userId ?? null;
      this.db.raw.prepare('INSERT INTO storage_usage_snapshots (id, user_id, total_bytes, breakdown_json, errors_json, free_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, userId, Math.max(0, Math.floor(input.totalBytes)), JSON.stringify(input.breakdown), JSON.stringify(input.errors ?? []), input.freeBytes ?? null, now);
      // Refresh is user-triggerable. Retain useful history without allowing a
      // caller to grow the application database indefinitely.
      this.db.raw.prepare(`DELETE FROM storage_usage_snapshots
        WHERE user_id IS ? AND rowid NOT IN (
          SELECT rowid FROM storage_usage_snapshots
          WHERE user_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 100
        )`).run(userId, userId);
      return this.getStorageUsageSnapshot(id) as StorageUsageSnapshot;
    });
  }

  getStorageUsageSnapshot(id: string): StorageUsageSnapshot | null {
    const row = this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE id = ?').get(id) as StorageUsageSnapshotRow | undefined;
    return row ? toStorageUsageSnapshot(row) : null;
  }

  latestStorageUsageSnapshot(userId?: number | null): StorageUsageSnapshot | null {
    const row = userId == null ? this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get() : this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId);
    return row ? toStorageUsageSnapshot(row as StorageUsageSnapshotRow) : null;
  }

  listStorageUsageSnapshots(userId?: number | null, limit = 50): StorageUsageSnapshot[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = userId == null
      ? this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(safeLimit)
      : this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, safeLimit);
    return (rows as StorageUsageSnapshotRow[]).map(toStorageUsageSnapshot);
  }

  usageWarnUserBytes(): number | null { return nonNegativeIntSetting(this.db.getSetting(SETTING_USAGE_WARN_USER)); }
  usageWarnAdminBytes(): number | null { return nonNegativeIntSetting(this.db.getSetting(SETTING_USAGE_WARN_ADMIN)); }
  setUsageWarnUserBytes(bytes: number | null): void { setOptionalByteSetting(this.db, SETTING_USAGE_WARN_USER, bytes); }
  setUsageWarnAdminBytes(bytes: number | null): void { setOptionalByteSetting(this.db, SETTING_USAGE_WARN_ADMIN, bytes); }
}
