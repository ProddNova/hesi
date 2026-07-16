# Tatsumi No.1 PA — elevated deck prototype

Checkpoint status: **prototype placed, nothing else moved.** The lot is now a
geometrically fitted elevated deck at the real Tatsumi corridor; the active
garage, the initial spawn, all route centrelines, junctions, merges, traffic
and the global `PA_ACCESS_LANES_DISABLED` state are untouched.

## What was placed, and how

`js/map.js` gains one narrowly scoped override, `_defineTatsumiDeck`
(hooked at the top of `_defineServiceAreas`, active only for
`def.id === 'tatsumi_pa'` **and only while PA access lanes are disabled** —
the `paAccessLanes: true` restoration twin keeps the legacy placement so the
restored access lane still matches its lot, which `pa-access-probe` asserts).

The deck is computed from the fitted runtime centrelines at build time; no
world coordinate in the code is hand-typed, and `data/routes*.json|js` are
untouched:

1. **Corridor discovery** — project the OSM lot centroid onto `wangan_0`
   (the spine) and scan ±900 m for stations that sit *between* `ramp_8`
   (north flank) and `ramp_9` (south flank) with both ramp decks ≥ 7 m above
   the Wangan pair and a ramp-to-ramp gap ≥ 34 m. The longest contiguous run
   wins (stations ≈ 31 826–32 066 on `wangan_0`).
2. **Axis fit** — least-squares line through the ramp-to-ramp midpoints
   (residuals ≈ 3 m; the corridor is straight through Tatsumi).
3. **Rectangle search** — trim the window ends so ramp pinches (ramp_9's
   flyover re-crossing at the east end, ramp_8 bowing inward) cost length
   instead of width; keep ≥ 1.6 m from every ramp surface edge; prefer width
   superlinearly (it is the scarce resource for the future garage).
4. **Elevation** — mean of both ramp decks across the final window, verified
   to keep ≥ 7.2 m over every Wangan station under the footprint (the flat
   lot collision gate is ±6 m, so traffic below can never be captured).
5. **Registration** — the deck goes through the shared `_pushServiceArea`
   model, so collision (`_lotAt`/`_lotRoadInfo`), proximity, refuel, minimap,
   dev map and the standard PA dressing all follow for free. The only
   dressing change: `area.pillarLateralOffsets` places the support columns in
   the median gap between the two carriageways below instead of the generic
   ±width·0.32 rows (which would stand in the live Wangan lanes).

Placement produced by the current data (runtime Y, i.e. data Y + 25):

| Property | Value |
| --- | --- |
| Deck centre | `3646.2, 57.79, -4056.0` |
| Size | 25.2 m × 206.1 m, flat, drivable, grip 0.94 |
| Elevation source | mean of ramp_8/ramp_9 decks over the window (55.9…60.2) |
| Clearance over Wangan | 9.0 m (both carriageways run under the full deck) |
| Clearance to ramp edges | ≥ 1.6 m (never intersects either ramp corridor) |
| Spine reference | `wangan_0` @ ≈ 31 942 m |

## Future anchors (metadata only — nothing consumes them yet)

Exposed as `area.futureAnchors` on the `tatsumi_pa` service area:

- **`garage`** — deck point at u = −0.3·length on the deck axis, heading along
  the deck. NOTE: the Shibaura-style garage building (48 × 34) is wider than
  the deck; the future pass must either shrink the shell or let it overhang
  the Wangan with its own visual footing.
- **`spawn`** — deck point at u = +0.15·length, heading toward the future
  exit end.
- **`wanganExit`** — player-only exit toward `wangan_0`: departure point on
  the north-west deck edge at the downstream (north-east) end, target
  `wangan_0` station ≈ 240 m past the deck, 9.0 m drop, ≈ 3.7 % grade. The
  future ramp must thread under ramp_9's flyover (which re-crosses the Wangan
  ≈ 90 m past the deck end at y ≈ 58) — expect to start the descent early or
  swing slightly north. **The connection is deliberately not built in this
  checkpoint** (no route, no edge, no traffic lane).

## Verification

- `.devtests/tatsumi-pa-placement-probe.mjs` — placement, elevation,
  between-the-ramps position, Wangan overlap + vertical separation, flat
  drivable deck, no ramp/Wangan interference, pillar clearance, no new
  routes/edges/lanes, garage + initialSpawn untouched, twin-map reversibility,
  anchor sanity. PASS.
- `.devtests/pa-access-probe.mjs` — still PASS (twin restores all 4 legacy
  access lanes, Shibaura garage flow intact).
- `.devtests/tatsumi-pa-shots.mjs` — 6 deterministic captures in
  `.devtests/shots/TATSUMI-*.png` (top-down, side elevation, deck over
  Wangan, deck level, Wangan underneath, exit-anchor area).

## Remaining (future checkpoints)

- Move the garage + player spawn onto the deck (use `futureAnchors`).
- Build the player-only `wangan_0` exit from `futureAnchors.wanganExit`.
- Garage shell that fits a 25 m deep deck (or overhang treatment).
- Optional visual pass: deck fascia/underside dressing beyond the standard
  slab + pillars, and an entry connection (the deck is currently reached by
  dev-map teleport only — intentional while PA access lanes stay disabled).
