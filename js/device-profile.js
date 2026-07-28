/**
 * Which performance profile does this machine deserve?
 *
 * This used to be one flag, `isTouchDevice`, defined as
 * `(pointer: coarse) || navigator.maxTouchPoints > 0` and used both to decide
 * whether to show on-screen controls AND to pick the render profile. Those are
 * different questions, and `maxTouchPoints > 0` is true on any Windows machine
 * with a touchscreen or a precision touchpad. A player's desktop therefore ran
 * the phone profile: quality High became 0.62 (its quality scale) × 0.72 (its
 * fixed render scale) = a 0.446-linear framebuffer stretched over the monitor,
 * measured as 857×407 presented at 1920×911.
 *
 * Kept as a pure function, separate from game.js, because the browser cannot be
 * made to reproduce the interesting case: Playwright's `hasTouch` forces
 * `(pointer: coarse)` to match, which is exactly what a real touchscreen laptop
 * does NOT do. The truth table is unit-tested instead of emulated.
 */

/**
 * True when this is a phone or a tablet — not merely a machine that can be
 * touched.
 *
 * The test is "touch is the primary pointer AND there is no fine pointer
 * anywhere". Anything with a mouse or a trackpad reports `(any-pointer: fine)`,
 * so a touchscreen laptop is excluded whether or not its panel makes
 * `(pointer: coarse)` match. A phone has no fine pointer at all.
 *
 * Deliberately no user-agent sniffing for the general case: an earlier attempt
 * keyed on the OS string and classified a phone-shaped test context as a
 * desktop, because emulated contexts keep the desktop UA. Capability queries
 * describe what is actually attached.
 *
 * iPadOS is the one exception worth naming. It presents itself as a Mac, and an
 * iPad on a keyboard trackpad reports a fine pointer while still needing the
 * thermal profile.
 */
export function isHandheldDevice({
  userAgent = '', platform = '', maxTouchPoints = 0, pointerCoarse = false, anyPointerFine = false,
} = {}) {
  const appleHandheld = /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  return appleHandheld || (pointerCoarse && !anyPointerFine);
}

/** Reads the live browser values and answers the same question. */
export function detectHandheld(view = typeof window === 'undefined' ? null : window) {
  if (!view?.matchMedia || !view.navigator) return false;
  return isHandheldDevice({
    userAgent: view.navigator.userAgent || '',
    platform: view.navigator.platform || '',
    maxTouchPoints: view.navigator.maxTouchPoints || 0,
    pointerCoarse: view.matchMedia('(pointer: coarse)').matches,
    anyPointerFine: view.matchMedia('(any-pointer: fine)').matches,
  });
}
