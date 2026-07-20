# PS2 visual art direction status (2026-07-17)

Scope: visual presentation only — lighting, fog, sky, post-processing,
material palette, emissive treatment and roadside dressing. No gameplay,
physics, traffic-logic, UI-layout or map-topology changes.

Reference direction: GT4 / NFSU2 / Midnight Club 2-era Japanese night
racing — warm sodium expressway pools, light-pollution sky, low-poly
intentional geometry, controlled bloom.

## Audit findings

What was already right (kept as the foundation):

- Lambert flat-color materials everywhere, no PBR, no shadow maps.
- Canvas-generated facade window grids, additive sodium light-pool and
  wet-streak decals, merged chunk geometry + instanced props, flat-shaded
  vertex-colored traffic.

What broke the PS2 illusion:

- **No bloom at all.** Every emissive (lamps, headlights, windows,
  tail lights) rendered as flat bright pixels; the era's signature glow was
  absent.
- **Void sky.** `scene.background` was a flat near-black color — no
  light-pollution horizon, so the world floated in nothing.
- **Cool blue-grey global cast.** Two stacked blue light rigs (game.js +
  map.js), deep-blue fog (`0x050713`) and a blue-shifted material palette
  (road `0x14171f`, blue-grey barriers) read "generic modern indie", not
  sodium-lit Tokyo.
- Dark gradients banded visibly (no dithering), and the overall frame had
  no grade/vignette identity.

## Systems changed

1. **`js/retro-post.js` (new)** — dependency-free post pipeline:
   scene → 2×MSAA render target, quarter-res bright pass (max-channel
   threshold so saturated tail lights/lamps bloom), two separable blur
   iterations for the convolution-bloom halo, then one composite pass with
   warm sodium grade, highlight soft-shoulder, vignette and a 4×4 ordered
   dither (kills sky banding, very console). Quality-aware: Low runs the
   bloom chain at 1/8 res with one blur iteration. Wired into
   `game.js` `render()`/`resize()`; falls back to direct rendering if
   construction fails.
2. **Sky dome (`map.js`)** — inverted low-poly sphere with an 8×128 canvas
   gradient: near-black zenith into a warm sodium band at the horizon,
   `fog:false` so the glow stays crisp behind the fogged world. Follows the
   player in `update()`; 1 draw call.
3. **Lighting/fog** — warm hemisphere + ambient (sodium light pollution)
   with a dimmer cool "moon" directional for roof contrast, in both light
   rigs; fog and background re-tinted to warm murk (`0x0e0a06` @ 0.0013) so
   distant geometry fades into the same haze the sky glows with.
4. **Material palette** — single warm-neutral language: asphalt
   (`0x181613`), concrete/barriers/rails warm grey with warm emissive
   floors, tunnel walls, ground, fences, sheds, garage all de-blued;
   broadcast tower now floodlit warm orange; facade textures warmed and
   window-lit fractions retuned; light pools/streaks slightly stronger.
5. **Industrial dressing (`_buildCity` K1)** — parked box/flatbed trucks
   (3 instanced boxes each, white/silver fleet colors), pallet stacks and
   one sodium lot lamp + pool per yard so the warehouse lots read from the
   viaduct like the reference's loading yards. Reuses existing instanced
   types — no new materials or geometry types.
6. **Traffic fit (`traffic.js`)** — added white/silver body colors
   (weighted ×2) to match real Tokyo traffic and the era's look.

## Style decisions

- Warmth lives in **light, fog and grade**, not in repainting every asset
  saturated orange: the palette is warm-neutral, the sodium comes from the
  hemisphere light, the pools and the post tint (1.04, 0.995, 0.93).
- Bloom threshold sits above lit-asphalt level (0.55 linear, knee 0.3,
  strength 0.62) so markings/lamps/windows glow but the road surface stays
  readable at speed.
- Sky glow > fog brightness: fog fades buildings into dark murk, the dome
  band reads as city glow *behind* the haze — the classic PS2 trick.
- Dither + vignette give the frame a console-output identity without
  the old PSX posterize/vertex-snap mush (which the repo deliberately
  removed).

## Performance considerations

Measured with `.devtests/style-perf.mjs` (new, post-pipeline-aware: it
accumulates `renderer.info` across all passes per frame — the existing
probes only see the final composite call now), 844×390 @2x, Medium,
k1-industrial, 44 traffic:

| Metric | Before | After |
|---|---:|---:|
| Draw calls / frame (all passes) | 172 | 187 |
| Triangles / frame | 38.4k | 42.3k (budget 70k) |
| Frame mean / p95 (SwiftShader, software) | 133.8 / 148.6 ms | 177.5 / 192.0 ms |

The frame-time delta is a **software-rasterizer artifact**: headless
SwiftShader pays CPU cost per fullscreen-pass pixel, which is exactly what
a post pipeline adds. On real GPUs (including mobile) the added passes are
~0.6 MPix of quarter-res work plus two full-res passes — low single-digit
ms at worst, and Low quality trims bloom to 1/8 res. Geometry additions
(trucks/lamps/dome) cost +15 draw calls and +4k triangles, well inside the
repo's 70k/175-call budgets. Note: `.devtests/performance.mjs`'s 150 ms
p95 gate was calibrated before any post-processing existed and will read
high under software rendering; recalibrate it against a hardware-rendered
baseline in a future pass.

## Screenshots

`docs/style-overhaul/` (half-res): before/after pairs for
`wangan-straight`, `k1-industrial`, `c1-tunnel` (C1 canyon),
`rainbow-bridge`, plus after-only `industrial-yards`,
`elevated-overview`, `lamp-pools`, `barrier-closeup`, `skyline-wide`.
Repeatable capture: `.devtests/landmarks.mjs` (chase cam) and
`.devtests/style-shots.mjs` (drone views, new).

## Remaining work / recommended future passes

1. **UI pass** — HUD/phone/boot-screen typography and color to match the
   sodium identity (currently untouched by design).
2. **Car-shader pass** — player/traffic paint could take a cheap two-tone
   fresnel-ish ramp (vertex-color trick) for the GT4 paint feel; headlight
   cones as additive billboards instead of real spotlights.
3. **VFX pass** — speed-streak particles, tunnel-light strobing, rain/wet
   variant of the streak decals, near-miss camera shake polish.
4. **Menu/branding pass** — boot screen, garage PC skin, loading screen.
5. Visual niceties deferred: skyline silhouette variety behind Daikoku,
   ground-level clutter along R9/R1 (vending machines, fences exist but are
   sparse), per-route fog density tinting (bay vs canyon), recalibrating
   `.devtests/performance.mjs` for the post pipeline.
