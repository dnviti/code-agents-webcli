import fs from 'node:fs';
import path from 'node:path';
import { ContainerEngine, EnvironmentEngine } from '../engine.js';
import { KubernetesEngine } from '../kubernetes.js';
import { ContainerConfig } from '../types.js';

/**
 * The engine an administrator asked for.
 *
 * The only place in the feature that branches on which one it is: everything
 * downstream holds an `EnvironmentEngine` and cannot tell.
 */
export function createEngine(config: ContainerConfig): EnvironmentEngine {
  if (config.engine === 'kubernetes') {
    return new KubernetesEngine({
      context: config.kubernetes.context,
      namespace: config.kubernetes.namespace,
      storageClaim: config.kubernetes.storageClaim,
      serviceAccount: config.kubernetes.serviceAccount,
      rootDir: config.rootDir,
      kubeconfigPath: config.kubeconfigPath ?? null,
    });
  }
  return new ContainerEngine({ kind: config.engine, hostArgs: config.hostArgs });
}

/** The default root for per-user homes, matching where the rest of the data lives. */
export function defaultEnvironmentRoot(dataDir: string | null): string {
  const base = dataDir || path.join(process.env.HOME || '/tmp', '.code-agents-webcli');
  return path.join(base, 'environments');
}

export function ensureRoot(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
}
