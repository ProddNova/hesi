# Debug HUD and diagnostic recorder

`js/debug-stats.js` provides a low-overhead performance HUD and a structured
session recorder intended for profiling, regression comparisons, and AI-assisted
game optimization.

## Controls

| Input | Action |
|---|---|
| `I` | Show or hide the live debug HUD |
| `P` | Start a diagnostic recording; press again to stop and export it |
| `O` | Add a manual marker while recording |

The hotkeys are ignored while typing in an input, textarea, or select.
Recording does not require the HUD to remain visible. A red badge always shows
the elapsed time, sample count, and export/marker controls.
The in-game debug menu also exposes `START / STOP` and `MARK MOMENT` buttons,
so the recorder remains usable on touch devices.

## Recommended capture workflow

1. Start the game and reach the state you want to investigate.
2. Press `P`.
3. Reproduce the hitch, route, crash, traffic condition, or gameplay issue.
4. Press `O` close to a problem that may not be obvious from timing alone.
5. Continue for at least 30–60 seconds so the report contains a useful baseline.
6. Press `P` again.
7. Attach the downloaded `hesi-diagnostic-*.json` when requesting an analysis.

Stopping performs two exports:

- The complete compact JSON report is downloaded automatically.
- A short AI-readable overview is copied to the clipboard.

If the clipboard API is unavailable, a dialog offers `DOWNLOAD JSON`,
`COPY SUMMARY`, and `CLOSE`. The last report also remains available at
`window.shutoko.debugStats.lastReport`; it can be downloaded again with
`window.shutoko.debugStats.downloadLastReport()`.

## What the report captures

The report uses schema `hesi.diagnostic-recording`, version `3`.

### Environment and reproducibility

- UTC start/end time and session ID
- Browser user agent, platform, CPU-thread hint, device-memory hint, touch count
- Viewport, screen, device pixel ratio, internal canvas resolution
- WebGL renderer/GPU, WebGL and shader versions, renderer limits, antialiasing
- Page build query, navigation timing, resource-entry count
- Game quality/settings, vehicle and installed parts, runtime/admin tuning
- Route/chunk/service/world counts and boot prewarm/map-build metrics

### Frame pacing

- Every frame contributes to an exact count/sum/min/max plus a 1 ms histogram
- Session p50, p95, p99, and p99.9
- Counts above 25, 33.34, 50, 100, and 250 ms
- Time accumulated beyond the 16.67 ms/60 FPS budget
- Per-mode and per-route frame distributions
- A sparse spike stream from 33.34 ms upward with location and game context

### CPU attribution

The existing per-frame game profiler is retained and expanded:

- physics
- traffic
- map update/streaming
- render submission
- save/persistence
- other synchronous game-loop work
- total profiled CPU time
- the remaining rAF gap

The report stores subsystem averages for every 250 ms window and the subsystem
breakdown of that window's worst frame. `raf_gap_ms` is the end-to-end frame
interval minus profiled synchronous CPU. It can include vsync waiting,
GPU/driver blocking, browser scheduling, background throttling, or OS
contention; it is not a pure GPU measurement.

### Renderer, scene, and memory

- Draw calls, triangles, lines, and points
- Live geometry, texture, and shader-program counts
- Resource-count deltas per window, plus session additions/removals
- Scene objects, meshes, visible-tree meshes, instances, lights, and materials
- JS heap used/total/limit where Chromium exposes `performance.memory`
- Heap start/end/peak/growth

Positive geometry, texture, or program deltas while driving are especially
useful: they can expose lazy uploads, content streaming, and shader compilation
that coincide with a hitch.

### Gameplay context

- Mode, route ID/name, area, position, heading, camera
- Speed, RPM, gear, throttle, brake, steering, handbrake, slip, surface grip
- Forward/lateral speed, yaw rate, longitudinal/lateral acceleration
- Steering angle, front/rear slip angles and tire saturation, wheel lock/spin
- Body roll/pitch, engine torque, drive force, and distance travelled
- Road lateral offset/width, on-road and tunnel flags
- Run score, combo, lives, fuel
- Active/visible traffic and car/van/truck mix
- Visible/total streamed chunks and current UI overlay

The game also emits sparse semantic events for near misses, collisions,
recoveries, score banking, garage/highway transitions, camera/settings changes,
traffic tuning, noclip changes, headlights, wasted runs, and manual markers.
The recorder independently captures window errors, unhandled promise
rejections, failed resources, console debug/info/log/warn/error calls, network
online/offline changes, WebGL context loss/restoration, page visibility changes,
and browser Long Tasks. Resource Timing entries created during the recording
are stored with duration, initiator, transfer/decoded size, and protocol.

## Timeline encoding

The high-frequency streams use tuple arrays to keep long recordings practical:

```json
{
  "timeline_columns": ["time_s", "interval_ms", "..."],
  "timeline": [[0.25, 250.1, "..."]],
  "spike_columns": ["time_s", "frame_ms", "..."],
  "spikes": [[4.82, 71.4, "..."]]
}
```

For each row, value `N` corresponds to column `N`. The report embeds
interpretation notes and the full column lists, so it is self-describing.

The timeline samples at 4 Hz and retains up to six hours. The spike stream
retains 12,000 rows; after that it uses reservoir sampling so a long slow
session is represented across its full duration instead of only at the start.
Dropped/replaced counts are reported in `summary.dropped_records`.

## Automatic summary

The JSON contains a precomputed summary with:

- overall, per-mode, and per-route distributions
- CPU subsystem averages
- renderer and heap growth
- Long Task totals
- event counts
- the 15 worst sampled windows with route, position, CPU cause, and GPU deltas
- conservative automatic signals for unstable pacing, dominant CPU subsystem,
  a large rAF gap, runtime GPU resource churn, heap growth, and Long Tasks

These signals are triage hints, not conclusions. Route/position repetition and
the raw timeline should be checked before changing game code.

## Command-line analysis

The repository includes a zero-dependency Markdown analyzer:

```powershell
npm run diagnostics:analyze -- "C:\path\to\hesi-diagnostic-....json"
```

It prints an executive summary, pacing and CPU tables, memory/Long Task data,
routes ranked by p95, worst windows, notable events, and sustained slow
windows. The raw JSON remains the authoritative source.

## Runtime cost

When hidden and not recording, each frame performs one `performance.now()`
call and one ring-buffer write. A profile object is only copied for a spike.

While recording:

- frame data is aggregated numerically each frame
- game state and renderer counters are sampled every 250 ms
- the scene graph is scanned at most once per second
- Long Tasks are received through `PerformanceObserver`
- console output and resources are captured only for the recording lifetime

No screenshots, GPU readbacks, synchronous disk writes, network uploads, or
per-frame JSON serialization occur. JSON serialization and download happen
only when recording stops.

## Files

- `js/debug-stats.js` — HUD, recorder, aggregation, summary, JSON/clipboard UI
- `styles/debug-stats.css` — isolated HUD, badge, and fallback-dialog styles
- `js/game.js` — frame profiler, metadata/snapshot callbacks, semantic events
- `.devtests/debug-stats-test.mjs` — browser regression for HUD and full export
- `tools/analyze-diagnostic.mjs` — offline Markdown analyzer

## Sharing and privacy

Reports contain device/browser capability data, the current page path/query,
game settings, vehicle configuration, resource paths, console output, and
recorded gameplay coordinates/events.
They do not intentionally include saved money, auctions, or unrelated browser
storage. Review a report before sharing it publicly if device or session
metadata is sensitive.
