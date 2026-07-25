const assert = require('assert');
const { scoreFilePath, rankFilePaths, mentionAtCaret } = require('../dist/shared/file-match.js');

// The ranking behind the composer's `@` picker.
//
// Tested on ordering rather than on absolute numbers: the scores are an
// implementation detail and will move, but "typing the name of a file puts that
// file first" is the property the picker is worth having for.

/** Which position `wanted` came back in, or -1. */
function rankOf(paths, query, wanted) {
  return rankFilePaths(paths, query).findIndex((match) => match.path === wanted);
}

describe('ranking files for the @ picker', function () {
  const TREE = [
    'src/server/chat/session.ts',
    'src/server/chat/session-store.ts',
    'src/client/chat/session.ts',
    'test/chat-session.test.js',
    'docs/sessions.md',
    'src/client/shell/chat/Composer.tsx',
    'src/client/shell/chat/ChatView.tsx',
    'README.md',
    'package.json',
  ];

  it('puts an exact filename first, ahead of everything that merely contains it', function () {
    const ranked = rankFilePaths(TREE, 'session.ts');
    assert.strictEqual(ranked[0].path.endsWith('/session.ts'), true, `got ${ranked[0].path}`);
    // The shallower of the two exact matches wins the tie.
    assert.strictEqual(ranked[0].path, 'src/client/chat/session.ts');
    assert.ok(
      ranked.findIndex((m) => m.path === 'src/server/chat/session-store.ts')
        > ranked.findIndex((m) => m.path === 'src/server/chat/session.ts'),
      'a longer name that starts with the query must lose to the exact one',
    );
  });

  it('beats a path-only hit with a basename hit', function () {
    assert.ok(
      rankOf(TREE, 'chat', 'test/chat-session.test.js') < rankOf(TREE, 'chat', 'src/server/chat/session.ts'),
      'people type the filename; a directory called chat/ is not what "chat" means',
    );
  });

  it('treats a query with a slash in it as a path fragment', function () {
    const ranked = rankFilePaths(TREE, 'server/chat/ses');
    assert.strictEqual(ranked[0].path, 'src/server/chat/session.ts');
    assert.ok(!ranked.some((m) => m.path === 'src/client/chat/session.ts'), 'the other half of the tree is not a match');
  });

  it('falls back to a subsequence so initials still find something', function () {
    const ranked = rankFilePaths(TREE, 'cmpsr');
    assert.strictEqual(ranked[0].path, 'src/client/shell/chat/Composer.tsx');
  });

  it('never lets a fuzzy hit outrank a literal one', function () {
    // 'cs' threads through nearly every path here as a subsequence.
    const ranked = rankFilePaths(['aXcXsX.txt', 'cs.txt'], 'cs');
    assert.strictEqual(ranked[0].path, 'cs.txt');
  });

  it('is case-insensitive in both directions', function () {
    assert.ok(scoreFilePath('src/Composer.tsx', 'composer') > 0);
    assert.ok(scoreFilePath('src/composer.tsx', 'COMPOSER') > 0);
  });

  it('offers everything for an empty query, so the picker is useful the instant @ is typed', function () {
    assert.strictEqual(rankFilePaths(TREE, '').length, TREE.length);
    assert.strictEqual(rankFilePaths(TREE, '   ').length, TREE.length);
  });

  it('returns nothing rather than everything when there is genuinely no match', function () {
    assert.deepStrictEqual(rankFilePaths(TREE, 'zzzqqq'), []);
  });

  it('honours the limit', function () {
    assert.strictEqual(rankFilePaths(TREE, '', 3).length, 3);
  });

  it('is stable for equal scores', function () {
    const a = rankFilePaths(TREE, '').map((m) => m.path);
    const b = rankFilePaths([...TREE].reverse(), '').map((m) => m.path);
    assert.deepStrictEqual(a, b, 'the same tree in a different order must rank the same');
  });
});

describe('finding the @ mention the caret is in', function () {
  it('reads the token being typed', function () {
    assert.deepStrictEqual(mentionAtCaret('@src/ser', 8), { start: 0, end: 8, query: 'src/ser' });
    assert.deepStrictEqual(mentionAtCaret('look at @comp', 13), { start: 8, end: 13, query: 'comp' });
  });

  it('opens on a bare @, with no query yet', function () {
    assert.deepStrictEqual(mentionAtCaret('@', 1), { start: 0, end: 1, query: '' });
  });

  it('ignores an @ that is not starting a word', function () {
    assert.strictEqual(mentionAtCaret('mail me at dnviti@gmail.com', 27), null);
    assert.strictEqual(mentionAtCaret('list@2', 6), null);
  });

  it('opens after an opening bracket or quote, which do start a word', function () {
    assert.ok(mentionAtCaret('see (@src', 9));
    assert.ok(mentionAtCaret('"@src', 5));
  });

  it('closes once the mention is finished', function () {
    assert.strictEqual(mentionAtCaret('@src/a.ts and then', 18), null);
    assert.strictEqual(mentionAtCaret('@src/a.ts ', 10), null);
  });

  it('reads the token at the caret, not at the end of the draft', function () {
    // Caret parked mid-draft, inside an earlier mention.
    assert.deepStrictEqual(mentionAtCaret('@comp and @view', 5), { start: 0, end: 5, query: 'comp' });
  });

  it('finds nothing in text with no @ at all', function () {
    assert.strictEqual(mentionAtCaret('just a message', 14), null);
    assert.strictEqual(mentionAtCaret('', 0), null);
  });
});
