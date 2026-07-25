/**
 * Syntax highlighting for code blocks and diffs in chat output.
 *
 * Hand-rolled rather than pulled from a library. The two real options each cost
 * more than they are worth here: a full grammar engine ships megabytes for a
 * feature that decorates a chat bubble, and a regex-per-language pack still
 * needs the same theming work to sit inside the Relay palette. What agents
 * actually paste is a narrow set of languages, and a token stream is all the
 * renderer needs.
 *
 * Tokens name a *role*, not a colour. The renderer maps roles onto the ANSI
 * custom properties the terminal theme already defines, so highlighted code
 * follows the user's light/dark choice and their terminal colours without a
 * second palette to keep in sync.
 *
 * Correctness bar: never lose a character. Every branch either consumes input
 * as a classified token or as unclassified text, so `tokens.join('') === input`
 * always holds — a highlighter that silently drops a character while streaming
 * would corrupt code the user is about to copy.
 */

export type TokenRole =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'operator'
  | 'punctuation'
  | 'property'
  | 'variable'
  | 'added'
  | 'removed'
  | 'meta'
  | null;

export interface HighlightToken {
  text: string;
  role: TokenRole;
}

interface Rule {
  pattern: RegExp;
  role: TokenRole;
  /** Re-classify based on the match, for rules that cover several roles. */
  refine?: (match: RegExpExecArray) => TokenRole;
}

const JS_KEYWORDS =
  'as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield|declare|namespace|abstract|override|infer|keyof|asserts|is';

const JS_LITERALS = 'true|false|null|undefined|NaN|Infinity';

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case';

const GO_KEYWORDS =
  'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var';

const RUST_KEYWORDS =
  'as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while';

const SH_KEYWORDS =
  'if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|in|select|time|local|export|readonly|declare|source|alias|set|unset|trap|shift';

const SQL_KEYWORDS =
  'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|AS|AND|OR|NOT|NULL|IS|IN|EXISTS|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|END|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CONSTRAINT|WITH|RETURNING';

/** Shared string/number/punctuation rules, in the order they must be tried. */
function commonRules(keywords: string, literals?: string): Rule[] {
  return [
    // Strings before everything: a keyword inside quotes is not a keyword.
    { pattern: /"(?:[^"\\\n]|\\.)*"?/y, role: 'string' },
    { pattern: /'(?:[^'\\\n]|\\.)*'?/y, role: 'string' },
    { pattern: /`(?:[^`\\]|\\.)*`?/y, role: 'string' },
    { pattern: /\b0[xXbBoO][0-9a-fA-F_]+n?\b/y, role: 'number' },
    { pattern: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?\b/y, role: 'number' },
    ...(literals ? [{ pattern: new RegExp(`\\b(?:${literals})\\b`, 'y'), role: 'number' as TokenRole }] : []),
    { pattern: new RegExp(`\\b(?:${keywords})\\b`, 'y'), role: 'keyword' },
    // A name followed by '(' reads as a call; this is the cheap approximation
    // that gets function highlighting right almost everywhere.
    { pattern: /[A-Za-z_$][\w$]*(?=\s*\()/y, role: 'function' },
    { pattern: /\b[A-Z][A-Za-z0-9_]*\b/y, role: 'type' },
    { pattern: /[A-Za-z_$][\w$]*/y, role: 'variable' },
    { pattern: /[+\-*/%=<>!&|^~?:]+/y, role: 'operator' },
    { pattern: /[{}[\]();,.]/y, role: 'punctuation' },
  ];
}

const LANGUAGES: Record<string, Rule[]> = {
  js: [
    { pattern: /\/\/[^\n]*/y, role: 'comment' },
    { pattern: /\/\*[\s\S]*?(?:\*\/|$)/y, role: 'comment' },
    ...commonRules(JS_KEYWORDS, JS_LITERALS),
  ],
  python: [
    { pattern: /#[^\n]*/y, role: 'comment' },
    { pattern: /"""[\s\S]*?(?:"""|$)/y, role: 'string' },
    { pattern: /'''[\s\S]*?(?:'''|$)/y, role: 'string' },
    { pattern: /\b(?:True|False|None|self|cls)\b/y, role: 'number' },
    ...commonRules(PY_KEYWORDS),
  ],
  go: [
    { pattern: /\/\/[^\n]*/y, role: 'comment' },
    { pattern: /\/\*[\s\S]*?(?:\*\/|$)/y, role: 'comment' },
    ...commonRules(GO_KEYWORDS, 'true|false|nil|iota'),
  ],
  rust: [
    { pattern: /\/\/[^\n]*/y, role: 'comment' },
    { pattern: /\/\*[\s\S]*?(?:\*\/|$)/y, role: 'comment' },
    { pattern: /#!?\[[^\]]*\]/y, role: 'meta' },
    ...commonRules(RUST_KEYWORDS, 'None|Some|Ok|Err'),
  ],
  shell: [
    { pattern: /#[^\n]*/y, role: 'comment' },
    { pattern: /"(?:[^"\\]|\\.)*"?/y, role: 'string' },
    { pattern: /'[^']*'?/y, role: 'string' },
    // A variable expansion is the thing worth seeing in a shell command.
    { pattern: /\$(?:\{[^}]*\}?|[A-Za-z_][\w]*|[@*#?$!0-9-])/y, role: 'variable' },
    { pattern: /\b(?:\d+)\b/y, role: 'number' },
    { pattern: new RegExp(`\\b(?:${SH_KEYWORDS})\\b`, 'y'), role: 'keyword' },
    { pattern: /^\s*[A-Za-z_][\w.-]*(?=\s)/my, role: 'function' },
    { pattern: /--?[A-Za-z][\w-]*/y, role: 'property' },
    { pattern: /[|&;<>()$`\\"'*?[\]#~=%]/y, role: 'operator' },
  ],
  json: [
    { pattern: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, role: 'property' },
    { pattern: /"(?:[^"\\]|\\.)*"?/y, role: 'string' },
    { pattern: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, role: 'number' },
    { pattern: /\b(?:true|false|null)\b/y, role: 'keyword' },
    { pattern: /[{}[\],:]/y, role: 'punctuation' },
  ],
  yaml: [
    { pattern: /#[^\n]*/y, role: 'comment' },
    { pattern: /^[\s-]*[A-Za-z_][\w.-]*(?=\s*:)/my, role: 'property' },
    { pattern: /"(?:[^"\\]|\\.)*"?/y, role: 'string' },
    { pattern: /'[^']*'?/y, role: 'string' },
    { pattern: /\b(?:true|false|null|yes|no|on|off)\b/y, role: 'keyword' },
    { pattern: /\b-?\d+(?:\.\d+)?\b/y, role: 'number' },
    { pattern: /[:\-|>&*]/y, role: 'punctuation' },
  ],
  css: [
    { pattern: /\/\*[\s\S]*?(?:\*\/|$)/y, role: 'comment' },
    { pattern: /--[\w-]+/y, role: 'variable' },
    { pattern: /[.#][\w-]+/y, role: 'type' },
    { pattern: /@[\w-]+/y, role: 'keyword' },
    { pattern: /[\w-]+(?=\s*:)/y, role: 'property' },
    { pattern: /"(?:[^"\\]|\\.)*"?|'[^']*'?/y, role: 'string' },
    { pattern: /\b-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|fr|deg)?\b/y, role: 'number' },
    { pattern: /[{}();:,]/y, role: 'punctuation' },
  ],
  html: [
    { pattern: /<!--[\s\S]*?(?:-->|$)/y, role: 'comment' },
    { pattern: /<\/?[A-Za-z][\w-]*/y, role: 'keyword' },
    { pattern: /[\w-]+(?==)/y, role: 'property' },
    { pattern: /"(?:[^"\\]|\\.)*"?|'[^']*'?/y, role: 'string' },
    { pattern: /\/?>/y, role: 'keyword' },
  ],
  sql: [
    { pattern: /--[^\n]*/y, role: 'comment' },
    { pattern: /\/\*[\s\S]*?(?:\*\/|$)/y, role: 'comment' },
    { pattern: /'(?:[^'\\]|\\.)*'?/y, role: 'string' },
    { pattern: new RegExp(`\\b(?:${SQL_KEYWORDS})\\b`, 'iy'), role: 'keyword' },
    { pattern: /\b\d+(?:\.\d+)?\b/y, role: 'number' },
    { pattern: /[(),;.*=<>!+-]/y, role: 'punctuation' },
  ],
  markdown: [
    { pattern: /^#{1,6}\s[^\n]*/my, role: 'keyword' },
    { pattern: /`[^`\n]*`?/y, role: 'string' },
    { pattern: /\*\*[^*\n]*\*\*?/y, role: 'type' },
    { pattern: /^\s*[-*+]\s/my, role: 'punctuation' },
  ],
};

/**
 * Diff gets its own tokenizer rather than a rule list.
 *
 * The unit is a whole line, and line-oriented classification is both simpler
 * and what the eye actually wants: a changed line reads as changed even when
 * the tokens inside it are unremarkable.
 */
function tokenizeDiff(source: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    const text = index === lines.length - 1 ? line : `${line}\n`;
    if (!text) return;
    if (/^\+\+\+|^---|^diff |^index |^@@/.test(line)) {
      tokens.push({ text, role: 'meta' });
    } else if (line.startsWith('+')) {
      tokens.push({ text, role: 'added' });
    } else if (line.startsWith('-')) {
      tokens.push({ text, role: 'removed' });
    } else {
      tokens.push({ text, role: null });
    }
  });

  return tokens;
}

/** Language aliases as they actually appear in fence info strings. */
const ALIASES: Record<string, string> = {
  ts: 'js',
  tsx: 'js',
  jsx: 'js',
  javascript: 'js',
  typescript: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  golang: 'go',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  shellsession: 'shell',
  terminal: 'shell',
  yml: 'yaml',
  jsonc: 'json',
  json5: 'json',
  scss: 'css',
  less: 'css',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  postgres: 'sql',
  psql: 'sql',
  mysql: 'sql',
  md: 'markdown',
  patch: 'diff',
};

export function normalizeLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const key = String(lang).toLowerCase().trim();
  const resolved = ALIASES[key] || key;
  if (resolved === 'diff') return 'diff';
  return resolved in LANGUAGES ? resolved : null;
}

/** True when a fence language will actually be highlighted. */
export function canHighlight(lang: string | null | undefined): boolean {
  return normalizeLanguage(lang) !== null;
}

/**
 * Tokenize source for display.
 *
 * Falls back to a single unclassified token for an unknown language, which
 * renders as plain monospace text — the correct outcome, and far better than
 * guessing a grammar and colouring the wrong words.
 */
export function highlight(source: string, lang: string | null | undefined): HighlightToken[] {
  const text = String(source ?? '');
  if (!text) return [];

  const resolved = normalizeLanguage(lang);
  if (!resolved) return [{ text, role: null }];
  if (resolved === 'diff') return tokenizeDiff(text);

  const rules = LANGUAGES[resolved];
  const tokens: HighlightToken[] = [];
  let index = 0;
  let plain = '';

  const flush = (): void => {
    if (plain) {
      tokens.push({ text: plain, role: null });
      plain = '';
    }
  };

  while (index < text.length) {
    let matched = false;

    for (const rule of rules) {
      rule.pattern.lastIndex = index;
      const match = rule.pattern.exec(text);
      // A sticky pattern can match empty; consuming nothing would spin forever.
      if (!match || match[0].length === 0) continue;

      flush();
      tokens.push({
        text: match[0],
        role: rule.refine ? rule.refine(match) : rule.role,
      });
      index += match[0].length;
      matched = true;
      break;
    }

    if (!matched) {
      plain += text[index];
      index += 1;
    }
  }

  flush();
  return tokens;
}

/**
 * CSS custom property each role reads its colour from.
 *
 * Deliberately the ANSI variables rather than a new set: those already exist,
 * already flip with the theme, and already track whatever terminal palette the
 * user picked, so highlighted code and terminal output cannot drift apart.
 */
export const ROLE_COLOR_VAR: Record<Exclude<TokenRole, null>, string> = {
  keyword: '--ansi-magenta',
  string: '--ansi-green',
  number: '--ansi-yellow',
  comment: '--ansi-bright-black',
  function: '--ansi-blue',
  type: '--ansi-cyan',
  operator: '--ansi-bright-magenta',
  punctuation: '--terminal-dim',
  property: '--ansi-cyan',
  variable: '--terminal-fg',
  added: '--ansi-green',
  removed: '--ansi-red',
  meta: '--ansi-bright-blue',
};
