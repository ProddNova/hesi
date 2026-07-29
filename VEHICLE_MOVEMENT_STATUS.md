# VEHICLE MOVEMENT STATUS — 29 Jul 2026

A new dev panel on **key 8**, in the vehicle laboratory: **MOVIMENTI**, the way
the player's car MOVES while driving. Fifty-five dials over eight sections — how
far the body leans in a corner and how fast it gets there, ride height and
spring rates, the wheel's speed and its return to centre, grip and front/rear
balance, where a slide starts and how hard the assists fight it, yaw inertia and
damping, brakes, engine braking, shift points, drag.

Three things make it a feature rather than a slider box:

1. **The numbers now exist in one place.** Every one of them used to be a module
   constant in `js/physics.js` or a bare literal inside a substep.
2. **Live, mid-corner.** The panel does not freeze the drive — it is docked to
   the left edge and the car keeps going while you drag.
3. **The tuned car is the shipped car.** The record is published in
   `data/editor/custom-assets.json` beside the camera and picture tuning, so what
   is tuned in the test game is what everybody downloads.

Probes: `node .devtests/movement-tuning-probe.mjs` — **59/59**;
`node .devtests/movement-menu-probe.mjs` — **18/18**.
Regression: `node .devtests/handling-probe.mjs` — **18/18**,
`node .devtests/grip-test.mjs` — **12/12**,
`node .devtests/debug-stats-test.mjs` — **32/32**.

---

## 1. The record — `js/vehicle-movement.js`

One entry per dial, with a range, a step, a unit and a default:

```js
{ key: 'rollPerGDeg', group: 'body', label: 'INCLINAZIONE IN CURVA', min: -8, max: 20, step: 0.05, unit: '°/g' }
```

`MOVEMENT_GROUPS` gives the panel its sections, `MOVEMENT_FIELDS` its sliders,
`normalizeMovement()` is the clamp every load path goes through, and
`movementSignature()` is the published-revision id. The module is the same shape
as `js/ps2-filter.js` and `js/playground-config.js` on purpose: those two already
solved "an authored record with ranges, defaults, presets and a publish route",
and a third pattern would just be a third thing to learn.

Angles are authored in **degrees** — a lean or a dive is not discussable in
radians — and physics multiplies by `DEG` at the point of use. The keys say so
(`rollPerGDeg`, `diveLimitDeg`), so a unit mix-up cannot hide.

### What replaced what

| Was, in `js/physics.js` | Is now |
| --- | --- |
| `ROLL_GRADIENT = 0.061` | `rollPerGDeg: 3.5` |
| `PITCH_GRADIENT = 0.028` | `divePerGDeg: 1.6` |
| `clamp(…, -0.1, 0.1)` | `rollLimitDeg: 5.75` |
| `clamp(…, -0.055, 0.05)` | `squatLimitDeg: 3.15` / `diveLimitDeg: 2.85` |
| `-dt * (5 + suspensionFactor * 3)` | `bodyResponse: 5` + `bodyResponseStiffness: 3` |
| `STEER_GRIP_BUDGET = 0.94` | `steerGripBudget: 0.94` |
| `TURN_IN_BOOST` / `DIRECTION_CHANGE_BOOST` | `turnInBoost` / `directionChangeBoost` |
| `steerCommand / 0.26`, `0.55`, `* 4` | `steerBuildTime` / `steerRateFloor` / `steerCatchGain` |
| `exp(-dt * (5.5 + speed * 0.035))` | `steerReturnRate` / `steerReturnSpeedGain` |
| `SLIDE_ONSET` / `SLIDE_RANGE` | `slideOnset` / `slideRange` |
| `COUNTER_STEER_ASSIST` / `STABILITY_YAW_GAIN` / `TRACTION_HEADROOM` | `counterSteerAssist` / `stabilityYawGain` / `tractionHeadroom` |
| `mass * (a² + b²) * 0.72` | `inertiaScale: 0.72` |
| `exp(-dt * (0.32 + 2.6 + 5))` | `yawDamping` / `impactYawDamping` / `parkedYawDamping` |
| `… / max(5, speed) * 1.7 + 0.22` | `yawLimit` / `yawLimitFloor` |
| `error * 95 - velocity * 17` | `surfaceSpring` / `surfaceDamping` |
| `lerp(0.42, 1, …)` | `launchBite` |
| `redline * lerp(0.72, 0.94, throttle)` | × `upshiftRPM` |
| `dragArea * 0.7` (lateral) | `lateralDrag` |
| `clamp(atan2(…), -.2, .2)`, `-dt * 5` in `updateBodyClimb` | `slopeLimitDeg` / `slopeSmoothing` / `slopeFollow` |

Everything the car itself owns — mass, power, tire grip, brake force, its own
suspension rate — stays in `js/data.js` and the Car Modeler. These are the global
gradients and response rates applied on top, which is why most of them are
multipliers: one setting reads the same on a 90 hp starter car and on a tuned
one.

### The defaults are the old behaviour

`DEFAULT_MOVEMENT` reproduces the driving the game shipped with, and the probe
measures it rather than trusting it: 3.5°/g of roll and 1.6°/g of dive at the
stock suspension rate, the same steering budget, the same yaw ceiling. The
angles are the old radian constants rounded to the sliders' step (0.061 rad/g =
3.4951°/g, authored as 3.5) — 0.14% of the lean angle, under a tenth of a degree
at the limit.

`handling-probe.mjs` and `grip-test.mjs` pass unchanged, with the same numbers in
their output, which is the real check: an untuned car drives exactly as before.

---

## 2. The panel — `MOVIMENTI // 8`

Built by `setupMovementMenu()` in `js/game.js` from the groups and fields, not
written out in `index.html`: fifty-five labelled dials in eight sections is
exactly the kind of table that goes stale the moment it exists twice. The HTML is
a header, a preset row, a status row and two empty containers.

**It does not freeze the drive.** DEBUG (0) and FILTRO (9) are centred and take
`debug.menuOpen`, which stops `updateDriving`; that is fine for image dials,
because the image is still on screen. A lean, a dive or a turn-in rate can only
be judged while the car is going round something, so this panel is docked left,
leaves the road and the playground's own panel visible, and keeps the keys
driving. The browser probe asserts the contrast: a second of throttle moves the
car 2.3 m with MOVIMENTI open and 0.000 m with FILTRO open.

Live-drag / commit-on-release, like every other dev slider here: dragging
retunes the running car (`physics.setMovementTuning()` swaps a plain object of
numbers, so position, velocity and current body attitude are untouched),
releasing writes the save and queues the publish.

Six presets — `STOCK`, `MORBIDO`, `RIGIDO`, `DRIFT`, `ARCADE`, `CRUDO` — are
applied as whole records: anything a preset does not name goes back to the
shipped value, so a preset is an answer rather than a patch on whatever was on
the dials. `STOCK` doubles as RESET.

### Where it is offered

`canTuneMovement()` — the editor test game (`?editorTest`) or the playground. It
retunes the driving for everyone once published, so it is not something to hand a
player mid-run: on a normal boot key 8 does nothing and the debug menu's
"APRI MOVIMENTI" row is hidden. The playground panel also carries an
`APRI MOVIMENTI // 8` button, so a touch device can reach it.

---

## 3. Publishing

`runtimeTuning.movement` in `data/editor/custom-assets.json`, next to
`runtimeTuning.camera` and `runtimeTuning.picture`, written by the panel's
`SALVA NEL GIOCO` (and by the playground panel's own save, which now carries the
movement record too — a panel that saves "everything the playground tunes" must
not quietly leave it behind).

Adoption is signature-gated exactly like the picture: a client takes a published
record **once per revision** (`state.movementRevision`). Adopting on every boot
would mean the panel could not hold a value across a reload, which is the one
thing a live tuning panel has to do; adopting never would mean a deploy changes
nothing for anyone who has played before, which is the point of publishing.

The section is absent from the shipped document until something is published —
`movementFromDocument()` returns `null` rather than a default, so "nothing was
published" and "the defaults were published" stay distinguishable, and the code
defaults apply.

---

## 4. Probes

`movement-tuning-probe.mjs` (node, no browser) covers the record — clamping,
normalizing rubbish, presets, signature, document round-trip — the defaults
against the old constants, and then one measurement per group: the lean scales
and can be inverted (a negative gradient leans the body INTO the corner), the
limits cap, the response rate decides how fast the lean arrives, ride height
moves the car, a stiff spring follows a step faster, a short build time moves the
wheel faster, the grip and balance dials move the cornering limit and the
rotation, the assists decide how much of a slide is handed back, brakes stop,
shift points move, drag and grades cost speed.

Its last section is the one that matters most for a panel this size: **every dial
is driven to both ends of its range through nine manoeuvres and has to change at
least one of them.** A slider wired to nothing is worse than no slider — it
advertises a parameter that is not there — and this makes that a failing test
rather than a surprise for whoever is tuning. The three slope dials are excluded
by name, because they are read by `game.js updateBodyClimb` (they pitch the
shell on a gradient, which the sim has no opinion about) and are covered by
`body-attitude-probe.mjs`.

`movement-menu-probe.mjs` (browser) covers the half that only exists in a page:
the key, the generated sections and sliders, a drag reaching the running car, the
readouts, presets and reset, the drive continuing, the value surviving a reload,
and key 8 doing nothing in a normal game.
