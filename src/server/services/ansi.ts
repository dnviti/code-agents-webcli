// CSI/OSC and the rest of the escape vocabulary a PTY emits.
//
// Shared by the Markdown exporter and the update-log streamer: both take text
// that a terminal produced and put it somewhere that is not a terminal, where
// an unstripped escape is at best noise and at worst an injection (an OSC 0
// sequence retitles whatever window the text is later pasted into).
//
// CSI (colours, cursor moves, including colon-separated and private
// parameters), OSC and the other string-terminated escapes with their whole
// body, single-character escapes, and stray control bytes. Tab, LF and CR are
// deliberately left in.
// eslint-disable-next-line no-control-regex
export const ANSI_PATTERN =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[P^_X][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[ -/]*[0-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip every escape sequence and control byte except tab, LF and CR. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}
