import { shellStore } from '../../shell/store';
import {
  getControllerSnapshot,
  parseQualifiedSessionId,
} from '../../controller/transport';
import { TabManagerLifecycle } from './lifecycle';

/**
 * Fourth and final partial: notifications, session activity tracking, and
 * command completion detection.
 */
export abstract class TabManagerStatus extends TabManagerLifecycle {
  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  sendNotification(
    title: string,
    body: string,
    sessionId: string,
    kind: 'finished' | 'failed' = 'finished',
  ): void {
    const preferences = shellStore.getSnapshot().notifications;
    if (!preferences.enabled || !preferences[kind]) return;
    if (sessionId === this.activeTabId) return;
    if (document.visibilityState === 'visible') return;

    const owner = parseQualifiedSessionId(sessionId)?.serverId;
    const serverName = owner
      ? getControllerSnapshot().targets.find((target) => target.id === owner)?.name
      : undefined;
    const visibleTitle = preferences.details ? title : kind === 'failed' ? 'A task failed' : 'A task finished';
    const visibleBody = preferences.details ? body : '';
    const targetedTitle = serverName ? `${visibleTitle} · ${serverName}` : visibleTitle;

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification(targetedTitle, {
          body: visibleBody,
          icon: '/favicon.ico',
          tag: sessionId,
          requireInteraction: false,
          silent: false,
        });

        notification.onclick = () => {
          window.focus();
          void this.reopenAndSwitch(sessionId).catch((error) => {
            console.error('Failed to open notification target:', error);
          });
          notification.close();
        };

        setTimeout(() => notification.close(), 5000);
        return;
      } catch {
        // fall through to the in-page fallback
      }
    }

    this.showInPageNotification(targetedTitle, visibleBody);
  }

  // ---------------------------------------------------------------------------
  // Activity tracking
  // ---------------------------------------------------------------------------

  markSessionActivity(sessionId: string, hasOutput = false, outputData = ''): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const previousActivity = session.lastActivity || 0;
    const wasActive = session.status === 'active';
    session.lastActivity = Date.now();

    if (hasOutput) {
      this.updateTabStatus(sessionId, 'active');

      clearTimeout(session.idleTimeout);
      clearTimeout(session.workCompleteTimeout);

      session.workCompleteTimeout = setTimeout(() => {
        const s = this.activeSessions.get(sessionId);
        if (s && s.status === 'active') {
          this.updateTabStatus(sessionId, 'idle');
          if (wasActive && sessionId !== this.activeTabId) {
            const sessionName = s.name || 'Session';
            const duration = Date.now() - previousActivity;
            this.updateUnreadIndicator(sessionId, true);
            this.sendNotification(
              `${sessionName} -- ${this.getAlias('claude')} appears finished`,
              `No output for 90 seconds (worked for ${Math.round(duration / 1000)}s)`,
              sessionId,
            );
          }
        }
      }, 90000);

      session.idleTimeout = setTimeout(() => {
        // 5-minute backstop; the 90-second timeout handles the transition
      }, 300000);
    }

    if (hasOutput && outputData) {
      this.checkForCommandCompletion(sessionId, outputData);
    }
  }

  /**
   * Take the working / idle state of a session from the server.
   *
   * Ignored on the screen attached to the session, which has the output itself
   * and is already running this exact rule off it. Everywhere else this is the
   * only sign of life there is: output goes to whoever is driving, so without it
   * a session that has been building for a minute reads as idle on every other
   * screen — and stays that way until somebody reloads.
   */
  applyRemoteActivity(sessionId: string, active: boolean): void {
    if (!this.tabs.has(sessionId)) return;
    if (sessionId === this.app.currentClaudeSessionId) return;

    if (active) this.markSessionActivity(sessionId, true);
    else this.updateTabStatus(sessionId, 'idle');
  }

  private checkForCommandCompletion(sessionId: string, outputData: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const completionPatterns = [
      /build\s+successful/i,
      /compilation\s+finished/i,
      /tests?\s+passed/i,
      /deployment\s+complete/i,
      /npm\s+install.*completed/i,
      /successfully\s+compiled/i,
      /✓\s+All\s+tests\s+passed/i,
      /Done\s+in\s+\d+\.\d+s/i,
    ];

    const hasCompletion = completionPatterns.some((p) => p.test(outputData));

    if (hasCompletion && sessionId !== this.activeTabId) {
      let message = 'Task completed successfully';
      if (/build\s+successful/i.test(outputData)) message = 'Build completed successfully';
      else if (/tests?\s+passed/i.test(outputData)) message = 'All tests passed';
      else if (/deployment\s+complete/i.test(outputData)) message = 'Deployment completed';

      this.updateUnreadIndicator(sessionId, true);
      this.sendNotification(session.name || 'Session', message, sessionId);
    }
  }

  markSessionError(sessionId: string, hasError = true): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.hasError = hasError;
    if (hasError) {
      this.updateTabStatus(sessionId, 'error');
      this.sendNotification(
        `Error in ${session.name || 'Session'}`,
        'A command has failed or the session encountered an error',
        sessionId,
        'failed',
      );
    } else {
      this.syncShell();
    }
  }
}