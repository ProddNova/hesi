/**
 * Does a road edit made in the editor survive to the built world unchanged?
 *
 * Three things used to go wrong and this probe pins all of them:
 *
 * 1. WYSIWYG — the editor previewed the raw control points while a world build
 *    re-blended a ramp's endpoints onto its host (_anchorEndpoint), so the road
 *    "did not move" where the user was looking. HighwayMap.applyEditorDataRouteEdit
 *    now runs that same blend, so the live preview must equal a fresh build.
 * 2. Deliberate synthetic-route edits (the Tatsumi PA connectors) were dropped
 *    by a staleness heuristic as soon as ANY edit to the host ramp regenerated
 *    them — the routes "came back" on the next load.
 * 3. A deleted road has to stay deleted: no geometry, no collision, no traffic.
 *
 * Run: node .devtests/road-editor-draft-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HighwayMap, getRouteNetworkData } from '../js/map.js';

const DRAFT = fileURLToPath(new URL('../data/editor/road-route-overrides.json', import.meta.url));
const draft = JSON.parse(readFileSync(DRAFT, 'utf8'));
const production = getRouteNetworkData();

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`);
};
const silently = (run) => {
  const warn = console.warn;
  const info = console.info;
  const lines = [];
  console.warn = console.info = (...args) => lines.push(args.join(' '));
  try { return { value: run(), lines }; } finally { console.warn = warn; console.info = info; }
};

// ---- 1. The editor's live edit equals what the next world build produces ----

const EDIT_ROUTE = 'ramp_30';
const SHIFT = 35;

const baseline = silently(() => new HighwayMap(null, { quality: 'low' })).value;
const target = baseline.routes.get(EDIT_ROUTE);
const dataRoute = production.routes.find((route) => route.id === EDIT_ROUTE);
check(`${EDIT_ROUTE} exists in both the runtime and the route document`, Boolean(target && dataRoute));

// The editor edits the DATA polyline and hands the runtime the same points
// reversed and Y-lifted, exactly like RoadEditController._runtimePointArrays.
const yOffset = baseline.roadNetworkYOffset;
const editedData = dataRoute.points.map((point) => [...point]);
const midpoint = Math.floor(editedData.length / 2);
editedData[midpoint][0] += SHIFT;
const runtimePoints = [...editedData].reverse().map((point) => [point[0], point[1] + yOffset, point[2]]);

check('applyEditorDataRouteEdit accepted the edit', baseline.applyEditorDataRouteEdit(EDIT_ROUTE, runtimePoints));
const preview = baseline.routes.get(EDIT_ROUTE).points.map((point) => point.toArray());

// Now build a world where that same edit is the published data, the way the
// editor's own draft load does it, and compare the resulting centreline.
dataRoute.points = editedData;
const rebuilt = silently(() => new HighwayMap(null, { quality: 'low' })).value;
const built = rebuilt.routes.get(EDIT_ROUTE).points.map((point) => point.toArray());

let worst = 0;
if (preview.length !== built.length) {
  check('live preview has the same control points as the build', false, `${preview.length} preview vs ${built.length} built`);
} else {
  for (let index = 0; index < preview.length; index += 1) {
    worst = Math.max(worst, Math.hypot(
      preview[index][0] - built[index][0],
      preview[index][1] - built[index][1],
      preview[index][2] - built[index][2],
    ));
  }
  check('live preview matches the rebuilt world centreline', worst < 0.05, `worst point ${worst.toFixed(4)} m apart`);
}

// The moved handle must actually reach the built world, not be blended away.
const movedInBuild = built.some((point) => Math.abs(point[0] - (dataRoute.points[midpoint][0])) < 0.5
  && Math.abs(point[2] - dataRoute.points[midpoint][2]) < 0.5);
check('the moved control point survives into the built road', movedInBuild, `${SHIFT} m shift on point ${midpoint}`);

// ---- 2. Saved synthetic-route edits are honoured, not silently reverted ----

const syntheticDraft = draft.syntheticRoutes || {};
production.meta ??= {};
production.meta.editorRoadOverrides = { ...(production.meta.editorRoadOverrides || {}), syntheticRoutes: structuredClone(syntheticDraft) };
const withSynthetic = silently(() => new HighwayMap(null, { quality: 'low' }));
for (const [id, entry] of Object.entries(syntheticDraft)) {
  const route = withSynthetic.value.routes.get(id);
  if (!route) { check(`synthetic ${id}`, false, 'route not in the built map'); continue; }
  const gap = Math.hypot(
    entry.points[0][0] - route.points[0].x,
    entry.points[0][1] - route.points[0].y,
    entry.points[0][2] - route.points[0].z,
  );
  check(`saved edit to ${id} is applied`, gap < 0.1, `start point ${gap.toFixed(2)} m from the saved one`);
}
check(
  'no saved synthetic edit is skipped as stale',
  !withSynthetic.lines.some((line) => line.includes('skipped')),
  withSynthetic.lines.filter((line) => line.includes('skipped')).join(' | '),
);

// ---- 3. A deleted road leaves the world, the index and the traffic ----

const REMOVED = 'ramp_14';
production.meta.editorRoadOverrides.removedRoutes = [REMOVED];
const withRemoval = silently(() => new HighwayMap(null, { quality: 'low' })).value;
const removedRoute = withRemoval.routes.get(REMOVED);
check(`${REMOVED} is still registered (edges reference it)`, Boolean(removedRoute));
check(`${REMOVED} is flagged removed`, removedRoute?.removed === true);
const onRemoved = removedRoute.curve.getPointAt(0.5);
check(`${REMOVED} is no longer drivable`, !withRemoval.isPointDrivable(onRemoved.clone()));
check(`${REMOVED} carries no traffic lanes`, !withRemoval.getTrafficLanes().some((lane) => lane.routeId === REMOVED));
check(`${REMOVED} is off the minimap`, !withRemoval.getMinimapData().routes.some((route) => route.id === REMOVED));
check(`${REMOVED} emitted no geometry`, !withRemoval._routeEmissionRanges.has(REMOVED));

// ---- 4. The live geometry rebuild is reversible and actually changes meshes --

const live = withRemoval;
const signature = () => {
  let sum = 0;
  live.group.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh) return;
    const array = object.geometry?.attributes?.position?.array;
    if (!array) return;
    for (let index = 0; index < array.length; index += 997) sum += array[index];
  });
  return sum;
};
const before = signature();
check('erasing a route changes the baked chunk meshes', live._eraseBakedRouteGeometry('ramp_2') && signature() !== before);
check('restoring it puts them back byte for byte', live._restoreBakedRouteGeometry('ramp_2') && Math.abs(signature() - before) < 1e-6);
const started = Date.now();
check('refreshEditorRouteGeometry emits a live group', live.refreshEditorRouteGeometry('ramp_2'));
let liveMeshes = 0;
live._editorRouteGeometry.get('ramp_2')?.traverse((object) => { if (object.isMesh) liveMeshes += 1; });
check('the live group carries real road meshes', liveMeshes > 0, `${liveMeshes} meshes in ${Date.now() - started} ms`);
check('clearing it restores the baked geometry', live.clearEditorRouteGeometry('ramp_2') && Math.abs(signature() - before) < 1e-6);

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all road editor checks passed'}`);
process.exit(failures ? 1 : 0);
