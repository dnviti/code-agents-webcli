import * as React from 'react';
import { ROLE_COLOR_VAR, highlight } from '../../chat/highlight.js';

/**
 * A syntax-highlighted text editor, built out of a textarea.
 *
 * Three layers pinned on top of each other: a line-number gutter, a `<pre>`
 * holding the highlighted tokens, and a transparent `<textarea>` in front doing
 * all of the actual editing. The browser keeps the caret, selection, undo
 * history, IME composition, spell-check suppression, autoscroll-on-type and
 * every keyboard convention a text field has — none of which is worth
 * reimplementing, and all of which a hand-rolled editor gets subtly wrong.
 *
 * The alternative was CodeMirror or Monaco. Either would be several hundred
 * kilobytes shipped to every session for a panel that opens a file, in an app
 * that vendors its assets specifically because it is routinely run on a LAN
 * with no route to a CDN. The highlighter is already here for chat code blocks
 * and already themed against the terminal palette; this reuses it.
 *
 * The invariant that makes the illusion hold is that the `<pre>` and the
 * `<textarea>` lay text out identically — same font, size, line height,
 * padding, tab size and wrapping. Everything shared is in ONE object below
 * rather than repeated, because the failure mode of a drift is the highlight
 * sliding out from under the caret, which looks like a rendering bug.
 */

export interface CodeEditorProps {
  value: string;
  onChange?: (next: string) => void;
  /** Fence language for the highlighter; null renders plain monospace. */
  language?: string | null;
  readOnly?: boolean;
  /** Ctrl/Cmd+S, wired here so it works wherever the caret is. */
  onSave?: () => void;
  ariaLabel?: string;
  height?: React.CSSProperties['height'];
  /** One-based line to reveal on the first paint. */
  initialLine?: number;
}

/**
 * Past this, highlighting is skipped and the text renders plain.
 *
 * The tokenizer runs over the whole document on every keystroke. On a file this
 * size that is the difference between typing and waiting, and an editor that
 * stutters is worse than one that is monochrome.
 */
const HIGHLIGHT_LIMIT = 120_000;

/** What a Tab inserts. Two spaces, matching this repo's own source. */
const INDENT = '  ';

const SHARED: React.CSSProperties = {
  margin: 0,
  padding: '8px 12px',
  border: 'none',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-terminal)',
  // `pre` keeps long lines long and lets the pair scroll sideways together.
  // Wrapping would have to wrap identically in both layers, which it does not
  // reliably do across engines once a token boundary lands mid-word.
  whiteSpace: 'pre',
  tabSize: 2,
  letterSpacing: 'normal',
  wordBreak: 'normal',
  overflowWrap: 'normal',
};

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  onSave,
  ariaLabel = 'File contents',
  height = '100%',
  initialLine,
}: CodeEditorProps): React.JSX.Element {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const preRef = React.useRef<HTMLPreElement | null>(null);
  const gutterRef = React.useRef<HTMLDivElement | null>(null);

  const tokens = React.useMemo(() => {
    if (value.length > HIGHLIGHT_LIMIT) return [{ text: value, role: null as null }];
    return highlight(value, language ?? null);
  }, [value, language]);

  const lineCount = React.useMemo(() => {
    let lines = 1;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) === 10) lines += 1;
    }
    return lines;
  }, [value]);

  // `ch` rather than a pixel guess: the gutter has to fit the digits at
  // whatever size the user's monospace font renders them, and 8px-per-digit is
  // only true for one font at one size.
  const gutterDigits = Math.max(2, String(lineCount).length);

  // The textarea is the only thing that scrolls; the other two layers are
  // pushed to match. Doing it the other way around — a wrapper that scrolls
  // with a content-sized textarea — means measuring the text to size the
  // textarea, which is the measurement this whole approach exists to avoid.
  const syncScroll = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { scrollTop, scrollLeft } = textarea;
    // Translated, not scrolled. Setting `scrollLeft` on the <pre> clamps it to
    // that element's own maximum, and the textarea's maximum is larger by the
    // width of its vertical scrollbar — so at the end of a long line the
    // highlight came to rest a scrollbar-width to the right of the caret.
    // A transform has no maximum to clamp against.
    if (preRef.current) {
      preRef.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
  }, []);

  // A programmatic value change (opening a different file, reverting) moves the
  // textarea's scroll without firing a scroll event, so the layers are realigned
  // whenever the text itself changes as well as on every scroll.
  React.useEffect(syncScroll, [value, syncScroll]);

  React.useEffect(() => {
    if (initialLine === undefined) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const line = Math.min(lineCount, Math.max(1, Math.trunc(initialLine) || 1));
    let offset = 0;
    for (let current = 1; current < line; current++) {
      const newline = value.indexOf('\n', offset);
      if (newline === -1) break;
      offset = newline + 1;
    }
    textarea.setSelectionRange(offset, offset);

    // Native textareas reveal a programmatic caret only once focused. This
    // fallback must not steal focus from the dialog, so position its scroller
    // directly and then move the highlight/gutter layers to match.
    const measured = typeof getComputedStyle === 'function'
      ? Number.parseFloat(getComputedStyle(textarea).lineHeight)
      : Number.NaN;
    const lineHeight = Number.isFinite(measured) ? measured : 18;
    textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - (textarea.clientHeight - lineHeight) / 2);
    syncScroll();
    // The value deliberately is not a dependency: typing after opening at a
    // line must not snap the cursor back there on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLine, syncScroll]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // `!event.altKey` is not cosmetic: AltGr reports as ctrl+alt on Windows and
    // Linux layouts, so AltGr+S would otherwise be swallowed as a save — the
    // same guard the terminal's clipboard chords already carry.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      // The browser's "save page" is never what someone editing a file in a
      // code editor meant by Ctrl+S.
      event.preventDefault();
      onSave?.();
      return;
    }

    if (event.key !== 'Tab' || event.altKey || event.metaKey || event.ctrlKey) return;

    // A read-only view has nothing to indent, so Tab keeps its usual job and
    // moves focus. Swallowing it there would trap a keyboard user inside a
    // field they cannot even type into.
    if (readOnly) return;

    const textarea = event.currentTarget;
    const { selectionStart, selectionEnd } = textarea;

    // While editing, Tab is the indent key — that is what a code editor is for.
    // Escape is the way out: it closes the dialog (asking first if there is
    // unsaved work), and Ctrl/Cmd+S saves without reaching for the button, so
    // nobody is stranded in here without a pointer.
    event.preventDefault();

    if (selectionStart === selectionEnd && !event.shiftKey) {
      const next = `${value.slice(0, selectionStart)}${INDENT}${value.slice(selectionEnd)}`;
      onChange?.(next);
      // Restored after React has written the new value back, or the browser
      // puts the caret at the end of the field.
      requestAnimationFrame(() => {
        textarea.selectionStart = selectionStart + INDENT.length;
        textarea.selectionEnd = selectionStart + INDENT.length;
      });
      return;
    }

    // A selection indents or outdents whole lines, which is what every editor
    // does and what makes Tab useful on more than one line at a time.
    const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const end = value.indexOf('\n', selectionEnd);
    const stop = end === -1 ? value.length : end;
    const block = value.slice(start, stop);

    const shifted = event.shiftKey
      // One tab *or* up to two spaces. `[ \t]{1,2}` ate two tabs, outdenting a
      // tab-indented file by two levels for one press.
      ? block.replace(/^(?:\t| {1,2})/gm, '')
      : block.replace(/^/gm, INDENT);
    if (shifted === block) return;

    onChange?.(`${value.slice(0, start)}${shifted}${value.slice(stop)}`);

    // The first line of the block moved too, so the anchor has to move with it
    // — otherwise the selection walks off the first line, and after a press or
    // two that line stops being indented at all.
    const firstLineDelta =
      shifted.slice(0, shifted.indexOf('\n') === -1 ? shifted.length : shifted.indexOf('\n')).length -
      block.slice(0, block.indexOf('\n') === -1 ? block.length : block.indexOf('\n')).length;
    const delta = shifted.length - block.length;
    requestAnimationFrame(() => {
      textarea.selectionStart = Math.max(start, selectionStart + firstLineDelta);
      textarea.selectionEnd = Math.max(textarea.selectionStart, selectionEnd + delta);
    });
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        height,
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--terminal-bg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          width: `calc(${gutterDigits}ch + 14px)`,
          overflow: 'hidden',
          position: 'relative',
          background: 'var(--muted)',
          borderRight: '1px solid var(--border)',
          userSelect: 'none',
        }}
      >
        <div
          ref={gutterRef}
          style={{
            ...SHARED,
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            textAlign: 'right',
            color: 'var(--muted-foreground)',
            paddingLeft: 6,
            paddingRight: 8,
            willChange: 'transform',
          }}
        >
          {Array.from({ length: lineCount }, (_, i) => `${i + 1}\n`).join('')}
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <pre
          ref={preRef}
          aria-hidden="true"
          style={{
            ...SHARED,
            position: 'absolute',
            top: 0,
            left: 0,
            // Sized by its content, not by the box: the transform above moves
            // it, so it must be free to be wider and taller than what shows.
            minWidth: '100%',
            pointerEvents: 'none',
            color: 'var(--terminal-fg)',
            willChange: 'transform',
          }}
        >
          {tokens.map((token, i) =>
            token.role ? (
              <span key={i} style={{ color: `var(${ROLE_COLOR_VAR[token.role]})` }}>
                {token.text}
              </span>
            ) : (
              <React.Fragment key={i}>{token.text}</React.Fragment>
            ),
          )}
          {/* A trailing newline leaves the last line with no box to sit in, so
              the highlight ends one line above the caret. */}
          {'\n'}
        </pre>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label={ariaLabel}
          aria-readonly={readOnly || undefined}
          data-initial-line={initialLine}
          style={{
            ...SHARED,
            position: 'relative',
            width: '100%',
            height: '100%',
            resize: 'none',
            outline: 'none',
            overflow: 'auto',
            background: 'transparent',
            // The text itself is invisible; what the user reads is the <pre>
            // behind it. The caret and the selection are the parts that must
            // stay visible, and both are styled independently of `color`.
            color: 'transparent',
            caretColor: 'var(--terminal-fg)',
          }}
        />
      </div>
    </div>
  );
}
