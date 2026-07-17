# PS2 VISUAL OVERHAUL — STATUS

Branch: `claude/full-ps2-style-overhaul-8uy7p7`
Target: coherent late-PS2 / early-2000s Japanese racing-game presentation
(GT4 / NFSU2 / MC2 era) via **textures, materials, assets and restrained
lighting** — explicitly NOT the previous neon/glow/decal direction.

---

## CHECKPOINT 1 — AUDIT (complete)

### Baseline capture

- `.devtests/ps2-style-shots.mjs` (new, committed) captures 12 deterministic
  views + renderer metrics. Baseline run: `.devtests/shots/PS2-*-baseline.png`
  (shots dir is gitignored; script is reproducible from any commit).
- Baseline metrics (chase view, 960×540@2x, headless SwiftShader):
  - draw calls **182**, triangles **63.6k**, geometries 209, **13 textures**,
    23 programs. Frame times in headless are software-rendered and only
    useful relative to each other.

### How the world is built (what we must work with)

- `js/map.js` (~8.3k lines) builds everything statically at boot into
  ~`CHUNK`-sized groups: merged `BufferGeometry` per chunk **per material
  name** (`_bucket`/`_pushQuad`, UV support already present but road/barrier
  quads currently push default `[0,0,1,1]` UVs), plus per-chunk
  `InstancedMesh` pools (`_instance`, `box:material` / `lamppost:concrete` /
  `pool:lightPool` types). Chunk visibility streams around the player.
  **This is a great PS2-friendly base: we can keep the entire pipeline and
  swap flat colors for small CanvasTextures + real UVs.**
- Physics/collision/markings are derived from analytic route frames —
  completely independent of visuals as long as we do not touch
  `_frameAt`/`_paintStrip` inputs, wallSegments, or route geometry.

### What breaks the PS2 illusion today (worst first)

1. **Zero surface texture anywhere.** Road (`road` = flat 0x14171f Lambert),
   barriers, concrete, tunnel walls, fascia — all untextured flat colors.
   At night this reads as vector graphics, not a textured game world.
2. **Garage is a near-black empty box** with a handful of primitive-colored
   boxes (bench, PC, drum). No floor/wall texture, no shelving/clutter, no
   workshop identity. Spawning here sets the wrong tone for the whole game.
3. **Buildings are pure emissive window grids.** The facade CanvasTexture has
   no wall tone, banding, or structure — towers read as floating LED panels
   (accidentally "cyber"), not concrete buildings with lit windows.
4. **Light pools/streaks are big additive decals** under every lamp
   (11×15 m pools + 30 m streaks). This is exactly the "circular light
   decals" the brief bans. They also wash the road out around lamps.
5. **Parked cars / props are single flat-colored boxes** (Daikoku lot reads
   as colored LEGO). No trucks/vans/forklifts/pallets; PA feels placeholder.
6. **HUD/UI is modern web** (skewed flex panels, glows, thin monospace,
   giant anti-aliased numerals). Nothing early-2000s about it.
7. **No mid-ground density**: outside the C1 canyon there are large black
   gaps between the road and the skyline; K1/Wangan roadside is sparse.
8. **Sky is featureless pure black**, no horizon gradient/low haze band, so
   unlit areas have no silhouette contrast at all.

### What can be retained

- Chunk/bucket/instancing pipeline, quality system (`low/medium/high`),
  route-frame road builder, marking painter (readable markings), traffic
  merged-geometry vehicles (good shapes, just flat), sign canvas generator
  (already period-correct look), fog + dark night direction (correct,
  just needs tuning), minimap, all gameplay.

### Rebuild plan (visual only)

- **Texture atlas module** (new `js/textures.js`): small shared
  CanvasTextures (64–256 px), nearest/low-filtered, baked shading:
  asphalt, shoulder/service concrete, parapet/jersey barrier, pillar
  concrete, tunnel panel wall, retaining wall, building facade atlases
  (office/residential/hotel/industrial with real wall tone), shutter,
  garage floor/walls, prop atlas (containers, cabinets, vending, pallets),
  vehicle-side atlases for parked cars/trucks.
- **UV-mapped road/barrier emit**: pass distance/lateral-based UVs in
  `_buildRouteGeometry` deck + parapet quads so textures tile in metres.
- **Lighting**: kill the giant additive pools/streaks (replace with small,
  dim, few); keep sodium lamps as small emissive heads; slightly raise
  material albedo to compensate; keep night dark; add subtle horizon band.
- **Density**: cheap facade-card rows + low warehouse/apartment blocks along
  Wangan/K1 gaps; more container/prop clutter near port; parked trucks/vans
  built from 2–3 textured boxes sharing one atlas.
- **Garage**: full retexture + shelving, tool cabinets, tire stacks, drums,
  pallets, posters, cables — all boxes/cylinders with baked-texture faces.
- **HUD/UI**: restyle styles.css toward flat early-2000s console look:
  chunky italic display numerals, hard edges, limited palette, simple
  gradients, no glows/skews; PC/phone reskin in the same language.

### Cost control

- All new textures are generated CanvasTextures (no downloads, few KB).
- No new lights (the only real-time lights stay: hemisphere+ambient+moon,
  headlights, garage fixtures, one garage-entrance beacon).
- Draw calls should stay ~flat: same buckets, same instancing; new props ride
  existing instanced types or new shared types (one mesh per chunk per type).
- Low quality keeps hiding effect layers; texture sizes stay ≤256 px.

## CHECKPOINT 2 — STYLE SLICE (complete)

**Art direction locked: stylized pixel tiles, not realism.** After a course
correction (first attempt had realistic cracks/patches — rejected), every
world texture is now generated as a 16-32 texel grid with a posterized
grey palette (tones spaced ±0.03-0.05 around the base), upscaled nearest
then softened one pixel — "pixelated, then lightly blurred".

- `js/textures.js` — shared tile set: asphalt, ramp asphalt, shoulder,
  service slabs, barrier/wall concrete, pillar concrete, tunnel panels,
  container siding, sky gradient. All 64-128 px canvases.
- Asphalt candidates A (16 texels / 3 tones), B (24/4), C (32/5) rendered
  in-game via `?asphaltStyle=` and compared with
  `.devtests/ps2-texture-candidates.mjs` (shots `PS2-cand-*`).
  **A chosen** — visible soft-edged texel blocks at driving distance,
  exactly the coarse blocky brief; B/C read as smooth clouds. A is the
  default; B/C remain selectable for reference.
- World-projected metre UVs for merged geometry (`_assignWorldUVs` +
  `WORLD_UV_TILES`): decks, fascia, parapets, medians, mouth surfaces and
  tunnel walls all tile in world units with no per-site UV code.
- Shoulder band: paler pixel-asphalt strip painted outside each edge line
  through the same junction-zone suppression as the edge line itself
  (excluded from marking instrumentation; A/B probe passes).
- Facades: rewritten to wall-with-windows in the same pixel language
  (drawn half-res, upscaled; posterized window palette; spandrels, seams,
  balcony bands; no grime streaks).
- Light decals restrained: pools 11×15.5 m @0.34 → 6.2×8.8 m @0.15,
  streaks 30 m @0.26 → 19 m @0.11.
- Horizon dome (gradient cylinder, 1 draw call) + slightly desaturated
  night lights; night stays dark navy.

Slice shots: `PS2-*-slice.png` vs `PS2-*-baseline.png`. Draw calls 177
(baseline 182), textures 20 (13).

## CHECKPOINT 3 — WORLD FOUNDATION (complete)

- Service-area decks: slab body keeps dark fascia sides; the walkable top
  is now a world-UV bucket quad with metre-tiled slab concrete (Daikoku /
  Tatsumi lots read as real PA surface, not one stretched texture).
- Garage exterior + konbini buildings: horizontal-band siding texture
  (stretch-safe on instanced unit boxes). Roller-shutter slat texture on
  the workshop door.
- Containers: corrugated pixel siding × brightened instance tints.
- Gas canopy dimmed; broadcast tower toned down.
- Verified across Wangan/C1/K1/tunnel/PA views (`PS2-*-foundation.png`),
  draw calls 181 (baseline 182).

## CHECKPOINT 4 — CITY DENSITY + PROPS (complete)

- Shared prop language (`_emitParkedCar/Truck/Forklift/PalletStack/Drums`):
  every prop is a few instanced primitives on shared materials. New unit
  geometries: raked car glasshouse, 8-sided drum.
- Parked cars everywhere get body + glasshouse + four wheel blocks;
  Daikoku adds a five-truck row (corrugated cargo boxes), forklift,
  pallet stacks and drums.
- Port container yards get working aprons: trucks, forklifts, pallets,
  drums beside the stacks.
- K1: shed density up (skip 0.26→0.18), loading aprons with clutter at
  shed fronts, second backdrop row of apartment blocks.
- Wangan: mid-distance apartment/office silhouettes on the land side;
  two new skyline clusters (Oi wharf, Shinagawa bank).
- Draw calls 203 (baseline 182) — the removed giant light decals offset
  most of the prop cost. Probes pass.

## CHECKPOINT 5 — GARAGE (complete)

- `createGarageTextures` (textures.js): whole-room pixel floor with slab
  joints, painted work bay and shutter scuff lanes; block wall courses
  with plinth + faded banner stripe; slat shutter; cardboard crate tile;
  three low-res posters (Gekko Tires, Wangan Night, 安全第一).
- Five steel shelving units with instanced crate clutter (34 crates, one
  draw call), instanced tire stacks, drums, bench shelf with paint cans,
  ceiling cable trays with drop conduits, extra NO SMOKING sign.
- Point lights reduced 9 → 5 (alternating fixtures, slightly stronger);
  fixture tubes stay emissive. GridHelper and per-slat meshes removed.
- All interaction points/clearances untouched (PC, exit, delivery zone,
  car footprint, walk clamps).

## CHECKPOINT 6 — HUD/UI (pending)

## CHECKPOINT 7 — PERF + CONSISTENCY (pending)

---

**Status: Checkpoint 2 complete — pixel-tile art direction validated on
the slice (candidate A). Next action: propagate to remaining surfaces
(Checkpoint 3), then density/props.**
