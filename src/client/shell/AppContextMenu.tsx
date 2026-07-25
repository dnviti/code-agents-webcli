import * as React from 'react';
import { TabContextMenu, type TabMenuItem } from './TabContextMenu.js';

/**
 * The app's own right-click menu, in place of the browser's.
 *
 * The browser's menu is a page menu: Back, Reload, View Source, Save As, Inspect
 * — a list of things to do to a *document*, offered on top of an application
 * where none of them is what was meant. This replaces it with the controls that
 * are.
 *
 * ## What it deliberately does not take
 *
 * A surface that has its own menu keeps it, and says so by calling
 * `preventDefault` on the event. That is the whole protocol, and it is checked
 * rather than hardcoded so a surface added later opts out without editing this
 * file:
 *
 *   - **Monaco** has a real editor menu — cut, copy, the command palette,
 *     format — and it is better than anything here for a file you are editing.
 *   - **The terminal** turns a right-click *with a selection* into a copy, which
 *     is a gesture people already have muscle memory for, and is the only copy
 *     available on a touch device (long-press fires `contextmenu`).
 *   - **The tab strip** already has per-session actions.
 *
 * With no selection the terminal does not prevent anything, so this menu opens
 * there — which is right, because in that state there was nothing to copy and
 * the browser's menu was the only thing on offer.
 */

export interface AppContextMenuActions {
  newTab(): void;
  openSettings(): void;
  openSessions(): void;
  clearTerminal(): void;
  setTheme(theme: 'dark' | 'light'): void;
  /**
   * File actions, present only while a session with a working tree is on screen.
   *
   * Optional because this menu is also the menu on the launcher and the session
   * list, where there is no project to download anything from.
   */
  workspace?: {
    download(filePath: string): void;
    upload(directory: string): void;
  };
}

/** The folder a path sits in, or the tree root. */
function parentOf(filePath: string): string {
  const cut = filePath.lastIndexOf('/');
  return cut > 0 ? filePath.slice(0, cut) : '.';
}

export interface AppContextMenuProps {
  actions: AppContextMenuActions;
  theme: 'dark' | 'light';
  /** True while a terminal session is on screen, so its item is honest. */
  hasTerminal?: boolean;
}

interface OpenAt {
  x: number;
  y: number;
  /** What was under the pointer, so the clipboard items know what they apply to. */
  selection: string;
  editable: HTMLInputElement | HTMLTextAreaElement | null;
  /** The workspace file or folder under the pointer, if any. */
  target: WorkspaceTarget | null;
}

/** A file or folder in the session's tree, as a row declared itself. */
export interface WorkspaceTarget {
  path: string;
  kind: 'file' | 'directory';
}

/**
 * What the pointer was over, read from the row rather than from a callback.
 *
 * The tree marks its rows with `data-workspace-path`; this finds the nearest
 * one. Same shape as the `preventDefault` opt-out above — the surface declares
 * a fact about itself and this file needs to know nothing else about it.
 */
function workspaceTarget(node: EventTarget | null): WorkspaceTarget | null {
  const element = node instanceof Element ? node : null;
  const row = element?.closest('[data-workspace-path]');
  if (!row) return null;
  const path = row.getAttribute('data-workspace-path') || '';
  if (!path) return null;
  return {
    path,
    kind: row.getAttribute('data-workspace-kind') === 'directory' ? 'directory' : 'file',
  };
}

/**
 * A field a Paste could actually go into, or null.
 *
 * The clicked element first, the focused one second. A right-click does not
 * reliably move focus — and the long-press that fires `contextmenu` on a touch
 * device never does — so relying on `activeElement` alone meant the clipboard
 * items were missing from exactly the field the user was pointing at.
 */
function editableTarget(node?: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  const element = node instanceof Element ? node.closest('input, textarea') : null;
  return writableField(element) ?? writableField(document.activeElement);
}

function writableField(node: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (node instanceof HTMLTextAreaElement) return node.readOnly ? null : node;
  if (node instanceof HTMLInputElement) {
    // `type` matters: a checkbox has a selection API that does nothing.
    const textual = ['text', 'search', 'url', 'tel', 'password', 'email', ''];
    if (!node.readOnly && textual.includes(node.type)) return node;
  }
  return null;
}

/** Whether the field actually has a range selected, not just the caret in it. */
function hasSelectionIn(field: HTMLInputElement | HTMLTextAreaElement): boolean {
  return (field.selectionEnd ?? 0) > (field.selectionStart ?? 0);
}

/**
 * The selected text, wherever it is.
 *
 * `document.getSelection()` does not see inside a text field — a form control
 * keeps its own selection, and the document's is empty while the user has half
 * a sentence highlighted in the composer. Reading only the document's is why
 * Copy never appeared for the one place in this app people select text most.
 */
function selectedText(field: HTMLInputElement | HTMLTextAreaElement | null): string {
  if (field && hasSelectionIn(field)) {
    return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  }
  return String(document.getSelection() ?? '');
}

export function AppContextMenu({
  actions,
  theme,
  hasTerminal = false,
}: AppContextMenuProps): React.JSX.Element | null {
  const [open, setOpen] = React.useState<OpenAt | null>(null);

  React.useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      // A surface with its own menu has already claimed this. Checking the flag
      // rather than a list of selectors is what keeps this file from needing to
      // know about every surface in the app.
      if (event.defaultPrevented) return;

      event.preventDefault();
      // The field under the pointer, not merely the focused one: a right-click
      // does not always move focus, and on a touch device the long-press that
      // fires this never does.
      const editable = editableTarget(event.target);
      setOpen({
        x: event.clientX,
        y: event.clientY,
        selection: selectedText(editable),
        editable,
        target: workspaceTarget(event.target),
      });
    };

    // Bubble phase, on purpose: every surface that wants to handle its own
    // right-click gets the event first, and its `preventDefault` is the signal
    // above. Capturing would take the decision away from all of them.
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);

  const close = React.useCallback(() => setOpen(null), []);

  if (!open) return null;

  const items: TabMenuItem[] = [];

  if (open.selection.trim()) {
    items.push({
      label: 'Copy',
      icon: 'copy',
      onSelect: () => {
        void navigator.clipboard?.writeText(open.selection);
      },
    });
  }

  // Cut only where there is somewhere for the text to be cut *from*. Offered on
  // a selection inside a writable field, which is the only case where removing
  // it is something this page can actually do.
  if (open.editable && open.selection.trim() && hasSelectionIn(open.editable)) {
    const field = open.editable;
    items.push({
      label: 'Cut',
      icon: 'scissors',
      onSelect: () => {
        const start = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? 0;
        void navigator.clipboard?.writeText(field.value.slice(start, end)).then(() => {
          field.setRangeText('', start, end, 'end');
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.focus();
        });
      },
    });
  }

  if (open.editable) {
    const field = open.editable;
    items.push({
      label: 'Paste',
      icon: 'clipboard-paste',
      onSelect: () => {
        // Only ever offered for a focused, writable text field: a page cannot
        // paste into an arbitrary surface, and an item that silently did
        // nothing would be worse than no item.
        void navigator.clipboard?.readText().then((text) => {
          if (!text) return;
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? start;
          field.setRangeText(text, start, end, 'end');
          // React listens for `input`, not for a programmatic value write, so
          // without this the field shows the text and the component does not
          // know it is there.
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.focus();
        });
      },
    });
    items.push({
      label: 'Select all',
      icon: 'layout-list',
      onSelect: () => field.select(),
    });
  }

  // Acting on the thing that was right-clicked, before the app-wide actions.
  // A menu whose first item is about the pointer and whose last is about the
  // whole app is the order every file manager uses.
  if (open.target && actions.workspace) {
    const workspace = actions.workspace;
    const target = open.target;
    const separated = items.length > 0;

    if (target.kind === 'file') {
      items.push({
        label: 'Download',
        icon: 'download',
        separated,
        onSelect: () => workspace.download(target.path),
      });
    }

    items.push({
      // A file's own folder, so "upload here" means the folder you can see it
      // in — right-clicking a file to put another one beside it is the gesture,
      // and making the user find the parent row first would be a worse one.
      label: target.kind === 'directory' ? 'Upload into this folder…' : 'Upload into this folder…',
      icon: 'upload',
      separated: separated && target.kind !== 'file',
      onSelect: () =>
        workspace.upload(
          target.kind === 'directory' ? target.path : parentOf(target.path),
        ),
    });
  }

  if (hasTerminal) {
    items.push({
      label: 'Clear the terminal',
      icon: 'eraser',
      separated: items.length > 0,
      onSelect: actions.clearTerminal,
    });
  }

  items.push(
    {
      label: 'New session',
      icon: 'plus',
      separated: items.length > 0,
      onSelect: actions.newTab,
    },
    { label: 'All sessions…', icon: 'layout-list', onSelect: actions.openSessions },
    { label: 'Settings…', icon: 'settings', separated: true, onSelect: actions.openSettings },
    {
      label: theme === 'dark' ? 'Light theme' : 'Dark theme',
      icon: theme === 'dark' ? 'monitor' : 'monitor',
      onSelect: () => actions.setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    {
      label: 'Reload the app',
      icon: 'rotate-cw',
      separated: true,
      onSelect: () => window.location.reload(),
    },
  );

  return (
    <TabContextMenu
      x={open.x}
      y={open.y}
      items={items}
      label="Application actions"
      onClose={close}
    />
  );
}
