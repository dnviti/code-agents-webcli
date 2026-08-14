import { ChatEvent } from '../../../shared/chat-events.js';
import { ChatSessionRef, TurnCut } from '../../chat/store.js';
import { AccountTabCoordinatorLike } from '../../services/account-tab-coordinator.js';
import { AttachmentSessionRef, AttachmentStoreLike } from '../../services/attachment-store.js';
import { HistoryStoreLike } from '../../services/history-store.js';
import { ProjectsSessionApi } from '../../services/projects/working-dir.js';
import { SessionTeardownLike } from '../../services/session-teardown.js';
import { TranscriptStoreLike } from '../../services/transcript-store.js';
import { SessionRecord, AgentKind, BridgeInterface, PathValidation, WebSocketInfo } from '../../types.js';

/** Project-aware attachment seam used only while the route owns its lifecycle gate. */
export interface ProjectBranchAttachmentStoreLike {
  cloneForBranchInProjectWorkspace(
    source: AttachmentSessionRef,
    target: AttachmentSessionRef,
    attachment: Parameters<AttachmentStoreLike['cloneForBranch']>[2],
    workspaceRoot: string,
  ): ReturnType<AttachmentStoreLike['cloneForBranch']>;
}

/**
 * Process-local coordination for the one race persistence cannot express:
 * creating a hidden child while its owning conversation is being retired.
 *
 * `retireProjectSessions()` is called with a freshly assembled deps object, so
 * the shared sessions map is the stable identity that lets it join the same
 * gate as the HTTP router.
 */
export interface SessionRouteCoordination {
  pendingOwnedCreates: Map<string, Set<Promise<void>>>;
  pendingProjectCreates: Map<string, Set<Promise<void>>>;
  retiringProjects: Set<string>;
  retiringTrees: WeakMap<SessionRecord, Promise<boolean>>;
  destroyedSessions: WeakMap<SessionRecord, Promise<void>>;
}

const sessionRouteCoordinations = new WeakMap<
  Map<string, SessionRecord>,
  SessionRouteCoordination
>();

export function coordinationFor(deps: SessionRoutesDeps): SessionRouteCoordination {
  let coordination = sessionRouteCoordinations.get(deps.claudeSessions);
  if (!coordination) {
    coordination = {
      pendingOwnedCreates: new Map(),
      pendingProjectCreates: new Map(),
      retiringProjects: new Set(),
      retiringTrees: new WeakMap(),
      destroyedSessions: new WeakMap(),
    };
    sessionRouteCoordinations.set(deps.claudeSessions, coordination);
  }
  return coordination;
}

export interface SessionRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  baseFolder: string;
  dev: boolean;
  validatePath(targetPath: string, userId?: number): PathValidation;
  /** Optional: without it the single shared base folder is used, as before. */
  getUserBaseFolder?(userId?: number): string;
  createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
    ownerSessionId?: string;
    projectId?: string | null;
    projectWorkingDirKind?: 'host' | 'container';
    /** Canonical server-resolved workspace root, never request input. */
    storageRoot?: string;
  }): SessionRecord;
  /** Lazy-load a trusted workspace before any save is allowed to prune it. */
  loadWorkspaceSessions?(ownerUserId: number, storageRoot: string): Promise<void>;
  /** Read-only project catalog resolution for resume/listing. */
  loadProjectWorkspaceSessions?(ownerUserId: number, projectId: string): Promise<void>;
  getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  /**
   * Stop whichever process owns this record. The real composition root routes
   * chats through ChatSessionManager and terminals through their bridge.
   */
  stopSessionRuntime?(session: SessionRecord): Promise<void>;
  /** `false` means the SQLite write was attempted but did not commit. */
  saveSessionsToDisk(): Promise<boolean | void>;
  transcriptStore: TranscriptStoreLike;
  historyStore: HistoryStoreLike;
  /** Lines still on screen, not yet scrolled into history. */
  getScreenSnapshot(sessionId: string): string[];
  /** Tear down the scrollback emulator held for a session. */
  disposeRecorder(sessionId: string): void;
  getSelectedWorkingDir(userId: number): string | null;
  /**
   * The active profile for a runtime, read without writing its tier files.
   *
   * Only the branch needs it, and only as the last resort behind the source's
   * own recorded model — see there. Deliberately not paired with a reader for
   * the account's standing choice: the source's record already says which model
   * it ran, whichever layer decided it, and asking the layers again would answer
   * a different question than "what was this history measured against".
   *
   * Optional so the hand-built deps literals in the existing tests keep
   * compiling; a server without one simply pins nothing for a source recorded
   * before pins existed, which is what branching did before.
   */
  activeProfileFor?(runtime: string): { profileName: string; model?: string } | null;
  sessionStore: {
    getSessionMetadata(ownerUserId?: number): Promise<any>;
    /** Write-through for the runtime active flag. Optional for tests. */
    setActive?(id: string, active: boolean): Promise<void>;
    /** Boot reset for stale active flags. Optional for tests. */
    resetActiveFlags?(): Promise<void>;
  };
  /**
   * Optional project manager seam. When absent, project-aware create is not
   * available and project-less sessions behave exactly as today. (#168)
   */
  projectsManager?: ProjectsSessionApi;
  /** Release runtime, join and subscription leases before deleting a record. */
  releaseProjectSessionResources?(sessionId: string): void;
  /**
   * Optional so the hand-built deps literals in the existing tests keep
   * compiling; the server always supplies one.
   */
  sessionTeardown?: SessionTeardownLike;
  /** Durable attachment copy used when carried branch events name stored bytes. */
  attachmentStore?: AttachmentStoreLike & Partial<ProjectBranchAttachmentStoreLike>;
  /** Shared with socket-created sessions so all account tab writes serialize. */
  tabCoordinator?: AccountTabCoordinatorLike;
  /**
   * The chat log, for listing past conversations in a folder.
   *
   * Optional for the same reason as `sessionTeardown` — the hand-built deps in
   * the tests predate it — and a server without one simply has nothing to
   * resume, which the route reports as an empty list rather than an error.
   */
  chatStore?: {
    stat(session: ChatSessionRef): Promise<{ firstSeq: number; cursor: number }>;
    describe(session: ChatSessionRef): Promise<{
      nativeSessionId: string | null;
      firstMessage: string | null;
    }>;
    /**
     * The three calls a branch needs, optional for the same reason the store
     * itself is: a deployment without a chat log has no conversation to branch
     * and the route says so rather than throwing.
     */
    turnCut?(session: ChatSessionRef, turnId: string): Promise<TurnCut | null>;
    append?(session: ChatSessionRef, events: ChatEvent[]): void | Promise<void>;
    setOpeningContext?(session: ChatSessionRef, context: string): Promise<void>;
    /** Required for an all-or-nothing branch when any later step fails. */
    deleteChat?(session: ChatSessionRef): Promise<void>;
  };
}
