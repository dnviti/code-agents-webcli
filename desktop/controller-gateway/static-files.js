'use strict';

const fs = require('node:fs');
const path = require('node:path');

function rawPathname(url) {
  const raw = String(url || '/').split('?', 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/');
  if (segments.includes('..') || segments.includes('.')) return null;
  return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

function safeStaticFile(publicDir, requestUrl) {
  const pathname = rawPathname(requestUrl);
  if (pathname === null || pathname.startsWith('/api/')) return null;
  let root;
  try { root = fs.realpathSync(publicDir); } catch { return null; }
  const relative = pathname.replace(/^\/+/, '');
  let candidate = path.resolve(root, relative || 'index.html');
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
    candidate = fs.realpathSync(candidate);
    if (
      candidate !== root
      && candidate.startsWith(`${root}${path.sep}`)
      && fs.statSync(candidate).isFile()
    ) return candidate;
  } catch { /* SPA fallback below */ }
  // Requests without a filename extension are client-side routes.
  if (!path.extname(relative)) {
    candidate = path.join(root, 'index.html');
    try {
      candidate = fs.realpathSync(candidate);
      if (candidate.startsWith(`${root}${path.sep}`) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 404 */ }
  }
  return null;
}

module.exports = {
  rawPathname,
  safeStaticFile,
};