import type { IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PromptSession } from '../setup/prompts.js';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthContext, AuthenticatedUser } from '../types.js';
import { AppDatabase } from './database.js';

const AUTH_COOKIE_NAME = 'code_agents_webcli_session';
const OAUTH_STATE_COOKIE_NAME = 'code_agents_webcli_oauth_state';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

interface AuthServiceOptions {
  database: AppDatabase;
  dev: boolean;
  port: number;
  useHttps: boolean;
  publicBaseUrl: string | null;
  githubClientId: string | null;
  githubClientSecret: string | null;
  githubAppToken: string | null;
  allowedGitHubIds: string[];
  allowAnyGitHubUser?: boolean;
}

interface GitHubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
}

interface GitHubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

export class AuthService {
  private readonly database: AppDatabase;
  private readonly dev: boolean;
  private readonly port: number;
  private readonly useHttps: boolean;

  private publicBaseUrl: string | null;
  private githubClientId: string | null;
  private githubClientSecret: string | null;
  private githubAppToken: string | null;
  private allowedGitHubIds: string[];
  private readonly allowAnyGitHubUser: boolean;

  constructor(options: AuthServiceOptions) {
    this.database = options.database;
    this.dev = options.dev;
    this.port = options.port;
    this.useHttps = options.useHttps;
    this.publicBaseUrl = options.publicBaseUrl;
    this.githubClientId = options.githubClientId;
    this.githubClientSecret = options.githubClientSecret;
    this.githubAppToken = options.githubAppToken;
    this.allowedGitHubIds = options.allowedGitHubIds;
    this.allowAnyGitHubUser = options.allowAnyGitHubUser === true;

    this.loadPersistedSettings();

    if (this.allowedGitHubIds.length === 0) {
      if (this.allowAnyGitHubUser) {
        console.warn(
          '\nWARNING: --allow-any-github-user is set and no allow-list is configured.\n' +
            '         ANY GitHub account that can reach this server may sign in and run\n' +
            '         commands on this host. Do not use this on an exposed network.\n',
        );
      } else {
        console.warn(
          '\nWARNING: no allowed GitHub user IDs are configured, so every sign-in will be\n' +
            '         refused. Set --allowed-github-ids (or GITHUB_ALLOWED_USER_IDS), or\n' +
            '         re-run with --setup. Pass --allow-any-github-user to intentionally\n' +
            '         allow anyone.\n',
        );
      }
    }
  }

  get currentAllowedGitHubIds(): string[] {
    return [...this.allowedGitHubIds];
  }

  get gitHubAppToken(): string | null {
    return this.githubAppToken;
  }

  isConfigured(): boolean {
    return Boolean(this.githubClientId && this.githubClientSecret);
  }

  /**
   * Collect and persist the GitHub OAuth configuration.
   *
   * The caller owns the PromptSession so that the run-mode wizard can ask its
   * own questions on the same readline interface afterwards.
   */
  async ensureConfiguredInteractive(
    force = false,
    session?: PromptSession,
  ): Promise<boolean> {
    if (!force && this.isConfigured()) {
      return false;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'GitHub OAuth is not configured. Run the server in an interactive terminal once, or supply GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.',
      );
    }

    const rl = session ?? new PromptSession();
    const ownsSession = !session;

    try {
      const defaultBaseUrl =
        this.publicBaseUrl || `${this.useHttps ? 'https' : 'http'}://localhost:${this.port}`;

      console.log('\nInitial setup for Code Agents Web CLI');
      console.log('This installation uses GitHub OAuth for user authentication.\n');

      const publicBaseUrl = await rl.value('Public base URL', defaultBaseUrl, true);
      const githubClientId = await rl.value(
        'GitHub OAuth Client ID',
        this.githubClientId || '',
        true,
      );
      const githubClientSecret = await rl.secret(
        'GitHub OAuth Client Secret',
        this.githubClientSecret || '',
      );
      // Required: an empty allow-list now denies every sign-in, so silently
      // accepting a blank answer here would produce an unusable install.
      const allowedGitHubIds = await rl.value(
        'Allowed GitHub user IDs (comma-separated)',
        this.allowedGitHubIds.join(','),
        true,
      );
      const githubAppToken = await rl.secret(
        'GitHub App token (optional, press Enter to skip)',
        this.githubAppToken || '',
        true,
      );

      this.persistSetup({
        publicBaseUrl,
        githubClientId,
        githubClientSecret,
        githubAppToken,
        allowedGitHubIds,
      });

      console.log('\nGitHub authentication setup saved to SQLite.\n');
      return true;
    } finally {
      if (ownsSession) {
        rl.close();
      }
    }
  }

  attachRequestContext(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      res.locals.authContext = this.getAuthContextFromIncomingMessage(req);
      next();
    };
  }

  requireAuth(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      const authContext = this.getAuthContextFromResponseLocals(res);
      if (authContext.user) {
        next();
        return;
      }

      if (req.path.startsWith('/api/')) {
        res.status(401).json({
          error: 'authentication_required',
          loginUrl: '/login',
        });
        return;
      }

      res.redirect('/login');
    };
  }

  getAuthContextFromResponseLocals(res: Response): AuthContext {
    return (res.locals.authContext as AuthContext | undefined) || {
      user: null,
      authSessionId: null,
    };
  }

  getAuthContextFromIncomingMessage(message: Pick<IncomingMessage, 'headers'>): AuthContext {
    this.database.pruneExpiredAuthSessions();

    const cookies = parseCookies(message.headers.cookie);
    const authSessionId = cookies[AUTH_COOKIE_NAME];
    if (!authSessionId) {
      return { user: null, authSessionId: null };
    }

    const authSession = this.database.getAuthSession(authSessionId);
    if (!authSession) {
      return { user: null, authSessionId: null };
    }

    if (authSession.expiresAt.getTime() <= Date.now()) {
      this.database.deleteAuthSession(authSessionId);
      return { user: null, authSessionId: null };
    }

    this.database.touchAuthSession(
      authSessionId,
      new Date(Date.now() + SESSION_TTL_MS),
    );

    return {
      user: authSession.user,
      authSessionId,
    };
  }

  handleLoginPage = (req: Request, res: Response): void => {
    if (!this.isConfigured()) {
      res.status(503).send(renderSetupRequiredPage());
      return;
    }

    const authContext = this.getAuthContextFromResponseLocals(res);
    if (authContext.user) {
      res.redirect('/');
      return;
    }

    const next = sanitizeRedirectTarget((req.query.next as string) || '/');
    res.send(renderLoginPage(next));
  };

  handleGitHubLogin = (req: Request, res: Response): void => {
    if (!this.isConfigured()) {
      res.status(503).send(renderSetupRequiredPage());
      return;
    }

    const state = randomBytes(24).toString('hex');
    const redirectTarget = sanitizeRedirectTarget((req.query.next as string) || '/');
    const callbackUrl = this.getCallbackUrl();

    res.setHeader(
      'Set-Cookie',
      serializeCookie(OAUTH_STATE_COOKIE_NAME, `${state}:${redirectTarget}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.shouldUseSecureCookies(),
        maxAge: 600,
        path: '/',
      }),
    );

    const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', this.githubClientId!);
    authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('scope', 'read:user user:email');

    res.redirect(authorizeUrl.toString());
  };

  handleGitHubCallback = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!this.isConfigured()) {
        res.status(503).send(renderSetupRequiredPage());
        return;
      }

      const code = String(req.query.code || '');
      const state = String(req.query.state || '');
      const cookies = parseCookies(req.headers.cookie);
      const stateCookie = cookies[OAUTH_STATE_COOKIE_NAME];

      if (!code || !state || !stateCookie) {
        res.status(400).send(renderAuthErrorPage('Missing OAuth state or code.'));
        return;
      }

      const [expectedState, redirectTarget] = stateCookie.split(':', 2);
      if (!expectedState || expectedState !== state) {
        res.status(400).send(renderAuthErrorPage('GitHub OAuth state validation failed.'));
        return;
      }

      const accessToken = await this.exchangeCodeForAccessToken(code, state);
      const githubUser = await this.fetchGitHubUser(accessToken);

      if (!this.isGitHubUserAllowed(String(githubUser.id))) {
        res.status(403).send(
          renderAuthErrorPage(
            `GitHub user ${githubUser.login} is not allowed to access this installation.`,
          ),
        );
        return;
      }

      const user = this.database.upsertGitHubUser({
        githubId: String(githubUser.id),
        githubLogin: githubUser.login,
        githubName: githubUser.name,
        avatarUrl: githubUser.avatar_url,
        email: githubUser.email,
      });

      const authSessionId = randomUUID();
      this.database.createAuthSession(
        authSessionId,
        user.id,
        new Date(Date.now() + SESSION_TTL_MS),
      );

      res.setHeader('Set-Cookie', [
        serializeCookie(AUTH_COOKIE_NAME, authSessionId, {
          httpOnly: true,
          sameSite: 'lax',
          secure: this.shouldUseSecureCookies(),
          maxAge: SESSION_TTL_MS / 1000,
          path: '/',
        }),
        serializeCookie(OAUTH_STATE_COOKIE_NAME, '', {
          httpOnly: true,
          sameSite: 'lax',
          secure: this.shouldUseSecureCookies(),
          maxAge: 0,
          path: '/',
        }),
      ]);

      // Re-sanitize: the cookie value is not integrity-protected.
      res.redirect(sanitizeRedirectTarget(redirectTarget || '/'));
    } catch (error) {
      console.error('GitHub OAuth callback failed:', error);
      res.status(500).send(
        renderAuthErrorPage(
          error instanceof Error ? error.message : 'Failed to complete GitHub login.',
        ),
      );
    }
  };

  handleLogout = (req: Request, res: Response): void => {
    const authContext = this.getAuthContextFromResponseLocals(res);
    if (authContext.authSessionId) {
      this.database.deleteAuthSession(authContext.authSessionId);
    }

    res.setHeader(
      'Set-Cookie',
      serializeCookie(AUTH_COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.shouldUseSecureCookies(),
        maxAge: 0,
        path: '/',
      }),
    );
    res.redirect('/login');
  };

  handleCurrentUser = (_req: Request, res: Response): void => {
    const authContext = this.getAuthContextFromResponseLocals(res);
    if (!authContext.user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    res.json({
      user: authContext.user,
      logoutUrl: '/auth/logout',
    });
  };

  private persistSetup(values: {
    publicBaseUrl: string;
    githubClientId: string;
    githubClientSecret: string;
    githubAppToken: string;
    allowedGitHubIds: string;
  }): void {
    this.database.setSetting('config.publicBaseUrl', values.publicBaseUrl);
    this.database.setSetting('config.githubClientId', values.githubClientId);
    this.database.setSetting('config.githubClientSecret', values.githubClientSecret);
    this.database.setSetting('config.githubAppToken', values.githubAppToken);
    this.database.setSetting('config.allowedGitHubIds', values.allowedGitHubIds);

    this.publicBaseUrl = values.publicBaseUrl;
    this.githubClientId = values.githubClientId;
    this.githubClientSecret = values.githubClientSecret;
    this.githubAppToken = values.githubAppToken || null;
    this.allowedGitHubIds = values.allowedGitHubIds
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private loadPersistedSettings(): void {
    this.publicBaseUrl =
      this.publicBaseUrl || this.database.getSetting('config.publicBaseUrl');
    this.githubClientId =
      this.githubClientId || this.database.getSetting('config.githubClientId');
    this.githubClientSecret =
      this.githubClientSecret || this.database.getSetting('config.githubClientSecret');
    this.githubAppToken =
      this.githubAppToken || this.database.getSetting('config.githubAppToken');

    if (this.allowedGitHubIds.length === 0) {
      const persistedAllowList = this.database.getSetting('config.allowedGitHubIds');
      if (persistedAllowList) {
        this.allowedGitHubIds = persistedAllowList
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
      }
    }
  }

  private getCallbackUrl(): string {
    const baseUrl =
      this.publicBaseUrl || `${this.useHttps ? 'https' : 'http'}://localhost:${this.port}`;
    return new URL('/auth/github/callback', baseUrl).toString();
  }

  private shouldUseSecureCookies(): boolean {
    return this.useHttps || (this.publicBaseUrl?.startsWith('https://') ?? false);
  }

  private async exchangeCodeForAccessToken(code: string, state: string): Promise<string> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'code-agents-webcli',
      },
      body: JSON.stringify({
        client_id: this.githubClientId,
        client_secret: this.githubClientSecret,
        code,
        redirect_uri: this.getCallbackUrl(),
        state,
      }),
    });

    const payload = (await response.json()) as GitHubAccessTokenResponse;
    if (!response.ok || !payload.access_token) {
      throw new Error(payload.error_description || payload.error || 'GitHub token exchange failed.');
    }

    return payload.access_token;
  }

  private async fetchGitHubUser(accessToken: string): Promise<GitHubUserResponse> {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'code-agents-webcli',
    };

    const userResponse = await fetch('https://api.github.com/user', { headers });
    if (!userResponse.ok) {
      throw new Error(`GitHub user lookup failed with status ${userResponse.status}.`);
    }

    const user = (await userResponse.json()) as GitHubUserResponse;
    if (user.email) {
      return user;
    }

    const emailsResponse = await fetch('https://api.github.com/user/emails', { headers });
    if (!emailsResponse.ok) {
      return user;
    }

    const emails = (await emailsResponse.json()) as GitHubEmailResponse[];
    const primaryEmail = emails.find((entry) => entry.primary && entry.verified)
      || emails.find((entry) => entry.verified)
      || emails[0];

    return {
      ...user,
      email: primaryEmail?.email || null,
    };
  }

  /**
   * Whether this GitHub account may sign in right now.
   *
   * Public because the installer lookup needs the same answer: an account that
   * cannot sign in cannot be the installer either, and reading the allow-list
   * out of settings a second time would let the two drift apart.
   */
  isGitHubUserAllowed(githubId: string): boolean {
    // Fail closed. An empty allow-list used to mean "allow every GitHub account
    // on earth", and since any signed-in user can spawn PTY processes on the
    // host, that made an exposed instance equivalent to unauthenticated RCE.
    // Opening the instance up is now an explicit, loudly logged opt-in.
    if (this.allowedGitHubIds.length === 0) {
      return this.allowAnyGitHubUser;
    }
    return this.allowedGitHubIds.includes(githubId);
  }
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, pair) => {
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex <= 0) {
        return acc;
      }

      const key = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      try {
        acc[key] = decodeURIComponent(value);
      } catch {
        // decodeURIComponent throws URIError on malformed input (e.g. "a=%").
        // This runs on the unauthenticated WebSocket upgrade path, where an
        // uncaught throw would take the whole process down.
        acc[key] = value;
      }
      return acc;
    }, {});
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
    secure?: boolean;
    maxAge?: number;
    path?: string;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);

  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${capitalize(options.sameSite)}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function sanitizeRedirectTarget(next: string): string {
  if (!next || !next.startsWith('/')) {
    return '/';
  }

  // Resolve against a placeholder origin and keep the target only if it stayed
  // same-origin. A leading "//" or "/\" would otherwise escape off-site:
  // per the URL spec a backslash acts as a slash in special schemes, so
  // "/\evil.com" resolves to "https://evil.com/".
  try {
    const resolved = new URL(next, 'http://placeholder.invalid');
    if (resolved.origin !== 'http://placeholder.invalid') {
      return '/';
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderLoginPage(next: string): string {
  return renderPage(
    'Code Agents Web CLI',
    `
      <span class="eyebrow">Secure access</span>
      <h1>Sign in with GitHub</h1>
      <p>Every user signs in with a GitHub identity. Sessions stay isolated per user in the local database.</p>
      <a class="button" href="/auth/github/login?next=${encodeURIComponent(next)}">Continue with GitHub</a>
    `,
  );
}

function renderSetupRequiredPage(): string {
  return renderPage(
    'Setup Required',
    `
      <span class="eyebrow">Setup required</span>
      <h1>GitHub OAuth is not configured</h1>
      <p>Run the server once in an interactive terminal, or start it with <code>--setup</code>, so it can ask for the OAuth client ID, the client secret and the optional GitHub App token.</p>
    `,
  );
}

function renderAuthErrorPage(message: string): string {
  return renderPage(
    'Authentication Error',
    `
      <span class="eyebrow">Authentication error</span>
      <h1>GitHub sign-in failed</h1>
      <p class="error">${escapeHtml(message)}</p>
      <a class="button secondary" href="/login">Back to sign in</a>
    `,
  );
}

/**
 * The shell for the pages served before a user is signed in.
 *
 * These are the first thing anyone sees, and until now they were the last part
 * of the app still speaking the old visual language: 28px radii, blue
 * gradients, radial glows over #0d1117 — everything the interface behind them
 * stopped using.
 *
 * They link the real design tokens rather than restating their values. That is
 * the whole point: a token change reaches the login screen without anyone
 * remembering this file exists. /css/relay/relay.css is static and sits ahead
 * of requireAuth, so it is reachable while signed out.
 */
function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>${escapeHtml(title)}</title>
      <meta name="theme-color" content="#0a0a0a" />
      <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
      <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
      <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png" />
      <link rel="stylesheet" href="/css/relay/relay.css" />
      <script>
        // The app stores its mode under this key and signals light with a class
        // on <html>. Reading it here stops a dark sign-in page from flashing in
        // front of a light app. Inline and before paint, so there is no flash
        // to fix afterwards.
        (function () {
          try {
            if (localStorage.getItem('cc-web-relay-theme') === 'light') {
              document.documentElement.classList.add('light');
            }
          } catch (e) { /* private mode; dark is the default anyway */ }
        })();
      </script>
      <style>
        body {
          display: grid;
          place-items: center;
          padding: 24px;
          /* relay.css hides body overflow for the app shell, which owns the
             viewport. These pages are a centred card that must be able to
             scroll on a short window. */
          overflow: auto;
        }
        .card {
          width: min(460px, 100%);
          padding: var(--space-6);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: var(--card);
          box-shadow: var(--shadow-lg);
        }
        .mark {
          display: flex;
          align-items: center;
          gap: 9px;
          margin-bottom: 22px;
          color: var(--muted-foreground);
          font-family: var(--font-mono);
          font-size: var(--text-xs);
          letter-spacing: var(--tracking-caps);
          text-transform: uppercase;
        }
        .mark img {
          width: 20px;
          height: 20px;
          display: block;
        }
        .eyebrow {
          display: block;
          margin-bottom: 10px;
          color: var(--muted-foreground);
          font-family: var(--font-mono);
          font-size: var(--text-2xs);
          letter-spacing: var(--tracking-caps);
          text-transform: uppercase;
        }
        h1 {
          margin: 0 0 10px;
          font-size: var(--text-2xl);
          font-weight: var(--font-semibold);
          line-height: var(--leading-tight);
          color: var(--foreground);
        }
        p {
          margin: 0;
          color: var(--muted-foreground);
          font-size: var(--text-ui);
          line-height: var(--leading-normal);
        }
        code {
          padding: 1px 5px;
          border: 1px solid var(--border);
          background: var(--secondary);
          font-family: var(--font-mono);
          font-size: var(--text-sm);
          color: var(--foreground);
        }
        .button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          /* 40px, not the app's 32px: this is the one control on the page and
             is routinely tapped on a phone. */
          min-height: 40px;
          margin-top: 22px;
          padding: 0 16px;
          border: 1px solid var(--primary);
          border-radius: var(--radius);
          background: var(--primary);
          color: var(--primary-foreground);
          font-family: var(--font-sans);
          font-size: var(--text-ui);
          font-weight: var(--font-medium);
          text-decoration: none;
          transition: filter var(--duration-fast) var(--ease-standard);
        }
        .button:hover { filter: brightness(0.9); }
        .button:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
        .button.secondary {
          border-color: var(--border);
          background: transparent;
          color: var(--foreground);
        }
        .button.secondary:hover { filter: none; background: var(--accent); }
        .error {
          margin-top: 14px;
          padding: 10px 12px;
          border: 1px solid var(--destructive);
          background: var(--secondary);
          color: var(--foreground);
          font-size: var(--text-sm);
          line-height: var(--leading-normal);
          word-break: break-word;
        }
      </style>
    </head>
    <body>
      <main class="card">
        <div class="mark">
          <img src="/icons/icon.svg" alt="" width="20" height="20" />
          <span>Code Agents</span>
        </div>
        ${body}
      </main>
    </body>
  </html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
