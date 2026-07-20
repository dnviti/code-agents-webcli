// Plan mode detection for Claude Code sessions

import type { PlanData } from '../types';

export class PlanDetector {
  isMonitoring: boolean;
  planModeActive: boolean;
  currentPlan: PlanData | null;
  onPlanDetected: ((plan: PlanData) => void) | null;
  onPlanModeChange: ((active: boolean) => void) | null;

  private readonly planStartMarker = '## Implementation Plan:';
  private readonly planEndMarker = 'User has approved your plan';
  private readonly maxChars = 50000;

  /**
   * A single rolling, already ANSI-stripped string. Keeping the raw chunks and
   * re-joining plus re-stripping them on every chunk was quadratic in the
   * amount of output produced.
   */
  private text = '';
  private lastPlanContent: string | null = null;

  constructor() {
    this.isMonitoring = false;
    this.planModeActive = false;
    this.currentPlan = null;
    this.onPlanDetected = null;
    this.onPlanModeChange = null;
  }

  processOutput(data: string): void {
    if (!this.isMonitoring) return;

    this.text += data
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\[[0-9]*[A-Za-z]/g, '');

    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(-this.maxChars);
    }

    const recentText = this.text;

    if (!this.planModeActive && this.detectPlanModeStart(recentText)) {
      this.planModeActive = true;
      this.onPlanModeChange?.(true);
    }

    if (this.planModeActive && this.detectCompletedPlan(recentText)) {
      const plan = this.extractPlan(recentText);
      // Fire once per distinct plan: the markers stay inside the window, so an
      // unguarded callback reopens the modal on every subsequent chunk and the
      // user can never dismiss it.
      if (plan && plan.content !== this.lastPlanContent) {
        this.lastPlanContent = plan.content;
        this.currentPlan = plan;
        this.onPlanDetected?.(plan);
      }
    }

    if (this.planModeActive && this.detectPlanModeEnd(recentText)) {
      this.planModeActive = false;
      // Drop the consumed window, otherwise the start markers still in it
      // immediately re-activate plan mode on the next chunk.
      this.text = '';
      this.lastPlanContent = null;
      this.onPlanModeChange?.(false);
    }
  }

  getRecentText(maxChars = 50000): string {
    return this.text.slice(-maxChars);
  }

  private detectPlanModeStart(text: string): boolean {
    const indicators = [
      'Plan mode is active',
      'you MUST NOT make any edits',
      'present your plan by calling the ExitPlanMode tool',
      'Starting plan mode',
    ];
    return indicators.some((indicator) => text.includes(indicator));
  }

  private detectCompletedPlan(text: string): boolean {
    const planPatterns = [
      /## Implementation Plan:/,
      /### \d+\. /,
      /## Plan:/,
      /### Plan Overview/,
      /## Proposed Solution:/,
    ];

    const hasPattern = planPatterns.some((pattern) => pattern.test(text));
    const recentText = text.slice(-10000);

    return hasPattern && recentText.includes('###');
  }

  private extractPlan(text: string): PlanData | null {
    let plan: string | null = null;

    const implMatch = text.match(
      /## Implementation Plan:[\s\S]*?(?=(?:User has approved|Exit plan mode|[$>]|^[a-z]+@))/i,
    );
    if (implMatch) {
      plan = implMatch[0];
    }

    if (!plan) {
      const structuredMatch = text.match(
        /##[^#].*?Plan.*?:[\s\S]*?(?:###.*?[\s\S]*?){2,}(?=(?:User has approved|Exit plan mode|[$>]|^[a-z]+@))/i,
      );
      if (structuredMatch) {
        plan = structuredMatch[0];
      }
    }

    if (!plan) {
      const recentText = text.slice(-5000);
      const planMatch = recentText.match(/(?:##|Plan:)[\s\S]*?(?:###[\s\S]*?){1,}/);
      if (planMatch) {
        plan = planMatch[0];
      }
    }

    if (plan) {
      plan = plan
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();

      return {
        content: plan,
        timestamp: Date.now(),
        raw: plan,
      };
    }

    return null;
  }

  private detectPlanModeEnd(text: string): boolean {
    const endIndicators = [
      'User has approved your plan',
      'You can now start coding',
      'Plan mode exited',
      'Exiting plan mode',
    ];
    return endIndicators.some((indicator) => text.includes(indicator));
  }

  startMonitoring(): void {
    this.isMonitoring = true;
    this.text = '';
    this.planModeActive = false;
    this.currentPlan = null;
    this.lastPlanContent = null;
  }

  stopMonitoring(): void {
    this.isMonitoring = false;
    this.text = '';
    this.planModeActive = false;
    this.currentPlan = null;
    this.lastPlanContent = null;
  }

  clearBuffer(): void {
    this.text = '';
    this.currentPlan = null;
    this.lastPlanContent = null;
  }

  getPlanModeStatus(): boolean {
    return this.planModeActive;
  }

  getCurrentPlan(): PlanData | null {
    return this.currentPlan;
  }
}
