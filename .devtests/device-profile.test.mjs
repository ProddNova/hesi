/**
 * Truth table for isHandheldDevice — which machines get the phone performance
 * profile.
 *
 * A unit test rather than a browser probe on purpose: the case that caused the
 * bug cannot be produced in Playwright. `hasTouch: true` gives the non-zero
 * maxTouchPoints of a touchscreen laptop but also forces `(pointer: coarse)` to
 * match, which real touchscreen laptops do not — there the primary pointer is
 * the mouse. Emulating it by patching matchMedia in an init script stops the
 * page from firing `load` at all. So the inputs are supplied directly.
 *
 * Run: node --test .devtests/device-profile.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHandheldDevice } from '../js/device-profile.js';

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const IPADOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';

const cases = [
  // The bug. maxTouchPoints > 0, which is what the old flag keyed on, but the
  // mouse is the primary pointer and a trackpad is attached.
  ['Windows laptop with a touchscreen', false, {
    userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 10, pointerCoarse: false, anyPointerFine: true,
  }],
  ['plain Windows desktop', false, {
    userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 0, pointerCoarse: false, anyPointerFine: true,
  }],
  // Same machine, but something makes the coarse pointer primary (a browser
  // quirk, an emulator, a detached keyboard). The fine pointer is still there.
  ['touchscreen desktop reporting a coarse primary pointer', false, {
    userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 10, pointerCoarse: true, anyPointerFine: true,
  }],
  ['Android phone', true, {
    userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5, pointerCoarse: true, anyPointerFine: false,
  }],
  ['iPhone', true, {
    userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, pointerCoarse: true, anyPointerFine: false,
  }],
  // iPadOS presents as a Mac; only maxTouchPoints gives it away. With a
  // keyboard trackpad it also reports a fine pointer, and it still needs the
  // thermal profile — hence the explicit Apple branch.
  ['iPad on a keyboard trackpad', true, {
    userAgent: IPADOS, platform: 'MacIntel', maxTouchPoints: 5, pointerCoarse: true, anyPointerFine: true,
  }],
  ['Windows tablet with no mouse attached', true, {
    userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 10, pointerCoarse: true, anyPointerFine: false,
  }],
  // A desktop Mac must not be caught by the iPadOS heuristic: same UA and
  // platform, but no touch points.
  ['desktop Mac', false, {
    userAgent: IPADOS, platform: 'MacIntel', maxTouchPoints: 0, pointerCoarse: false, anyPointerFine: true,
  }],
];

test('isHandheldDevice separates handhelds from machines that merely have touch', () => {
  for (const [name, expected, input] of cases) {
    assert.equal(isHandheldDevice(input), expected, `${name} should be ${expected ? '' : 'NOT '}handheld`);
  }
});

test('an empty environment is not a handheld', () => {
  assert.equal(isHandheldDevice(), false);
  assert.equal(isHandheldDevice({}), false);
});
