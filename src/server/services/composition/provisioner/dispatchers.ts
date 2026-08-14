import { createHash } from 'node:crypto';
import {
  PINNED_TEA_VERSION,
  TEA_TMPFS_XDG_CONFIG_HOME,
} from './artifacts.js';
import { TargetCompatibilityError } from './platform.js';
import { privateDirectory, atomicPublish } from './private-fs.js';

export class ProvisioningFoundationError extends Error {
  constructor(readonly safeCode: string, readonly safeMessage: string) {
    super(safeMessage);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function miseEnvironment(ownerHome: string): Readonly<Record<string, string>> {
  const data = `${ownerHome}/.local/share/code-agents/mise`;
  return {
    HOME: ownerHome,
    PATH: `${data}/shims:${ownerHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    MISE_DATA_DIR: data,
    MISE_CACHE_DIR: `${ownerHome}/.cache/code-agents/mise`,
    MISE_STATE_DIR: `${ownerHome}/.local/state/code-agents/mise`,
    MISE_CONFIG_DIR: '/opt/code-agents-project/mise',
    MISE_CONFIG_FILE: '/opt/code-agents-project/mise.toml',
    MISE_SHIMS_DIR: `${data}/shims`,
    MISE_AUTO_INSTALL: '0',
  };
}

function safeItemFailure(error: unknown, tool: string): { code: string; message: string } {
  if (error instanceof ProvisioningFoundationError) {
    return { code: error.safeCode, message: error.safeMessage };
  }
  if (error instanceof TargetCompatibilityError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INSTALL_FAILED', message: `Could not install ${tool}` };
}

function miseDispatcher(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'case "$(uname -m)" in',
    '  x86_64|amd64) code_agents_arch=x64 ;;',
    '  aarch64|arm64) code_agents_arch=arm64 ;;',
    '  *) echo "mise is unavailable for this architecture" >&2; exit 126 ;;',
    'esac',
    'code_agents_libc=glibc',
    'if command -v ldd >/dev/null 2>&1; then',
    '  case "$(ldd --version 2>&1 || true)" in *musl*) code_agents_libc=musl ;; esac',
    'fi',
    'if test -z "${HOME:-}"; then echo "mise requires HOME" >&2; exit 126; fi',
    'code_agents_binary="$HOME/.local/share/code-agents/platforms/linux-$code_agents_arch-$code_agents_libc/bin/mise"',
    'if test ! -x "$code_agents_binary"; then echo "mise is not installed for this platform" >&2; exit 127; fi',
    'code_agents_invoked_as=${0##*/}',
    'if test "$code_agents_invoked_as" != mise; then',
    '  exec "$code_agents_binary" exec -- "$code_agents_invoked_as" "$@"',
    'fi',
    'exec "$code_agents_binary" "$@"',
    '',
  ].join('\n');
}

function teaDispatcher(version: string): string {
  if (version !== PINNED_TEA_VERSION) throw new Error('tea dispatcher version is not pinned');
  return [
    '#!/bin/sh',
    'set -eu',
    'case "$(uname -m)" in',
    '  x86_64|amd64) code_agents_arch=x64 ;;',
    '  aarch64|arm64) code_agents_arch=arm64 ;;',
    '  *) echo "tea is unavailable for this architecture" >&2; exit 126 ;;',
    'esac',
    'if test -z "${HOME:-}"; then echo "tea requires HOME" >&2; exit 126; fi',
    `XDG_CONFIG_HOME=${TEA_TMPFS_XDG_CONFIG_HOME}`,
    'export XDG_CONFIG_HOME',
    `code_agents_binary="$HOME/.local/share/code-agents/tools/tea/${version}/linux-$code_agents_arch/tea"`,
    'if test ! -x "$code_agents_binary"; then echo "tea is not installed for this architecture" >&2; exit 127; fi',
    'exec "$code_agents_binary" "$@"',
    '',
  ].join('\n');
}

/** Atomically replace one fixed, owner-only launcher without following links. */
export async function publishPrivateEntrypoint(
  ownerHome: string,
  name: 'mise' | 'tea',
  contents: string,
): Promise<void> {
  const directory = await privateDirectory(ownerHome, ['.local', 'bin']);
  try {
    await atomicPublish(directory, name, contents, 0o700);
  } finally {
    await directory.close();
  }
}

export {
  sha256,
  miseEnvironment,
  safeItemFailure,
  miseDispatcher,
  teaDispatcher,
};
