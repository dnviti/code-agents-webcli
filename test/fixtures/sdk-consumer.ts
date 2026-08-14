import { controllerFetch, controllerTargetAvailability, type ServerTarget } from 'code-agents-webcli/sdk/browser';
import { parseQualifiedSessionId, qualifySessionId } from 'code-agents-webcli/sdk/contracts';
import {
  createCodeAgentsServer,
  type CodeAgentsServer,
  type DesktopAuthCookie,
  type DesktopServerOptions,
  type ServerOptions,
} from 'code-agents-webcli/sdk/node';

const sessionId = qualifySessionId('server', 'session');
const parsed = parseQualifiedSessionId(sessionId);
const host: CodeAgentsServer = createCodeAgentsServer({ port: 0 });
const options: ServerOptions = { desktop: { authToken: 'token', username: 'user' } };
const desktop: DesktopServerOptions | undefined = options.desktop;
const cookie: DesktopAuthCookie | null = host.desktopAuthCookie;
const target = {} as ServerTarget;

void parsed;
void host;
void desktop;
void cookie;
void controllerFetch('/api/config');
void controllerTargetAvailability(target);
