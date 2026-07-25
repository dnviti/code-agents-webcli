import * as React from 'react';
import {
  Align,
  InlineNode,
  ListItem,
  MarkdownNode,
  markdownToText,
  parseMarkdown,
} from '../../chat/markdown.js';
import { ROLE_COLOR_VAR, canHighlight, highlight } from '../../chat/highlight.js';
import { isMermaidLanguage } from '../../chat/mermaid.js';
import { MermaidBlock } from './MermaidBlock.js';
import { Icon } from '../../ui/relay/Icon.js';

/**
 * Renders parsed markdown as React elements.
 *
 * Every node becomes an element — there is no `dangerouslySetInnerHTML` in this
 * file and there must never be one. That is what makes model output structurally
 * incapable of becoming markup, rather than merely filtered on its way there.
 *
 * Styling is inline against Relay custom properties, matching the rest of the
 * components in this codebase, so a chat bubble inherits the user's theme,
 * terminal palette and font choices without a stylesheet to keep in sync.
 */

export interface MarkdownProps {
  text: string;
  /** Compact spacing for dense surfaces like tool output. */
  dense?: boolean;
}

export const Markdown = React.memo(function Markdown({ text, dense }: MarkdownProps) {
  // Parsing is pure and cheap, but a streaming message re-renders per token and
  // the tree is identical whenever the text has not moved.
  const nodes = React.useMemo(() => parseMarkdown(text), [text]);
  return <>{nodes.map((node, i) => renderBlock(node, i, Boolean(dense)))}</>;
});

function renderBlock(node: MarkdownNode, key: React.Key, dense: boolean): React.ReactNode {
  const gap = dense ? 6 : 10;

  switch (node.type) {
    case 'paragraph':
      return (
        <p
          key={key}
          style={{
            margin: `0 0 ${gap}px`,
            lineHeight: 'var(--leading-normal)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {node.children.map(renderInline)}
        </p>
      );

    case 'heading': {
      const size = ['var(--text-xl)', 'var(--text-lg)', 'var(--text-body)'][
        Math.min(node.level, 3) - 1
      ];
      return React.createElement(
        `h${Math.min(node.level, 6)}`,
        {
          key,
          style: {
            margin: `${gap + 4}px 0 ${gap}px`,
            fontSize: size,
            fontWeight: 'var(--font-semibold)',
            lineHeight: 'var(--leading-snug)',
          },
        },
        node.children.map(renderInline),
      );
    }

    case 'code':
      // A mermaid fence is a diagram, not a listing. MermaidBlock falls back to
      // exactly this CodeBlock when the source will not draw, so nothing is
      // lost when the renderer cannot load or the syntax is wrong.
      if (isMermaidLanguage(node.lang)) {
        return <MermaidBlock key={key} code={node.text} complete={node.complete} />;
      }
      return <CodeBlock key={key} lang={node.lang} text={node.text} complete={node.complete} />;

    case 'rule':
      return (
        <hr
          key={key}
          style={{
            border: 0,
            borderTop: '1px solid var(--border)',
            margin: `${gap + 2}px 0`,
          }}
        />
      );

    case 'quote':
      return (
        <blockquote
          key={key}
          style={{
            margin: `0 0 ${gap}px`,
            padding: '2px 0 2px 12px',
            borderLeft: '2px solid var(--border)',
            color: 'var(--muted-foreground)',
          }}
        >
          {node.children.map((child, i) => renderBlock(child, i, dense))}
        </blockquote>
      );

    case 'list':
      return <List key={key} node={node} dense={dense} />;

    case 'table':
      return <Table key={key} head={node.head} align={node.align} rows={node.rows} />;

    default:
      return null;
  }
}

function List({
  node,
  dense,
}: {
  node: Extract<MarkdownNode, { type: 'list' }>;
  dense: boolean;
}) {
  const hasTasks = node.items.some((item) => item.checked !== undefined);

  // A task list is not really a list: bullets alongside checkboxes read as
  // noise, so it drops the marker and lays out as rows.
  if (hasTasks) {
    return (
      <div style={{ margin: `0 0 ${dense ? 6 : 10}px`, display: 'grid', gap: 4 }}>
        {node.items.map((item, i) => (
          <TaskRow key={i} item={item} dense={dense} />
        ))}
      </div>
    );
  }

  const Tag = node.ordered ? 'ol' : 'ul';
  return React.createElement(
    Tag,
    {
      key: 'list',
      start: node.ordered ? node.start : undefined,
      style: {
        margin: `0 0 ${dense ? 6 : 10}px`,
        paddingLeft: 20,
        display: 'grid',
        gap: 2,
      },
    },
    node.items.map((item, i) =>
      React.createElement(
        'li',
        { key: i, style: { lineHeight: 'var(--leading-normal)' } },
        item.children.map((child, j) => renderBlock(child, j, true)),
      ),
    ),
  );
}

function TaskRow({ item, dense }: { item: ListItem; dense: boolean }) {
  const done = item.checked === true;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          width: 13,
          height: 13,
          marginTop: 3,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${done ? 'var(--success)' : 'var(--border)'}`,
          color: 'var(--success)',
          borderRadius: 'var(--radius)',
        }}
      >
        {done ? <Icon name="check" size={9} /> : null}
      </span>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          color: done ? 'var(--muted-foreground)' : undefined,
          textDecoration: done ? 'line-through' : undefined,
        }}
      >
        {item.children.map((child, i) => renderBlock(child, i, dense))}
      </div>
    </div>
  );
}

function Table({
  head,
  align,
  rows,
}: {
  head: InlineNode[][];
  align: Align[];
  rows: InlineNode[][][];
}) {
  const cell = (a: Align): React.CSSProperties => ({
    padding: '4px 10px',
    borderBottom: '1px solid var(--border)',
    textAlign: a || 'left',
    verticalAlign: 'top',
  });

  // A wide table must scroll inside its own bubble rather than widening the
  // message column and pushing the whole conversation sideways.
  return (
    <div style={{ overflowX: 'auto', margin: '0 0 10px', maxWidth: '100%' }}>
      <table
        style={{
          borderCollapse: 'collapse',
          fontSize: 'var(--text-sm)',
          minWidth: '100%',
        }}
      >
        <thead>
          <tr>
            {head.map((cells, i) => (
              <th
                key={i}
                style={{
                  ...cell(align[i]),
                  fontWeight: 'var(--font-semibold)',
                  color: 'var(--muted-foreground)',
                  whiteSpace: 'nowrap',
                }}
              >
                {cells.map(renderInline)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cells, j) => (
                <td key={j} style={cell(align[j])}>
                  {cells.map(renderInline)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface CodeBlockProps {
  lang: string | null;
  text: string;
  /** False while the closing fence has not arrived yet. */
  complete?: boolean;
}

export function CodeBlock({ lang, text, complete = true }: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false);
  const tokens = React.useMemo(() => highlight(text, lang), [text, lang]);

  const copy = React.useCallback(() => {
    // Clipboard access is not guaranteed: the page can be on an insecure
    // origin, or permission can be refused. Failing quietly leaves the button
    // looking broken, so the label only changes once the write resolved.
    const write = navigator.clipboard?.writeText(text);
    if (!write) return;
    write
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        /* Left to the user to select manually. */
      });
  }, [text]);

  return (
    <div
      style={{
        position: 'relative',
        margin: '0 0 10px',
        border: '1px solid var(--border)',
        background: 'var(--terminal-bg)',
        borderRadius: 'var(--radius)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '3px 6px 3px 10px',
          borderBottom: '1px solid var(--border)',
          minHeight: 24,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
            letterSpacing: 'var(--tracking-wide)',
          }}
        >
          {lang || 'text'}
          {complete ? null : ' · writing'}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 20,
            padding: '0 6px',
            background: 'transparent',
            border: '1px solid transparent',
            color: copied ? 'var(--success)' : 'var(--muted-foreground)',
            font: 'inherit',
            fontSize: 'var(--text-2xs)',
            cursor: 'pointer',
            borderRadius: 'var(--radius)',
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={11} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          overflowX: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          lineHeight: 'var(--leading-terminal)',
          color: 'var(--terminal-fg)',
        }}
      >
        <code>
          {tokens.map((token, i) =>
            token.role ? (
              <span key={i} style={{ color: `var(${ROLE_COLOR_VAR[token.role]})` }}>
                {token.text}
              </span>
            ) : (
              <React.Fragment key={i}>{token.text}</React.Fragment>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

function renderInline(node: InlineNode, key: React.Key): React.ReactNode {
  switch (node.type) {
    case 'text':
      return <React.Fragment key={key}>{node.value}</React.Fragment>;

    case 'strong':
      return (
        <strong key={key} style={{ fontWeight: 'var(--font-semibold)' }}>
          {node.children.map(renderInline)}
        </strong>
      );

    case 'em':
      return <em key={key}>{node.children.map(renderInline)}</em>;

    case 'strike':
      return (
        <span key={key} style={{ textDecoration: 'line-through', opacity: 0.7 }}>
          {node.children.map(renderInline)}
        </span>
      );

    case 'codespan':
      return (
        <code
          key={key}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.92em',
            padding: '1px 4px',
            background: 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            wordBreak: 'break-word',
          }}
        >
          {node.value}
        </code>
      );

    case 'link':
      return (
        <a
          key={key}
          href={node.href}
          title={node.title}
          // The parser already refused every scheme that could execute; these
          // close the tabnabbing hole that opening in a new tab would leave.
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: 'var(--info)', textDecoration: 'underline' }}
        >
          {node.children.map(renderInline)}
        </a>
      );

    case 'image':
      return (
        <img
          key={key}
          src={node.src}
          alt={node.alt}
          loading="lazy"
          style={{
            maxWidth: '100%',
            height: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
          }}
        />
      );

    default:
      return null;
  }
}

/** Plain text of a markdown string, for copy-message and search snippets. */
export function markdownText(text: string): string {
  return markdownToText(parseMarkdown(text));
}

export { canHighlight };
