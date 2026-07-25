import * as React from 'react';
import {
  PermissionOption,
  PermissionRequest,
  ToolKind,
  isAllowOption,
} from '../../../shared/chat-events.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Button, ButtonVariant } from '../../ui/relay/Button.js';
import { Icon, IconName } from '../../ui/relay/Icon.js';
import { DiffView } from './DiffView.js';

/**
 * A blocking approval prompt in the middle of the transcript.
 *
 * The agent is stalled until one of these buttons is pressed — there is no
 * timeout and nothing else the user can do to unstick the turn — so unlike
 * every other card in chat mode this one must not be missable, must not be
 * dismissible by accident (Escape closes dialogs everywhere else in this app;
 * here there is nothing to close *to*), and must answer "what did I just
 * agree to" after the fact, because the alternative is a card that vanishes
 * the instant it is clicked and leaves no record in the scrollback.
 */

export interface PermissionCardProps {
  request: PermissionRequest;
  onRespond: (requestId: string, optionId: string) => void;
  /** True while the response is in flight to the server. */
  busy?: boolean;
}

const TOOL_ICON: Record<ToolKind, IconName> = {
  read: 'file-text',
  edit: 'pencil',
  delete: 'trash-2',
  move: 'arrow-right',
  search: 'search',
  execute: 'terminal',
  think: 'brain',
  fetch: 'download',
  task: 'bot',
  todo: 'list-todo',
  other: 'wrench',
};

const OPTION_ORDER: Record<PermissionOption['kind'], number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

const OPTION_VARIANT: Record<PermissionOption['kind'], ButtonVariant> = {
  allow_once: 'primary',
  allow_always: 'secondary',
  reject_once: 'outline',
  reject_always: 'destructive',
};

const OPTION_ICON: Record<PermissionOption['kind'], IconName> = {
  allow_once: 'check',
  allow_always: 'check',
  reject_once: 'circle-x',
  reject_always: 'circle-x',
};

export function PermissionCard({ request, onRespond, busy = false }: PermissionCardProps) {
  // Chosen locally and kept forever: the server-side pendingPermissions list
  // drops the request the instant it resolves, which would make the card
  // disappear mid-scrollback if it depended on that list to know what to
  // render. Recording the choice here is what turns "the request vanished"
  // into "the transcript shows what was decided".
  const [decided, setDecided] = React.useState<PermissionOption | null>(null);

  const options = React.useMemo(
    () => [...request.options].sort((a, b) => (OPTION_ORDER[a.kind] ?? 4) - (OPTION_ORDER[b.kind] ?? 4)),
    [request.options],
  );
  const firstAllow = options.find(isAllowOption);

  const respond = (option: PermissionOption) => {
    if (decided || busy) return;
    setDecided(option);
    onRespond(request.requestId, option.optionId);
  };

  // Escape closes every dialog in this app, but this card is not a dialog —
  // there is no prior state to fall back to, only an agent sitting idle. A
  // stray Escape here must do nothing rather than look like it dismissed
  // something that is, in fact, still blocked.
  const swallowEscape = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') event.stopPropagation();
  };

  const preview = describeInput(request.input, request.toolKind);

  return (
    <div
      role="group"
      aria-label={`Permission request: ${request.title}`}
      onKeyDown={swallowEscape}
      style={{
        border: '1px solid var(--warning)',
        background: 'var(--card)',
        display: 'grid',
        gap: 10,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Icon name="shield" size={16} style={{ color: 'var(--warning)', marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 'var(--text-body)',
                fontWeight: 'var(--font-semibold)',
                color: 'var(--foreground)',
              }}
            >
              {request.title}
            </span>
            <Badge variant="outline" style={{ gap: 4 }}>
              <Icon name={TOOL_ICON[request.toolKind] || 'wrench'} size={10} />
              {request.toolKind}
            </Badge>
          </div>
          {request.reason ? (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
              {request.reason}
            </p>
          ) : null}
        </div>
      </div>

      {request.diffs && request.diffs.length > 0 ? (
        <DiffView diffs={request.diffs} />
      ) : preview ? (
        <InputPreview preview={preview} />
      ) : null}

      {decided ? (
        <Resolved option={decided} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {options.map((option) => (
            <Button
              key={option.optionId}
              variant={OPTION_VARIANT[option.kind] || 'outline'}
              size="sm"
              disabled={busy}
              autoFocus={firstAllow ? option.optionId === firstAllow.optionId : false}
              iconLeft={<Icon name={OPTION_ICON[option.kind] || 'circle'} size={12} />}
              onClick={() => respond(option)}
            >
              {option.name}
            </Button>
          ))}
          {busy ? (
            <span
              role="status"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 'var(--text-2xs)',
                color: 'var(--muted-foreground)',
              }}
            >
              <Icon
                name="loader-circle"
                size={11}
                style={{ animation: 'relay-pulse 1s var(--ease-standard) infinite' }}
              />
              Sending…
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Resolved({ option }: { option: PermissionOption }) {
  const allowed = isAllowOption(option);
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 'var(--text-sm)',
        color: allowed ? 'var(--success)' : 'var(--destructive)',
      }}
    >
      <Icon name={allowed ? 'check' : 'circle-x'} size={13} />
      <span>
        {allowed ? 'Approved' : 'Denied'} — <span style={{ color: 'var(--muted-foreground)' }}>{option.name}</span>
      </span>
    </div>
  );
}

interface InputPreviewData {
  kind: 'command' | 'path' | 'json';
  text: string;
}

function InputPreview({ preview }: { preview: InputPreviewData }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '8px 10px',
        border: '1px solid var(--border)',
        background: 'var(--terminal-bg)',
        color: 'var(--terminal-fg)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        lineHeight: 'var(--leading-terminal)',
        overflowX: 'auto',
        whiteSpace: preview.kind === 'json' ? 'pre' : 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      {preview.kind === 'command' ? <span style={{ color: 'var(--terminal-prompt)' }}>$ </span> : null}
      {preview.text}
    </pre>
  );
}

/**
 * Best-effort read of what a runtime is asking permission for.
 *
 * `input` is `unknown` by contract (every adapter reports it differently), so
 * this only ever narrows — it never assumes a shape and always has a fallback
 * that still shows *something* rather than an empty approval card.
 */
function describeInput(input: unknown, toolKind: ToolKind): InputPreviewData | null {
  if (input === undefined || input === null) return null;

  if (typeof input === 'string') {
    return { kind: toolKind === 'execute' ? 'command' : 'path', text: input };
  }

  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const command = firstString(obj.command, obj.cmd, obj.script);
    if (command !== undefined) {
      const args = Array.isArray(obj.args) ? obj.args.filter((a) => typeof a === 'string') : [];
      return { kind: 'command', text: [command, ...args].join(' ') };
    }
    const path = firstString(obj.path, obj.file, obj.filePath, obj.target, obj.url);
    if (path !== undefined) return { kind: 'path', text: path };
  }

  try {
    return { kind: 'json', text: JSON.stringify(input, null, 2) };
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
