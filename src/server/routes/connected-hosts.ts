/**
 * Personal connected-host credentials for project clone/push.
 *
 * Tokens are never returned; the list only shows which hosts have a stored
 * credential. Writes are same-origin, matching the other state-changing
 * routes.
 */

import { Request, Response, Router } from 'express';
import { requireUser } from './helpers.js';
import type { AuthenticatedUser } from '../types.js';
import type { ConnectedHost, ConnectedHostValidationStatus } from '../services/projects/store.js';

export type ConnectedHostForgeKind = 'github' | 'gitlab' | 'gitea' | 'forgejo';

export type ConnectedHostTokenValidation =
  | { ok: true; scopes?: string[]; expiresAt?: string | null }
  | { ok: false; status?: 401 | 403 | 422; code: string; message: string };

/**
 * The integration-owned validator. It must request only `url`, reject redirects,
 * bound both time and response body, and must never include `token` in a URL,
 * log, or returned error. OAuth approval belongs to #170 and is intentionally
 * not an alternative implementation of this token validator.
 */
export interface ConnectedHostTokenValidator {
  validate(input: {
    host: string;
    url: string;
    token: string;
    forgeKind: ConnectedHostForgeKind;
    redirect: 'error';
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<ConnectedHostTokenValidation>;
}

export interface ConnectedHostRoutesDeps {
  projectStore: {
    listConnectedHosts(userId: number): ConnectedHost[];
    upsertConnectedHostToken(userId: number, host: string, token: string): ConnectedHost;
    setConnectedHostValidation(input: {
      userId: number; host: string; kind?: string; forgeKind?: string | null;
      expectedCredentialRevision?: number;
      status: ConnectedHostValidationStatus; errorCode?: string | null; errorMessage?: string | null;
      scopes?: string[]; expiresAt?: string | null;
    }): boolean;
    deleteConnectedHost(userId: number, host: string): boolean;
  };
  /** Optional during the legacy connected-host migration. New forge choices require it. */
  tokenValidator?: ConnectedHostTokenValidator;
  /** Serialize source replacement, validation, and live tmpfs refresh. */
  synchronizeHostCredentialReplacement?<T>(
    userId: number,
    host: string,
    mutation: () => Promise<T> | T,
  ): Promise<T>;
  /** Scrub exact owner/host live tmpfs material before its source credential is deleted. */
  disconnectHostCredentials?(userId: number, host: string): Promise<boolean | void>;
}

const FORGE_KINDS = new Set<ConnectedHostForgeKind>(['github', 'gitlab', 'gitea', 'forgejo']);
const VALIDATION_TIMEOUT_MS = 5_000;
const VALIDATION_MAX_RESPONSE_BYTES = 64 * 1024;

function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function normalizedHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\\/?#@\s]/u.test(raw)) return null;

  try {
    const parsed = new URL(`https://${raw}`);
    if (
      !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function paramHost(req: Request): string | null {
  return normalizedHost(String(req.params.host));
}

function forgeKind(value: unknown): ConnectedHostForgeKind | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && FORGE_KINDS.has(value as ConnectedHostForgeKind)
    ? value as ConnectedHostForgeKind
    : undefined;
}

function safeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token && token.length <= 16_384 && !/[\0\r\n]/u.test(token) ? token : null;
}

function safeValidationMessage(value: unknown, fallback: string, secrets: string[] = []): string {
  if (typeof value !== 'string') return fallback;
  let message = value.replace(/[\0\r\n]/gu, ' ').trim();
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join('[redacted]');
  }
  return message && message.length <= 240 ? message : fallback;
}

function requireAuth(req: Request, res: Response, write: boolean): AuthenticatedUser | null {
  const user = requireUser(res);
  if (!user) {
    res.status(401).json({ error: 'authentication_required' });
    return null;
  }
  if (write && !isSameOrigin(req)) {
    res.status(403).json({ error: 'cross_origin' });
    return null;
  }
  return user;
}

export function createConnectedHostRoutes(deps: ConnectedHostRoutesDeps): Router {
  const router = Router();

  router.get('/api/connected-hosts', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;
    res.json({ hosts: deps.projectStore.listConnectedHosts(user.id) });
  });

  router.post('/api/connected-hosts', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const host = normalizedHost(body.host);
    const token = safeToken(body.token);
    const selectedForge = forgeKind(body.forgeKind);

    if (!host) {
      res.status(400).json({
        error: 'validation',
        message: 'host must be a hostname or hostname:port, without a scheme or path.',
      });
      return;
    }
    if (!token) {
      res.status(400).json({ error: 'validation', message: 'token is required and must not contain control characters.' });
      return;
    }
    if (selectedForge === undefined) {
      res.status(400).json({ error: 'validation', message: 'forgeKind must be github, gitlab, gitea, or forgejo.' });
      return;
    }
    // OAuth approval is deliberately unavailable until #170 provides a
    // provider registry. Do not treat an arbitrary browser value as an OAuth
    // credential or silently fall back to a token connection.
    if (body.credentialKind !== undefined && body.credentialKind !== 'token') {
      res.status(501).json({
        error: 'oauth_approval_unavailable',
        message: 'OAuth host approval is not available yet; connect this host with a token.',
      });
      return;
    }

    type MutationResult =
      | { ok: true; hostRecord: ConnectedHost }
      | { ok: false; status: number; body: Record<string, unknown> };
    let mutationCompleted = false;
    const mutation = async (): Promise<MutationResult> => {
      const hostRecord = deps.projectStore.upsertConnectedHostToken(user.id, host, token);
      if (selectedForge && deps.tokenValidator) {
        let validation: ConnectedHostTokenValidation;
        try {
          validation = await deps.tokenValidator.validate({
            host,
            url: `https://${host}`,
            token,
            forgeKind: selectedForge,
            redirect: 'error',
            timeoutMs: VALIDATION_TIMEOUT_MS,
            maxResponseBytes: VALIDATION_MAX_RESPONSE_BYTES,
          });
        } catch {
          validation = { ok: false, code: 'validation_unavailable', message: 'Could not validate this host right now. Try again.' };
        }
        if (!validation.ok) {
          const message = safeValidationMessage(validation.message, 'The credential was not accepted by this host.', [token]);
          const saved = deps.projectStore.setConnectedHostValidation({
            userId: user.id, host, kind: 'token',
            expectedCredentialRevision: hostRecord.credentialRevision,
            forgeKind: selectedForge, status: 'invalid',
            errorCode: safeValidationMessage(validation.code, 'credential_invalid', [token]), errorMessage: message,
          });
          mutationCompleted = true;
          if (!saved) {
            return {
              ok: false,
              status: 409,
              body: { error: 'credential_changed', message: 'The credential changed while validation was in progress. Retry with the current value.' },
            };
          }
          return {
            ok: false,
            status: validation.status === 401 || validation.status === 403 ? 401 : 422,
            body: {
              error: 'credential_invalid',
              code: safeValidationMessage(validation.code, 'credential_invalid', [token]),
              message,
            },
          };
        }
        const saved = deps.projectStore.setConnectedHostValidation({
          userId: user.id, host, kind: 'token',
          expectedCredentialRevision: hostRecord.credentialRevision,
          forgeKind: selectedForge, status: 'valid',
          scopes: validation.scopes, expiresAt: validation.expiresAt,
        });
        mutationCompleted = true;
        if (!saved) {
          return {
            ok: false,
            status: 409,
            body: { error: 'credential_changed', message: 'The credential changed while validation was in progress. Retry with the current value.' },
          };
        }
      } else if (selectedForge) {
        // Keep the stored token usable by legacy clone paths, but make the lack
        // of the #170/integration validator visible instead of claiming it was
        // authenticated for a forge CLI.
        const saved = deps.projectStore.setConnectedHostValidation({
          userId: user.id, host, kind: 'token',
          expectedCredentialRevision: hostRecord.credentialRevision,
          forgeKind: selectedForge, status: 'unvalidated',
          errorCode: 'validator_unavailable', errorMessage: 'Host validation is not configured on this installation.',
        });
        mutationCompleted = true;
        if (!saved) {
          return {
            ok: false,
            status: 409,
            body: { error: 'credential_changed', message: 'The credential changed while validation was in progress. Retry with the current value.' },
          };
        }
      } else {
        mutationCompleted = true;
      }
      const current = deps.projectStore.listConnectedHosts(user.id)
        .find((entry) => entry.id === hostRecord.id) ?? hostRecord;
      return { ok: true, hostRecord: current };
    };

    try {
      const result = deps.synchronizeHostCredentialReplacement
        ? await deps.synchronizeHostCredentialReplacement(user.id, host, mutation)
        : await mutation();
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      res.status(200).json({ host: result.hostRecord });
    } catch {
      res.status(mutationCompleted ? 503 : 400).json(mutationCompleted
        ? { error: 'credential_refresh_failed', message: 'The credential was saved, but running projects could not be refreshed. Stop them and retry.' }
        : { error: 'validation', message: 'The credential could not be stored.' });
    }
  });

  router.delete('/api/connected-hosts/:host', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const host = paramHost(req);
    if (!host) {
      res.status(400).json({ error: 'validation', message: 'host is invalid.' });
      return;
    }
    if (!deps.projectStore.listConnectedHosts(user.id).some((entry) => entry.host === host)) {
      res.status(404).json({ error: 'not_found', message: 'Host not found.' });
      return;
    }
    let sourceDeleted = false;
    if (deps.disconnectHostCredentials) {
      try {
        sourceDeleted = (await deps.disconnectHostCredentials(user.id, host)) === true;
      } catch {
        // Keep the encrypted source row so a retry can scrub every verified
        // runtime before the only usable credential disappears.
        res.status(503).json({
          error: 'credential_scrub_failed',
          message: 'Could not remove this credential from every running project. Try again.',
        });
        return;
      }
    }
    const removed = sourceDeleted || deps.projectStore.deleteConnectedHost(user.id, host);
    if (!removed) {
      res.status(404).json({ error: 'not_found', message: 'Host not found.' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
