/**
 * Which kerb does each lamp row stand on?
 *
 * Builds the map headless, captures every `lamppost:concrete` placement, then
 * projects it onto its owning route (signed lateral: + = right of travel) and,
 * where a twin carriageway runs alongside, reports whether that kerb faces the
 * twin (inner, i.e. the median gap) or away from it (outer flank).
 *
 * Expected after the 29 Jul 2026 change: one row per carriageway, overwhelmingly
 * "awayFromTwin".
 *
 * Run: node .devtests/lamp-side-probe.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const lamps = [];
class ProbeMap extends HighwayMap {
  _instance(position, scale, quaternion = null, color = null, type = 'box:concrete') {
    if (type === 'lamppost:concrete') lamps.push(position.clone());
    return super._instance(position, scale, quaternion, color, type);
  }
}
const map = new ProbeMap(null, {});
console.log('lampposts:', lamps.length);

const routes = [...map.routes.values()];
const byGroup = new Map();
for (const route of routes) {
  if (!byGroup.has(route.group)) byGroup.set(route.group, []);
  byGroup.get(route.group).push(route);
}

const tally = new Map();
for (const position of lamps) {
  let best = null;
  for (const route of routes) {
    const projection = map._projectToRoute(route, position);
    const lateral = projection.signedLateral;
    if (!best || Math.abs(lateral) < Math.abs(best.lateral)) best = { route, lateral };
  }
  if (!best) continue;
  const key = best.route.id;
  if (!tally.has(key)) tally.set(key, { left: 0, right: 0, kind: best.route.kind, inner: 0, outer: 0 });
  const row = tally.get(key);
  if (best.lateral > 0) row.right += 1; else row.left += 1;

  // Inner/outer relative to the twin carriageway of the same corridor.
  let twin = null;
  for (const other of byGroup.get(best.route.group) || []) {
    if (other === best.route || other.kind === 'ramp') continue;
    const projection = map._projectToRoute(other, position);
    const distance = projection.point.distanceTo(position);
    if (!twin || distance < twin.distance) twin = { distance, point: projection.point };
  }
  if (twin && twin.distance < 70) {
    const centre = map._projectToRoute(best.route, position).point;
    const toTwin = twin.point.clone().sub(centre);
    const toLamp = position.clone().sub(centre);
    toTwin.y = 0; toLamp.y = 0;
    if (toTwin.dot(toLamp) > 0) row.inner += 1; else row.outer += 1;
  }
}

const rows = [...tally.entries()].sort((a, b) => (b[1].left + b[1].right) - (a[1].left + a[1].right));
for (const [id, row] of rows.slice(0, 20)) {
  console.log(`${id.padEnd(14)} ${row.kind.padEnd(9)} left=${String(row.left).padStart(4)} right=${String(row.right).padStart(4)}`
    + `  towardTwin=${String(row.inner).padStart(4)} awayFromTwin=${String(row.outer).padStart(4)}`);
}
const totals = rows.reduce((acc, [, row]) => {
  acc.left += row.left; acc.right += row.right; acc.inner += row.inner; acc.outer += row.outer; return acc;
}, { left: 0, right: 0, inner: 0, outer: 0 });
console.log('TOTAL', totals);
