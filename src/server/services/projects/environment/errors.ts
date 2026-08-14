/** A same-name container is known to belong to somebody else; never touch it. */
export class ProjectContainerOwnershipError extends Error {}

/**
 * Engine preparation may have left this project's deterministic container
 * running, but ownership/absence or a successful stop could not be proven.
 * Callers must record the name and retain a counted lifecycle state.
 */
export class ProjectContainerStateUnknownError extends Error {
  constructor(message: string, readonly containerName: string) {
    super(message);
  }
}

/** Workspace history could not be moved without risking traversal or loss. */
export class ProjectWorkspaceSessionStorageError extends Error {}
