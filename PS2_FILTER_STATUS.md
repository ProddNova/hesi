# PS2 FILTER STATUS — 28 Jul 2026

Two changes, both aimed at the same thing: making the game look like it came off
a PlayStation 2 rather than off a modern GPU.

1. **Every imported image is capped at 512×512.**
2. **A new "filtro" panel on key 9** with pixelation, colour quantization +
   dithering, and film grain.

Probe: `node .devtests/ps2-filter-probe.mjs` — **21/21**.
Regression: `node .devtests/vhs-car-paint-probe.mjs` — **23/23** (unchanged).

---

## 1. The 512 px ceiling

`js/custom-assets.js` now exports `MAX_TEXTURE_SIZE = 512` and applies it in
`applyTextureSizeBudget()` **above** every other rule:

```js
const budget = Math.min(MAX_TEXTURE_SIZE, textureSizeBudget ? Math.max(textureSizeBudget, floor) : MAX_TEXTURE_SIZE);
```

This matters because there were three ways to get past the old cap and all three
are now closed:

- **No budget set at all** (`textureSizeBudget === 0`) used to mean "full
  resolution", which is what the editor runs at. It now means "the ceiling".
- **The per-slot floor.** `SMOOTH_SURFACE_TEXTURE_MIN_SIZE` was 1024 so the road
  photographs would keep a complete mip chain; it is now 512, and the `Math.min`
  above would clamp it even if it were not.
- **The quality tiers** in `game.js resize()` were `{low:512, medium:1024,
  high:1024}` on desktop. They are now `{low:256, medium:512, high:512}` — the
  tiers still differ, they just differ below the ceiling.

Downscaling happens on a canvas before GPU upload and preserves aspect ratio
(the longest side lands on 512), so a 1672×837 import becomes 512×256 rather
than a square. Measured on the shipped world: **279 uploaded textures, largest
512 px, 81 of them downscaled, 0 skewed.**

### What is deliberately NOT capped

The **skybox panorama** (`js/skybox.js`, its own 4096 clamp). It is one
equirectangular image covering 360°: at 512 px that is ~1.4 px per degree, and
the ~64° the camera sees would be a 91 px strip stretched across the viewport.
That reads as broken, not as retro. It is excluded by name in the probe so the
exclusion is visible rather than accidental.

Procedural `CanvasTexture`s (road markings, noise, signage in `map.js`) are
authored at their size in code and are not affected — they were never imports.

The cap is applied **at upload, not at import**: the files under
`data/editor/textures/` keep their original resolution, so nothing the player
has authored is destroyed and raising the ceiling later is a one-line change.

---

## 2. FILTRO // 9

- Model: **`js/ps2-filter.js`** (new) — defaults, ranges, clamping, presets,
  label formatting. No pixels.
- Pixels: **`js/vhs-effect.js`** — the filter runs on the pass that already
  exists. A second pass would mean a second full-resolution buffer for what
  amounts to a UV snap, a `floor()` and a noise sample.
- Panel: `#filter-menu` in `index.html`, built at boot by
  `game.js setupFilterMenu()` from `PS2_FILTER_FIELDS`.

### The three stages, in hardware order

**Pixelation** snaps the *sampling* coordinate, not the finished picture: each
block takes ONE sample of the scene, exactly as a smaller framebuffer would,
instead of averaging a sharp frame into mush. The dial is a **virtual line
count** (448 = the PS2's NTSC framebuffer), not a block size in device pixels —
so the look is identical on 1080p and 4K and does not move when the adaptive
resolution governor changes the internal framebuffer. On a 960×540 test window
448 lines is nearly invisible; that is correct, and on a 1080p display it is
2.4 px blocks.

**Quantization + dither.** 32 levels per channel is the console's 5-bit
framebuffer. The dither is added **before** the `floor()` — that is the entire
point: it pushes each pixel across the step boundary in a pattern, so a gradient
that would land on one flat level resolves into two interleaved ones. Applied
after the quantize it would just be noise, which is why the two dials sit in one
group and why the panel says dither does nothing on its own. Three patterns:
ordered 8×8 (console), ordered 4×4, and white noise.

The dither and grain are anchored to the **virtual** framebuffer coordinate, not
the screen one: a console dithers at its own resolution, not at the resolution
of the TV showing it. Without that, each chunky block gets a bayer texture
*inside* it.

**Film grain** is deliberately separate from the VHS pass's own grain (which is
tied to `uAmount`) because it models the capture chain, not the console, and has
to survive with the tape look switched off. Dials: intensity, size, refresh rate
in Hz (0 = frozen), how much it stays in the shadows, and mono ↔ colour.

### Traps found while building it

- **`tapeNoise()` dies at large arguments.** The first version seeded the grain
  with `grainCell + step * 137.0`; after a minute of play that argument is past
  what a 32-bit float resolves, `sin()` returns the same value everywhere, and
  the grain silently freezes into a flat brightness offset. The probe caught it
  as "frame-to-frame delta 0.00". Fixed by wrapping time (`mod(uTime, 512.0)`)
  and the step (two coprime moduli). The existing VHS grain was never affected —
  it uses `fract(uTime * 24.0)`, which is already bounded.
- **Backticks inside the GLSL template literal terminate the string.** Two boot
  failures came from writing `` `pixelCoord` `` in a shader comment. The probe
  now prints captured page errors when boot times out, which turns a 60 s
  timeout into a one-line diagnosis.

### State and invariants

- Stored in `admin.ps2Filter`, normalized once on load
  (`normalizePS2Filter`), persisted like every other dev dial.
- **A disabled filter writes zeros to the uniforms** rather than its stored
  values, so every shader branch is skipped and the pass is a pure passthrough —
  and the dials come back exactly as they were when it is switched on again.
- `VHSEffect.active()` now also returns true for an active filter, so the filter
  works with the VHS look off; a neutral filter releases the buffer entirely.
  Verified: "a neutral filter changes nothing · 0.00%".
- `debug.menuOpen` still means "a dev overlay owns the screen" (the driving
  update, touch controls and pointer lock all read it); `debug.debugOpen` /
  `debug.filterOpen` say which. The two panels are mutually exclusive.

### Reaching it without a keyboard

Touch devices have no key 9, so the debug menu (`0`, or the DBG touch button)
carries an **APRI FILTRO** button.
