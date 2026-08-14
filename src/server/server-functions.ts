import { agentCatalogEntry } from '../shared/agent-maintenance.js';
import type { AgentKind, SessionRecord } from './types.js';
import {
  childProcessRunner,
  safeProcessEnvironment,
  type AgentCommandRunner,
} from './services/agent-maintenance-runtime.js';
import type { UserEnvironment } from './services/environments/types.js';

/** Probe exactly the launch executable without inheriting server/provider secrets. */
export async function probeLaunchedAgentVersion(
  environment: UserEnvironment,
  agentKind: AgentKind,
  selectedCommand?: string,
  runner: AgentCommandRunner = childProcessRunner,
): Promise<string | null> {
  if (agentKind === 'terminal') return null;
  const entry = agentCatalogEntry(agentKind);
  if (!entry) return null;
  const command = selectedCommand || entry.binary;
  try {
    const wrapped = environment.wrap(command, [...entry.versionArgs], {
      env: environment.kind === 'host' ? safeProcessEnvironment() : {},
      inheritHostEnv: false,
    });
    const result = await runner.run(wrapped.command, wrapped.args, {
      env: wrapped.env,
      timeoutMs: 2_000,
      inheritEnv: false,
      windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
    });
    const match = `${result.stdout}\n${result.stderr}`
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
      .match(/v?([0-9]+(?:\.[0-9A-Za-z.+-]+)+)/u);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fold what a chat session learned about itself into the record that outlives it.
 *
 * An absent `nativeSessionId` is "nothing to say about the id", and a null one
 * is "this conversation no longer has one". The distinction prevents a cleared
 * conversation from retaining the native id of the conversation it replaced.
 */
export function applyChatLifecycle(
  record: SessionRecord,
  change: {
    nativeSessionId?: string | null;
    exited?: boolean;
    bypassing?: boolean;
    planMode?: boolean;
  },
  writeActive?: (sessionId: string, active: boolean) => void | Promise<void>,
): void {
  if (change.nativeSessionId !== undefined) {
    record.nativeChatSessionId = change.nativeSessionId || undefined;
  }
  if (change.bypassing !== undefined) {
    record.chatBypassPermissions = change.bypassing;
  }
  if (change.planMode !== undefined) record.chatPlanMode = change.planMode;
  if (change.exited === true) record.active = false;
  if (change.exited === false) {
    record.active = true;
    record.lastActivity = new Date();
  }
  if (change.exited !== undefined) void writeActive?.(record.id, !change.exited);
}

export function nextAccountTabOrder(
  sessions: Map<string, SessionRecord>,
  userId: number,
): number {
  let maximum = -1;
  for (const session of sessions.values()) {
    if (
      session.ownerUserId === userId
      && !session.ownerSessionId
      && session.tabOpen !== false
      && typeof session.tabOrder === 'number'
      && Number.isFinite(session.tabOrder)
    ) {
      maximum = Math.max(maximum, session.tabOrder);
    }
  }
  return maximum + 1;
}
