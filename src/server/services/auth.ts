import type { IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
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

    this.loadPersistedSettings();
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

  async ensureConfiguredInteractive(force = false): Promise<void> {
    if (!force && this.isConfigured()) {
      return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'GitHub OAuth is not configured. Run the server in an interactive terminal once, or supply GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.',
      );
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const defaultBaseUrl =
        this.publicBaseUrl || `${this.useHttps ? 'https' : 'http'}://localhost:${this.port}`;

      console.log('\nInitial setup for Code Agents Web CLI');
      console.log('This installation uses GitHub OAuth for user authentication.\n');

      const publicBaseUrl = await promptValue(
        rl,
        'Public base URL',
        defaultBaseUrl,
        true,
      );
      const githubClientId = await promptValue(
        rl,
        'GitHub OAuth Client ID',
        this.githubClientId || '',
        true,
      );
      const githubClientSecret = await promptSecret(
        rl,
        'GitHub OAuth Client Secret',
        this.githubClientSecret || '',
      );
      const allowedGitHubIds = await promptValue(
        rl,
        'Allowed GitHub user IDs (comma-separated, optional)',
        this.allowedGitHubIds.join(','),
        false,
      );
      const githubAppToken = await promptSecret(
        rl,
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
    } finally {
      rl.close();
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

      res.redirect(redirectTarget || '/');
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

  private isGitHubUserAllowed(githubId: string): boolean {
    return this.allowedGitHubIds.length === 0 || this.allowedGitHubIds.includes(githubId);
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
      acc[key] = decodeURIComponent(value);
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

  if (next.startsWith('//')) {
    return '/';
  }

  return next;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function promptValue(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
  required: boolean,
): Promise<string> {
  while (true) {
    const prompt = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
    const response = (await rl.question(prompt)).trim();
    const value = response || defaultValue;
    if (!required || value) {
      return value;
    }
  }
}

async function promptSecret(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
  allowEmpty = false,
): Promise<string> {
  while (true) {
    const prompt = defaultValue ? `${label} [saved]: ` : `${label}: `;
    const value = (await rl.question(prompt)).trim();
    if (value) {
      return value;
    }
    if (defaultValue) {
      return defaultValue;
    }
    if (allowEmpty) {
      return '';
    }
  }
}

function renderLoginPage(next: string): string {
  return renderPage(
    'Code Agents Web CLI',
    `
      <div class="card">
        <span class="eyebrow">Secure Access</span>
        <h1>Sign in with GitHub</h1>
        <p>This installation uses GitHub OAuth identities for all internal users. Your runtime sessions stay isolated per user in the local SQLite database.</p>
        <a class="button" href="/auth/github/login?next=${encodeURIComponent(next)}">Continue with GitHub</a>
      </div>
    `,
  );
}

function renderSetupRequiredPage(): string {
  return renderPage(
    'Setup Required',
    `
      <div class="card">
        <span class="eyebrow">Setup Required</span>
        <h1>GitHub OAuth is not configured</h1>
        <p>Run the server once in an interactive terminal so it can ask for the GitHub OAuth client ID, client secret, and the optional GitHub App token.</p>
      </div>
    `,
  );
}

function renderAuthErrorPage(message: string): string {
  return renderPage(
    'Authentication Error',
    `
      <div class="card">
        <span class="eyebrow">Authentication Error</span>
        <h1>GitHub sign-in failed</h1>
        <p>${escapeHtml(message)}</p>
        <a class="button secondary" href="/login">Back to login</a>
      </div>
    `,
  );
}

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          color-scheme: dark;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          background:
            radial-gradient(circle at top left, rgba(88, 166, 255, 0.2), transparent 28%),
            radial-gradient(circle at bottom right, rgba(63, 185, 80, 0.12), transparent 24%),
            #0d1117;
          color: #f0f6fc;
        }
        .card {
          width: min(560px, calc(100vw - 32px));
          padding: 32px;
          border: 1px solid rgba(240, 246, 252, 0.12);
          border-radius: 28px;
          background: rgba(22, 27, 34, 0.86);
          box-shadow: 0 24px 64px rgba(1, 4, 9, 0.35);
        }
        .eyebrow {
          display: inline-block;
          margin-bottom: 12px;
          color: #7d8590;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        h1 {
          margin: 0 0 12px;
          font-size: clamp(2rem, 5vw, 2.7rem);
          line-height: 1.04;
        }
        p {
          margin: 0;
          color: #9ba6b2;
          font-size: 15px;
          line-height: 1.65;
        }
        .button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 48px;
          margin-top: 24px;
          padding: 0 18px;
          border-radius: 14px;
          background: linear-gradient(180deg, #58a6ff, #2f81f7);
          color: #fff;
          font-weight: 700;
          text-decoration: none;
        }
        .button.secondary {
          background: rgba(240, 246, 252, 0.06);
          color: #f0f6fc;
        }
      </style>
    </head>
    <body>${body}</body>
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
