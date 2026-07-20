const assert = require('assert');
const { classifyPaste, MAX_IMAGES_PER_PASTE } = require('../dist/shared/paste-classify.js');

const MAX = 10 * 1024 * 1024;

function image(size = 1024, type = 'image/png') {
  return { kind: 'file', type, size };
}

function text() {
  return { kind: 'string', type: 'text/plain', size: 12 };
}

describe('classifyPaste', function () {
  // The single highest-blast-radius behaviour in the feature: getting this
  // wrong breaks ordinary text pasting for every user, in every terminal.
  it('does not touch a text-only paste', function () {
    const result = classifyPaste([text()], MAX);
    assert.strictEqual(result.handled, false);
    assert.deepStrictEqual(result.accepted, []);
  });

  it('does not touch an empty clipboard', function () {
    assert.strictEqual(classifyPaste([], MAX).handled, false);
  });

  it('does not claim a non-image file', function () {
    // A dragged .zip or .pdf belongs to whatever handles it next, not here.
    const result = classifyPaste([{ kind: 'file', type: 'application/zip', size: 2048 }], MAX);
    assert.strictEqual(result.handled, false);
  });

  it('claims a pasted image', function () {
    const result = classifyPaste([image()], MAX);
    assert.strictEqual(result.handled, true);
    assert.deepStrictEqual(result.accepted, [0]);
  });

  it('claims the image half of a mixed text and image paste', function () {
    // A screenshot with a caption: one event carries both.
    const result = classifyPaste([text(), image()], MAX);
    assert.strictEqual(result.handled, true);
    assert.deepStrictEqual(result.accepted, [1]);
  });

  it('keeps clipboard order', function () {
    const result = classifyPaste([image(), text(), image(), image()], MAX);
    assert.deepStrictEqual(result.accepted, [0, 2, 3]);
  });

  it('accepts every format the server accepts', function () {
    const types = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
    for (const type of types) {
      assert.strictEqual(classifyPaste([image(1024, type)], MAX).handled, true, type);
    }
  });

  it('flags an oversize image instead of ignoring it', function () {
    const result = classifyPaste([image(MAX + 1)], MAX);
    // Still "handled": the user pasted a picture and deserves to be told it
    // was too big, not to have its bytes typed into the terminal.
    assert.strictEqual(result.handled, true);
    assert.deepStrictEqual(result.accepted, []);
    assert.deepStrictEqual(result.oversize, [0]);
  });

  it('accepts an image exactly at the limit', function () {
    const result = classifyPaste([image(MAX)], MAX);
    assert.deepStrictEqual(result.accepted, [0]);
    assert.deepStrictEqual(result.oversize, []);
  });

  it('caps how many images one paste can carry', function () {
    // A folder drag can hold hundreds of files, and each one is an upload.
    const many = Array.from({ length: 10 }, () => image());
    const result = classifyPaste(many, MAX);
    assert.strictEqual(result.accepted.length, MAX_IMAGES_PER_PASTE);
    assert.strictEqual(result.overflow, 10 - MAX_IMAGES_PER_PASTE);
  });

  it('reports both overflow and oversize together', function () {
    const candidates = [
      ...Array.from({ length: MAX_IMAGES_PER_PASTE }, () => image()),
      image(MAX + 1),
      image(),
    ];
    const result = classifyPaste(candidates, MAX);
    assert.strictEqual(result.accepted.length, MAX_IMAGES_PER_PASTE);
    assert.deepStrictEqual(result.oversize, [MAX_IMAGES_PER_PASTE]);
    assert.strictEqual(result.overflow, 1);
  });
});
