/** What the strip needs about a tab that `SessionInfo` does not already say. */
export interface TabRecord {
  id: string;
  /** The label shown on the tab, which is not always the session name. */
  displayName: string;
  /**
   * The label the user chose, if they chose one.
   *
   * Kept apart from `displayName` so a rename that the server refuses can be
   * put back the way it was, and so a session the user never renamed still goes
   * through the generated-name rules rather than being pinned to whatever the
   * strip happened to be showing.
   */
  customName?: string;
  /**
   * Which surface the session runs on, as far as this client knows.
   *
   * Learned from the session list at boot and from `session_joined` /
   * `chat_started` afterwards. It decides whether the browser subscribes to the
   * conversation's event stream, which is what keeps a chat tab live while the
   * user is looking at a different one.
   */
  surface: 'terminal' | 'chat';
  /** Runtime currently or most recently associated with this tab. */
  kind: string;
  projectId?: string | null;
  projectName?: string | null;
  projectWorkingDirKind?: 'host' | 'container';
  /**
   * Where this tab falls in the order they were opened on this screen.
   *
   * Read by `reconcile`, and only there. A tab created while the reconcile's
   * own listing was already in flight is missing from that listing through no
   * fault of its own, and removing it would take away the session the user just
   * started — so a tab younger than the question is left alone.
   *
   * A counter rather than a clock. `Date.now()` is accurate to the millisecond
   * and a server on the same machine answers well inside one, so timestamps
   * cannot order a tab against a request that has just returned: both readings
   * come back equal and whichever way the comparison is written is wrong half
   * the time. This is exact by construction.
   */
  openedSeq: number;
}

/**
 * A session as the server describes it.
 *
 * The same shape whether it arrived in the listing or in an announcement that
 * one came into existence somewhere else, so one method can turn either into a
 * tab. `active` and `surface` are optional because the listing has always
 * allowed them to be absent, and absent means "not running" and "a terminal".
 */
export interface ListedSession {
  id: string;
  name: string;
  workingDir: string | null;
  active?: boolean;
  surface?: 'terminal' | 'chat';
  agent?: string | null;
  lastAgent?: string | null;
  customName?: string | null;
  bypassPermissions?: boolean;
  projectId?: string | null;
  projectName?: string | null;
  projectWorkingDirKind?: 'host' | 'container';
  /** Metadata cached by the desktop controller; never a live tab to join. */
  offline?: boolean;
}

export type TabVisibilityMutationResult =
  | { kind: 'synced'; open: boolean }
  | { kind: 'unsupported' };

export class TabVisibilityMutationError extends Error {
  constructor(message: string, readonly endpointAvailable: boolean) {
    super(message);
    this.name = 'TabVisibilityMutationError';
  }
}

/**
 * Tell an old server's missing route from the new route saying the session is
 * missing. Express' route-level 404 is JSON; its default "Cannot PATCH" 404 is
 * HTML. A generic JSON 404 from an older deployment is treated as unsupported
 * too, while the current server's exact ownership-safe answer remains an error.
 */
export async function tabVisibilityEndpointUnsupported(response: Response): Promise<boolean> {
  if (response.status === 405) return true;
  if (response.status !== 404) return false;

  try {
    const body = await response.json() as { error?: unknown };
    return body?.error !== 'Session not found';
  } catch {
    return true;
  }
}