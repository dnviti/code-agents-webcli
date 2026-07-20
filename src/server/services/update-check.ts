import { BuildInfo, shortSha } from './build-info.js';
import { stripAnsi } from './ansi.js';
import { UpdateState, UpdateStatus } from '../../shared/update.js';

export type { UpdateState, UpdateStatus };

/**
 * Where updates come from.
 *
 * Hard-coded constants, never configuration: the only value ever interpolated
 * into these URLs is a commit SHA that has been validated as 40 lowercase hex
 * at both write and read time, so no request field, setting or API response
 * can redirect the outbound call.
 */
const GITHUB_API = 'https://api.github.com';
const REPO_OWNER = 'dnviti';
const REPO_NAME = 'code-agents-webcli';
const BRANCH = 'main';

export const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;
export const INSTALL_SPEC = `github:${REPO_SLUG}`;

/** Background refresh cadence once a check has succeeded. */
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
/** Retry sooner after a transport failure, but not aggressively. */
const FAILURE_TTL_MS = 30 * 60 * 1000;
/**
 * Hard floor between any two outbound calls, however many users click Check.
 * This is the rate-limit budget: unauthenticated GitHub allows 60 requests an
 * hour per IP, and a check costs at most two.
 */
const MIN_INTERVAL_MS = 15 * 60 * 1000;
/** A hostile or misbehaving endpoint must not be able to exhaust memory. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_SUBJECT_LENGTH = 100;

const SETTING_STATUS = 'update.lastStatus';
const SETTING_ETAG = 'update.commitsEtag';

export interface UpdateCheckerOptions {
  buildInfo: BuildInfo;
  settings: {
    getSetting(key: string): string | null;
    setSetting(key: string, value: string): void;
  };
  fetchImpl?: typeof fetch;
  now?: () => number;
  onStatus?: (status: UpdateStatus) => void;
}

interface CappedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Read a response body with a hard byte ceiling.
 *
 * Deliberately not `res.text()` then a length check: text() buffers the entire
 * body first, so the check would happen after the allocation it is meant to
 * prevent.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('Response larger than the allowed maximum');
  }

  if (!res.body) {
    return '';
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Response larger than the allowed maximum');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function emptyStatus(buildInfo: BuildInfo, now: number): UpdateStatus {
  return {
    state: 'never_checked',
    installed: {
      sha: buildInfo.sha,
      short: shortSha(buildInfo.sha),
      commitDate: buildInfo.commitDate,
      version: buildInfo.version,
      dirty: buildInfo.dirty,
      source: buildInfo.source,
    },
    remote: { sha: null, short: null, commitDate: null, subject: null },
    behindBy: null,
    checkedAt: null,
    nextCheckAllowedAt: now,
    message: null,
  };
}

/**
 * Compares the running build against the tip of main.
 *
 * Never throws: every failure path resolves to a status whose `state` says
 * what went wrong, because a GitHub outage must not turn into a 500 on a page
 * whose actual job is running terminals.
 */
export class UpdateChecker {
  private readonly buildInfo: BuildInfo;
  private readonly settings: UpdateCheckerOptions['settings'];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onStatus: ((status: UpdateStatus) => void) | undefined;

  private status: UpdateStatus;
  private inFlight: Promise<UpdateStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.buildInfo = options.buildInfo;
    this.settings = options.settings;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
    this.onStatus = options.onStatus;
    this.status = this.restore();
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * A previous process already paid for a check; a restart should not burn a
   * fresh request against the hourly budget just to redraw the same banner.
   */
  private restore(): UpdateStatus {
    const fallback = emptyStatus(this.buildInfo, this.now());
    const raw = this.settings.getSetting(SETTING_STATUS);
    if (!raw) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<UpdateStatus>;
      // A stored status describing a different build is worthless — it is what
      // the *previous* install was comparing.
      if (parsed.installed?.sha !== this.buildInfo.sha) {
        // The ETag has to go with it. Keeping it would send If-None-Match on
        // the next check, GitHub would answer 304 ("nothing changed since you
        // last asked"), and the 304 branch would re-publish this very
        // never_checked status — leaving the banner stuck immediately after a
        // successful update, until someone happened to push to main.
        this.settings.setSetting(SETTING_ETAG, '');
        return fallback;
      }
      return { ...fallback, ...parsed, installed: fallback.installed };
    } catch {
      return fallback;
    }
  }

  private persist(): void {
    try {
      this.settings.setSetting(SETTING_STATUS, JSON.stringify(this.status));
    } catch (error) {
      console.error('Failed to persist update status:', error);
    }
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.status = status;
    this.persist();
    this.onStatus?.(status);
    return status;
  }

  /**
   * Start the periodic background check.
   *
   * Unref'd so it never holds the process open, and jittered so a fleet of
   * installs restarted together does not hit GitHub in lockstep.
   */
  start(): void {
    if (this.timer) {
      return;
    }
    const jitter = Math.floor(Math.random() * 5 * 60 * 1000);
    this.timer = setInterval(() => {
      void this.check(false).catch(() => undefined);
    }, SUCCESS_TTL_MS + jitter);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(force: boolean): Promise<UpdateStatus> {
    const now = this.now();

    // The floor applies to forced checks too. Otherwise any signed-in user
    // could drain the hourly quota by holding down the Check button.
    if (now < this.status.nextCheckAllowedAt && this.status.state !== 'never_checked') {
      return this.status;
    }
    if (!force && this.status.checkedAt !== null && now - this.status.checkedAt < SUCCESS_TTL_MS) {
      return this.status;
    }

    // Build identity problems are answerable without touching the network.
    if (!this.buildInfo.sha) {
      return this.publish({
        ...emptyStatus(this.buildInfo, now),
        state: 'unknown_build',
        checkedAt: now,
        nextCheckAllowedAt: now + SUCCESS_TTL_MS,
        message:
          'This build carries no commit identity, so it cannot be compared against the repository.',
      });
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.run(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async request(url: string, etag?: string | null): Promise<CappedResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `code-agents-webcli/${this.buildInfo.version}`,
    };
    // No Authorization header, ever. See the security notes in README: the
    // configured GitHub App token was provisioned for sign-in, and widening it
    // to an endpoint it was not issued for is not a trade worth 5000 req/hr.
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const res = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });

    const body = res.status === 304 ? '' : await readCapped(res, MAX_RESPONSE_BYTES);
    return { ok: res.ok, status: res.status, headers: res.headers, body };
  }

  private rateLimited(res: CappedResponse, now: number): UpdateStatus | null {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if ((res.status !== 403 && res.status !== 429) || remaining !== '0') {
      return null;
    }

    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const resetMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 60 * 60 * 1000;
    return {
      ...this.status,
      state: 'rate_limited',
      // Keep whatever the last good answer was; a quota bump should not erase
      // a known-good "update available".
      checkedAt: this.status.checkedAt,
      nextCheckAllowedAt: resetMs + 30_000,
      message: 'GitHub rate limit reached.',
    };
  }

  private async run(now: number): Promise<UpdateStatus> {
    const installedSha = this.buildInfo.sha as string;
    const base = emptyStatus(this.buildInfo, now);

    let head: CappedResponse;
    try {
      head = await this.request(
        `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}`,
        // Only useful when there is a previous verdict for a 304 to reaffirm.
        this.status.state === 'never_checked' ? null : this.settings.getSetting(SETTING_ETAG),
      );
    } catch (error) {
      return this.publish({
        ...this.status,
        state: 'offline',
        nextCheckAllowedAt: now + FAILURE_TTL_MS,
        message: `Could not reach GitHub: ${(error as Error).message}`,
      });
    }

    const limited = this.rateLimited(head, now);
    if (limited) {
      return this.publish(limited);
    }

    if (head.status === 304) {
      // Unchanged since the last check. Whatever the previous verdict was is
      // still the right one; only the timestamp moves.
      return this.publish({
        ...this.status,
        checkedAt: now,
        nextCheckAllowedAt: now + MIN_INTERVAL_MS,
        message: null,
      });
    }

    if (!head.ok) {
      return this.publish({
        ...this.status,
        state: 'offline',
        nextCheckAllowedAt: now + FAILURE_TTL_MS,
        message: `GitHub returned HTTP ${head.status}.`,
      });
    }

    let remoteSha: string | null = null;
    let remoteDate: string | null = null;
    let subject: string | null = null;
    try {
      const parsed = JSON.parse(head.body) as {
        sha?: unknown;
        commit?: { message?: unknown; committer?: { date?: unknown } };
      };
      if (typeof parsed.sha === 'string' && /^[0-9a-f]{40}$/.test(parsed.sha)) {
        remoteSha = parsed.sha;
      }
      if (typeof parsed.commit?.committer?.date === 'string') {
        remoteDate = parsed.commit.committer.date;
      }
      if (typeof parsed.commit?.message === 'string') {
        // Attacker-influenced text: any PR title that lands on main ends up
        // here. Stripped and truncated server-side; the client additionally
        // only ever assigns it with textContent.
        subject = stripAnsi(parsed.commit.message).split('\n')[0].slice(0, MAX_SUBJECT_LENGTH);
      }
    } catch {
      return this.publish({
        ...this.status,
        state: 'offline',
        nextCheckAllowedAt: now + FAILURE_TTL_MS,
        message: 'GitHub returned a response that could not be parsed.',
      });
    }

    if (!remoteSha) {
      return this.publish({
        ...this.status,
        state: 'offline',
        nextCheckAllowedAt: now + FAILURE_TTL_MS,
        message: 'GitHub did not return a usable commit.',
      });
    }

    const etag = head.headers.get('etag');
    if (etag) {
      this.settings.setSetting(SETTING_ETAG, etag);
    }

    const remote = {
      sha: remoteSha,
      short: shortSha(remoteSha),
      commitDate: remoteDate,
      subject,
    };
    const nextCheckAllowedAt = now + MIN_INTERVAL_MS;

    if (remoteSha === installedSha) {
      return this.publish({
        ...base,
        state: 'up_to_date',
        remote,
        checkedAt: now,
        nextCheckAllowedAt,
      });
    }

    // A modified working tree is not "behind" in any actionable sense —
    // reinstalling would throw the modifications away.
    if (this.buildInfo.dirty) {
      return this.publish({
        ...base,
        state: 'dev_build',
        remote,
        checkedAt: now,
        nextCheckAllowedAt,
        message: 'This build has uncommitted local changes; update checks are informational.',
      });
    }

    let behindBy: number | null = null;
    let message: string | null = null;
    try {
      const compare = await this.request(
        `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/compare/${installedSha}...${remoteSha}`,
      );
      if (compare.status === 404) {
        message = 'The installed commit is no longer on the remote.';
      } else if (compare.ok) {
        const parsed = JSON.parse(compare.body) as { status?: unknown; ahead_by?: unknown };
        if (parsed.status === 'identical') {
          return this.publish({
            ...base,
            state: 'up_to_date',
            remote,
            checkedAt: now,
            nextCheckAllowedAt,
          });
        }
        // base = installed, head = main, so "ahead_by" counts the commits main
        // has that this build does not.
        if (parsed.status === 'ahead' && typeof parsed.ahead_by === 'number') {
          behindBy = parsed.ahead_by;
        } else {
          message = 'This build is not an ancestor of main.';
        }
      }
    } catch {
      // The distance is a nicety; not knowing it does not change the verdict.
      message = 'Could not determine how far behind this build is.';
    }

    return this.publish({
      ...base,
      state: 'behind',
      remote,
      behindBy,
      checkedAt: now,
      nextCheckAllowedAt,
      message,
    });
  }
}
