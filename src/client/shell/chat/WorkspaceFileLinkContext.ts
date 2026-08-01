import * as React from 'react';
import type { WorkspaceFileTarget } from '../../chat/file-links.js';

/**
 * File-link routing for the active transcript.
 *
 * Kept in context so streamed message bubbles do not need another prop threaded
 * through their memoisation boundary. A Markdown renderer outside ChatView has
 * no scope and therefore cannot turn a machine-local path into an active link.
 */
export interface WorkspaceFileLinkScope {
  workingDir: string;
  onOpen(target: WorkspaceFileTarget): void;
}

export const WorkspaceFileLinkContext = React.createContext<WorkspaceFileLinkScope | null>(null);
