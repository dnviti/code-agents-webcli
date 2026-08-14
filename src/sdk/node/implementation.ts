import { ClaudeCodeWebServer } from '../../server/index.js';
import type { CodeAgentsServer } from './contract.js';
import type { ServerOptions } from './options.js';

const implementations = new WeakMap<CodeAgentsServer, ClaudeCodeWebServer>();

function implementation(host: CodeAgentsServer): ClaudeCodeWebServer {
  const value = implementations.get(host);
  if (!value) throw new TypeError('Host was not created by createCodeAgentsServer');
  return value;
}

class ServerFacade implements CodeAgentsServer {
  constructor(value: ClaudeCodeWebServer) { implementations.set(this, value); }
  runSetupIfNeeded(): Promise<boolean> { return implementation(this).runSetupIfNeeded(); }
  start(): ReturnType<ClaudeCodeWebServer['start']> { return implementation(this).start(); }
  shutdown(): Promise<void> { return implementation(this).shutdown(); }
  get localUrl(): string | null { return implementation(this).localUrl; }
  get desktopAuthCookie(): CodeAgentsServer['desktopAuthCookie'] { return implementation(this).desktopAuthCookie; }
}

export const createServerFacade = (options: ServerOptions = {}): CodeAgentsServer => new ServerFacade(new ClaudeCodeWebServer(options));

/** Deliberately available only to the packaged qualification entry point. */
export const implementationForQualification = implementation;
