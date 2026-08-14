import fs from 'node:fs';
import path from 'node:path';
import { WrapOptions } from '../types.js';

function mergedEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      base[key] = value;
    }
  }
  return { ...base, ...(extra || {}) };
}

/**
 * Native Windows process creation cannot execute npm's `.cmd`/`.bat` shims
 * directly. Route only those script types through ComSpec; real executables
 * stay direct and container commands never pass through this host wrapper.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;
const CMD_UNREPRESENTABLE = /[\0\r\n]/u;

function assertRepresentableCmdValue(value: string): void {
  if (CMD_UNREPRESENTABLE.test(value)) {
    throw new Error('Windows batch commands cannot safely represent NUL or line-break characters');
  }
}

function escapeCmdCommand(value: string): string {
  assertRepresentableCmdValue(value);
  return value.replace(CMD_META, '^$1');
}

// Based on the qntm/cross-spawn algorithm: quote for CreateProcess first,
// then caret-escape cmd.exe metacharacters. The resulting command line is
// marked verbatim at every Windows spawn site, so neither Node nor cmd gets a
// chance to reinterpret a prompt/model/path as shell syntax.
function escapeCmdArgument(value: string, doubleEscapeMeta: boolean): string {
  assertRepresentableCmdValue(value);
  let escaped = value
    .replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/gu, '$1$1');
  escaped = `"${escaped}"`.replace(CMD_META, '^$1');
  return doubleEscapeMeta ? escaped.replace(CMD_META, '^$1') : escaped;
}

export interface HostCommandLaunch {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  envPatch?: Record<string, string>;
}

function npmShimLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): HostCommandLaunch | null {
  try {
    const source = fs.readFileSync(command, 'utf8');
    const matches = [...source.matchAll(/"%(?:~?dp0|dp0)%?\\([^"\r\n]+)"\s+%\*/giu)];
    const relativeEntry = matches[matches.length - 1]?.[1];
    if (!relativeEntry) return null;
    const entry = path.resolve(path.dirname(command), relativeEntry.replace(/\\/gu, path.sep));
    if (!fs.existsSync(entry)) return null;
    const shimDir = path.dirname(command);
    const siblingNode = path.join(shimDir, 'node.exe');
    const managedNode = path.resolve(shimDir, '..', '..', 'node-runtime');
    const managedNodeBinary = path.join(managedNode, 'node.exe');
    const existingPath = env.PATH || env.Path || '';
    const managedPi = fs.existsSync(managedNodeBinary)
      && path.basename(command).toLowerCase() === 'pi.cmd';
    return {
      command: fs.existsSync(siblingNode) ? siblingNode : 'node.exe',
      args: [entry, ...args],
      // Launching an npm bin's JS entry directly avoids every cmd.exe
      // quoting/injection trap. Managed Pi additionally needs its private
      // npm/npx tools exposed so `pi install` and `pi update` keep working.
      ...(managedPi ? {
        envPatch: {
          PATH: [shimDir, managedNode, existingPath].filter(Boolean).join(path.delimiter),
          npm_config_prefix: shimDir,
          PI_NPM_INSTALL_PREFIX: shimDir,
        },
      } : {}),
    };
  } catch {
    return null;
  }
}

export function wrapHostCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): HostCommandLaunch {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  const npmShim = npmShimLaunch(command, args, env);
  if (npmShim) return npmShim;
  const normalizedCommand = path.normalize(command);
  const doubleEscapeMeta = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(normalizedCommand);
  const shellCommand = [
    escapeCmdCommand(normalizedCommand),
    ...args.map((argument) => escapeCmdArgument(argument, doubleEscapeMeta)),
  ].join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    // /d disables AutoRun, /s applies cmd's quoting rules, and /v:off keeps
    // literal `!` intact. The outer quotes are cmd's required /s + /c pair.
    args: ['/d', '/s', '/v:off', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

/** Route native process launches out of a Flatpak sandbox and onto the host. */
export function wrapFlatpakHostCommand(
  command: string,
  args: string[],
  options: WrapOptions,
): HostCommandLaunch {
  const flatpakArgs = ['--host', '--watch-bus'];
  if (options.cwd) flatpakArgs.push(`--directory=${options.cwd}`);
  if (options.inheritHostEnv === false) flatpakArgs.push('--clear-env');
  for (const [name, value] of Object.entries(options.env || {})) {
    flatpakArgs.push(`--env=${name}=${value}`);
  }
  flatpakArgs.push(command, ...args);
  return { command: '/usr/bin/flatpak-spawn', args: flatpakArgs };
}

/** Environment needed by the trusted bridge itself, not by the host child. */
function flatpakSpawnEnvironment(childEnv: Record<string, string>): Record<string, string> {
  const bridgeEnv: Record<string, string> = { ...childEnv };
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'FLATPAK_ID']) {
    const value = process.env[name];
    if (typeof value === 'string') bridgeEnv[name] = value;
  }
  return bridgeEnv;
}

export { mergedEnv, flatpakSpawnEnvironment };
