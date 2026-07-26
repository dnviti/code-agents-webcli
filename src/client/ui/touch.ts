/**
 * The phone's sizing rules — type scale, target size, spacing — in one place.
 *
 * Why a TypeScript module and not a stylesheet: this app's chrome is styled
 * with inline `React.CSSProperties` over the Relay custom properties, and a
 * media query cannot reach an inline style. A `@media (max-width: 480px)` block
 * would silently apply to nothing on almost every surface this issue is about.
 *
 * So the phone scale is a value that components read, gated on the same
 * `isMobile` the shell already computes (`ui/mobile.ts` → `shellStore` →
 * `AppShell` → `ChatView` → children). One source for the device answer, one
 * source for the numbers that follow from it.
 *
 * These are minimums, not suggestions. The browser checks assert the resulting
 * geometry against their own copies of the thresholds — deliberately not by
 * importing this file, because a check that imports the constants only proves
 * the app agrees with itself.
 */

import * as React from 'react';

/**
 * Type scale for a phone.
 *
 * The desktop scale bottoms out at 10px (`--text-2xs`), which is a caption size
 * for a screen held at desk distance. At arm's length on a phone it is not
 * readable, and several things set at it — cost, model, the state word — are
 * exactly what somebody looks at mid-session.
 *
 * The rule the acceptance criteria state: nothing carrying live session
 * information is smaller than the body text. `label` is therefore equal to
 * `body`, not one step below it, and that is the point of the pair.
 */
export const PHONE_TEXT = {
  /** Conversation prose and anything read as a sentence. */
  body: 15,
  /** Live session information: cost, tokens, model, state, approvals, branch. */
  label: 15,
  /**
   * Anything the user types into.
   *
   * 16 rather than 15 for one specific reason: iOS Safari zooms the page in
   * when a focused field is set below 16px, and it does not zoom back out. The
   * composer's own buttons end up off the right edge of a page the user never
   * asked to magnify, which is a worse failure than the one the small type was.
   */
  input: 16,
  /** Standing context that is true all session and glanced at, not read. */
  meta: 13,
} as const;

/**
 * The smallest thing a finger is asked to hit, in CSS pixels.
 *
 * 44 is the number both platform guidelines land on, and it is a *hit area*,
 * not an ink size: an icon may be drawn at 20px inside a 44px button. Below
 * this, on the sizes the desktop chrome uses (26–34px), the intended control
 * and its neighbour are within one fingertip of each other.
 */
export const TOUCH_TARGET = 44;

/**
 * Clear space between two neighbouring targets.
 *
 * Size alone does not fix mistaps: two 44px buttons touching each other still
 * present one continuous 88px strip with an invisible seam. The gap is what
 * makes the seam findable.
 */
export const TOUCH_GAP = 8;

/** Phone padding steps, so surfaces do not each invent their own. */
export const PHONE_SPACE = {
  /** Inside a control, between its icon and its label. */
  inline: 8,
  /** A surface's own edge padding. */
  edge: 12,
} as const;

/**
 * Whether this subtree is being drawn on a phone.
 *
 * A context rather than a prop because the surfaces that need the answer are
 * the deepest ones: a copy button inside a tool call inside a message bubble
 * inside the list. Threading `isMobile` down five levels puts the same
 * parameter on five component signatures, and the level that forgets to pass it
 * on is exactly the level that keeps a 22px button — which is how a phone
 * layout ends up correct in the chrome and unchanged everywhere else.
 *
 * Defaults to false, so a component rendered outside a provider (a dialog
 * mounted at the root, a static render, a unit test) gets the desktop sizes it
 * had before.
 */
export const PhoneContext = React.createContext(false);

export function usePhone(): boolean {
  return React.useContext(PhoneContext);
}
