/**
 * The pseudo-terminal binding, and the one place that decides where it comes
 * from.
 *
 * The default is `@lydell/node-pty`: a repackaging of Microsoft's node-pty that
 * ships one prebuilt binary per platform through `optionalDependencies` and
 * never calls node-gyp. That single property is what makes
 * `npx github:dnviti/code-agents-webcli` a one-command install — upstream
 * node-pty publishes prebuilds for macOS and Windows only, so on Linux it
 * compiles, which drags in a C++ toolchain and (on npm >= 12) an install-script
 * approval prompt that an npx run has nowhere to record.
 *
 * What that costs: prebuilds exist for linux-x64, linux-arm64, darwin-x64,
 * darwin-arm64, win32-x64 and win32-arm64 only, and the Linux ones are linked
 * against glibc >= 2.28. Alpine/musl and 32-bit ARM have no binary, where
 * upstream node-pty would simply have compiled one.
 *
 * Hence the fallback. `node-pty` is deliberately NOT a dependency of this
 * package — declaring it would put its install script back into everybody's
 * tree — but if a user on such a platform installs it themselves, it is picked
 * up here. The two modules expose the same API; upstream is the code the
 * prebuilt one is built from.
 */

import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from '@lydell/node-pty';

export type { IPty, IPtyForkOptions, IWindowsPtyForkOptions };

export type PtySpawn = (
  file: string,
  args: string[] | string,
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

interface PtyModule {
  spawn: PtySpawn;
}

/** Where the binding came from, for the startup diagnostic. */
export type PtySource = 'prebuilt' | 'compiled';

let cached: { module: PtyModule; source: PtySource } | null = null;

function loadPty(): { module: PtyModule; source: PtySource } {
  if (cached) {
    return cached;
  }

  let prebuiltError: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = { module: require('@lydell/node-pty') as PtyModule, source: 'prebuilt' };
    return cached;
  } catch (error) {
    prebuiltError = error;
  }

  try {
    // Resolved by name at runtime so TypeScript does not demand the types of a
    // package that is intentionally absent from package.json.
    const fallback = require('node-pty') as PtyModule;
    cached = { module: fallback, source: 'compiled' };
    return cached;
  } catch {
    // Report the prebuilt failure, not the fallback's "module not found" — the
    // former says which platform is unsupported, the latter only says the
    // escape hatch was not taken.
    // `cause` is attached rather than passed to the constructor: the server
    // compiles against lib ES2020, which predates the two-argument Error.
    throw Object.assign(new Error(
      'No pseudo-terminal binding is available for '
      + `${process.platform}-${process.arch}.\n\n`
      + `@lydell/node-pty failed to load: ${describe(prebuiltError)}\n\n`
      + 'Prebuilt binaries exist for linux-x64, linux-arm64, darwin-x64, darwin-arm64, '
      + 'win32-x64 and win32-arm64, and the Linux ones need glibc 2.28 or newer '
      + '(Debian 10+, Ubuntu 18.10+, RHEL 8+) — so Alpine/musl and 32-bit ARM are not '
      + 'covered.\n\n'
      + 'On such a host, install upstream node-pty yourself and it will be used instead:\n'
      + '  npm install node-pty --allow-scripts=node-pty\n'
      + 'That one does compile, so it needs python3, make and a C++ compiler.\n'
      + 'The container image (ghcr.io/dnviti/code-agents-webcli) avoids the problem entirely.',
    ), { cause: prebuiltError });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Spawn a pseudo-terminal.
 *
 * A thin forwarder rather than a re-exported binding: resolving lazily keeps the
 * "which platform are you on" error at the point somebody actually opens a
 * session, instead of turning an unsupported platform into an import-time crash
 * that takes the whole server down before it can say why.
 */
export const spawn: PtySpawn = (file, args, options) => loadPty().module.spawn(file, args, options);

/**
 * Which binding is in use.
 *
 * A diagnostic, not part of startup: `scripts/verify-install.sh` calls it to
 * prove an install really got the prebuilt binary rather than quietly falling
 * back to a compiled one. Deliberately not printed in the startup banner —
 * doing so would force the binding to load before anything needs it, turning an
 * unsupported platform into a crash at boot instead of a clear error the first
 * time somebody opens a session.
 */
export function ptySource(): PtySource {
  return loadPty().source;
}
