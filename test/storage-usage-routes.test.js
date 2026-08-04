const assert = require('node:assert/strict');
const express = require('express');

const { createStorageUsageRoutes } = require('../dist/server/routes/storage-usage.js');

function report(totalBytes = 10) {
  return {
    recordedAt: new Date(0).toISOString(),
    totalBytes,
    homeBytes: totalBytes,
    agentsBytes: 0,
    toolingBytes: 0,
    otherHomeBytes: totalBytes,
    projects: [],
    filesystems: [],
    warnings: {
      user: false,
      admin: false,
      userThresholdBytes: null,
      adminThresholdBytes: null,
    },
    errors: [],
    complete: true,
  };
}

async function serverFor({ userId = 1, installerUserId = 1 } = {}) {
  const calls = [];
  const storageUsage = {
    async reportForUser(id, refresh) {
      calls.push(['user', id, refresh]);
      return report(id);
    },
    async reportsForAdmin(refresh) {
      calls.push(['admin-list', refresh]);
      return [{ userId: 1, login: 'one', report: report(1) }];
    },
    async reportForAdmin(id, refresh) {
      calls.push(['admin-one', id, refresh]);
      return id === 404 ? null : { userId: id, login: `user-${id}`, report: report(id) };
    },
    async clearCache(id, action) {
      calls.push(['clear', id, action]);
      return report(0);
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.authContext = userId === null
      ? { user: null, authSessionId: null }
      : {
          user: {
            id: userId,
            githubId: String(userId),
            githubLogin: `user-${userId}`,
            githubName: null,
            avatarUrl: null,
            email: null,
          },
          authSessionId: 'session',
        };
    next();
  });
  app.use(createStorageUsageRoutes({ storageUsage, getInstallerUserId: () => installerUserId }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { server, calls };
}

async function request(server, pathname, options = {}) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${pathname}`, options);
}

describe('storage usage routes', () => {
  it('returns only the signed-in user report and accepts an explicit refresh', async () => {
    const { server, calls } = await serverFor({ userId: 7 });
    try {
      const response = await request(server, '/api/usage/storage?refresh=1');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).report.totalBytes, 7);
      assert.deepEqual(calls, [['user', 7, true]]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps the all-user view installer-only', async () => {
    const { server, calls } = await serverFor({ userId: 2, installerUserId: 1 });
    try {
      const response = await request(server, '/api/admin/usage/storage');
      assert.equal(response.status, 403);
      assert.deepEqual(calls, []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns a 404 for an unknown user without widening the ordinary route', async () => {
    const { server } = await serverFor();
    try {
      const response = await request(server, '/api/admin/usage/storage/404');
      assert.equal(response.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('accepts only opaque cleanup actions through a same-origin write', async () => {
    const { server, calls } = await serverFor({ userId: 9 });
    try {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;
      const rejected = await fetch(`${base}/api/usage/storage/cache/miseDownloads`, {
        method: 'DELETE',
        headers: { Origin: 'https://elsewhere.example' },
      });
      assert.equal(rejected.status, 403);
      const accepted = await fetch(`${base}/api/usage/storage/cache/miseDownloads`, {
        method: 'DELETE',
        headers: { Origin: base },
      });
      assert.equal(accepted.status, 200);
      const unused = await fetch(`${base}/api/usage/storage/cache/unusedToolVersions`, {
        method: 'DELETE',
        headers: { Origin: base },
      });
      assert.equal(unused.status, 200);
      const browserToolName = await fetch(`${base}/api/usage/storage/cache/node`, {
        method: 'DELETE',
        headers: { Origin: base },
      });
      assert.equal(browserToolName.status, 400, 'tool names are never accepted from the browser');
      const inheritedName = await fetch(`${base}/api/usage/storage/cache/toString`, {
        method: 'DELETE',
        headers: { Origin: base },
      });
      assert.equal(inheritedName.status, 400, 'prototype names are not cleanup actions');
      assert.deepEqual(calls, [
        ['clear', 9, 'miseDownloads'],
        ['clear', 9, 'unusedToolVersions'],
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
