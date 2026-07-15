# Same-level lateral junction rebuild — status (2026-07-15)

Scope: every real same-level merge/diverge connection (a branch entering or
leaving a host carriageway at approximately one deck level). Out of scope,
untouched: vertical crossings, overpass/underpass clearance, the global
guardrail cleanup, parking-area access reconstruction. Start commit
`dbb2e33`; raw (`data/routes.json`) and smoothed (`data/routes-smoothed.json`)
network data untouched.

## Phase 0 — parking-area access lanes disabled (reversible)

The synthesized PA decel/accel legs and descent spirals are broken and
queued for their own rebuild. `PA_ACCESS_LANES_DISABLED` (js/map.js) removes
them from the RUNTIME map only: for a disabled PA no service route is
registered, so its asphalt, collision corridor, wall segments, markings,
edges and traffic connections all disappear together, and its blue "P"
advance boards are suppressed. Restore with `options.paAccessLanes = true`
or by flipping the flag — no data was deleted.

| PA | access lane | why |
|---|---|---|
| shibaura_pa | **kept** (`shibaura_pa_access`) | garage connector — the player garage lives in this lot; spawn/tow/exit land beside it on R11 and the player must drive in/out |
| tatsumi_pa | disabled | broken access geometry, rebuild later |
| heiwajima_pa | disabled | broken access geometry, rebuild later |
| daikoku_pa | disabled | broken access geometry + synthesized descent spirals, rebuild later |

The lots themselves (dressing, refuel pad, proximity, their own wall
collision) remain. Disabling removed the `daikoku_pa_access` validator
families outright (overlap 18→16, ramp-drive 47→45, smoothness 62→60).

## Phase 1 — audited junction catalogue

`.devtests/lateral-junction-audit.mjs` walks every diverge/merge edge in the
runtime graph — connection metadata only; a road visually crossing another
without an edge is never treated as a junction — and measures host/branch,
side, transfer gap/step, tangent mismatch, widths, level delta, paved
overlap depth, vertical separation inside the overlap, gore gaps, and rails
across either opening. Full catalogue: `.devtests/lateral-junction-audit.json`.

Baseline findings (58 connections: 30 diverges / 28 merges; 38 left / 20
right; hosts 2–3 lanes, branches 1–2):

- every mouth is same-level at the transfer point (drop 0.00 m, jumps ≤ 5 m,
  tangent mismatch ≤ 13.3°) — the topology and anchoring were sound;
- **45/58** had the branch ribbon lying coplanar on the host deck through
  the anchored taper (duplicated asphalt, z-fighting);
- **32/58** opened a 0.15–0.7 m sliver hole between the paved edges before
  the surfaces split (the gore area);
- **0/58** had a guardrail crossing an opening (visual suppression already
  covered the mouths — but runs ended as open hollow profiles).

## Phase 2 — implementation architecture

One generic, data-driven system in `js/map.js`; no per-junction coordinate
patches. Physics (the corridor union), wall segments, `_frameAt` road
frames and all endpoint/connection anchors are untouched — the mouth system
only changes what is DRAWN.

- **`_prepareJunctionMouths()`** registers a mouth on the branch end of
  every diverge/merge edge (host, side, span), scanning the branch until
  the corridors separate laterally (> 1.6 m) or vertically (> 2 m).
- **`_mouthClipAt(route, frame)`** computes a cached per-frame clip record.
  Across the branch cross-section, g(l) = signed distance outside the
  host's paved edge and dy(l) = height above the host's banked surface are
  locally linear; the record removes exactly
  `{g < 0} ∩ {|dy| < 0.12 m}` — the coplanar duplicate — leaving up to two
  drawn intervals: the outer wing and, where the decks scissor, a lifted
  shelf. Each cut edge carries a flap vertex that extends 0.35 m past the
  cut and dives 6 cm under the host surface (watertight against the host's
  chorded edge, clear of the depth-fighting band). Cross-sections fully
  outside the host close the gore sliver with the same flap mechanism (an
  apron that fades back to the branch edge as the gap exceeds 1.2 m or the
  level offset exceeds 0.35 m). Sections vertically clear of the host —
  a ramp lifting away, a stacked deck — are drawn untouched: vertical
  separations are real geometry and stay out of scope.
- **`_emitMouthDeck(...)`** pairs intervals across consecutive surface
  frames by lateral overlap and emits quads on the authoritative frame
  plane; an unpaired interval emits a quad whose missing-side corners tuck
  under both decks (min of branch plane and host surface − 6 cm), so wings
  grow out of the host progressively with no unpaved notch and no pop.
  Mouth quads use the HOST's road material so the junction reads as one
  paved surface. Elevated undersides follow the clipped footprint.
- **Markings** clip to the drawn intervals (`mouthPaintLat`): branch paint
  never duplicates over the host; the branch's host-side edge line
  reappears exactly where the gore opens and becomes the ramp-side gore
  line; the host's own edge line continues as the through-lane
  channelizing line. Dash phase stays route-absolute (no restarts).
- **Guardrails**: parapet runs now emit closing end-cap faces at
  suppression boundaries (`_emitBarrierEndCap`) — rails terminate cleanly
  before a gore and restart cleanly after it instead of showing hollow
  open profiles. Gore chevrons and crash cushions are placed on the banked
  deck surface via `_frameAt` (they previously floated at bare curve
  height on banked gores). No network-wide guardrail work was started.
- **A/B switch**: `?legacyMouths=1` (URL) or
  `junctionMouthSurfaces: false` (constructor option) draws the legacy
  full ribbons for comparison. The constructor also no longer drops
  options passed as `(null, options)` — headless probes were silently
  losing their flags.

## Verification

`.devtests/lateral-junction-probe.mjs` — the focused gate — raycasts the
actual drawn deck triangles across all 58 mouths (20,295 points): a paved
point must have a surface matching a corridor-union height (no holes, no
steps), no two parallel road surfaces within 18 mm (z-fight), and no
rail/parapet sheet crossing 0.25–1.4 m above an open mouth interior.

| metric (drawn surface, 58 mouths) | legacy ribbons | mouth system |
|---|---|---|
| holes in the paved union | 0* | **0** |
| height steps vs corridor union | 0 | **0** |
| rails across open mouths | 0 | **0** |
| parallel coplanar pairs (z-fight) | **459** | **46** |
| … of which severe (< 6 mm) | 114 | 10 |

\* legacy "holes" were sliver gaps between two decks, which the hole probe
scores against either corridor — the audit's gore-gap metric (32 junctions)
is the honest before-number for those.

The 46 remaining pairs are mm-scale sibling-branch overlaps inside braided
multi-level JCT complexes (Daikoku k5/wangan braid, Hakozaki family) —
pre-existing, in the vertical-crossing domain, ratcheted at ≤ 60 by the
probe so the family can only shrink.

Full battery at this checkpoint:

- `node .devtests/lateral-junction-probe.mjs` — **PASS** (0/0/0, doubles 46);
- `node .devtests/osm-validate.mjs` — rail 0 / overlap 16 / ramp-drive 45 /
  smoothness 60 / hygiene 0. Identical counts to post-Phase-0; every
  remaining failure is a documented pre-existing family (ramp_17/Hakozaki
  height steps, braided-complex overlaps), **no new signatures**;
- `node .devtests/road-surface-probe.mjs` — PASS;
- `CHROMIUM_PATH=… node .devtests/e2e.mjs` — **25/25**;
- `node .devtests/traffic-test.mjs` — OK; 68 junction transfers driven:
  worst excess displacement 7.35 m at `ramp_39 → ramp_46` (the documented
  pre-existing fork-continuation data jump), zero traffic lanes on
  disabled PA routes, merge landing lanes unchanged;
- performance probe: this container fails the absolute wall-clock limits
  AT THE BASELINE COMMIT TOO (5.1 s build / 167 ms p95 before any change);
  relative A/B shows the mouth system within noise (~6.1 s vs ~6.0 s
  headless build, same-run legacy comparison).

## Before/after screenshots

Repeatable via `.devtests/junction-shots.mjs [suffix] [--legacy]` — cameras
derive from centrelines only, so pairs frame identical spots
(`.devtests/shots/J-*-{legacy,fixed}.png`, full set). Committed
representative pairs in `docs/junctions/`:

- `wide-diverge-wangan0-ramp2-oblique-{before,after}.png` — 3-lane Wangan
  West with the 2-lane ramp_2 exit: the duplicated ribbon with its own
  doubled edge lines disappears into one paved surface;
- `right-merge-r1_3-ramp12-top-{before,after}.png` — right-side merge:
  progressive width combination, gore fill, clean paint;
- `left-merge-k1_0-ramp42-top-{before,after}.png` — left-side merge on K1;
- `left-diverge-k1_0-ramp42-chase-after.png` — driver's view through the
  mouth: single surface, gore chevrons and cushion on the deck.

Where a legacy ribbon sat slightly BELOW the host surface, before/after
top-down views can be pixel-identical (the host always won the depth test
from straight above); the defect there was z-fighting at oblique/grazing
angles and is captured by the oblique pairs and the probe numbers.

## Remaining work (out of this task's scope)

- **Vertical junctions / stacked crossings**: the 16 overlap-clearance
  failures (Hakozaki r9/ramp_25 knot, Namamugi, Daikoku k5×wangan braids),
  the ramp_17 / ramp_46 / Hakozaki height-step families (45 ramp-drive +
  60 smoothness entries) — extractor `holdEndZone`/elevation work, plus
  the 46 ratcheted sibling-braid coplanar pairs inside those complexes.
- **Global guardrail cleanup**: only junction-mouth terminals were treated
  (end caps + existing suppression). Network-wide rail continuity,
  double rails along parallel decks and PA-lot fencing remain.
- **Parking-area access reconstruction**: three PA lanes are disabled
  (table above); the Shibaura garage connector still has its pre-existing
  audit findings and should be rebuilt with the PA pass.
- Traffic behaviour beyond junction routing was not redesigned; the
  `ramp_39 → ramp_46` continuation jump is a data fix for the vertical
  pass.
