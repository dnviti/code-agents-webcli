/** Bounded, redirect-free validation for owner-supplied forge credentials. */

export type ForgeValidationKind = 'github' | 'gitlab' | 'gitea' | 'forgejo';

export interface ConnectedHostValidationInput {
  host: string;
  url: string;
  token: string;
  forgeKind: ForgeValidationKind;
  redirect: 'error';
  timeoutMs: number;
  maxResponseBytes: number;
}

export type ConnectedHostValidationResult =
  | { ok: true; scopes?: string[]; expiresAt?: string | null }
  | { ok: false; status?: 401 | 403 | 422; code: string; message: string };

export class ConnectedHostValidator {
  constructor(private readonly fetch_: typeof fetch = fetch) {}

  async validate(input: ConnectedHostValidationInput): Promise<ConnectedHostValidationResult> {
    const base = exactBase(input.host, input.url);
    if (!base || !input.token || /[\0\r\n]/u.test(input.token)) {
      return { ok: false, status: 422, code: 'validation_input', message: 'Host or credential is invalid.' };
    }
    const endpoint = validationEndpoint(base, input.forgeKind);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
    timer.unref();
    try {
      const response = await this.fetch_(endpoint, {
        method: 'GET',
        redirect: input.redirect,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `${input.forgeKind === 'gitea' || input.forgeKind === 'forgejo' ? 'token' : 'Bearer'} ${input.token}`,
          'User-Agent': 'code-agents-webcli',
        },
      });
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > input.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, status: 422, code: 'response_too_large', message: 'Host validation returned too much data.' };
      }
      const withinBound = await consumeBounded(response.body, input.maxResponseBytes);
      if (!withinBound) {
        return { ok: false, status: 422, code: 'response_too_large', message: 'Host validation returned too much data.' };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, code: 'credential_rejected', message: 'The host rejected this credential.' };
      }
      if (!response.ok) {
        return { ok: false, status: 422, code: 'host_unavailable', message: `Host validation returned HTTP ${response.status}.` };
      }
      const scopes = response.headers.get('x-oauth-scopes')
        ?.split(',').map((scope) => scope.trim()).filter(Boolean);
      return { ok: true, ...(scopes?.length ? { scopes } : {}) };
    } catch (error) {
      return controller.signal.aborted
        ? { ok: false, status: 422, code: 'validation_timeout', message: 'Host validation timed out.' }
        : { ok: false, status: 422, code: 'host_unavailable', message: 'Could not reach the host without a redirect.' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function exactBase(host: string, url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host.toLowerCase() !== host.toLowerCase()
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validationEndpoint(base: URL, forgeKind: ForgeValidationKind): URL {
  if (forgeKind === 'github' && base.hostname === 'github.com') {
    // GitHub.com's API is its documented, fixed sibling host. Enterprise uses
    // the exact supplied host below; no arbitrary redirect is followed.
    return new URL('https://api.github.com/user');
  }
  const path = forgeKind === 'github' ? '/api/v3/user'
    : forgeKind === 'gitlab' ? '/api/v4/user'
      : '/api/v1/user';
  return new URL(path, base);
}

async function consumeBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<boolean> {
  if (!body) return true;
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return true;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
