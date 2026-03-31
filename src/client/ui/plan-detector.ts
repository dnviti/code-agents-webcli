// Plan mode detection for Claude Code sessions

import type { PlanData } from '../types';

interface BufferEntry {
  timestamp: number;
  data: string;
}

export class PlanDetector {
  isMonitoring: boolean;
  outputBuffer: BufferEntry[];
  planModeActive: boolean;
  currentPlan: PlanData | null;
  onPlanDetected: ((plan: PlanData) => void) | null;
  onPlanModeChange: ((active: boolean) => void) | null;

  private readonly planStartMarker = '## Implementation Plan:';
  private readonly planEndMarker = 'User has approved your plan';
  private readonly maxBufferSize = 10000;

  constructor() {
    this.isMonitoring = false;
    this.outputBuffer = [];
    this.planModeActive = false;
    this.currentPlan = null;
    this.onPlanDetected = null;
    this.onPlanModeChange = null;
  }

  processOutput(data: string): void {
    if (!this.isMonitoring) return;

    this.outputBuffer.push({ timestamp: Date.now(), data });

    if (this.outputBuffer.length > this.maxBufferSize) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferSize / 2);
    }

    const recentText = this.getRecentText();

    if (!this.planModeActive && this.detectPlanModeStart(recentText)) {
      this.planModeActive = true;
      this.onPlanModeChange?.(true);
    }

    if (this.planModeActive && this.detectCompletedPlan(recentText)) {
      const plan = this.extractPlan(recentText);
      if (plan) {
        this.currentPlan = plan;
        this.onPlanDetected?.(plan);
      }
    }

    if (this.planModeActive && this.detectPlanModeEnd(recentText)) {
      this.planModeActive = false;
      this.onPlanModeChange?.(false);
    }
  }

  getRecentText(maxChars = 50000): string {
    const text = this.outputBuffer
      .map((item) => item.data)
      .join('')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\[[0-9]*[A-Za-z]/g, '');

    return text.slice(-maxChars);
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
    this.outputBuffer = [];
    this.planModeActive = false;
    this.currentPlan = null;
  }

  stopMonitoring(): void {
    this.isMonitoring = false;
    this.outputBuffer = [];
    this.planModeActive = false;
    this.currentPlan = null;
  }

  clearBuffer(): void {
    this.outputBuffer = [];
    this.currentPlan = null;
  }

  getPlanModeStatus(): boolean {
    return this.planModeActive;
  }

  getCurrentPlan(): PlanData | null {
    return this.currentPlan;
  }
}
