# Driving feel

## Round 2 (July 2026) — the car slid, and could not be caught

Reported: the car breaks away in ordinary corners, the slide cannot be
recovered, weaving through traffic is hard, and the body sits at a silly angle
when turning. Four separate causes in `js/physics.js`, all of them found by
measuring rather than by feel.

### 1 · A held turn asked for more grip than the car had

The steering cap was `wheelbase × grip × g × 0.88 / u² + 0.024`. The trailing
0.024 rad is a fixed allowance, so at 100 km/h it *doubled* the angle the first
term had carefully computed. Worked through the understeer relation, holding the
button demanded:

| | old demand | new demand |
| --- | --- | --- |
| reference car (1120 kg, µ 1.00) | 100% of grip | 86% |
| starter car (940 kg, µ 0.94, soft springs) | **119%** of grip | 86% |

The reference car landed exactly on the limit, which is why the shipped grip
test passed; the lighter, softer car the player actually drives was 19% past it.
Every held corner was already a slide waiting for its trigger.

`steerCommand` now solves the steady-state relation directly —
`a_y × (L/u² + K/g)` at `STEER_GRIP_BUDGET` (0.86) of the tires' limit, with the
car's own understeer gradient `K`. It is right for every spec instead of for one,
and the 14% it leaves on the table is the margin the car spends on a bump, the
throttle or a lane change taken mid-corner.

### 2 · Counter-steer was capped at about 3 degrees

The same cap applied symmetrically, so once the car was sideways the driver
could ask for ~3° of opposite lock at 100 km/h against a 20° slide. The slide
was unrecoverable by construction, not by difficulty.

The budget is now measured from the **front axle's own velocity angle** rather
than from the chassis centreline, so the window opens toward the counter-steer
side by exactly the angle the slide is worth — up to full mechanical lock. It
opens only once the rear is genuinely past its slip peak (`slide`, measured in
multiples of the rear tires' own peak slip angle, so it scales with tire and
surface). Opening it during merely hard cornering was tried and reverted: the
car rotates into the turn, the window follows, and more lock becomes available —
a divergence, not a driving aid.

### 3 · The throttle was paying for the corner out of the lateral budget

168 hp through a 940 kg rear axle asks for **2.4× the rear tires' grip in 1st
and 1.4× in 2nd**. `_gripCircle` scaled the whole force vector down to fit,
which took the excess out of the *lateral* force — squeeze the throttle
mid-corner and the rear lost half its cornering grip in one frame with no
warning. Drive force is now capped at what is left of the driven axle's friction
circle (`TRACTION_HEADROOM` 1.18, so power-on rotation still exists), bypassed
entirely by the handbrake. Straight-line acceleration is unchanged — the
friction circle was already clipping it to the same number — so 0–100 is still
6.45 s and top speed is still 220 km/h.

### 4 · Tires broke away as a step, and nothing damped the spin

* **Progressive saturation.** Linear cornering stiffness clipped by a friction
  circle gives full grip on one frame and a scaled fraction on the next.
  `saturate()` rolls the same stiffness into its own limit: within 2% of linear
  to half the limit, 84% at the linear-limit slip, asymptotic beyond. Grip never
  disappears past the peak, it only stops growing.
* **Stability control** removes yaw the steering never asked for
  (`STABILITY_YAW_GAIN`), asleep below the rear slip peak and stood down to 25%
  under the handbrake.
* **Counter-steer assist** dials in 55% of the slide-cancelling angle, because a
  keyboard cannot modulate lock; cut to 15% when the driver is steering *into*
  the slide on purpose.
* **A sustainable-yaw bleed** replaces the flat ±2.2 rad/s clamp: past the yaw
  rate the tires could hold at that speed, the surplus decays instead of being
  clipped.

All three are gated by `settings.drivingAssist` (default 1, saved and clamped in
`save.js`). At 0 the car is handed back whole — the counter-steer *window* is
physics and stays open either way.

### 5 · Body roll was the load-transfer angle, not a body attitude

`rollTarget` was `a_lat × cgHeight / (g × trackWidth)` clamped at 0.28 rad. That
expression is how much weight moves across the track; using it as a lean angle
gave **16° of roll and 8° of dive**. Now a proper suspension gradient —
3.5°/g of roll, 1.6°/g of dive, divided by the suspension rate so upgrades lean
less — measuring 2.8° and 1.7° at the limit.

Note this is telemetry only today: nothing rotates the car mesh, `updatePlayerMesh()`
sets `rotation.y` and nothing else. If the visible lean was the complaint, the
lean to fix is the *drift* angle, which is items 1–4.

## Round 3 (July 2026) — follow-up on the same session

Three things were still wrong after Round 2.

### 6 · The brake was a steering aid

Reported: "at high speed it barely turns, but the moment I brake the steering
angle opens right up and it turns a huge amount." Exactly right, and the cause
was Round 2's own understeer gradient being fed the *transferred* axle loads.
Hard braking moves ~1.9 kN onto the front axle, which drove `K` up **5.8×** and
therefore doubled `steerCommand`:

| at 200 km/h | coasting | braking |
| --- | --- | --- |
| before | 1.86° | **3.53°** |
| after | 1.25° | 1.26° |

`K` is a property of the car, so it now comes from the **static** axle weights.
Braking no longer changes how much lock you may ask for — which is correct, as
the tires are already spending their circle on stopping.

### 7 · The steering was too limited, and turn-in was numb

Two changes, because they are two different things:

* **Budget** `STEER_GRIP_BUDGET` 0.86 → **0.94**. Round 2 cut the demand from
  119% to 86% of grip to stop the sliding; 94% keeps a real margin while giving
  the lock back.
* **Cornering stiffness** 68000/72000 → **105000/111000** N/rad. The old figures
  were about 60% of a real road tire, and a soft tire needs a big slip angle
  before it makes force. The car took **0.87 s to reach 0.8 g** at 140–200 km/h,
  which reads as "it barely turns" long before any grip runs out. Now 0.68–0.72 s
  for the same 0.8 g, at ~21 N/rad per newton of axle load.
* **Turn-in allowance** (`TURN_IN_BOOST` 0.55). The steady-state angle is what
  the *finished* corner needs; drivers turn in past it and unwind as the grip
  arrives. Extra lock is allowed while the lateral acceleration is still short
  of what was asked for, closing itself as the corner loads and shutting off
  once the rear slides — so the entry sharpens without the steady demand rising.

Knock-on: the 130 km/h lane change went from 3.9 m to **4.5 m** in the same
1.4 s, with peak drift *falling* from 3.7° to 3.1°.

### 8 · The shell did not move — `js/game.js`

`updatePlayerMesh()` set `rotation.y` and nothing else, so the car was a brick
that changed heading: no lean, no dive, no squat, and perfectly level up a ramp.
It now takes the roll and pitch the sim had been computing all along, plus the
gradient it is actually driving on.

The gradient is measured from the car's own motion (rise over horizontal
distance, smoothed at 5/s) rather than from a route tangent, so it is
sign-correct everywhere — ramps, the PA, terrain — without assuming which way
the route runs. A null `dt` means a teleport and restarts the tracker instead of
pitching the car through the jump.

Signs are the trap here: the model faces backwards (`yaw + PI`), so its local
+X points to the car's **left** and its local −Z is the **nose**. Roll takes the
physics value as-is, pitch takes the opposite, and the Euler order is `YXZ` so
pitch and roll act on the car's own axes rather than on world ones.

### Verification

```bash
node .devtests/handling-probe.mjs
```

16/16 on the real starter car: full throttle and full lock at 80 km/h peaks at
1.7° of drift instead of swapping ends; a handbrake slide provoked to 22° is
caught back to 0° by blunt keyboard input; with assists off 36° of opposite lock
is available and the slide stays bounded; a 130 km/h lane change moves 4.5 m in
1.4 s at 3.1° of drift and settles to zero yaw; braking changes the available
lock by under 3% at 140 and 200 km/h; roll 3.3° leaning outward, dive 1.7°.

```bash
node .devtests/body-attitude-probe.mjs
```

16/16 — boots the real game and drives the real `updatePlayerMesh()` with
synthetic vehicle state (the same trick `driving-camera-probe.mjs` uses, and the
reason it is deterministic), then checks world-space nose and roof vectors at
two headings: a right-hander leans the roof outward to the left, braking dives
the nose, accelerating lifts it, a climb points it up the slope, and a teleport
does not fling the body. Note the car cannot be driven for real in this probe —
stepping `updateDriving()` by hand leaves it pinned at the spawn point, revving
in 2nd at 0.1 km/h.

`node .devtests/grip-test.mjs` still 12/12. `node .devtests/top-speed-probe.mjs`
2/2 unchanged (220.2 km/h, 0–100 in 6.45 s — the traction cap does not touch
straight-line acceleration, because the friction circle was already clipping it
to the same number). `node .devtests/e2e.mjs` is 38/42, the same four
pre-existing failures as before this work (two layout overlaps, an auction swap,
and a touch-steer check that already failed on a clean baseline).

Module versions were bumped so the change actually reaches the player past the
service worker: `physics.js?v=20260727a`, `game.js?v=20260727a`, cache `v56`.

---

## Round 2 verification (superseded by Round 3 above)

`handling-probe.mjs` was 14/14 at this point: 2.1° peak drift on the power-on
corner, an 18° slide caught back to 0°, a 3.9 m lane change, roll 2.8°.

---

## Round 1 — chase camera, cabin shake, top speed

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
