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

`CACHE` was bumped `v65` → `v66` as an immediate unstick. But that bump was
manual, and so was `index.html`'s `js/game.js?v=20260728c` — two hand-edited
version strings guarding every deploy, which is why they were sometimes not
edited at all. Round 4 removed both.

---

# Round 4 · No more hand-edited cache versions

**`scripts/stamp-build.mjs`** rewrites both strings with the commit being
deployed, and `render.yaml`'s `buildCommand` runs it — so the stamp happens on
every deploy, including ones pushed from a phone. The id comes from
`RENDER_GIT_COMMIT`, falling back to `git rev-parse`, then to a UTC timestamp so
a build outside a checkout still produces a unique id instead of silently
reusing the last one. The script **exits non-zero if either pattern stops
matching**: a rename fails the deploy rather than shipping it unstamped, which
is the failure mode that started all this. Idempotent, so re-running is a no-op.

**Self-healing clients.** Bumping the cache is only half the problem: claiming a
page does not re-run the modules it already loaded, so an update still needed
one manual reload — and on a phone there are no DevTools to force one. `sw.js`
now posts `hesi-sw-activated` to its windows on `activate`, and `index.html`
reloads once on that message. Three guards, because a silent reload is not free:

- only if a worker was already controlling the page (`navigator.serviceWorker.controller`
  at load) — a first-ever visit has nothing stale to escape;
- at most once per cache name per tab, via `sessionStorage`, so a re-activation
  cannot loop;
- **never once `shutoko.started` is true** — reloading mid-drive would cost the
  player their unbanked run. That session picks the update up on its next
  natural load.

---

# Round 5 · The actual reason the deploy stayed invisible

Round 4 was still not enough, and the reason was in `js/game.js`'s own imports:

```js
from './map.js?v=20260728a'
from './garage.js?v=20260723b'   // changed in Round 2, stamp untouched
from './custom-assets.js'        // the texture fix — NO ?v= at all
```

Every module carried a **hand-written per-file date**. `custom-assets.js` — the
file holding the entire texture-filtering fix — had none, and `garage.js` kept a
five-day-old one although it had changed. Busting `index.html` and the service
worker did nothing, because these URLs were byte-identical to the previous
build: the browser reused what it already had. A clean browser saw the fix
because it had nothing to reuse. That is the whole story of "non è cambiato
nulla".

38 relative imports had no version at all.

## Fix

`stamp-build.mjs` now stamps **one id onto every local URL**, because a URL that
has never been requested cannot be stale in any cache layer:

- `sw.js` — the cache name (required pattern; a miss fails the build)
- `index.html` — every local `href=`/`src=` `.css`/`.js`
- `js/*.js` — every relative module specifier (`from './x.js'`, `import('./y.js')`)

Bare specifiers are left alone: `'three'` goes through the import map to a CDN.

**The build id is now visible on the boot screen** (`Ver.2.02 · 391fef1`), so
"the deploy did not apply" is answerable by looking instead of by guessing which
cache is holding what. Its pattern is required too — losing the label fails the
build rather than silently removing the only way to tell what is running.

## Verification

`node scripts/stamp-build.mjs`: stamps 31 files, no-op on a second run, honours
`RENDER_GIT_COMMIT` (checked with a fake SHA), and exits 1 when a required
pattern is removed (checked by deleting the boot label). Query strings on module
specifiers are resolved fine by Node, the editor server (`requestUrl.pathname`)
and the probe harnesses (`request.url.split('?')[0]`):
`custom-assets` unit tests 25/25, `texture-filtering-probe` 6/6, `e2e` 39/42,
`editor-build-ops-probe` 95/99 hide ops on target (the 4 `chunk 6,-7
box:marking` drifts are the known pre-existing ones).

## Open item — `render.yaml` is not being applied

The deploy of `391fef1` served `shutoko-nights-b33314be4a60`, i.e. the value
committed locally, **not** the deployed commit. So Render never ran
`buildCommand`: the service predates `render.yaml` and is not Blueprint-managed,
so that file is decorative. Until the Build Command is set to
`node scripts/stamp-build.mjs` in the Render dashboard (or the service is
recreated from the Blueprint), **the stamp has to be run locally before
committing** — `npm run build`.

---

# Round 6 · The 4K cap, and putting the numbers on screen

The player's browser reached the latest commit (`03b2aea` on the boot screen)
and still reported "pixelato". So the caches were finally out of the picture and
the diagnosis was simply incomplete.

Anti-aliasing was ruled out by measurement, not by eye —
`node .devtests/antialias-probe.mjs`, 6/6: the driver allocates a 4-sample
framebuffer (the hardware maximum here) for the VHS target, and 70% of
high-contrast edges resolve across pixels, better than with the pass off. The
probe's first run reported 0 edges, which was the *measurement* failing:
without `preserveDrawingBuffer` the buffer is gone once the frame has been
composited, so it now renders and reads back in one task.

**What was left: `maxPixels`.** Desktop carried 4.2 MP — above 1440p, but below
4K's 8.29 MP. So a 4K or high-DPI display rendered at ~71% linear and upscaled,
on Medium, which is the tier a fresh save gets. Invisible on a 1080p test
machine; every probe so far had run at 1280×720 or 1600×900 and reported
"native ✓" quite correctly. Desktop now carries the 8.5 MP headroom on every
tier — the adaptive governor exists to take the frame rate back if the GPU
cannot hold it.

| viewport | before | after |
|---|---|---|
| 1080p, 1440p | native | native |
| 4K (dpr 1 or 1.5) | 2734×1538 → upscaled to 3840×2160 | 3840×2160 native |

**The boot screen now shows the numbers.** Next to the build id:
`· 3840×2160 ✓ · dpr 1.50 · MEDIUM`, or `· 2734×1538 → 3840×2160` when the
frame is being stretched. Six rounds went into guessing at values a photo of the
boot screen would have answered — the drawing buffer, the display pixels, DPR
and the tier. `showRenderInfo()` in `game.js`, filled from
`applyRenderResolution`.

## Verification

A new headless sweep across 1080p/1440p/4K at dpr 1 and 1.5 reports native on
all five, with the on-screen string matching. `render-resolution-probe` 10/10,
`antialias-probe` 6/6.

---

# Round 7 · The actual bug: a desktop on the phone profile

The boot-screen readout added in Round 6 answered it on the first look:

```
Ver.2.02 · 86ad425 · 857×407 → 1920×911 · dpr 1.00 · HIGH
```

857/1920 = **0.446**, and 0.446 is exactly `0.62 × 0.72` — the **touch** quality
scale for High times the **touch** profile's fixed `initialRenderScale`. On
quality High, which on desktop is supposed to be locked at native. The player's
PC was running the phone performance profile, and had been the whole time.

`isTouchDevice` was:

```js
matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
```

`navigator.maxTouchPoints > 0` is true on any Windows machine with a touchscreen
or a precision touchpad. Every probe here missed it because headless Chromium
reports `maxTouchPoints: 0` — so all seven rounds of measurement ran on the
desktop branch and reported "native ✓", entirely correctly, about a code path
the player was never on.

This also explains why nothing before it helped: Rounds 1 and 6 tuned desktop
constants the player's machine never read, and Round 2's texture fix was real
but was being resampled into a 0.446-linear frame.

## Fix

The flag was answering two unrelated questions. They are now separate:

- **`isTouchDevice`** — *can it be touched?* Unchanged and deliberately
  permissive: a Windows laptop with a touch panel still gets the on-screen
  controls. Drives input only (7 call sites).
- **`isHandheld`** — *is it a phone or a tablet?* What the performance profile
  actually needs. Drives the profile, quality scales, `maxPixels`, texture
  budget, MSAA, VHS samples, the governor and resize coalescing (13 call sites).

The rule lives in `js/device-profile.js` as a pure function:

```js
appleHandheld || (pointerCoarse && !anyPointerFine)
```

"touch is the primary pointer AND there is no fine pointer anywhere". Anything
with a mouse or trackpad reports `(any-pointer: fine)`, so a touchscreen laptop
is excluded whether or not its panel makes `(pointer: coarse)` match — which it
can. A phone has no fine pointer at all. iPadOS is the one named exception: it
presents itself as a Mac, and an iPad on a keyboard trackpad reports a fine
pointer while still needing the thermal profile.

**A wrong turn worth recording.** The first attempt keyed on the OS string in
the user agent. It broke `e2e`: that context is a phone-shaped emulation with a
*desktop* UA, so it was classified as a desktop and the "render quality changes
internal resolution" check started failing (Medium and High are both native on
desktop, so nothing moved). Capability queries describe what is actually
attached; UA strings describe what the emulator did not bother to change.

## Verification

**The interesting case cannot be produced in a browser**, which is why the rule
is a pure function. Playwright's `hasTouch: true` supplies the non-zero
`maxTouchPoints` that caused the bug, but it also forces `(pointer: coarse)` to
match — precisely what a real touchscreen laptop does *not* do. Patching
`matchMedia` from an init script to model the real combination stops the page
firing `load` at all. So the truth table is asserted directly:

`node --test .devtests/device-profile.test.mjs` — 8 cases, including Windows
laptop with a touchscreen, the same machine reporting a coarse primary pointer,
Windows tablet with no mouse, iPad on a keyboard trackpad, and a desktop Mac
(which must not be caught by the iPadOS heuristic).

`render-resolution-probe` 10/10 — its desktop assertion now reads `isHandheld`
rather than `isTouchDevice`, which is the question it was always meant to ask.
A phone check added here was **removed again**: a third WebGL context in the
same process would not load reliably, and a flaky check is worse than none.
That direction is covered by `e2e`, which runs the whole session under a full
mobile emulation — **39/42, back to baseline**, with the regression the UA-based
attempt introduced gone.
