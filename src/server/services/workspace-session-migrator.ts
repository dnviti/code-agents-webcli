/**
 * Facade for per-session migration of legacy file artifacts.
 *
 * The implementation was split into cohesive sibling modules; this module
 * preserves the original public surface so existing importers keep working
 * unchanged.
 */
export type {
  LegacySessionArtifact,
  LegacyArtifactState,
  LegacyArtifactBlockReason,
  LegacyArtifactMigrationEntry,
  LegacySessionArtifactMigrationResult,
  LegacySessionMigrationRef,
  WorkspaceSessionArtifactMigratorOptions,
  WorkspaceSessionArtifactMigratorHooks,
} from './migrator-core.js';
export { MAX_MIGRATION_MARKER_ARTIFACTS } from './migrator-core.js';
export { WorkspaceSessionArtifactMigrator, default } from './migrator-class.js';
