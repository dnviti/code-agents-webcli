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

import { createHash } from 'node:crypto';

const MAX_SLUG = 32;
/** Kubernetes label values are limited to 63 DNS-subdomain-compatible characters. */
const MAX_LABEL_VALUE = 63;
const LABEL_SAFE = /[^A-Za-z0-9._-]/g;

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

/** Every managed container carries the id of the deploy target it was placed on. */
export const TARGET_LABEL = 'com.code-agents-webcli.target';

/** Every project container carries the id of the project it was built for. */
export const PROJECT_LABEL = 'com.code-agents-webcli.project';

/**
 * The numeric suffix of a project container's name.
 *
 * A project's UUID is not a number, and the shared `environmentName` shape —
 * prefix, slug, trailing id that no login fragment can impersonate — wants
 * one. Eight hex characters of the id's SHA-256 read as a uint32 is stable
 * across restarts, unique in practice, and says nothing about the id itself.
 */
export function projectNameHash(projectId: string): number {
  const digest = createHash('sha256').update(projectId).digest('hex').slice(0, 8);
  return Number.parseInt(digest, 16) >>> 0;
}

/**
 * The full container name for a project.
 *
 * Deterministic from the project id and name, so a rebuild after a reclaim
 * lands on the same name — but computed from the *current* name, so a rename
 * changes it. Callers therefore record the name in the project's container
 * metadata at build time and use the recorded name for every operation on an
 * existing container; this function is for creation only.
 */
export function projectContainerName(
  prefix: string,
  project: { id: string; name: string },
): string {
  return environmentName(prefix, {
    id: projectNameHash(project.id),
    githubLogin: `p-${project.name}`,
  });
}

/**
 * Sanitise a value for the `com.code-agents-webcli.target` label.
 *
 * Kubernetes label values are limited to 63 DNS-subdomain-compatible
 * characters. When the original value exceeds that, a deterministic
 * 6-character hash suffix is appended so two truncated values still differ.
 */
export function targetLabelValue(value: string): string {
  const base = (value || '')
    .toLowerCase()
    .replace(LABEL_SAFE, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');

  if (!base) {
    return 'unknown';
  }

  if (base.length <= MAX_LABEL_VALUE) {
    return base;
  }

  // Leave room for a `-<6-char hash>` suffix, and do not let the truncation
  // itself end on a dash or dot.
  const prefix = base.slice(0, MAX_LABEL_VALUE - 7).replace(/[^a-z0-9]+$/, '');
  const hash = createFnvHash(value).slice(0, 6);
  return `${prefix}-${hash}`;
}

function createFnvHash(input: string): string {
  // A small, dependency-free FNV-1a variant keeps this deterministic and
  // readable without pulling in a crypto import for naming alone.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
