# Driving feel — chase camera, cabin shake, top speed

Three changes, July 2026, all about how fast the car feels and how well you can
read it while it is moving.

## 1 · The chase camera backs off half as far — `js/game.js`

The chase view sits 6.2 m behind the car and drops further back the faster you
go, which is what sells speed. The rate was `speedKmh × 0.01`, so by 220 km/h
the camera had added 2.2 m and the car had shrunk into the middle of the frame —
exactly when its attitude matters most.

`CHASE_SPEED_PULLBACK` is now `.005`: **+1.1 m at 220 km/h instead of +2.2**.
The pull-back is still there and still grows with speed; there is just half as
much of it. The constant is used by both `updateCamera()` and
`snapDrivingCamera()`, so a camera change mid-drive does not jump.

Nothing else about the chase view moved — the look-ahead distance, the height,
the tunnel duck and the speed-driven FOV are untouched.

## 2 · Cabin shake in the first-person views — `game.updateCameraShake()`

From behind, the car body sells speed on its own. From the driver's seat there
is nothing between the player and a perfectly steady horizon, so the fastest
views were the calmest ones. `updateCameraShake(dt, t)` puts the eye back on a
car:

* **amplitude** — `pace × (0.42 + 0.58 × effort)`, where `pace` ramps from
  70 km/h to 190 km/h and `effort` combines throttle, slip and the handbrake.
  Coasting at 200 down a straight stays calm; a boosted, sliding exit rattles.
  Smoothed with a 6/s exponential so it never snaps on.
* **motion** — two incommensurable sines per axis (~9 Hz carrier, ~14 Hz
  partial) so they never line up into a visible pulse, and several frames per
  cycle at 60 fps so it never strobes.
* **size** — 18 mm of lateral and 14 mm of vertical head movement at full
  amplitude, plus a fraction of that on the aim point so the view *rotates* a
  little instead of only sliding.
* **scope** — cockpit at full strength, hood at 0.72 (it is a bonnet mount, not
  a head), chase never: the function returns `null` and zeroes the state.

## 3 · The playable car tops out at 220 km/h — `js/data.js`

Nothing declares top speed to the sim: it falls out of the torque curve, the
gearing and the drag area. `topSpeedKmh` was therefore only a claim, and a stale
one — the Suzume E90 declared 166 and actually did **182**.

Reaching 220 is a power problem and only a power problem. Drag alone asks for
~100 kW at the wheels up there, so no amount of regearing gets a 92 hp car
close; gearing only decides whether the engine runs out of revs first. The tune:

| | before | after |
| --- | --- | --- |
| power | 92 hp · 126 Nm | **168 hp · 229 Nm** |
| 5th gear | 0.81 | **0.76** (0.81 put 220 km/h past the redline) |
| `topSpeedKmh` | 166 | **220** |
| measured top speed | 182.3 km/h | **220.2 km/h**, in 5th, just under 6500 rpm |
| 0–100 km/h | 9.84 s | 6.45 s |

Redline, mass, drag, grip, brakes and the torque curve shape are unchanged, so
the car still teaches the same countersteer. It is simply no longer slow. The
acceleration change is a consequence of the requested top speed, not a separate
decision — the two cannot be moved independently in a sim with a real
drivetrain.

Upgrade parts still stack on top as designed; nothing caps the car at 220.

## Verification

```bash
node .devtests/top-speed-probe.mjs
```

Drives the playable car flat out on a flat road with the automatic box and
checks both that `topSpeedKmh` reads 220 **and** that the car actually gets
there (220.2 km/h, within 3 km/h). This is the probe to re-run after touching
power, gearing, mass or drag.

```bash
node .devtests/driving-camera-probe.mjs
```

8/8 — boots the real game and drives the camera with synthetic telemetry so the
numbers are deterministic: the chase pull-back still grows with speed but by
~1.0 m rather than ~2.2 m; the cockpit is bit-exactly steady at a standstill,
shakes while driving hard, and stays under 20 mm/frame; the hood camera shakes
less than the cockpit; the chase camera never shakes at all.
