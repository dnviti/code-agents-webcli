/** Partial class: connected-host tokens, oauth fallbacks, and credential retrieval. */

import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../database.js';
import type { EncryptionKeyRing } from '../../encryption.js';
import type {
  ConnectedCredential,
  ConnectedHost,
  ConnectedHostValidationStatus,
} from './types.js';
import { credentialExpired, toConnectedHost, usableCredentialRow, type ConnectedHostRow } from './rows.js';
import { ProjectStoreCore } from './core.js';

export abstract class ProjectStoreHosts extends ProjectStoreCore {
  /** Every host this user has connected, never with the credential. */
  listConnectedHosts(userId: number): ConnectedHost[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM connected_hosts WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as ConnectedHostRow[];
    const byHost = new Map<string, ConnectedHost>();
    for (const row of rows.map(toConnectedHost)) {
      const prior = byHost.get(row.host);
      // A user-supplied token is the visible/preferred record; the sign-in
      // credential remains a fallback and is never allowed to overwrite it.
      if (!prior || (prior.credentialKind === 'oauth' && row.credentialKind === 'token')) {
        byHost.set(row.host, row);
      }
    }
    return [...byHost.values()];
  }

  /**
   * Store (or replace) a personal access token for a host.
   *
   * Encrypted before it touches the database: the plaintext exists in this
   * process and nowhere else, and the unique (user, host, kind) key makes a
   * repeat submission a replacement rather than a second row.
   */
  upsertConnectedHostToken(userId: number, host: string, token: string): ConnectedHost {
    const normalized = (host || '').trim().toLowerCase();
    if (!normalized) {
      throw new Error('connected host requires a host');
    }
    if (!token) {
      throw new Error('connected host requires a token');
    }
    const now = new Date().toISOString();
    const encrypted = this.keyRing.encrypt(token);
    this.db.raw
      .prepare(
        `INSERT INTO connected_hosts (
          id, user_id, host, kind, identity_id, credential_encrypted,
          scopes_json, expires_at, last_used_at, forge_kind, credential_kind,
          validation_status, credential_revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'token', NULL, ?, NULL, NULL, NULL, NULL, 'token', 'unvalidated', 1, ?, ?)
        ON CONFLICT(user_id, host, kind) DO UPDATE SET
          credential_encrypted = excluded.credential_encrypted,
          credential_kind = excluded.credential_kind,
          forge_kind = NULL, scopes_json = NULL, expires_at = NULL,
          last_validated_at = NULL, validation_status = 'unvalidated', validation_error_code = NULL,
          validation_error_message = NULL,
          credential_revision = COALESCE(connected_hosts.credential_revision, 0) + 1,
          updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), userId, normalized, encrypted, now, now);
    const row = this.db.raw
      .prepare('SELECT * FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
      .get(userId, normalized, 'token') as ConnectedHostRow;
    return toConnectedHost(row);
  }

  /** GitHub sign-in fallback, kept separate so it never replaces an owner's PAT. */
  upsertConnectedHostOAuth(userId: number, host: string, token: string): ConnectedHost {
    const normalized = (host || '').trim().toLowerCase();
    if (!normalized || !token) throw new Error('connected host requires a host and credential');
    const now = new Date().toISOString();
    const encrypted = this.keyRing.encrypt(token);
    this.db.raw.prepare(`INSERT INTO connected_hosts (
      id, user_id, host, kind, identity_id, credential_encrypted,
      scopes_json, expires_at, last_used_at, forge_kind, credential_kind,
      validation_status, credential_revision, created_at, updated_at
    ) VALUES (?, ?, ?, 'oauth', NULL, ?, NULL, NULL, NULL, 'github', 'oauth', 'valid', 1, ?, ?)
    ON CONFLICT(user_id, host, kind) DO UPDATE SET credential_encrypted = excluded.credential_encrypted,
      forge_kind = 'github', credential_kind = 'oauth', validation_status = 'valid',
      scopes_json = NULL, expires_at = NULL, last_validated_at = NULL,
      validation_error_code = NULL, validation_error_message = NULL,
      credential_revision = COALESCE(connected_hosts.credential_revision, 0) + 1,
      updated_at = excluded.updated_at`).run(randomUUID(), userId, normalized, encrypted, now, now);
    const row = this.db.raw.prepare('SELECT * FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
      .get(userId, normalized, 'oauth') as ConnectedHostRow;
    return toConnectedHost(row);
  }

  /** Store only safe validation metadata; token material never leaves credentialFor. */
  setConnectedHostValidation(input: { userId: number; host: string; kind?: 'token' | 'oauth'; expectedCredentialRevision?: number; forgeKind?: string | null; status: ConnectedHostValidationStatus; errorCode?: string | null; errorMessage?: string | null; scopes?: string[]; expiresAt?: string | null }): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw.prepare(`UPDATE connected_hosts SET
      forge_kind = CASE WHEN ? THEN ? ELSE forge_kind END,
      validation_status = ?, last_validated_at = ?, validation_error_code = ?, validation_error_message = ?,
      scopes_json = CASE WHEN ? THEN ? ELSE scopes_json END,
      expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
      updated_at = ? WHERE user_id = ? AND host = ? AND kind = ?
      AND (? = 0 OR credential_revision = ?)`)
      .run(input.forgeKind !== undefined ? 1 : 0, input.forgeKind ?? null, input.status, now, input.errorCode ?? null, input.errorMessage ?? null,
        input.scopes !== undefined ? 1 : 0, input.scopes === undefined ? null : JSON.stringify(input.scopes),
        input.expiresAt !== undefined ? 1 : 0, input.expiresAt ?? null,
        now, input.userId, input.host.trim().toLowerCase(), input.kind ?? 'token',
        input.expectedCredentialRevision === undefined ? 0 : 1,
        input.expectedCredentialRevision ?? -1);
    return result.changes > 0;
  }

  deleteConnectedHost(userId: number, host: string, kind = 'token'): boolean {
    const result = kind === 'token'
      ? this.db.raw.prepare('DELETE FROM connected_hosts WHERE user_id = ? AND host = ?')
        .run(userId, host.trim().toLowerCase())
      : this.db.raw.prepare('DELETE FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
        .run(userId, host.trim().toLowerCase(), kind);
    return result.changes > 0;
  }

  /**
   * The plaintext credential for clone and push, or null when none is stored.
   *
   * The only method that decrypts: credentials exist to be used in exactly
   * two places (clone, preservation push), and both ask for one host's token
   * at the moment they need it.
   */
  credentialKindFor(userId: number, host: string): 'token' | 'oauth' | null {
    const rows = this.db.raw.prepare(`SELECT kind FROM connected_hosts
      WHERE user_id = ? AND host = ? AND credential_encrypted IS NOT NULL
      ORDER BY CASE kind WHEN 'token' THEN 0 WHEN 'oauth' THEN 1 ELSE 2 END
      LIMIT 1`).get(userId, host.trim().toLowerCase()) as { kind: string } | undefined;
    return rows?.kind === 'token' || rows?.kind === 'oauth' ? rows.kind : null;
  }

  credentialRecordFor(userId: number, host: string, kind = 'token'): ConnectedCredential | null {
    type CredentialRow = {
      credential_encrypted: string | null;
      validation_status: string | null;
      expires_at: string | null;
      credential_revision: number;
    };
    const normalized = host.trim().toLowerCase();
    let row = this.db.raw
      .prepare(
        'SELECT credential_encrypted, validation_status, expires_at, credential_revision FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?',
      )
      .get(userId, normalized, kind) as CredentialRow | undefined;
    let usedKind = kind;
    // A present manual credential is the owner's explicit choice. If it is
    // known bad, do not silently substitute the sign-in credential.
    if (row && !usableCredentialRow(row)) {
      if (credentialExpired(row.expires_at)) this.markCredentialExpired(userId, normalized, kind, row.credential_revision);
      return null;
    }
    if (!row?.credential_encrypted && kind === 'token') {
      row = this.db.raw.prepare(
        'SELECT credential_encrypted, validation_status, expires_at, credential_revision FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?',
      ).get(userId, normalized, 'oauth') as CredentialRow | undefined;
      usedKind = 'oauth';
    }
    if (!row?.credential_encrypted || !usableCredentialRow(row)) {
      if (row && credentialExpired(row.expires_at)) this.markCredentialExpired(userId, normalized, usedKind, row.credential_revision);
      return null;
    }
    const token = this.keyRing.decrypt(row.credential_encrypted);
    this.db.raw
      .prepare(
        'UPDATE connected_hosts SET last_used_at = ? WHERE user_id = ? AND host = ? AND kind = ?',
      )
      .run(new Date().toISOString(), userId, normalized, usedKind);
    return {
      token,
      kind: usedKind as 'token' | 'oauth',
      revision: row.credential_revision,
    };
  }

  credentialFor(userId: number, host: string, kind = 'token'): string | null {
    return this.credentialRecordFor(userId, host, kind)?.token || null;
  }

  private markCredentialExpired(userId: number, host: string, kind: string, revision: number): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`UPDATE connected_hosts SET validation_status = 'invalid',
      last_validated_at = ?, validation_error_code = 'credential_expired',
      validation_error_message = 'The stored credential has expired', updated_at = ?
      WHERE user_id = ? AND host = ? AND kind = ? AND credential_revision = ?`)
      .run(now, now, userId, host, kind, revision);
  }
}
