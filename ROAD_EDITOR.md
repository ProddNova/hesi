# Shutoko Road Editor — manual centreline corrections

A local desktop tool for manually correcting individual road curves of the
Shutoko network. It lets a non-programmer inspect the whole network, find a
bad curve, add/drag a few control handles, preview the **exact** final
processed road and save the correction safely.

It edits road **centrelines only** (XZ plan geometry). It is *not* a
junction editor, guardrail editor, road-width editor, elevation editor or
game-level editor.

---

## Launch

```
npm i --no-save three@0.166.1        # once (same dev dependency as the generator)
node tools/road-editor/server.mjs    # → http://127.0.0.1:8123/
```

Options:

| flag | default | meaning |
|---|---|---|
| `--port=N` | `8123` | listen port (always bound to 127.0.0.1 only) |
| `--overrides=PATH` | `data/route-overrides.json` | override file to edit |
| `--backups=DIR` | `tools/road-editor/backups` | timestamped backups (gitignored) |
| `--open` | off | try to open the browser automatically |
| `--allow-apply` | off | enable the «Applica alla working tree» action |

The interface is in Italian. Press `?` (or the `?` button) for the built-in
help and the guided tutorial.

## Data flow — where edits live

```
raw OSM routes (data/routes.json)          ← NEVER edited
        │
        ▼
manual overrides (data/route-overrides.json)   ← the ONLY file the editor writes
        │
        ▼
offline fairing  (tools/road-editor/lib/fairing.mjs)
        │            ▲ shared module: the CLI generator AND the editor
        ▼              preview run the very same mathematics
generated smoothed routes (data/routes-smoothed.json + .js)
        │
        ▼
game runtime (js/map.js)
```

- `tools/build-smoothed-routes.mjs` is now a thin CLI wrapper around the
  shared fairing core. Its flags, logs and byte-exact output are unchanged.
- The editor **never** regenerates production assets by itself. The
  «Rigenera anteprima» action runs the full pipeline into a temporary
  directory and verifies (by hash) that `data/` stayed untouched.
- One caveat, by design: the live single-route preview runs the full fairing
  *without* the network-wide cross-route clearance guard (that guard needs
  every route). The temporary regeneration and the CLI run it. The editor
  compensates with its own carriageway-clearance warning.

## Override schema (v2, stable)

`data/route-overrides.json`:

```jsonc
{
  "version": 2,
  "meta": { "tool": "road-editor" },
  "routes": {
    "r11_0": [
      {
        "id": "ov_abc123",                 // stable id (undo/diff/merge friendly)
        "op": "move",                      // move | insert | delete | pin | smooth
        "enabled": true,                   // disable without deleting
        "note": "curva a S dopo il ponte", // free note
        "createdAt": "2026-07-15T00:00:00Z",
        "anchor": {                        // STABLE reference, no array indexes
          "station": 1667.3,               // chainage (m) along the raw route
          "point": [-472.77, -4893.8],     // raw position signature [x, z]
          "tolerance": 15                  // max matching distance (m)
        },
        "to": [-452.3, -4882.4],           // move target [x, z]
        "influence": 45,                   // bump half-width along the route (m)
        "weight": 24,                      // data-term weight (solver tracking)
        "unlockProtected": false           // explicit advanced unlock
      }
    ]
  }
}
```

Anchors resolve by projecting `point` onto the current raw polyline inside a
window around `station`; if the geometry was re-extracted and stations
shifted, the window widens once. An anchor that no longer matches within
`tolerance` makes the op **skip with a warning** — it never lands somewhere
wrong. Ops:

- `move` — cosine-falloff displacement of the raw polyline over ±`influence`
  metres plus a local data-weight floor so the solver follows the handle.
  `influence: 0` moves a single vertex (pin-style).
- `insert` — adds one raw control vertex (`point`: `[x,z]` or `[x,y,z]`).
- `delete` — removes the nearest raw vertex, only when safely matchable
  (default tolerance 6 m).
- `pin` — weight floor `W_PROT` over ±`span`: the stretch is emitted raw
  verbatim, like a protected zone.
- `smooth` — scales the data weight by `factor` over ±`span` so the fairing
  smooths harder locally (deviation cap still applies).

The **legacy v1 index format** (`{ "routeId": [ {op,index,…} ] }`) is still
accepted by the generator, the server and the schema validator, with the
original semantics.

Every save is schema-validated (`tools/road-editor/lib/schema.mjs`), written
atomically (temp file + rename), and preceded by a timestamped backup of the
previous file. There are no partial writes and no silent overwrites.

## Safe editing workflow

1. **Seleziona una strada** — click it on the map or search the sidebar
   (name, ID, kind, length, connections, warning badges, «≈» quality hints).
2. **Zooma sulla curva** — mouse wheel; enable the «Curvatura» overlay
   (red/blue = left/right, brighter = tighter).
3. **Aggiungi 2–3 maniglie** — double-click the route line.
4. **Trascinale** — the green line is the REAL fairing result, recomputed
   live server-side; orange is the current production road; grey is raw OSM.
5. **Controlla gli avvisi** — ⚠ warnings (deviation > 1.8 m, tighter radius,
   oscillation, clearance loss, near-anchor edits, tangent/length changes)
   allow saving; ⛔ **errori bloccanti** (self-intersection, new same-level
   crossings, protected-zone edits without unlock, deviation > 8 m, NaN)
   block it.
6. **Salva override** (Ctrl+S) — atomic write + backup + exact diff shown.
7. **Rigenera anteprima** — full pipeline to temp files, production hashes
   verified untouched.
8. **Valida** — quick focused checks, or the full project probes
   (`tools/fairing-metrics.mjs`, `.devtests/osm-validate.mjs` — hardcoded
   allowlist, streamed output).

Protected zones (violet) are locked by default: route endpoints, connection
stations ±45 m, diverge/merge anchor-blend spans, PA gate + access spans and
the whole grounded Daikoku stack. Clicking one explains *why* it is locked;
an explicit confirmation dialog can unlock a single op, which stays flagged
in the warnings.

Section tools (set markers A and B on the route): *Liscia*, *Raddrizza*,
*Arco* (broad circular arc between two stations), *Riduci oscillazioni*,
*Reset sezione*. They only generate ordinary override constraints.

## Undo, recovery, robustness

- Multi-step undo/redo (Ctrl+Z / Ctrl+Y), duplicate-safe.
- The browser autosaves a recovery draft (localStorage) on every change; on
  reload a differing draft offers **Riprendi / Scarta**.
- Unsaved-changes indicator + `beforeunload` warning.
- A malformed `route-overrides.json` never crashes anything: the editor
  starts with the file untouched and offers backup restore; the next save
  backs the broken file up before replacing it.
- Backups are timestamped (`route-overrides-YYYYMMDD-HHMMSS-mmm.json`) and
  restorable from the UI (the current file is backed up first).

## Applying corrections to the game (deliberate, manual)

1. Save overrides in the editor.
2. Run `node tools/build-smoothed-routes.mjs` (reads the overrides, rewrites
   `data/routes-smoothed.json` + `.js`).
3. Inspect `git diff`, run the validations, commit manually.

The server-side «Applica alla working tree» button automates steps 1–2 (with
backups, no commit) but is **disabled** unless the server was started with
`--allow-apply` and the confirmation word is typed.

## Tests

```
node --test 'tools/road-editor/test/*.test.mjs'
```

31 tests cover: schema validation (v1+v2), atomic save/backup/restore,
malformed-JSON recovery, undo/redo and draft state, stable anchor matching
across resampling, op application (move/insert/delete/pin/smooth, disabled,
legacy v1), protected-zone rejection vs unlock, deviation error vs warning,
preview⇄generator parity on fixtures, **byte-parity of the shared core with
the committed production asset**, and a real-server integration test
(save gates, backups, temp regeneration, production hashes untouched,
apply refusal, path-traversal defence). Fixtures are synthetic; temporary
directories are used throughout; production data is never modified.

## Limitations

- XZ centrelines only — elevation is carried from the raw profile, exactly
  like the generator.
- The live preview skips the network-wide clearance guard (see above).
- «Validazione completa» analyses the *committed* production assets, not
  unsaved edits (the probes import `js/map.js`, which loads
  `data/routes-smoothed.js`).
- Warning heuristics are advisory; the generator remains the ground truth.

## Future extensions

The v2 op format leaves room for growth without breaking changes:

- **width**: a `widen`/`lanes` op keyed by the same anchors, consumed by the
  runtime road builder;
- **elevation**: a `raise` op adjusting the y-profile before the (future)
  elevation fairing pass;
- **junctions**: gore/anchor repositioning would extend `protectedZones`
  into editable-but-guarded geometry — the zone descriptions already carry
  the reasons and spans an editor would need.

## Merging this branch after the junction branch

This branch deliberately does **not** touch `js/map.js`, `js/traffic.js`,
`js/game.js`, `data/routes*.{json,js}` or `.devtests/osm-validate.mjs`, so
it merges cleanly after the junction work regardless of what that branch
changes in runtime geometry. After merging BOTH branches:

1. re-run `node tools/build-smoothed-routes.mjs` only if the junction branch
   changed `data/routes.json` (the editor's parity test
   `tools/road-editor/test/parity.test.mjs` will tell you: it fails if the
   committed smoothed asset no longer matches the shared core's output);
2. run `node --test 'tools/road-editor/test/*.test.mjs'`;
3. run `node .devtests/osm-validate.mjs`.

If the junction branch reshaped connection stations, existing v2 overrides
re-anchor themselves via their point signatures; any op that can no longer
match within tolerance is skipped and reported — never misapplied.
