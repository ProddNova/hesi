# Road barriers — status

Lateral (road-edge) barriers used to be one hard-coded profile everywhere: a
low capped concrete parapet with a steel handrail, drawn inline in
`js/map.js _buildRouteGeometry`. This checkpoint turns that into a catalogue
plus a per-road / per-side / per-chainage addressing scheme, and applies the
tall Shutoko screen wall to Ramp 8.

## What shipped

**Style catalogue — `js/road-barrier-styles.js`**

| id | label | height | body surface slot | notes |
| --- | --- | --- | --- | --- |
| `parapet` | Parapet (default) | 1.15 m | `barrier` | the shipped profile; drawn by the original code path |
| `shutokoTall` | Tall screen wall (Shutoko) | 3.45 m | `barrierScreen` | concrete kerb + ribbed screen + capping beam + posts |
| `meshScreen` | Parapet + anti-throw screen | 3.0 m | `barrierMesh` | parapet with a slim mesh screen above |
| `soundWall` | Sound wall | 4.85 m | `barrierSound` | solid acoustic wall |
| `jersey` | Jersey barrier | 1.0 m | `barrierJersey` | bare jersey profile, no handrail |
| `guardrail` | Open guardrail | 0.9 m | `barrierRail` | W-beam on posts, open underneath |
| `none` | No barrier (open edge) | — | — | removes the VISUAL only; collision is kept |

A style is **one continuous cross-section** swept along the edge — up the
road-side face, over the top, back down the outer face — so a wall is a single
solid piece, not parallel sheets that would take a painted texture twice.
Laterals are **insets from the drawn surface edge**, not absolute offsets, so a
style rides correctly over lay-by bulges and progressive-merge envelopes at any
carriageway width. Everything is emitted as **merged chunk quads** (`_pushQuad`
/ `_pushBox`) — never `_instance` — so no style can shift the (mesh, index)
addresses the editor's saved build operations use.

### Texturing (why the UVs are baked, not projected)

Profile points are `[inset, height, v]`. `v` is **authored**, and `u` is world
chainage along the route, both baked in `_emitStyledBarrierSegment` at
`ROAD_TEXTURE_TILE_METERS` — the same tile units the projections use, so the
Surfaces app's metres-per-tile still applies on top.

The styled-barrier slots are therefore deliberately **absent** from
`WALL_UV_SURFACE_MATERIAL_NAMES`. That projection groups vertices into
connected components and re-fits the image to each component's own foot and
top; merged chunk quads share no vertices, so every segment became its own
component and re-anchored the picture to its own lowest corner — on a graded
ramp that reads as a **staircase**. Baked UVs make a run continuous across
every joint regardless of grade or terminal taper. A probe check enforces that
the projection never reclaims these slots.

**Addressing — `data/road-barriers.json` (+ generated `data/road-barriers.js`)**

```json
{ "version": 1,
  "routes": { "ramp_8": [ { "side": "both", "start": 0, "end": null, "style": "shutokoTall" } ] } }
```

### Which Surfaces slot is which

**One style = one paintable slot.** Everything a style draws (kerb, panels,
posts, capping beam) sits on that style's own material, registered in
`WORLD_SURFACES` (`js/custom-assets.js`) under *Barriers & rails*, so a slot
means exactly what its name says.

| Surfaces entry | material | what it actually is |
| --- | --- | --- |
| **Concrete barriers** | `barrier` | **the default low parapet — the muretti along every road in the map**, plus its end caps, the dead-end cap and the Tatsumi deck edge |
| **Guardrails** | `railMetal` | the steel handrail on top of that default parapet |
| **Concrete (pillars & lamp posts)** | `concrete` | pillars, lamp masts, and the central median jersey on two-way routes |
| **Tall screen wall** | `barrierScreen` | the whole `shutokoTall` wall (Ramp 8) |
| **Sound wall** | `barrierSound` | the whole `soundWall` |
| **Anti-throw screen** | `barrierMesh` | only the screen + posts of `meshScreen` |
| **Jersey barrier (road edge)** | `barrierJersey` | the whole `jersey` road-edge style (NOT the central median) |
| **Open guardrail beam** | `barrierRail` | the whole `guardrail` style |

`meshScreen` is the one deliberate exception to the rule: it *is* the default
parapet with a screen bolted on, so its base stays on `barrier` and its
handrail on `railMetal` — retexturing the normal parapets carries it along.
A probe check enforces the rule for every other style.

The new slots are in `WALL_UV_SURFACE_MATERIAL_NAMES`, so they get the upright
wall projection (image stands full height and repeats along the run), not the
planar one.

- `side`: `"both" | "left" | "right"` — left/right relative to travel direction
  (map.js side signs: `+1` = right, `-1` = left).
- `start` / `end`: metres of chainage along the one-way carriageway. Spans are
  independent of route segments — a 30 m patch inside a 1.2 km ramp is one row.
  `end: null` means "to the end of the route".
- Spans are applied **in order and later spans repaint earlier ones**, so the
  natural authoring pattern is "full-length coat first, then patches". The
  flattener (`flattenBarrierSpans`) punches earlier intervals out rather than
  layering them, so the resolved edge is always a clean, sorted partition.
- `heightScale` (optional, 0.4–3, default 1): the same style, taller or
  shorter. It scales sheet heights and post height/base but **not** insets — a
  taller wall stands in the same footprint instead of leaning further into the
  carriageway — and it scales the collision height with the visual. Omitted
  from the saved file when 1. Out-of-range values are rejected, not clamped.
- Anything not covered falls back to `parapet`.

**Runtime** — `js/map.js` imports the document statically (barrier geometry is
baked while the world is generated, so it cannot be patched by
`editor-map-patch` afterwards). `options.roadBarriers` overrides it for probes
and previews. A malformed document degrades to "no overrides" with a console
warning instead of failing world construction. `wallSegments` collision height
follows the style, so a screen wall is as solid as it looks.

**Editor — Barriers app** (bottom tab + "Barriers" button in the World look
toolbar group)

- Road picker with a text filter; "Use road selected in viewport" targets
  whatever road is open for centreline editing.
- Span rows: side / from / to / style / `×h` height multiplier, reorder
  (↑ ↓ = paint order), remove. Hovering a height field or a resolved chip shows
  the resulting metres.
- "Resolved edge" summary per side, so paint order is never guesswork.
- A viewport overlay draws the authored spans as coloured ladders at each edge
  (one colour per style, height = the style's own height).
- **Save barriers** writes `data/road-barriers.json` + `.js` through
  `/__hesi_editor_barriers`. There is no draft/publish split and Apply to Game
  is not involved — barrier styles are pure look with their own files.
- **Reload editor preview** reloads the page: the world bakes barrier geometry
  at generation time, so the viewport needs a rebuild to show a saved change.

## Ramp 8

`ramp_8` (the 1206 m Tatsumi approach the player spawns on) is walled on
**both** sides with `shutokoTall` for its full length — the walled-ramp look
from the reference photo. Collision follows at 3.35 m. To go taller still, set
the span's `×h` field in the Barriers app rather than editing the catalogue.

## Verification

| probe | result |
| --- | --- |
| `node .devtests/road-barrier-probe.mjs` | PASS (25 checks) — resolver, overlap/patch semantics, height multiplier through to collision, one-slot-per-style, tall wall is a single sheet with no posts, wall `v` has 6 distinct authored values (per-quad refitting could only ever give 2) spanning 0→1, `u` running 0.7→94.6 tiles along the route, ramp_8 peaking at +3.95 m, collision 3.35 m on 222/222 segments, and an explicit-`parapet` world byte-identical to the no-override baseline |
| `node .devtests/guardrail-probe.mjs` | PASS — runs=218, unexplained gaps=0, doubled=0, insideAsphalt=0 |
| `node .devtests/editor-build-ops-probe.mjs` | 96/101 on target — the same 5 pre-existing Tatsumi-deck drifts as before, no new drift |
| `node tools/hesi-editor/.devtests/barriers-panel-probe.mjs` | PASS — panel renders, saved span loads, a left-only 300–340 m patch splits the left edge into three and leaves the right edge whole, overlay drawn, all five new slots listed in Surfaces, no console errors |
| `node .devtests/ramp8-barrier-shots.mjs` | screenshot at `.devtests/shots/ramp8-barrier-chase.png` — tall walls both sides on Ramp 8, from the player's chase camera |
| `node .devtests/barrier-texture-shots.mjs [--route ramp_8]` | close exterior shots from the editor's free camera with the project's real texture applied — the angle tiling and seams are actually judged from |

The editor probes need the dev server (`node tools/hesi-editor/server.mjs`);
both accept `--port` for a spare instance.

## Notes / follow-ups

- **The dev server must be restarted** to pick up `/__hesi_editor_barriers`.
- No live preview of a barrier change inside the editor viewport without a
  page reload. Rebuilding `HighwayMap` in place would give one, but the
  editor's map rebuild path is already known-shaky (see the Wangan
  "Apply to Game doesn't update the road" note) — deliberately not touched.
- `none` keeps collision on purpose. If a genuinely open edge is ever wanted,
  that needs a separate `collision: false` flag and a look at what happens when
  a car leaves the deck.
- The five new material slots are additive: they only ever create chunk meshes
  where a styled span exists, and a new mesh NAME cannot shift the
  `(name, nameIndex)` counters of existing names, so saved editor object
  operations are unaffected (confirmed by the build-ops probe).
