import { createServerFacade } from './implementation.js';
import type { ServerOptions } from './options.js';

export type { CodeAgentsServer, DesktopAuthCookie } from './contract.js';
export type { DesktopServerOptions, ServerOptions } from './options.js';

/** Create a server host without exposing the server's application internals. */
export const createCodeAgentsServer = (options?: ServerOptions) => createServerFacade(options);
