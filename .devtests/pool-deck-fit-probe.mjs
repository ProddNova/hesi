/**
 * Do the lamp light pools actually lie ON the asphalt?
 *
 * Each pool is a big flat additive quad (up to 19 x 55 m). Where it sinks BELOW
 * the deck it is depth-occluded, and because a plane cutting a plane produces a
 * straight line, the player sees a hard straight light/dark edge across the
 * road — reported as "the light disappears and leaves an annoying line", and on
 * a grade as light "steps" (gradoni) that do not follow the surface.
 *
 * This probe samples a grid over every pool's footprint and reports how much of
 * it is buried, for three orientations in ONE run:
 *   old  — yawQuaternion only (heading; grade thrown away)   [the old bug]
 *   new  — surfaceQuaternion (heading + grade)
 *   sag  — surfaceQuaternion + the per-lamp sag clearance    [what ships]
 *
 * Regression guard: `SHIPPED` should stay near ~2% buried samples with almost
 * nothing deeper than 25 cm. Headless — no browser, no server.
 *
 * Run: node .devtests/pool-deck-fit-probe.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const EPS = 1e-5;

function yawQuat(t, target = new THREE.Quaternion()) {
  const flat = new THREE.Vector3(t.x, 0, t.z);
  if (flat.lengthSq() < EPS) return target.identity();
  flat.normalize();
  return target.setFromUnitVectors(FORWARD, flat);
}
function surfaceQuat(t, target = new THREE.Quaternion()) {
  const fwd = t.clone();
  if (fwd.lengthSq() < EPS) return target.identity();
  fwd.normalize();
  const up = UP.clone().addScaledVector(fwd, -UP.dot(fwd));
  if (up.lengthSq() < EPS) return yawQuat(t, target);
  up.normalize();
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  return target.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd));
}
const horizNormal = (t) => new THREE.Vector3(-t.z, 0, t.x).normalize();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lampNoise = (seed) => {
  let h = (Math.floor(seed) * 374761393 + 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const map = new HighwayMap(null, {});

const BINS = [0.02, 0.05, 0.1, 0.25, 0.5, 1, Infinity];
const blank = () => ({ samples: 0, clipped: 0, worst: 0, sumClip: 0, poolsWithClip: 0, worstAt: null, hist: BINS.map(() => 0) });
const stats = { old: blank(), new: blank(), sag: blank() };
const lifts = [];
const worstSpots = [];
let pools = 0;

// Deck height at an arbitrary world XZ, sampled on the pool's own route.
// `expectDistance`/`maxSlip` reject hairpin mis-projections: on a tight loop
// ramp a point 25 m along the quad can project onto a totally different part of
// the same curve, which would report a bogus multi-metre "burial".
function deckYAt(route, worldPoint, hintIndex, expectDistance = null, maxSlip = Infinity) {
  const projection = map._projectToRoute(route, worldPoint, hintIndex);
  if (expectDistance !== null && Math.abs(projection.distance - expectDistance) > maxSlip) return null;
  const c = map._sampleCenter(route, projection.distance, 1);
  const frame = {
    position: c.position, tangent: c.baseTangent, normal: horizNormal(c.baseTangent),
    bank: map._bankAt(route, projection.distance), route, distance: projection.distance,
  };
  // Off the paved edge there is no asphalt to clip against.
  const half = map._halfWidthAt(route, projection.distance);
  if (Math.abs(projection.signedLateral) > half) return null;
  return map._deckPoint(frame, projection.signedLateral, 0).y;
}

for (const route of map.routes.values()) {
  if (!route.curve || !(route.length > 0)) continue;
  const isService = route.kind === 'service';
  const isRamp = route.kind === 'ramp';
  const lampStep = isService ? 55 : (isRamp ? 70 : 42);
  let lampSide = 1;
  for (let distance = lampStep * 0.4; distance < route.length; distance += lampStep) {
    const center = map._sampleCenter(route, distance, 1);
    const half = map._halfWidthAt(route, distance);
    if (map._isTunnel(route, distance)) continue;
    const rawFrame = {
      position: center.position, tangent: center.baseTangent,
      normal: horizNormal(center.baseTangent), bank: map._bankAt(route, distance),
    };
    // `frame` = what the decals now use (carries the progressive deck offset).
    const frame = { ...rawFrame, route, distance };
    const side = route.bidirectional ? (lampSide *= -1) : 1;
    const base = map._deckPoint(rawFrame, side * (half - 0.62), 0.01);
    if (map._barrierSuppressed(base, route)) continue;

    const jL = lampNoise(distance);
    const jW = lampNoise(distance * 1.7 + 41);
    const jY = lampNoise(distance * 2.3 + 7);
    const poolLen = lampStep * (1.2 + jL * 0.2);
    const poolWidth = clamp(half * (1.38 + jW * 0.3), 13, 19);
    const poolOffset = side * (half - poolWidth * 0.4) + (jW - 0.5) * 1.6;
    const tangentN = center.baseTangent.clone().normalize();
    const bankQuat = new THREE.Quaternion().setFromAxisAngle(tangentN, -frame.bank);
    const yawJitter = new THREE.Quaternion().setFromAxisAngle(UP, (jL - 0.5) * 0.2);
    const poolCenter = map._deckPoint(frame, poolOffset, 0.14)
      .addScaledVector(frame.tangent, (jY - 0.5) * 4);

    // Shipped sag clearance: probe the deck at both ends and lift clear of it.
    const planeRise = center.baseTangent.y / Math.max(EPS, center.baseTangent.length());
    const baseY = map._deckPoint(frame, poolOffset, 0).y;
    let sag = 0;
    for (const end of [-0.5, 0.5]) {
      const span = end * poolLen;
      const endDistance = distance + span;
      if (endDistance < 0 || endDistance > route.length) continue;
      const ec = map._sampleCenter(route, endDistance, 1);
      const ef = {
        position: ec.position, tangent: ec.baseTangent,
        normal: horizNormal(ec.baseTangent), bank: map._bankAt(route, endDistance),
        route, distance: endDistance,
      };
      sag = Math.max(sag, map._deckPoint(ef, poolOffset, 0).y - (baseY + planeRise * span));
    }
    const sagLift = Math.min(0.4, sag);
    lifts.push(sagLift);

    const variants = {
      old: { q: yawQuat(center.baseTangent).multiply(yawJitter.clone()).premultiply(bankQuat.clone()), lift: 0 },
      new: { q: surfaceQuat(center.baseTangent).multiply(yawJitter.clone()).premultiply(bankQuat.clone()), lift: 0 },
      sag: { q: surfaceQuat(center.baseTangent).multiply(yawJitter.clone()).premultiply(bankQuat.clone()), lift: sagLift },
    };
    pools += 1;
    const hint = map._projectToRoute(route, poolCenter).index;
    const perVariant = {};
    for (const [key, { q: quat, lift }] of Object.entries(variants)) {
      let clippedHere = false;
      let worstHere = 0;
      for (let iz = -3; iz <= 3; iz += 1) {
        for (let ix = -2; ix <= 2; ix += 1) {
          const local = new THREE.Vector3((ix / 4) * poolWidth, 0, (iz / 6) * poolLen).applyQuaternion(quat);
          const world = poolCenter.clone().add(local);
          world.y += lift;
          const deckY = deckYAt(route, world, hint, distance, poolLen * 0.75 + 12);
          if (deckY === null) continue;
          const deviation = world.y - deckY; // >0 above asphalt (visible), <0 buried
          const s = stats[key];
          s.samples += 1;
          if (deviation < 0) {
            s.clipped += 1;
            s.sumClip += -deviation;
            clippedHere = true;
            s.hist[BINS.findIndex((b) => -deviation <= b)] += 1;
            if (-deviation > worstHere) worstHere = -deviation;
            if (-deviation > s.worst) { s.worst = -deviation; s.worstAt = world.clone(); }
          }
        }
      }
      if (clippedHere) stats[key].poolsWithClip += 1;
      perVariant[key] = worstHere;
    }
    // Pools the fix helps most: deep burial before, clean after -> best A/B shots.
    if (perVariant.old > 0.6 && perVariant.sag < 0.06) {
      worstSpots.push({ route: route.id, distance, oldBurial: perVariant.old, newBurial: perVariant.sag });
    }
  }
}

console.log(`pools evaluated: ${pools}\n`);
const LABEL = { old: 'OLD (yaw-only)   ', new: 'surface-fit only ', sag: 'SHIPPED (fit+sag)' };
for (const key of ['old', 'new', 'sag']) {
  const s = stats[key];
  const label = LABEL[key];
  console.log(`${label}  buried samples: ${String(s.clipped).padStart(6)}/${s.samples} (${(100 * s.clipped / s.samples).toFixed(2)}%)`);
  console.log(`${' '.repeat(19)}  pools showing a hard edge: ${s.poolsWithClip}/${pools} (${(100 * s.poolsWithClip / pools).toFixed(1)}%)`);
  console.log(`${' '.repeat(19)}  worst burial: ${s.worst.toFixed(3)} m   mean burial: ${(s.sumClip / Math.max(1, s.clipped)).toFixed(3)} m`);
  if (s.worstAt) console.log(`${' '.repeat(19)}  worst at x=${s.worstAt.x.toFixed(0)} y=${s.worstAt.y.toFixed(1)} z=${s.worstAt.z.toFixed(0)}`);
  const labels = ['<2cm', '<5cm', '<10cm', '<25cm', '<50cm', '<1m', '>1m'];
  console.log(`${' '.repeat(19)}  burial depth: ${s.hist.map((n, i) => `${labels[i]}:${n}`).join('  ')}`);
  console.log('');
}
lifts.sort((a, b) => b - a);
const nonZero = lifts.filter((v) => v > 0.001).length;
console.log(`sag lift applied: ${nonZero}/${lifts.length} pools (${(100 * nonZero / lifts.length).toFixed(1)}%)`);
console.log(`  mean lift (where applied): ${(lifts.reduce((s, v) => s + v, 0) / Math.max(1, nonZero)).toFixed(3)} m`);
console.log(`  capped at 0.4 m: ${lifts.filter((v) => v >= 0.3999).length} pools`);
console.log(`  largest lifts: ${lifts.slice(0, 8).map((v) => v.toFixed(2)).join(', ')}`);

// Worst offenders the fix rescues, handy as camera targets when eyeballing it.
worstSpots.sort((a, b) => b.oldBurial - a.oldBurial);
const picked = [];
const seen = new Map();
for (const spot of worstSpots) {
  const n = seen.get(spot.route) || 0;
  if (n >= 2) continue;
  seen.set(spot.route, n + 1);
  picked.push(spot);
  if (picked.length >= 6) break;
}
console.log('\nsteepest cases the fix rescues (drive/park here to eyeball it):');
for (const s of picked) console.log(`  ${s.route} @ ${s.distance.toFixed(0)} m — was buried ${s.oldBurial.toFixed(2)} m, now ${s.newBurial.toFixed(3)} m`);
