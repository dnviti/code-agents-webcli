const UNSUPPORTED_TERMINAL_SEQUENCE = /\x1b\[\[?[IO]/g;

export function stripUnsupportedTerminalSequences(data: string): string {
  return data.replace(UNSUPPORTED_TERMINAL_SEQUENCE, '');
}
