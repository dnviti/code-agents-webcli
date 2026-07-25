const assert = require('assert');
const { mediaTypeForFile, isMarkdownFile, isHtmlFile } = require('../dist/shared/file-media.js');
const { sniffMediaType, looksLikeSvg } = require('../dist/shared/media-sniff.js');
const {
  describeSlashCommand,
  isClearingCommand,
  isCompactingCommand,
} = require('../dist/shared/slash-commands.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');

// The two halves of "show this file rather than refusing it", plus the
// conversation markers.
//
// The split between these first two is the point and is worth stating: the
// *name* picks which element to render, because getting that wrong costs a
// broken preview; the *bytes* pick the content type the server sends, because
// getting that wrong is a stored XSS. They are tested separately for the same
// reason they are written separately.

const bytes = (...parts) =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'binary') : Buffer.from(p))));

describe('picking a viewer from a filename', function () {
  it('recognises the formats a browser can actually show', function () {
    assert.strictEqual(mediaTypeForFile('shot.png').kind, 'image');
    assert.strictEqual(mediaTypeForFile('photo.JPEG').kind, 'image', 'extensions are case-insensitive');
    assert.strictEqual(mediaTypeForFile('a/b/clip.mp4').kind, 'video');
    assert.strictEqual(mediaTypeForFile('voice.m4a').kind, 'audio');
    assert.strictEqual(mediaTypeForFile('manual.pdf').kind, 'pdf');
    assert.strictEqual(mediaTypeForFile('logo.svg').kind, 'image');
  });

  it('refuses formats a browser would load and then silently not play', function () {
    // "This file is binary" is at least true; an audio element that never
    // starts is a worse answer than that.
    assert.strictEqual(mediaTypeForFile('movie.mkv'), null);
    assert.strictEqual(mediaTypeForFile('track.wma'), null);
  });

  it('is not media for ordinary source and for names with no extension', function () {
    for (const name of ['index.ts', 'README', 'Makefile', '.gitignore', '', 'trailing.']) {
      assert.strictEqual(mediaTypeForFile(name), null, `${name} should not be media`);
    }
  });

  it('knows markdown from everything else', function () {
    assert.ok(isMarkdownFile('README.md'));
    assert.ok(isMarkdownFile('docs/GUIDE.MARKDOWN'));
    assert.ok(isMarkdownFile('page.mdx'));
    assert.ok(!isMarkdownFile('notes.txt'));
    assert.ok(!isMarkdownFile('mdfile'));
  });
});

describe('deciding a content type from the bytes', function () {
  it('identifies the formats it claims to', function () {
    assert.deepStrictEqual(sniffMediaType(bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 0])), { kind: 'image', mime: 'image/png' });
    assert.strictEqual(sniffMediaType(bytes([0xff, 0xd8, 0xff], 'x'.repeat(12))).mime, 'image/jpeg');
    assert.strictEqual(sniffMediaType(bytes('GIF89a', 'x'.repeat(12))).mime, 'image/gif');
    assert.strictEqual(sniffMediaType(bytes('RIFF', '\0\0\0\0', 'WEBP')).mime, 'image/webp');
    assert.strictEqual(sniffMediaType(bytes('RIFF', '\0\0\0\0', 'WAVE')).mime, 'audio/wav');
    assert.strictEqual(sniffMediaType(bytes('%PDF-1.7', 'x'.repeat(12))).mime, 'application/pdf');
    assert.strictEqual(sniffMediaType(bytes([0, 0, 0, 0x20], 'ftypisom', 'x'.repeat(8))).mime, 'video/mp4');
    assert.strictEqual(sniffMediaType(bytes([0, 0, 0, 0x20], 'ftypM4A ', 'x'.repeat(8))).mime, 'audio/mp4');
    assert.strictEqual(sniffMediaType(bytes([0, 0, 0, 0x20], 'ftypqt  ', 'x'.repeat(8))).mime, 'video/quicktime');
    assert.strictEqual(sniffMediaType(bytes('fLaC', 'x'.repeat(12))).mime, 'audio/flac');
    assert.strictEqual(sniffMediaType(bytes('ID3', 'x'.repeat(12))).mime, 'audio/mpeg');
    assert.strictEqual(sniffMediaType(bytes('OggS', 'x'.repeat(40), 'theora')).mime, 'video/ogg');
    assert.strictEqual(sniffMediaType(bytes('OggS', 'x'.repeat(40), 'vorbis')).mime, 'audio/ogg');
  });

  it('identifies nothing it cannot vouch for', function () {
    // The caller turns null into an opaque download, which is the honest
    // answer for a file this cannot recognise.
    assert.strictEqual(sniffMediaType(bytes('<script>alert(1)</script>')), null);
    assert.strictEqual(sniffMediaType(bytes('#!/bin/sh\necho hi\n')), null);
    assert.strictEqual(sniffMediaType(bytes('RIFF', '\0\0\0\0', 'AVI ')), null, 'a container nothing here plays');
    assert.strictEqual(sniffMediaType(bytes([0x1a, 0x45, 0xdf, 0xa3], 'x'.repeat(40))), null, 'matroska that is not webm');
    assert.strictEqual(sniffMediaType(Buffer.alloc(4)), null, 'too short to say anything');
  });

  it('never lets a filename talk it into a type', function () {
    // The whole attack: markup wearing an image's name. The sniff does not see
    // the name at all, which is what makes that impossible rather than unlikely.
    assert.strictEqual(sniffMediaType(bytes('<html><body>hi</body></html>')), null);
  });

  it('accepts an SVG that opens like markup and rejects one that does not', function () {
    assert.ok(looksLikeSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')));
    assert.ok(looksLikeSvg(bytes('  <?xml version="1.0"?><svg/>')));
    assert.ok(!looksLikeSvg(bytes('GIF89a')));
    assert.ok(!looksLikeSvg(bytes('just some text')));
  });
});

describe('slash commands', function () {
  it('describes the built-ins a runtime reports by name alone', function () {
    assert.match(describeSlashCommand('compact'), /summarise/i);
    assert.match(describeSlashCommand('/clear'), /new conversation/i);
    assert.match(describeSlashCommand('MODEL'), /model/i);
  });

  it('says nothing rather than inventing a description', function () {
    // A project command carries its own; guessing from the name would be a
    // guess presented as documentation.
    assert.strictEqual(describeSlashCommand('deploy-to-prod'), undefined);
    assert.strictEqual(describeSlashCommand(''), undefined);
  });

  it('recognises the commands that empty the conversation', function () {
    assert.ok(isClearingCommand('/clear'));
    assert.ok(isClearingCommand('  /new  '));
    assert.ok(isClearingCommand('/reset now'), 'arguments do not change what the command is');
    assert.ok(!isClearingCommand('/clearance-report'), 'a prefix is not a match');
    assert.ok(!isClearingCommand('clear'), 'without the slash it is just a word');
    assert.ok(!isClearingCommand('please /clear it'), 'and only when it leads the message');
    assert.ok(isCompactingCommand('/compact'));
    assert.ok(!isCompactingCommand('/compaction'));
  });
});

describe('markers in the transcript', function () {
  function withTwoMessages() {
    const state = createTranscript({});
    applyChatEvent(state, { t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'user', turnId: 't1' });
    applyChatEvent(state, { t: 'block_start', seq: 2, ts: 1, msgId: 'm1', index: 0, block: { kind: 'text', text: 'hi' } });
    applyChatEvent(state, { t: 'msg_end', seq: 3, ts: 1, msgId: 'm1' });
    applyChatEvent(state, { t: 'msg_start', seq: 4, ts: 1, id: 'm2', role: 'assistant', turnId: 't1' });
    applyChatEvent(state, { t: 'msg_end', seq: 5, ts: 1, msgId: 'm2' });
    return state;
  }

  it('draws a line for a compaction and keeps everything above it', function () {
    const state = withTwoMessages();
    applyChatEvent(state, { t: 'marker', seq: 6, ts: 2, kind: 'compacted', detail: '42k tokens summarised' });

    assert.strictEqual(state.messages.length, 3, 'the conversation is not thrown away');
    const marker = state.messages[2];
    assert.strictEqual(marker.role, 'system');
    assert.deepStrictEqual(marker.blocks, [{
      kind: 'notice',
      notice: 'compacted',
      text: 'Context compacted',
      detail: '42k tokens summarised',
    }]);
  });

  it('empties the window for a clear', function () {
    const state = withTwoMessages();
    applyChatEvent(state, { t: 'marker', seq: 6, ts: 2, kind: 'cleared' });

    assert.deepStrictEqual(state.messages, [], '/clear means start again');
    assert.deepStrictEqual(state.index, {});
  });

  it('stops offering history from before a clear', function () {
    const state = withTwoMessages();
    state.firstSeq = 1;
    applyChatEvent(state, { t: 'marker', seq: 6, ts: 2, kind: 'cleared' });

    // Otherwise "load earlier messages" would undo the clean window one scroll
    // at a time. The log still holds it; this is a view, not a delete.
    assert.strictEqual(state.firstSeq, 6);
  });

  it('refuses a marker it has already applied', function () {
    const state = withTwoMessages();
    applyChatEvent(state, { t: 'marker', seq: 6, ts: 2, kind: 'compacted' });
    const again = applyChatEvent(state, { t: 'marker', seq: 6, ts: 2, kind: 'compacted' });

    assert.strictEqual(again.applied, false, 'a replay must not double the line');
    assert.strictEqual(state.messages.length, 3);
  });
});

describe('picking a page out of the files', function () {
  it('knows the two extensions that are a document', function () {
    assert.ok(isHtmlFile('index.html'));
    assert.ok(isHtmlFile('docs/PAGE.HTM'));
  });

  it('leaves a template alone', function () {
    // A Handlebars or JSX file whose name merely ends in something html-ish
    // renders as a page full of its own braces, which reads as a broken
    // preview rather than the source it actually is.
    for (const name of ['page.html.hbs', 'view.xhtml', 'App.jsx', 'logo.svg', 'notes.txt']) {
      assert.ok(!isHtmlFile(name), `${name} must not be previewed as a page`);
    }
  });
});
