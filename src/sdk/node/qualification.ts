import type { CodeAgentsServer } from './contract.js';

/** Raw implementation access reserved for packaged persistence qualification. */
export function implementationForQualification(host: CodeAgentsServer) {
  return (require('./implementation.js') as typeof import('./implementation.js')).implementationForQualification(host);
}

/** Runtime primitives exercised by the packaged desktop qualification suite. */
export const qualificationTools = () => ({
    get BaseBridge() { return (require('../../server/bridges/base.js') as typeof import('../../server/bridges/base.js')).BaseBridge; },
    get TerminalBridge() { return (require('../../server/bridges/terminal.js') as typeof import('../../server/bridges/terminal.js')).TerminalBridge; },
    get PermissionBroker() { return (require('../../server/chat/permission-broker.js') as typeof import('../../server/chat/permission-broker.js')).PermissionBroker; },
    get ptySource() { return (require('../../server/services/pty.js') as typeof import('../../server/services/pty.js')).ptySource; },
  });
