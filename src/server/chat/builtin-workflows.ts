import * as fs from 'fs';
import * as path from 'path';
import { BuiltInWorkflowId } from '../../shared/chat-events.js';

/**
 * Read app-owned workflow instructions from the installed server bundle.
 *
 * `__dirname` is `dist/server/chat` in a packaged application, so this does
 * not depend on the guest's working directory or skill discovery. The source
 * candidate is only for direct source/test execution before the asset-copy
 * build step has produced dist.
 */
const installedRoot = path.join(__dirname, 'builtin-workflows');
const sourceRoot = path.resolve(__dirname, '../../../src/server/chat/builtin-workflows');
const runningInstalledBundle = path.basename(path.resolve(__dirname, '../..')) === 'dist';
const cache = new Map<BuiltInWorkflowId, string>();

export function builtInWorkflowInstructions(workflow: BuiltInWorkflowId): string {
  const remembered = cache.get(workflow);
  if (remembered !== undefined) return remembered;

  const relative = path.join(workflow, 'SKILL.md');
  const installed = path.join(installedRoot, relative);
  const source = path.join(sourceRoot, relative);
  // Once TypeScript has put us under dist, that is the installed application
  // and a missing copied asset must be reported, not papered over by a nearby
  // checkout. The source fallback is for direct TypeScript/temporary-bundle
  // test runners whose module directory is neither source nor dist.
  const filename = fs.existsSync(installed) || runningInstalledBundle ? installed : source;

  try {
    const instructions = fs.readFileSync(filename, 'utf8').trim();
    if (!instructions) throw new Error('the file is empty');
    cache.set(workflow, instructions);
    return instructions;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The bundled ${workflow} workflow is unavailable: ${detail}`);
  }
}
