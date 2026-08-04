# Using the terminal

Sessions, scrollback, copy/paste, images, and the parts built for a phone.

## Sessions

A session is a running agent or shell plus everything recorded about it: its
working directory, its scrollback, its transcript. Sessions are **per user** —
you only ever see your own — and they survive a reload, a new tab, or a
different device.

What they do not survive is the server restarting: the record, the history and
the transcript all persist, but the live process is gone. A restarted session
shows as ended and can be launched again.

Open several and switch between them from the tab bar. Sessions can also be
[split side by side](#splits).

Closing a tab means different things for the two surfaces, because the two are
reached differently. Closing a **terminal** ends it — a shell has no listing of
its own, so one left running with no tab would hold a working directory open
with nothing able to reach it. Closing a **conversation** only takes it off this
screen: it stays in [the conversation list](runtimes.md#finding-a-conversation-again),
which is where it is reopened from. Deleting, which asks first, is the only way
to lose either.

## Scrollback and history

Long sessions used to bog the browser down: the terminal held a 20,000-line
buffer, reflowed all of it on every resize, and repainted fully on every
streamed chunk.

Now the live terminal keeps only the recent tail. Everything older is rebuilt
server-side and paged in a screen at a time, so scrolling back costs the same
whether the session is a minute or a week old.

- The server runs a **headless copy of the same terminal emulator** the browser
  runs, and freezes each line as it scrolls off. Those lines go to an
  append-only log with a fixed-width index, so fetching "lines 812,340 to
  812,390" is two positioned reads.
- **Scroll to the top** of the live buffer — or keep scrolling up once you are
  there — to enter the history viewer. Scroll to the bottom, press `Escape`, or
  use **Back to live** to come back.
- **Full-screen programs are not recorded.** The alternate screen buffer is
  isolated, so a TUI redrawing itself does not fill your history with frames.
- **Download .md** in the history bar exports the whole session as Markdown,
  ANSI stripped, streamed page by page. Also available at
  `GET /api/sessions/<id>/export.md`.

Known limits:

- Lines are wrapped at the width the terminal was rendering at. Viewing from a
  window of a different width shows that wrapping, not yours.
- Oldest lines are dropped past a per-session cap (200,000 lines by default).
  Line numbers stay absolute, and the viewer tells you how many were dropped.
- If a program emits more scrollback in one burst than the emulator holds, the
  gap is recorded rather than passed over silently.
- Text selection inside the history viewer is not supported yet — use the
  Markdown export to get content out.
- A scrollback emulator costs roughly 2 MB per running session, released when
  the process exits, the session is deleted, or the server shuts down.

## Copy and paste

Agents turn on full mouse tracking, and the terminal paints to a canvas rather
than to DOM text, so an ordinary drag does not select anything — the drag goes
to the program.

| To | Do |
| --- | --- |
| Select text | **Hold Shift** while dragging |
| Copy the selection | `Ctrl+Shift+C`, or the right-click menu |
| Paste | `Ctrl+Shift+V`, or the right-click menu |

`Ctrl+C` is left alone deliberately — it stays the interrupt signal, which is
what you want far more often than a copy.

Copy and paste need a **secure context**, which is one of the reasons the server
[insists on HTTPS](https-and-certificates.md). On a browser that withholds the
clipboard API, the app falls back rather than failing silently.

## Pasting images

Paste an image into a terminal, or drag one onto it, and it is written into the
session's working directory; the path is then typed into the prompt for the
agent to read. On a phone, **Attach Image** in the menu opens the picker.

Nothing is submitted for you: the path arrives followed by a single space, so
you can say what you want done with it before pressing Enter.

- Files land in `<working directory>/.cc-web/pasted/`. That location is
  deliberate — it is the only place all the agent CLIs read without a permission
  prompt, since Claude Code asks before reading outside its working directory and
  a sandboxed Codex can refuse outright.
- A `.gitignore` is written inside `.cc-web/`, so the images never show up in
  `git status`. Your own `.gitignore` is never touched, and if you edit the
  generated one your version is kept.
- Images are deleted when the session is deleted.
- PNG, JPEG, GIF, WebP and BMP are accepted, decided **by content** rather than
  by filename or the type the browser claims. SVG is refused: it has no magic
  number and can carry script.
- The cap is 10 MB per image. Behind nginx you need `client_max_body_size 10m;`
  or the upload fails at the proxy.

Known limits:

- iPhone photo libraries hand over HEIC unless the browser converts it. HEIC is
  refused, with a message saying so.
- Every session on the host runs as the same OS user, so someone who points a
  session at another user's working directory can read images pasted there. This
  is the same boundary as the rest of the app — anyone signed in can already open
  a shell — but it is worth stating.
- Text pasting is untouched: an event with no image in it is left entirely to the
  terminal.

## Splits

Terminals can be arranged side by side, VS Code style. Each pane is a real,
independent session with its own connection — not a view onto a shared one.

## On a phone

- **On-screen key strip** — a persistent row with `Ctrl`, `Esc`, `Tab` and arrow
  keys. `Ctrl` is a one-shot latch rather than a chord: tap it, then tap the
  letter. Arrows repeat on a long press.
- **The OS keyboard stays down** until you ask for it, so tapping the terminal to
  scroll does not throw a keyboard over half the screen.
- **Touch scrolling belongs to the terminal**, including into history.
- **Tab sheet** for switching sessions with a thumb.
- **Attach Image** in the menu, for the photo picker.

## Install it as an app

The UI is a PWA. Where the browser supports it, an **Install** action appears in
the More sheet, in Settings, and in the command palette.

On supported desktop browsers, an installed window uses the native title-bar
space for the existing session strip. The operating system still owns the real
window controls; drag the small **Code Agents** block to move the window. Tabs,
New session, the command palette, theme, usage, settings and sign-out remain
ordinary controls. At narrow widths the fixed actions move into the **More
title bar actions** menu before tabs give up their scrolling space.

The integration follows the browser's live title-bar setting. Turning Window
Controls Overlay off immediately restores the ordinary standalone layout, and
turning it back on restores the integrated strip without reloading or losing
session state. Browsers and installed apps without this API silently keep the
ordinary layout.

On iOS there is no install API — use Safari's share sheet → **Add to Home
Screen**.

If installing is unavailable, the app says why. Almost always it is one of:

- the origin is plain http, or
- the certificate is not trusted on this device, so the service worker never
  became ready.

Both are [the same fix](https-and-certificates.md#trusting-the-ca-once-per-device).

## Appearance

**Settings** offers five themes — GitHub Dark, Dark Dimmed, Dark High Contrast,
Light and Light High Contrast — and the terminal palette follows the app theme
automatically.

Eight terminal fonts are bundled, including four Nerd Font variants (Cascadia
Code, Hack, Meslo, Sauce Code Pro) for powerline segments and icon glyphs that
agent CLIs like to print. Font size is adjustable from 10 to 24 px.

Fonts are served from the app, not from a CDN — this app is routinely run on a
LAN with no outbound internet.
