# Changelog

## [Unreleased]

### Added
- **Antigravity CLI (`agy`) is a runtime like any other** (#133). Google's coding
  CLI — the successor to Gemini CLI, which now refuses a personal account
  outright and points at this one — has its own card in the launcher, opens as a
  terminal or as a conversation, and carries the same controls, accounting and
  recovery every other agent here does. It is renameable with
  `--antigravity-alias` / `ANTIGRAVITY_ALIAS` like the rest, and it takes a
  per-runtime profile (model, extra arguments, environment) like the rest.

  Three of its habits are handled rather than passed on. It asks "Do you trust
  the contents of this project?" the first time it sees a folder and then waits
  forever; the app answers it, the way it already answers Claude's. Driven
  headlessly it runs every shell tool in a scratch directory of its own — asked
  to read a file that was sitting right there it reported no such file existed —
  so the app passes `--new-project`, which puts it back in the folder you picked
  without adding anything to your own project list. And its `--print-timeout`
  defaults to five minutes, which cuts a real turn off mid-work; a conversation
  is not a script, so the ceiling is the interrupt button instead.

  What it will not do, it is not made to look like it does. Headless, it
  **cannot stop and ask**: anything needing approval is refused on the spot and
  the run carries on around it. So the mode is chosen when the conversation
  starts, stated on the card, and each refusal gets its own entry naming what was
  refused and what would have allowed it — never an unexplained failure. It
  reports how much it thought and never a word of what, so the reasoning entry
  says which silence that is instead of opening onto an empty panel. It prices
  nothing, so the meter says *cost not reported*. It reports no diff for a file
  edit, so none is drawn. `--mode accept-edits` and `--mode plan` are wired to
  nothing, because three runs of the same prompt proved they change nothing.

  The effort control is the interesting one: `--effort` is refused whenever a
  model is named, and what `agy models` publishes instead is one model id per
  level (`gemini-3.6-flash-high`, `-medium`, `-low`). So the levels offered are
  exactly the sibling ids the CLI printed, and picking one moves the next turn
  onto that model. A model with no level in its name offers no control at all.

### Fixed
- **A model list is no longer lost to a probe waiting on stdin.** The command
  each runtime is asked for its models with was run through `execFile`, which
  leaves the child an open stdin pipe — and `agy models` waits on that pipe
  forever. The picker said "this runtime hasn't listed models" about a runtime
  that lists eleven, and took the full eight-second timeout to say it. The probe
  now closes stdin, which it never wrote to: measured at 2.0s and the whole list,
  against no output and no exit before. The same trap has already caught
  `codex exec` and `pi -p` elsewhere in this codebase.
- **A chat that has just opened is empty, and the first prompt is turn 1.** The
  approval mode a conversation begins in was announced as a rule written across
  the transcript, and in a conversation nobody had spoken in yet that rule was
  the whole of it: a line, a turn strip and a row in the index for a turn that
  had not happened, so the empty state never showed and the first question the
  user actually asked opened turn 2 — with both strips reading "turn 1" until the
  recorded index arrived to disagree. The mode is a standing fact about the
  session rather than something that happened in the conversation, and the two
  surfaces that state standing facts already carry it permanently: the badge in
  the header and the chip beside the composer. The marker still travels, because
  a conversation restarted from inside itself re-decides the mode and nothing
  else tells the pane (#134), and it is still written to the log. It simply draws
  nothing.

## [5.3.3] - 2026-07-29

### Fixed
- **A conversation's record stops being edited by a question about layout.** The
  rule added for #132 — does this block put anything on the screen — is the right
  question for whether a step earns a row and the wrong one to ask before writing
  the step down. It says no to reasoning and to every tool call that is not a
  question, correctly, because neither earns a row on its own; asked at record
  time that verdict is permanent, taking the block off the trace and out of the
  work counter with no fold able to bring it back. Both codex adapters were
  asking it there. Nothing was lost in practice, and only because `itemToBlock`
  does not yet recognise the spelling real `codex exec --json` uses for those
  items — the first person to teach it would have silently deleted every command,
  diff and thought on that path. The record now asks whether the block has
  anything *in* it, and refuses only what is blank on its own terms: the blank
  reply #132 was filed for, and a plan a runtime announced and never filled in.
  Deciding the row stays where it belongs, on the display, working from a record
  that still holds everything.
- **The same answer twice is answered twice** (#128). The box that reports an
  outcome the control cannot show for itself now leaves after seven seconds,
  which was the fix for it piling up with the effort chip's. It was raised by an
  effect keyed on the message's *text*, so an outcome repeated word for word —
  the same model picked again on a runtime that cannot switch mid-session, or
  "use the default for this runtime" clicked twice — left that key unchanged once
  the box had gone, and the second click was answered with nothing at all. On a
  phone, where the chip can show neither a pending model nor a clear, that was
  the entire response to a deliberate action. Keyed on the answer itself now, so
  two identical ones are still two. The seven-second dismissal had no check
  either way; both halves have one now.
- **A delegation that stopped reporting reads that way in its own window too**
  (#139). The status for a call nothing will ever report on again reached the
  tool-status table, the Agents panel and the workflow popup, and missed the
  agent popup, which keeps a fourth copy of the list. So the row and the window
  it opens disagreed: the row said "no longer reporting" while the popup put a
  live dot on that very badge, drew the in-flight glyph beside the last thing the
  agent said, and offered "Waiting for this agent to report its first step…"
  about a wait that had already ended.
- **A prompt scrolled back to is drawn once, like every other one** (#129). The
  double bubble was fixed for live sending and for reopening a conversation, and
  survived in the one place left: scrolling back far enough that the turn arrives
  by paging. The rule that catches an echo needs this app's own copy of the
  prompt and the runtime's copy in front of it together — only
  `ChatSession.deliver` writes a user message, and it always mints
  `user-<uuid>`, so a second one in the same turn under a name this app would not
  have minted is the runtime repeating itself. Every history page is folded on
  its own, so a page boundary landing in the handful of events between the two
  hid each from the other and both survived: on a real Oh My Pi conversation the
  session wrote its message at seq 2485, a `state` event sat at 2488, the echo
  followed at 2489, and the client's 200-event walk put the boundary on exactly
  2488. Eleven pages back, the prompt was drawn twice. The same rule is now
  applied where the pair is finally whole, as pages are merged. Nothing on disk
  is rewritten — a turn that holds no message this app minted keeps what it has,
  rather than losing the only prompt it has.
- **The Status panel stops making up your subscription** (#137). It used to
  open on a plan badge reading `max20`, a meter reading "Tokens 0 of 220.0k"
  and a "Left 220.0k" underneath it. None of that was a fact about anybody's
  account. The plan name was a command-line flag whose default was `max20` on
  every install, so every user of every agent saw the same one. The allowances
  were a table written into this repository — 19,000 tokens and $18 for `pro`,
  220,000 and $140 for `max20`, and a bare 188,026 for anything it did not
  recognise — and no provider publishes those figures to a client. And the
  "used" number came from scanning every Claude Code transcript on the host
  machine, so it described the whole computer rather than you, and when it found
  no window containing the present moment it reported zero. A meter reading "0
  of 220.0k" therefore meant "nobody measured anything", while looking exactly
  like "you have spent nothing".

  Every one of those figures is gone, and so is the `--plan` flag that chose
  between them. The flag is still accepted and now does nothing, so an existing
  service unit keeps starting.

  What replaced them is only ever what a provider said about itself. Claude has
  been reporting its rate-limit window and reset time on every turn all along —
  the app was reading that line and throwing it away — and Codex will answer
  with its plan name and how full each of its windows is if you ask it, which
  this app now does when a conversation opens. Where the provider states a
  percentage there is a meter; where it does not, and four of five recorded
  Claude events do not, there is the reset time on its own and the words "not
  reported". A bar drawn at 0% would be the same lie in a new place.

  A "time until this runs out" now requires two readings of the same window
  during the same conversation, because one reading is a level and not a rate.
  Until the second arrives the panel says there are not enough readings yet.

  The section is titled after the agent you are actually talking to, and every
  runtime that reports nothing says so in a sentence naming what it does and
  does not tell us — Cursor and Qwen because they run in a terminal here with no
  protocol to ask over, and pi, Grok and Oh My Pi because no captured session of
  theirs has ever carried a quota, a limit or a reset. Kimi was asked rather
  than observed, because its handshake advertises `status` and `usage` commands
  and an unrun command proves nothing: both were driven over the ACP connection
  this app already speaks, and both answer with the model and the context
  window and nothing about a membership or a quota. The transcript of that probe
  is in `docs/usage-accounting.md`.

  Claude's billing line is stated only for the two sources that mean one: an
  `ANTHROPIC_API_KEY` the user exported, or an `apiKeyHelper` they configured.
  The CLI has a third answer — `/login managed key`, the key `/login` provisions
  into `~/.claude.json`, which the CLI itself groups with a claude.ai login
  rather than with a configured key — and that reads "not stated" rather than
  being turned into a confident "Billed as: API key".

  Beside it there is now a second, clearly separate section for what this app
  measured itself: the turns that ran through this client, for you, on that
  agent, over the last day. Those are priced at published list rates rather than
  billed, and a turn whose runtime reported nothing contributes nothing rather
  than a zero — the same rule the rest of the usage accounting already follows.
  It is kept apart from the provider's own meter on purpose; the two are in
  different currencies and adding them together would produce a figure that is
  neither. A conversation that has never been launched has no agent to scope a
  measurement to, and says that rather than reporting that this server keeps no
  usage record.

  There is one file this app will now open that it did not before, and one rule
  about which: **it reads a CLI's configuration file and never a credentials
  file.** `~/.claude.json` supplies a cached tier and percentage for whichever
  figure the conversation has not stated for itself — which for the tier is
  every conversation, since Claude states a window every turn and a plan name
  never — and each one it supplies is labelled: with the time the CLI wrote it,
  with a note that it describes the account this *server* is signed in as, and
  naming which figure on screen came from there rather than from the runtime.
  Nothing identifying comes back with it, and it is discarded once it is older
  than the shortest window it describes; a window it declines to measure at all
  is dropped rather than shown as 0%. `~/.codex/auth.json` is not read and will not be, which
  is why Codex's plan name comes over the protocol instead: the same fact is
  sitting in that file next to an access token and a refresh token, and a status
  readout is not worth going near them for.

  What was deliberately not changed: the Usage dashboard, which was already
  honest and is where the per-agent spend history lives; the local
  transcript-reading analytics service, which still measures what it always
  measured now that it has no invented ceiling to measure it against; and the
  billing question the issue also asks — what your account has actually spent
  with the provider this period. That needs an admin API key this app does not
  hold and should not, so it is not shown, rather than approximated.
- **An agent that reports no tokens and no cost now says so, instead of leaving
  the header blank** (#136). The report that started this said Oh My Pi showed
  no context window, no token counts and no cost. It turned out not to
  reproduce: omp reports all four, the app reads all four, and a session on it
  gets `85.7k tok · $0.1253` and a context bar in the header exactly as Claude
  does. That is now covered by a test driven off omp's own recording, so it
  cannot quietly stop being true.

  What the report was really about is what an empty header *means*, and the app
  had only one way to draw two very different things. A conversation whose first
  turn has not finished has no figures. A conversation with Kimi will never have
  any — probed, and confirmed in the recording the tests replay: Kimi sends no
  usage notifications, no token counts on its replies, and no cost anywhere.
  Both looked identical: nothing where the numbers go, which reads as "you have
  not spent anything yet".

  The rule now is that silence has to be *spoken*, and only a finished turn can
  speak it. Once a turn has actually done work and ended having reported no
  tokens or no money, the conversation records that fact once, and the header
  strip, the line under the composer and the Status panel all say **not
  reported** in place of the blank. Before that point they stay quiet, because
  nothing is known yet — and a runtime that goes quiet for one turn and reports
  on the next reads as having reported, not as silent.

  A turn that was *stopped* teaches it nothing. Pressing stop, correcting the
  agent mid-sentence, or a runtime that falls over all end a turn before the
  moment it would have said what the turn cost, so none of them is evidence
  about the runtime and none of them writes the label. Otherwise stopping Claude
  once would have left "reports neither tokens nor cost" standing over a Claude
  conversation for the rest of its life.

  Kimi also stops claiming it can report tokens and money. Every agent behind
  the protocol bridge advertised both, which was optimism for most of them and
  simply wrong for Kimi — and it was durable, because that claim is what the
  permanent usage history files against every job. Kimi's jobs read as "n/a" in
  the usage dashboard now — the label that view uses for a runtime that cannot
  report, as against "not reported" for a job from an agent that could have and
  did not. The other bridge agents keep the optimistic default: their handshake
  corrects it upward, and a silent turn corrects it downward from evidence.

  Those two labels belong to the history view, which has a capability recorded
  beside every job it draws. A live conversation has no such record and makes no
  such claim: it says "not reported" for what it watched happen, which is why
  the two surfaces word the same silence differently. `docs/usage-accounting.md`
  now says which is which.

  One quieter fix rides along. A runtime that publishes how big its context
  window is did not always say which model the window was about, so a model
  change mid-conversation could make the app read the agent's own figure as the
  previous model's, throw it away, and go asking a model catalogue for a worse
  one. Oh My Pi, Codex and Claude all name the model now.

  Two things it deliberately does not do. It does not price a turn the app was
  not told the price of — there is no price table here and there will not be
  one, so "cost not reported" for Codex means exactly that. And it does not work
  out what a runtime can report by watching it: the usage dashboard keeps "this
  agent cannot report" and "this agent could have and did not" apart on purpose,
  and those stay two different answers.
- **The model you pick is remembered for that agent, and the picker says where
  it came from** (#135). Choosing a model in a chat used to last exactly as long
  as that conversation. Open a new one on the same agent and you were back on
  whatever the CLI does by default, picking again — while the effort control
  right beside it had been remembering its setting per runtime for two releases.

  A model chosen in a chat is now your standing choice for that agent, and the
  next new chat opens on it. Three things can decide the model, and they are
  consulted in this order: whatever *this conversation* was set to, then your
  standing choice for the agent, then the active runtime profile. Below all
  three the CLI is launched with no model flag at all and uses its own default.

  A conversation already under way is never re-modelled. Every chat records the
  model its launch actually used, and that recorded model is what it comes back
  on — so a relaunch, a resume from the launcher and the recovery banner's
  restart all return to the model that conversation was already using, including
  after a server restart, which is the moment every open conversation gets
  relaunched. Changing your standing choice, or the active profile, affects the
  next new chat and nothing that is open. A conversation that launched with no
  model flag at all keeps that too: a profile added afterwards does not reach
  back into it.

  **The picker now says which of the three is in force**, in a line above the
  list and on the chip's hover. Before this, a model pinned by a runtime profile
  was genuinely applied to every launch and nowhere on screen: until the agent
  reported a model of its own, the chip read the literal word "model". It now
  names the model *this conversation was launched on* — never a default it was
  not launched on, which would change under an open chat every time you picked a
  model in another tab — and says where the default came from: a profile, by
  name; your own last choice; or nobody, in which case the runtime picks. When
  the two differ the line says which model the conversation is staying on.

  **Use the default for this runtime** clears the conversation's choice *and*
  forgets your standing one, so the next new chat falls back to the profile and
  then to the CLI's own default. That is deliberate, and it is what makes the
  entry worth having: nothing else in the app can undo a standing choice, and a
  model id typed with a typo would otherwise ride into every new chat on that
  runtime. For the same reason, a name is only promoted to a standing choice
  when the runtime is known to take it — the switch applied live, or the name is
  on the list the runtime published. A runtime that publishes no list at all
  (Claude is one) has nothing to check against, so a name typed there is taken
  at face value.

  Your standing choice lives on the server, scoped to your account, so it
  travels between your phone and your desk and is not readable from anyone
  else's. Effort is kept per browser instead, and the difference is not taste:
  Claude, Codex and pi fix the model when the process starts, so a preference
  held in the browser could only be applied after the launch — which on Claude
  means a visible `/model` turn pushed into a conversation nobody has typed in
  yet.

  Runtime profiles are not weakened by this and not going anywhere. They were
  never a pin a user could not escape — a conversation's own choice has
  outranked them since the picker existed — and they remain the shared default
  for everybody who has not chosen. Two things deliberately did not change:
  terminal sessions, which run the CLI's own interface where the model is yours
  to change inside the tool, and the launcher screen before a chat starts, which
  has no model control for the new line to sit in. Branching is unaffected: a
  branch opens on the model its source was actually running — the one the
  carried history was just measured against — whether that came from a choice,
  from your standing one, from the profile, or from nothing at all.
- **The Web chat approvals switch now reaches every way of starting a
  conversation, and holds for you rather than for the browser you set it in**
  (#134). It reached exactly one: the chat button on the runtime launcher.
  Everything else ignored it. A branch cut from a turn always asked. *Start a
  new chat* on the recovery notice after a server restart always asked — and
  when nothing had recorded which conversation the agent was having, that button
  was the only one offered, so those conversations had no route back to the mode
  you had chosen at all. Meanwhile **New chat** inside a live conversation did
  the opposite: it carried the old conversation's bypass forward even if you had
  since switched the preference back to asking. Two actions with nearly the same
  name doing opposite things, with nothing on screen saying which you had got.

  There is one rule now, and it is decided by *how you got there* rather than by
  what happens to be on the record. A conversation that is **beginning** takes
  your preference: the launcher, a branch, starting over after a restart, and
  `/clear` are all beginnings. A conversation that is **continuing** — resumed
  from the launcher, opened from the conversations list, or picked back up with
  *Resume this conversation* — comes back in the mode it was already running in,
  and the preference is not re-read in either direction. Turning the preference
  on later cannot widen a conversation that had already chosen to ask; turning
  it off cannot take the mode away from one that is running without prompts.
  Anything missing or unreadable means ask.

  The mode is stated where you are looking. Every conversation opens with a line
  saying which mode it is in, including the one that replaces it after a
  `/clear`, and the two buttons on the recovery notice each name the mode they
  land in — so a bypass is never restored, or dropped, in silence. The chip
  beside the input box and the header badge move with that line rather than
  going on naming the mode of the conversation the `/clear` replaced, which is
  the difference between reading the mode once and being able to check it.

  The preference has moved off the browser and onto your account. It is stored
  on the server, arrives with the page, and is the same answer on your phone as
  on your desktop. One consequence of that move: **a preference set before this
  release does not carry over.** It had never been attached to an account, only
  to a browser profile, and quietly turning approvals off for an account on the
  strength of a value one device happened to be holding is not a thing to do
  with a standing permission. Set it once more and it follows you.

  A chat launch no longer carries an approval flag from the page at all. The
  button reports what the server is going to do instead of asking for it, which
  removes the one place in this feature where a page could have asked for a
  permission the account had never been granted. An explicit *narrowing* from
  the browser is still honoured, because asking more often is always safe.

  A conversation also shows its real mode from its first paint now, rather than
  claiming it asks first until the server answers — the session list already
  knew, and the tab simply was not told.

  Two things deliberately left alone. The terminal surface's own **No prompts**
  button is a per-launch choice on a different surface and is not covered by
  this preference. And **pi** is named rather than papered over: its chat
  adapter has no approval channel, so a pi conversation runs its tools without
  asking whichever mode the rule works out — its opening line says so instead of
  promising prompts that were never going to come.
- **On a phone the message is the largest text in the conversation again**
  (#92). It had become the smallest. Everything around it — the turn header, the
  tool and reasoning summary, the model and token line, the timestamps — was
  made phone-aware and raised to 15px to fix an earlier complaint about
  captions nobody could read, and the message itself never was: it stayed at
  13px while the accounting around it sat at 15 in a wide monospace face and in
  capitals, which reads larger still. The eye landed on "83 tools 31 reasoning"
  and on a string of token counts before it found what had actually been said.

  There is an order now, and it is written down in one place: 17px for the
  message (18 at comfortable density), 16 for anything typed into, 15 for a
  collapsed turn's label and for the live session figures in the header, 13 for
  the per-message and per-turn detail, and nothing readable below 12. The rule
  the earlier fix encoded — nothing carrying live session information is smaller
  than the body text — survives where it belongs, in the session chrome, and no
  longer governs the conversation.

  Size is not all of it. The per-turn label drops its capitals and its wide
  tracking on a phone, and a tool call's title drops its extra weight: a 13px
  shout is still a shout. Two search fields that were below 16px now clear it,
  because iOS Safari magnifies the page when a smaller field takes focus and
  never magnifies back.

  Desktop sizing is untouched, and there is now a check that measures the
  *order* rather than a floor. Every phone type rule this app had was "nothing
  smaller than N", and a floor cannot catch an inversion — which is exactly how
  this shipped.
- **A delegation nothing will report on again stops reading as running** (#139).
  After a chat turn finished and the agent had delivered its answer, a workflow
  started during that turn could still appear as running — a spinning badge on
  its row, a non-zero count on the Agents panel, a turning dot on the trace —
  with no waits and no activity anywhere in the trace to explain it. The
  conversation said the work was over and the panel said it was not, and nothing
  on screen said which was true.

  Nothing in the pipeline ever closed a call on a turn-level event. Ending a
  turn stamped the outcome onto every message in it and never looked inside
  their blocks. And the runtimes routinely stop reporting on a call before the
  turn is over: an Oh My Pi task moved to the background never sends a terminal
  update at all, and Claude ends a turn with an unresolved call whenever a tool
  errors during execution. So the call sat non-terminal for ever.

  A call left open when its turn ends now reads **no longer reporting**. It is a
  new word on purpose: nobody stopped it, which is what *cancelled* says, and
  nothing is known to have broken, which is what *failed* says — the runtime
  went quiet and its turn is over. A spinner that will never stop is the worse
  answer.

  Two things it deliberately does not do. A run that is still reporting about
  *itself* — a background workflow saying it is working — outlives its turn by
  design and is left alone; it settles when it says so, or when the runtime it
  belongs to is gone, since nothing can report after that. And a turn
  interrupted to redirect it has not ended, so nothing in it is settled.

  An ending that turns up late still lands: this is the answer until a better
  one arrives, and a real completion replaces it. What cannot land is a progress
  report that would put the spinner back on a runtime that has already gone
  quiet once.

  The popup stops saying it is waiting for a stage to report in, which was the
  trace claiming something was waiting when nothing was.
- **An answered question comes back marked** (#113). A question the agent asked
  is left in the conversation after it is answered for exactly one reason:
  scrolling back past a decision should show the decision. It only survived as
  long as you stayed put. Switching to another conversation tab and back redrew
  every answered card blank — all the options faded, none marked, sometimes a
  grey sentence naming the labels underneath and sometimes nothing at all. A
  card reading as one nobody had ever answered, sitting beside an agent that had
  plainly acted on an answer.

  The answer was never lost. It was sent, the agent got it, the turn carried on,
  and the conversation's own record still held every option that was picked. It
  was dropped at the join: the snapshot a rejoining browser is sent had nowhere
  to put it. What was on screen until then was not the record at all — it was
  the card's own memory of the click, and that does not survive the surface
  being taken down and built again, which is what switching tabs does.

  So the snapshot carries it now, and it survives a tab switch, a reload, a
  reconnect, a second browser, a conversation whose agent has since stopped, and
  a question far enough back that it arrives by scrolling rather than with the
  opening view — that last one had a second leak of its own, where the page was
  replayed through a scratch transcript that worked the answer out correctly and
  was then thrown away with it.

  Questions answered before this ships come back marked too. Nothing needs
  migrating: the answer has always been written to the log, and the snapshot is
  built by replaying that log.

  One thing the card used to say that it should not: "Skipped without
  answering" was drawn both when the user really had skipped and when the app
  simply did not know. Those are different facts and now read differently — a
  skip is an answer, and claiming one nobody gave is the same misreport this
  issue is about, in miniature.
- **A row appears in the conversation only when it has something to say** (#132).
  #46 set the rule: a step that produced only tool activity and no written reply
  gets no row of its own, its work is counted on the next reply that does speak,
  and the detail stays on the trace. What it decided from was the *kind* of a
  step's blocks — a reply block meant "this one spoke" — never from whether
  anything would actually appear on the screen.

  Oh My Pi sends a reply that is a single space beside the tool activity on
  almost every step. Each of those counted as having spoken and got the row #46
  exists to remove: a bordered strip holding a model name, a clock and a work
  counter, with no sentence anywhere in it. In the recorded conversation this
  was reported from, 22 of 29 rows. The other agents on that protocol send the
  same blank replies and escaped only because they group a whole turn into one
  step, so the blank lands in the same row as the real answer — lucky, not safe.
  Claude had its own trigger: a command whose arguments merely mention the name
  of the question tool was taken for a question the agent had asked, and a
  question card with no question in it paints nothing.

  Both are gone, and the fix is in two halves on purpose. A blank reply is no
  longer *recorded* as content — by the ACP adapters, by Claude's snapshots, by
  codex — so it never reaches a transcript in the first place. And the rule that
  decides whether to draw a row now asks the only question that matters: would
  this paint? A reply that is empty or only spaces, a plan with nothing in it, a
  step mistaken for a question — none of them earns a row, whichever agent
  produced it.

  The work counter and the trace of every folded step land on the next reply
  that does speak, in the order they happened, exactly as #46 requires. And a
  command that mentions the question tool is now counted as the command it is,
  which it was not before — it was being skipped as a question already on
  screen.

  Two things deliberately left alone. A stream that opens an empty block before
  its first token still opens it: pi and Claude address their deltas by index,
  so the block has to exist before they arrive, and the display rule is the
  backstop for whatever ends up in it. And conversations already on disk are not
  rewritten — they simply stop drawing the empty rows when they are reopened.

  Checked against real recordings rather than constructed ones: the Oh My Pi
  session the issue was reported from, and a Claude one containing the grep that
  was mistaken for a question.

- **One prompt makes one turn again** (#129). Sending a single message from the
  composer put two identical user turns in the conversation, side by side. The
  browser was never involved: there is one submit path, one frame on the wire,
  and nothing optimistic anywhere in it. Both copies were written by the server.
  `ChatSession` writes the user's message, because it is the same in every
  protocol and a transcript missing what was asked is useless for resuming,
  exporting or searching — and then every ACP runtime (Oh My Pi, Kimi, Grok,
  opencode) and both codex modes wrote it *again* from inside their own send,
  under a turn id of their own. Anything arriving inside an open turn joins that
  turn, so the two landed together. Claude and pi never did it, which is why the
  report came from an Oh My Pi conversation.

  Those adapters no longer write one. The session now also refuses a user
  message it did not mint itself, so this cannot come back from a new runtime:
  only the session knows what the user actually typed — a branched conversation
  hands the adapter the carried briefing glued in front of the prompt, and the
  echo filed all of it as something the user had said — and only the session
  knows whether the turn was a steer.

  **Conversations recorded before this are not rewritten, and stop drawing the
  double anyway.** The logs on disk still hold both messages and are replayed
  every time one of those conversations is opened, so the fold happens where
  they are read. What identifies the echo is not that it repeats — people
  repeat themselves — but that this app did not write it: a message claiming to
  be the user, with an id nothing here would have minted, inside a turn that
  already carries the user's own. A real second prompt cannot be caught by that,
  because a real one comes from the session.

  The accounting has defended itself against these echoes since #86 and is
  untouched: old logs still contain them.

- **Changing the model is quiet now, like changing the effort** (#128). Every
  pick raised a box beside the composer reading "Switched to claude-sonnet for
  this conversation." It is the answer #119 deliberately left as an open
  question, and it is the same one: a change that took effect needs no
  announcement, because the control has already made it by redrawing. The chip
  wears the new model's name the instant the switch lands, so the box was the
  one thing on screen saying nothing new — while overlapping the controls around
  it, and on a phone landing on the field the user was about to type into.

  Three outcomes still speak, because each is one the chip gets wrong on its
  own: a choice the runtime has to be *asked* about mid-session is waiting on
  its reply in the transcript; one that will only apply from the next session
  does not reach this conversation at all; and clearing the override is the
  least visible of the three, because the chip has already fallen back to
  whatever the session last reported, which is not what the next one will run.
  Unlike the effort ladder there is no refusal to report — a model name is free
  text and nothing here can pre-judge it.

  Two things the effort chip fixed and this one had not. The hover now describes
  the control again instead of holding the last confirmation for the rest of the
  conversation. And the notice that does appear times out and, on a phone, opens
  upward: this wrapper is `static` there so the menu can have the composer's
  width, which means `top: 100%` resolved against the composer and put the box
  on the bottom navigation bar. Measured before the fix, a deferred choice was
  drawn at 686–756px on a 740px-tall phone — over the bar and past the bottom of
  the screen.

- **A long popup title is cut, and the window's controls stay where they are**
  (#114). Every popup in this app is the same panel, and its title was the one
  thing in the title bar with no permission to shrink. A flex item's automatic
  minimum size is its own content, so a title carrying a `white-space: nowrap`
  span — the issue reader's, the file editor's — made the row wider than the
  panel and pushed the controls block, which is deliberately unshrinkable,
  bodily out of it. Measured at a phone width, the Close button ended up 341px
  past the right edge of the screen: not hard to aim at, gone, with the title
  painted across the strip it should have occupied. A plain-string title failed
  the other way and wrapped, taking the bar from one line to five.

  The title is now the side that yields. It ends in an ellipsis when it has to,
  it never wraps, and the controls keep their full size — including the 44px
  touch targets a phone gets. Nothing is actually lost: the whole title stays in
  the element, so the accessible name is unchanged, and it is on hover too. A
  title made of nodes rather than a string has no text a browser could put in a
  tooltip, so those four popups hand theirs over explicitly.

  Clamping the title is not enough on its own, and that is the half that is easy
  to miss. Inside a title that may not wrap, an inline-level wrapper is laid out
  at its maximum width and then chopped with no ellipsis to say so, and anything
  after it — the workflow popup's status badge, the file editor's view switch —
  is clipped away entirely rather than shortened. So each of the four now says
  which part gives way: the sentence, never the icon, the issue number or the
  status. The file editor's view switch moved out of the title and in with the
  other controls, because it is a control and a cut title would have taken it.

  Checked in a browser, since none of this is visible to static markup: four
  shapes of title, each at a desktop width, dragged 300px narrower, maximised,
  and in a real 390px phone frame with the app's own stylesheets — 224
  assertions that the title stops before the controls, stays on one line, is
  ellipsised rather than chopped, and that every control is inside the panel,
  full size, and returns itself from a hit test at its own centre. Run against
  the code before the fix, 44 of them fail.
- **A background workflow reads as running until the run itself ends** (#116).
  Starting one is a quick, separate step: the request comes back almost
  immediately with "Workflow launched in background", and the actual work — often
  several agents across several phases — keeps going for many minutes. The app
  took that acknowledgement for the end of the work. Within a second of a
  workflow starting it wore a green **done** badge on its row and in its popup
  title, no spinner, below the Finished divider, and missing from the panel's
  running count. In a recorded run the badge flipped about a minute in and the
  workflow then kept going for another nine, counting up through hundreds of
  tool calls underneath it.

  The receipt is a receipt now, not a result. The launching call stays running
  and is settled by the run's own report — done, failed, or cancelled, on either
  of the two channels the runtime uses, whichever arrives — so the row, the
  badge, the popup title, the spinner, the trace rail and the running count all
  say the same true thing. Cancellation was simply unreachable before; it is the
  outcome that had no path to the screen at all.

  The acknowledgement is no longer captioned as the run's final output either.
  It says how the run was launched, which is what it is.

  And a run this app can no longer watch — the process exited, the app
  restarted — settles as interrupted rather than spinning for ever, saying in
  its own words that it is our observation that ended and not necessarily the
  run. That mattered less before, because the run already claimed to be
  finished; it is load-bearing now.

  The Agents row also takes its elapsed time from the run when the run reports
  one. It used to show nothing while the popup two inches away counted up
  through nine minutes.

  Only workflows. How an ordinary delegation reports its status is untouched,
  and there is a test that says so.

## [5.3.2] - 2026-07-29

### Fixed
- **A workflow that failed no longer reads as done** (#140). The Workflow tool
  returns the moment a run is launched — "Workflow launched in background", no
  error, four seconds before anything has happened — and that acknowledgement
  was the only thing the app ever heard about how the run went. So a workflow
  that hit a usage limit, lost its runtime, or threw halfway through wore a
  green **done** badge on its row and in its popup title, and the conversation
  said nothing at all. In a run that takes twenty minutes in the background,
  that is a task you believe finished.

  The run does say how it ended. It says it twice, on a channel this app was
  listening to and one it was not: `task_updated` carries the raw error, and
  `task_notification` — which used to be dropped with the hook plumbing —
  carries a sentence. Either now settles the call that launched the run, so the
  row, the popup title and the tool call on the trace rail all read **failed**,
  with the reason's first line on the row itself rather than a badge that makes
  you open a popup to learn what broke. The conversation gets a message saying
  so, filed under the turn on screen rather than behind a fold, carrying the
  reason as a sentence — the stack frames stay on the run, where the popup
  shows them.

  Somebody in another conversation is told, in the same notification a failed
  turn raises and under the same switch, now labelled "a turn or workflow
  fails" — because a background run's own turn ended cleanly and some time ago.
  That notification survives the conversation carrying on, which is the
  ordinary case: a run that breaks mid-turn is followed within seconds by that
  turn ending normally. The tab raises its unread mark too, for the browsers
  where notification permission was never granted.

  **Agents inside a workflow are counted, not promoted.** A thrown agent
  resolves to `null` rather than failing the run — a script that probes for
  failures expects some — so a run that returned a result still reads as done,
  with `2 failed` beside it in red and the phase they died in marked failed.
  Only a run that reports its own failure is a failed run. The same rule the
  transcript already applies to a step that failed inside a turn that did not.

  Verified against two recordings of real runs rather than a hand-written
  example of one: `claude-workflow-failed.jsonl`, captured for this by
  `.work/probes/workflow-failure-probe.mjs`, and the existing
  `claude-workflow.jsonl`, which turned out to be the control it needed — a run
  that succeeded with one of its five agents dead.

  Two neighbouring bugs are untouched and still open: a workflow reads **done**
  for as long as it is *running* (#116), and one whose ending never arrives
  reads **running** forever (#139). Both come from the same launch
  acknowledgement, and both need the run's whole lifecycle rather than only its
  failures.

- **Changing the effort level no longer announces itself** (#119). Every pick
  raised a box beside the composer reading "Now thinking at high" — an opaque
  panel that overlapped the controls around it and, on a phone, landed on the
  field the user was about to type into, because it resolves against the
  composer there rather than against its own chip. It was also the one thing on
  screen saying nothing new: the chip redraws to the new level the instant it
  lands, spelling it out, filling its meter to where the level sits on that
  runtime's own ladder, and colouring it.

  So a change that took effect is now silent, and the four outcomes that are
  *not* that still speak, because they are exactly the ones the chip gets wrong
  on its own: a **refused** level was never stored and the conversation is still
  running at the old one; **sent** is waiting on the runtime's own reply in the
  transcript; and **pending** and **cleared** do not reach the conversation in
  progress at all — `cleared` least visibly of the three, since the chip has
  already dropped back to a default it will not actually run at until the next
  session. Muting those would leave a change looking made that was not. The
  hover went back to describing the control as well, instead of holding the
  confirmation for the rest of the conversation.

  The model picker's equivalent is left alone for now; it is raised as an open
  question on the issue rather than decided here.

- **A reasoning entry never opens onto an empty panel** (#120). The trace rail
  showed "reasoning", and expanding it showed a blank box — three times on an
  ordinary turn. Nothing said whether the agent had reasoned about nothing,
  whether the app had dropped the text, or whether the agent had never handed it
  over, which is the one thing the trace exists to answer.

  All six runtimes were driven to find out, rather than assuming the agent it
  was reported against was the only one. **pi, Kimi Code and Oh My Pi** hand
  over their reasoning and always did; **Grok Build** does too, on the traffic it
  has been recorded producing (its own API was erroring, eight retries deep,
  while this was being written). **Claude Code does not.** Probed live against
  2.1.220 at `--effort high`: every thinking block on the wire is
  `"thinking": ""` with a signature beside it, every `thinking_delta` is empty,
  and the only account of what was thought is a token estimate on a side
  channel. **Codex** withholds it too wherever its trace is encrypted and it
  summarised nothing — which is all 22,987 reasoning items in this machine's own
  codex history.

  So the entry now says which silence it is. Reasoning text where the agent
  sends any; "still reasoning" while the block is open; and where an agent kept
  it, a plain sentence saying so *with the size it did report* — Claude's own
  running estimate, marked `~` because measured against the same turns' billed
  thinking tokens it runs high. The collapsed row previews the same thing rather
  than sitting blank, and the figure beside it now climbs as the agent thinks
  instead of staying still. Codex's reasoning *summaries* were also being
  dropped on the way in — the app read only its raw-trace channel, which for an
  encrypted trace carries nothing — so a codex turn that summarised its thinking
  showed an empty panel even though the words had arrived.

  Covered per agent, so a runtime that stops sending reasoning is caught rather
  than quietly rendering nothing: each one's own recorded traffic is replayed
  through its adapter and asserted on, and a browser check expands all three
  shapes of entry and fails if any of them paints an empty box.

- **The settings dialog is usable on a phone.** Two things were wrong with it,
  both found by putting the app's own settings dialog into the phone checks —
  which had covered every other sheet and dialog but not the longest one in the
  product. Its rows put the explanation and the control side by side, a shape
  that only works with room for both: at 390px the control kept its width and
  the sentence beside it was set one word to a line ("Sets / the / terminal /
  palette / and / the"). Rows stack on a phone now, sentence first, control
  under it. And the font-size slider was four pixels tall — a native range's hit
  area is its own box — so changing the terminal's text size meant landing a
  fingertip on a hairline. It is a touch target's height there now, with the
  track still painted thin and the desktop row unchanged.

- **The terminal takes its own size back, and asks for the screen again.** The
  PTY is shared, so a split pane, a second browser tab or a phone joining the
  same session resizes it to *their* screen. This client kept one record of the
  size it had last sent, made once and never reset, so it saw nothing to send
  and went on drawing a full-width screen over a half-width PTY — and since the
  attached CLI paints only the cells it thinks changed, what was left was the
  skeleton with the ticking values moving on it that issue #17 was reported for.
  The record is now dropped whenever this client's claim on the PTY may be
  stale: a socket opening, a session joined, a reattach over a socket that never
  dropped (closing a split, which is the case that had no event at all), and
  coming back to the tab — which is the only signal there is when the resize
  happened in another window entirely. A join also dips the height a row and
  puts it straight back, because re-sending a size the PTY already has asks for
  no repaint: two real SIGWINCHes are what resizing the browser window was doing
  by hand.

- **A pasted image is attached again, not typed as a path.** The upload always
  worked; how the resulting path was handed to the terminal did not. It went out
  as a raw socket write, so it reached the program as characters typed at the
  prompt with none of the markers that say a paste happened, and an agent that
  attaches pasted image paths saw only a filename. It now leaves through the
  same paste path as any other paste — the one-line change issue #18 asked for
  in its own title, which had never been made — and the raw sender it used is
  gone from the interface, so nothing can reach for it again.

- **The shell inside a conversation can be driven from a phone.** It inherited
  the on-screen-keyboard suppression that made terminals usable on touch, but
  not the key strip that suppression depends on: no Escape, Tab, Enter, arrows
  or Ctrl, and since a tap no longer summons the keyboard either, the pane was
  something you could read and not use. The strip now sits inside the split,
  wired to that pane's own session rather than to whichever session the shell
  considers current — so an arrow follows the cursor-key mode of the terminal
  you are looking at — and the conversation's floating menu steps up out of its
  way instead of covering the key that summons the keyboard.
- **A model chosen for a conversation survives a restart, on every runtime.** On
  grok, kimi and Oh My Pi the switch was applied to the running process and
  nowhere else: the adapter never carried the choice into a launch, so `/clear`
  — which restarts the process in place — or any relaunch brought the agent up
  on its own default, while the chip in the composer went on naming the model
  the user picked. Every turn after that was answered and billed on a model
  nobody chose, with nothing on screen to say so. The choice is now reapplied
  over the protocol as soon as the session opens, down whichever road each agent
  published; a model an agent refuses leaves an error in the conversation
  instead of taking it down.

- **Grok reports the context it is using, and what each model did.** It publishes
  both — occupancy on the `_meta` of nearly every update it sends, the per-model
  breakdown on the reply that ends a turn — and neither was being read, because
  the adapter only knew the one channel the other ACP agents use. So a Grok
  conversation had a 512,000-token ceiling with nothing measured against it: no
  percentage, no bar, and no way to reach the warning that says the window is
  filling up. It also read "not reported" in the dashboard's Model turns column
  on every row. The occupancy taken is the last request's own figure, not the
  turn's total — that turn totalled 65,943 tokens with 16,637 ever in the window
  at once, and filing the larger number would have drawn a bar four times too
  full.

- **A ceiling nobody can vouch for comes down instead of standing there.**
  Switch mid-conversation to a model the agent does not describe and no
  catalogue lists, and the previous model's window stayed on screen — the bar,
  the percentage, and the "N left, compact or start a new conversation" warning,
  all describing the conversation you had just left, while occupancy went on
  climbing against a model that may be far smaller. A context that was nearly
  full read as comfortable. The reading now says the size is unknown and means
  it. It says that only when nobody can answer: a window the agent itself
  published for the model it just moved to is kept, and a lookup that could not
  be reached is not mistaken for one that answered no.
- **"Send this one now" keeps the message it is sending.** On a runtime that
  spawns a process per turn, this cut the running work short and then lost what
  the user had typed: the interrupt only signals the child, so the send that
  followed was refused while it was still exiting, and the promoted message —
  already out of the queue — was gone. What was left on screen was the turn cut
  short, the message printed as though it had been asked, and one line of error;
  then the *next* queued message was delivered, so the agent answered a
  follow-up written on the assumption the correction had landed. The promotion
  now waits for the runtime the way every other delivery does, and a delivery
  that fails puts the message back at the head of the line with the reason on
  it, which is what makes it retryable rather than retypable.

- **A cleared conversation is no longer offered back with its old memory.** The
  clear dropped the runtime's session id from the running session and nowhere
  else. The record that outlives the process kept it — its writer could not
  express "there is no id" — so a conversation cleared and then left alone came
  back after a server restart showing the emptied transcript above an offer to
  pick it up where it left off, and taking that offer handed the agent every
  turn the user had cleared to be rid of. The record is told now, and told after
  the log it lived in has actually been dropped: a record with no id sends the
  server to the head of the log for one, so the other order would have been
  undone by the very next rejoin.

- **A resumed conversation has its commands, attachments and stop button
  straight away.** A snapshot took what the runtime can do from the replayed
  tail alone, and Claude announces that once, at the head of the log — so any
  conversation past the replay window came back with none of it: no slash menu,
  no attachment control, an inert stop button and empty model and effort menus,
  until the user sent a throwaway message or switched tabs and back. The same
  conversation a few messages shorter came back complete, so the failure looked
  arbitrary. What the runtime said is now read from the whole log, and a
  relaunch no longer throws away the capabilities it has been carrying all
  along.

- **The runtime's own command list is the command list.** A scan of what is
  installed on disk was merged back over it for every runtime, so on Claude a
  skill it does not accept — a disabled plugin's, a directory it rejects —
  stayed in the `/` menu, and choosing it sent text no command matches. The
  merge is kept exactly where it is needed: grok announces seven built-ins and
  nothing about `.grok/skills`, and taking it literally there would empty a
  user's own menu milliseconds after the handshake.
- **Selecting an older turn takes you there.** Past about four thousand events
  above what was loaded, clicking an entry in the turn index did nothing at all:
  the row highlighted and stayed highlighted, the conversation did not move, and
  nothing was said. The walk back gave up at a page ceiling while the history
  was still on disk, and the caller ignored the answer. In the conversations an
  index exists for, that was the ordinary case rather than the guard. A jump now
  goes as far as it has to, says which turn it is fetching while it works, and
  can be abandoned by doing anything else. The ceiling stays where it belongs:
  ordinary scrolling still asks for one page at a time.

- **The turn index no longer renumbers a trimmed conversation from 1.** Past the
  retention cap the oldest events are dropped, and the turns that survived were
  numbered by their position in what was left — so the index, the count in the
  header and the dashboard's requests figure disagreed about the same turn. The
  number of turns that went is now kept with the log, so the survivors keep the
  numbers they had; and the index says out loud that the older history was
  trimmed, which the server has been reporting all along to a UI that read it
  nowhere.

- **Expand-all and collapse-all can be reached at any width.** Between 1024 and
  1280 pixels the index shrinks to a rail of icons and dropped both, with no
  menu entry, shortcut or setting behind them — which is every maximised
  1366x768 laptop and every half-screen on a large monitor. They are now in the
  index's own menu at that width, and on **Ctrl+E** / **Ctrl+Shift+E**
  (⌘E on a Mac) from anywhere in the conversation, composer included.

- **A running workflow says what it is doing.** The popup read only the output
  the tool writes when it finishes, so it showed "waiting for the first stage to
  report in" for the whole run — which for a dynamic workflow is tens of
  minutes. It now reads the same live channel a delegation's popup has always
  read: the stage the run names for itself, the tool it last reached for, and
  what it has spent, updating as it goes, with the finished log still landing
  underneath. A run invoked by script path is titled with the script's own name
  rather than the word "Workflow".
- **The usage dashboard can look at a period that has ended.** Its window was
  always anchored on "now" and the client never sent the anchor the API has
  always accepted, so nothing before 1 January of the viewer's own year could be
  reached — not the charts, not the history list, not the export, while the rows
  sat in the database and could be had by typing a URL by hand. Today that costs
  nothing, because accounting began in July; from the first of January it would
  have taken the whole previous year off the screen. There are now arrows, a
  date field and a way back to the present, and the window belongs to the whole
  page: the history under the charts and the export follow it. Nothing offers to
  walk into the future, and a window that holds nothing says so.

- **The effort histograms can be read without a mouse.** Every bar was a plain
  `div` inside a hover tooltip, so the keyboard never reached one and a screen
  reader heard five orphan labels — "1", "2", "3-5", "6-10", "11+" — with no
  numbers against them. The distribution is the whole question that panel
  answers. Each bucket is now a real control that says how many turns fall in
  it, announces itself when reached, and answers a tap. The dashboard's own
  accessibility checks had been running against fixtures with the histograms
  empty, which is how this stayed hidden through thirteen of them; they carry a
  real distribution now.

- **The phone layout reaches the file tree and the shell.** Two of the five
  destinations in the bottom bar never received the touch scale: the file tree
  drew 26px rows with 10px size figures and no gap between them, so a mistap
  opened the wrong file, and the terminal's tab bar put 22px buttons two pixels
  apart. Both are at the touch floor now, with type no smaller than the rest of
  the phone layout. The phone checks were pressing "Files" and asserting only
  that something appeared — they now open each destination and hold it to the
  same rules as the conversation, including that nothing is pushed off the side.
- **A slash command Claude answers itself now leaves an answer on screen.** Some
  commands — `/effort`, `/model` — are handled by the CLI without going near the
  model, and a locally-handled command emits no streaming events at all. This
  app's transcript is built from streaming and treats the snapshot that follows
  as a patch, so there was nothing for those replies to patch and they were
  dropped: typing one showed the command, a turn, `$0`, and no answer, for a
  command that had in fact worked. An answer nothing streamed is now a message
  in its own right.

- **The composer's own answers redraw when they arrive.** The store's
  equality guard compared the six values the chat surface republishes and, since
  a controller reporting its own change moves none of them, told no listener
  anything had happened. Everything held on the controller rather than on the
  transcript was affected — the model override and the line reporting what the
  server actually did with a change. It looked fine wherever the runtime emitted
  an event in the same moment, which is why switching a model looked right and
  clearing one left the previous answer frozen on screen.

### Added
- **Every conversation, by project, in a searchable list — and closing one no
  longer ends it** (#127). Nothing in the app answered "what conversations do I
  have?". Every conversation ever started came back as an open tab, so the strip
  grew until it was unreadable, and the only way to shorten it was to close a
  tab — which deleted the conversation. Nothing in the app could reach it again
  afterwards, however much you might have wanted to pick it up next week.

  The one list of past conversations was inside the launcher, and it is reachable
  only on the way to starting a *new* session in a folder that has already been
  chosen: you had to know which project a conversation belonged to before you
  could look for it, you saw the most recent handful for that folder alone, and
  there was nothing to type into. Search, meanwhile, only ever looked inside the
  conversation on screen. So the two questions people actually ask — where the
  conversation about the release script went, and whether yesterday's closed one
  is recoverable — had no answer.

  **Closing a conversation now means what the word means.** The tab goes; the
  record, the transcript, whatever is running and whatever shells were opened
  inside it all stay. Closing a *terminal* still ends it, and that is not an
  oversight: a pty is reached through its tab and nowhere else, so one closed
  without being ended is a shell holding a working directory open that nothing in
  the app could ever reach again — the very failure this removes for
  conversations, in the one place it would create. Deleting is unchanged: still a
  separate action, still confirmed, and now the only way to lose a conversation.
  A closed conversation is remembered as closed in the browser, because the strip
  is rebuilt from the session list on every page load — without that, closing
  would have lasted until the next reload and the strip would still grow forever.

  **The list is reached from the top of the chat surface, beside the transcript
  search**, and on a phone from the actions sheet, which is where that search
  lives there. It shows every conversation the signed-in user owns — not only the
  ones with a tab open, and not only the ones still running — grouped under the
  project folder each belongs to, newest first inside a group, with the groups
  themselves ordered by their own newest conversation. So the folder you were
  working in this morning is at the top, whichever folder that is.

  A row is **what was asked**, not when it happened: "che file ho caricato?"
  identifies a conversation on sight, where "Session 25/07/2026, 21:35"
  identifies nothing — which is the whole reason a column of timestamps was never
  worth showing. Beside it: the agent it ran, when it was last active, whether it
  is running right now, whether it comes back with approvals bypassed, and
  whether its agent can carry on from where it left off or is meeting the
  transcript for the first time. That last one is said **before** the choice is
  made, exactly as the launcher's resume list already does, because the two are
  very different things to walk into.

  Typing narrows the list on what was asked, the conversation's name and the
  folder it lives in, and a group with no match drops out entirely — so a search
  across a dozen projects reads as a short list rather than a page of empty folder
  headings. Groups fold; searching opens them all, because a match hidden inside a
  folded group is a search that answered nothing. Picking a conversation joins it
  if something is running it, and otherwise brings it back with its transcript,
  handing the agent its own context where the conversation recorded one.

  Two things the implementation is careful about. The opening line of a
  conversation is read from the head of its log, and a log is append-only — so
  once found it cannot change, and the answer is kept rather than re-read on every
  look. The two operations that genuinely rewrite a log's head, a `/clear` and a
  retention trim, drop it; otherwise listing three hundred conversations would
  cost three hundred bounded reads every time the list opened rather than once.
  And those reads run a few at a time: four hundred logs, indexes and stats opened
  at one instant is how a listing turns into `EMFILE`, which fails not just the
  request but whatever else the server was doing. Past four hundred conversations
  the list describes the most recent ones and *says* it stopped there — a list
  that silently ends at a ceiling reads as "this is everything", which is the one
  thing it must not say when the question is where a conversation went.

  Also fixed along the way, in a shared primitive the list happened to expose:
  a text field's touch target was the frame around it rather than the field. The
  wrapper took the 44px floor and `align-items: center` left the input itself at
  its content height — 22px inside a 44px box — so a tap in the top or bottom
  quarter of what looks like the field focused nothing. Every phone-width text
  field in the app is affected.

- **A workflow shows the whole shape of the run** (#117). A workflow is a
  structure — named phases in order, and several agents working at once inside
  each — and none of that reached the screen. Opening one showed a single line
  of text: the one thing the run last narrated about itself. That line is
  genuinely useful and it is still there, but it can only ever describe one
  agent, so watching a run with eight in flight meant watching seven of them be
  invisible. This is the half of #45 that was left unwired for want of a
  recorded run.

  The run has been reporting all of it the whole time. `task_progress` carries a
  complete snapshot of every phase and every agent — label, phase, state, model,
  last tool, tokens, tool calls, duration, and a preview of what it returned —
  and the app was keeping the one-line summary out of all of it. It is forwarded
  now, and the popup lists the phases in order with their own state, the agents
  inside each with theirs and what each one is doing, and counts across the top:
  how many are running, queued, done and failed, out of how many, and which
  phase the run is in. A failed agent is red on its own row with the failure
  spelled out, without anything being opened. Opening one gives the rest — what
  it was asked, what it cost, what it came back with. Everything moves as the
  run moves, with no reopening. The Agents list says how many agents a workflow
  holds and how many are still going, so a workflow no longer reads as the same
  kind of row as a single subagent.

  Two things a hand-written example would have got wrong, and a real recording
  did not: the structure is **absent** from four of every ten progress reports
  rather than empty, so a report that carries none now leaves the panel standing
  instead of blanking it; and a run started from an inline script names itself
  nowhere in its own tool call, which is why every workflow popup used to be
  titled "Workflow". Both come from
  `test/fixtures/chat/claude-workflow.jsonl` — a real two-phase, five-agent run
  captured off the wire, one agent of which fails — which is what every test and
  browser check here is driven by, rather than by a shape that would only have
  agreed with the code under it.

  Phase state is derived from the agents rather than read from the tool call, on
  purpose: the Workflow tool returns the moment a run is launched (#116, still
  open), so a workflow whose agents are working sits under a completed call.
  Reading the agents means this view is right either way. A runtime that reports
  no structure at all still gets the single-line view it has always had.

- **A conversation tells you when it has finished, or when it is waiting for
  you** (#93). Terminal sessions have been notifying for some time, and what
  they do there is guesswork: nothing has been printed for ninety seconds, or a
  line went past that looked like the end of something. A conversation never has
  to guess. It knows when a turn ended and which word the runtime ended it with,
  and it knows the difference between working and stopped — so notifications now
  come from the events themselves, for work that **finished**, a turn that
  **failed**, and the two that cost real time: an agent that has stopped for an
  **approval** or a **question** and will do nothing at all until it is answered.

  Reading the endings rather than the states is the whole of it. Claude, every
  ACP agent — Grok Build, Kimi Code, Oh My Pi — and codex in app-server mode
  emit no state at all when a turn ends, and codex never announces
  `awaiting_permission` either, only the request that caused it. A watcher built
  on the state stream would have been silent for most of the agents this app
  supports; the tab strip's own dot had that bug and has it no longer, which is
  why a background conversation used to stay green after it had finished.

  Acting on a notification opens that conversation — bringing the window
  forward, or starting one if the app is closed. The conversation on screen is
  never announced, where "on screen" means its tab is showing *and* the window
  has focus: a visible window sitting behind an editor is precisely the case
  this exists for, and the terminal notifications suppress themselves for it to
  this day. Several conversations do not become several notifications to dismiss
  one by one — there is one at a time, and a second conversation turns it into a
  summary of both.

  They are shown through the service worker rather than by the page, because the
  page's own constructor throws outright on Android Chrome — the phone this is
  most useful on would otherwise have got nothing. Where notifications are
  refused, unsupported, or never allowed, a waiting conversation is still marked
  in the tab strip and in the phone's session sheet, in its own colour *and* in
  words, and that mark lasts as long as the wait does: unlike the unread dot it
  is not cleared by glancing at the tab, and it clears itself when the approval
  is answered, from wherever it was answered.

  **Settings → Conversation notifications** switches off any of the four events
  or all of them, and remembers. The browser's own permission is asked from that
  switch and nowhere else: asking on page load is refused outright by Firefox
  and Safari, and once refused nothing in the page can ask again. **What
  notifications say** reduces them to "a conversation needs you" — they are read
  on lock screens and on shared devices, outside the boundary that signing in
  protects, so how much leaves the app is the user's choice and not this app's.

- **A turn can be branched into a conversation of its own.** The button was
  promised in 5.1.2 beside copy-a-turn and never built — the changelog said it
  had shipped, and the control existed in no state at all, folded or open, on
  any screen size. It is there now, on every turn's header, and pressing it
  opens a **new conversation in a new tab** that carries the history up to and
  including that turn.

  Not a fork in the runtime's sense, because no runtime here has one: not one of
  the six CLIs can split a session at a point, every adapter says so, and none
  of them has been made to claim otherwise. What happens instead is two things
  this app can do for itself. The transcript up to that turn is copied into the
  new conversation's own log, so the history is there to read. And the same
  history is handed to the agent as the opening context of its first turn, so
  the first thing you ask is answered by something that knows what came before —
  a branch that only copied the transcript would leave you talking to an agent
  reading over your shoulder.

  What the agent is sent is a rendition and says so in its own opening words: it
  is told plainly that this is a record of a conversation it was not in, that
  nothing in it was said by it here, and that tool output and reasoning are not
  carried. It arrives *with* your first message rather than as a turn of its
  own, so the conversation on screen opens with your words and not with a wall
  of quoted history standing in as though you had typed it. A rule across the
  transcript marks where the carried history ends and this conversation begins.

  **When the history does not fit the model's window, the branch is refused
  rather than trimmed.** The reply names what it would have carried, what the
  window is, and what that leaves — enough to branch from an earlier turn
  instead. Where the runtime has never reported a window size, nothing is
  measured and you are told that nothing was measured, in the notice and in the
  transcript both; guessing at a ceiling would be the more confident answer and
  the wrong one.

  The conversation branched from is not touched — not one event — and goes on
  running in its own tab. The branch opens in the same directory on the same
  agent and carries the model and effort level that conversation was using. It
  does not carry a bypass of tool approvals: that is a standing permission
  granted to the conversation that asked for it.

- **How hard the agent thinks, as a control in the composer.** Every runtime the
  WebUI drives has a reasoning-effort setting and there was no way to reach any
  of them: the conversation ran at whatever the CLI considered normal, and the
  only way to change that was to close the tab and start the agent by hand in a
  terminal. There is now a button beside the model, and it offers **exactly what
  the runtime you are talking to published, in that runtime's own words** —
  Claude's `low` through `max` and its undocumented `ultracode`, Codex's ladder
  for the model actually in use as far as `ultra`, Grok's per-model levels,
  Kimi's `off`/`on`, Oh My Pi's `auto`, pi's seven. Nothing is translated between
  them and no level is invented.

  Each road was probed against the installed CLI rather than written from a
  schema, and two of them turned out not to be where they looked. Grok's
  `--reasoning-effort` flag does nothing on the protocol this app drives it over
  — launching at `low` and at `high` both left it reporting `high` — and the
  setting actually travels on a model change. Claude has no control request for
  it at all, but answers `/effort` as an ordinary turn, for free: no model call,
  no money, and its own sentence back confirming the level. That confirmation is
  what the button waits for, so the chip reports what the agent said it is doing
  rather than what this app asked for. Where a runtime cannot be told until its
  next turn, it says so instead of claiming otherwise.

  The level is coloured on a scale — the same grey as every other control at the
  bottom of a ladder, and the loudest thing on the row at the top, with a pulse
  that quickens as it climbs. Maximum effort is the most expensive setting
  available and a control that looked identical at both ends would hide that.
  Colour is never the only carrier: the level is named, and a small meter fills
  in proportion to where it sits on its own runtime's ladder, which is the only
  honest way to put Kimi's `on` beside Claude's `xhigh`. Reduced motion turns
  the pulse off and loses nothing.

  Where a runtime publishes no ladder — Grok on its default model — no button
  appears at all, rather than one that could only refuse. That is the one way
  this differs from the model picker beside it, and the reason is pi: an
  unrecognised level there is not an error, it is a warning on a stream nobody
  reads followed by an answer at the default level, which would leave the
  control reporting something that was never running.

  What the conversation is running at is kept with the conversation, so it
  survives a reload, a rejoin and a `/clear`. What to open the *next*
  conversation at is kept per runtime in the browser, because the ladders are
  not comparable and one remembered setting spread across all six would be
  wrong five times — and a remembered level only ever opens a conversation that
  has not started, never one you have merely gone back to look at.

  Two of the runtimes do not refuse a level they do not have; they warn on a
  stream nobody reads and answer at their own default, which is the quietest
  possible way to get the opposite of what was asked for. So a level is checked
  against what the runtime published at every point it could enter — the button,
  a `/effort` typed by hand, a record carried over from when the conversation ran
  on another agent — and Claude's own answer is read back rather than assumed,
  because it reports a refusal as a *successful* result whose text happens to
  say no.

- **What each turn cost, beside the turn.** The conversation showed what the
  whole chat had spent and nothing about where it went — so the expensive turn
  and the cheap one looked identical, and the only way to find out which was
  which was to leave the conversation for the statistics page. Every row of the
  turn index now carries its own figure, and so does the strip over the turn
  itself.

  It is the accounting's figure, not a second calculation of it: the money can't
  be added up from the messages on screen, because half the runtimes report a
  running total rather than a per-turn one, and turning that into "what this
  turn cost" means differencing it against where the turn began. Taking it from
  the row the accountant filed is also the only way the number beside a turn and
  the number on the dashboard can be relied on to agree. It appears the moment a
  turn ends rather than on the next reload.

  A turn nobody could price — one still running, or a runtime that reports no
  money at all — shows nothing rather than `$0.00`, and a turn that cost less
  than a cent keeps four decimals instead of being rounded away to nothing.

  The strip over a turn also stopped letting a long prompt crowd its figures
  out. Everything to the right of the label is a measurement, and a measurement
  cut in half — `16 too…`, `9 rea…` — is not one; so the prompt is now the only
  thing on the bar that gives its width up, cut to whatever room is left with
  the whole of it on hover.

- **The turn count is a real measurement of the work, and every surface agrees
  about it.** (#86) The word meant two different things at once. In a
  conversation a turn was something you asked for and everything the agent did
  about it; in the statistics it was how many separate pieces the agent's answer
  happened to arrive in — which depends on the agent's writing style, not on the
  work. The same job filed 1 under an agent that answers in one stretch and 6
  under one that separates its thinking from its answer, and that figure was the
  headline number, appeared in every breakdown by project, agent and model, and
  drove the averages and the distribution chart that exist specifically to
  compare agents against each other.

  A turn is now **one user request and everything the agent did about it**,
  defined in one place and read by every surface. Nothing had to be recounted:
  the accounting was already recording exactly that unit under the name "job",
  so the corrected figure is the number of rows, every row ever written is
  already one prompt, and older periods stay directly comparable.

  What a message typed while the agent is working belongs to is now decided
  where the work runs and recorded with it, because it cannot be reconstructed
  afterwards: pushed into the running turn to redirect it, it continues that
  turn; left in the queue until the turn finishes, it is a turn of its own. The
  conversation groups on the same recorded turn, so a runtime that echoes your
  prompt back under an id of its own — codex and the ACP agents both do — no
  longer shows twice the turns that were actually recorded.

  Round trips to the model survive as **model turns**, under their own name and
  their own column, and only where a runtime counts its own: Claude's
  `num_turns` was being discarded in favour of the derived figure and is now the
  figure. Everywhere else it reads **"not reported"** rather than a number
  somebody inferred, and the effort averages are taken over the turns that
  reported one — reading a silent runtime as zero would have put it at the top
  of every efficiency comparison on the page for having said nothing at all.

- **A request and its answer are one turn, in conversations already recorded as
  much as in new ones.** (#86) No adapter reuses the id this app mints: the
  session stamps the user's message `turn-<uuid>` and the runtime answers under
  a name of its own, with codex and the ACP agents echoing the prompt back under
  that name first. Read literally, that splits every single turn in two — the
  ask in one, the answer in another with no prompt to name it by, which is why
  an index row could read "no prompt" next to a question that had been asked
  perfectly clearly. Checked against all 69 conversations on the machine this
  was written on: 33 of them read differently, 147 phantom turns in total, and
  all 69 now agree with what the conversation shows.

  Nothing needed migrating and nothing had been recorded wrongly. The events
  were always right; it was the reading of them that split a request from its
  answer, and the index is read from the log every time it is asked for — so an
  old conversation is simply re-read under the settled rule. A turn is open from
  the user's message until the runtime ends it, and everything in between
  belongs to it.

- **A turn is numbered by the conversation, not by what the browser has
  loaded.** (#86) Reloading a page landed on the last turn of a long
  conversation and called it "Turn 1", and it stayed 1 until enough history had
  been paged back in for the count to come right by accident — so the number on
  screen was a fact about the loading window rather than about the work. It now
  reads 49 of 49 on the first paint, and counts back to 48, 47 as older turns
  arrive. A turn the reload landed *inside* — its opening ask not in the window
  at all — is named from the recording too, instead of reading "no prompt"
  beside a question that was asked perfectly clearly and is still on file.

- **The turn list runs newest first.** (#86) The turn you are looking for is
  almost always the one that just happened, and it was at the bottom — so in a
  long conversation you scrolled to the end of the index to reach the thing
  already on screen. Only the order changed: a turn keeps the number the
  conversation gave it, so the list opens on 49 and counts down. Arrow keys,
  Home and End follow what is drawn, so "down" is down the list.

- **The turn index lists the whole conversation, and every entry is named after
  what you asked.** (#86) It was assembled from whatever the browser happened to
  be holding, so a long conversation's index quietly started part way through —
  the one case where an index is the only practical way to navigate. It is now
  served from the recorded conversation, lists every turn from the first one,
  and selecting an older entry fetches it and takes you there. Entries are
  titled with the user's own prompt: an entry could previously end up carrying
  model output, whatever text the turn happened to offer first, which made the
  index unsearchable by the only thing anybody remembers — what they asked. A
  turn with no prompt behind it now says so rather than borrowing a line from
  the model.

- **Every conversation shows how full the model's context is, against that
  model's real capacity.** (#82) The reading was only there where a runtime
  happened to volunteer it, and where it was missing there was nothing at all —
  a raw token count with no ceiling to read it against, on agents used here
  every day. The ceiling is the part that cannot be guessed: it differs by a
  factor of five between models, and a bar drawn against an assumed number is
  worse than no bar, because it invites you to keep going up to a limit that is
  not there.

  Nothing in the product now records how large any model is. Capacity comes
  first from the agent, which is the most authoritative source there is — Claude
  publishes it in `modelUsage`, Codex in `modelContextWindow`, Oh My Pi in its
  usage updates, and Grok Build one per model in its handshake. For the two that
  report none, pi and Kimi Code, the model's provider is asked instead: both
  name an OpenRouter model id, so the catalogue they are already served from
  answers for them, matched on the exact id and never on a neighbouring name.
  That ordering is not academic — Grok reports 512,000 tokens for `grok-build`
  where the nearest catalogue entry says 256,000, half the truth. Where neither
  can answer, the display says **"size unknown"** and draws no bar, the same way
  the product already tells "not reported" apart from a real zero.

  How full it is now comes from the *last* request rather than the turn's
  totals. A three-round-trip turn measured while building this spent 105,027
  tokens across its requests while only 37,387 were ever in the window at once —
  the old reading would have shown 10.5% full where the truth was 3.7%.
  Switching model mid-conversation discards everything known about the previous
  one, so a move to a smaller model reads against the smaller ceiling
  immediately instead of carrying the old one forward. Past 80% the panel says
  so and says how much is left; past 90% it says it more plainly, while there is
  still room to compact or start fresh.

- **A message waiting in line can be sent now, instead of only waiting its
  turn.** (#70) The composer never refuses a message while the agent works — it
  queues it — but queuing was the *only* thing that could happen to it. Some
  messages are worth waiting their turn; others are the reason you are typing at
  all: "stop, you're editing the wrong file", "no, use the staging database".
  Those sat in the queue doing nothing while the agent spent another two minutes
  going the wrong way, because the only way to get in front of a working agent
  was the stop button — and stopping discards everything else you had queued, so
  correcting one thing cost you the two messages already lined up.

  Each waiting message now carries a second control, beside the one that removes
  it, that sends it immediately: the turn in flight is cut short, that message is
  handed over as a real turn of its own, and **the rest of the line survives** —
  still waiting, still in the order it was typed, delivered afterwards as usual.
  Nothing about the default changes: a message sent while the agent is busy still
  queues.

  The conversation says what happened. A turn cut short this way leaves a marker
  across the transcript naming the message that did it, so the record does not
  read as an agent that simply stopped, and a reader coming back later can see
  why the answer above is half an answer. Anything the interrupted turn was
  waiting on — an approval, a question — is cleared rather than left on screen
  inviting an answer that can no longer reach anything.

  The control is offered only where it can do something. Not on an idle agent,
  which is already working through the line; not on `codex exec`, the one
  supported runtime that cannot be interrupted at all, where cutting in would
  hand the process a second turn rather than replacing the first. It *is*
  offered while the agent waits on a person, which is exactly when a correction
  gets typed. Pressing it twice sends once, a press that arrives after the
  message has already gone is a no-op rather than a second delivery, and a
  second browser open on the same conversation sees the line change.

- **A queue of more than one message collapses to a single row, openable to
  inspect.** (#79) Every waiting message was drawn as its own full-width row and
  the list simply grew — so lining up a run of work, which is what the queue is
  for, pushed the conversation off the top of the screen. On a phone it pushed
  the composer off the bottom: with up to twenty messages queued the input and
  the send control were unreachable and the agent's work invisible, which is not
  a corner case but what the queue does when used as intended.

  Past one message the line now shows the message you added last — the one you
  are still deciding about — with a count of the rest beside it, so twenty
  waiting messages take the room of one. The count opens to the full list in
  order and closes again, and the opened list scrolls inside its own bounded
  space rather than growing into the conversation. Opening lands on the row you
  were already looking at, so the list appears to grow upwards out of it instead
  of leaving you at the top of twenty with the way back off screen.

  Everything a waiting message offers — removing it, and sending it now — is
  offered on the rows on screen in either state. The list stays as you left it
  while messages arrive and drain, opening or closing on nothing but your own
  press, and returns to the plain single row by itself once one message is left.
  The number waiting is announced to a screen reader as it changes rather than
  only drawn on a button, and every part of it is reachable by keyboard and
  sized for a finger.

### Changed
- **The pointer into a turn's hidden work is a counter, not a banner** (#118).
  Every assistant reply that ran a command or thought about anything carried a
  full-width button under its text spelling out what had happened — "3 commands
  · 2 reasoning · 12s — show work". It was wider and louder than the message
  controls beside it, it repeated in a sentence what two icons say, and it cost
  a line of the conversation on nearly every turn, so a long exchange read as a
  stack of banners with prose between them.

  The pointer moved into the row of per-message actions, directly right of
  retry: a terminal glyph with the number of commands and a brain with the
  number of reasoning steps. A count of zero is left out entirely, so a turn
  that only thought shows a brain and nothing else. It appears on exactly the
  turns the button appeared on — including a reply that speaks for the silent
  steps before it, which still counts the whole stretch and still opens the
  trace at the *first* of them rather than at its own call. Turning off the
  display of reasoning or of commands still takes those steps out of the count,
  and takes the control away when nothing is left to point at.

  The elapsed time the wide button reported has no room in two glyphs, so it
  survives where the words it dropped went: the control's hover and its
  accessible description read "Show work: 3 commands, 2 reasoning steps, 12s",
  which is also what answers the icons for anyone who cannot see them. On a
  phone it is a full 44px target on the same line as copy, retry and branch.

  It is quiet but not faded. The actions either side of it sit at reduced
  opacity at rest, which is right for a glyph that stands for a verb and is
  recognised rather than read; a two-digit number at the same treatment
  composites too close to the background to resolve, and the button it replaces
  never dimmed its counts. So the counter takes the muted colour and none of
  the fade. The browser checks now assert that it is painted at all, that both
  its glyphs are drawn, and that it is in the tab order — each of which a
  plausible regression had been able to break with the whole suite still green.

- **Folded history is not built until it is opened, and what is kept is
  bounded.** (#81) Entering a conversation rebuilt its entire backlog at once —
  text, code blocks, diagrams, tool output and file previews all at the same
  moment — which showed as a visible stutter, content popping in and the view
  shifting under the pointer before the chat settled. It got worse the longer
  the conversation was, and it was paid on every entry rather than the first,
  because the chat surface is remounted per session. Almost all of that work
  was wasted: every turn but the newest is folded shut, so what was being built
  was not on screen. The old code rendered every turn and then hid the folded
  ones.

  A folded turn is now not built at all. Forty turns of history mount the two
  message bubbles of the turn on screen rather than eighty, and cost a strip
  and an index row each — twenty-eight DOM nodes, the same whether the turn
  behind them holds two thousand characters or sixty thousand. Nothing is
  hidden by it: every turn keeps its strip and its index row, opens on a click,
  and opens on a jump from the turn index or from search.

  What has been opened is kept, so re-folding and re-opening is immediate
  rather than a second rebuild — the behaviour hiding-rather-than-unmounting
  used to buy, kept deliberately. What is kept is bounded by the *content* it
  holds rather than by a count of turns, since a conversation of one-line
  exchanges and one full of large files are nothing alike at the same turn
  count; past the bound the least recently opened material is released and
  built again on demand, so a long conversation cannot grow the browser's
  memory use without end.

  The turn in progress is exempt: it is prepared whether folded or open, and a
  turn that kept running while folded opens on its real current state rather
  than a snapshot, because a bubble reads its message off the transcript when
  it mounts.

- **Usage is accounted per chat tab: one entry per conversation, not one per
  request.** (#88) Statistics filed one row per request, so a morning's work in
  a single tab landed as dozens of fragments, none of them answerable on its
  own, and reading what a conversation cost meant adding rows up by hand.
  Clearing the conversation or starting a new one in the same tab made it
  worse: everything before the reset was accounted as if it belonged to
  somewhere else, splitting the one total anybody actually wanted.

  The history now lists conversations. Everything spent in a tab sums into one
  entry, for as long as the tab exists — across compaction, clearing, starting
  fresh, closing and reopening the tab, and a server restart. Each entry says
  enough to recognise the work without opening it: its name, the project, the
  agent, when it started and when it was last active. A conversation that
  changed agent or model half way through is listed as having used both rather
  than being filed under one of them. The requests are still there one level
  down — open a conversation for its own, or take the Requests view to browse
  them across conversations.

  Nothing was migrated and no earlier period is counted differently: the tab's
  id has been on every recorded row since the table existed, so this gathers the
  whole history rather than dividing it. The headline totals and the
  project/agent/model breakdowns go on summing jobs, which is the same rows
  grouped another way, so they agree with the conversation entries by
  construction. The list underneath now also covers the same range as the
  figures above it, which it previously did not.

### Fixed
- **A slash command Claude answers itself left no answer on screen.** Anything
  the model produces arrives token by token, and this app builds the message
  from those tokens and uses the complete copy that follows only to fill in
  details. A command the CLI handles without going near the model — `/effort`,
  `/model` — has no tokens: it sends the finished reply and nothing else. There
  was no message for that copy to fill in, so it was dropped, and typing one of
  those commands produced a turn, a `$0`, and silence where the confirmation
  should have been. The reply is now built into a message of its own, but only
  for a turn in which nothing streamed at all — which is what stops an ordinary
  answer being written into the transcript twice.

- **The feedback under the model picker never went away.** It stayed until the
  conversation was reset, so a second answer landed on top of the first; on a
  phone, where both bubbles resolve against the composer rather than their own
  chip, they shared coordinates exactly and the older one was invisible
  underneath. It now clears itself after long enough to read, and on a phone it
  opens upward rather than down over the navigation bar.

- **The turn index and every per-turn cost were being thrown away before they
  reached the screen.** The chat layer routes server messages by a list of the
  types it owns, and that list had fallen three behind the messages the chat
  controller actually answers: the recorded turn index, a turn's filed spend,
  and the result of a model change. A type missing from it is not merely
  unhandled — it goes to the terminal's handler, which has no idea what a chat
  message is, and it is dropped in silence.

  So the conversation numbered its turns by the browser's window instead of by
  the recording — "turn 1" for turn 40, and no prompt to name a half-loaded turn
  by — and no turn ever showed what it cost, however carefully the server filed
  and announced it. Both figures were correct at every step but the last one.
  The list is now the controller's own, kept beside the switch it mirrors, with
  a test that fails if the two drift apart again.

- **`/clear` now really does end the conversation.** It emptied the window and
  started a new agent process, which was the half you could see — but the
  conversation it replaced was still on the log, so reloading the page brought
  the whole of it straight back. Worse without touching anything: a freshly
  cleared pane is too short to scroll, so the browser asked for the page above
  it unprompted and pulled the old conversation in on its own.

  Clearing now cuts the log at the line it draws: the conversation begins where
  the clear happened, so a reload opens on the new conversation, there is no
  older page to fetch, and the turn index lists the new turns alone. This is a
  delete, deliberately — "start again" is a promise about what is left behind,
  not a view over it. What each turn cost is recorded separately and is not
  touched, so the statistics page still shows the spend of the conversation you
  cleared.

  The figures over the chat go back to nothing with it: `$0.00`, `0 tok` and an
  empty context bar. They are statements about the conversation on screen, and
  the new one used to open carrying the last one's bill — under a bar reading
  80% full of a window that was now empty, which is the reading people clear in
  order to fix. Zeroed rather than blanked, because a header that empties looks
  like a readout that broke instead of one that reset, and no figure is invented
  for a runtime that reports none.

- **An agent that picks its own work back up stays in the turn it was working
  on — and what that work costs is finally counted.** (#86) An agent that leaves
  something running in the background — a build, a check, a job it is waiting on
  — ends its turn and starts again by itself when the thing it was waiting for
  finishes. Nobody asked a second question, but a second turn appeared anyway:
  numbered on its own, with no prompt in it to name it by, while the agent was
  visibly still working on what you had asked a moment earlier.

  Only a request opens a turn now. Work with nothing asked in front of it
  continues the turn it belongs to, which is the definition #86 settled and is
  what the conversation on screen already looked like.

  The same fault was quietly costing far more than a row in an index. A job in
  the accounting is opened by the user's message — so work that had none was
  filed **nowhere at all**, and everything it spent was dropped. On the
  conversation this was found in that was **$23 of $40, more than half**, and it
  was missing from the totals, from every breakdown by project, agent and model,
  and from the effort comparisons. Those stretches are now filed against the
  request that caused them, and a conversation's recorded spend adds up to
  exactly what its log reports.

- **A turn stops spinning when the work is done, and the index says what was
  asked instead of "no prompt".** (#86) Reopening or reloading a long
  conversation gave you a turn list with an extra row on it: numbered on its
  own, titled **"no prompt"**, and turning its working spinner over a chat that
  had finished minutes earlier.

  What a browser is given is the *tail* of a conversation, and a tail routinely
  starts in the middle of a turn — the question that opened it is simply not in
  the window. Replayed from a standing start, the first message in the window
  opened a turn of its own under the runtime's private name for it. That name is
  one the recorded conversation has never used, so the row could not be matched
  against the recording that still holds the question, and nothing could repair
  the title. The same thing happened again a message at a time as you scrolled
  back through history, and once more the moment a browser joined a turn already
  in progress. Which turn is open is now told to the replay rather than guessed
  by it, at every edge: a half-loaded turn is filed under the turn it belongs to,
  carries the number the conversation gave it, and is titled with what was
  actually asked.

  The spinner was a second fault behind the same symptom. A message carries a
  "still streaming" flag that only an event can clear, and those events go
  missing in ordinary ways — a window cut before the end of a message, a
  reconnect, a runtime that dropped one. A turn read off that flag alone spun
  forever. The session's own state decides now: when the session says it is
  idle, the turn that was running has finished, whatever a stale flag says.

- **Correcting the agent mid-turn stays in that turn, question and all.** (#86)
  Sending a message ahead of the queue interrupts whatever is running, and every
  runtime answers an interrupt by ending its own run. That acknowledgement was
  being read as the turn ending — so the correction was recorded into a turn
  that closed a moment later, and everything the agent then did about it arrived
  in a fresh turn with nobody's question in it. That is where most of the "no
  prompt" rows came from.

  The runtime letting go of work it was told to abandon is now recorded as
  exactly that, and the turn stays open across it: the correction, the work it
  redirected and what both halves cost are one turn, which is what the number
  beside the conversation has meant since #86. A message that simply waited its
  place in the queue is unaffected — it is delivered after the turn ends and is
  a turn of its own. Conversations already recorded are read back with the
  stranded question restored to the work it produced.

- **What a conversation has cost stops falling while you are still in it.** The
  figure was never stored: it was re-added up from the log each time a browser
  asked for the conversation, and what a browser is given is the *tail* of it —
  the last forty messages, which is the right amount of transcript to open and
  the wrong basis for a total. Claude reports the money at the end of a turn, so
  every turn older than that window was not merely excluded, it was never read
  from disk. The number the meter showed was therefore the cost of the recent
  part of the conversation, and it was re-derived — and dropped — on every
  reconnect, tab switch and reload. Nothing about it looked like an event you
  could point at, which is why it read as resetting at random; scrolling back
  through the history did not restore it either.

  A conversation's spend is now read from the whole conversation, the way its
  turn index already is: it is a property of what was recorded, so nothing that
  happens to be in a browser's window may decide it. One streamed pass of the
  log per conversation, and every event after it keeps the total current, so a
  rejoin costs no more than it did. There is one honest limit, unchanged: a log
  long enough to have had its head trimmed cannot say what the trimmed turns
  cost.

  Separately, on the ACP runtimes — grok, qwen, kimi, gemini — a report that
  carried the context window and no money **erased the money already spent**.
  Those runtimes report running totals, whose fields replace rather than sum,
  and the absent cost was being sent as an explicit "no value" rather than left
  out. A report now states only what it actually measured.

- **Clearing a conversation starts a new one in the same tab, and is a button
  on the composer.** (#69) `/clear`, `/new` and `/reset` did give the agent a
  genuinely fresh memory, and left the tab looking closed: the process being
  replaced is signalled and not waited for, so its own "I have exited" landed
  *after* the replacement was already answering. The conversation you were
  sitting in went read-only, every session list called it finished, and the
  recovery offer — the one meant for an agent that really has gone away — was
  what you were left looking at. The way out was a new tab, which left the old
  one behind as a stale entry and lost its name, its place in the strip and the
  folder it was pointed at.

  A conversation now knows which process is speaking for it, and a superseded
  one is not heard from again; the session record is told it is running rather
  than left claiming a process that is gone. Clearing also acts at once when
  the agent is mid-answer instead of queueing behind the turn it was meant to
  cut short, and a message typed while the new process is still starting waits
  for it rather than being refused as a dead session.

  Starting a new conversation is also a **New chat** button in the composer,
  next to the attach and command controls — available whenever the conversation
  is healthy, which is exactly when the old "start a new chat" button was not:
  it lived in the recovery notice and appeared only once the session had
  already failed. The button, the three spellings and the menu entry are one
  behaviour: the button sends the same command. Nothing is deleted — the
  previous conversation stays in the log for history, search and export.

- **The historical dashboard shows the tokens a job used, instead of "not
  reported" for work whose tokens were on screen the whole time it ran.**
  (#80) A job's token figure was whatever the runtime volunteered as a
  pre-summed total — and Claude, the agent most people here run most, sends its
  four buckets on every message and a total on none of them. So its rows read
  "not reported" beside a cost that reported fine, and every figure built on
  the column — the headline total, the breakdowns by project, agent and model,
  the trend — silently skipped them. Anyone comparing agents or projects by
  token consumption was comparing whichever handful of jobs happened to
  survive.

  A job's total is now derived when the runtime gives none, from the parts it
  does give: the input, the output and the two cache buckets. Reasoning tokens
  are deliberately left out — they are a slice of the output rather than an
  addition to it — and a total the runtime did report is always used as it
  stands, which is what keeps runtimes that count their cached input *inside*
  their input from being billed for it twice. Both rules are read off what the
  agents actually send rather than assumed, and there is a regression test per
  agent, driven by captured wire logs, that compares what a job showed in chat
  against what it was filed as having consumed.

  **Existing history was corrected in place**, once, on the next start: the
  parts were always recorded, so nothing was estimated to get there and no
  period of the dashboard is built on a different rule from any other. Work
  from an agent that reported nothing still reads "not reported", and an agent
  that cannot report usage still reads as such — the two stay distinguishable.

- **Claude's tokens were counted twice, everywhere.** Found while checking the
  above. The `result` message that ends a Claude turn repeats the whole turn's
  token counts, which the turn's own messages had already reported, and
  everything downstream adds up what a turn reports — so the live meter, the
  composer's session line and the recorded history all showed double. Claude's
  cumulative *cost* was already corrected in the same adapter; its tokens now
  are too.

- **The composer's session line was leaving out the cache.** It added the input
  to the output and stopped, which on Claude is a rounding error against the
  real figure — 101 tokens where the meter beside it said 63.8k. Both readouts
  and the historical record now come from one function, so they cannot answer
  the same question three ways again.

- **A message typed ahead is never lost between one turn and the next.** (#89)
  Queued messages went missing, and did it in the worst way available: the
  message left the queue, appeared in the conversation as though it had been
  asked, and was never answered — with the rest of the line stuck behind it and
  the session still showing as working. It happened precisely when the queue is
  most useful, which is when nobody is watching.

  The cause was a handover a few milliseconds too early. Three of the five
  runtimes — pi, Grok Build and `codex exec` — run one process per turn and
  announce the turn's end on a line of output, while the process that wrote it
  is still exiting. The queue took that as its cue, and the adapter refused the
  message it was handed, after the message had already been written into the
  transcript.

  The adapter is now *asked* whether it can take a turn instead of being assumed
  able to, and nothing leaves the queue or reaches the conversation until it
  says yes — a wait of a millisecond or two, only for those runtimes, invisible
  in ordinary use. A message that still cannot be delivered is **kept**, with
  its text and the reason it did not go, on a row that offers **Try again**; the
  messages behind it wait rather than jumping it, since they were typed
  expecting it to have been asked. The same guarantee covers a message sent
  straight from the composer at that same moment, which took the identical
  race.

- **Every agent now reports the model it actually ran, and the picker offers
  the models it accepts.** (#75) A model name in a spend record is only worth
  having if the runtime said it, and two quite different claims were hiding
  behind one: the model this app *asked for* and the model that *ran*. Grok
  reported neither — its conversations showed no model at all, and every Grok
  job was filed against nothing, so the by-model view built to answer "what are
  we spending this on" had a nameless row absorbing the lot. Elsewhere the
  request was being shown where a measurement belonged, which is worse than a
  blank because it looks like a fact.

  Every supported agent was probed against its installed binary, and the answer
  turned out to be that all of them say so somewhere. Grok names its models at
  the end of a turn, in `modelUsage`, in the one place nothing was reading;
  Claude reports the same structure on the line that closes a turn; pi names
  the model on every message it sends. Those are now what the conversation
  shows and what the record files. A model that has only been requested is
  shown nowhere until the runtime confirms it. Claude's billing alias
  (`claude-opus-5[1m]`) is filed under the canonical name its messages carry,
  so the conversation and the usage view cannot disagree about what ran.

  A turn that ran on more than one model — a subagent, a fallback — is no
  longer recorded as though one model did all of it. The job still names the
  model that answered, and each model's own tokens, cost and round-trip count
  are kept beside it, visible on the job and folded into the by-model
  breakdown, which still adds up to exactly the headline total. Tool calls are
  left unattributed there on purpose: no runtime says which model asked for
  which tool. Claude's per-model cost is put on the same footing as the turn's
  own before it is stored, so a cumulative counter can never make the models in
  a turn cost more than the turn did. Filtering by a model now finds the work a
  subagent did on it, not only the turns it answered.

  Choosing a model is a menu wherever a runtime publishes one: Codex over its
  protocol, the ACP agents in their model select, and Grok and pi through the
  command each ships for it. Claude publishes nothing, so its picker keeps the
  typed field and says so. The field doubles as a filter — pi lists several
  hundred models — and a name that matches nothing listed can still be sent.

  Nothing already recorded is reclassified, and no model name appears anywhere
  that its agent did not report.

  While confirming this, one documented open question was settled: Grok's
  `total_cost_usd` is per-turn, not cumulative like Claude's. Two consecutive
  turns in one conversation reported $0.0134 and then $0.0039, where a
  cumulative counter would have said $0.0173. The app's existing treatment of
  it was right.

- **Grok Build shows what it actually does.** (#73) A conversation where Grok
  rewrote four files looked exactly like one where it thought hard and wrote a
  paragraph: the commands it ran and the files it edited never appeared as
  activity of their own, only as its own narration folded into its reasoning.
  You could not follow along, the record of the conversation had no account of
  what happened to your working folder, and the spend figures were wrong in a
  way nobody would suspect — tool counts read as zero for Grok next to agents
  where the same work was counted properly.

  The cause was not a mapping bug. Grok's headless mode has no tool channel at
  all: asked to read a file and run a command, it emitted eighty-three thought
  events, one line of text and a summary, while the file it wrote appeared on
  disk. So Grok is now driven over ACP (`grok agent stdio`), which reports the
  identical work as ordinary tool calls — with what each one touched and what
  came back. That is a row in the runtime table rather than a new adapter,
  since three other agents already speak the same protocol.

  Everything else about Grok improves with it: permission prompts instead of
  approve-everything-or-nothing, the model list published in the handshake
  instead of typed from memory, and interruption that leaves the session
  standing. **Conversations recorded before this still open** — Grok kept the
  record all along, and loading one replays even the tool calls its headless
  output was silent about.

  The other five agents were checked the same way rather than assumed correct,
  each against its own recorded output, and each shows, keeps and counts its
  tool activity properly. That per-agent answer is written down in
  `docs/runtimes.md`, and the tests behind it run every agent's real captured
  output through its real adapter, so an agent whose activity silently stops
  being captured fails the build.

  Two things the check turned up on the way. The launcher advertised
  `toolCalls` for Grok while the adapter it built said the opposite — the one
  place the app promises to be honest about capability said the wrong thing.
  And a skill installed in `.grok/skills` no longer disappears from the `/`
  menu when a runtime announces its own built-in commands.

- **Skills and project commands are in the `/` menu from the moment a
  conversation opens, not after the first message.** (#71) Typing `/` in a new
  chat listed a handful of the runtime's built-in commands and nothing else:
  everything installed on top — skills, and the commands a project or plugin
  brings — appeared only once a turn had run, because the app knows the
  built-ins independently and waited on the runtime for the rest. Anyone who
  knew a skill by name could still type it blind; anyone who did not had to
  send a throwaway message, watch the menu fill in, and start over. The
  composer's own button says it offers commands *and skills*, so the gap read
  as a broken promise.

  The menu now shows what the session can actually run, before a word is typed.
  Where a runtime can be asked up front it is, and what it says wins: the ACP
  agents (Kimi Code, Oh My Pi) volunteer their list as the session starts, and
  Claude Code's arrives with the first turn and **replaces** whatever stood in
  for it, entire — a fallback is a stand-in until the real answer arrives, never
  something merged into it. Where a runtime never reports one — Codex and pi —
  the menu lists what is installed for that session, read from the directories
  each runtime's own installer writes into, including enabled plugins for
  Claude. (Grok Build was in that group until #73 below moved it onto a
  protocol where it does report one.)

  Entries carry the description their author wrote in the skill's frontmatter,
  which also fills in the column for Claude, whose own list is names and nothing
  else. A skill whose author wrote no description is listed with none rather
  than with an invented sentence. Each session reads the home of the person it
  belongs to, so the menu never lists what someone else has installed, and a
  machine with no skills installed shows the built-ins exactly as before.

- **The file editor shows the file, in the file's own order.** (#77) Opening a
  file in the code view could give an editor whose lines were drawn in an order
  the file is not in — a run of lines from halfway down at the top, a block
  split across the view — with a bare white box, drag handle and all, over the
  first line. Everything was there and every line was coloured correctly, which
  is the worst version of it: the first thing anyone concludes is that the file
  on disk is broken.

  Neither the editor nor the file was at fault. The editor is a chunk fetched
  the first time a file is opened, and it arrives as two independent requests —
  a script and a stylesheet. The loader took the stylesheet on trust: it treated
  a `<link>` element being present as proof that it had loaded. So one failed
  CSS fetch — a moment with no route to the server, or the service restarting
  under an open page, both of which this app treats as routine — left a dead
  link in the page that every later open read as success. The editor was then
  built with none of its own rules: its lines lost the positioning that puts
  them where they belong, leaving the recycling order of the underlying elements
  as the order on screen, and its hidden input area became an ordinary resizable
  textarea drawn over line one.

  The loader now owns its stylesheet, discards a failed one so the next open
  genuinely fetches it again, and — before handing the editor over — asks the
  browser whether the rules are actually in effect. If they are not, the file
  opens in the app's own editor with the notice that already existed for a chunk
  that could not be fetched at all. A plainer editor that is correct beats a
  full one that shows your source in an order you did not write it in.

  The check that should have caught this exists now too. The browser checks ran
  from a `file://` page, where a chunk the app fetches by absolute path can
  never arrive — so every check around this editor could only ever confirm that
  its *parts* had been built. They are served over HTTP out of the real build
  now, and one of them opens a real file in the real editor and compares what is
  on the screen, line by line, against the file — in both themes.
- **A turn's badge says how the turn ended, and is right.** (#74) Turns were
  regularly marked failed when they had succeeded. The mark was never a verdict
  on the turn: a turn went red if *anything* inside it had gone wrong at any
  point — a search that found no matches, a test run that reported failures, a
  command that came back non-zero, a warning the agent read and moved past.
  Those are ordinary moments in a working turn, and for a coding agent they are
  most of the work, so the longer and more useful the turn the likelier it was
  to be marked failed. The badge stopped meaning anything, which cost the one
  thing it exists for: finding, in a long session, the turn that really did go
  wrong.

  The outcome now comes from the runtime's own word for how the turn concluded,
  which every one of them already sends and the app used to discard. A turn that
  finished and answered reads as done however many steps inside it errored, and
  the steps stay marked failed where the steps themselves are shown. Red is
  kept for a turn that did not complete: the agent stopped on an error it could
  not get past, the runtime went away mid-turn, or the turn ended with no
  answer. A turn the user interrupted reads as done — nothing went wrong — and
  so does one whose answer is the agent saying it could not do the thing, since
  anything else means reading what an answer meant. A word no runtime has used
  before reads as done rather than as a guess at failure.

  Each runtime says this differently — `end_turn`, `EndTurn`, `stop`,
  `completed`, or nothing at all for a good turn on pi — so the reading of it is
  covered per agent by tests over the conversations those agents really
  produced. A conversation reopened later shows every turn with the outcome it
  ended with, taken from the log it already recorded; nothing was migrated and
  nothing already recorded was reclassified. One thing fixed along the way: a
  turn left mid-stream by a runtime that died used to come back spinning
  forever, on a process that had ended hours before.

## [5.3.1] - 2026-07-27

### Added
- **Usage broken down per project, so spend can be tracked per piece of
  work.** (#65) Until now every figure was pooled across every codebase people
  happened to be working in, which answered "what did claude cost this week"
  and could not answer "what is this project costing us". Each recorded job now
  carries the project it ran in — the name of the session's working folder, the
  same label the session tab and header already show — and the dashboard has a
  by-project breakdown alongside by-agent and by-model, a project filter that
  narrows the whole view, a project column in the job history and job detail,
  and the project in the CSV and JSON export.

  Attribution is decided when a job is filed, so a session re-pointed at
  another folder leaves its earlier work attributed to where that work actually
  ran. Projects are grouped by folder name rather than by absolute path, so one
  project stays one project across machines and checkouts; the cost is that two
  same-named folders under different parents merge, which is stated in the docs
  rather than left to be discovered. Work recorded before this existed is shown
  under **unattributed** rather than being dropped from the totals or charged to
  a project nobody chose, and the existing visibility rules are unchanged — the
  project view is not a way around them, and the project filter menu names only
  projects the viewer may already see.

- **Unattributed work can be assigned to a project by hand.** Work recorded
  before its folder was tracked has no project, and there was no way to fix
  that — a backlog of "unattributed" that would never shrink. Any job can now be
  attributed from its detail view in the job history, and by default the whole
  conversation goes with it, since a conversation ran in one folder.

  What was *observed* stays observed: a project read off a running session
  cannot be overwritten, and no control is offered to try, because a
  measurement a person can edit is not a measurement. An attribution made by
  hand can be corrected or withdrawn, is labelled as hand-made on screen, and
  carries a `projectSource` of `manual` into the export — so a per-project total
  can be read for how much of it was recorded and how much was asserted. You
  can only attribute work you could already see; the installer can fix anyone's,
  everyone else only their own.

- **The dashboard charts are interactive.** (#66) They were pictures: the trend
  plotted cost and nothing else, the only way to read a bar was to hover a
  mouse over it — which does nothing at all on a phone or with a keyboard — and
  the breakdowns could be read but not acted on.

  The trend now plots whichever measure you pick (cost, tokens, jobs, turns,
  tool calls), and every point is a real control: reach it with a pointer, a
  finger or the Tab key and its period and exact figures appear above the
  chart, announced to a screen reader as well as drawn. Pressing a point
  narrows the entire dashboard to that slice of time and redraws the trend one
  level finer — a month becomes its days, a day becomes its hours — so a spike
  can be opened up rather than merely noticed. Pressing a breakdown row narrows
  to that project, agent, model or person, and selections combine. Whatever is
  selected is named on screen as chips that clear individually or all at once,
  the job history below is narrowed by the same selection so drilling into the
  jobs behind a total needs no filters re-entered by hand, and the export
  carries the selection too. Breakdowns sort by any column and show each row's
  share as a bar.

  The honesty rule survives into the charts: a bucket that reported nothing is
  drawn as a dashed stub rather than as a bar of height zero, because on a
  chart "nothing reported a cost here" and "this hour cost nothing" are one
  pixel apart.

## [5.3.0] - 2026-07-27

### Added
- **A durable, per-user record of what every job cost, with a dashboard.** Until
  now the only view of token and dollar spend was the live in-conversation
  meter, and it forgot everything the moment the tab closed or the session was
  cleaned up. Every prompt-to-settle unit is now filed as its own row — who ran
  it, which agent and model, how many turns and tool calls it took, and the
  token and cost figures the runtime reported — kept forever, in the app's own
  database, independent of the runtime session, the conversation, and the
  server process that recorded it. Deleting a conversation removes its
  transcript, not its billing history.

  A dashboard reads it back: totals and a trend line for the day, week, month
  or year you pick, broken down by agent and by model, an effort view showing
  whether an agent typically settles a job in one round trip or several, and
  the tools it reached for most. A signed-in user sees only their own figures;
  the installer — the same account that already gates applying an update — can
  additionally switch to everyone's.

  Not every agent reports the same things, and the dashboard says so rather
  than guessing: a runtime that never reports a cost or a token figure shows
  "not reported" for it, never "$0.00" or zero, and every total says how many
  of the jobs behind it actually contributed a figure. Codex's `exec` fallback
  mode reports neither tokens nor cost at all; its app-server mode reports
  tokens but no cost, since nothing in its schema prices a turn.

  Cost, wherever it appears, is the provider's API list price for the tokens a
  job moved — which is the only figure the runtimes report, whether or not the
  account behind them pays by the token. On a subscription plan nothing is
  billed per job, so the dashboard says as much in plain sight under its
  totals: these are what the work would have cost through the API, not what
  anyone was charged.

  The same history is reachable as an API — a dashboard endpoint, a paged job
  history with filters, a single job with its tool breakdown, and a CSV or
  JSON export — all scoped the same way the dashboard is, so an export can
  never carry more than the view it came from.

### Fixed
- **The live in-conversation cost meter no longer compounds on every turn of a
  Claude conversation.** Claude's own `total_cost_usd` turns out to be
  cumulative for the whole conversation rather than per turn — confirmed by
  probing the running CLI directly, not documented anywhere — and it stays
  cumulative across a `--resume` into a brand new process. Nothing downstream
  expected that: every turn after the first was shown its own cost stacked on
  top of every turn before it, so a ten-turn conversation's meter read roughly
  ten times too high by the end. The adapter now tracks the highest cumulative
  figure it has seen and reports only what a turn added past it, so the live
  meter and the new durable job record agree, and both show a turn's own cost
  rather than the conversation's running total.

## [5.2.0] - 2026-07-27

### Added
- **A tab you renamed stays renamed, and a reload brings you back to it.** The
  name you gave a session used to live only in the page you typed it in: reload
  the browser, or open the app in a second window, and every tab was back to the
  name it was created with. A chosen name now belongs to the session. It comes
  back after a reload, it is the same name in every window and on every device,
  it reaches windows that are already open without them reloading, and it
  survives the app being restarted and the session being recovered. Sessions
  nobody renamed are unchanged — they still show their generated name, with the
  folder name standing in for it.

  The same reload also used to lose your place, dropping you on the first tab
  whichever one you had been working in. It now returns you to the tab you were
  last on, remembered per window, so two windows can each sit on their own
  session. If that session is gone by the time you come back, the app falls back
  to the first tab rather than showing you nothing.

- **The agent can ask you a question and wait for the answer.** Until now the
  only thing it could put in front of you was an approval — allow or deny a tool
  it was about to run. Anything else it needed to know, it had to ask in prose,
  and you had to guess the wording it was hoping for.

  It can now ask a proper question with the answers already written out: which
  of three approaches to take, which of the four candidate files you meant, which
  of the problems it found to fix first. The question appears in the conversation
  where it was asked, you answer by clicking, and the agent picks up from your
  answer. Questions come in both kinds — pick exactly one, or tick several and
  confirm.

  The card stays where it was after you answer, showing what was asked and what
  you chose, so scrolling back past a decision shows the decision. If you close
  the tab while one is waiting, it is still there — and still answerable — when
  you come back. A question you would rather not answer can be skipped; the agent
  is told so and carries on rather than sitting there blocked.

  Questions are asked even in sessions running with approvals bypassed: not being
  asked before it acts has never meant having your questions answered for you.

  Works with Claude and with omp, each through its own handshake. kimi can reach
  it too, but often prefers its own built-in question tool, which answers itself
  without asking anyone — so questions there are hit and miss, and that is kimi's
  behaviour rather than something this app can steer. Codex, pi and grok report
  the capability as unavailable rather than offering a button that would do
  nothing.
- **You can open what the agent handed off and watch it work.** A delegation
  used to be one line in the agents list: a name, a status badge, a duration.
  Whether it was a sub-agent reading three files or a workflow running a dozen
  agents across four stages, you got the same single row and waited.

  Now any entry in that list opens. A sub-agent shows its own work — the step it
  is on in its own words ("Reading hello.txt"), every tool it reached for, what
  each one gave back, and how many tools and tokens it has spent. It fills in
  live while the agent works and stays there afterwards for reading back. A
  workflow opens the same way and shows the stages it narrates as it goes.

  Failures inside that work are now legible. When a step an agent took fails,
  the popup shows the message it failed with, rather than the whole delegation
  turning into a red badge that says only that something went wrong somewhere.

  Both popups behave like the file editor — movable, resizable, expandable to
  fill the window — and both stay open while you look at another panel.

### Fixed
- **A sub-agent's own steps are no longer thrown away.** The runtime has been
  reporting them all along, tagged with the delegation they belong to. Nothing
  read that tag, so every tool call an agent made inside its own work was filed
  against an id no part of the conversation owned and silently dropped. They now
  reach the delegation that made them.

### Changed
- **The conversation only shows what was actually said.** When the agent spent a
  step running commands without writing anything, the transcript still drew a
  row for it: an icon, a clock and a small work pill with no sentence beside
  them. A long task could put half a dozen of those between one reply and the
  next, and skimming the chat meant stepping over rows that said nothing.

  Those steps no longer appear in the conversation. The moment a written reply
  arrives, it carries the pill for everything that led up to it — "3 commands ·
  1 reasoning · 8.1s" on the sentence that came out of them — and opening it
  lands on the trace at the *start* of that stretch rather than at the reply's
  own last command. Nothing is hidden: the trace holds every call exactly as
  before, and a trace row or a search hit that points at a suppressed step now
  scrolls to the reply that speaks for it.

- **A phone gets a layout built around the conversation.** It used to be the
  desktop layout at the same size: the figures you read mid-session — the cost,
  the model, the state, whether approvals are bypassed — were set smaller than
  the body text, the controls sat close enough together that hitting the
  intended one was luck, and more than half the screen went to chrome.

  Now the chat surface is one slim strip above the conversation and one row
  below it. The strip says what the session is doing and what it has cost;
  tapping it opens the runtime, the folder, the branch, the tokens, the context
  meter and the approvals state. The row below is the message field and send,
  with the attachments, the pickers, the model and the approvals readout behind
  a *More*.

  The bottom bar is now a set of destinations rather than a drawer of commands.
  What this app does is run agent sessions, and inside one there are four places
  worth being — the conversation, what the agent did about it, the files it did
  that to, and a shell in the same directory — plus the other sessions. Those
  are the five, it says which one you are on, and pressing one goes there. What
  used to sit in those slots mixed a place to go, a thing to make, a panel to
  toggle, a file to attach and a sheet of everything left over.

  The verbs moved to a square button floating in the bottom right: search this
  conversation, jump to a turn, display settings, new session, attach an image,
  rename, reconnect, and the rest behind *More*. A control that changes where
  you are and a control that does something to where you are no longer share a
  row.

  The conversation now has about seven tenths of a phone screen, where it had
  under half, and the bar gets out of the way entirely while the on-screen
  keyboard is up. Everything a finger is meant to hit is at least 44px with real
  space around it, nothing carrying live information is smaller than the body
  text, and every control says what it is rather than being a bare glyph with a
  tooltip no touch screen can show. The same treatment reaches the trace rail,
  the turn index, the model list, the more sheet, the tab switcher and the
  dialogs. The desktop and tablet layouts are unchanged.

### Fixed
- **A phone no longer opens a conversation onto a panel.** Which panel is open
  is a desktop preference — there the rail sits beside the transcript — but on a
  phone it replaces it, so the stored setting put every conversation behind a
  panel. It is session state on a phone now, and the shared preference is left
  alone rather than overwritten, which would have closed the rail on the desktop
  that set it open.
- **The conversation no longer spills over the live ribbon and the composer on
  a short screen.** The transcript kept a fixed minimum height it could not
  give up, so on a phone in landscape — or any window short enough — it grew
  past the space it had and was painted over the two things below it.

### Internal
- A browser check covers the suppressed steps end to end — that they leave no
  row, that the trace still holds them, and that clicking the reply's pill lands
  on the first of them. The suite's virtual-time budget grew with it: a run that
  outgrows the budget reports no results rather than a failure, so it now has
  room over what the checks need.
- The automated browser checks run at phone viewports (portrait, keyboard-open
  and landscape), with each of the phone's own disclosures and its menu open in
  turn, and assert the geometry rather than the intent: target size, the space
  between neighbours, type size, that the named live figures are legible and
  reachable, that every control can be identified without pressing it, that no
  region is drawn over another, and that the chrome takes no more than 170px
  from the conversation — nothing else would have noticed that drifting back,
  since every other rule is about the chrome being big enough.

  Three defects in the checks themselves came out of it. They ran in an 800x600
  window while mounting a 390x740 fixture, so a third of it was off-viewport
  and anything that asks the viewport a question got the wrong answer. They
  loaded none of the app's own stylesheets, without which every
  `var(--text-2xs)` resolved to nothing and a type-size check read 16px for
  text that ships at 10. And a panel animating in from `opacity: 0` was skipped
  as invisible in headless Chrome, so a whole state was reported clean without
  measuring anything — the menu rises without fading now, which also means it
  is there under reduced motion and on a dropped first frame.

## [5.1.2] - 2026-07-26

### Added
- **A conversation can run a different model from the one the profile picks.**
  The model shown beside the composer is now something to click: choose one the
  runtime has listed, or type a name it has not, and that choice belongs to that
  one conversation — never written back as a profile or personal default, and
  never inherited by the next conversation. Where the runtime can change model
  without restarting, it changes immediately; where it cannot, the choice is
  saved and used the next time that conversation starts, and the reply says
  which of the two happened rather than claiming success either way. The same
  menu offers the way back to the runtime's own default.
- **Turns fold away.** Each turn's header can be collapsed to hide everything
  under it, and a turn folds on its own once the next one begins, so a long
  session reads as a list of what was asked rather than an endless scroll. The
  turn index can open or close them all at once, and jumping to a turn from the
  index opens it. A folded turn still says what it was about, and its copy
  action keeps working while it is shut. (This entry also claimed a branch
  action. There was none: the control was never built, in this release or any
  other before it. Branching from a turn is in Unreleased above.)

### Fixed
- **The runtime's own slash commands are there from the moment a conversation
  opens.** They used to appear only after the first message had been sent,
  because nothing knew what the agent supported until the agent had spoken.
- **`/clear` and `/new` really do start over.** The transcript went blank, but
  the text was handed to the agent like any other message, so the process kept
  the whole conversation in mind and the next answer brought it all back. They
  now restart the agent on a genuinely empty conversation, which is what they
  had appeared to do.

## [5.1.1] - 2026-07-26

### Fixed
- **The approval mode you started a conversation in survives having to bring it
  back.** A chat started with approvals bypassed used to come back asking for them
  — after the browser reconnected to a conversation whose agent was gone, after
  the server restarted, or when the conversation was resumed from the launcher —
  and it came back that way without saying so. The mode is now remembered against
  the conversation itself, so reconnecting, restarting and resuming all restore it,
  and relaunching carries it forward instead of quietly falling back to manual.

  The badge in the conversation header is now the conversation's own rather than
  the shell's most recent, which also fixes it showing the wrong mode after
  switching between two chats; it states the mode even while a conversation is
  offline and only its transcript is on screen, and the launcher's resume list
  says which mode picking a conversation will put back. A conversation that asked
  first is never restored into a bypass, a remembered bypass belongs to one
  conversation and one user and is never inherited by another, and starting a
  fresh conversation in the same tab starts it asking again.
- **A terminal opened in a conversation stays in that conversation.** It used to
  become a session like any other, so the same shell appeared twice — once in the
  conversation where it belonged and once as a loose terminal tab beside it — and
  every other place the app was open showed it too, as a standalone session with
  nothing to say which conversation it came from. Shells now name the conversation
  that owns them: they are reached only from there, they are absent from every
  session listing on every device, and closing the conversation ends them instead
  of leaving ptys nothing on screen refers to. Terminals opened as standalone
  sessions are unchanged. A shell whose session did not survive a server restart
  now opens a new one rather than leaving an empty pane.

  A conversation open on two devices gets a shell per device rather than one
  shared between them: a shared pty would put a terminal on a screen the user did
  not open it on, showing input they did not type, which is the same complaint
  from the other side.

## [Unreleased]

### Added
- **The chat area is three zones you can each switch off.** The turn index on
  the left, the conversation in the middle with a shell split under it, and the
  trace rail on the right. What drives the rest is that reasoning blocks and
  tool calls leave the transcript: inlining them put a disclosure and a tool
  card between every two paragraphs, which made a five-line answer eight screens
  tall and the prose impossible to read as prose. They move to the rail — a
  relocation, never a hiding. Every block is still on screen and still expands
  to the same card, with its arguments, its clamped output and its diff hunks.
- **A trace rail holding the plan and everything the agent did about it.** One
  ordered timeline of every reasoning block and tool call in the conversation,
  filterable to tools, reasoning or file changes, each row expandable in place.
  A call that is still running updates on the timeline as it goes rather than
  freezing at whatever its arguments looked like when the row was drawn, and a
  row you opened stays open when the next token arrives. It is the rail's first
  tab and it opens by default, since it is now where the agent's working is.
- **A turn index for jumping back through a long conversation.** A long session
  is a scrollbar with no landmarks, and "the twelfth thing I asked" is a unit
  the user thinks in that a flat message list has no name for. Every turn gets a
  number, an outcome glyph and the first line of what was asked; the arrow keys
  move the selection and Enter jumps to it. Below 1280px it collapses to an icon
  rail rather than taking width the conversation needs.
- **Each turn is headed by what it cost.** A slim strip carrying the turn's
  duration, token count and price, sticky for the turn you are reading so
  scrolling back through an hour of conversation always leaves a header on
  screen saying which turn the text under it belongs to.
- **A working line above the composer, with the stop button on it.** While a
  turn runs it says what the agent is doing now. The header's state chip is a
  spot of colour at the top of a tall surface, so with the transcript scrolled
  up or the terminal open, "is it still working, and on what" was a question the
  screen could not answer without going to look. Stop lives here for the same
  reason approvals do: the thing you need when a turn goes wrong must not be
  somewhere you have to find.
- **A shell at the bottom of the conversation, in its working directory.** You
  can read what the agent said it did and check it without leaving the
  conversation, losing your scroll position or switching tabs. Tabbed, with a
  draggable divider, and each pane is a real session — so its scrollback is
  stored, its history is pageable and it survives the browser going away.
  Ctrl+` opens it, and gets you back out of it.
- **⌘F finds something in the conversation you are in.** Instant, over the
  transcript the browser already holds, and explicit that this is what it
  covers — paging further back is what "Load earlier messages" is for. The
  ranked search across every session is unchanged.
- **Keyboard shortcuts for the surface**: Ctrl+` for the terminal, Escape to
  interrupt, ⌘F to search, ⌘B for the rail, ⌘J for the latest turn and ⌘↑/⌘↓
  between turns. Escape inside the terminal stays a byte the shell wants, so
  `vi` still works in a pane you opened in order to use it.
- **Reading width and density are yours to set.** A measure of about 74
  characters or the full column, at 13px or 14px. Code, tables and diffs ignore
  it and take the room they need, because their width is part of what they say.
- **The app opens in the theme the operating system asks for**, until you pick a
  side — after which your choice wins and the machine going light at sunset no
  longer flips the app out from under you.
- **Pick up a past conversation when you open a folder.** The web counterpart of
  `claude --resume`: choose a directory, and the launcher lists the
  conversations that happened in it before offering to start a new one — because
  when there is one, it is usually the answer. Each is listed by what was said
  in it rather than by when it happened, since a column of
  "Session 25/07/2026, 21:35" identifies nothing. One already running is marked
  as such, and one whose runtime never named itself is marked "transcript only",
  so the difference between an agent that remembers the conversation and one
  reading it for the first time is known before choosing rather than after.
- **HTML files open as a page.** An `.html` file gets the same Preview/Code
  toggle markdown has, rendered in a sandboxed frame with an opaque origin: the
  page runs its own scripts and can do nothing to this app — no reading the auth
  cookie, no reaching into the surrounding DOM. Its relative `./style.css` and
  images load too, through a path-shaped asset route, so a preview looks like
  the page rather than like its markup.
- **A chat whose process is gone offers to resume it or start again, in the same
  tab.** Chat sessions live in the server's memory and transcripts live on disk,
  so restarting the server left a conversation on screen that no longer had
  anything running it — and the first message came back as an app-wide
  "Connection error" with a Retry that reconnected a socket which had never been
  the problem. The pane now says which agent stopped and offers the two ways
  forward. *Resume* hands the runtime its own conversation back, so it remembers
  what is on screen; *start a new chat* keeps the transcript on disk and draws a
  line under it. Resume is only offered when it can actually deliver — a
  conversation whose runtime never named itself says so rather than producing a
  stranger that looks like it worked.
- **Cut, Copy and Paste in the right-click menu, and Download / Upload on a
  file.** Right-clicking a file in the workspace tree saves it out; right-clicking
  anywhere in the tree uploads into that folder, one file or several, asking
  before it replaces anything.
- **Issues and pull requests open in the app.** The GitHub panel used to hand
  them to a new browser window, which on a phone means finding your way back.
  They now open in a panel that renders the body and the discussion with the
  same markdown renderer the transcript uses, with a link out for the things
  only GitHub can do.
- **The file viewer is a window.** Drag it by its title bar, resize it from the
  bottom-right corner, or fill the screen with the button beside Close — so a
  file can sit open beside the conversation instead of on top of it.
- **A Status panel: what is left of the context window, the plan, and the
  branch.** The three things worth knowing before deciding whether to keep
  going. Every number is one something actually reported — a runtime that does
  not publish its context window gets a sentence saying so rather than a meter
  reading zero, which is indistinguishable from having nothing left.
- **Markdown files open rendered, with a toggle back to the source.** A README is
  written to be read, so it opens as a document — headings, links, tables, and
  mermaid diagrams through the same renderer the chat already uses. Two buttons
  switch between that and the editor, and the preview shows the *draft*, so
  edits appear as you make them.
- **Images, video, audio and PDFs open in the viewer instead of "this file is
  binary".** A screenshot is shown, a screen recording plays with a working seek
  bar, a voice note plays, a PDF gets the browser's own viewer. Range requests
  are answered, which is not a nicety — Safari will not start a video at all
  without them, and seeking depends on them everywhere else.

  A file is never served back under a type its *name* claimed: the bytes decide,
  and anything unrecognised is an opaque download. SVG — the one image format
  that is also an executable document — is served under a `sandbox` policy.
- **A right-click menu that belongs to the app.** The browser's menu offers Back,
  View Source and Save As on top of an application where none of them is what
  was meant. In its place: the current selection, a paste into whatever field is
  focused, sessions, settings, theme and reload. Surfaces with a better menu of
  their own keep it — the editor, and the terminal's right-click-to-copy — by
  claiming the event, so nothing had to be hardcoded here.
- **A line across the conversation when the context is compacted**, saying what
  triggered it and how much was summarised. Everything above it is still on
  screen and still worth reading, and is no longer something the agent can see;
  an answer that contradicts an earlier one is explained rather than baffling.
- **`/clear`, `/new` and `/reset` empty the chat window.** They already cleared
  the runtime's context, and the window went on showing an hour of conversation
  the agent could no longer see.
- **The slash command list says what each command does.** Claude reports its
  commands as bare names, so the picker was a column of indistinguishable
  slashes; the built-ins are described, and anything a runtime describes for
  itself is left alone.

- **The browser stops stealing keys from the terminal and the editor.** `Ctrl+R`
  is reverse history search in every shell anyone uses; until now the byte
  reached the shell *and* the page reloaded, losing the scrollback. `Ctrl+U`
  kills the line rather than viewing the source, `Ctrl+P` walks back through
  history rather than printing, and `Ctrl+F` is the editor's find. Nineteen
  chords in total, claimed only inside the terminal and the editor — the
  composer, the dialogs and every ordinary text field keep the browser's
  defaults, because there taking them away would be the bug.

  Copy, paste, cut, select-all, undo and redo are never touched: for those the
  browser's default *is* the mechanism. `AltGr` is not mistaken for `Ctrl+Alt`,
  so an Italian or German keyboard can still type `@` and `[`. `F5` and
  `Ctrl+Shift+R` are deliberately left alone so reload stays reachable — every
  other claimed chord means something in a shell or an editor, and that one does
  not. `Ctrl+T`, `Ctrl+W` and `Ctrl+N` are reserved by the browser and never
  reach a page at all.
- **The file editor is Monaco**, the editor from VS Code. Around ninety
  languages instead of eleven, plus everything the hand-rolled one never had:
  find and replace, folding, multi-cursor, bracket matching, a minimap, a
  command palette and a real undo stack. It is themed from the same CSS custom
  properties the terminal and the chat's own highlighter use, so one file looks
  the same in all three.

  It is fetched the first time you open a file and never otherwise — 4.6 MB in
  its own chunk, with the main bundle unchanged at around 950 kB — and it is
  bundled and served by this app rather than pulled from a CDN, because this app
  is routinely run on a LAN with no route out. Until it lands, and for good if it
  cannot be fetched at all, the previous editor is what fills the panel: the file
  is readable and editable either way.

  The language *services* are deliberately switched off. Monaco's TypeScript
  service only ever sees the single open buffer, so it cannot resolve one import
  in a real project and would underline most of every source file in red — 6.7 MB
  spent making the editor confidently wrong. Syntax highlighting comes from the
  grammars, which cost nothing extra.
- **Type ahead while the agent is working.** The composer no longer goes inert mid-turn:
  a message sent while a turn is running is accepted and queued, and goes over the moment
  that turn ends. The queue lives on the server, not in the tab — this app's whole premise
  is that the agent keeps working after you close the browser, and a queue that died with
  the tab would contradict it. Waiting messages are listed above the input, oldest first,
  each withdrawable until the moment it starts; a second browser watching the same
  conversation sees the same line. Pressing Stop discards it, because a stop that then
  fires three more prompts is not a stop.

  It also queues while an approval is on screen. That moment — the agent waiting on you —
  is exactly when the follow-up is worth typing, and it was the one moment you could not.
- **Attach files and images to a chat turn.** The composer had the whole attachment
  interface already — chips, drag and drop, the image-paste classifier — and no way to
  reach it, because nothing ever gave it an upload handler and there was no endpoint to
  upload to. Now there is: drag a file onto the composer, paste a screenshot, or use the
  paperclip. Images preview as themselves rather than as a grey rectangle labelled "image",
  and land in the transcript as pictures.

  Files are stored inside the session's own working directory, which is the only place
  every agent CLI can read without asking first. Nothing is ever served back under a
  content type the uploader chose: a file whose bytes really are an image comes back as
  that image, and everything else is an opaque download.
- **`@` to reference a file from the project.** Typing `@` opens a picker over the whole
  working tree — `git ls-files`, so it knows what `.gitignore` says, with a bounded walk
  for a directory that is not a repository. Ranked on the assumption that people type the
  filename, so `session` finds `session.ts` rather than everything under `chat/`; `@` with
  a slash in it is read as a path fragment, and initials still work as a fallback.
- **Buttons for the things that used to need a keystroke you had to already know about.**
  `@` for files and `/` for the runtime's slash commands and skills are now also a click,
  next to the paperclip. Reaching a feature by typing a character nobody told you about is
  not discoverability.
- **The workspace panel's tabs stay reachable when the rail is narrow.** The tab strip
  scrolls, with the scrollbar hidden — so narrowing the rail moved tabs out of view with
  nothing on screen to say they were still there. A chevron now appears exactly when they
  overflow, listing every panel.
- **The workspace panel can be resized**, by dragging its edge or from the keyboard — the
  handle is a real `separator` with arrow keys, Home/End, Enter to reset and double-click to
  reset. The width is clamped to 220–760px, never takes more than 70% of the window, and is
  kept across reloads.
- **Clicking a file opens it in an editor.** A modal with syntax highlighting, line numbers,
  Tab indent (including whole-selection indent and outdent) and ⌘/Ctrl+S to save — built on
  the highlighter the chat already uses for code blocks, so it follows the terminal palette
  and adds no dependency. Reachable from the Files tree and from a per-row button in
  Changes. Binary and oversized files open read-only and say which limit applies.

  Saving carries the version the file was opened at, and the server refuses a stale one:
  an agent is editing the same tree while the panel is open, and overwriting its work with
  a copy read two minutes ago is the one outcome nobody would ask for. Unsaved edits are
  never discarded without asking. Files inside `.git` are not writable.
- **The web chat's own display settings.** The gear inside a conversation opened the
  app-wide Settings dialog — font size, colourway, terminal typeface, install — none of
  which changes anything you can see in a chat. It now opens a chat dialog: which workspace
  panels exist, and whether the transcript shows reasoning, tool cards, the plan and the
  usage readout. Presentation only; nothing there changes what an agent may do.
- **A workspace panel beside the conversation**, with five tabs you can switch off
  individually. *Files* browses the session's working directory. *Changes* lists the
  uncommitted work from `git status` and fetches a diff per file only when you open it.
  *GitHub* shows open pull requests and issues through the `gh` CLI on the server — and
  says which of "not installed", "not signed in" or "not a GitHub repository" applies,
  because an empty list looks identical to a repository with no open work. *Agents* lists
  the subagents and workflows this conversation has started, running ones first, derived
  from the transcript rather than from a registry that could disagree with it. *Links*
  turns local server addresses the agent printed into links you can open — re-pointed at
  the host the page was served from, so a `localhost:5173` printed on the server is
  reachable from the phone looking at it.
- **Bypass tool approvals for web chats**, as a setting in the app Settings dialog. Only
  the terminal launcher could start a runtime with approvals off; a chat could not, even
  though the server already accepted the flag. The chat launch button states when it is on.
- **A capability handshake on connect.** The server advertises the optional messages it
  understands, so a page newer than the server it is talking to asks for nothing that would
  come back as an error toast, and falls back to the behaviour that server can deliver.

### Changed
- **The composer shows the model the session is actually running**, rather than
  the first entry of the list of models it could run — which was right only by
  accident. Switching is offered only where the runtime genuinely supports it,
  and approval mode is shown as the read-only fact it is: it is fixed when the
  session is launched, so a picker there would have been a control that looked
  like it worked.
- **The transcript stays pinned to the bottom when the window changes shape,**
  not only when the text grows. Opening the terminal, resizing the window or the
  on-screen keyboard arriving used to leave a transcript that was following
  along short by exactly the height the viewport had lost.
- **The transcript is chat bubbles** — the user's turns on the right in a card,
  the agent's on the left with the full width its code blocks and diffs need.
  Square corners, like everything else here.
- **The font chosen for the terminal is now the app's monospace font.** It set
  exactly one thing before, so the same snippet was one typeface in the terminal
  and another in the transcript quoting it. It now drives the chat's code blocks,
  the file editor and the diff view too.

### Fixed
- **Resuming a conversation changes what is on screen.** Clearing the recovery
  offer was not enough: the transcript still recorded the session as dead, so
  the derived offer came straight back and the pane sat unchanged — composer
  disabled, notice up — over a session that was already running, until the page
  was reloaded.
- **The file window's contents follow its height.** The editor and the preview
  were sized in viewport units, so dragging the window bigger left the content
  exactly as it was, with empty panel underneath. They now fill the panel and
  track it to the pixel in both directions.
- **A window can no longer be resized past the bottom of the screen**, which put
  its own resize grip out of reach and left no way to make it smaller again.
- **Monaco colours large files.** Its large-file optimisation silently drops
  syntax highlighting, and "large" is much smaller than it sounds; long lines
  stopped being tokenised at 20,000 characters. Both limits are lifted — the
  language services that optimisation protects are switched off here anyway, so
  tokenising is nearly all this editor does.
- **Copy in the right-click menu now sees text selected in a field.** A form
  control keeps its own selection and `document.getSelection()` cannot see into
  it, so the menu offered nothing in the one place people select text most — the
  composer.
- **A chat pane no longer reports "Ready" for a process that is gone.** The event
  log replays to idle on its own, so a conversation that ended on a finished turn
  came back looking live, with a working composer, until the first message failed.
- **A chat session's runtime is freed when it exits.** The session record went on
  claiming a process that had died, so relaunching in the same tab was refused
  with "A process is already running in this session" — escapable only by opening
  a new tab and leaving the conversation behind.
- **Both Monaco themes are re-derived when the app theme changes.** They were
  defined once from whichever palette happened to be live, so switching to light
  produced a light editor still wearing dark token colours.
- **The `@` and `/` pickers behave like menus.** Arrowing past the fold scrolls
  the list instead of walking the highlight off the bottom of it, clicking
  outside closes them rather than leaving Escape as the only way out, and moving
  the pointer over a row selects it.
- **The editor follows the app's theme.** Both themes were derived once, from
  whichever palette happened to be live at the time, so switching to light gave
  a light editor still wearing the dark palette's token colours.
- **The workspace rail no longer sits on top of the composer.** The input was a sibling of
  the row that holds the rail, so it ran the full width of the surface and the rail was
  simply drawn over its left end — and dragging the rail wider covered more of it. It
  belongs to the conversation column now, bounded by the same rails the transcript is.

  Moving it was not sufficient on its own: the region holding it is a CSS grid, and a grid
  item has `min-width: auto` exactly the way a flex item does, so the track refused to
  shrink below the composer's min-content width and a wide rail pushed it off the
  right-hand edge instead. Both are pinned by a browser check that measures the geometry;
  neither is visible to a test that only renders markup.
- **The prompt field says where your typing goes.** A lit ring and a top edge that draws
  itself in on focus, a highlight travelling along that edge while the agent works, press
  feedback on send, and room around the text instead of six pixels. On a narrow rail the
  keyboard hint drops out rather than truncating to "Send anyway — it …", which is not a
  shorter sentence but a worse one.
- **Opening a second web chat no longer clears the first.** A browser held one transcript
  and the server bound each socket to one session, so a second conversation overwrote the
  first and its tab went blank while its agent carried on working. Chat sessions are
  addressed by id now: the browser keeps a transcript per conversation, the server delivers
  each conversation's events to every socket watching it, and a background chat keeps
  streaming — moving its own tab's status and unread dot while you are elsewhere.
- **Chat transcripts were being silently truncated, and lost entirely on restart.** The
  event index was written without its header whenever `stat()` had been called before the
  first append — which `ChatSession.start()` always does — so every index this store had
  ever produced was header-less. Since offsets are measured from the header, rejoining a
  conversation dropped its first few events and a server restart made the whole log
  unreadable. New logs are written correctly and existing ones are repaired in place on
  first read.
- **`Could not start claude: listen EINVAL`.** The approval socket lived at
  `<data-dir>/chat-sockets/<session-uuid>/perm-<24 hex>.sock`, which for a default install
  is 118 bytes — past the 108-byte limit on `sockaddr_un.sun_path`, which the kernel reports
  as `EINVAL` rather than as a length error. The per-session directory is gone (the random
  filename already made the path unguessable) and a private temp directory is used as a
  fallback when the data directory is too deep to fit.
- **"Loading earlier messages" no longer spins forever.** Two defects: the "is there older
  history" test was `firstSeq > 0`, and seq numbering starts at 1, so every session ever
  created claimed to have more; and a page that came back with no messages never notified
  the list, so the spinner it raised was never taken down. Snapshots now report how far back
  their replay reached, an empty or failed page settles the control, and a request that goes
  unanswered gives the button back.
- **A Claude chat no longer hangs on every tool approval.** Emitting the approval event
  replaced the pending entry and threw away the resolver the hook was blocked on, so
  answering in the browser went nowhere: the tool never ran, the turn never ended, and the
  surface kept its stop button and its "Working" indicator indefinitely. Every chat that
  touched a tool was affected.
- **Slash commands now work for every runtime that has them, not just Oh My Pi.** A launch
  reports its command list before the conversation is announced, and the browser was
  dropping every event that arrived in that window; the list is also kept on the session so
  it survives a rejoin instead of being replaced by the adapter's static declaration.
- **Rejoining a finished chat no longer reports "Thinking" forever.** The session's state
  only moved on an explicit `state` event, and Claude ends a turn with `turn_end`.
- **Closing a chat tab closes the conversation with it.** The surface was only ever
  replaced by joining another session, so closing the last tab left a dead conversation on
  screen with a composer that could not send anything.
- **The chat surface no longer pushes itself wider than the window.** It is a flex item and
  had no `min-width: 0`, so one long file path in the panel or one long line in the
  transcript cut off the right-hand edge of everything on a phone.
- **The connection indicator now reflects the connection.** Nothing ever wrote to it, so it
  read "disconnected" for the whole life of a healthy session.
- **The Changes panel works for a session opened inside a subdirectory of a repository.**
  `git status --porcelain` reports paths relative to the repository root whatever directory
  it ran in, so those paths were being resolved against the session directory and pointed at
  files that do not exist — and the listing showed changes from outside the session as well.
  It is now scoped to the session's own directory and reports paths relative to it.
- **Workspace paths are confined after following symlinks.** A lexical path check passes a
  link inside the working tree that points at `/etc`, and an agent's working tree is exactly
  the sort of place a symlink turns up.

### Changed
- **Node 22.13 or newer is required** (was 20). This is the breaking change behind 5.0.0.
- The workspace panel sits to the left of the conversation, and on a phone it takes the
  mobile bar slot the key strip had — the strip sends terminal control codes, which a
  conversation has no use for, and it is still there for terminal sessions.
- Assistant messages are no longer labelled "Assistant". A conversation is overwhelmingly
  the assistant talking; the user's turns keep their label, their card and their rule. The
  accessible name is unchanged, so both roles are still announced.
- A session's surface (terminal or chat) is persisted, so a restart reopens a conversation
  as a conversation instead of as an empty terminal.

### Added
- **On-screen terminal keys on mobile** (issue #21): a key strip above the bottom bar with
  Esc, Tab, a one-shot Ctrl latch, and the four arrow keys — the keys a phone keyboard does
  not have and agents routinely ask for. Ctrl is a latch, not a chord: tap it, then type the
  letter on the ordinary keyboard (the transform hooks xterm's `onData`, the one path every
  input method reaches, including Android IME composition). Arrows honor the terminal's
  application-cursor-keys mode (SS3 vs CSI), send their modified form (CSI 1;5X) while Ctrl
  is latched, and repeat while held. The strip can be hidden with the bottom bar's new Keys
  toggle when the terminal needs the room back.
- **A mobile tab switcher sheet** replacing the desktop tab strip on phones: full-width,
  thumb-sized rows with the active session ringed, unread output dotted, per-row close, a
  New session button, and an All sessions route to the server-wide list. The desktop strip
  no longer renders at phone widths, returning its vertical space to the terminal.
- **Deliberate touch scrolling for the terminal**: vertical drags on the live terminal now
  scroll the buffer through xterm's own scroll API with sub-line precision, owned by the app
  instead of the browser's incidental native scroll of the xterm viewport. Dragging down
  while parked at the top hands off to server-paged history, matching the mouse-wheel path,
  and the gesture can never trigger pull-to-refresh or bounce the surrounding page.
- **The on-screen keyboard no longer appears by itself.** Every tap on the terminal focused
  xterm's hidden textarea and summoned it; the textarea now keeps `inputMode="none"` so taps
  stay silent, and the keyboard appears only from the key strip's explicit keyboard button
  (Enter is on the strip too). When it does appear, the app lifts by exactly the keyboard's
  size — natively on Android Chrome (`interactive-widget=resizes-content`) and via a
  visualViewport watcher on iOS Safari — instead of being covered.

### Changed
- **The runtime picker is a Relay screen.** The thirteen buttons are now one card per runtime,
  each showing the command its bridge looks for (`claude`, `cursor-agent`, `qwen`, `kimi`, …) so a
  CLI that is not installed is diagnosable at a glance. Starting a runtime without approval prompts
  is a separate control inside the card rather than a second button beside it, so aiming at the card
  cannot trigger it, and it names what the runtime will actually do — "auto-accepts every action"
  rather than the word "dangerous". Cursor and pi have no such control, because their CLIs have no
  tool-approval bypass to offer.

- **The UI now uses the Relay design system**, whose semantic tokens are shadcn's own
  (`--background`, `--foreground`, `--primary`, `--muted`, `--destructive`, `--border`, …). The
  chrome — title bar, tab strip, sessions sidebar, status bar and a Ctrl/Cmd-K command palette — is
  React; a dark and a light theme come from the token layer. shadcn/ui itself is not installed:
  Relay's components are plain React with inline styles bound to CSS custom properties, so adopting
  Tailwind, PostCSS and Radix would have bought identical pixels for an extra toolchain.
- The terminal is deliberately **not** a React component. xterm binds its renderer, viewport and
  selection to the node it was constructed against, so the node is created once outside React and
  adopted into the tree; a re-render can never take a live session's scrollback with it. Relay's own
  `TerminalPane` renders mock ANSI lines and is a design-system stand-in, not a terminal.
- React is a devDependency, bundled by esbuild. Relay's reference page loads React and Babel from
  unpkg; that is not reproduced, because this app is a PWA that ships offline and already vendors
  xterm's stylesheet locally for the same reason.

### Added
- **Qwen Code and Kimi Code** as runtimes, with `--qwen-alias` and `--kimi-alias` to relabel them.
  Both get a Dangerous button wired to `--yolo`. For Kimi that flag is documented (`-y, --yolo
  Automatically approve all actions.`); for Qwen it is not — `qwen --help` omits it entirely — but
  the shipped bundle both registers it (`.option("yolo", { alias: "y", type: "boolean" })`) and acts
  on it (`else if (argv.yolo) approvalMode = "yolo"`), verified against `@qwen-code/qwen-code`
  0.20.0. Kimi's `--auto` is deliberately not used: it is a narrower "auto permission mode" that
  still prompts for what it does not cover, so wiring the Dangerous button to it would promise a
  bypass the user does not get.
- The Kimi bridge looks in `~/.kimi-code/bin` before `PATH`, because that is where its installer puts
  the binary and that directory is often missing from a systemd `--user` PATH — the same reason the
  Grok bridge leads with `~/.grok/bin`.

### Changed
- **The live terminal's own scrollback is 10x deeper** (2,000 → 20,000 lines), so scrolling up
  through a whole agent reply no longer hands off to server-paged history mid-gesture. Older output
  still pages in from the server at the top exactly as before; the trade-off is xterm's reflow cost
  on resize, which scales with the buffer.

### Fixed
- **Scrollback history is a clean transcript again** (issue #22). Three defects compounded into the
  garbled scroll-up view. First, the server-side recorder anchored its eviction marker at the
  cursor, and erase-in-display — which repaint-style agent CLIs emit on every single frame —
  disposes markers on the lines it blanks; each dead anchor was misread as "output outran the
  recorder", so gap markers were interleaved through healthy history and, worse, the recovery path
  re-emitted the entire scrollback, which is where the duplicated splash screens and repeated blocks
  came from. The recorder now parks a second marker at buffer line 0, which erase sequences can
  never reach (only a genuine trim removes line 0), so an erased anchor is no longer confused for
  lost output. Second, repaint frames themselves: a redraw taller than the screen scrolls the
  previous frame's top into history on every keystroke. When — and only when — the output carries
  in-place repaint sequences (cursor up / cursor position / erase, never plain streaming), the
  recorder drops the prefix of each new batch that exactly repeats the recorded tail, so a frame is
  stored once and only the lines that genuinely scrolled for the first time are kept. Third, the
  recorder was born at a default 80x24 and only caught up with the terminal's real size on the next
  resize message, wrapping early output at a width the program never had; the session's geometry is
  now tracked server-side from the start payload onward and the emulator is created at it. A
  program erasing its own scrollback (ED 3) no longer disturbs any of this either: the sequence is
  neutralized before the emulator sees it, so the transcript survives a wipe request intact and the
  request is never mistaken for a recording gap. Genuinely repeated blocks in a plain output stream are never collapsed, and the gap path
  stays honest for the one case that remains (a single burst outrunning the emulator, whose buffer
  also grew 5,000 → 20,000 lines, sized from measured PTY chunking rather than guesswork). Session
  export reads the same store, so exports get the same clean record.

## [4.1.0] - 2026-07-20

### Fixed
- **A global install could not start, and was told there was no way to fix it.** npm exposes two
  approval mechanisms that are exact mirror images — `npm install-scripts approve` for project-scoped
  installs, `--allow-scripts=<pkgs>` for global ones — and each is rejected in the other's context.
  Having verified that `npm install-scripts` refuses a global prefix, the launcher wrongly concluded
  no mechanism existed and told users to reinstall or run node-gyp by hand. It now prints
  `npm rebuild -g --allow-scripts=node-pty,better-sqlite3`, and offers to run it.
- **`npx github:dnviti/code-agents-webcli` could not start.** npm 12 blocks dependency install
  scripts unless the *root* package.json approves them, and for an npx run that root is a file npm
  generates itself — this package has no way to influence it — so node-pty and better-sqlite3 arrived
  uncompiled. The launcher now detects that, names the actual install directory, and offers to
  approve and build them. It asks first: npm blocks those scripts as a supply-chain protection, and
  approving them runs third-party build code.
- The advice printed on that failure was wrong for every install that is not global: it named
  `$(npm root -g)/code-agents-webcli`, which for an npx run does not exist. It also recommended
  `npm rebuild`, which reports success while silently skipping the blocked packages.
- **Releases now actually happen.** `release-on-main.yml` published to npm partway through its release
  job, which 404'd on every run because trusted publishing cannot bootstrap a package that has never
  existed on the registry. Because that step sat mid-job, its failure skipped the container build,
  the GHCR push and the GitHub release, so the repository had no tags, no releases and no published
  images. npm publishing is removed; the project is distributed from git and as a container image.

### Added
- **Update checking against GitHub.** The app compares the commit it was built from against the tip
  of `main` and shows a banner when it is behind. The commit is baked into `dist/build-info.json`
  at build time, because installs come from `github:dnviti/code-agents-webcli` and resolve to
  whatever `main` HEAD is, not to the package version.
- **One-click self-update**, restricted to the first account that ever signed in. It installs, then
  runs `npm rebuild`, then verifies the new build loads, and only restarts the service if all three
  succeed. npx, container, source-checkout and unwritable-prefix installs are each refused with a
  specific reason rather than offered a button that would silently do nothing.
- **Image paste and drag-and-drop** into Claude, Codex, Cursor and terminal sessions. The image is
  written to `<working directory>/.cc-web/pasted/` and its path is typed into the prompt, followed by
  a space and no newline so you can add your question first. Type is decided by magic bytes; SVG is
  refused. 10 MB per image, removed when the session is deleted.
- **pi and Grok Build** as runtimes, with `--pi-alias` and `--grok-alias` to relabel them. Grok gets
  a Dangerous button wired to `--always-approve`; pi does not, because its `--approve` only trusts
  project-local files and is not a tool-approval bypass.

### Changed
- Toasts stack in a container instead of every toast pinning itself to the same corner coordinates,
  and carry `role`/`aria-live` so screen readers announce errors immediately and confirmations
  politely.
- Session teardown is a registry a subsystem registers with, rather than another line appended to the
  DELETE handler by every new feature.
- The service-worker cache name is derived from the build, so a new server is never paired with the
  previously cached client.
- UI strings the scrollback feature had left in Italian are now English, matching the rest of the UI.

### Security
- The paste endpoint rejects cross-origin requests. The auth cookie is `SameSite=Lax`, which is
  site-scoped rather than origin-scoped, so a sibling subdomain would otherwise reach an endpoint
  that writes a file and injects text into a PTY.
- Paste directories are created one level at a time and refused if any level is a symlink. `mkdir -p`
  follows an existing symlink, so a planted `.cc-web` could otherwise have a directory created
  through it before any later check could refuse.
- Update output is sent only to the installer's own sockets, never broadcast: npm prints absolute
  host paths.

## [3.4.0] - 2025-10-23

### Added
- **VS Code-Style Split View**: New working split view system that actually works!
  - Drag any tab to the right edge of the terminal to create a side-by-side split
  - Each split has its own independent terminal instance and WebSocket connection
  - Resizable divider between splits (drag to adjust width)
  - Keyboard shortcuts: `Ctrl+1`/`Ctrl+2` to focus splits, `Ctrl+\` to close split
  - Close button (X) in top-right of right split
  - Automatic session switching per split
  - Clean state management with localStorage persistence

### Removed
- **Broken panes.js system** (1018 lines of buggy code)
  - Removed complex grid-based tiling that had fundamental design flaws
  - Removed all pane manager code from app.js and session-manager.js
  - Removed tile HTML and CSS (~200 lines)
  - Removed "Add Pane" button from tab bar

### Fixed
- Sessions no longer get lost during split operations
- Panels can now be closed reliably
- Drag and drop now works correctly
- No more orphaned terminal instances
- No more WebSocket connection leaks
- Proper cleanup when closing splits

### Changed
- Simplified from complex N×M grid to simple 2-pane horizontal split
- Each split maintains its own terminal and connection (true independence)
- Split view is opt-in: create by dragging tabs, not auto-enabled
- Cleaner codebase: 400 lines of working code vs 1000+ lines of broken code

### Notes
- This is a complete rewrite of the split/pane system
- Much more reliable and matches VS Code behavior exactly
- All existing functionality (tabs, sessions, single-pane mode) unchanged
- Test suite: 12/12 passing

## [3.3.0] - 2025-10-23

### Fixed
- **Critical**: Fixed syntax error in `server.js` close() method causing improper indentation in agent session cleanup
- **Critical**: Fixed memory leaks in all three bridge files (claude-bridge.js, codex-bridge.js, agent-bridge.js) by properly tracking and clearing kill timeouts
- Fixed race condition in `session-store.js` where atomic rename could fail if directory was deleted between write and rename operations
- Fixed duplicate signal handlers in `server.js` that could cause double-shutdown attempts
- Removed call to undefined method `clearProcessedEntriesCache()` in `usage-reader.js`
- Removed unused `sessionCache` Map variable from `usage-reader.js`
- Added missing test coverage for agent alias in server alias tests
- Fixed test cleanup warnings by ensuring storage directory exists before save operations

### Changed
- Removed token usage top bar from UI - no longer displays real-time token statistics in the header
- Updated `applySettings()` to reflect removal of token stats visibility toggle
- Disabled `updateUsageDisplay()` and `startSessionTimerUpdate()` functions as UI elements no longer exist

### Notes
- All bug fixes are backward-compatible
- Usage statistics backend code still runs but is no longer displayed in the UI
- Test suite passing: 12/12 tests

## [3.2.2] - 2025-10-23

### Fixed
- Fixed loading spinner overlay remaining visible when showing folder browser
- Added proper overlay hiding before showing folder browser in all locations
- Resolves issue where users couldn't interact with folder browser due to stuck spinner

## [3.2.1] - 2025-10-23

### Fixed
- Corrected agent command from `claude-agent` to `cursor-agent` in AgentBridge
- Updated command search paths to use `~/.cursor/` instead of `~/.agent/`

## [3.2.0] - 2025-10-23

### Added
- Cursor Agent (`cursor-agent`) support as a third CLI option alongside Claude and Codex
- New CLI flag: `--agent-alias <name>` to customize the display name for Cursor Agent (default: "Cursor")
- New environment variable: `AGENT_ALIAS` for setting the agent alias
- "Start Cursor" button in assistant selection UI (main overlay and per-pane overlays)
- Full WebSocket message handling for `start_agent`, `agent_started`, and `agent_stopped` events
- Agent session management in `AgentBridge` with automatic command detection

### Changed
- Updated startup logs to display all three assistant aliases (Claude, Codex, Agent)
- Enhanced `/api/config` endpoint to include agent alias
- Extended session management to support three concurrent agent types per session

### Notes
- Backwards-compatible feature addition; existing Claude and Codex functionality unchanged
- Agent bridge searches for `cursor-agent` in standard paths (~/.cursor/local/cursor-agent, ~/.local/bin/cursor-agent, etc.)
- No special CLI flags required for agent (unlike Claude's `--dangerously-skip-permissions` or Codex's bypass flag)

## [3.1.0] - 2025-09-15

### Added
- Middle-click tab closing, inline rename styling, and automatic scroll-into-view for the active session tab to mirror VS Code ergonomics.

### Changed
- Session tabs now maintain explicit order and MRU history, improving Ctrl/Cmd+Tab navigation, drag reordering, and pane targeting parity with VS Code.
- Mobile overflow counters and menus refresh automatically on resize or drag, keeping hidden sessions reachable across devices.

### Fixed
- Tabs now disappear immediately when the backend deletes a session, preventing stale entries and redundant DELETE calls.

## [3.0.3] - 2025-09-14

### Fixed
- Single-pane and no-session states now use the full viewport width. Moved the global overlay out of the terminal container and made it `position: fixed` to prevent it from reserving layout space; ensured `.tile-grid` flexes to fill available width. This resolves the issue where, with zero tabs or a single pane, the pane did not span the full width.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.0] - 2025-09-13

### Added
- Tiled View (MVP): view two sessions side‑by‑side with independent terminals and sockets.
- Resizable splitter between panes with persistent split position.
- Per‑pane session picker and close controls; layout and assignments persist in localStorage.

### Changed
- Settings font size now applies to all visible panes in tiled view.

### Notes
- Client‑side only; no server/CLI changes required. Default remains single‑pane; toggle via new tile button in the top bar.

## [2.9.0] - 2025-09-13

### Added
- Theme toggle in Settings with persistence (Dark/Light).
- Early theme application to avoid flash of incorrect theme on load.

### Changed
- Default theme set to Dark; Light can be selected in Settings.

### Notes
- UI-only change; no server/CLI APIs modified.

## [2.8.0] - 2025-09-13

### Added
- Inline SVG icon system across the UI to replace emojis for a premium, minimalist look.
- New icon helper at `src/public/icons.js` for consistent, dependency‑free icons.
- Subtle status indicators using CSS dots (active/idle/error) in place of emoji glyphs.

### Changed
- Refined visual design: cohesive light palette by default, improved spacing and rhythm, and cleaner typography (Inter for UI, JetBrains Mono for terminal/stats).
- Usage rate display now uses an icon + text rather than emoji; improved readability on mobile/desktop.
- Plan modal header and action buttons now include icons; tooltips and labels simplified.
- Notifications and headings no longer use emojis; copy updated for a professional tone.
- Auth prompt UI aligned with the new palette and iconography.

### Fixed
- Prevented potential null‑element errors in plan mode indicator updates.

### Notes
- No API or CLI changes. Dark theme variables remain; switch by removing `data-theme="light"` or adding a toggle.

## [2.5.0] - 2025-08-22

### Added
- ngrok tunnel integration with `--ngrok-auth-token` and `--ngrok-domain` CLI options
- Public tunnel support for remote access to Claude Code Web interface
- Enhanced shutdown handling to properly close ngrok tunnels
- Input validation to ensure both ngrok flags are provided together

### Changed
- Improved auto-open behavior to use ngrok public URL when tunnel is active
- Enhanced error handling for ngrok tunnel establishment

### Dependencies
- Added `@ngrok/ngrok` package for tunnel functionality

## [2.4.0] - 2025-08-22

### Added
- Custom command modal for multi-line message input via "Custom..." option in commands dropdown
- Keyboard shortcut (Ctrl/Cmd + Enter) to run custom commands from the modal
- Enhanced commands dropdown interface with better user experience

### Changed
- Commands menu button repositioned from floating to anchored within terminal container
- Improved commands menu positioning and z-index handling for better integration

## [2.3.0] - 2025-08-22

### Added
- Commands menu with floating "/" button in top-right corner
- Commands API for listing and serving markdown files from ~/.claude-code-web/commands directory
- Interactive dropdown interface for browsing and executing commands
- Support for nested command directories with automatic label generation
- Command content execution directly to active Claude/Codex session

### Changed
- Enhanced user interface with new commands functionality
- Improved accessibility with dedicated commands directory structure

## [2.2.2] - 2025-08-20

### Changed
- Updated Claude Code CLI flag from `--dangerously-skip-permissions` to `--dangerously-bypass-approvals-and-sandbox`
- Updated UI text and tooltips to reflect new flag name
- Updated loading messages to match new CLI flag terminology

## [2.2.1] - 2025-08-20

### Changed
- Improved start button layout and responsive design
- Simplified button styling for better mobile experience
- Increased dialog max-width from 400px to 520px for better button layout

### Fixed
- Mobile responsiveness issues with assistant selection buttons

## [2.2.0] - 2025-08-20

### Added
- Basic test infrastructure with Mocha and unit tests

### Fixed
- Command injection vulnerability in commandExists method
- Documentation discrepancy - added missing auth.js file to README structure

### Security
- Fixed command injection vulnerability that could potentially allow malicious command execution

## [2.5.1] - 2025-08-22

### Added
- CONTRIBUTING guide with setup, testing, and PR workflow
- MIT LICENSE file

### Changed
- Enhanced README with requirements, local dev/testing instructions, and links to CONTRIBUTING and LICENSE

## [2.5.2] - 2025-08-22

### Added
- GitHub Pages single-page marketing site under `/docs` (hero, features, quick start, security, FAQ)

### Notes
- No runtime or API changes; documentation/website only

## [2.5.3] - 2025-08-22

### Changed
- Docs site: replaced HTTPS guidance with accurate ngrok options

### Fixed
- Docs site: improved mobile responsiveness and removed horizontal scrolling

## [2.1.3] - Previous Release
- Previous version baseline
## [2.6.1] - 2025-08-29

### Added
- Assistant alias support across CLI, server, and UI.
  - New CLI flags: `--claude-alias <name>` and `--codex-alias <name>`.
  - New env vars: `CLAUDE_ALIAS`, `CODEX_ALIAS`.
  - `/api/config` now returns `aliases` for the frontend.
- UI now displays configured aliases in buttons, prompts, and messages.
- Tests: added `test/server-alias.test.js` to validate server alias configuration.

### Changed
- Startup logs show configured aliases.
- README updated with alias usage examples.
## [2.11.0] - 2025-09-13

### Added
- Up to 4 panes in Tiled View with an “Add Pane” control.
- Drag a tab onto any pane to attach that session to the pane.

### Changed
- Tiled layout now distributes widths dynamically across multiple panes; resizers adjust neighboring pane widths.

### Notes
- Client-side only; no server/CLI changes. Defaults to single‑pane; toggle and expand via the top‑bar grid/plus controls.
## [2.12.0] - 2025-09-13

### Added
- Per‑split tab bars (VS Code–style): each pane now has its own tab strip.
- Add tab per split (+ button) and attach existing sessions to a split by clicking global tabs while a pane is focused.
- Drag a global tab into a split to add/activate that session in the target pane.

### Changed
- Tiled view routing: in tiled mode, global tab clicks target the focused split; single‑pane behavior unchanged when tiles are off.

### Notes
- Client‑side feature; no API/CLI changes. State (pane tabs, active tab, widths) persists locally.

## [2.13.0] - 2025-09-13

### Added
- Close Pane control: remove a split entirely (sockets cleaned up, layout reflows); clears when only one pane remains.

### Changed
- Removed focused‑pane border highlight for a cleaner look.
- In tiled mode, the global top tab bar is hidden; manage tabs per split only.
- Pane removal re-normalizes widths and rebuilds grid for consistent resizing; state persists.

### Notes
- UI‑only changes; no server/CLI surface changes.
## [2.14.0] - 2025-09-13

### Changed
- Always-on multi‑pane mode: the tiled view is now the default and only mode.
- Global top tab bar is hidden in multi‑pane; manage tabs per split.
- Removed tile view toggle button.

### Fixed
- Pane “+” button now opens a reliable session picker menu and works in every pane.

### Notes
- UI/UX change only; no server/CLI API changes.
## [2.15.0] - 2025-09-13

### Added
- Drag a pane tab to the grid’s right edge to create a new split and move the tab (VS Code‑like “drag to split”).

### Changed
- Pane tab items are now draggable between splits; dropping on another split moves the tab there.
- Pane Add Tab button opens a session picker menu consistently across panes.

### Notes
- UI‑only; no server/CLI changes.
## [2.15.1] - 2025-09-13

### Fixed
- Start‑prompt (Claude/Codex) overlay now appears in multi‑pane mode: terminal container is kept available for overlays even when panes are active.
## [2.16.0] - 2025-09-13

### Added
- Per‑pane start prompt overlay: when a session is attached to a pane and hasn’t produced output yet, the pane shows a local dialog to pick the assistant (Claude/Codex), including dangerous variants.

### Changed
- Overlays no longer rely on the single‑pane terminal; the per‑pane overlay sits within each split.

### Notes
- UI‑only; no server/CLI changes.
## [2.17.0] - 2025-09-13

### Changed
- Closing a pane tab now fully closes the session (server DELETE), removes it from all panes, and cleans up sockets/terminals.
- Pane “+” button opens the folder picker directly to create a new session; session dropdown removed.
- Session deletion events now remove the session from all pane tab strips automatically.

### Notes
- UI/behavior change only; no server/CLI API changes.

## [2.18.0] - 2025-09-13

### Added
- Tab context menus for both global tabs and per‑pane tabs:
  - Close Others
  - Split Right
  - Move to Split (choose destination split)
- Drag‑to‑split in all directions (left/right/top/bottom) with visual drop hints.
- Ctrl/Cmd‑drag to copy a tab to another split; default drag moves the tab.

### Changed
- Vertical splits supported (up to 2 rows) with a horizontal resizer; sizes persist.
- Edge‑of‑grid drops create splits on that edge; drag cursor reflects copy vs move.
- Layout persistence now includes rows, cols, and heights in `cc-web-tiles`.

### Notes
- UI‑only features; no server/CLI API changes.

## [3.0.0] - 2025-09-13

### Removed
- Custom prompts dropdown UI ("/" button, commands list, and "Custom…" modal).
- Server endpoints `GET /api/commands/list` and `GET /api/commands/content`.

### Breaking Changes
- The commands dropdown system and its APIs are no longer available. Any external automation calling `/api/commands/*` must be migrated to send content directly to the active session via WebSocket input.

### Migration Notes
- To send predefined prompts, store them in your own UI or scripts and paste/send directly to the terminal. The app will forward input to the active session as before.

## [3.0.1] - 2025-09-13

### Fixed
- Remove an empty left column gap in tiled mode by hiding the single-pane container when tiles are enabled.
- Restore per-pane assistant chooser overlay by not treating 'idle' sessions as already running.

## [3.0.2] - 2025-09-13

### Fixed
- Stabilize tiled splitting: correct index math and use insertion helpers for columns/rows.
- Reattach active sessions to terminals after grid rebuilds so sessions no longer appear to vanish.
- Honor copy vs move when dragging tabs between splits and avoid removing from the wrong source pane.
- Improve edge-of-grid splits to consistently place the tab into the intended new split.
## [3.0.4] - 2025-09-14

### Fixed
- Restore VS Code-style tab workflow: global tabs are visible in both single and tiled modes; selecting a tab targets the active pane.
- Make tiled panes optional again (no auto-enable on load); preserve pane layout and assignments across refresh via localStorage.
- Pane “+” opens a reliable session picker (Shift+click opens folder browser to create a new one).
- When attaching an existing session to a split, replay recent output buffer so tabs don’t look like “new” empty sessions.
- Remove CSS that hid tabs in tiled mode; panes fill width without interfering with the tab bar.
