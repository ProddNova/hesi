# Render resolution on desktop — status

**Report (28 Jul 2026):** "perché da PC risulta così pixelato?" — the game looked
upscaled and aliased on a normal PC, at the default settings, in the editor
playground and in the game alike.

## Cause

Nothing to do with the VHS pass or the PS2 look. The internal framebuffer was
simply well below the monitor.

`applyRenderResolution()` multiplies three things: DPR, a per-quality scale, and
the adaptive governor's dynamic scale. On desktop those were `0.75` (Medium, the
tier a fresh save gets) × `0.82` (`initialRenderScale`) = **0.615 linear, 38% of
the pixels**, stretched bilinearly over the native canvas. The governor could
walk it down to `0.68` × `0.75` = `0.51`.

It usually did, because of a second bug: the governor compared each frame's CPU
cost against `1000/targetFps` with `targetFps = 144`, i.e. a 6.9 ms budget with a
6.1 ms trigger. On a 60 Hz display — where 16.7 ms per frame is perfect — that
is a false positive on almost every frame, so the resolution rode the floor on
machines that were never late.

## Fix (`js/game.js`)

| | before | after |
|---|---|---|
| desktop `initialRenderScale` | `.82` | `1` |
| desktop `minRenderScale` | `.68` | `.8` |
| desktop `maxPixels` | 3.2 MP | 4.2 MP (1440p native) |
| desktop quality scale | low `.55` / med `.75` / high `1` | low `.62` / med `1` / high `1` |
| governor budget | `1000/144`, fixed | `max(1000/targetFps, observed display interval)` |
| desktop imported-texture cap | 128 / 256 / 1024 | 256 / 512 / 1024 |

Desktop Medium and High both draw at native now; they differ in view distance,
far plane, anisotropy and texture budget, and Medium keeps the adaptive governor
(floor `.8`) as its safety net while High stays locked. Low is the only tier
that renders below the display.

The display interval is estimated as the **shortest** wall-clock gap between
presented frames, never an average — on a machine that is genuinely late the
average *is* the symptom, and folding it into the budget would make the governor
stop noticing.

Touch profiles are untouched: their scales, DPR cap and 1.25 MP ceiling were
tuned against a real thermal budget.

## Verification

`node .devtests/render-resolution-probe.mjs` — 10/10. Asserts the drawing buffer
matches viewport × DPR on Medium and High, that the map needs no mip-bias
compensation (bias 0), that Low is the only sub-native tier, that the governor
learns a 16.7 ms cadence, and that it holds native when a 12 ms frame fits it.

`node .devtests/e2e.mjs` — 38/42, byte-identical to the pre-change baseline
(verified by stashing `js/game.js` and re-running): the 4 failures are the
pre-existing HUD-overlap, touch-steer and auction ones.
