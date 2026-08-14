/** Policy settings partial class and the concrete public ProjectStore. */

import {
  DEFAULT_IDLE_RECLAIM_MINUTES,
  DEFAULT_IDLE_STOP_MINUTES,
  DEFAULT_RUN_LIMIT_PER_USER,
  SETTING_IDLE_RECLAIM,
  SETTING_IDLE_STOP,
  SETTING_RUN_LIMIT,
} from './types.js';
import { positiveIntSetting } from './rows.js';
import { ProjectStoreLifecycle } from './lifecycle.js';

export abstract class ProjectStoreSettings extends ProjectStoreLifecycle {
  runLimitPerUser(): number {
    return positiveIntSetting(this.db.getSetting(SETTING_RUN_LIMIT), DEFAULT_RUN_LIMIT_PER_USER);
  }

  idleStopMinutes(): number {
    return positiveIntSetting(this.db.getSetting(SETTING_IDLE_STOP), DEFAULT_IDLE_STOP_MINUTES);
  }

  idleReclaimMinutes(): number {
    return positiveIntSetting(this.db.getSetting(SETTING_IDLE_RECLAIM), DEFAULT_IDLE_RECLAIM_MINUTES);
  }
}

export class ProjectStore extends ProjectStoreSettings {}
