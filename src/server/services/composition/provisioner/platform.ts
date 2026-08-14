export interface CommandRunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Sensitive input is permitted here and nowhere in command metadata. */
  input?: string;
  signal?: AbortSignal;
}

export interface ContainerCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<{ stdout: string; stderr: string }>;
}

export type TargetArchitecture = 'x64' | 'arm64';
export type TargetLibc = 'glibc' | 'musl';

export interface TargetPlatform {
  os: 'linux';
  arch: TargetArchitecture;
  libc: TargetLibc;
  /** Safe as one durable directory name. */
  namespace: string;
}

export class TargetCompatibilityError extends Error {
  readonly code = 'TARGET_INCOMPATIBLE';
}

const TARGET_PROBE = [
  'set -eu',
  'test -r /proc/self/status',
  'command -v uname >/dev/null',
  'command -v bash >/dev/null',
  'command -v git >/dev/null',
  'command -v setsid >/dev/null',
  'certificates=',
  'for candidate in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do',
  '  if test -r "$candidate"; then certificates=$candidate; break; fi',
  'done',
  'test -n "$certificates"',
  'os=$(uname -s)',
  'arch=$(uname -m)',
  'libc=glibc',
  'if command -v ldd >/dev/null 2>&1; then',
  '  case "$(ldd --version 2>&1 || true)" in *musl*) libc=musl;; esac',
  'fi',
  'printf "%s\\n%s\\n%s\\n" "$os" "$arch" "$libc"',
].join('\n');

/** Probe only fixed commands; repository files and configuration are absent. */
export async function probeTargetPlatform(runner: ContainerCommandRunner): Promise<TargetPlatform> {
  let stdout: string;
  try {
    ({ stdout } = await runner.run('sh', ['-c', TARGET_PROBE]));
  } catch {
    throw new TargetCompatibilityError(
      'Base image requires Linux sh, Bash, CA certificates, Git, readable /proc, and setsid',
    );
  }
  const [rawOs, rawArch, rawLibc, ...extra] = stdout.trim().split(/\r?\n/);
  if (extra.length || rawOs !== 'Linux') {
    throw new TargetCompatibilityError('Provisioning requires a Linux target');
  }
  const arch = rawArch === 'x86_64' || rawArch === 'amd64'
    ? 'x64'
    : rawArch === 'aarch64' || rawArch === 'arm64'
      ? 'arm64'
      : null;
  const libc = rawLibc === 'glibc' || rawLibc === 'musl' ? rawLibc : null;
  if (!arch || !libc) {
    throw new TargetCompatibilityError('Target architecture or libc is unsupported');
  }
  return { os: 'linux', arch, libc, namespace: `linux-${arch}-${libc}` };
}
