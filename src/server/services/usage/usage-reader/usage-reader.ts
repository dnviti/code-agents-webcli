import { UsageReaderStats } from './stats.js';

/**
 * The public `UsageReader`: a thin concrete leaf over the abstract inheritance
 * chain (`UsageReaderCore` → `UsageReaderSessions` → `UsageReaderStats`).
 * All behavior lives in those layers; this class exists so callers can
 * `new UsageReader(...)` against the concrete type.
 */
export class UsageReader extends UsageReaderStats {}
