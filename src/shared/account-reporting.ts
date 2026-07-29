/**
 * What each runtime will tell this app about the account behind it.
 *
 * One sentence per runtime, and a sentence rather than a flag because the
 * answers are genuinely different shapes: Claude states a reset time and only
 * sometimes a percentage, Codex states a plan name and two windows, and most of
 * the others state nothing at all. A boolean would flatten all of that into a
 * blank panel, which is how the status readout came to be full of invented
 * numbers in the first place (#137).
 *
 * Every line here is what was seen on the wire, not what a vendor's
 * documentation promises. `docs/usage-accounting.md` records which build was
 * probed and when; when a runtime starts reporting something, the probe goes in
 * the docs and the sentence changes here.
 */

const NOTES: Record<string, string> = {
  claude: 'Claude reports which rate-limit window it is in and when that window resets, '
    + 'every turn. It reports how full the window is only once a warning threshold has been '
    + 'crossed, and it never states a token, message or dollar allowance — so there is no '
    + 'ceiling here to measure against.',
  codex: 'Codex reports its plan name and how full each of its rate-limit windows is, '
    + 'asked once when the conversation opens and re-sent whenever it changes.',
  agent: 'Cursor is driven in a terminal here, not over a protocol, so there is no channel '
    + 'for it to report an account on. Its usage lives behind cursor.com.',
  qwen: 'Qwen is driven in a terminal here, not over a protocol, so there is no channel for '
    + 'it to report an account on.',
  pi: 'pi reports what a turn cost and nothing about the account behind it. It runs on a '
    + 'provider key of your own, and this app does not read that key or call the provider on '
    + 'your behalf.',
  // Not read off the captures alone: kimi's handshake advertises `status` and
  // `usage` slash commands, and "no capture happens to carry a quota field" is
  // not the same claim as "the runtime will not tell you". Both were run over
  // ACP against 0.29.1 before this sentence was written — they answer with the
  // model, the thinking flag, the permission mode, plan *mode*, and the context
  // occupancy, and with nothing about membership, quota or billing.
  kimi: 'Kimi Code reports nothing about an account over the protocol this app drives it on. '
    + 'Its own /status and /usage commands answer with the model and the context window, '
    + 'not with a membership or a quota.',
  grok: 'Grok reports what a turn cost and nothing about the account behind it.',
  omp: 'Oh My Pi reports what a turn cost and nothing about the account behind it.',
  terminal: 'A terminal session has no runtime to ask.',
};

/** True when this runtime is expected to say something about an account. */
export function reportsAccountStatus(runtime: string): boolean {
  return runtime === 'claude' || runtime === 'codex';
}

export function accountReportingNote(runtime: string | null | undefined): string {
  if (!runtime) return 'Nothing is running here yet, so nobody has been asked.';
  return NOTES[runtime]
    // Deliberately not a guess at what an unknown runtime does. A new agent
    // arrives with a row in this table or with an honest shrug, never with
    // somebody else's sentence.
    ?? 'This runtime has not been probed for account status, so nothing is claimed about it.';
}
