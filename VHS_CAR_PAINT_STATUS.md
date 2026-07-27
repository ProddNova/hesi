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
`MeshPhongMaterial` with flat shading: the highlight breaks across facets, which
is what reads as *metallizzato* on a low-poly car under sodium lamps. Metallic
also darkens the base coat and adds ~5 % self-illumination so a dark body does
not go pure black between lamps.

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

15/15 — pass active on boot, buffer sized to the canvas, frame is a real
picture, toggle off/on releases and re-allocates, artifacts visible
(1.7/255 mean channel delta) but subtle (5.5 % exposure), **pure passthrough at
`amount 0` (0.00 % delta — the guard against the offscreen buffer changing the
look)**, the saved paint reaches the car at boot, every body slot becomes one
metallic colour, glass/lamps/wheels untouched, no console errors.

```bash
node .devtests/car-body-wrap-probe.mjs
```

22/22, headless (no browser) — builds a body deliberately cut into a front and
a rear half plus a leftover per-face image, and asserts the wrap covers all of
it with one shared projection: both halves get complementary slices that meet
at the seam, all parts share one texture upload, glass is untouched, Image
scale tiles, removing the image restores plain paint and drops the projection,
and an id pointing at a deleted image degrades to plain paint.

```bash
node tools/hesi-editor/.devtests/car-paint-panel-probe.mjs   # server on :8081
```

9/9 — controls render, write through to the document, repaint every preview
body slot in place, sliders survive their own input handler, a body image
reaches every preview body slot, the wrap controls appear only with an image,
and removing it goes back to plain paint.

Regression suites re-run clean: editor `npm test` 151 unit + 8 server,
`node tools/hesi-editor/.devtests/ui-audit.mjs` ALL CLEAN.
