import * as React from 'react';
import {
  currentMonacoTheme,
  loadMonaco,
  type MonacoHandle,
  type MonacoTheme,
} from '../../chat/monaco.js';
import { CLAIM_ATTRIBUTE } from '../../ui/browser-shortcuts.js';
import { Icon } from '../../ui/relay/Icon.js';
import { CodeEditor, type CodeEditorProps } from './CodeEditor.js';

/**
 * The file editor: Monaco, fetched on demand.
 *
 * Monaco is several megabytes and lives in its own chunk (see chat/monaco.ts),
 * so there is a window between mounting this and having an editor. That window
 * is filled by the app's own textarea editor rather than by a spinner — it is
 * already built, it already highlights, and it is already the thing that would
 * have been on screen. Someone who starts typing immediately keeps their
 * keystrokes; the swap carries the text across.
 *
 * The same editor is the fallback when the chunk cannot be fetched at all. That
 * is not a hypothetical: this app is routinely run on a LAN with no route out
 * and updated by restarting a service, so "the asset is briefly not there" is a
 * real state, and an editor that answers it with a blank rectangle would have
 * lost the file the user opened.
 *
 * Everything Monaco-specific stays in the chunk. This file owns exactly the
 * lifecycle React is responsible for: create once, push prop changes in, and
 * dispose on unmount.
 */

export interface MonacoEditorProps extends CodeEditorProps {
  /**
   * Path of the file, used only to pick a language.
   *
   * Monaco resolves it against its own registry of about ninety languages,
   * which is why the `language` prop is not enough on its own: that one carries
   * a fence name from the app's eleven-grammar highlighter, and is what the
   * fallback editor uses.
   */
  path?: string;
}

type Phase = 'loading' | 'ready' | 'failed';

export function MonacoEditor({
  value,
  onChange,
  language,
  readOnly = false,
  onSave,
  ariaLabel = 'File contents',
  height = '100%',
  path,
}: MonacoEditorProps): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const handleRef = React.useRef<MonacoHandle | null>(null);
  const [phase, setPhase] = React.useState<Phase>('loading');
  const [theme, setTheme] = React.useState<MonacoTheme>(() => {
    try {
      return currentMonacoTheme();
    } catch {
      return 'dark';
    }
  });

  // The callbacks go through refs so the editor is created exactly once. Passed
  // straight into `create`, a new `onChange` identity on every keystroke — which
  // is what an inline arrow in the caller produces — would tear the editor down
  // and rebuild it per character, losing the cursor each time.
  const onChangeRef = React.useRef(onChange);
  const onSaveRef = React.useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Held so the effect below can read the text at creation time without listing
  // it as a dependency; `value` changes on every keystroke and would otherwise
  // recreate the editor.
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const readOnlyRef = React.useRef(readOnly);
  readOnlyRef.current = readOnly;

  React.useEffect(() => {
    let live = true;

    loadMonaco().then(
      (mod) => {
        // Both guards matter: `live` for an unmount during the fetch, and the
        // host for the render that has not happened yet in between.
        if (!live || !hostRef.current) return;
        try {
          handleRef.current = mod.create(hostRef.current, {
            value: valueRef.current,
            path,
            readOnly: readOnlyRef.current,
            theme,
            ariaLabel,
            onChange: (next) => onChangeRef.current?.(next),
            onSave: () => onSaveRef.current?.(),
          });
          setPhase('ready');
        } catch {
          // A chunk that loaded but could not start an editor is the same
          // outcome for the user as one that never arrived.
          setPhase('failed');
        }
      },
      () => {
        if (live) setPhase('failed');
      },
    );

    return () => {
      live = false;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // `theme` is deliberately absent: a theme change is pushed into the live
    // editor below rather than rebuilding it. `path` is not — a different file
    // is a different editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ariaLabel]);

  // Props pushed into the live editor. Each is guarded inside the handle
  // against writing a value that is already there, because `setValue` resets
  // the cursor and the scroll position.
  React.useEffect(() => {
    handleRef.current?.setValue(value);
  }, [value]);

  React.useEffect(() => {
    handleRef.current?.setReadOnly(readOnly);
  }, [readOnly]);

  React.useEffect(() => {
    handleRef.current?.setTheme(theme);
  }, [theme]);

  // The app's theme toggle writes a class on <html>; nothing about that
  // reaches React, so this is the only way the editor hears about it. Same
  // mechanism MermaidBlock uses to re-render a diagram on a theme change.
  React.useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => setTheme(currentMonacoTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const frame: React.CSSProperties = {
    position: 'relative',
    height,
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--terminal-bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
  };

  if (phase === 'failed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          <Icon name="circle-alert" size={11} />
          The full editor could not be loaded. This is the built-in one.
        </div>
        <CodeEditor
          value={value}
          onChange={onChange}
          language={language}
          readOnly={readOnly}
          onSave={onSave}
          ariaLabel={ariaLabel}
          height={height}
        />
      </div>
    );
  }

  return (
    <div style={frame}>
      {/* Both are mounted while loading: the host has to exist for Monaco to
          attach to, and the fallback has to be the thing with focus until it
          does. The host is empty and zero-height until then, so it takes up no
          room and cannot swallow a click. */}
      <div
        ref={hostRef}
        // `data-` rather than a class: the rest of this surface styles inline,
        // and this is here for the tests and for anyone reading the DOM.
        data-monaco-host={phase}
        // Ctrl+F is the editor's find, not the browser's; Ctrl+S saves the file,
        // not the page. See ui/browser-shortcuts.ts for the whole set.
        {...{ [CLAIM_ATTRIBUTE]: 'editor' }}
        style={{
          position: 'absolute',
          inset: 0,
          visibility: phase === 'ready' ? 'visible' : 'hidden',
        }}
      />
      {phase === 'ready' ? null : (
        <div style={{ position: 'absolute', inset: 0 }}>
          <CodeEditor
            value={value}
            onChange={onChange}
            language={language}
            readOnly={readOnly}
            onSave={onSave}
            ariaLabel={ariaLabel}
            height="100%"
          />
        </div>
      )}
    </div>
  );
}
