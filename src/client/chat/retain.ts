/**
 * Which turns the transcript keeps prepared, and which it lets go.
 *
 * Folded turns used to be rendered anyway and merely hidden, so entering a
 * conversation built its entire backlog — code blocks, diffs, diagrams, tool
 * output — none of which was on screen. This decides what is actually built.
 *
 * Three rules, in order of authority:
 *
 *   1. A turn that is open is prepared. So is the live turn, open or not.
 *      Neither is ever released; the conversation you are looking at must not
 *      feel lazy.
 *   2. A turn you have opened and since folded stays prepared, so re-opening it
 *      is instant — which is exactly what hiding rather than unmounting used to
 *      buy, and the behaviour this must not lose.
 *   3. What rule 2 keeps is bounded. Past the budget the least recently opened
 *      material is released, and prepared again if the user goes back to it.
 *
 * The bound is a *content* budget rather than a turn count. A conversation of
 * one-line exchanges and one full of large files are nothing alike at the same
 * turn count, and it is memory that has to stay bounded, not turns. A small
 * floor of turns is kept regardless so that a conversation made entirely of
 * enormous turns still re-opens the last few without rebuilding them.
 *
 * Pure — no DOM, no React, no transcript object — so the policy can be tested
 * on its own and the list component only has to apply it.
 */

import type { ChatBlock, ChatMessage } from '../../shared/chat-events.js';

/**
 * How much content may sit in released-but-prepared turns, in weight units.
 *
 * A unit is roughly one character of rendered content (see `turnWeight`), so
 * this is about 200k characters of backlog held against a re-open. Turns that
 * are open, and the live one, are outside the budget entirely.
 */
export const RETAIN_BUDGET = 200_000;

/**
 * Turns kept whatever they weigh.
 *
 * Without this a single turn heavier than the whole budget would evict every
 * neighbour and then still be evicted itself, so nothing would ever be kept.
 */
export const RETAIN_FLOOR = 3;

export interface RetainInput {
  /** Every turn id, in conversation order. */
  order: readonly string[];
  /** The turns open right now. */
  open: ReadonlySet<string>;
  /** The turn in progress, which is prepared whether or not it is open. */
  liveId?: string;
  /** What preparing a turn costs. Called at most once per turn per call. */
  weightOf: (turnId: string) => number;
  budget?: number;
  floor?: number;
}

/**
 * The turns to keep prepared, most recently opened first.
 *
 * `previous` is the last answer, which is where the recency order lives: a turn
 * already in it holds its place, and a turn that has just been opened goes to
 * the front. There are no timestamps because there is nothing to timestamp —
 * "recently opened" is precisely "appeared in the open set more recently than
 * the others did", and successive calls record that.
 *
 * Returns `previous` itself when the answer has not changed, so the caller can
 * compare by identity and re-render nothing.
 */
export function retain(previous: readonly string[], input: RetainInput): string[] {
  const { order, open, liveId, weightOf } = input;
  const budget = input.budget ?? RETAIN_BUDGET;
  const floor = input.floor ?? RETAIN_FLOOR;

  const known = new Set(order);

  // Never released. The live turn is in here even when folded: it is being
  // written to, and a turn that has to be built at the moment it finishes is
  // the one case where the delay would be visible.
  const pinned = new Set<string>();
  for (const id of open) if (known.has(id)) pinned.add(id);
  if (liveId && known.has(liveId)) pinned.add(liveId);

  // Recency order. Everything still open goes to the front, newest turn first:
  // a turn open across several calls is being looked at now, so it must not
  // drift down the order and be released the moment it is folded. Behind them,
  // whatever was kept last time, in the order it was kept — minus turns that
  // have left the conversation entirely (cleared, or scrolled out of the
  // loaded window).
  const mru: string[] = [];
  for (let i = order.length - 1; i >= 0; i--) if (pinned.has(order[i])) mru.push(order[i]);
  for (const id of previous) if (known.has(id) && !pinned.has(id)) mru.push(id);

  const kept: string[] = [];
  let released = 0;
  let spent = 0;
  for (const id of mru) {
    if (pinned.has(id)) {
      kept.push(id);
      continue;
    }
    const weight = weightOf(id);
    // The floor counts released turns only, and is checked before the budget,
    // so a turn that alone exceeds the whole budget is still kept while there
    // is room under the floor. Without it such a turn would evict its
    // neighbours and then be dropped itself, and nothing would ever be kept.
    if (released >= floor && spent + weight > budget) continue;
    kept.push(id);
    released += 1;
    spent += weight;
  }

  return same(previous, kept) ? (previous as string[]) : kept;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * What preparing a message costs, as a proxy for the DOM and text it builds.
 *
 * Characters, because that is what the expensive part of this surface actually
 * scales with: Markdown parsing, syntax highlighting, diff rendering and
 * Mermaid all take time in the length of their input. Two adjustments to the
 * raw count:
 *
 *   - every block carries a flat cost, so a turn of three hundred empty tool
 *     calls is not free — it is three hundred cards;
 *   - an image counts for a fixed amount rather than the length of its URL. A
 *     decoded bitmap is the heaviest thing on the page and its size is not
 *     something the transcript knows.
 */
export const BLOCK_COST = 256;
export const IMAGE_COST = 2048;

export function messageWeight(message: ChatMessage): number {
  let weight = 0;
  for (const block of message.blocks) weight += BLOCK_COST + blockWeight(block);
  return weight;
}

function blockWeight(block: ChatBlock): number {
  switch (block.kind) {
    case 'text':
    case 'thinking':
    case 'error':
      return block.text.length;
    case 'notice':
      return block.text.length + (block.detail?.length ?? 0);
    case 'image':
      return IMAGE_COST;
    case 'plan':
      return block.items.reduce((sum, item) => sum + item.text.length, 0);
    case 'question':
      return block.request.question.length
        + block.request.options.reduce(
          (sum, option) => sum + option.label.length + (option.description?.length ?? 0),
          0,
        )
        + (block.answer?.text?.length ?? 0);
    case 'tool': {
      let weight = block.name.length + (block.title?.length ?? 0);
      weight += block.output?.length ?? 0;
      weight += block.inputPartial?.length ?? 0;
      weight += block.error?.length ?? 0;
      weight += size(block.input);
      for (const diff of block.diffs ?? []) {
        weight += diff.path.length;
        for (const hunk of diff.hunks) {
          for (const line of hunk.lines) weight += line.length;
        }
      }
      for (const step of block.agent?.steps ?? []) {
        weight += BLOCK_COST + step.name.length + (step.output?.length ?? 0) + size(step.input);
      }
      return weight;
    }
    default:
      return 0;
  }
}

/**
 * Length of a tool argument without serialising it.
 *
 * `JSON.stringify` on every tool input of every turn, every time the retained
 * set is recomputed, would cost more than the rendering this is trying to
 * avoid — and it throws on the cyclic objects some adapters hand through. This
 * walks a bounded depth and gives up rather than being exact: it only has to
 * separate "a path" from "a file's contents".
 */
function size(value: unknown, depth = 0): number {
  if (value == null || depth > 3) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += size(item, depth + 1);
    return total;
  }
  if (typeof value === 'object') {
    let total = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += key.length + size(item, depth + 1);
    }
    return total;
  }
  return 0;
}
