# Road editor — live edits, honest saves, deletable roads

Date: 2026-07-30

Reported: *"sposto le sfere/nodi della strada e non applica le modifiche subito,
devo per forza salvare e ricaricare"*, *"ho spostato la rampa 8 … save draft e mi
ha ricreato Tatsumi PA entry e exit che avevo eliminate"*, *"manca il modo di
eliminare del tutto una strada"*.

Four separate defects were behind that. All four are fixed and covered.

---

## 1. The saved draft never reached the map (the root cause)

`js/map.js` imports the route document as `../data/routes-smoothed.js?v=aa56cc4f53cb`.
The editor's draft loader imported `/data/routes-smoothed.js`. **Different
specifier = different ES module record**, each with its own copy of the
document — so `loadDraftIntoModule()` mutated an object `HighwayMap` never read.
Save Draft wrote the file, the reload re-applied it to the wrong copy, and the
road came back unchanged. That is the whole "devo salvare e ricaricare, e
comunque non cambia".

- `js/map.js` now exports `getRouteNetworkData()` — the document it actually builds from.
- `tools/hesi-editor/src/world/map-module.js` is the single import site for
  `js/map.js` in the editor; `world-adapter.js`, `route-persistence.js` and
  `road-edit-controller.js` all go through it.

## 2. Moving a point now rebuilds the real road, immediately

The world's asphalt is merged per chunk per material, so a moved route could not
be re-meshed — the editor drew an orange draft surface on top and left the baked
road where it was.

`HighwayMap` now records, per route, the exact vertex ranges and instance ranges
that route contributed while the world was built (`_beginRouteEmission` /
`_endRouteEmission`, hooked into `_bucket`, `_instance` and `_addChunkMesh`).
With that:

- `refreshEditorRouteGeometry(routeId)` collapses those ranges in place
  (zero-area triangles, zero-scale instances — **no index anything addresses
  ever moves**, so saved world-build ops stay valid) and re-runs
  `_buildRouteGeometry` + `_queueRouteDetails` in *capture* mode into a
  standalone group.
- `clearEditorRouteGeometry(routeId)` puts the baked geometry back byte for byte.

Cost measured on the real world: **~45–100 ms for a ramp**, 0.7 s for a C1
carriageway, 3.6 s for the 26 km Bayshore. The controller debounces (220 ms, or
1.4 s once a route has proven expensive) and flushes before any save.

## 3. WYSIWYG: the preview now equals what the build produces

`_registerDataRoute` re-blends a branch's endpoints onto its host
(`_anchorEndpoint`). The editor previewed the raw handles, so a saved ramp edit
came back looking like it had never been applied — the ends had been re-glued.
Measured drift before the fix: **up to 56 m** on `ramp_14`, 54 m on `ramp_8`.

`applyEditorDataRouteEdit(routeId, points)` re-runs that same blend on the edited
polyline, using the anchoring decision recorded at registration
(`route.editorSource`). Probe result: live preview vs a fresh world build agree
to **0.0000 m**.

## 4. A deliberate edit is never silently reverted

`_syntheticOverrideIsStale` discarded a saved PA-connector override whenever the
generated connector changed — and the connectors are generated *from ramp_8*, so
editing ramp_8 was enough to resurrect both Tatsumi PA lanes the user had hidden.

An override carrying a `base` stamp is editor-authored user data and is now
applied verbatim, with an informational log when the stamp has drifted. Only
unstamped (pre-stamp) files still face the geometric guard.

Side effect worth noting: replaying the user's own saved edits also repaired
their world-build addressing — `node .devtests/editor-build-ops-probe.mjs` went
from **79/99 on target (20 drifted)** to **95/99 (4 drifted)**, the 4 being the
pre-existing `box:marking` drifts on the Tatsumi deck.

## 5. Roads can be deleted

A centreline always keeps at least two points, so removing points can never take
a road out. Deletion is now its own operation:

- Road panel → **Delete road** / **Restore road** (undoable, `deleted` badge).
- Persisted as `removedRoutes` in `data/editor/road-route-overrides.json`, published
  into `meta.editorRoadOverrides.removedRoutes`.
- `HighwayMap.setEditorRouteRemoved()` / `_applyEditorRouteRemovals()`: the route
  stays *registered* (edges, junctions and service areas hold references to it)
  but emits no geometry and leaves the spatial index — invisible, undrivable, no
  traffic, off the minimap.
- The route's centreline override is kept beside the removal, so restoring the
  road brings its edited shape back.

---

## Verification

| check | result |
|---|---|
| `node .devtests/road-editor-draft-probe.mjs` | 18/18 — WYSIWYG 0.0000 m, synthetic edits honoured, removal complete, erase/restore reversible |
| `node tools/hesi-editor/.devtests/road-live-edit-probe.mjs` | 16/16 in real Chromium — live rebuild, delete, save, undo; shots in `.devtests/shots/road-live-edit/` |
| `node tools/hesi-editor/test/smoke/editor.smoke.mjs` | PASS (it failed on `main` at the same stale `waitForNavigation`) |
| `npm --prefix tools/hesi-editor run test:unit` | 183 pass / 1 fail — `car-models` traffic indicators, pre-existing and unrelated |
| `npm --prefix tools/hesi-editor run test:server` | 8/8 |
| `node .devtests/e2e.mjs` | 39/42 — identical to `main`'s 39/42, same three pre-existing failures |
| `node .devtests/editor-build-ops-probe.mjs` | 95/99 on target (was 79/99) |

Two test files were corrected as part of this, both stale rather than newly
broken: `editor.smoke.mjs` expected Save Draft to reload the page (it has not for
some time) and ran against whatever roads happened to be edited locally — it now
runs on an empty draft and restores the developer's file afterwards.

## Known limits

- A live rebuild regenerates the route's own geometry only. Junction-mouth
  clipping and gore dressing keep the alignment they were built with until the
  next full world build; on a heavily moved junction ramp that shows as stale
  paint at the mouth.
- The 26 km Bayshore carriageways cost ~3.6 s per rebuild. Debounced, but a
  visible pause after each committed point move on those two routes.
- `Apply to Game` is still what writes production data. Nothing here changes the
  draft/publish split.
