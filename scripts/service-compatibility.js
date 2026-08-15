'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Canonical homes for the service modules that historically compiled directly
 * into dist/server/services. Keep this list explicit: each key is a published
 * deep-import path that must remain available even though its implementation is
 * now grouped by domain.
 */
const ROOT_SERVICE_FORWARDERS = Object.freeze({
  'account-tab-coordinator': 'identity/account-tab-coordinator',
  'agent-maintenance': 'runtime/agents/agent-maintenance',
  'agent-maintenance-runtime': 'runtime/agents/agent-maintenance-runtime',
  ansi: 'runtime/terminal/ansi',
  'attachment-store': 'workspace/artifacts/attachment-store',
  auth: 'identity/auth',
  'build-info': 'release/build-info',
  'claude-account': 'identity/claude-account',
  'codex-pricing': 'usage/codex-pricing',
  'connected-host-validator': 'projects/connections/connected-host-validator',
  database: 'persistence/app/database',
  'data-dir-lease': 'persistence/app/data-dir-lease',
  'deploy-targets': 'projects/deployment/deploy-targets',
  encryption: 'persistence/security/encryption',
  'history-store': 'workspace/artifacts/history-store',
  'lan-discovery': 'network/lan-discovery',
  'paste-store': 'workspace/artifacts/paste-store',
  'project-attachment-store': 'projects/attachments/project-attachment-store',
  pty: 'runtime/terminal/pty',
  'runtime-profiles': 'runtime/profiles/runtime-profiles',
  'safe-session-file': 'workspace/artifacts/safe-session-file',
  scrollback: 'runtime/terminal/scrollback',
  'self-update': 'release/self-update',
  'server-identity': 'network/server-identity',
  'session-store': 'workspace/session/session-store',
  'session-teardown': 'workspace/session/session-teardown',
  sqlite: 'persistence/app/sqlite',
  'storage-usage': 'storage/storage-usage',
  'storage-usage-manager': 'storage/storage-usage-manager',
  'tier-writer': 'runtime/profiles/tier-writer',
  tls: 'network/tls',
  'transcript-store': 'workspace/artifacts/transcript-store',
  'update-check': 'release/update-check',
  'usage-analytics': 'usage/usage-analytics',
  'usage-reader': 'usage/usage-reader',
  'usage-store': 'usage/usage-store',
  'user-preferences': 'identity/user-preferences',
  'workspace-catalog': 'workspace/catalog/workspace-catalog',
  'workspace-cwd-helper': 'workspace/session/io/workspace-cwd-helper',
  'workspace-cwd-helper-async': 'workspace/session/io/workspace-cwd-helper-async',
  'workspace-cwd-helper-async-worker': 'workspace/session/io/workspace-cwd-helper-async-worker',
  'workspace-cwd-helper-broker': 'workspace/session/io/workspace-cwd-helper-broker',
  'workspace-cwd-helper-child': 'workspace/session/io/workspace-cwd-helper-child',
  'workspace-private-path': 'workspace/catalog/workspace-private-path',
  'workspace-session-database': 'workspace/session/workspace-session-database',
  'workspace-session-directory-async': 'workspace/session/workspace-session-directory-async',
  'workspace-session-directory-worker': 'workspace/session/workspace-session-directory-worker',
  'workspace-session-lease-cache': 'workspace/session/workspace-session-lease-cache',
  'workspace-session-migrator': 'workspace/session/workspace-session-migrator',
  'workspace-session-storage': 'workspace/session/workspace-session-storage',
  'workspace-usage-coordinator': 'usage/workspace-usage-coordinator',
});

/**
 * Split implementations used to live in these service-root directories. Their
 * individual compiled paths are just as public as the root facades because the
 * package intentionally supports wildcard deep imports.
 */
const SERVICE_DIRECTORY_FORWARDERS = Object.freeze({
  'attachment-store': 'workspace/artifacts/attachment-store',
  'session-store': 'workspace/session/session-store',
  'usage-reader': 'usage/usage-reader',
  'usage-store': 'usage/usage-store',
  'workspace-session-database': 'workspace/session/workspace-session-database',
  'workspace-session-migrator': 'workspace/session/workspace-session-migrator',
});

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walkJavaScriptFiles(root, current = root, result = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkJavaScriptFiles(root, absolute, result);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(toPosix(path.relative(root, absolute)).slice(0, -3));
    }
  }
  return result;
}

function listLegacyServiceForwarders(servicesDirectory) {
  const entries = Object.entries(ROOT_SERVICE_FORWARDERS).map(([legacy, canonical]) => ({
    legacy,
    canonical,
  }));

  for (const [legacyDirectory, canonicalDirectory] of Object.entries(SERVICE_DIRECTORY_FORWARDERS)) {
    const absoluteCanonical = path.join(servicesDirectory, ...canonicalDirectory.split('/'));
    if (!fs.existsSync(absoluteCanonical)) {
      throw new Error(`Canonical service directory is missing: ${absoluteCanonical}`);
    }
    for (const relative of walkJavaScriptFiles(absoluteCanonical).sort()) {
      entries.push({
        legacy: `${legacyDirectory}/${relative}`,
        canonical: `${canonicalDirectory}/${relative}`,
      });
    }
  }

  return entries;
}

function moduleSpecifier(fromFile, targetFile) {
  let relative = toPosix(path.relative(path.dirname(fromFile), targetFile));
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

function declarationHasDefaultExport(source) {
  return /\bexport\s+default\b/.test(source)
    || /\bexport\s*\{[^}]*\bdefault\b[^}]*\}/s.test(source);
}

function mappedSource(mapFile, canonicalFile) {
  let sourceFile = canonicalFile;
  const canonicalMapFile = `${canonicalFile}.map`;
  if (fs.existsSync(canonicalMapFile)) {
    try {
      const canonicalMap = JSON.parse(fs.readFileSync(canonicalMapFile, 'utf8'));
      if (typeof canonicalMap.sources?.[0] === 'string') {
        sourceFile = path.resolve(
          path.dirname(canonicalMapFile),
          canonicalMap.sourceRoot || '',
          canonicalMap.sources[0],
        );
      }
    } catch {
      // A canonical map is optional; the compiled artifact remains a valid source.
    }
  }
  return toPosix(path.relative(path.dirname(mapFile), sourceFile));
}

function writeForwarderMap(mapFile, generatedFile, canonicalFile, mappedLines) {
  fs.writeFileSync(mapFile, JSON.stringify({
    version: 3,
    file: path.basename(generatedFile),
    sourceRoot: '',
    sources: [mappedSource(mapFile, canonicalFile)],
    names: [],
    // Map each generated export/require line to the canonical source entry.
    mappings: Array.from({ length: mappedLines }, () => 'AAAA').join(';'),
  }));
}

function writeLegacyServiceForwarders(servicesDirectory) {
  const entries = listLegacyServiceForwarders(servicesDirectory);

  for (const { legacy, canonical } of entries) {
    const legacyJavaScript = path.join(servicesDirectory, ...legacy.split('/')) + '.js';
    const canonicalJavaScript = path.join(servicesDirectory, ...canonical.split('/')) + '.js';
    if (!fs.existsSync(canonicalJavaScript)) {
      throw new Error(`Canonical service module is missing: ${canonicalJavaScript}`);
    }

    fs.mkdirSync(path.dirname(legacyJavaScript), { recursive: true });
    const javascriptSpecifier = moduleSpecifier(legacyJavaScript, canonicalJavaScript);
    fs.writeFileSync(
      legacyJavaScript,
      `'use strict';\nmodule.exports = require('${javascriptSpecifier}');\n`
        + `//# sourceMappingURL=${path.basename(legacyJavaScript)}.map\n`,
    );
    writeForwarderMap(`${legacyJavaScript}.map`, legacyJavaScript, canonicalJavaScript, 2);

    const canonicalDeclaration = canonicalJavaScript.slice(0, -3) + '.d.ts';
    if (!fs.existsSync(canonicalDeclaration)) continue;

    const legacyDeclaration = legacyJavaScript.slice(0, -3) + '.d.ts';
    const declarationSpecifier = moduleSpecifier(legacyDeclaration, canonicalJavaScript);
    const canonicalSource = fs.readFileSync(canonicalDeclaration, 'utf8');
    const lines = [`export * from '${declarationSpecifier}';`];
    if (declarationHasDefaultExport(canonicalSource)) {
      lines.push(`export { default } from '${declarationSpecifier}';`);
    }
    const declarationLines = lines.length;
    lines.push(`//# sourceMappingURL=${path.basename(legacyDeclaration)}.map`);
    fs.writeFileSync(legacyDeclaration, `${lines.join('\n')}\n`);
    writeForwarderMap(
      `${legacyDeclaration}.map`,
      legacyDeclaration,
      canonicalDeclaration,
      declarationLines,
    );
  }

  return entries;
}

module.exports = {
  ROOT_SERVICE_FORWARDERS,
  SERVICE_DIRECTORY_FORWARDERS,
  listLegacyServiceForwarders,
  writeLegacyServiceForwarders,
};
