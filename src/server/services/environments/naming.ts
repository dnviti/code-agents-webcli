/**
 * Turning an account into a container name.
 *
 * The name is what an operator reads on the host to answer "whose is this?", so
 * it has to carry the login. But a login is user-controlled text, and a name
 * built from it alone would let somebody register `alice-2` and land on the
 * container belonging to `alice` with id 2. Every name therefore ends in the
 * numeric account id, which the user does not choose, and the login part is
 * reduced to a character set that cannot produce a trailing `-<digits>` of its
 * own: it is truncated and then stripped of trailing digits and dashes.
 */

const MAX_SLUG = 32;

/** The login part of a name: lowercase, `[a-z0-9-]`, never ending in a digit. */
export function environmentSlug(githubLogin: string): string {
  const cleaned = (githubLogin || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG)
    // Trailing digits are removed so the id suffix is unambiguous: without
    // this, login `bob1` + id `2` and login `bob` + id `12` both read `bob12`.
    .replace(/[0-9-]+$/, '');

  return cleaned || 'user';
}

/** The full container name. Unique per account by construction. */
export function environmentName(
  prefix: string,
  owner: { id: number; githubLogin: string },
): string {
  return `${prefix}-${environmentSlug(owner.githubLogin)}-${owner.id}`;
}

/** Where the user's home lives inside the container. */
export function containerHomeFor(owner: { id: number; githubLogin: string }): string {
  return `/home/${environmentSlug(owner.githubLogin)}-${owner.id}`;
}
