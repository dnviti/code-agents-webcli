/** Partial class: immutable composition revisions and their installation ledger. */

import { randomUUID } from 'node:crypto';
import type {
  CompositionInstallation,
  CompositionInstallationStatus,
  ProjectComposition,
} from './types.js';
import {
  toComposition,
  toCompositionInstallation,
  type CompositionInstallationRow,
  type CompositionRow,
} from './rows.js';
import { immediateTransaction } from './immediate-transaction.js';
import { ProjectStoreHosts } from './hosts.js';

export abstract class ProjectStoreCompositions extends ProjectStoreHosts {
  createCompositionDraft(input: {
    projectId: string; userId: number; catalogVersion: string; detected: unknown; chosen: unknown;
    sourceOid?: string | null; sourceRef?: string | null; forgeKind?: string | null; forgeHost?: string | null;
    installations?: Array<{ itemId: string; status?: CompositionInstallationStatus }>;
  }): ProjectComposition | null {
    return immediateTransaction(this.db.raw, () => {
      if (!this.getProjectForUser(input.projectId, input.userId)) return null;
      const id = randomUUID(); const now = new Date().toISOString();
      this.db.raw.prepare(`INSERT INTO project_compositions (id, project_id, user_id, catalog_version, detected_json, chosen_json, source_oid, source_ref, forge_kind, forge_host, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.userId, input.catalogVersion, JSON.stringify(input.detected), JSON.stringify(input.chosen), input.sourceOid ?? null, input.sourceRef ?? null, input.forgeKind ?? null, input.forgeHost ?? null, now);
      for (const item of input.installations ?? []) this.upsertCompositionInstallation(id, item.itemId, { status: item.status ?? 'pending' });
      return this.getCompositionForUser(id, input.userId);
    });
  }

  /** Name used by route/provisioning callers: every save creates a new immutable revision. */
  saveCompositionDraft(input: {
    projectId: string; userId: number; catalogVersion: string; detected: unknown; chosen: unknown;
    sourceOid?: string | null; sourceRef?: string | null; forgeKind?: string | null; forgeHost?: string | null;
    installations?: Array<{ itemId: string; status?: CompositionInstallationStatus }>;
  }): ProjectComposition | null { return this.createCompositionDraft(input); }

  getCompositionForUser(compositionId: string, userId: number): ProjectComposition | null {
    const row = this.db.raw.prepare('SELECT * FROM project_compositions WHERE id = ? AND user_id = ?').get(compositionId, userId) as CompositionRow | undefined;
    return row ? toComposition(row) : null;
  }

  getProjectComposition(projectId: string, userId: number, revision?: string | null): ProjectComposition | null {
    const row = revision
      ? this.db.raw.prepare('SELECT * FROM project_compositions WHERE id = ? AND project_id = ? AND user_id = ?').get(revision, projectId, userId)
      : this.db.raw.prepare('SELECT * FROM project_compositions WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId, userId);
    return row ? toComposition(row as CompositionRow) : null;
  }

  /** Activate only if the project still points at the revision the editor read. */
  activateComposition(input: { projectId: string; userId: number; expectedCurrentRevision: string | null; revision: string; applyNow?: boolean }): boolean {
    return immediateTransaction(this.db.raw, () => {
      const revision = this.db.raw.prepare('SELECT 1 FROM project_compositions WHERE id = ? AND project_id = ? AND user_id = ?').get(input.revision, input.projectId, input.userId);
      if (!revision) return false;
      const result = this.db.raw.prepare(`UPDATE projects SET composition_revision = ?, applied_composition_revision = CASE WHEN ? THEN ? ELSE applied_composition_revision END, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND composition_revision IS ?`).run(input.revision, input.applyNow ? 1 : 0, input.revision, new Date().toISOString(), input.projectId, input.userId, input.expectedCurrentRevision);
      return result.changes > 0;
    });
  }

  markCompositionApplied(projectId: string, userId: number, revision: string): boolean {
    const result = this.db.raw.prepare('UPDATE projects SET applied_composition_revision = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND composition_revision = ?').run(revision, new Date().toISOString(), projectId, userId, revision);
    return result.changes > 0;
  }

  listCompositionInstallations(compositionId: string, userId: number): CompositionInstallation[] {
    const rows = this.db.raw.prepare(`SELECT i.* FROM composition_installations i INNER JOIN project_compositions c ON c.id = i.composition_id WHERE i.composition_id = ? AND c.user_id = ? ORDER BY i.created_at, i.rowid`).all(compositionId, userId) as CompositionInstallationRow[];
    return rows.map(toCompositionInstallation);
  }

  /** Recipes with work currently inside the shared owner/tool/version lock. */
  listInstallingCompositionsForUser(userId: number): ProjectComposition[] {
    const rows = this.db.raw.prepare(`SELECT DISTINCT c.*
      FROM project_compositions c
      INNER JOIN composition_installations i ON i.composition_id = c.id
      WHERE c.user_id = ? AND i.status = 'installing'`).all(userId) as CompositionRow[];
    return rows.map(toComposition);
  }

  /** A process restart is the only way an installation can stay `installing`. */
  failInterruptedCompositionInstallations(): number {
    const now = new Date().toISOString();
    const result = this.db.raw.prepare(`UPDATE composition_installations
      SET status = 'failed', installed_version = NULL,
          error_code = 'INSTALL_INTERRUPTED',
          error_message = 'Installation was interrupted by a server restart',
          updated_at = ?
      WHERE status = 'installing'`).run(now);
    return result.changes;
  }

  upsertCompositionInstallation(compositionId: string, itemId: string, patch: Partial<Pick<CompositionInstallation, 'status' | 'installedVersion' | 'errorCode' | 'errorMessage'>> & { incrementAttempts?: boolean }): CompositionInstallation | null {
    const now = new Date().toISOString();
    this.db.raw.prepare(`INSERT INTO composition_installations (id, composition_id, item_id, status, attempts, installed_version, error_code, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(composition_id, item_id) DO UPDATE SET status = COALESCE(excluded.status, composition_installations.status), attempts = composition_installations.attempts + ?, installed_version = excluded.installed_version, error_code = excluded.error_code, error_message = excluded.error_message, updated_at = excluded.updated_at`)
      .run(randomUUID(), compositionId, itemId, patch.status ?? 'pending', patch.incrementAttempts ? 1 : 0, patch.installedVersion ?? null, patch.errorCode ?? null, patch.errorMessage ?? null, now, now, patch.incrementAttempts ? 1 : 0);
    const row = this.db.raw.prepare('SELECT * FROM composition_installations WHERE composition_id = ? AND item_id = ?').get(compositionId, itemId) as CompositionInstallationRow | undefined;
    return row ? toCompositionInstallation(row) : null;
  }

  updateCompositionInstallationForUser(input: { compositionId: string; userId: number; itemId: string; patch: Partial<Pick<CompositionInstallation, 'status' | 'installedVersion' | 'errorCode' | 'errorMessage'>> & { incrementAttempts?: boolean } }): CompositionInstallation | null {
    if (!this.getCompositionForUser(input.compositionId, input.userId)) return null;
    return this.upsertCompositionInstallation(input.compositionId, input.itemId, input.patch);
  }
}
