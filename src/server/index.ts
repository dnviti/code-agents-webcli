import type http from 'node:http';
import type https from 'node:https';

import type { AgentKind, ServerOptions, SessionRecord } from './types.js';
import {
  childProcessRunner,
  type AgentCommandRunner,
} from './services/runtime/agents/agent-maintenance-runtime.js';
import type { UserEnvironment } from './services/environments/types.js';
import {
  applyChatLifecycle as applyChatLifecycleImplementation,
  probeLaunchedAgentVersion as probeLaunchedAgentVersionImplementation,
} from './server-functions.js';
import { ServerLifecycle } from './server-lifecycle.js';

/** Probe the configured launch executable without inheriting provider secrets. */
export async function probeLaunchedAgentVersion(
  environment: UserEnvironment,
  agentKind: AgentKind,
  selectedCommand?: string,
  runner: AgentCommandRunner = childProcessRunner,
): Promise<string | null> {
  return await probeLaunchedAgentVersionImplementation(environment, agentKind, selectedCommand, runner);
}

/** Persist lifecycle facts learned by a live chat into its durable record. */
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
  applyChatLifecycleImplementation(record, change, writeActive);
}

export interface ClaudeCodeWebServer {
  /** Actual loopback URL after start, including a dynamically allocated port. */
  readonly localUrl: string | null;
  /** Cookie metadata for an Electron/WebView session. */
  readonly desktopAuthCookie: {
    name: string;
    value: string;
    httpOnly: true;
    sameSite: 'strict';
  } | null;
  shutdown(): Promise<void>;
  /** Run interactive setup; false means a newly installed service owns startup. */
  runSetupIfNeeded(): Promise<boolean>;
  start(): Promise<http.Server | https.Server>;
  close(): void;
}

/**
 * Public server facade with the monolith's original prototype shape.
 * Overriding undocumented implementation members is not a supported extension point.
 */
export class ClaudeCodeWebServer {
  declare private readonly serverBrand: void;

  constructor(options: ServerOptions = {}) {
    return Reflect.construct(ServerLifecycle, [options], new.target) as ClaudeCodeWebServer;
  }
}

const implementationPrototypes: object[] = [];
for (
  let source: object = ServerLifecycle.prototype;
  source !== Object.prototype;
  source = Object.getPrototypeOf(source) as object
) {
  implementationPrototypes.unshift(source);
}
for (const source of implementationPrototypes) {
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (name !== 'constructor') Object.defineProperty(ClaudeCodeWebServer.prototype, name, descriptor);
  }
}

export async function startServer(options: ServerOptions): Promise<http.Server | https.Server> {
  const server = new ClaudeCodeWebServer(options);
  return await server.start();
}
