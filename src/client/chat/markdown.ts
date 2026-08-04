/**
 * Markdown parser for agent output.
 *
 * Produces a node tree, never HTML. That is the whole security design: the
 * renderer turns these nodes into React elements, so there is no point in the
 * pipeline where model-authored text could become markup. A sanitiser is a
 * filter you have to keep ahead of; this is a shape that cannot express an
 * injection in the first place.
 *
 * It also has to survive *incomplete* input. Chat output streams, so this
 * parser is asked to render half a sentence, an unterminated code fence, or a
 * table with one row written so far — several times a second. Every construct
 * therefore has a defined meaning while still open, and nothing waits for a
 * terminator before it will render.
 *
 * Not CommonMark. It covers what coding agents actually emit — fenced code,
 * lists, tables, headings, emphasis, links — and deliberately omits the corners
 * (reference links, HTML blocks, setext headings) that would cost far more than
 * they would ever render here.
 */

export type MarkdownNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'code'; lang: string | null; text: string; complete: boolean }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'quote'; children: MarkdownNode[] }
  | { type: 'table'; head: InlineNode[][]; align: Align[]; rows: InlineNode[][][] }
  | { type: 'rule' };

export interface ListItem {
  children: MarkdownNode[];
  /** Set for `- [ ]` / `- [x]` items, which agents use constantly for plans. */
  checked?: boolean;
}

export type Align = 'left' | 'center' | 'right' | null;

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'strike'; children: InlineNode[] }
  | { type: 'codespan'; value: string }
  | { type: 'link'; href: string; title?: string; children: InlineNode[] }
  | { type: 'filelink'; href: string; title?: string; children: InlineNode[] }
  | { type: 'image'; src: string; alt: string };

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * URL schemes allowed to become an href.
 *
 * Everything else renders as plain text. `javascript:` is the obvious one, but
 * `data:` matters just as much — a data URL can carry a whole HTML document,
 * and agents legitimately produce them often enough that a user would click.
 */
const SAFE_SCHEME = /^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;

/** Images may additionally come from our own paste/attachment store. */
const SAFE_IMAGE = /^(?:https?:|\/|\.\/|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i;

function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  // A scheme-relative URL inherits our scheme, which is fine, but a bare
  // "foo:bar" could be anything, so anything unrecognised is refused.
  if (url.startsWith('//')) return null;
  return SAFE_SCHEME.test(url) ? url : null;
}

/**
 * Windows file paths look like URL schemes to a browser. Preserve them as a
 * distinct, inert node so a workspace-aware renderer can route them without
 * ever making `c:` (or a UNC spelling) an ordinary navigable href.
 */
function safeFileHref(raw: string): string | null {
  const path = raw.trim();
  if (/^[A-Za-z]:[\\/]/.test(path)) return path;
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path)) return path;
  return null;
}

function safeSrc(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  return SAFE_IMAGE.test(url) ? url : null;
}

export function parseMarkdown(input: string): MarkdownNode[] {
  const lines = String(input ?? '').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const width = fence[2].length;
      const lang = fence[3] || null;
      const body: string[] = [];
      i++;
      let complete = false;
      while (i < lines.length) {
        const candidate = lines[i];
        const closing = FENCE.exec(candidate);
        if (closing && closing[2][0] === marker && closing[2].length >= width && !closing[3]) {
          complete = true;
          i++;
          break;
        }
        body.push(candidate);
        i++;
      }
      // `complete` is what lets the renderer show a still-streaming block
      // differently instead of flickering between code and paragraph.
      nodes.push({ type: 'code', lang, text: body.join('\n'), complete });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2].trim()),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      nodes.push({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i]);
        if (!quoted) {
          if (!lines[i].trim()) break;
          // A lazy continuation line belongs to the quote it follows.
          body.push(lines[i]);
          i++;
          continue;
        }
        body.push(quoted[1]);
        i++;
      }
      nodes.push({ type: 'quote', children: parseBlocks(body) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const consumed = parseTable(lines, i);
      if (consumed) {
        nodes.push(consumed.node);
        i = consumed.next;
        continue;
      }
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const consumed = parseList(lines, i);
      nodes.push(consumed.node);
      i = consumed.next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (
        !current.trim() ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      i++;
    }
    if (paragraph.length) {
      nodes.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    }
  }

  return nodes;
}

function isTableStart(lines: string[], at: number): boolean {
  return (
    lines[at].includes('|') &&
    at + 1 < lines.length &&
    TABLE_DIVIDER.test(lines[at + 1]) &&
    lines[at + 1].includes('-')
  );
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(lines: string[], at: number): { node: MarkdownNode; next: number } | null {
  const head = splitRow(lines[at]);
  const align: Align[] = splitRow(lines[at + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });

  const rows: InlineNode[][][] = [];
  let i = at + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]).map(parseInline));
    i++;
  }

  return {
    node: { type: 'table', head: head.map(parseInline), align, rows },
    next: i,
  };
}

function parseList(lines: string[], at: number): { node: MarkdownNode; next: number } {
  const first = BULLET.exec(lines[at]) || ORDERED.exec(lines[at]);
  const ordered = !BULLET.test(lines[at]);
  const baseIndent = first ? first[1].length : 0;
  const start = ordered && first ? parseInt(first[2], 10) : 1;

  const items: ListItem[] = [];
  let i = at;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it, which is
      // how agents write lists with paragraph-spaced items.
      const next = lines[i + 1];
      if (!next || !(BULLET.test(next) || ORDERED.test(next))) break;
      i++;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = ORDERED.exec(line);
    const match = bullet || numbered;
    if (!match) break;

    const indent = match[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // Deeper indent belongs to the item above; gather it and recurse.
      const nested: string[] = [];
      while (i < lines.length) {
        const candidate = lines[i];
        const candidateMatch = BULLET.exec(candidate) || ORDERED.exec(candidate);
        if (!candidate.trim()) break;
        if (!candidateMatch || candidateMatch[1].length <= baseIndent) break;
        nested.push(candidate.slice(baseIndent + 2));
        i++;
      }
      const parent = items[items.length - 1];
      if (parent) {
        parent.children.push(...parseBlocks(nested));
      }
      continue;
    }

    // Same level: a new item, whose body may continue on indented lines.
    const content = match[3];
    const body: string[] = [content];
    i++;
    while (i < lines.length) {
      const candidate = lines[i];
      if (!candidate.trim()) break;
      if (BULLET.test(candidate) || ORDERED.test(candidate)) break;
      const indentOf = candidate.length - candidate.trimStart().length;
      if (indentOf <= baseIndent) break;
      body.push(candidate.trim());
      i++;
    }

    const task = TASK.exec(body[0] || '');
    if (task) {
      body[0] = task[2];
      items.push({
        children: parseBlocks(body),
        checked: task[1].toLowerCase() === 'x',
      });
    } else {
      items.push({ children: parseBlocks(body) });
    }
  }

  return { node: { type: 'list', ordered, start, items }, next: i };
}

/**
 * Inline parse.
 *
 * A single left-to-right scan rather than a delimiter-run algorithm: it gets
 * every case an agent actually produces right, and it cannot get stuck on
 * pathological input the way a backtracking matcher can — which matters when
 * this runs on every token of a streaming response.
 */
export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = '';
  let i = 0;

  const flush = (): void => {
    if (text) {
      nodes.push({ type: 'text', value: text });
      text = '';
    }
  };

  while (i < input.length) {
    const char = input[i];

    if (char === '\\' && i + 1 < input.length) {
      text += input[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      let width = 0;
      while (input[i + width] === '`') width++;
      const marker = '`'.repeat(width);
      const close = input.indexOf(marker, i + width);
      if (close !== -1) {
        flush();
        nodes.push({ type: 'codespan', value: input.slice(i + width, close) });
        i = close + width;
        continue;
      }
      // Unterminated span: a code fence still being streamed. Show the
      // backtick as text rather than swallowing the rest of the line.
      text += marker;
      i += width;
      continue;
    }

    if (char === '!' && input[i + 1] === '[') {
      const parsed = parseLink(input, i + 1);
      if (parsed) {
        const src = safeSrc(parsed.href);
        flush();
        if (src) {
          nodes.push({ type: 'image', src, alt: parsed.label });
        } else {
          nodes.push({ type: 'text', value: `![${parsed.label}](${parsed.href})` });
        }
        i = parsed.next;
        continue;
      }
    }

    if (char === '[') {
      const parsed = parseLink(input, i);
      if (parsed) {
        const href = safeHref(parsed.href);
        const fileHref = href ? null : safeFileHref(parsed.href);
        flush();
        if (href) {
          nodes.push({
            type: 'link',
            href,
            title: parsed.title,
            children: parseInline(parsed.label),
          });
        } else if (fileHref) {
          nodes.push({
            type: 'filelink',
            href: fileHref,
            title: parsed.title,
            children: parseInline(parsed.label),
          });
        } else {
          // A refused scheme degrades to the text the author wrote. Silently
          // dropping it would hide from the user that a link was attempted.
          nodes.push({ type: 'text', value: `[${parsed.label}](${parsed.href})` });
        }
        i = parsed.next;
        continue;
      }
    }

    const emphasis = matchEmphasis(input, i);
    if (emphasis) {
      flush();
      nodes.push(emphasis.node);
      i = emphasis.next;
      continue;
    }

    if (char === '<') {
      const autolink = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(input.slice(i));
      if (autolink) {
        const href = safeHref(autolink[1]);
        if (href) {
          flush();
          nodes.push({ type: 'link', href, children: [{ type: 'text', value: autolink[1] }] });
          i += autolink[0].length;
          continue;
        }
      }
    }

    text += char;
    i++;
  }

  flush();
  return nodes;
}

function parseLink(
  input: string,
  at: number,
): { label: string; href: string; title?: string; next: number } | null {
  if (input[at] !== '[') return null;

  let depth = 0;
  let close = -1;
  for (let i = at; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] === '[') depth++;
    else if (input[i] === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || input[close + 1] !== '(') return null;

  let paren = 0;
  let end = -1;
  for (let i = close + 1; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    if (input[i] === '(') paren++;
    else if (input[i] === ')') {
      paren--;
      if (paren === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const label = input.slice(at + 1, close);
  const target = input.slice(close + 2, end).trim();
  const titled = /^(\S+)\s+["'(](.*)["')]$/.exec(target);

  return {
    label,
    href: titled ? titled[1] : target,
    title: titled ? titled[2] : undefined,
    next: end + 1,
  };
}

function matchEmphasis(
  input: string,
  at: number,
): { node: InlineNode; next: number } | null {
  const char = input[at];
  if (char !== '*' && char !== '_' && char !== '~') return null;

  const double = input[at + 1] === char;

  if (char === '~') {
    if (!double) return null;
    const close = input.indexOf('~~', at + 2);
    if (close === -1) return null;
    return {
      node: { type: 'strike', children: parseInline(input.slice(at + 2, close)) },
      next: close + 2,
    };
  }

  if (double) {
    const marker = char + char;
    const close = findClose(input, marker, at + 2);
    if (close === -1) return null;
    return {
      node: { type: 'strong', children: parseInline(input.slice(at + 2, close)) },
      next: close + 2,
    };
  }

  // A single underscore inside a word is an identifier, not emphasis —
  // snake_case names are everywhere in agent output and italicising half of
  // one is worse than not supporting `_em_` at all.
  if (char === '_' && at > 0 && /\w/.test(input[at - 1])) return null;

  const close = findClose(input, char, at + 1);
  if (close === -1) return null;
  if (close === at + 1) return null;
  if (char === '_' && close + 1 < input.length && /\w/.test(input[close + 1])) return null;

  return {
    node: { type: 'em', children: parseInline(input.slice(at + 1, close)) },
    next: close + 1,
  };
}

function findClose(input: string, marker: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === '\\') {
      i++;
      continue;
    }
    // Never match across a code span: `a * b` inside backticks is arithmetic.
    if (input[i] === '`') {
      const end = input.indexOf('`', i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (input.startsWith(marker, i)) return i;
  }
  return -1;
}

/** Plain text of a node tree, for copy-to-clipboard and search snippets. */
export function markdownToText(nodes: MarkdownNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'paragraph':
          return inlineToText(node.children);
        case 'heading':
          return inlineToText(node.children);
        case 'code':
          return node.text;
        case 'quote':
          return markdownToText(node.children);
        case 'rule':
          return '';
        case 'list':
          return node.items
            .map((item) => `- ${markdownToText(item.children)}`)
            .join('\n');
        case 'table':
          return [node.head, ...node.rows]
            .map((row) => row.map(inlineToText).join('\t'))
            .join('\n');
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

function inlineToText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.value;
        case 'codespan':
          return node.value;
        case 'image':
          return node.alt;
        case 'strong':
        case 'em':
        case 'strike':
        case 'link':
        case 'filelink':
          return inlineToText(node.children);
        default:
          return '';
      }
    })
    .join('');
}
