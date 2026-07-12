# Shutoko Rebuild — Map, Dressing, Traffic, Physics, Garage (2026-07-12)

## What was built

**Map (js/map.js, full rewrite).** A scaled, topologically faithful Shutoko:

- **C1 Inner Loop** — 14.6 km irregular loop (radius 1.9–2.5 km) around (0,0),
  2 lanes/direction at level E (+8…+16 m) through a building canyon, with the
  curved **Yaesu tunnel** (T, −15 m, white lighting) on the NE arc. Junction
  nodes at N / E / S / W; the W node has the signed-closed stub ramp
  (通行止 board, crash cushions, capped wall).
- **Route 11 + Rainbow Bridge** — spur from C1-S (Shibaura JCT) over open
  water on an H-level suspension deck: two white towers with red blinkers,
  sagging catenary cables, vertical hangers, light chain.
- **Wangan / Bayshore** — 31 km, 3 lanes/direction backbone from Tatsumi to
  Daikoku along the bay: port cranes, container stacks and warehouses on the
  land side, open water + lit skyline on the bay side, and the ~3 km
  **Tokyo Port Tunnel** (T, orange lighting, gentle dip — the top-speed run).
- **Route 9 Fukagawa** — Tatsumi → C1-E continuation with an H-level river
  flyover and a grade-separated Hakozaki-style pair of ramps at C1-E.
- **K1 Yokohane** — Oi → Daikoku over industrial suburbs (low sheds, canals'
  worth of dark ground, smokestacks with blinking reds), Heiwajima PA midway.
- **Daikoku JCT + PA** — multi-level stack: arrivals at E, the JCT turn at H,
  a **360° spiral** descending to the ground-level PA, and an S-level (+36 m)
  U-turn flyover crossing the whole junction. The PA is the packed meet:
  painted stalls, ~34 static JDM boxes (some hoods open), gas-station canopy
  with pumps, glowing **7-HEAVEN** konbini, vending machines, sodium lights,
  fences.
- **Four PAs** (Shibaura + garage, Tatsumi, Heiwajima, Daikoku) with blue "P"
  boards at 500/300/100 m, deceleration/acceleration lanes, dressed lots.
  Score banking, refuel and the garage entrance all reconnected; the player
  spawns at Shibaura PA where Wangan Works lives.

**Construction rules enforced (and tested):**

- Carriageways never cross at grade — connectivity is a directed edge list
  (diverge / merge / continuation) and every crossing is separated by the
  T/G/E/H/S elevation levels. `network-test.mjs` scans all route pairs: 0
  illegal overlaps.
- Collision is the **union of route corridors** (+ PA lots): a point is
  drivable iff at least one corridor at a matching elevation accepts it, so
  barriers are continuous everywhere, junction gores seal themselves, and
  walls can never be "disabled". A swept resolver probes every ≤1.5 m; a
  400-trial barrage of up to 400 km/h escape attempts produces 0 escapes and
  0 stuck-in-wall states.
- Left-hand traffic: direction +1 lanes sit left of the centreline, lane 0 at
  the median, exits/merges peel off on the outer (left) edge — which is what
  makes the geometry work without crossings, and what fixed the blinkers.
- The grand tour (C1 lap → R11 → bridge → Wangan W → Daikoku → K1 → Oi →
  Wangan E → Tatsumi → R9 → C1) is 74.8 km ≈ **32 min at 140 km/h**; total
  network 90.5 km including ramps/PA lanes.
- **Streaming:** world geometry is baked once into 600 m chunks (merged
  meshes + per-chunk instancing) and toggled by distance (1.5 km radius,
  fully fog-covered). Measured on the driving scene: **145 draw calls /
  34 k triangles** at default traffic, **175 calls** at 3× — comfortable for
  iPhone Safari.

**Traffic (js/traffic.js, surgical).**

- Blinker side now matches the actual lane-change direction —
  `indicator-test.mjs` verifies lamp world-side == movement side for both
  carriageways and both deltas.
- Route hand-offs (ramps, merges, continuations, the 3→2 lane taper at
  Tatsumi) blend the lateral jump over ~1.5 s; cars funnel out of
  disappearing lanes before narrower continuations; AI takes ramp diverges
  from the outermost lane with per-vehicle seeded probability.
- Spawn/despawn pooling unchanged (850 m/1100 m around the player only).
- Default density raised: 44 cars (touch) / 56 (desktop), pool 84; the phone
  **admin panel has a TRAFFIC DENSITY 0.5×–3× control**, persisted with the
  save and applied on boot.
- Car meshes rebaked with vertex colors: 5 draw calls per car (was ~9).

**Physics (js/physics.js + game.js wiring, surgical).**

1. *60 km/h slide fixed:* steering authority was 1.15× the grip-limited
   angle — every full press exceeded the tires on purpose. Now capped at
   0.88× + slip allowance with a ~0.26 s ramp: full press at 60/100 km/h
   corners at ~0.9 g with rear saturation < 1.0 (no drift), flicks settle
   straight, 160 km/h full lock stays a progressive, catchable slide
   (`grip-test.mjs`).
2. *Tunneling fixed:* game.js hands physics a live road adapter; every
   120 Hz substep sweeps the corridor union (CCD), so barriers are solid at
   any speed on every road, ramp, tunnel and bridge. The frame-level sweep
   remains as a failsafe.
3. *Stuck-in-guardrail fixed:* the old code re-applied a stale penetration
   correction every substep, ramming cars into rails. Substeps now read
   fresh geometry and penetration resolves along the surface normal — the
   escape barrage ends free and controllable every time; R-reset still
   recovers as the last resort.
4. Fixed 120 Hz substepping and post-impact yaw damping verified against the
   new barriers (spin-test unchanged and passing). Wall contacts resolved
   inside physics now surface as events so scrape/impact scoring still works.

**Garage (js/garage.js).** Room shell rebuilt with explicit clearances: real
front wall around the shutter opening, beams pulled proud of walls, slats/
panels/stripes at distinct depths — no coplanar faces. Every interaction
point (car spot, workbench, delivery zone, PC desk, exit) is unchanged.

**UI.** Minimap + phone map now render north-up (the network reads as the
actual Shutoko silhouette); player arrow recalibrated; admin slider added.

## What was cut / simplified (fallback order: nothing from the route list)

All six blueprint stages were built. Simplifications, smallest-impact first:

- **Junction movement sets are minimal but complete for the tour:** each spur
  junction provides one off-ramp and one merge per direction pair (e.g. there
  is no R11 → Wangan-east movement; U-turn at Daikoku covers the gap). Real
  Shutoko junctions also lack movements, and every carriageway end connects
  somewhere — no dead ends except the signed stub.
- **Daikoku PA has one entrance** (spiral, from the Wangan-west direction)
  and one exit; arriving from K1 you take the S-deck U-turn first.
- C1 has one tunnel (Yaesu) rather than three; blueprint required one.
- AI traffic doesn't enter PA lots (by design, as before).
- Deck banking is subtle (≤4.3°) and its height effect is approximated at
  the car's lateral position; no roll of the car mesh with the deck.
- No water reflections (fog range would hide them); the "distant skyline" is
  placed near enough to read through the PSX fog instead.

## Known limitations

- AI cars still teleport up to ~7 m laterally at route hand-offs; the 1.5 s
  blend hides it, but a sharp eye at a gore may catch a glide.
- The HUD route label can briefly show the ramp name where corridors overlap.
- World geometry builds at load (~1–2 s extra on a phone, once, behind the
  loading screen); after that, streaming is visibility-toggling only — no
  runtime hitches.
- Kanji on signs uses device system fonts (fine on iOS).

## iPhone test checklist

1. Load the game (Safari) → CONTINUE → garage: walk with the pad, look
   around — walls/ceiling clean, no flicker on beams/slats/panels.
2. Exit to the expressway → you're at Shibaura PA on the C1. Hold GAS,
   steer at ~60–80 km/h: the car should corner hard and never slide.
3. Follow 芝浦/SHIBAURA signs around a C1 lap (~14 km): canyon buildings,
   billboards, the Yaesu tunnel (white strips, jet fans, green exit doors).
4. Take the R11 exit at Shibaura → Rainbow Bridge (towers, cables, light
   chain) → merge onto the Wangan westbound.
5. Full-speed run through the Tokyo Port Tunnel (orange). Try to hit the
   wall at top speed: you must bounce/scrape, never pass through or get
   stuck (R recovers if anything looks wrong).
6. At Daikoku: ride the JCT loop, take the spiral down to the packed PA —
   banking toast fires, refuel happens, konbini + parked cars visible.
7. Exit ramp back up, K1 north-east past Heiwajima PA, Oi merge onto the
   Wangan eastbound, Tatsumi → R9 flyover → back onto C1.
8. Phone → MAP: network drawn north-up with PA markers + your arrow moving.
9. Phone → admin (PIN 1997) → TRAFFIC DENSITY 3×: noticeably packed lanes,
   frame rate steady. Near-miss combos above 100 km/h; a wall scrape drops
   combo; three hard hits end the run; banking at any PA converts to ¥.
10. Buy a part on the garage PC → box arrives → carry + install → stats
    change; run the tank dry → tow → garage. Reload the tab: save intact.

## Verification artifacts (.devtests/)

- `network-test.mjs` — grade-crossings, edge continuity/alignment, 400-trial
  escape barrage, 30×70 km traffic walk, tour length, lane convention (ALL OK)
- `indicator-test.mjs` — blinker side vs movement in world space (ALL OK)
- `grip-test.mjs` — 60/100/160 km/h grip + flick stability (ALL OK)
- `spin-test2.mjs`, `steer-test.mjs`, `traffic-test.mjs` — unchanged, passing
- `e2e.mjs` — 25/25 on an iPhone-like touch viewport
- `landmarks.mjs` — landmark screenshots + draw-call probe

Run with `npm i --no-save three@0.166.1 playwright` from the repo root.

---

# PS1 → PS2 Visual Overhaul (2026-07-12, claude/shutoko-ps2-visual-pass)

The game was mistakenly targeting a PS1 aesthetic; this pass retargets every
visual system to PS2-era (TXR / Wangan Midnight): sharp near-native image,
clean readable geometry, emissive night lighting. Road topology, collision,
physics, scoring, phone Map app, controls and HUD are untouched.

**Renderer:** internal resolution 0.55/0.75/1.0 × device pixels (was
0.32/0.5/0.72), 3.2 MP cap, MSAA on; PSX vertex-snap, 31-level posterization,
CRT overlay and nearest-filtering removed; textures bilinear + mipmaps + 4×
anisotropy; darker blue-black ambient so emissive surfaces carry the scene.

**Buildings:** canvas window-grid facade textures (per-window warm/cool,
banded lit/dark floors) tiled with whole-window UV repeats; 8 archetypes
(slab, stepped, lit-crown, hotel, narrow+neon, commercial+billboard, shed,
warehouse); rooftop tanks/antennas/blinkers; footprint-grid placement pass
(no intersections, corridor/PA clearance); two-row C1 canyon, R9 row, K1
industrial, Wangan port warehouses, backdrop skyline on the same system.

**Barriers:** jersey-profile median, concrete parapet + steel handrail on
outer edges; barrier/lamp/reflector visuals suppressed exactly where they
would criss-cross another carriageway (gore mouths, PA gates) — collision
(corridor union) and wallSegments unchanged; deck pillars no longer stab
through lower carriageways.

**Gores:** every diverge/merge walks the ramp to the paved-edge split;
chevron paint fills the wedge, yellow/black crash cushion at the tip.

**Lamps/furniture:** merged lamppost geometry (flange, tapered pole, torus
arm, luminaire) + emissive lens; additive sodium light pools + stretched
wet-asphalt streaks (streaks off on Low); emergency phone boxes; km posts
and P boards on poles.

**Signage:** truss gantries with legs outside the barriers and both
directions' panels at the SAME beam height (fixes the mismatched sign
heights — the old code applied deck-bank tilt per panel); panels face only
their carriageway; all signs have dark backs (no mirrored text); faces
redrawn with route shields, kanji+romaji, lane arrows; textured chevron
boards in bends; matrix boards on mini-gantries; junction masts.

**Coherence:** tunnel portals with wing walls + name boards, ceiling ribs,
cylindrical jet fans; Rainbow Bridge deck light chains; skyline reflection
streaks on the bay; PA kerbs.

**Performance (iPhone-like viewport, default traffic):** 189 draw calls /
49.5k triangles (baseline 140 / 34.3k); at 3× traffic 213 / 50.6k (baseline
177 / 36k). e2e 25/25, network/indicator/grip suites ALL OK.
