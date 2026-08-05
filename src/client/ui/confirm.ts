import { shellStore } from '../shell/store';
import { getControllerSnapshot, parseQualifiedSessionId } from '../controller/transport';

/**
 * The app's own replacement for `window.confirm`.
 *
 * The native dialog is the one piece of UI this app cannot style, cannot place,
 * and cannot theme: it renders in the browser's chrome, in the browser's
 * colours, with the browser's buttons. On a phone-shaped install pretending to
 * be an app it reads as a page hijack rather than a question the app asked.
 *
 * The signature is deliberately the same shape as `confirm` — ask, await a
 * boolean — so a call site converts by adding `await` rather than by growing
 * dialog state of its own.
 */

export interface ConfirmOptions {
  title: string;
  /** The body. Kept to one or two sentences; this is a question, not a page. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button destructive, for irreversible actions. */
  tone?: 'default' | 'danger';
  /** Defaults to the selected server in controller mode; desktop/none suppress it. */
  scope?: 'server' | 'desktop' | 'none';
  /** Qualified session whose owning server must be named instead of global selection. */
  sessionId?: string;
  /** Exact server for a server-owned action that is not tied to a session. */
  serverId?: string;
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve(confirmed: boolean): void;
}

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  const previous = shellStore.getSnapshot().confirm;
  // A second question replaces the first rather than stacking. The pending
  // promise is settled as declined so whoever is awaiting it stops waiting —
  // an unsettled promise here would strand that call site forever.
  previous?.resolve(false);

  return new Promise<boolean>((resolve) => {
    const controller = getControllerSnapshot();
    const sessionOwner = options.sessionId
      ? parseQualifiedSessionId(options.sessionId)?.serverId : null;
    const scopedServerId = options.serverId || sessionOwner || controller.selectedServerId;
    const target = controller.enabled && (options.scope ?? 'server') === 'server'
      ? controller.targets.find((item) => item.id === scopedServerId) : null;
    const scopeText = target ? `Server: ${target.name}.` : '';
    const description = [options.description, scopeText].filter(Boolean).join(' ');
    shellStore.setState({
      confirm: {
        ...options,
        ...(description ? { description } : {}),
        resolve,
      },
    });
  });
}

/** Answer the open question. Safe to call when there is none. */
export function resolveConfirm(confirmed: boolean): void {
  const request = shellStore.getSnapshot().confirm;
  if (!request) return;
  shellStore.setState({ confirm: null });
  request.resolve(confirmed);
}
