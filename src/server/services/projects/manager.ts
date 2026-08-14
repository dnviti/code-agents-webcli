import { ProjectManagerComposition } from './manager/manager-composition.js';

/**
 * ProjectManager entry point.
 *
 * Originally a single 3,480-line file; this is now a thin facade over the
 * cohesive composition modules in this directory (manager-core, -storage,
 * -credential, -composition-core, -build, -leases, -lifecycle, -composition,
 * plus leaf modules manager-types and manager-helpers). The public surface is
 * unchanged — the `ProjectManager` class and the same set of exported types.
 */
export class ProjectManager extends ProjectManagerComposition {}

export * from './manager/manager-types.js';
export type {
  ProjectSessionFileCommand,
  ProjectSessionProcessRecovery,
} from './working-dir.js';
