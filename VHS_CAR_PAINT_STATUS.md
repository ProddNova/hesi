# VHS pass + player body paint — status

Two changes, July 2026: a light VHS present pass over the whole game, and a real
body-paint control for the player car (which replaces the per-part colour
fumbling that produced half-painted cars).

## 1 · VHS present pass — `js/vhs-effect.js`

The scene renders into an offscreen buffer and is presented through one
fullscreen quad that adds four restrained artifacts:

| artifact | strength | notes |
| --- | --- | --- |
| chroma split | 0 at centre → ~0.2 % of width at the edges | grows with `edge²`; static, it does not breathe with time |
| field scanlines | 3 % | pitch = `clamp(bufferHeight × 0.25, 120, 300)` line pairs, so it never aliases or changes with the render-scale governor |
| grain | 2.6 %, weighted by `1 − 0.65·luma` | lives in the sky and tunnel shadows, not on lit signs |
| edge falloff | 15 %, cubic | worn-tape frame |

### No artifact displaces the picture — July 2026

The first version also had a standing wobble (`sin(uv.y·74 + t)`) and a soft
tracking band crawling up the frame, both of which shifted whole rows sideways.
Over a road rushing at the camera that does not read as tape: it reads as the
world flexing, i.e. **waves**, which is what the user reported. Every
UV-warping term is gone and each output pixel now samples its own row; only the
colour/contrast side of a worn tape is left. If tape *movement* is ever wanted
back, it has to be gated to something that is not the whole frame.

Setting: **phone → Settings → VHS FILTER** (`state.settings.vhs`, default on).
`game.setVHS()` allocates/releases the buffer; nothing else changes.

### The `isXRRenderTarget` flag is load-bearing — do not remove it

three.js renders into an ordinary offscreen target with **LinearSRGB output and
tone mapping OFF**, expecting a late output pass. That is wrong for this game
twice over:

1. **Look.** The night highway leans on additive lamp pools and streaks. Letting
   them accumulate in linear HDR and tone-mapping once at the end makes the road
   glow visibly hotter and redder. Measured on the first implementation: the
   road went from orange to red, mean frame luma +5 %.
2. **Stutter.** Output colour space and tone mapping are part of three.js'
   program cache key. An ordinary offscreen target forks **every** program, so
   the boot prewarm (`prewarmGpuResources`) would cover the canvas variant while
   the frames actually drawn compile mid-drive — the exact failure
   `DRIVING_STUTTER_STATUS.md` exists to prevent.

Marking the buffer `isXRRenderTarget = true` tells three to treat it exactly
like the canvas: tone map per material, encode to the texture's own colour
space. With an sRGB byte texture the buffer holds precisely the pixels the
canvas would have shown, the program cache key is unchanged, and the quad is a
pure passthrough apart from the artifacts. This is why the quad's shader has
**no** `tonemapping_fragment` / `colorspace_fragment` include, and why
`prewarmGpuResources` still renders to the canvas.

`target.texture.internalFormat = 'RGBA8'` is required alongside it: an XR
target's multisample renderbuffer is allocated RGBA8 (the shader does the sRGB
encode itself) while the resolve texture would otherwise pick `SRGB8_ALPHA8`
from its colour space — `glBlitFramebuffer` refuses to resolve mismatched
formats and **every frame lands black**.

MSAA moved off the canvas and into the buffer (`samples: 4` desktop, `0` touch);
without it the one-pixel lamp posts and rail lines start crawling.

## 2 · Player body paint — `js/car-paint.js` + `carModels[target].paint`

### Why the old workflow was broken

A car body is never one material:

* the PSX pack maps several OBJ groups onto one shared `psxBody` material;
* a Modeler replacement splits the same body across as many mesh parts as the
  document vertex limit needs — the user's `custom:0038` (Japan Sedan) carries
  the body in **two** parts, each with its own `psxBody` face;
* `faceMaterial()` resolves `style.color || part.color`, so a face imported with
  a colour (every face of a converted car) silently beats the per-part
  **Base colour** picker.

Net effect when the user tried to paint the car: the picker looked dead on one
chunk, worked on the other, and a "pure black wallpaper" JPG had been stretched
over `psxTrim`/`psxHeadlight` of chunk 2 as a workaround.

### What replaced it

`carModels['player:<id>'].paint = { color, metallic, gloss }` — one
authoritative record per car, validated in `customAssetsDocumentErrors`,
normalized by `carPaintSettings()` (returns **null** when absent, so unpainted
cars stay byte-identical), and applied by `applyCarPaint(root, paint)` as a pass
over the finished visual. It repaints every material matching
`(^|:)(psxbody|body|carrozzeria)$` — the PSX name and the custom-asset
`custom:mesh:psxBody` name alike — sharing one new material per original so
merged draw calls survive. Textured body faces are skipped (a livery is never
tinted).

Flat paint stays `MeshLambertMaterial`. Any metallic/gloss switches to
`MeshPhysicalMaterial` with smooth normals, a coloured base coat, metallic
flake, low roughness, and a separate clear coat. A compact generated
night/garage panorama supplies broad warm and cool reflections in every scene:
without something to reflect, even a physically glossy material reads as matte.
The paint no longer darkens the selected colour or fakes visibility with
self-illumination.

Applied in `game.loadCustomCar()` **before** `compileAsync`, so the painted
material is the one prewarmed; and in `modeler-panel._buildCarPreview()` plus
`_repaintCarPreview()` (in-place, because a full rebuild re-parses the OBJ).

Player scope only — the live traffic fleet is deliberately one high-visibility
colour driven by its own emissive floor (see `js/traffic.js`).

### Body image (livery wrap) — July 2026

`paint.texture` names one entry of the document's texture library and wraps it
over the **whole** bodywork. This is the fix for "I tried putting an image on
the car and it does not land properly on all of the body": an image attached in
*Faces & textures* is fitted per face, so a body split across several mesh parts
receives a complete, differently-cropped copy on each of them.

`applyCarPaint()` instead projects **one** coordinate set from the union
bounding box of every body mesh, in the car's own space, and writes it to a
separate `uv1` attribute (`map.channel = 1`) so the stock UVs survive and
removing the wrap needs no geometry rebuild. Each vertex is mapped by its
dominant normal — flanks take length × height, roof and bonnet length × width,
nose and tail width × height — and the mirrored axis is flipped so the picture
does not read backwards on one side of the car. Two consequences worth knowing:

* one copy covers a whole flank **across** the parts it is cut into (a front
  half and a rear half get `u ∈ [0, 0.5]` and `[0.5, 1]`, not `[0, 1]` each);
* because the flanks run in opposite directions, the same image region sits at
  opposite ends of the two sides. That is the cost of non-mirrored artwork from
  a single image, and it is the right default for a wrap.

Two extra fields appear only when there is an image: **Image scale** (repeats
across the car) and **Tint by paint colour**. The base colour is lifted to white
by default because three.js multiplies `map` by `color` — a blue base coat would
otherwise turn every livery blue; `wrapTint` dials the paint colour back in.

With a wrap, body faces carrying their own image **are** replaced (a body-wide
image is exactly the instruction to stop honouring the per-face patchwork).
Without one, they are still left alone. Wrap materials are tagged
`userData.hesiCarWrap` so a later repaint can tell its own work from a
hand-attached livery — without that tag the wrap could never be removed.

Deleting a texture that a car is wearing clears the reference (a dangling id
fails `customAssetsDocumentErrors`).

### Editor UI

* **Cars tab → Body paint**: colour + Metallic flake + Clear-coat gloss sliders,
  live on `input` and deliberately **without** re-rendering the panel (a
  re-render tears out the slider under the pointer mid-drag), plus a **Body
  image** row (add / change / remove, from the texture library) and
  *Remove paint*.
* **Faces & textures** rows gained a per-face colour picker — the generic fix
  for "the colour picker does nothing" on any imported asset.
* The **Base colour** row now names how many faces of the part override it.

### Shipped state

`data/editor/custom-assets.json` sets `player:JapanSedan` to
`#1b3fa8 / metallic 0.78 / gloss 0.5` — blue metallic, the requested target.
Change or clear it from the Modeler.

**Known leftover, not touched:** `custom:0038` part "Plane 2" still has
`tex:0157` (a pure-black wallpaper JPG) stretched over its `psxTrim` and
`psxHeadlight` faces, from the old workaround. It makes half the trim and half
the headlight lenses black. Clear it per face in Faces & textures.

## Verification

```bash
node .devtests/vhs-car-paint-probe.mjs
```

23/23 — pass active on boot, buffer sized to the canvas, frame is a real
picture, toggle off/on releases and re-allocates, artifacts visible
(1.7/255 mean channel delta) but subtle (5.5 % exposure), **pure passthrough at
`amount 0` (0.00 % delta — the guard against the offscreen buffer changing the
look)**, the saved paint reaches the car at boot, every body slot becomes one
physical metallic/clear-coat material with an environment map, glass/lamps/
wheels untouched, no console errors.

```bash
node .devtests/car-body-wrap-probe.mjs
```

26/26, headless (no browser) — builds a body deliberately cut into a front and
a rear half plus a leftover per-face image, and asserts the wrap covers all of
it with one shared projection: both halves get complementary slices that meet
at the seam, all parts share one texture upload, glass is untouched, Image
scale tiles, removing the image restores plain paint and drops the projection,
an id pointing at a deleted image degrades to plain paint, and metallic/gloss
produce one physical clear-coat material on every body part. The final two
checks prove nearby fixture data reaches every body coat's live shader uniforms.

```bash
node tools/hesi-editor/.devtests/car-paint-panel-probe.mjs   # server on :8081
```

9/9 — controls render, write through to the document, repaint every preview
body slot in place, sliders survive their own input handler, a body image
reaches every preview body slot, the wrap controls appear only with an image,
and removing it goes back to plain paint.

Regression suites re-run clean: editor `npm test` 151 unit + 8 server,
`node tools/hesi-editor/.devtests/ui-audit.mjs` ALL CLEAN.

---

## Round 2 (2026-07-27) — VHS level dial + speed blur

Both live in the same pass and both are driven from the dev panel (`0` →
**IMMAGINE & LUCI**). The tape look was previously all-or-nothing (`settings.vhs`
on/off at a hardcoded amount of 1).

**VHS level** — `admin.vhsAmount`, slider `debug-vhs-amount` (0…2×). Feeds
`VHSEffect.setAmount()`. `setAmount` no longer writes the uniform directly: the
amount is stored on the instance and the uniform is `enabled ? amount : 0`, so
the on/off setting and the level are independent and neither loses the other's
value.

**Speed blur** — `admin.motionBlur`, slider `debug-motion-blur` (0…200%). Four
taps pulled toward the centre of the frame, weighted down with distance:

- The reach is `uSpeedBlur × smoothstep(0.10, 0.62, |uv − 0.5|)`, so it is **zero
  in the middle of the picture** and only opens up at the edges. The car, the
  road ahead and the traffic you are about to hit stay sharp; the rails and the
  city smear past. That is also why this does not reintroduce the "onde" problem
  that killed the old wobble: every tap is on the same radial line as the pixel
  it belongs to, so nothing bends.
- Speed ramp is `((kmh − 120) / 140)²` capped at `MAX_SPEED_BLUR = 0.09`, times
  the slider. Nothing at all below 120 km/h.
- `game.updateSpeedBlur()` is called from `updateDriving`, and `render()` forces
  it to zero outside driving, so the garage, the PA and the menus are never
  blurred.

**The pass now runs for the blur alone.** `active()` is
`supported && (enabled || uSpeedBlur > 0)`, and dropping the blur back to zero
with the tape look off releases the buffer exactly as toggling VHS off does.
This is the risky part — an offscreen buffer that resolves wrong renders every
frame black (see the `RGBA8` note in section 1) — so the probe covers it.

Verified: `node .devtests/vhs-car-paint-probe.mjs` → **20/20**. New checks: the
level slider reaches both the instance and the uniform, the headlight multiplier
scales the live beam, and with VHS off + blur held open the pass stays active,
keeps its buffer, still presents a real picture and does not shift exposure
(0.5%). `.devtests/shots/vhs-speed-blur.png` shows the sharp centre / smeared
edges.

---

## Round 3 (2026-07-27) — the two dials get headroom

Both caps were tasteful and both were in the way. `MAX_VHS_AMOUNT = 4` and
`MAX_MOTION_BLUR_LEVEL = 4` now live in `js/vhs-effect.js`; the sliders read
`0…4×` and `0…400%` and every clamp on the path — the constructor, `setAmount`,
`setVisualParam`, `updateSpeedBlur` — reads those constants instead of a
hardcoded `2`.

**The blur cap needed a second fix to mean anything.** `setSpeedBlur` clamped
its argument to `MAX_SPEED_BLUR` (0.09), which is the smear at the *100%*
setting — so above 100% the dial did nothing at all at top speed (level × ramp²
× 0.09 was already at the ceiling by ~220 km/h) and only affected the ramp's
lower half. The ceiling is now `MAX_SPEED_BLUR_CEILING = MAX_SPEED_BLUR ×
MAX_MOTION_BLUR_LEVEL`, so the range of the dial and the range of the clamp are
the same thing. `MAX_SPEED_BLUR` keeps its meaning as the authored 100% value.

Above ~2× the frame is deliberately past tasteful; that is the point of the
headroom, not a bug to be tuned back out.

---

## Round 4 (2026-07-27) — paint reflects the actual road lamps

The first physical-paint pass had a correct clear coat but relied too heavily
on one generic environment map, so at high settings the car read like a jewel
while the street lamps appeared to slide past without affecting it. The road
fixtures are emissive meshes plus baked additive pools, not Three.js lights,
so a standard physical material could not receive them.

`HighwayMap` now retains a compact chunked index of the real sodium, white, and
tunnel fixture positions. Each driving frame queries only the current and
adjacent 600 m chunks and returns the nearest two fixtures. Their world
positions, live configured colours, ranges, and strengths feed two analytic
direct lights injected into the player paint shader. They run through Three's
physical `RE_Direct`, including the clear coat, but exist only on the player
body: no PointLights and no extra per-fragment loop on the road, buildings, or
traffic.

The generic environment contribution was reduced from 2.15 to 1.05 at maximum,
metalness from 0.42 to 0.28, and maximum-gloss roughness broadened to 0.10 /
0.05 for base/clear coat. The car now keeps a restrained automotive finish
between lamps and receives a visible warm highlight that moves across the roof,
edges, and panels as each real fixture passes.

Verified in Chromium: **23/23**, including two real sodium fixtures detected
15.1 m and 30.9 m from the player and both 52 m ranges present on every body
coat; no shader compile or console errors. Headless material/wrap probe:
**26/26**.
