'use strict';

const assert = require('node:assert/strict');
const { findCommand } = require('./browser/find-command.js');

describe('browser command discovery', function () {
  it('searches POSIX PATH directly without relying on which', function () {
    const visited = [];
    const found = findCommand(['google-chrome', 'chromium'], {
      env: { PATH: '/first:/second' },
      platform: 'linux',
      isExecutable: (candidate) => {
        visited.push(candidate);
        return candidate === '/second/chromium';
      },
    });
    assert.strictEqual(found, '/second/chromium');
    assert.deepStrictEqual(visited, [
      '/first/google-chrome',
      '/second/google-chrome',
      '/first/chromium',
      '/second/chromium',
    ]);
  });

  it('honours case-insensitive Path and PATHEXT names on Windows', function () {
    const visited = [];
    const found = findCommand(['chrome'], {
      env: { Path: 'C:\\Tools;"D:\\Browser Bin"', Pathext: '.COM;.EXE' },
      platform: 'win32',
      isExecutable: (candidate) => {
        visited.push(candidate);
        return candidate === 'D:\\Browser Bin\\chrome.EXE';
      },
    });
    assert.strictEqual(found, 'D:\\Browser Bin\\chrome.EXE');
    assert.deepStrictEqual(visited, [
      'C:\\Tools\\chrome.COM',
      'C:\\Tools\\chrome.EXE',
      'D:\\Browser Bin\\chrome.COM',
      'D:\\Browser Bin\\chrome.EXE',
    ]);
  });

  it('does not treat an empty PATH segment as the current directory', function () {
    const visited = [];
    assert.strictEqual(findCommand(['chromium'], {
      env: { PATH: ':/safe::' },
      platform: 'linux',
      isExecutable: (candidate) => { visited.push(candidate); return false; },
    }), null);
    assert.deepStrictEqual(visited, ['/safe/chromium']);
  });
});
