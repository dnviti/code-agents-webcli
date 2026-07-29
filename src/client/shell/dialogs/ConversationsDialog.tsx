import * as React from 'react';

import {
  conversationLabel,
  countConversations,
  filterConversations,
  withoutConversation,
  type ConversationList,
  type ConversationProject,
  type ConversationSummary,
} from '../../../shared/conversations';
import { Badge } from '../../ui/relay/Badge';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { IconButton } from '../../ui/relay/IconButton';
import { Input } from '../../ui/relay/Input';
import { PHONE_SPACE, PHONE_TEXT, TOUCH_TARGET, usePhone } from '../../ui/touch';

/**
 * Every conversation you have, grouped by project, narrowed by typing.
 *
 * The app had nowhere that answered "what conversations do I have?". Every
 * conversation came back as an open tab, so the strip grew until it was
 * unreadable, and the only way to shorten it destroyed something you might want
 * next week. The one list of past conversations was inside the launcher, reachable
 * only on the way to starting a *new* session in a folder already chosen — so you
 * had to know which project a conversation belonged to before you could look for
 * it, and there was nothing to type into (#127).
 *
 * Three decisions shape what follows.
 *
 * **A row is what was asked, not when it happened.** "che file ho caricato?"
 * identifies a conversation on sight; "Session 25/07/2026, 21:35" identifies
 * nothing, which is why a column of timestamps was never worth showing. The
 * timestamp is detail beside it, with the agent and whether it is running.
 *
 * **The grouping comes from the server.** Which project a conversation belongs to
 * and what order the projects come in are decisions, not rendering, and they are
 * taken once — see `/api/sessions/conversations`. This component groups nothing;
 * it draws groups.
 *
 * **A group with no match disappears.** Searching across a dozen projects has to
 * read as a short list, and a page of folder headings with nothing under them is
 * the opposite of that. Searching also opens every surviving group, because a
 * match hidden inside a collapsed one is a search that answered nothing.
 */

export interface ConversationsDialogProps {
  open: boolean;
  /**
   * Read the list.
   *
   * Injected rather than fetched here so this component can be driven by a test
   * with three hundred conversations in it without a server, and so the
   * authenticated fetch stays in one place. Called each time the dialog opens —
   * never cached — because a conversation may have been started, finished or
   * deleted in another window since the last look.
   */
  load(): Promise<ConversationList>;
  /** Session ids this browser already has a tab for, so a row can say so. */
  openIds?: readonly string[];
  /** The tab in focus, when it is one of these. */
  activeId?: string | null;
  onOpen(conversation: ConversationSummary): void;
  /**
   * Ask, delete, and resolve true when the conversation is actually gone.
   *
   * The confirmation belongs to the caller because it is the caller that knows
   * this is irreversible and owns the app's confirm dialog. False — declined, or
   * refused by the server — leaves the row exactly where it was.
   */
  onDelete(conversation: ConversationSummary): Promise<boolean> | boolean;
  onClose(): void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; list: ConversationList }
  | { status: 'error'; message: string };

const NO_COLLAPSE: ReadonlySet<string> = new Set<string>();

export function ConversationsDialog({
  open,
  load,
  openIds,
  activeId,
  onOpen,
  onDelete,
  onClose,
}: ConversationsDialogProps): React.JSX.Element | null {
  const isPhone = usePhone();
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(NO_COLLAPSE);
  // Bumped by Reload. A separate value from `open` so re-reading does not also
  // throw away what the user has typed.
  const [reload, setReload] = React.useState(0);

  // A query and a set of folded groups belong to one visit. Left behind, a search
  // typed last time would open the dialog showing three of two hundred
  // conversations with no obvious reason why.
  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setCollapsed(NO_COLLAPSE);
  }, [open]);

  // Held in a ref rather than depended on.
  //
  // The effect below sets state, which re-renders — so a caller that passes an
  // inline `load` would hand this a new identity on that render, re-run the
  // effect, and set state again, forever. The dialog's own trigger for re-reading
  // is `reload`, deliberately, and nothing else should be able to become one.
  const loader = React.useRef(load);
  loader.current = load;

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ status: 'loading' });
    Promise.resolve()
      .then(() => loader.current())
      .then((list) => {
        if (live) setState({ status: 'ready', list });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Your conversations could not be listed',
        });
      });
    return () => {
      live = false;
    };
  }, [open, reload]);

  const remove = React.useCallback(
    (conversation: ConversationSummary) => {
      void Promise.resolve(onDelete(conversation)).then((gone) => {
        if (!gone) return;
        setState((current) =>
          current.status === 'ready'
            ? { status: 'ready', list: withoutConversation(current.list, conversation.id) }
            : current,
        );
      });
    },
    [onDelete],
  );

  const toggleGroup = React.useCallback((dir: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  if (!open) return null;

  const all = state.status === 'ready' ? state.list.projects : [];
  const searching = query.trim().length > 0;
  const visible = filterConversations(all, query);
  const shown = countConversations(visible);
  const total = state.status === 'ready' ? state.list.total : 0;
  const withTabs = new Set(openIds ?? []);

  return (
    <Dialog
      open={open}
      title="Conversations"
      placement={isPhone ? 'bottom' : 'center'}
      width={640}
      bodyFill
      onClose={onClose}
      headerActions={
        <IconButton
          label="Read the list again"
          onClick={() => setReload((value) => value + 1)}
          disabled={state.status === 'loading'}
        >
          <Icon name="rotate-cw" size={14} />
        </IconButton>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 10 }}>
        <div style={{ flex: '0 0 auto' }}>
          <Input
            // The dialog hands focus to the panel unless a child has claimed it,
            // and typing is the whole point of this one: someone who opened it to
            // find a conversation should be able to start describing it.
            autoFocus
            type="search"
            value={query}
            placeholder="Search what was asked, a name, or a folder…"
            aria-label="Search conversations"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        </div>

        {state.status === 'ready' ? (
          <div
            // polite, not assertive: the count changes on every keystroke, and a
            // reader interrupting itself per character would be unusable.
            role="status"
            aria-live="polite"
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: 8,
              fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            <span>{summaryLine(shown, total, visible.length, searching)}</span>
            {/* Said out loud, because a list that quietly stops at a ceiling
                reads as "this is everything" — the one thing it must not say
                when the question is where a conversation went. */}
            {state.list.truncated ? (
              <span style={{ color: 'var(--warning)' }}>
                Only your most recent conversations are listed.
              </span>
            ) : null}
          </div>
        ) : null}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: isPhone ? 10 : 8,
            overflowY: 'auto',
            // A long list must not drag the viewport around as rows come and go
            // above the scroll position.
            overflowAnchor: 'auto',
          }}
        >
          {state.status === 'loading' ? <Placeholder>Looking for your conversations…</Placeholder> : null}

          {state.status === 'error' ? (
            <Placeholder tone="var(--destructive)">
              <span>{state.message}</span>
              <Button
                variant="secondary"
                size="sm"
                style={isPhone ? { height: TOUCH_TARGET } : undefined}
                onClick={() => setReload((value) => value + 1)}
              >
                Try again
              </Button>
            </Placeholder>
          ) : null}

          {state.status === 'ready' && all.length === 0 ? (
            <Placeholder>
              No conversations yet. Start one from a folder and it will be listed here — including
              after you close its tab.
            </Placeholder>
          ) : null}

          {state.status === 'ready' && all.length > 0 && visible.length === 0 ? (
            <Placeholder>Nothing matches “{query.trim()}”.</Placeholder>
          ) : null}

          {visible.map((project) => (
            <ProjectGroup
              key={project.dir}
              project={project}
              // Searching opens everything: a match inside a folded group is a
              // search that found nothing as far as the user can tell.
              expanded={searching || !collapsed.has(project.dir)}
              foldable={!searching}
              onToggle={() => toggleGroup(project.dir)}
              openIds={withTabs}
              activeId={activeId ?? null}
              onOpen={onOpen}
              onDelete={remove}
            />
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/** What the count line says, in the words each case actually calls for. */
function summaryLine(shown: number, total: number, groups: number, searching: boolean): string {
  const projects = `${groups} ${groups === 1 ? 'project' : 'projects'}`;
  if (searching) return `${shown} of ${total} in ${projects}`;
  return `${total} ${total === 1 ? 'conversation' : 'conversations'} in ${projects}`;
}

function Placeholder({
  children,
  tone = 'var(--muted-foreground)',
}: {
  children: React.ReactNode;
  tone?: string;
}): React.JSX.Element {
  const isPhone = usePhone();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '28px 16px',
        textAlign: 'center',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius)',
        fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-sm)',
        lineHeight: 'var(--leading-normal)',
        color: tone,
      }}
    >
      {children}
    </div>
  );
}

/**
 * One project folder and its conversations.
 *
 * The heading shows the folder's leaf name, because that is what a person calls
 * the project, with the whole path beside it for the case the leaf does not settle
 * — two checkouts of the same repository, `frontend` under three different
 * services. On a phone the path goes: 390px has room for a name and a count, and
 * a truncated path answers nothing a tooltip nobody can hover would fix.
 */
function ProjectGroup({
  project,
  expanded,
  foldable,
  onToggle,
  openIds,
  activeId,
  onOpen,
  onDelete,
}: {
  project: ConversationProject;
  expanded: boolean;
  foldable: boolean;
  onToggle(): void;
  openIds: ReadonlySet<string>;
  activeId: string | null;
  onOpen(conversation: ConversationSummary): void;
  onDelete(conversation: ConversationSummary): void;
}): React.JSX.Element {
  const isPhone = usePhone();
  const bodyId = React.useId();
  const count = project.conversations.length;

  return (
    <section aria-label={project.dir}>
      <button
        type="button"
        onClick={foldable ? onToggle : undefined}
        aria-expanded={expanded}
        aria-controls={bodyId}
        // A heading that cannot fold while a search is running must not read as a
        // control that does nothing.
        disabled={!foldable}
        title={project.dir}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isPhone ? PHONE_SPACE.inline : 7,
          width: '100%',
          minHeight: isPhone ? TOUCH_TARGET : 26,
          padding: isPhone ? `0 ${PHONE_SPACE.edge}px` : '0 4px',
          background: 'transparent',
          border: 0,
          color: 'var(--foreground)',
          font: 'inherit',
          textAlign: 'left',
          cursor: foldable ? 'pointer' : 'default',
          // A disabled button dims to the browser's default, which would make the
          // heading the faintest thing on the surface exactly while a search is
          // being read.
          opacity: 1,
        }}
      >
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
          style={{ color: 'var(--muted-foreground)', visibility: foldable ? 'visible' : 'hidden' }}
        />
        <Icon name="folder" size={12} style={{ color: 'var(--muted-foreground)' }} />
        <span
          style={{
            flex: '0 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-ui)',
            fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
          }}
        >
          {project.name}
        </span>
        {isPhone ? null : (
          <span
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            {project.dir}
          </span>
        )}
        <span
          style={{
            flex: '0 0 auto',
            marginLeft: 'auto',
            paddingLeft: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {count}
        </span>
      </button>

      {expanded ? (
        <div id={bodyId} style={{ display: 'flex', flexDirection: 'column', gap: isPhone ? 8 : 6, marginTop: 6 }}>
          {project.conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              hasTab={openIds.has(conversation.id)}
              isActive={conversation.id === activeId}
              onOpen={() => onOpen(conversation)}
              onDelete={() => onDelete(conversation)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ConversationRow({
  conversation,
  hasTab,
  isActive,
  onOpen,
  onDelete,
}: {
  conversation: ConversationSummary;
  hasTab: boolean;
  isActive: boolean;
  onOpen(): void;
  onDelete(): void;
}): React.JSX.Element {
  const isPhone = usePhone();
  const [hover, setHover] = React.useState(false);
  const label = conversationLabel(conversation);
  const when = new Date(conversation.lastActivity);
  // Whether it is running, and in what mode, is live session information — and
  // the phone rule for that is explicit: never below the body size. A badge
  // draws itself at the app-wide caption size, which is 10px, so the two facts
  // most worth seeing would be the smallest things in the row. See ui/touch.ts.
  const badgeStyle: React.CSSProperties | undefined = isPhone
    ? { height: 'auto', padding: '1px 8px', fontSize: PHONE_TEXT.label }
    : undefined;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 2,
        background: 'var(--card)',
        border: `1px solid ${isActive ? 'var(--ring)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={label}
        aria-label={rowDescription(conversation, hasTab)}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'grid',
          gap: 4,
          minHeight: isPhone ? TOUCH_TARGET : undefined,
          padding: isPhone ? `8px ${PHONE_SPACE.edge}px` : '8px 10px',
          background: hover ? 'var(--accent)' : 'transparent',
          border: 0,
          borderRadius: 'var(--radius)',
          color: 'var(--foreground)',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            display: 'block',
            minWidth: 0,
            fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-ui)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: isPhone ? PHONE_SPACE.inline : 8,
            flexWrap: 'wrap',
            // Live session information — is it running, in what mode — is never
            // below the body size on a phone. See ui/touch.ts.
            fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          <span>{conversation.runtimeLabel || conversation.runtime || 'chat'}</span>
          <span title={when.toLocaleString()}>{formatWhen(when)}</span>
          {conversation.running ? (
            <Badge variant="success" style={badgeStyle}>running</Badge>
          ) : null}
          {/* Said before the choice is made, not discovered on arrival: the
              transcript comes back either way, and this is the difference
              between an agent that remembers it and one reading it for the
              first time. */}
          {!conversation.running && !conversation.canResume ? (
            <Badge variant="outline" style={badgeStyle}>transcript only</Badge>
          ) : null}
          {conversation.bypassPermissions ? (
            <Badge variant="destructive" style={badgeStyle}>approvals bypassed</Badge>
          ) : null}
          {/* Not a warning, a shortcut: picking this one switches to the tab it
              already has rather than opening a second view of it. */}
          {hasTab ? <Badge variant="outline" style={badgeStyle}>open</Badge> : null}
        </span>
      </button>

      <IconButton
        label={`Delete “${label}”`}
        onClick={onDelete}
        style={{ alignSelf: 'center', flex: '0 0 auto', marginRight: 2 }}
      >
        <Icon name="trash-2" size={isPhone ? 17 : 14} />
      </IconButton>
    </div>
  );
}

/**
 * The whole row in one sentence, for a screen reader.
 *
 * The visible row spreads five facts across two lines and a handful of badges,
 * which reads as five separate fragments with no relation between them. This is
 * the same row read as a row.
 */
function rowDescription(conversation: ConversationSummary, hasTab: boolean): string {
  const parts = [conversationLabel(conversation)];
  parts.push(conversation.runtimeLabel || conversation.runtime || 'chat');
  parts.push(`last active ${new Date(conversation.lastActivity).toLocaleString()}`);
  if (conversation.running) parts.push('running now');
  else if (!conversation.canResume) parts.push('the agent cannot carry on from where it left off');
  if (conversation.bypassPermissions) parts.push('approvals bypassed');
  if (hasTab) parts.push('already open');
  return parts.join(', ');
}

/**
 * A date a person reads, at the width the row has for it.
 *
 * Time alone for today, because "today" is the only case where the time is the
 * distinguishing part; a plain date otherwise. The full timestamp is the title on
 * the same element, so nothing is lost — only shortened.
 */
function formatWhen(at: Date): string {
  if (Number.isNaN(at.getTime())) return 'unknown';
  const today = new Date();
  return at.toDateString() === today.toDateString()
    ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString();
}
