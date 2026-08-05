export type DesktopUpdateProvider = 'electron' | 'flatpak';

export type DesktopUpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'restarting'
  | 'up_to_date'
  | 'error';

export type DesktopUpdatePrompt = 'automatic' | 'deferred';

export interface DesktopUpdateProgress {
  percent: number;
  transferred: number | null;
  total: number | null;
  bytesPerSecond: number | null;
}

export interface DesktopUpdateState {
  provider: DesktopUpdateProvider | null;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  targetVersion: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  checkedAt: string | null;
  progress: DesktopUpdateProgress | null;
  prompt: DesktopUpdatePrompt | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  generation: number;
}

export interface DesktopUpdatesBridge {
  getSnapshot(): Promise<DesktopUpdateState>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
  defer(expectedVersion: string): Promise<DesktopUpdateState>;
  install(expectedVersion: string): Promise<DesktopUpdateState>;
  retry(expectedVersion: string): Promise<DesktopUpdateState>;
}
