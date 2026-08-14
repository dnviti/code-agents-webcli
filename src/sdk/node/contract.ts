export interface DesktopAuthCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly sameSite: 'strict';
}

interface CodeAgentsServerListener {
  readonly listening: boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
}

/** Stable lifecycle surface shared by Node, CLI, and desktop hosts. */
export interface CodeAgentsServer {
  runSetupIfNeeded(): Promise<boolean>;
  start(): Promise<CodeAgentsServerListener>;
  shutdown(): Promise<void>;
  readonly localUrl: string | null;
  readonly desktopAuthCookie: DesktopAuthCookie | null;
}
