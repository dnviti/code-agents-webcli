/** Installation-owned workspace state is never a generic project file. */
export const WORKSPACE_PRIVATE_COMPONENT = '.cc-web';

/**
 * Component-safe on POSIX paths, Windows paths and container paths.
 *
 * Checking absolute/resolved paths as well as client-relative input makes the
 * rule independent of the session cwd: a session accidentally restored with
 * `.cc-web` itself as cwd cannot browse the state directory as if it were a
 * project root. Case-folding is required on Windows and conservatively hides
 * the same spelling on case-sensitive hosts too.
 */
export function isWorkspacePrivatePath(value: string): boolean {
  return String(value)
    .split(/[\\/]+/)
    .some((component) => component.toLowerCase() === WORKSPACE_PRIVATE_COMPONENT);
}
