# Debug stats overlay (`I`) and stats log recorder (`P`)

A lightweight, always-available performance HUD for hunting lag, plus a
recorder that captures the same statistics over time and copies them to the
clipboard for sharing/diffing.

Files:

- `js/debug-stats.js` — the self-contained `DebugStats` module (panel, REC
  badge, ring-buffer frame timing, TSV log, clipboard copy + manual fallback
  dialog). Owns no game state.
- `styles/debug-stats.css` — overlay styling (isolated from `styles.css`).
- `.devtests/debug-stats-test.mjs` — focused browser regression (19 checks).
- Integration lives in `js/game.js` (`setupDebugStats`,
  `getDebugStatsSnapshot`, two keydown lines, one `frame()` call per rendered
  frame) and one `<link>` in `index.html`.

## Keys

| Input | Action |
|-------|--------|
| `I` | Show/hide the stats panel (ignored while typing in an input/textarea/select) |
| `P` | Start recording; press again to stop — stopping copies the log to the clipboard |

Recording is independent of panel visibility: a pulsing red `● REC` badge
(top-right) shows elapsed time and row count even when the panel is hidden.
If the clipboard is unavailable (e.g. `file://`), a fallback dialog shows the
log in a textarea with a COPY button.

## Panel contents

- FPS and frame time (average, p95, max over the last ~240 frames)
- JS heap used / total / limit (`performance.memory`, Chromium-only; other
  browsers show "not exposed")
- Renderer per-frame counters: draw calls, triangles
- Renderer memory: geometries, textures, shader programs
- Active scene contents: objects, meshes (plus how many sit in the visible
  tree), instanced-mesh instance count
- Streamed chunks visible/total and active traffic vehicles
- Mode (driving/garage/noclip/boot), quality profile, internal resolution,
  device pixel ratio
- Position, speed, current route

## Log format

Header lines prefixed with `#` (date, duration, user agent, GPU via
`WEBGL_debug_renderer_info`, quality/resolution), then a tab-separated table
at 2 rows/second — it pastes directly into any spreadsheet. Columns:

```
time_s mode fps frame_ms_avg frame_ms_p95 frame_ms_max draw_calls triangles
geometries textures programs scene_objects scene_meshes visible_meshes
instanced_count chunks_visible chunks_total traffic heap_used_mb heap_total_mb
speed_kmh pos_x pos_z route
```

Frame timings aggregate every frame between rows, so single-frame spikes show
up in `frame_ms_max` even at the 500 ms row cadence.

## Cost when idle

`frame()` does one `performance.now()` and a ring-buffer write per frame when
the panel is hidden and no recording is running. The panel refreshes at 4 Hz;
scene traversal (object counting) runs at most once per second and only while
the panel is visible or a recording is active.
