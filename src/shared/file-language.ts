/**
 * Which highlighter a file gets, from its name.
 *
 * The chat surface already highlights fenced code by the language the model
 * wrote after the backticks. A file on disk has no such label, so this is the
 * equivalent: a name, and the language it is written in.
 *
 * Deliberately conservative and deliberately shared. The highlighter itself
 * ships eleven grammars; guessing wrong colours the wrong words, which reads as
 * a broken editor rather than as an unsupported language, so anything not
 * recognised here is rendered as plain monospace text on purpose.
 */

/** Extension (no dot, lowercased) → the fence language the highlighter knows. */
const BY_EXTENSION: Record<string, string> = {
  // JavaScript family. `normalizeLanguage` folds these onto `js` itself; they
  // are listed rather than assumed so a change there cannot silently drop one.
  js: 'js',
  jsx: 'jsx',
  mjs: 'mjs',
  cjs: 'cjs',
  ts: 'ts',
  tsx: 'tsx',
  mts: 'ts',
  cts: 'ts',

  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',

  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ksh: 'shell',

  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yml',

  css: 'css',
  scss: 'scss',
  less: 'less',

  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'xml',
  svg: 'svg',
  vue: 'vue',

  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',

  patch: 'diff',
  diff: 'diff',
};

/**
 * Files whose whole name carries the language, because they have no extension.
 * Lowercased for comparison; `Dockerfile` and `dockerfile` are the same file to
 * everyone except the lookup.
 */
const BY_NAME: Record<string, string> = {
  dockerfile: 'shell',
  makefile: 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  '.env': 'shell',
  '.gitignore': 'shell',
  '.dockerignore': 'shell',
  '.npmrc': 'shell',
  '.editorconfig': 'shell',
};

/** The leaf of a path, in either separator style. */
export function basename(filePath: string): string {
  const trimmed = String(filePath || '').replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/**
 * The highlighter language for a file, or null when there is no honest answer.
 *
 * Null is a real result, not a failure: the editor renders plain monospace for
 * it, which is correct for a language the highlighter does not have.
 */
export function languageForFile(filePath: string): string | null {
  const name = basename(filePath).toLowerCase();
  if (!name) return null;

  const named = BY_NAME[name];
  if (named) return named;

  // `.env.local`, `Dockerfile.dev`: the leading segment is the identity.
  const firstDot = name.indexOf('.', name.startsWith('.') ? 1 : 0);
  if (firstDot > 0) {
    const stem = name.slice(0, firstDot);
    if (BY_NAME[stem]) return BY_NAME[stem];
  }

  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return null;
  return BY_EXTENSION[name.slice(lastDot + 1)] ?? null;
}
