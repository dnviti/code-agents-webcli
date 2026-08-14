import type { TargetPlatform } from './platform.js';

export interface MiseArtifact {
  /** A pinned mise release, never a moving tag. */
  version: string;
  platform: Pick<TargetPlatform, 'os' | 'arch' | 'libc'>;
  url: string;
  sha256: string;
}

export interface TeaArtifact {
  /** Exact official tea release, never a moving tag. */
  version: string;
  platform: Pick<TargetPlatform, 'os' | 'arch'>;
  url: string;
  sha256: string;
}

const MISE_RELEASE_BASE = 'https://github.com/jdx/mise/releases/download/v2026.8.1';

/** Official v2026.8.1 direct binaries, pinned from its SHASUMS256.txt. */
export const PINNED_MISE_ARTIFACTS: readonly MiseArtifact[] = Object.freeze([
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'arm64' as const, libc: 'glibc' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-arm64`,
    sha256: '54f9e0b4c4085cde1c80e107671a0058d4b234f7d2fc6bd3b61ead68df6cfcef',
  }),
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'arm64' as const, libc: 'musl' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-arm64-musl`,
    sha256: '509e42504b83347d8ae3d63f6d284c4a8f8c807ec775a102cfc20d7c8bef4b0b',
  }),
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'x64' as const, libc: 'glibc' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-x64`,
    sha256: '961b1fcc78830e861ab887abd19d9b961478bcf252e37881fdd61c81388308d4',
  }),
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'x64' as const, libc: 'musl' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-x64-musl`,
    sha256: '522fd15a3b0748d8a240bdf06cd45f679f759a097e2f49b436363e92c48fdbdc',
  }),
]);

export const PINNED_TEA_VERSION = '0.15.1' as const;
export const TEA_TMPFS_XDG_CONFIG_HOME = '/run/code-agents-forge/xdg' as const;
const TEA_RELEASE_BASE = `https://gitea.com/gitea/tea/releases/download/v${PINNED_TEA_VERSION}`;

/** Official v0.15.1 direct binaries, pinned from its checksums.txt release asset. */
export const PINNED_TEA_ARTIFACTS: readonly TeaArtifact[] = Object.freeze([
  Object.freeze({
    version: PINNED_TEA_VERSION,
    platform: Object.freeze({ os: 'linux' as const, arch: 'arm64' as const }),
    url: `${TEA_RELEASE_BASE}/tea-${PINNED_TEA_VERSION}-linux-arm64`,
    sha256: '0db109df6696bfe01f9203402f503404692404d4ea9c16a540ecaeecc8e6bab2',
  }),
  Object.freeze({
    version: PINNED_TEA_VERSION,
    platform: Object.freeze({ os: 'linux' as const, arch: 'x64' as const }),
    url: `${TEA_RELEASE_BASE}/tea-${PINNED_TEA_VERSION}-linux-amd64`,
    sha256: 'aac99cc6e650a81ae7b5061f8c75bc0eade4509c828d97b6072e1f0a3bd24357',
  }),
]);

export type MiseArtifactFetcher = (artifact: MiseArtifact) => Promise<Uint8Array>;
export type TeaArtifactFetcher = (artifact: TeaArtifact) => Promise<Uint8Array>;

// v2026.8.1's largest pinned Linux binary is about 106 MiB. Keep a bounded
// allowance above the verified artifact set without accepting arbitrary-sized
// responses from the release host.
export const MISE_BINARY_MAX_BYTES = 128 * 1024 * 1024;
export const TEA_BINARY_MAX_BYTES = 64 * 1024 * 1024;

/** Network implementation for production; tests inject a byte fixture. */
export async function fetchPinnedMiseArtifact(artifact: MiseArtifact): Promise<Uint8Array> {
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com'
    || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error('mise artifact pin is invalid');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    // GitHub's immutable release URL redirects to signed object storage.
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || new URL(response.url).protocol !== 'https:') {
      throw new Error('mise artifact download failed');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MISE_BINARY_MAX_BYTES) {
      throw new Error('mise artifact is too large');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MISE_BINARY_MAX_BYTES) {
      throw new Error('mise artifact has an invalid size');
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/** Download only a compile-time pinned official tea artifact. */
export async function fetchPinnedTeaArtifact(artifact: TeaArtifact): Promise<Uint8Array> {
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.hostname !== 'gitea.com'
    || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error('tea artifact pin is invalid');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    // Gitea's immutable release URL redirects to its signed object-storage URL.
    // The initial URL is fixed above and the final transport must remain HTTPS.
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || new URL(response.url).protocol !== 'https:') {
      throw new Error('tea artifact download failed');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > TEA_BINARY_MAX_BYTES) {
      throw new Error('tea artifact is too large');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > TEA_BINARY_MAX_BYTES) {
      throw new Error('tea artifact has an invalid size');
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}
