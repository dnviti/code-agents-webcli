/**
 * Node-facing adapters for agent maintenance. Network and process effects stay
 * injectable so service tests never contact publishers or execute an agent.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import type { AgentMaintenanceCatalogEntry, AgentMaintenanceId, AgentMaintenanceOperation } from '../../../../shared/agent-maintenance.js';
import type { UserEnvironment } from '../../environments/types.js';
import type { AgentCheckRecord, AgentInstaller, AgentMaintenanceStore, AgentMaintenanceTarget, AgentProbe, AgentReleaseSource } from './agent-maintenance.js';
import { stripAnsi } from '../terminal/ansi.js';

const MODE = 0o700;
const FILE_MODE = 0o600;
const COMMAND_DIAGNOSTIC_LIMIT = 16 * 1024;

type Persisted = { operations: AgentMaintenanceOperation[]; checks: AgentCheckRecord[] };

function commandDiagnostic(value: string): string {
  const clean = stripAnsi(value).trim();
  return clean.length > COMMAND_DIAGNOSTIC_LIMIT
    ? `${clean.slice(0, COMMAND_DIAGNOSTIC_LIMIT)}\n[installer output truncated]`
    : clean;
}

/** Small, atomic, owner-only persistence implementation for operation restore. */
export class JsonFileAgentMaintenanceStore implements AgentMaintenanceStore {
  private data: Persisted;
  private readonly file: string;
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: MODE }); fs.chmodSync(dataDir, MODE);
    this.file = path.join(dataDir, 'agent-maintenance.json'); this.data = this.read();
    // A successful activation is reflected by the active pointer and status;
    // retaining its operation row would create the completed-operation history
    // explicitly outside this feature's scope.
    const retained = this.data.operations.filter((item) => item.phase !== 'complete');
    if (retained.length !== this.data.operations.length) {
      this.data.operations = retained;
      this.write();
    }
  }
  loadOperations(): AgentMaintenanceOperation[] { return this.data.operations.map((item) => ({ ...item })); }
  saveOperation(operation: AgentMaintenanceOperation): void {
    // Keep at most the current recoverable row per exact target/agent. Complete
    // rows are represented by the verified pointer, never a history ledger.
    this.data.operations = this.data.operations.filter((item) => (
      item.id === operation.id
      || item.targetKey !== operation.targetKey
      || item.agentId !== operation.agentId
    ));
    const index = this.data.operations.findIndex((item) => item.id === operation.id);
    if (operation.phase === 'complete') {
      if (index >= 0) this.data.operations.splice(index, 1);
    } else if (index < 0) this.data.operations.push({ ...operation });
    else this.data.operations[index] = { ...operation };
    this.write();
  }
  loadCheck(targetKey: string, agentId: AgentMaintenanceId): AgentCheckRecord | null { return this.data.checks.find((item) => item.targetKey === targetKey && item.agentId === agentId) ?? null; }
  saveCheck(record: AgentCheckRecord): void { const index = this.data.checks.findIndex((item) => item.targetKey === record.targetKey && item.agentId === record.agentId); if (index < 0) this.data.checks.push({ ...record }); else this.data.checks[index] = { ...record }; this.write(); }
  private read(): Persisted { try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>; return { operations: Array.isArray(raw.operations) ? raw.operations : [], checks: Array.isArray(raw.checks) ? raw.checks : [] }; } catch { return { operations: [], checks: [] }; } }
  private write(): void { const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(this.data), { mode: FILE_MODE }); fs.chmodSync(temporary, FILE_MODE); fs.renameSync(temporary, this.file); fs.chmodSync(this.file, FILE_MODE); }
}

export interface AgentCommandRunner { run(command: string, args: readonly string[], options: { env: Record<string, string>; cwd?: string; signal?: AbortSignal; timeoutMs?: number; inheritEnv?: boolean; windowsVerbatimArguments?: boolean }): Promise<{ stdout: string; stderr: string }>; }
export const childProcessRunner: AgentCommandRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = nodeExecFile(command, [...args], {
        env: options.inheritEnv === false ? options.env : { ...process.env, ...options.env },
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeoutMs,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      }, (error, stdout, stderr) => {
        if (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          failure.stdout = stdout;
          failure.stderr = stderr;
          // Node includes stderr but omits stdout from execFile's Error.message.
          // Several official installers put their actionable failure on stdout,
          // so retain a bounded, control-sequence-free copy for the operation UI.
          const diagnostic = commandDiagnostic(stdout);
          if (diagnostic && !failure.message.includes(diagnostic)) {
            failure.message = `${failure.message.trimEnd()}\nInstaller output:\n${diagnostic}`;
          }
          reject(failure);
          return;
        }
        resolve({ stdout, stderr });
      });
      // Maintenance probes and installers receive all input through argv. An
      // unused pipe looks interactive to some CLIs (Claude waits three seconds
      // for data on Windows), so close it immediately and deliver EOF.
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    });
  },
};

function identity(target: AgentMaintenanceTarget): string { return createHash('sha256').update(target.key).digest('hex'); }
function validVersion(value: string): boolean { return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u.test(value); }
function normalized(value: string): string | null { const match = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').match(/v?([0-9]+(?:\.[0-9A-Za-z.+-]+)+)/u); return match ? match[1] : null; }

const SAFE_PROCESS_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
] as const;

/** System plumbing only: never provider tokens, session data, or app credentials. */
export function safeProcessEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SAFE_PROCESS_ENV) {
    const value = process.env[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function failedCommandIsMissing(error: unknown): boolean {
  const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
  const output = [failure.message, failure.stdout, failure.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return failure.code === 'ENOENT'
    || failure.code === 127
    || /(?:command not found|not recognized|no such file)/iu.test(output);
}

function preferredWindowsWhereResult(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const candidate = line.trim().replace(/^"|"$/gu, '');
    if (!path.win32.isAbsolute(candidate)) continue;
    const extension = path.win32.extname(candidate).toLowerCase();
    if (['.exe', '.com', '.cmd', '.bat'].includes(extension)) return candidate;
  }
  return null;
}

export interface EnvironmentAgentRuntimeOptions { dataDir: string; environmentFor(target: AgentMaintenanceTarget): Promise<UserEnvironment>; runner?: AgentCommandRunner; }

/** Resolves active managed copies dynamically; no bridge needs a construction-time command path. */
export class EnvironmentAgentRuntime implements AgentProbe {
  private readonly runner: AgentCommandRunner;
  constructor(private readonly options: EnvironmentAgentRuntimeOptions) { this.runner = options.runner ?? childProcessRunner; }
  environmentFor(target: AgentMaintenanceTarget): Promise<UserEnvironment> { return this.options.environmentFor(target); }
  dataDirectory(): string { return this.options.dataDir; }
  managedRoot(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry): string | null { const pointer = path.join(this.options.dataDir, 'agent-maintenance', identity(target), agent.id, 'active.json'); try { const parsed = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { root?: unknown }; return typeof parsed.root === 'string' && path.isAbsolute(parsed.root) ? parsed.root : null; } catch { return null; } }
  resolveManagedCommand(
    target: AgentMaintenanceTarget,
    agent: AgentMaintenanceCatalogEntry,
    environment?: UserEnvironment,
  ): { command: string; version: string | null } | null {
    const root = this.managedRoot(target, agent);
    if (!root) return null;
    const command = managedCommandOnHost(root, agent, target.platform);
    if (!command) return null;
    const runtimeCommand = environment?.kind === 'container'
      ? environment.toContainerPath(command)
      : command;
    return { command: runtimeCommand, version: pointerVersion(this.options.dataDir, target, agent) };
  }
  async locate(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry): Promise<{ state: 'missing' | 'external' | 'managed'; version: string | null; managedVersion?: string | null }> {
    const root = this.managedRoot(target, agent);
    if (root) {
      try {
        const managedVersion = await this.version(target, agent, root);
        if (managedVersion) return { state: 'managed', version: managedVersion, managedVersion };
      } catch { /* status stays available; direct install verification still preserves this diagnostic */ }
      if (managedCommandOnHost(root, agent, target.platform)) {
        return { state: 'managed', version: null, managedVersion: null };
      }
    }
    const environment = await this.options.environmentFor(target);
    const probeEnv = environment.kind === 'host' ? safeProcessEnvironment() : {};
    const probe = async (command: string): Promise<{ state: 'external'; version: string | null }> => {
      const wrapped = environment.wrap(command, [...agent.versionArgs], {
        env: probeEnv,
        inheritHostEnv: false,
      });
      const result = await this.runner.run(wrapped.command, wrapped.args, {
        env: wrapped.env,
        timeoutMs: 3_000,
        inheritEnv: false,
        windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
      });
      return { state: 'external', version: normalized(result.stdout || result.stderr) };
    };
    try {
      return await probe(agent.binary);
    } catch (initialError) {
      // Node's native Windows process launcher resolves .exe files through
      // PATH, but not npm's .cmd shims. Retry only a genuine missing-command
      // result through the system `where.exe`, ignoring the extensionless
      // POSIX shim npm writes beside the runnable .cmd file.
      if (failedCommandIsMissing(initialError)
        && process.platform === 'win32'
        && target.platform === 'win32'
        && environment.kind === 'host') {
        try {
          const systemRoot = probeEnv.SystemRoot || probeEnv.SYSTEMROOT || probeEnv.WINDIR;
          const whereCommand = systemRoot
            ? path.win32.join(systemRoot, 'System32', 'where.exe')
            : 'where.exe';
          const wrappedWhere = environment.wrap(whereCommand, [agent.binary], {
            env: probeEnv,
            inheritHostEnv: false,
          });
          const found = await this.runner.run(wrappedWhere.command, wrappedWhere.args, {
            env: wrappedWhere.env,
            timeoutMs: 3_000,
            inheritEnv: false,
            windowsVerbatimArguments: wrappedWhere.windowsVerbatimArguments,
          });
          const candidate = preferredWindowsWhereResult(found.stdout);
          if (candidate) return await probe(candidate);
        } catch (resolvedError) {
          return failedCommandIsMissing(resolvedError)
            ? { state: 'missing', version: null }
            : { state: 'external', version: null };
        }
      }
      return failedCommandIsMissing(initialError)
        ? { state: 'missing', version: null }
        : { state: 'external', version: null };
    }
  }
  async version(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry, root: string): Promise<string | null> {
    const environment = await this.options.environmentFor(target);
    const hostCommand = managedCommandOnHost(root, agent, target.platform);
    if (!hostCommand) return null;
    const command = environment.kind === 'container'
      ? environment.toContainerPath(hostCommand)
      : hostCommand;
    const visibleRoot = environment.kind === 'container' ? environment.toContainerPath(root) : root;
    const separator = target.platform === 'win32' ? ';' : ':';
    const wrapped = environment.wrap(command, [...agent.versionArgs], { env: { ...(environment.kind === 'host' ? safeProcessEnvironment() : {}), HOME: path.join(visibleRoot, 'home'), ...(environment.kind === 'host' ? { PATH: `${path.join(visibleRoot, 'prefix', 'bin')}${separator}${process.env.PATH ?? ''}` } : {}) }, inheritHostEnv: false });
    const result = await this.runner.run(wrapped.command, wrapped.args, { env: wrapped.env, timeoutMs: 3_000, inheritEnv: false, windowsVerbatimArguments: wrapped.windowsVerbatimArguments });
    return normalized(result.stdout || result.stderr);
  }
}

function pointerVersion(
  dataDir: string,
  target: AgentMaintenanceTarget,
  agent: AgentMaintenanceCatalogEntry,
): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(
      path.join(dataDir, 'agent-maintenance', identity(target), agent.id, 'active.json'),
      'utf8',
    )) as { version?: unknown };
    return typeof value.version === 'string' && validVersion(value.version) ? value.version : null;
  } catch {
    return null;
  }
}

function managedCommandOnHost(
  root: string,
  agent: AgentMaintenanceCatalogEntry,
  platform: AgentMaintenanceTarget['platform'],
): string | null {
  const names = platform === 'win32'
    ? [`${agent.binary}.exe`, `${agent.binary}.cmd`, agent.binary]
    : [agent.binary];
  const directories = [
    path.join(root, 'prefix', 'bin'),
    ...(platform === 'win32' ? [path.join(root, 'prefix')] : []),
    path.join(root, 'home', '.local', 'bin'),
    path.join(root, 'home', '.grok', 'bin'),
    path.join(root, 'home', '.kimi-code', 'bin'),
  ];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface OfficialFetch { get(url: string, signal: AbortSignal): Promise<{ status: number; body: Buffer; headers?: Record<string, string | undefined> }>; }
export const officialFetch: OfficialFetch = {
  async get(url, signal) {
    const response = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
    });
    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      headers: Object.fromEntries(response.headers.entries()),
    };
  },
};

function officialReleaseUrl(
  target: AgentMaintenanceTarget,
  agent: AgentMaintenanceCatalogEntry,
): string | null {
  switch (agent.id) {
    case 'claude': return 'https://downloads.claude.ai/claude-code-releases/stable';
    case 'codex': return 'https://releases.openai.com/codex/channels/latest';
    case 'pi': return 'https://pi.dev/api/latest-version';
    case 'grok': return 'https://x.ai/cli/stable';
    case 'qwen': return 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/latest/VERSION';
    case 'kimi': return 'https://code.kimi.com/kimi-code/latest';
    case 'omp': return 'https://api.github.com/repos/can1357/oh-my-pi/releases/latest';
    case 'antigravity': {
      const os = target.platform === 'darwin'
        ? 'darwin'
        : target.platform === 'linux'
          ? 'linux'
          : target.platform === 'win32' ? 'windows' : null;
      if (!os) return null;
      const arch = target.architecture === 'arm64' ? 'arm64' : 'amd64';
      return `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${os}_${arch}.json`;
    }
    default: return null;
  }
}

/** Parses only known official responses. Any changed/undocumented shape is unavailable, never guessed. */
export class OfficialAgentReleaseSource implements AgentReleaseSource {
  constructor(private readonly fetcher: OfficialFetch) {}
  async latest(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry, signal: AbortSignal): Promise<{ version: string; prerelease?: boolean } | null> {
    const url = officialReleaseUrl(target, agent);
    if (signal.aborted || !url) return null;
    const response = await Promise.race([
      this.fetcher.get(url, signal),
      new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })),
    ]);
    if (!response || response.status < 200 || response.status >= 300) return null;
    const body = response.body.toString('utf8');
    let raw: string | null = null;
    let prerelease = agent.channel === 'preview';
    try {
      const parsed = JSON.parse(body) as {
        tag_name?: unknown;
        version?: unknown;
        prerelease?: unknown;
      };
      raw = typeof parsed.tag_name === 'string'
        ? parsed.tag_name
        : typeof parsed.version === 'string' ? parsed.version : null;
      if (typeof parsed.prerelease === 'boolean') prerelease = parsed.prerelease;
    } catch {
      raw = body.trim().split(/\s/u)[0] || null;
    }
    const version = raw?.match(/[0-9]+(?:\.[0-9A-Za-z.+-]+)+/u)?.[0] ?? null;
    return version && validVersion(version) ? { version, prerelease } : null;
  }
}

const POSIX_INSTALL_SCRIPTS: Partial<Record<AgentMaintenanceId, string>> = {
  claude: 'https://claude.ai/install.sh',
  codex: 'https://chatgpt.com/codex/install.sh',
  pi: 'https://pi.dev/install.sh',
  grok: 'https://x.ai/cli/install.sh',
  qwen: 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh',
  kimi: 'https://code.kimi.com/kimi-code/install.sh',
  omp: 'https://omp.sh/install',
  antigravity: 'https://antigravity.google/cli/install.sh',
};
const WINDOWS_INSTALL_SCRIPTS: Partial<Record<AgentMaintenanceId, string>> = {
  claude: 'https://claude.ai/install.ps1',
  codex: 'https://chatgpt.com/codex/install.ps1',
  grok: 'https://x.ai/cli/install.ps1',
  kimi: 'https://code.kimi.com/kimi-code/install.ps1',
  omp: 'https://omp.sh/install.ps1',
  antigravity: 'https://antigravity.google/cli/install.ps1',
};
export interface OfficialInstallerOptions { runtime: EnvironmentAgentRuntime; fetcher: OfficialFetch; runner?: AgentCommandRunner; }

interface DownloadedNodePrerequisite {
  archive: Buffer;
  filename: string;
}

const WINDOWS_USER_PATH_INSTALLERS = new Set<AgentMaintenanceId>(['codex', 'grok', 'omp']);

function managedAgentPathScope(root: string, agentId: AgentMaintenanceId): string | null {
  const attempts = path.dirname(root);
  const versionRoot = path.dirname(attempts);
  const parent = path.dirname(versionRoot);
  if (path.basename(attempts).toLowerCase() !== 'attempts' || !validVersion(path.basename(versionRoot))) return null;
  if (path.basename(parent).toLowerCase() === agentId) return parent;
  return path.basename(parent).toLowerCase() === 'versions'
    && path.basename(path.dirname(parent)).toLowerCase() === agentId
    ? path.dirname(parent)
    : null;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function trustedManagedAgentPathScope(
  root: string,
  runtime: EnvironmentAgentRuntime,
  target: AgentMaintenanceTarget,
  agent: AgentMaintenanceCatalogEntry,
  environment: UserEnvironment,
): string | null {
  const candidate = managedAgentPathScope(root, agent.id);
  if (!candidate) return null;
  const digest = identity(target);
  const storageBase = target.scope === 'private'
    ? path.join(environment.homeDir, '.code-agents', 'agent-maintenance')
    : path.join(runtime.dataDirectory(), 'agent-maintenance');
  const expected = [digest, digest.slice(0, 24)]
    .map((segment) => path.join(storageBase, segment, agent.id));
  return expected.some((scope) => {
    const left = path.resolve(scope);
    const right = path.resolve(candidate);
    return target.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }) ? candidate : null;
}

/** Downloads an official script to owner-only staging, then executes it by argv (never a pipe or shell string). */
export class OfficialScriptAgentInstaller implements AgentInstaller {
  private readonly runner: AgentCommandRunner;
  constructor(private readonly options: OfficialInstallerOptions) { this.runner = options.runner ?? childProcessRunner; }
  async install(input: Parameters<AgentInstaller['install']>[0]): Promise<void> {
    if (!validVersion(input.version)) throw new Error('Unsafe official version.');
    const windows = input.target.platform === 'win32';
    const previousManagedRoot = windows && WINDOWS_USER_PATH_INSTALLERS.has(input.agent.id)
      ? this.options.runtime.managedRoot(input.target, input.agent)
      : null;
    // Pi's publisher documents npm, not its POSIX shell installer, on Windows.
    // Qwen's official npm fallback supports both Windows architectures and,
    // unlike its batch shim, is safe when an app-owned root contains cmd.exe
    // metacharacters. Keep a verified app-owned Node runtime for both.
    const nativePiWindows = windows && input.agent.id === 'pi';
    const nativeQwenWindows = windows && input.agent.id === 'qwen';
    const nativeNpmWindows = nativePiWindows || nativeQwenWindows;
    const source = nativeNpmWindows
      ? null
      : (windows ? WINDOWS_INSTALL_SCRIPTS : POSIX_INSTALL_SCRIPTS)[input.agent.id];
    if (!source && !nativeNpmWindows) {
      throw new Error(input.agent.prerequisiteGuidance || 'No documented official installer for this platform.');
    }
    const fetched = source ? await this.options.fetcher.get(source, input.signal) : null;
    if (fetched && (fetched.status < 200 || fetched.status >= 300 || !fetched.body.length)) {
      throw new Error('Official installer download failed.');
    }
    const needsManagedNode = input.agent.id === 'pi' || nativeQwenWindows;
    const nodePrerequisite = needsManagedNode
      ? await this.downloadNodePrerequisite(input.target, input.signal, input.agent.id)
      : null;
    if (input.signal.aborted) throw new Error('Installation cancelled.');
    input.onInstalling?.();
    fs.mkdirSync(input.stagingRoot, { recursive: true, mode: MODE }); fs.chmodSync(input.stagingRoot, MODE); fs.mkdirSync(path.join(input.stagingRoot, 'home'), { recursive: true, mode: MODE }); fs.mkdirSync(path.join(input.stagingRoot, 'prefix'), { recursive: true, mode: MODE });
    if (windows) {
      fs.mkdirSync(path.join(input.stagingRoot, 'home', 'AppData', 'Local'), { recursive: true, mode: MODE });
      fs.mkdirSync(path.join(input.stagingRoot, 'home', 'AppData', 'Roaming'), { recursive: true, mode: MODE });
    }
    const script = fetched
      ? path.join(input.stagingRoot, windows ? 'official-install.ps1' : 'official-install.sh')
      : null;
    if (script && fetched) {
      const scriptMode = windows ? FILE_MODE : MODE;
      fs.writeFileSync(script, fetched.body, { mode: scriptMode });
      fs.chmodSync(script, scriptMode);
    }
    const environment = await this.options.runtime.environmentFor(input.target);
    const visibleRoot = environment.kind === 'container'
      ? environment.toContainerPath(input.stagingRoot)
      : input.stagingRoot;
    const visibleScript = script && environment.kind === 'container'
      ? environment.toContainerPath(script)
      : script;
    const prefix = path.join(visibleRoot, 'prefix');
    const home = path.join(visibleRoot, 'home');
    const managedNodeBin = nodePrerequisite
      ? await this.installManagedNode(input, environment, visibleRoot, nodePrerequisite)
      : null;
    const inheritedPath = environment.kind === 'host'
      ? safeProcessEnvironment().PATH || safeProcessEnvironment().Path || ''
      : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const separator = windows ? ';' : ':';
    const windowsNpmPrefix = nativeNpmWindows
      ? path.join(prefix, 'bin')
      : prefix;
    const env: Record<string, string> = {
      ...(environment.kind === 'host' ? safeProcessEnvironment() : {}),
      ...input.environment,
      HOME: home,
      USERPROFILE: home,
      npm_config_prefix: windowsNpmPrefix,
      CODEX_RELEASE: input.version,
      CODEX_INSTALL_DIR: path.join(prefix, 'bin'),
      CODEX_HOME: path.join(home, '.codex'),
      CODEX_NON_INTERACTIVE: '1',
      GROK_VERSION: input.version,
      GROK_CHANNEL: 'stable',
      GROK_BIN_DIR: path.join(prefix, 'bin'),
      PI_NPM_INSTALL_PREFIX: windowsNpmPrefix,
      QWEN_INSTALL_VERSION: input.version,
      QWEN_INSTALL_ROOT: prefix,
      QWEN_NO_MODIFY_PATH: '1',
      QWEN_INSTALL_METHOD: windows ? 'npm' : 'standalone',
      KIMI_VERSION: input.version,
      KIMI_INSTALL_DIR: prefix,
      KIMI_NO_MODIFY_PATH: '1',
      PI_INSTALL_DIR: path.join(prefix, 'bin'),
      ...(managedNodeBin ? { PATH: `${managedNodeBin}${separator}${inheritedPath}` } : {}),
      ...(windows ? {
        OS: 'Windows_NT',
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        PROCESSOR_ARCHITECTURE: input.target.architecture === 'arm64' ? 'ARM64' : 'AMD64',
      } : {}),
    };
    if (windows) delete env.PROCESSOR_ARCHITEW6432;
    const scriptArgs = installerArguments(input.agent.id, input.version, prefix, windows);
    // On POSIX, execute the downloaded file directly so its publisher-owned
    // shebang selects the required interpreter. Several supported installers
    // require Bash and reject `/bin/sh` (notably on distributions where it is
    // dash); forcing one shell here silently breaks their documented path.
    if (nativeNpmWindows && !managedNodeBin) throw new Error(`${nativePiWindows ? 'Pi' : 'Qwen Code'} requires its managed Node.js runtime.`);
    const managedPackage = nativePiWindows
      ? `@earendil-works/pi-coding-agent@${input.version}`
      : `@qwen-code/qwen-code@${input.version}`;
    const wrapped = nativeNpmWindows
      ? environment.wrap(path.join(managedNodeBin!, 'node.exe'), [
        path.join(managedNodeBin!, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        'install', '--global', ...(nativePiWindows ? ['--ignore-scripts'] : []), '--omit=dev', '--include=optional',
        '--no-fund', '--no-audit', '--progress=false', '--prefix', path.join(prefix, 'bin'),
        managedPackage,
      ], { env, inheritHostEnv: false })
      : environment.wrap(windows ? 'powershell.exe' : visibleScript!, windows
        ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', visibleScript!, ...scriptArgs]
        : scriptArgs, { env, inheritHostEnv: false });
    let installationError: unknown = null;
    try {
      await this.runner.run(wrapped.command, wrapped.args, { env: wrapped.env, signal: input.signal, inheritEnv: false });
      if (nativePiWindows) this.wrapManagedPiWindowsLauncher(input.stagingRoot);
    } catch (error) {
      installationError = error;
      const guidance = input.agent.platformSupport.find((support) => (
        support.platform === input.target.platform
        && support.architectures.includes(input.target.architecture)
      ))?.guidance;
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      const failureOutput = [
        error instanceof Error ? error.message : String(error),
        failure.stdout,
        failure.stderr,
      ].filter((value): value is string => typeof value === 'string').join('\n');
      // Runtime-only guidance (for example Git Bash for Pi/Kimi) must never
      // replace a publisher install error. OMP is the sole catalogued install
      // prerequisite whose failure is diagnosed by its installer.
      const prerequisiteFailure = input.agent.id === 'omp'
        && input.target.platform === 'linux'
        && /(?:libstdc\+\+|libgcc)/iu.test(failureOutput);
      if (guidance && prerequisiteFailure) {
        const guided = new Error(guidance) as Error & { cause?: unknown };
        guided.cause = error;
        throw guided;
      }
      throw error;
    } finally {
      if (windows && WINDOWS_USER_PATH_INSTALLERS.has(input.agent.id)) {
        try {
          const scopes = [
            trustedManagedAgentPathScope(visibleRoot, this.options.runtime, input.target, input.agent, environment),
            previousManagedRoot
              ? trustedManagedAgentPathScope(previousManagedRoot, this.options.runtime, input.target, input.agent, environment)
              : null,
          ].filter((value): value is string => Boolean(value));
          await this.removeManagedWindowsUserPath(input, environment, scopes);
        } catch (cleanupError) {
          const cleanupDiagnostic = `The temporary Windows user PATH entry could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. The managed files were retained so PATH does not point at deleted files.`;
          if (installationError instanceof Error) {
            installationError.message = `${installationError.message.trimEnd()}\n${cleanupDiagnostic}`;
            (installationError as Error & { preserveStaging?: boolean }).preserveStaging = true;
          } else {
            const failure = new Error(
              installationError === null
                ? cleanupDiagnostic
                : `${String(installationError)}\n${cleanupDiagnostic}`,
            ) as Error & { cause?: unknown; preserveStaging?: boolean };
            failure.cause = cleanupError;
            failure.preserveStaging = true;
            throw failure;
          }
        }
      }
    }
  }
  private async downloadNodePrerequisite(
    target: AgentMaintenanceTarget,
    signal: AbortSignal,
    agentId: AgentMaintenanceId,
  ): Promise<DownloadedNodePrerequisite> {
    const requirement = agentId === 'pi'
      ? 'Pi requires Node.js 22.19 or newer'
      : 'Qwen Code on Windows requires Node.js 22 or newer';
    const checksums = await this.options.fetcher.get(
      'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt',
      signal,
    );
    if (checksums.status < 200 || checksums.status >= 300) {
      throw new Error(`${requirement}; the official Node.js checksums could not be downloaded.`);
    }
    const os = target.platform === 'win32' ? 'win'
      : target.platform === 'darwin' ? 'darwin'
        : target.platform === 'linux' ? 'linux' : null;
    const arch = target.architecture === 'arm64' ? 'arm64'
      : target.architecture === 'x64' ? 'x64' : null;
    if (!os || !arch) throw new Error(`${requirement} for this operating system and architecture.`);
    const suffix = os === 'win' ? `-${os}-${arch}.zip` : `-${os}-${arch}.tar.gz`;
    const selected = checksums.body.toString('utf8').split(/\r?\n/u).map((line) => {
      const match = line.match(/^([0-9a-f]{64})\s+\*?([^\s]+)$/iu);
      return match ? { digest: match[1].toLowerCase(), filename: match[2] } : null;
    }).find((item) => item?.filename.endsWith(suffix));
    if (!selected || !/^node-v22\.[0-9.]+-(?:darwin|linux|win)-(?:x64|arm64)\.(?:tar\.gz|zip)$/u.test(selected.filename)) {
      throw new Error(`${requirement}; no official user-scoped Node.js archive matches this target.`);
    }
    const archive = await this.options.fetcher.get(
      `https://nodejs.org/dist/latest-v22.x/${selected.filename}`,
      signal,
    );
    if (archive.status < 200 || archive.status >= 300 || !archive.body.length) {
      throw new Error(`${requirement}; its official user-scoped archive could not be downloaded.`);
    }
    const digest = createHash('sha256').update(archive.body).digest('hex');
    if (digest !== selected.digest) throw new Error('The official Node.js prerequisite failed SHA-256 verification.');
    return { archive: archive.body, filename: selected.filename };
  }
  private async installManagedNode(
    input: Parameters<AgentInstaller['install']>[0],
    environment: UserEnvironment,
    visibleRoot: string,
    prerequisite: DownloadedNodePrerequisite,
  ): Promise<string> {
    const archive = path.join(input.stagingRoot, prerequisite.filename);
    const nodeRoot = path.join(input.stagingRoot, 'node-runtime');
    fs.writeFileSync(archive, prerequisite.archive, { mode: FILE_MODE });
    fs.chmodSync(archive, FILE_MODE);
    fs.mkdirSync(nodeRoot, { recursive: true, mode: MODE });
    const visibleArchive = environment.kind === 'container' ? environment.toContainerPath(archive) : archive;
    const visibleNodeRoot = environment.kind === 'container' ? environment.toContainerPath(nodeRoot) : nodeRoot;
    if (input.target.platform === 'win32') {
      const extractor = path.join(input.stagingRoot, 'extract-node.ps1');
      fs.writeFileSync(extractor, [
        "$ErrorActionPreference = 'Stop'",
        'Expand-Archive -LiteralPath $env:CAWC_NODE_ARCHIVE -DestinationPath $env:CAWC_NODE_UNPACK -Force',
        '$root = Get-ChildItem -LiteralPath $env:CAWC_NODE_UNPACK -Directory | Select-Object -First 1',
        'if ($null -eq $root) { throw "The official Node.js archive has no root directory." }',
        'Get-ChildItem -LiteralPath $root.FullName -Force | Move-Item -Destination $env:CAWC_NODE_DEST -Force',
      ].join('\r\n'), { mode: FILE_MODE });
      const unpack = path.join(input.stagingRoot, 'node-unpack');
      fs.mkdirSync(unpack, { recursive: true, mode: MODE });
      const wrapped = environment.wrap('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        environment.kind === 'container' ? environment.toContainerPath(extractor) : extractor,
      ], {
        env: {
          ...(environment.kind === 'host' ? safeProcessEnvironment() : {}),
          CAWC_NODE_ARCHIVE: visibleArchive,
          CAWC_NODE_UNPACK: environment.kind === 'container' ? environment.toContainerPath(unpack) : unpack,
          CAWC_NODE_DEST: visibleNodeRoot,
        },
        inheritHostEnv: false,
      });
      await this.runner.run(wrapped.command, wrapped.args, { env: wrapped.env, signal: input.signal, inheritEnv: false });
    } else {
      const wrapped = environment.wrap('tar', ['-xzf', visibleArchive, '-C', visibleNodeRoot, '--strip-components=1'], {
        env: environment.kind === 'host' ? safeProcessEnvironment() : {},
        inheritHostEnv: false,
      });
      await this.runner.run(wrapped.command, wrapped.args, { env: wrapped.env, signal: input.signal, inheritEnv: false });
    }
    const nodeBinary = input.target.platform === 'win32'
      ? path.join(nodeRoot, 'node.exe')
      : path.join(nodeRoot, 'bin', 'node');
    if (!fs.existsSync(nodeBinary)) throw new Error('The official Node.js prerequisite did not contain its expected executable.');
    if (input.target.platform === 'win32'
      && ['npm-cli.js', 'npx-cli.js'].some((file) => !fs.existsSync(path.join(nodeRoot, 'node_modules', 'npm', 'bin', file)))) {
      throw new Error('The official Node.js prerequisite did not contain npm and npx.');
    }
    const prefixBin = path.join(input.stagingRoot, 'prefix', 'bin');
    fs.mkdirSync(prefixBin, { recursive: true, mode: MODE });
    const siblingNode = path.join(prefixBin, input.target.platform === 'win32' ? 'node.exe' : 'node');
    try { fs.linkSync(nodeBinary, siblingNode); } catch { fs.copyFileSync(nodeBinary, siblingNode); }
    fs.chmodSync(siblingNode, MODE);
    return input.target.platform === 'win32' ? visibleNodeRoot : path.join(visibleNodeRoot, 'bin');
  }
  private async removeManagedWindowsUserPath(
    input: Parameters<AgentInstaller['install']>[0],
    environment: UserEnvironment,
    managedRoots: string[],
  ): Promise<void> {
    const cleanup = path.join(input.stagingRoot, 'cleanup-user-path.ps1');
    fs.writeFileSync(cleanup, [
      "$ErrorActionPreference = 'Stop'",
      "$managedRoots = @((ConvertFrom-Json $env:CAWC_MANAGED_ROOTS) | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd([char[]]'\\/') })",
      'for ($attempt = 0; $attempt -lt 5; $attempt++) {',
      "  $current = [Environment]::GetEnvironmentVariable('Path', 'User')",
      '  if ($null -eq $current) { exit 0 }',
      "  $entries = $current.Split([char]';')",
      "  $kept = New-Object 'System.Collections.Generic.List[string]'",
      '  foreach ($entry in $entries) {',
      '    $inside = $false',
      '    try {',
      '      $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim([char]34))',
      '      if ([IO.Path]::IsPathRooted($expanded)) {',
      "        $candidate = [IO.Path]::GetFullPath($expanded).TrimEnd([char[]]'\\/')",
      '        foreach ($managedRoot in $managedRoots) {',
      '          if ($candidate.Equals($managedRoot, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($managedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break }',
      '        }',
      '      }',
      '    } catch { $inside = $false }',
      '    if (-not $inside) { $null = $kept.Add($entry) }',
      '  }',
      '  if ($kept.Count -eq $entries.Length) { exit 0 }',
      "  $next = [string]::Join(';', $kept)",
      '  if ([string]::IsNullOrWhiteSpace($next)) { $next = $null }',
      "  if ([Environment]::GetEnvironmentVariable('Path', 'User') -ne $current) { continue }",
      "  [Environment]::SetEnvironmentVariable('Path', $next, 'User')",
      '  exit 0',
      '}',
      "throw 'The Windows user PATH changed repeatedly during managed cleanup.'",
    ].join('\r\n'), { mode: FILE_MODE });
    fs.chmodSync(cleanup, FILE_MODE);
    const visibleCleanup = environment.kind === 'container'
      ? environment.toContainerPath(cleanup)
      : cleanup;
    const wrapped = environment.wrap('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', visibleCleanup,
    ], {
      env: {
        ...(environment.kind === 'host' ? safeProcessEnvironment() : {}),
        CAWC_MANAGED_ROOTS: JSON.stringify(managedRoots),
      },
      inheritHostEnv: false,
    });
    await this.runner.run(wrapped.command, wrapped.args, {
      env: wrapped.env,
      // Cleanup must still run after the installation signal was cancelled;
      // otherwise the service deletes the attempt while HKCU PATH still points
      // at it. Bound the independent cleanup instead of reusing that signal.
      timeoutMs: 10_000,
      inheritEnv: false,
    });
  }
  private wrapManagedPiWindowsLauncher(stagingRoot: string): void {
    const bin = path.join(stagingRoot, 'prefix', 'bin');
    const generated = path.join(bin, 'pi.cmd');
    if (!fs.existsSync(generated)) {
      throw new Error('The official Pi package did not create its expected Windows launcher.');
    }
    const packageLauncher = fs.readFileSync(generated, 'utf8');
    fs.writeFileSync(generated, [
      // npm and npx stay in the verified Node distribution. Pi inherits this
      // PATH, so extension/package commands work even when the host has no Node.
      '@SET "PATH=%~dp0..\\..\\node-runtime;%~dp0;%PATH%"',
      '@SET "npm_config_prefix=%~dp0"',
      '@SET "PI_NPM_INSTALL_PREFIX=%~dp0"',
      packageLauncher,
    ].join('\r\n'), { mode: FILE_MODE });
    fs.chmodSync(generated, FILE_MODE);
    for (const tool of ['npm', 'npx']) {
      const wrapper = path.join(bin, `${tool}.cmd`);
      fs.writeFileSync(wrapper, [
        '@ECHO off',
        'SETLOCAL',
        `"%~dp0..\\..\\node-runtime\\node.exe" "%~dp0..\\..\\node-runtime\\node_modules\\npm\\bin\\${tool}-cli.js" %*`,
        'EXIT /b %ERRORLEVEL%',
      ].join('\r\n'), { mode: FILE_MODE });
      fs.chmodSync(wrapper, FILE_MODE);
    }
  }
  async activate(input: Parameters<AgentInstaller['activate']>[0]): Promise<void> {
    const previousRoot = this.options.runtime.managedRoot(input.target, input.agent);
    const base = path.join(this.options.runtime.dataDirectory(), 'agent-maintenance', identity(input.target), input.agent.id);
    fs.mkdirSync(base, { recursive: true, mode: MODE }); fs.chmodSync(base, MODE);
    const temporary = path.join(base, `active.${process.pid}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({ root: input.stagingRoot, version: input.version }), { mode: FILE_MODE });
    fs.chmodSync(temporary, FILE_MODE);
    fs.renameSync(temporary, path.join(base, 'active.json'));
    fs.chmodSync(path.join(base, 'active.json'), FILE_MODE);

    // Activation is the commit point. Rollback/version history is a non-goal,
    // so only the newly active attempt remains after its pointer is durable.
    const attempts = path.dirname(input.stagingRoot);
    const activeVersion = path.dirname(attempts);
    const versions = path.dirname(activeVersion);
    try {
      for (const version of fs.readdirSync(versions, { withFileTypes: true })) {
        const versionPath = path.join(versions, version.name);
        if (versionPath !== activeVersion) {
          fs.rmSync(versionPath, { recursive: true, force: true });
          continue;
        }
        for (const attempt of fs.readdirSync(attempts, { withFileTypes: true })) {
          const attemptPath = path.join(attempts, attempt.name);
          if (attemptPath !== input.stagingRoot) fs.rmSync(attemptPath, { recursive: true, force: true });
        }
      }
    } catch { /* cleanup must not invalidate the already durable activation */ }

    // The compact Windows-safe layout replaced the original full-hash
    // `<agent>/versions/<version>` tree. Remove the previously active version
    // after the new pointer is durable, but only when its shape and containment
    // both prove that it is an app-owned managed version.
    if (previousRoot && previousRoot !== input.stagingRoot) {
      try {
        const previousVersion = path.dirname(path.dirname(previousRoot));
        if (previousVersion !== activeVersion) {
          const environment = await this.options.runtime.environmentFor(input.target);
          const trustedScope = trustedManagedAgentPathScope(
            previousRoot,
            this.options.runtime,
            input.target,
            input.agent,
            environment,
          );
          if (trustedScope && pathIsWithin(trustedScope, previousVersion)) {
            fs.rmSync(previousVersion, { recursive: true, force: true });
          }
        }
      } catch { /* legacy cleanup must not invalidate the active pointer */ }
    }
  }
  async discard(input: Parameters<NonNullable<AgentInstaller['discard']>>[0]): Promise<void> {
    fs.rmSync(input.stagingRoot, { recursive: true, force: true });
  }
}

function installerArguments(
  id: AgentMaintenanceId,
  version: string,
  prefix: string,
  windows: boolean,
): string[] {
  switch (id) {
    case 'claude': return [version];
    case 'codex': return windows ? ['-Release', version] : ['--release', version];
    case 'grok': return windows ? ['-Version', version] : [version];
    case 'kimi': return windows ? [] : ['--version', version];
    case 'omp': return windows ? ['-Binary', '-Ref', `v${version}`] : ['--binary', '--ref', `v${version}`];
    case 'antigravity': return windows
      ? ['--dir', path.join(prefix, 'bin'), '--skip-aliases', '--skip-path']
      : ['--dir', path.join(prefix, 'bin')];
    default: return [];
  }
}
