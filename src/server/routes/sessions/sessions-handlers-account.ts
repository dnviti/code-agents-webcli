import { ConversationProject, projectName } from '../../../shared/conversations.js';
import { SessionListItem } from '../../types.js';
import { announceSessionOpened, announceSessionTabClosed, announceSessionTabsReordered } from '../../websocket/handler.js';
import { getOwnedSession, requireUser } from '../helpers.js';
import { chatRecords, orderedAccountTabs, nextAccountTabOrder } from './sessions-account.js';
import { SessionRoutesDeps } from './sessions-common.js';
import { describeAll } from './sessions-describe.js';
import { MAX_RESUMABLE, MAX_LISTED_CONVERSATIONS, MAX_NAME_LENGTH, rejectUnavailablePersistence, reportWorkspacePersistenceUnavailable, countUserSessions } from './sessions-shared.js';
import { Request, Response } from 'express';
import path from 'node:path';
import WebSocket from 'ws';

export async function handlePersistence(
  deps: SessionRoutesDeps,
  _req: Request,
  res: Response,
): Promise<void> {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

const metadata = await deps.sessionStore.getSessionMetadata(user.id);
const currentSessions = countUserSessions(deps.claudeSessions, user.id);

res.json({
  ...metadata,
  currentSessions,
  autoSaveEnabled: true,
  autoSaveInterval: 30000,
});
}

/**
 * Past conversations in a folder, to pick up instead of starting over.
 *
 * The web counterpart of `claude --resume`: choose a directory, then choose a
 * conversation. Scoped to one directory on purpose — a conversation is about
 * a project, and a list mixing every folder a person has ever opened is a
 * list nobody reads.
 *
 * Only sessions this user owns, and only ones that actually have a chat log:
 * a session record with an empty transcript is a folder someone opened and
 * walked away from, and offering to "resume" it would resume nothing.
 */

export async function handleResumable(
  deps: SessionRoutesDeps,
  req: Request,
  res: Response,
): Promise<void> {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

const requested = typeof req.query.dir === 'string' ? req.query.dir : '';
if (!requested) {
  res.status(400).json({ error: 'No folder was named' });
  return;
}

const hasProjectId = Object.prototype.hasOwnProperty.call(req.query, 'projectId');
if (hasProjectId && (typeof req.query.projectId !== 'string' || !req.query.projectId.trim())) {
  res.status(400).json({ error: 'A project id must be a non-empty string' });
  return;
}
const projectId = typeof req.query.projectId === 'string'
  ? req.query.projectId.trim()
  : '';
const requestedKind = typeof req.query.workingDirKind === 'string'
  ? req.query.workingDirKind
  : undefined;

let canonicalDir = requested;
let workingDirKind: 'host' | 'container' = 'host';
if (projectId) {
  if (requestedKind !== 'host' && requestedKind !== 'container') {
    res.status(400).json({ error: 'A project folder namespace is required' });
    return;
  }
  const project = deps.projectsManager?.getForUser(user.id, projectId);
  if (!project) {
    // Same answer for an absent project and another user's project.
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  workingDirKind = requestedKind;
  // This endpoint reads no filesystem data: it matches an exact directory
  // against this user's already-owned records. Still require an absolute,
  // unambiguous name so a relative container path cannot alias another
  // folder after a later cwd change.
  if (requested.includes('\0') || (workingDirKind === 'container'
    ? !requested.startsWith('/')
    : !path.isAbsolute(requested))) {
    res.status(400).json({ error: 'An absolute project folder is required' });
    return;
  }
  canonicalDir = workingDirKind === 'container'
    ? path.posix.normalize(requested)
    : path.resolve(requested);
} else {
  if (requestedKind !== undefined) {
    res.status(400).json({ error: 'A folder namespace requires a project' });
    return;
  }
  // Legacy/host folders keep the same host confinement they have always
  // used. Project folders are authorised by project identity above because
  // their bind mount intentionally sits outside the user's legacy base.
  const validation = deps.validatePath(requested, user.id);
  if (!validation.valid || !validation.path) {
    res.status(403).json({ error: 'That folder is outside the allowed base' });
    return;
  }
  canonicalDir = validation.path;
}

try {
  if (projectId) await deps.loadProjectWorkspaceSessions?.(user.id, projectId);
  else await deps.loadWorkspaceSessions?.(user.id, canonicalDir);
} catch (error) {
  reportWorkspacePersistenceUnavailable(res, error);
  return;
}

const candidates = chatRecords(deps, user.id)
  .filter((session) => session.workingDir === canonicalDir)
  .filter((session) => (session.projectId || '') === projectId)
  .filter((session) => !projectId
    || (session.projectWorkingDirKind ?? 'host') === workingDirKind)
  .slice(0, MAX_RESUMABLE);

const conversations = await describeAll(deps, candidates);

res.json({
  dir: canonicalDir,
  projectId: projectId || null,
  workingDirKind,
  conversations: conversations.filter(
    (entry) => entry.events > 0 || entry.rollbackRecoveryPending,
  ),
});
}

/**
 * Every conversation this user has, grouped by the project it belongs to.
 *
 * The answer to "what conversations do I have?", which until now the app had
 * nowhere to put. The resume list above answers a narrower question — "in this
 * folder, is there one to carry on with" — and it is reachable only on the way
 * to starting a new session in a folder already chosen. That makes it useless
 * for the two things people actually ask: where the conversation about the
 * release script was, and how to get back into the one closed yesterday (#127).
 *
 * Grouped here rather than in the browser because the ordering is a decision,
 * not a rendering: conversations run newest-first inside a project, and the
 * projects themselves run by their own newest conversation, so the folder
 * somebody was working in this morning is at the top whichever folder it is.
 * Both orders fall out of one sort, which is why there is only one.
 *
 * Not grouped by anything the filesystem says, either: a project with no
 * conversations does not appear, because this is a list of conversations that
 * happen to be filed under folders rather than a folder browser.
 */

export async function handleConversations(
  deps: SessionRoutesDeps,
  _req: Request,
  res: Response,
): Promise<void> {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

const owned = chatRecords(deps, user.id);
const described = await describeAll(deps, owned.slice(0, MAX_LISTED_CONVERSATIONS));
// A record with an empty log is a folder somebody opened and walked away
// from. It is not a conversation, and listing it would put a row with nothing
// to read in front of the ones that matter — the same rule the resume list
// applies, for the same reason.
const conversations = described.filter(
  (entry) => entry.events > 0 || entry.rollbackRecoveryPending,
);

// Insertion order carries the grouping: `owned` is already newest-first, so
// the first time a directory is seen is at its most recent conversation, and
// every group's contents arrive in order behind it.
const groups = new Map<string, ConversationProject>();
for (const conversation of conversations) {
  // JSON framing makes the tuple unambiguous even when a path itself
  // contains punctuation. Project, namespace and cwd are all part of the
  // identity: `/workspace` in project A is unrelated to `/workspace` in B.
  const groupKey = JSON.stringify([
    conversation.projectId || null,
    conversation.workingDirKind || 'host',
    conversation.workingDir,
  ]);
  const existing = groups.get(groupKey);
  if (existing) {
    existing.conversations.push(conversation);
    continue;
  }
  groups.set(groupKey, {
    key: groupKey,
    projectId: conversation.projectId || null,
    workingDirKind: conversation.workingDirKind || 'host',
    dir: conversation.workingDir,
    name: conversation.projectName || projectName(conversation.workingDir),
    lastActivity: conversation.lastActivity,
    conversations: [conversation],
  });
}

res.json({
  projects: Array.from(groups.values()),
  total: conversations.length,
  truncated: owned.length > MAX_LISTED_CONVERSATIONS,
});
}

/**
 * The user's standalone sessions — everything the tab strip and the session
 * dialogs are built from.
 *
 * A shell that belongs to a conversation is deliberately not here. It is a
 * real session, but it is reached through its conversation and only there;
 * listing it would put a top-level tab and a session row in front of every
 * client the user has open, including ones with no relation to the
 * conversation that opened it.
 */

export async function handleList(
  deps: SessionRoutesDeps,
  acquireTabMutation: (userId: number) => Promise<() => void>,
  _req: Request,
  res: Response,
): Promise<void> {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

// A mutation updates the in-memory records before awaiting SQLite. Wait for
// that transaction to commit or roll back so reconnecting clients can never
// photograph tentative membership/order that durability later refused.
const release = await acquireTabMutation(user.id);
try {
  const sessionList: SessionListItem[] = orderedAccountTabs(deps.claudeSessions, user.id)
    .map((session) => ({
    id: session.id,
    name: session.name,
    created: session.created,
    active: session.active,
    agent: session.agent,
    lastAgent: session.lastAgent,
    runtimeLabel: session.runtimeLabel,
    workingDir: session.workingDir,
    projectId: session.projectId,
    projectName: session.projectId
      ? deps.projectsManager?.getForUser(session.ownerUserId, session.projectId)?.name || null
      : null,
    projectWorkingDirKind: session.projectWorkingDirKind,
    connectedClients: session.connections.size,
    lastActivity: session.lastActivity,
    surface: session.surface || 'terminal',
    customName: session.customName,
    // So a tab restored on page load can show the mode it is really in from
    // its first paint. `summarise` already does this for the conversations
    // dialog; the tab strip was the one place the fact was known and not
    // carried.
    bypassPermissions: session.chatBypassPermissions === true,
    persistenceUnavailable: session.persistenceUnavailable,
    rollbackRecoveryPending: session.rollbackRecoveryPending === true,
    }));

  res.json({ sessions: sessionList });
} finally {
  release();
}
}

/** Replace the order of this account's complete, currently open tab set. */

export async function handleTabsOrder(
  deps: SessionRoutesDeps,
  acquireTabMutation: (userId: number) => Promise<() => void>,
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(res);
  if (!user) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }

  const requested = req.body?.sessionIds;
  if (
    !Array.isArray(requested)
    || requested.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(requested).size !== requested.length
  ) {
    res.status(400).json({
      error: 'invalid_tab_order',
      message: 'Tab order must contain each open session exactly once',
    });
    return;
  }

  const sessionIds = requested as string[];
  const release = await acquireTabMutation(user.id);
  try {
    const current = orderedAccountTabs(deps.claudeSessions, user.id);
    if (current.some((session) => session.persistenceUnavailable)) {
      res.status(409).json({
        error: 'session_persistence_unavailable',
        message: 'A tab is read-only while its workspace persistence is unavailable',
        retryable: true,
      });
      return;
    }
    const currentIds = new Set(current.map((session) => session.id));
    if (
      sessionIds.length !== current.length
      || sessionIds.some((id) => !currentIds.has(id))
    ) {
      // Includes missing, foreign, closed and newly opened IDs without
      // revealing which one caused the mismatch. A stale reorder can never
      // reopen or close anything by implication.
      res.status(409).json({
        error: 'tab_set_changed',
        message: 'The open tab set changed; reload it before reordering',
      });
      return;
    }

    const byId = new Map(current.map((session) => [session.id, session]));
    const previous = current.map((session) => [session, session.tabOrder] as const);
    sessionIds.forEach((id, index) => { byId.get(id)!.tabOrder = index; });

    let saved = false;
    try {
      saved = (await deps.saveSessionsToDisk()) !== false;
    } catch (error) {
      console.error('Failed to persist conversation tab order:', error);
    }
    if (!saved) {
      for (const [session, order] of previous) session.tabOrder = order;
      res.status(503).json({
        error: 'tab_order_not_saved',
        message: 'The tab order could not be saved',
      });
      return;
    }

    announceSessionTabsReordered(user.id, sessionIds, deps.webSocketConnections);
    res.json({ success: true, sessionIds });
  } finally {
    release();
  }
}

/**
 * Rename a session.
 *
 * The chosen label is stored beside the created name rather than over it, so
 * a session that was never renamed keeps the name — and the folder-name
 * substitution — it has today.
 *
 * Every one of this user's sockets is told, not just the one that asked: two
 * windows open on the same sessions disagreeing about what a tab is called
 * until somebody reloads is the same complaint as losing the name entirely.
 */

export async function handleName(
  deps: SessionRoutesDeps,
  req: Request,
  res: Response,
): Promise<void> {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

const session = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
if (!session) {
  res.status(404).json({ error: 'Session not found' });
  return;
}
if (rejectUnavailablePersistence(res, session)) return;

const { name } = req.body ?? {};
if (typeof name !== 'string') {
  res.status(400).json({ error: 'invalid_name', message: 'Session name must be a string' });
  return;
}

// A name is what the user typed with the whitespace taken off, and a name
// that is nothing but whitespace is not a name. Capped because this label is
// rendered in a fixed-width strip and stored on every autosave, and neither
// has any use for a paragraph.
const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
if (!trimmed) {
  res.status(400).json({ error: 'empty_name', message: 'Session name cannot be empty' });
  return;
}

const previousName = session.customName;
session.customName = trimmed;
let saved = false;
try {
  saved = (await deps.saveSessionsToDisk()) !== false;
} catch (error) {
  console.error('Failed to persist session name:', error);
}
if (!saved) {
  session.customName = previousName;
  res.status(503).json({
    error: 'session_name_not_saved',
    message: 'The session name could not be saved',
  });
  return;
}

for (const wsInfo of deps.webSocketConnections.values()) {
  if (wsInfo.userId !== user.id) continue;
  if (wsInfo.ws.readyState !== WebSocket.OPEN) continue;
  wsInfo.ws.send(
    JSON.stringify({ type: 'session_renamed', sessionId: session.id, name: trimmed }),
  );
}

res.json({ success: true, name: trimmed });
}

/**
 * Open or close one conversation tab for the whole account.
 *
 * This changes only strip membership. Deleting a conversation remains the
 * separate DELETE endpoint below; terminal tabs still take that path because
 * a terminal with no tab would be an unreachable live PTY.
 */

export async function handleTab(
  deps: SessionRoutesDeps,
  acquireTabMutation: (userId: number) => Promise<() => void>,
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(res);
  if (!user) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = getOwnedSession(deps.claudeSessions, sessionId, user);
  if (!session) {
    // The same answer for a missing session and another account's session:
    // ownership must not become an existence oracle.
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (rejectUnavailablePersistence(res, session)) return;

  if (
    typeof req.body?.open !== 'boolean'
    || (req.body?.legacy !== undefined && typeof req.body.legacy !== 'boolean')
    || (req.body?.legacy === true && req.body.open !== false)
  ) {
    res.status(400).json({
      error: 'invalid_tab_state',
      message: 'Tab state must name whether the tab is open',
    });
    return;
  }

  if (session.surface !== 'chat' || session.ownerSessionId) {
    res.status(400).json({
      error: 'unsupported_tab_session',
      message: 'Only standalone conversation tabs can be opened or closed',
    });
    return;
  }

  const release = await acquireTabMutation(user.id);
  try {
    // It may have been deleted while this request waited behind an earlier
    // device. Re-read under the mutation turn instead of writing through a
    // stale object that is no longer in the authoritative map.
    const current = getOwnedSession(deps.claudeSessions, sessionId, user);
    if (!current) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const open = req.body.open as boolean;
    const legacy = req.body.legacy === true;

    // The retired browser-local close list can exist on several devices.
    // Apply one of those old tombstones only while the persisted row still
    // says no account-level decision has ever been recorded. Once any
    // device migrated, closed or explicitly reopened it, another stale
    // browser must not get to close it merely because it started later.
    if (legacy && current.tabOpen !== undefined) {
      res.json({ success: true, open: current.tabOpen, applied: false });
      return;
    }

    const previousOpen = current.tabOpen;
    const previousOrder = current.tabOrder;
    const genuinelyReopened = open && current.tabOpen === false;
    const appendedOrder = genuinelyReopened
      ? nextAccountTabOrder(deps.claudeSessions, user.id)
      : current.tabOrder;
    current.tabOpen = open;
    if (genuinelyReopened) current.tabOrder = appendedOrder;
    let saved = false;
    try {
      saved = (await deps.saveSessionsToDisk()) !== false;
    } catch (error) {
      console.error('Failed to persist conversation tab state:', error);
    }
    if (!saved) {
      current.tabOpen = previousOpen;
      current.tabOrder = previousOrder;
      res.status(503).json({
        error: 'tab_state_not_saved',
        message: 'The tab state could not be saved',
      });
      return;
    }

    // Durability comes before visibility. A client that receives this event
    // may immediately disconnect; its reconnect list must already agree.
    if (open) {
      announceSessionOpened(current, deps.webSocketConnections);
      // State the complete order even for an idempotent open. A stale live
      // client may be missing this tab and append the announcement locally,
      // while the server already has it in the middle of the strip.
      announceSessionTabsReordered(
        user.id,
        orderedAccountTabs(deps.claudeSessions, user.id).map((item) => item.id),
        deps.webSocketConnections,
      );
    } else {
      announceSessionTabClosed(current, deps.webSocketConnections);
    }

    res.json({ success: true, open, applied: true });
  } finally {
    release();
  }
}

/** Terminal panes owned by one conversation, restored after reload/restart. */

export function handleChildren(
  deps: SessionRoutesDeps,
  req: Request,
  res: Response,
): void {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

const parent = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
if (!parent || parent.surface !== 'chat' || parent.ownerSessionId) {
  res.status(404).json({ error: 'Session not found' });
  return;
}
if (rejectUnavailablePersistence(res, parent)) return;

const sessionIds = Array.from(deps.claudeSessions.values())
  .filter((session) => (
    session.ownerUserId === user.id
    && session.ownerSessionId === parent.id
    && !session.persistenceUnavailable
    && !session.rollbackRecoveryPending
  ))
  .sort((left, right) => left.created.getTime() - right.created.getTime())
  .map((session) => session.id);
res.json({ sessionIds });
}

export function handleGet(
  deps: SessionRoutesDeps,
  req: Request,
  res: Response,
): void {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

const session = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
if (!session) {
  res.status(404).json({ error: 'Session not found' });
  return;
}

res.json({
  id: session.id,
  name: session.name,
  customName: session.customName,
  persistenceUnavailable: session.persistenceUnavailable,
  rollbackRecoveryPending: session.rollbackRecoveryPending === true,
  created: session.created,
  active: session.active,
  agent: session.agent,
  lastAgent: session.lastAgent,
  runtimeLabel: session.runtimeLabel,
  workingDir: session.workingDir,
  projectId: session.projectId,
  projectWorkingDirKind: session.projectWorkingDirKind,
  connectedClients: session.connections.size,
  lastActivity: session.lastActivity,
});
}
