import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOverrides, fairRoute, buildSmoothedData, resolveAnchor,
  cumLengths, polylineAt, projectToPolyline, DEFAULT_PARAMS,
} from '../lib/fairing.mjs';
import { analyzeRouteEdit } from '../lib/analysis.mjs';
import { makeFixtureData } from './helpers.mjs';

const data = makeFixtureData();
const routeA = data.routes.find((r) => r.id === 'test_a');
const ctx0 = { data, overrides: null, params: DEFAULT_PARAMS };

// current processed dataset for analysis: the no-override full build
const { out: smoothedFixture } = buildSmoothedData(data, { params: DEFAULT_PARAMS });

function moveOpAt(station, dx, dz, extra = {}) {
  const cum = cumLengths(routeA.points, false);
  const p = polylineAt(routeA.points, cum, false, station);
  return {
    id: `t_${station}`,
    op: 'move',
    anchor: { station, point: [p[0], p[2]], tolerance: 15 },
    to: [p[0] + dx, p[2] + dz],
    influence: 60,
    weight: 30,
    ...extra,
  };
}

test('stable matching: anchors survive resampling of the raw route', () => {
  const cum = cumLengths(routeA.points, false);
  const anchor = { station: 480, point: null, tolerance: 15 };
  const p = polylineAt(routeA.points, cum, false, 480);
  anchor.point = [p[0], p[2]];

  // resolve on the original geometry
  const r1 = resolveAnchor(anchor, routeA.points, cum, false);
  assert.equal(r1.ok, true);
  assert.ok(Math.abs(r1.s - 480) < 1, `station ${r1.s}`);

  // simulate a regeneration: densify (midpoints) + tiny jitter, so both
  // indexes AND stations shift slightly — the point signature must still win
  const dense = [];
  for (let i = 0; i < routeA.points.length - 1; i += 1) {
    const a = routeA.points[i]; const b = routeA.points[i + 1];
    dense.push([a[0] + 0.05, a[1], a[2] - 0.04]);
    dense.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 0.06]);
  }
  dense.push([...routeA.points[routeA.points.length - 1]]);
  const cum2 = cumLengths(dense, false);
  const r2 = resolveAnchor(anchor, dense, cum2, false);
  assert.equal(r2.ok, true);
  const p2 = polylineAt(dense, cum2, false, r2.s);
  assert.ok(Math.hypot(p2[0] - p[0], p2[2] - p[2]) < 1, 'still anchors the same physical spot');
});

test('unresolvable anchors are skipped with a warning, not applied', () => {
  const ov = {
    version: 2,
    routes: { test_a: [{ id: 'lost', op: 'move', anchor: { station: 480, point: [99999, 99999], tolerance: 15 }, to: [0, 0] }] },
  };
  const res = applyOverrides(routeA, ov);
  assert.equal(res.applied, 0);
  assert.equal(res.skipped, 1);
  assert.equal(res.warnings.length, 1);
  assert.deepEqual(res.pts, routeA.points.map((p) => [...p]));
});

test('move op bends the faired centreline toward the handle', () => {
  const base = fairRoute(routeA, ctx0);
  const op = moveOpAt(480, 0, 8);
  const edited = fairRoute(routeA, { ...ctx0, overrides: { version: 2, routes: { test_a: [op] } } });
  const target = op.to;
  const dBase = projectToPolyline(target[0], target[1], base.pts, base.cum, false).d;
  const dEdit = projectToPolyline(target[0], target[1], edited.pts, edited.cum, false).d;
  assert.ok(dEdit < dBase - 4, `curve moved toward handle (${dBase.toFixed(2)} → ${dEdit.toFixed(2)} m)`);
  // endpoints stay pinned exactly
  assert.deepEqual(edited.pts[0], routeA.points[0]);
  assert.deepEqual(edited.pts[edited.pts.length - 1], routeA.points[routeA.points.length - 1]);
});

test('disabled ops are inert; re-enabling matches a fresh application', () => {
  const op = moveOpAt(480, 0, 8, { enabled: false });
  const base = fairRoute(routeA, ctx0);
  const off = fairRoute(routeA, { ...ctx0, overrides: { version: 2, routes: { test_a: [op] } } });
  assert.deepEqual(off.pts, base.pts);
  const on = fairRoute(routeA, { ...ctx0, overrides: { version: 2, routes: { test_a: [{ ...op, enabled: true }] } } });
  assert.notDeepEqual(on.pts, base.pts);
});

test('insert / delete / pin / smooth ops apply to the raw polyline', () => {
  const cum = cumLengths(routeA.points, false);
  const p300 = polylineAt(routeA.points, cum, false, 300);
  const vertex = routeA.points[20];
  const ov = {
    version: 2,
    routes: {
      test_a: [
        { id: 'i', op: 'insert', anchor: { station: 300, point: [p300[0], p300[2]], tolerance: 15 }, point: [p300[0], p300[2] + 2] },
        { id: 'd', op: 'delete', anchor: { station: 400, point: [vertex[0], vertex[2]], tolerance: 6 } },
        { id: 'p', op: 'pin', anchor: { station: 700, point: null }, span: 24 },
        { id: 's', op: 'smooth', anchor: { station: 900 }, span: 60, factor: 0.1 },
      ],
    },
  };
  ov.routes.test_a[2].anchor.point = (() => { const q = polylineAt(routeA.points, cum, false, 700); return [q[0], q[2]]; })();
  const res = applyOverrides(routeA, ov);
  assert.equal(res.applied, 4);
  assert.equal(res.skipped, 0);
  // insert added one, delete removed one → same count, but contents differ
  assert.equal(res.pts.length, routeA.points.length);
  assert.ok(res.pts.some((q) => Math.abs(q[2] - (p300[2] + 2)) < 1e-9), 'inserted vertex present');
  assert.ok(!res.pts.some((q) => q[0] === vertex[0] && q[2] === vertex[2]), 'deleted vertex gone');
  assert.equal(res.weightFloors.length, 2, 'insert weight + pin floor');
  assert.equal(res.weightScales.length, 1, 'smooth scale');
  // pinned span emits raw vertices verbatim in the faired output
  const edited = fairRoute(routeA, { ...ctx0, overrides: ov });
  const pinnedRaw = res.pts.filter((q, i) => {
    const c = cumLengths(res.pts, false);
    return c[i] > 700 - 20 && c[i] < 700 + 20;
  });
  for (const q of pinnedRaw) {
    assert.ok(edited.pts.some((e) => Math.hypot(e[0] - q[0], e[2] - q[2]) < 1e-9), 'raw vertex kept verbatim in pin span');
  }
});

test('legacy v1 ops reproduce the original generator behaviour', () => {
  const ov = { test_a: [{ op: 'move', index: 10, to: [routeA.points[10][0], routeA.points[10][2] + 3] }, { op: 'delete', index: 5 }, { op: 'insert', after: 2, point: [30, 2, 0] }] };
  const res = applyOverrides(routeA, ov);
  assert.equal(res.applied, 3);
  assert.equal(res.pts.length, routeA.points.length); // -1 +1
  assert.equal(res.pts[3][0], 30); // inserted after index 2
  assert.equal(res.weightFloors.length, 0, 'v1 has no weight effects');
});

test('editor preview (fairRoute) equals the full generator pipeline output', () => {
  // Single-route dataset: the cross-route clearance guard (which only the
  // full network build runs — documented) has nothing to do, so the preview
  // must match the generator EXACTLY.
  const solo = { ...data, routes: [routeA] };
  const ov = { version: 2, routes: { test_a: [moveOpAt(480, 0, 4)] } };
  const single = fairRoute(routeA, { data: solo, overrides: ov, params: DEFAULT_PARAMS });
  const { out } = buildSmoothedData(solo, { overrides: ov, params: DEFAULT_PARAMS });
  const built = out.routes.find((r) => r.id === 'test_a');
  // the generator rounds to 2 decimals on output; compare with that rounding
  const rounded = single.pts.map((p) => p.map((v) => Math.round(v * 100) / 100));
  assert.deepEqual(built.points, rounded, 'preview and generator produce identical geometry');
});

test('protected-zone ops are blocking errors; unlock downgrades to warning', () => {
  // station 600 is the diverge connection on test_a → protected ±45 m
  const blocked = analyzeRouteEdit({
    data,
    smoothedData: smoothedFixture,
    routeId: 'test_a',
    overrides: { version: 2, routes: { test_a: [moveOpAt(600, 0, 3)] } },
  });
  assert.equal(blocked.hasErrors, true);
  assert.ok(blocked.findings.some((f) => f.code === 'protected' && f.severity === 'error'));

  const unlocked = analyzeRouteEdit({
    data,
    smoothedData: smoothedFixture,
    routeId: 'test_a',
    overrides: { version: 2, routes: { test_a: [moveOpAt(600, 0, 3, { unlockProtected: true })] } },
  });
  assert.ok(unlocked.findings.some((f) => f.code === 'protected-unlocked' && f.severity === 'warning'));
  assert.ok(!unlocked.findings.some((f) => f.code === 'protected'));
});

test('gross deviation is a blocking error; moderate deviation only warns', () => {
  const gross = analyzeRouteEdit({
    data,
    smoothedData: smoothedFixture,
    routeId: 'test_a',
    overrides: { version: 2, routes: { test_a: [moveOpAt(300, 0, 30, { weight: 5000, influence: 120 })] } },
  });
  assert.equal(gross.hasErrors, true);
  assert.ok(gross.findings.some((f) => f.code === 'deviation' && f.severity === 'error'));

  const mild = analyzeRouteEdit({
    data,
    smoothedData: smoothedFixture,
    routeId: 'test_a',
    overrides: { version: 2, routes: { test_a: [moveOpAt(300, 0, 2.5)] } },
  });
  assert.equal(mild.findings.some((f) => f.code === 'deviation' && f.severity === 'error'), false);
});

test('reload round-trip: saved ops re-resolve on a fresh load', () => {
  const ov = { version: 2, routes: { test_a: [moveOpAt(480, 0, 5)] } };
  const first = fairRoute(routeA, { ...ctx0, overrides: ov });
  const reloaded = JSON.parse(JSON.stringify(ov));
  const second = fairRoute(routeA, { ...ctx0, overrides: reloaded });
  assert.deepEqual(second.pts, first.pts);
});
