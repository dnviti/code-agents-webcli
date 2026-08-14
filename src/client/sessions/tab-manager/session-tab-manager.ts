import { TabManagerStatus } from './status';

/**
 * The concrete public facade wrapping the partial-class chain.
 *
 * Every method is inherited from TabManagerCore → TabManagerSessionSync →
 * TabManagerLifecycle → TabManagerStatus. This class exists solely so that
 * the public API surface (SessionTabManager) is a single concrete class.
 */
export class SessionTabManager extends TabManagerStatus {}