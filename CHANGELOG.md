# Changelog

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
