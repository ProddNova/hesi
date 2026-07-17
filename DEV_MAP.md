# Developer network map (`M`)

A full-screen, interactive top-down map of the entire runtime highway network,
opened with the **M** key or the **DEV MAP** touch button. It is a development /
debugging tool, separate from
the in-fiction phone minimap, for inspecting routes and teleporting the car (or
the noclip drone) anywhere on the network.

Files:

- `js/dev-map.js` — the self-contained `DeveloperMap` module (overlay, canvas
  renderer, transforms, hit-testing, teleport selection). Owns no game state.
- `styles/dev-map.css` — the overlay styling (isolated from `styles.css`).
- `.devtests/dev-map-test.mjs` — focused Playwright regression (33 checks).
- `.devtests/e2e.mjs` — generic mobile touch entry, responsive layout, pinch,
  pan, close, and control-overlap regression.
- Integration lives in `js/game.js` (`setupDevMap`, `getDevNetwork`,
  `teleportToRoutePoint`) and one `<link>` in `index.html`.

## Controls

| Input | Action |
|-------|--------|
| `M` | Toggle the developer map (ignored while typing in an input/textarea/select) |
| `DEV MAP` touch button | Open the same developer map on any coarse-pointer/mobile layout |
| `Escape` | Close the map |
| Close button | Close the map |
| Drag empty map / one-finger drag | Pan (disables follow) |
| Mouse wheel / two-finger pinch | Zoom around the cursor or gesture centre |
| Double-click | Centre on the current position |
| Hover a road | Highlight it + show a tooltip of real metadata |
| Click a road | Teleport to the closest point on it |
| **Fit network** | Frame the whole network (turns follow off) |
| **Centre position** | Pan to the live position |
| **Follow: ON/OFF** | Keep the live position centred every frame |
| **Labels: ON/OFF** | Draw route codes at sensible zooms (de-cluttered) |

## Progressive pins

**Left-hand traffic note (2026-07):** the live network now runs reversed
(Japanese left-hand traffic — see `reverseNetworkData` in `js/map.js`), which
flips both prototype junction senses. The prototypes were engineered and
golden-digested against the original flow, so they only build under
`options.legacyFlow` — the live developer map exposes **no** prototype pins,
and the two junctions use the standard treatment. The progressive probe suite
(`.devtests/progressive-*.mjs`) constructs `legacyFlow` maps and keeps
validating both records, including the P1 geometry digest.

Under legacy flow the map exposes exactly two active progressive pins. Both
are bright magenta diamonds; every obsolete P1/P2/P3/P4 prototype or deferred
pin has been removed. Open the map with `M` or the mobile **DEV MAP** button,
choose **Fit network**, hover a pin for classification/topology/status
metadata, and click the diamond to teleport to the host transition. The info
line reads `2 active · 0 deferred (P1, P2)`.

| Pin | Junction | Route pair | Side | Topology | World X, Y, Z |
| --- | --- | --- | --- | --- | --- |
| P1 | `J2:diverge:c1_0:r1_0:start` | `c1_0 → r1_0` | left | preserved 2+2 progressive diverge | `-1094.38, 57.33, -3014.18` |
| P2 | `J48:merge:wangan_1:ramp_41:end` | `ramp_41 → wangan_1` | right | approved 2+3 merge, `5 → 4 → 3` | `-8164.3, 76.7, -24238.6` |

Pins use the read-only `progressive-prototype` category. Junction ID,
host/branch IDs, merge/diverge type, driver-relative side, lane counts,
classification, phase boundaries, topology, lane sequence, status and
teleport route all come from the shared transition records. In legacy
comparison mode (`?legacyProgressiveMerges=1`) the map exposes no pins.

While the map is open, gameplay is **frozen** — the vehicle and noclip drone
stay put and all gameplay keys are swallowed. Freezing is intentional and
preferable to letting the car or drone drift on a stuck key. Closing restores
normal controls and, deliberately, does **not** re-acquire pointer lock.

The touch entry point is part of the shared utility-control group and is shown
in driving, garage, and noclip modes on coarse-pointer/mobile layouts. It calls
the same `toggleDevMap()` path as the keyboard shortcut; there is no separate
mobile map state or renderer. Safe-area insets, a responsive toolbar,
one-finger pan, two-finger pinch zoom, tap-to-teleport, and the in-map Close
button cover both portrait and landscape devices rather than targeting a
specific phone model.

## Architecture

`DeveloperMap` never imports game internals. Everything flows through callbacks
passed by `game.js`:

```js
new DeveloperMap({
  getNetwork,           // () => { routes, bounds, junctions, serviceAreas, garage }
  getCurrentPosition,   // () => {x, y, z}  (vehicle or drone, see below)
  getCurrentHeading,    // () => radians
  getCurrentRoute,      // () => display string | null
  isNoclipActive,       // () => boolean
  teleportToRoutePoint, // ({routeId, distance, lane, direction, worldX, worldZ}) => {x,y,z,heading}
  onOpen, onClose,      // input/pointer-lock housekeeping
});
```

The module owns: overlay lifecycle, canvas rendering (a cached static layer + a
per-frame dynamic layer), network bounds, cached route polylines, world↔screen
transforms, pan/zoom, route hit-testing, hovered-route highlighting, the
tooltip, the current-position marker, teleport selection, and resize / device-
pixel-ratio handling.

**Static vs. dynamic layers.** The network (polylines, grid, junctions, service
areas, garage, labels) is drawn once into an off-screen buffer and only redrawn
after a pan, zoom or resize (`_staticDirty`). Every animation frame simply blits
that buffer and draws the cheap dynamic layer (marker, heading arrow, hover
highlight, tooltip) on top. No full-network allocation happens per frame.

## Position sources

- **Normal driving** → the authoritative physics/vehicle position and heading
  (`getVehicleState()`).
- **Noclip** → the authoritative debug/drone position and yaw
  (`debug.position` / `debug.yaw`). The hidden vehicle position is never shown
  in noclip. The marker is drawn cyan (drone) vs. pink (car).

The marker updates continuously from these callbacks without rebuilding the
static network, so it tracks correctly even right after a long-distance
teleport. Opening the map with follow on centres on whichever position is live
(this is what centres the noclip drone).

## Hover selection

Hit-testing runs in **screen space** against the cached polylines, so it is
stable at any zoom and uses a zoom-independent pixel threshold. For a cursor it
finds the closest segment of each route, keeps routes within the threshold, and:

- computes the closest point and an approximate **chainage** (uniform
  arc-length: segment `i`..`i+1` of `segCount` spans `route.length`);
- when several routes **overlap in plan view**, prefers the deck whose elevation
  is closest to the current camera/vehicle height (deterministic multi-level
  pick);
- applies a small hysteresis band so the tooltip does not flicker between
  overlapping decks, and throttles the mousemove hit-test.

The tooltip shows only genuine runtime metadata: display name, route id, group /
motorway name, kind, lane count, travel direction, approximate chainage, local
elevation and the hovered world X/Z. Names fall back
`route.name → route.label → route.id`; nothing is invented.

## Teleport behaviour

A deliberate click (never a drag) teleports to the exact closest point on the
hovered route. The chainage from hit-testing is fed to the **authoritative route
sampler** (`map.sampleLane`) to obtain the exact centre position, rendered road
height and travel tangent. The map stays open so several spots can be inspected
in a row.

- **Noclip** — updates the drone `debug.position` (placed slightly above the
  surface) and aligns `debug.yaw` to the route tangent, snaps the noclip camera,
  and refreshes streamed chunks / world visibility immediately (`map.update`).
- **Driving** — resets the physics pose via `physics.setPosition` (which clears
  linear and angular velocity, steering and impact timers), places the car just
  above the surface aligned to the travel direction, refreshes the player mesh,
  driving camera, current road info and streamed chunks, and arms a contact
  cooldown so the landing does not register as a crash.

Neither path touches the permanent spawn or save data. The selected teleport
route, chainage and coordinates are shown in the info panel.

## Limitations

- Chainage is derived from the minimap's uniform arc-length polyline, so it is
  accurate to within roughly the sample spacing; the authoritative sampler still
  lands the teleport on the true centreline.
- Route geometry is cached from `map.getMinimapData()` at first open; if the
  runtime network were rebuilt at runtime the map would need reopening (the game
  never does this).
- Overlap resolution uses local polyline elevation, so at a shallow-angle
  merge where two decks share the same height the pick falls back to nearest
  screen distance.
- Labels show route codes at higher zooms only, with a simple bounding-box
  de-clutter; extremely dense clusters may still hide a few labels.
