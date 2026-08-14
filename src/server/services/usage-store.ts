/**
 * Facade for the durable side of usage accounting.
 *
 * Re-exports the `UsageStore` class, its query interfaces and the
 * range/window helpers from their sibling modules so every caller of this path
 * keeps working unchanged:
 *
 *   - `./usage-store-core.ts` — the `UsageStore` class itself;
 *   - `./usage-store-types.ts` — the query/input interfaces;
 *   - `./usage-store-mappers.ts` — the row-mapping and SQL-filter layer;
 *   - `./usage-store-window.ts` — the `rangeFor`/`windowFor` helpers.
 */
export { UsageStore } from './usage-store/usage-store-core.js';
export * from './usage-store/usage-store-types.js';
export { rangeFor, windowFor } from './usage-store/usage-store-window.js';
