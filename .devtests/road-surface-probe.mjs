/**
 * Focused adaptive-road and marking-phase regression probe.
 * Run: node .devtests/road-surface-probe.mjs
 */
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const dashCalls = [];
let activeDash = null;
const originalDashed = HighwayMap.prototype._paintDashedStrip;
const originalStrip = HighwayMap.prototype._paintStrip;
HighwayMap.prototype._paintDashedStrip = function patchedDashed(
  route, materialName, lateralAt, width, period, dashLength, phase,
) {
  const call = { routeId: route.id, period, dashLength, phase, intervals: [] };
  dashCalls.push(call);
  activeDash = call;
  try {
    return originalDashed.call(this, route, materialName, lateralAt, width, period, dashLength, phase);
  } finally {
    activeDash = null;
  }
};
HighwayMap.prototype._paintStrip = function patchedStrip(
  route, materialName, sStart, sEnd, lateralAt, width, lift,
) {
  if (activeDash) activeDash.intervals.push([sStart, sEnd]);
  return originalStrip.call(this, route, materialName, sStart, sEnd, lateralAt, width, lift);
};

const started = performance.now();
const map = new HighwayMap(null, {});
const buildMs = performance.now() - started;
HighwayMap.prototype._paintDashedStrip = originalDashed;
HighwayMap.prototype._paintStrip = originalStrip;

const clampDot = (value) => Math.max(-1, Math.min(1, value));
const angleDeg = (a, b) => Math.acos(clampDot(a.tangent.dot(b.tangent))) * 180 / Math.PI;
let frameCount = 0;
let segmentCount = 0;
let worstLength = { value: 0 };
let worstAngle = { value: 0 };
let worstRefinableAngle = { value: 0 };
let worstVertical = { value: 0 };
let worstLateral = { value: 0 };

for (const route of map.routes.values()) {
  const frames = route.renderFrames;
  frameCount += frames.length;
  const count = route.closed ? frames.length : frames.length - 1;
  for (let i = 0; i < count; i += 1) {
    const a = frames[i];
    const b = frames[(i + 1) % frames.length];
    const end = route.closed && i === frames.length - 1 ? route.length : b.distance;
    const span = end - a.distance;
    const angle = angleDeg(a, b);
    const location = { routeId: route.id, distance: a.distance, span };
    if (span > worstLength.value) worstLength = { value: span, ...location };
    if (angle > worstAngle.value) worstAngle = { value: angle, ...location };
    if (span > 3.001 && angle > worstRefinableAngle.value) {
      worstRefinableAngle = { value: angle, ...location };
    }
    for (const t of [0.25, 0.5, 0.75]) {
      const sample = map._frameAt(route, a.distance + span * t);
      for (const side of [-1, 0, 1]) {
        const startPoint = map._deckPoint(a, side * a.half);
        const endPoint = map._deckPoint(b, side * b.half);
        const analytic = map._deckPoint(sample, side * sample.half);
        const chord = startPoint.lerp(endPoint, t);
        const vertical = Math.abs(analytic.y - chord.y);
        const lateral = Math.hypot(analytic.x - chord.x, analytic.z - chord.z);
        if (span > 3.001 && vertical > worstVertical.value) {
          worstVertical = { value: vertical, ...location, t, side };
        }
        if (span > 3.001 && lateral > worstLateral.value) {
          worstLateral = { value: lateral, ...location, t, side };
        }
      }
    }
    segmentCount += 1;
  }
}

let phaseErrors = 0;
let intervalCount = 0;
for (const call of dashCalls) {
  intervalCount += call.intervals.length;
  for (let i = 0; i < call.intervals.length; i += 1) {
    const [start, end] = call.intervals[i];
    const center = (start + end) * 0.5;
    if (start > 0 && end < map.routes.get(call.routeId).length) {
      const cycles = (center - call.phase) / call.period;
      if (Math.abs(cycles - Math.round(cycles)) > 1e-7) phaseErrors += 1;
    }
    if (i > 0 && start > 0 && end < map.routes.get(call.routeId).length
      && call.intervals[i - 1][0] > 0 && call.intervals[i - 1][1] < map.routes.get(call.routeId).length) {
      const previous = call.intervals[i - 1];
      const previousCenter = (previous[0] + previous[1]) * 0.5;
      if (Math.abs(center - previousCenter - call.period) > 1e-7) phaseErrors += 1;
    }
  }
}

// Synthetic taper: the stripe becomes valid 70% into the span. The old
// endpoint-all-or-nothing check emitted no quad; clipping must emit z=7..10.
const syntheticRoute = {
  closed: false,
  renderFrames: [
    { distance: 0, position: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(1, 0, 0), bank: 0, half: 1 },
    { distance: 10, position: new THREE.Vector3(0, 0, 10), normal: new THREE.Vector3(1, 0, 0), bank: 0, half: 3 },
  ],
};
const taperQuads = [];
const savedBucket = map._bucket;
const savedPushQuad = map._pushQuad;
map._bucket = () => ({});
map._pushQuad = (_bucket, ...points) => taperQuads.push(points.map((point) => point.clone()));
map._paintStrip(syntheticRoute, 'marking', 0, 10, () => 2, 0.2);
map._bucket = savedBucket;
map._pushQuad = savedPushQuad;
const taperStart = taperQuads.length ? Math.min(...taperQuads[0].map((point) => point.z)) : null;

const result = {
  buildMs,
  frameCount,
  segmentCount,
  worstLength,
  worstAngle,
  worstRefinableAngle,
  worstVertical,
  worstLateral,
  dashCalls: dashCalls.length,
  dashIntervals: intervalCount,
  phaseErrors,
  taperQuadCount: taperQuads.length,
  taperStart,
};
console.log(JSON.stringify(result, null, 2));

const failures = [];
if (worstLength.value > 24.001) failures.push(`segment length ${worstLength.value.toFixed(3)} m`);
if (worstRefinableAngle.value > 3.01) failures.push(`tangent change ${worstRefinableAngle.value.toFixed(3)} deg`);
if (worstVertical.value > 0.0351) failures.push(`vertical chord error ${worstVertical.value.toFixed(4)} m`);
if (worstLateral.value > 0.3001) failures.push(`lateral chord error ${worstLateral.value.toFixed(4)} m`);
if (phaseErrors) failures.push(`${phaseErrors} dash phase errors`);
if (taperQuads.length !== 1 || Math.abs(taperStart - 7) > 1e-6) failures.push('taper clipping failed');
if (failures.length) {
  console.error(`FAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS road surface refinement + dash phase');
