import { workspaceDescriptorRoot } from '../workspace-session-storage.js';

import type { AttachmentDirectoryBackend, ResolvedAttachmentDirectoryBackend } from './types.js';
import { errno } from './util.js';

/**
 * Keep platform selection pure and injectable so macOS/BSD and Windows policy
 * are covered on Linux CI. Descriptor traversal is selected only after the
 * shared resolver has proved real child create/rename/unlink through procfs or
 * fdescfs. Windows uses the path backend for reads and the cwd helper for
 * direct namespace mutations.
 */
export function resolveAttachmentDirectoryBackend(
  requested: AttachmentDirectoryBackend = 'auto',
  platform: NodeJS.Platform = process.platform,
  descriptorNamespaceAvailable = workspaceDescriptorRoot() !== null,
): ResolvedAttachmentDirectoryBackend {
  if (requested === 'path') return requested;
  if (requested === 'descriptor') {
    if (platform === 'win32' || !descriptorNamespaceAvailable) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'secure descriptor traversal is unavailable');
    }
    return requested;
  }
  return platform !== 'win32' && descriptorNamespaceAvailable
    ? 'descriptor'
    : 'path';
}
