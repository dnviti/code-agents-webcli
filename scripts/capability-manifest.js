'use strict';

// Per-file integration capability requirements.

// These are whole-file requirements observed in restricted runners.  Keeping
// this list explicit makes a skipped integration suite visible and auditable.
const capabilityManifest = Object.freeze({
  'test/adapter-stdin.test.js': ['subprocess'],
  'test/agent-maintenance-runtime.test.js': ['subprocess'],
  'test/agent-maintenance.test.js': ['loopbackTcp'],
  'test/chat-approval-mode-live.test.js': ['unixSocket'],
  'test/chat-attachment-route.test.js': ['loopbackTcp'],
  'test/chat-branch.test.js': ['loopbackTcp'],
  'test/chat-clear-reset.test.js': ['unixSocket'],
  'test/chat-installed-commands.test.js': ['unixSocket'],
  'test/chat-permission-broker.test.js': ['asyncSubprocess', 'unixSocket'],
  'test/chat-pi.test.js': ['unixSocket'],
  'test/chat-questions.test.js': ['asyncSubprocess', 'unixSocket'],
  'test/chat-queue-handover.test.js': ['subprocess', 'unixSocket'],
  'test/chat-resumable.test.js': ['loopbackTcp'],
  'test/chat-terminal-scope.test.js': ['loopbackTcp'],
  'test/chat-tool-activity.test.js': ['unixSocket'],
  'test/cli-starts.test.js': ['loopbackTcp', 'subprocess'],
  'test/composition-inspector.test.js': ['subprocess'],
  'test/composition-provisioner.test.js': ['subprocess'],
  'test/connected-hosts-routes.test.js': ['loopbackTcp'],
  'test/controller-gateway.test.js': ['loopbackTcp'],
  'test/controller-runtime.test.js': ['loopbackTcp'],
  'test/controller-transport.test.js': ['loopbackTcp', 'subprocess'],
  'test/conversation-list.test.js': ['loopbackTcp'],
  'test/data-dir-lease.test.js': ['loopbackTcp', 'subprocess'],
  'test/deploy-targets-routes.test.js': ['loopbackTcp'],
  'test/desktop-attachment-electron.test.js': ['subprocess'],
  'test/desktop-server.test.js': ['loopbackTcp'],
  'test/environment-disabled.test.js': ['subprocess'],
  'test/export-sanitising.test.js': ['loopbackTcp'],
  'test/file-callback.test.js': ['subprocess', 'unixSocket'],
  'test/git-identity-routes.test.js': ['loopbackTcp'],
  'test/history-access.test.js': ['loopbackTcp'],
  'test/install-surface.test.js': ['subprocess'],
  'test/packaged-desktop-smoke.test.js': ['loopbackTcp'],
  'test/paste-route.test.js': ['loopbackTcp'],
  'test/phone-access-controller-gateway.test.js': ['loopbackTcp'],
  'test/phone-access-gateway.test.js': ['loopbackTcp'],
  'test/phone-access-security.test.js': ['loopbackTcp'],
  'test/project-composition-routes.test.js': ['loopbackTcp'],
  'test/project-container-workspace.test.js': ['loopbackTcp', 'subprocess'],
  'test/project-folder-routes.test.js': ['loopbackTcp'],
  'test/project-server-composition.test.js': ['loopbackTcp'],
  'test/project-session-integration.test.js': ['loopbackTcp'],
  'test/project-session-staging-startup.test.js': ['loopbackTcp'],
  'test/projects-core.test.js': ['subprocess'],
  'test/projects-routes.test.js': ['loopbackTcp'],
  'test/release-pipeline.test.js': ['subprocess'],
  'test/server-identity-discovery.test.js': ['loopbackTcp'],
  'test/session-rename.test.js': ['loopbackTcp'],
  'test/session-sync.test.js': ['loopbackTcp'],
  'test/storage-usage-routes.test.js': ['loopbackTcp'],
  'test/tls.test.js': ['loopbackTcp', 'subprocess'],
  'test/update-routes.test.js': ['loopbackTcp'],
  'test/usage-conversations.test.js': ['loopbackTcp'],
  'test/usage-projects.test.js': ['loopbackTcp'],
  'test/usage-routes.test.js': ['loopbackTcp'],
  'test/user-preferences.test.js': ['loopbackTcp'],
  'test/workspace-routes.test.js': ['loopbackTcp', 'subprocess'],
  'test/workspace-session-migration-regressions.test.js': ['loopbackTcp'],
});

// These mixed suites self-skip native child cases during an ordinary local
// run, while strict/native CI must prove synchronous captured-child support.
const strictCapabilityManifest = Object.freeze({
  'test/workspace-portable-storage.test.js': ['nestedSubprocess'],
  'test/workspace-session-migrator.test.js': ['nestedSubprocess'],
});

function requiredCapabilitiesFor(testFile, root = process.cwd(), options = {}) {
  const relative = testFile.startsWith('test/')
    ? testFile
    : require('node:path').relative(root, testFile).split(require('node:path').sep).join('/');
  return [...new Set([
    ...(capabilityManifest[relative] || []),
    ...(options.strict ? strictCapabilityManifest[relative] || [] : []),
  ])];
}

module.exports = { capabilityManifest, strictCapabilityManifest, requiredCapabilitiesFor };
