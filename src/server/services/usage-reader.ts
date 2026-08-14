/**
 * Facade for the usage-reader split.
 *
 * Re-exports the concrete `UsageReader` class and every type/interface from
 * the sibling modules so all callers of this path keep working unchanged:
 *
 *   - `./usage-reader/usage-reader.ts` — the concrete `UsageReader` class;
 *   - `./usage-reader/types.ts` — the shared interfaces.
 */
export { UsageReader } from './usage-reader/usage-reader.js';
export * from './usage-reader/types.js';
export { UsageReader as default } from './usage-reader/usage-reader.js';
