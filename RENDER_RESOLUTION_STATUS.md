# "Il gioco è pixelato su PC" — status

Two independent causes, fixed in two passes. **Round 1** was the framebuffer;
after it landed the user reported "non è cambiato nulla, è tutto pixelato
ancora" — correctly, because **Round 2** was the real one for indoor/close-up
scenes.

---

# Round 1 · Render resolution on desktop

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

---

# Round 2 · Texture filtering

Round 1 was real but it was not what the player was looking at. A garage
screenshot at native resolution was still made of hard blocks, so the picture
was measured instead of guessed at
(`node .devtests/texture-filtering-probe.mjs`, then a raw dump):

```
canvas 1600×900 · css 1600×900 · dpr 1 · dynamicScale 1 · mipBias 0   ← frame was fine
custom:box:front   uploaded 512×386   source 1140×859   aniso=1  min=1005  mag=1003
```

`mag=1003` is `THREE.NearestFilter`. **Every editor-imported texture in the game
was point-sampled on magnification with anisotropy 1** — 78 of them in the
garage alone. That is what walls, crates, posters, lockers and building facades
were made of, and no amount of framebuffer would have helped.

## Cause

`textureFromSource()` in `js/custom-assets.js` defaulted to `sampling:'pixel'`,
and only three slots (`road`, `roadAlt`, `roadService`) opted into `'smooth'`.
The default also conflicted with the project's own stated policy — see the
comment above `applyRetroMaterials` in `js/game.js`: *"The old PSX pass
(nearest-filter mush) is gone. This pass only normalizes textures for the clean
PS2 look: bilinear filtering + mipmaps."* That pass could never win, because
`textureFromSource` re-runs `configure()` when the async image load resolves and
re-applies `NearestFilter` after the scene-wide pass has already been through.

## Fix

- `textureFromSource` defaults to filtered: `LinearFilter` mag,
  `LinearMipmapLinearFilter` min, anisotropy 8 (three clamps to hardware max).
  `sampling:'pixel'` remains, opt-in, for genuine pixel art.
- Filtering and the **resolution floor** are now separate arguments. The road
  slots pass `budgetFloor: 1024` (full mip chain against the "confetti") and
  keep anisotropy 16; they no longer have to ask for it via the sampling mode.
- The generated canvas signs — `garage.js addSign`/`makeLabel`,
  `tatsumi-pa.js` — were `NearestFilter` with *no mipmaps* at all. A 512 px
  canvas on a 5.5 m plane the player walks up to; now linear + mips + aniso 8.
- Desktop imported-texture cap: Medium 512 → **1024** (= High). Once the
  sampling is smooth, the cap is what decides how much of a 1000–1600 px import
  survives; the garage's 1254² sources were landing at 512².

## Verification

`node .devtests/texture-filtering-probe.mjs` — 6/6. Walks all 78 garage
textures and asserts none is point-sampled, all are trilinear with a mip chain,
none is left at anisotropy 1, and the frame is still native (Round 1 holding).

`node --test tools/hesi-editor/test/unit/custom-assets.test.mjs` — 25/25, with
the old `marking.map.magFilter === NearestFilter` assertion updated to the new
policy. `car-body-wrap-probe` 26/26, `vhs-car-paint-probe` 23/23,
`render-resolution-probe` 10/10. `e2e` 39/42 — no new failures (the 3 are the
pre-existing HUD-overlap and auction ones).

---

# Round 3 · The deploy that "did not apply"

After Round 2 shipped, the live site still looked unchanged to the player. It
was not a build problem — the served bytes were checked directly:

```
$ curl -s https://hesi.onrender.com/js/custom-assets.js | grep -o "sampling = '[a-z]*'"
sampling = 'smooth'
```

…and a clean headless browser against the *live* URL (service workers blocked)
reported canvas `1600×900` = native, 78 textures, all 182 material maps at
`magFilter 1006` (Linear), anisotropy 8. The deploy was correct; the player's
browser was serving an old build out of the service worker.

`sw.js` is network-first, so a deploy normally lands without any cache work.
The trap is the offline fallback plus Render's free tier: the instance sleeps,
and the first request after a cold start can be slow enough to fail — at which
point `caches.match()` serves the *entire* previous build, silently.

`CACHE` was bumped `v65` → `v66`. Changing the bytes of `sw.js` is what makes
`install` run (re-fetching CORE from the network) and `activate` delete the old
cache; `skipWaiting()` + `clients.claim()` were already in place, so it takes
effect on the next load. **Bump it on every deploy that changes a CORE file** —
that is the whole mechanism, and nothing else enforces it.
