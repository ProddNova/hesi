/**
 * Lateral barrier styles: does the authored document actually reach geometry,
 * and does an unauthored network stay byte-identical?
 *
 * 1. The shipped document must resolve ramp_8 to the tall Shutoko screen on
 *    both sides, and every other route to the default parapet.
 * 2. Building the world with the document must add upright geometry above the
 *    old parapet cap on ramp_8's chunks, and must leave the wall-segment
 *    collision height on those spans at the style's height.
 * 3. Building with an EMPTY document must reproduce the pre-feature geometry
 *    exactly (vertex-count identical per chunk bucket) — proof the feature is
 *    inert wherever nobody authored anything.
 *
 * Run: node .devtests/road-barrier-probe.mjs
 */
import { HighwayMap, ROAD_TEXTURE_TILE_METERS, WALL_UV_SURFACE_MATERIAL_NAMES } from '../js/map.js';
import { WORLD_SURFACES } from '../js/custom-assets.js';
import BARRIER_DOC from '../data/road-barriers.js';
import {
  BARRIER_MATERIAL_NAMES,
  BARRIER_STYLES,
  barrierSpanAt,
  barrierStyle,
  barrierStyleIdAt,
  canonicalizeBarrierDocument,
  flattenBarrierSpans,
} from '../js/road-barrier-styles.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('1. document + resolver');
const canonical = canonicalizeBarrierDocument(BARRIER_DOC);
check('document canonicalizes', canonical.version === 1);
const ramp8Spans = flattenBarrierSpans(canonical, 'ramp_8', 1200);
check('ramp_8 right side styled', barrierStyleIdAt(ramp8Spans, 1, 300) === 'shutokoTall');
check('ramp_8 left side styled', barrierStyleIdAt(ramp8Spans, -1, 300) === 'shutokoTall');
const otherSpans = flattenBarrierSpans(canonical, 'wangan_0', 1200);
check('unauthored route falls back to parapet', barrierStyleIdAt(otherSpans, 1, 300) === 'parapet');

// Overlap semantics: a later short patch must win inside a longer earlier coat.
const patched = canonicalizeBarrierDocument({
  version: 1,
  routes: {
    demo: [
      { side: 'both', start: 0, end: null, style: 'soundWall' },
      { side: 'left', start: 100, end: 140, style: 'guardrail' },
    ],
  },
});
const demoSpans = flattenBarrierSpans(patched, 'demo', 400);
check('patch wins inside the coat', barrierStyleIdAt(demoSpans, -1, 120) === 'guardrail');
check('coat survives outside the patch', barrierStyleIdAt(demoSpans, -1, 90) === 'soundWall');
check('patch is side-scoped', barrierStyleIdAt(demoSpans, 1, 120) === 'soundWall');

// Per-span height multiplier: same style, different height, no new catalogue
// entry — and out-of-range values are rejected rather than silently clamped.
const scaled = canonicalizeBarrierDocument({
  version: 1,
  routes: { demo: [{ side: 'both', start: 0, end: null, style: 'shutokoTall', heightScale: 1.5 }] },
});
check('height multiplier survives canonicalization', barrierSpanAt(flattenBarrierSpans(scaled, 'demo', 400), 1, 10)?.heightScale === 1.5);
let rejected = false;
try { canonicalizeBarrierDocument({ version: 1, routes: { demo: [{ side: 'both', start: 0, end: null, style: 'jersey', heightScale: 9 }] } }); }
catch { rejected = true; }
check('out-of-range height multiplier is rejected', rejected);

console.log('2. authored world');
const styled = new HighwayMap(null, {});
const ramp8 = styled.routes.get('ramp_8');
check('ramp_8 exists', Boolean(ramp8), ramp8 ? `${ramp8.length.toFixed(0)} m` : 'missing');
const style = barrierStyle('shutokoTall');
const ramp8Walls = styled.wallSegments.filter((wall) => wall.routeId === 'ramp_8' && wall.type === 'outer');
const tallWalls = ramp8Walls.filter((wall) => Math.abs(wall.height - style.collisionHeight) < 1e-6);
check('ramp_8 collision follows the style', ramp8Walls.length > 0 && tallWalls.length === ramp8Walls.length,
  `${tallWalls.length}/${ramp8Walls.length} at ${style.collisionHeight} m`);

// Every styled body material must exist in the palette AND be a Surfaces slot,
// or the editor would offer a paint target the generator never uses (or worse,
// the generator would bucket into a material three.js has no entry for).
const missingMaterial = BARRIER_MATERIAL_NAMES.filter((name) => !styled.materials[name]);
check('styled barrier materials exist in the palette', missingMaterial.length === 0, missingMaterial.join(', '));
const missingSurface = BARRIER_MATERIAL_NAMES.filter((name) => !WORLD_SURFACES[name]);
check('styled barrier materials are Surfaces slots', missingSurface.length === 0, missingSurface.join(', '));
// Styled barriers bake their own UVs, so the connected-component wall
// projection must NOT run over them — that projection re-fits the image to
// each merged quad's own foot and top, which is the "staircase" on a grade.
const hijacked = BARRIER_MATERIAL_NAMES.filter((name) => WALL_UV_SURFACE_MATERIAL_NAMES.includes(name));
check('styled barrier UVs are not overwritten by the wall projection', hijacked.length === 0, hijacked.join(', '));
let screenUsed = false;
styled.group.traverse((object) => { if (object.name?.includes('barrierScreen')) screenUsed = true; });
check('barrierScreen actually carries geometry', screenUsed);

// One style = one paintable slot. `meshScreen` is the documented exception:
// it is the default parapet plus a screen, so its base/handrail stay shared.
const SHARED_SLOT_STYLES = new Set(['parapet', 'meshScreen', 'none']);
const mixed = Object.values(BARRIER_STYLES).filter((entry) => {
  if (SHARED_SLOT_STYLES.has(entry.id)) return false;
  const used = new Set([...(entry.sheets || []).map((sheet) => sheet.material), ...(entry.posts ? [entry.posts.material] : [])]);
  return used.size !== 1;
});
check('each style paints on exactly one slot', mixed.length === 0, mixed.map((entry) => entry.id).join(', '));

// The wall must be ONE swept strip, not parallel sheets: two sheets would take
// the painted texture twice, side by side.
const tall = BARRIER_STYLES.shutokoTall;
check('the tall wall is a single piece', tall.sheets.length === 1 && !tall.posts,
  `${tall.sheets.length} sheet(s), posts=${tall.posts ? 'yes' : 'none'}`);

// Anti-staircase: `v` must come from the authored profile, so the same wall
// height maps to the same texture row at every chainage. Per-quad normalisation
// (the old bug) can only ever produce v in {0, 1}; the 9-point profile produces
// a spread of intermediate values.
const screenUvs = new Set();
let uReach = 0;
let runEdges = 0;
let fastEdges = 0;
let worstDensity = 0;
styled.group.traverse((object) => {
  if (!object.name?.includes('barrierScreen')) return;
  const geometry = object.geometry;
  const uv = geometry?.attributes?.uv;
  const position = geometry?.attributes?.position;
  if (!uv || !position) return;
  for (let i = 0; i < uv.count; i += 1) {
    screenUvs.add(uv.getY(i).toFixed(3));
    uReach = Math.max(uReach, Math.abs(uv.getX(i)));
  }
  // u advances with world chainage: on every edge, the metres of texture it
  // crosses match the metres of wall it covers. (u itself is anchored to the
  // nearest whole tile per segment — an integer shift lands on the same texel
  // and keeps the number small enough for a mobile GPU to interpolate.)
  const index = geometry.index;
  const cornerCount = index ? index.count : position.count;
  for (let corner = 0; corner + 2 < cornerCount; corner += 3) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(corner + k) : corner + k));
    for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) {
      const du = Math.abs(uv.getX(ids[p]) - uv.getX(ids[q])) * ROAD_TEXTURE_TILE_METERS;
      if (du < 1e-4) continue;
      const length = Math.hypot(
        position.getX(ids[p]) - position.getX(ids[q]),
        position.getY(ids[p]) - position.getY(ids[q]),
        position.getZ(ids[p]) - position.getZ(ids[q]),
      );
      if (length < 0.5) continue;
      const density = du / length;
      runEdges += 1;
      worstDensity = Math.max(worstDensity, density);
      if (density > 0.9) fastEdges += 1;
    }
  }
});
check('wall v comes from the profile, not per-quad refitting', screenUvs.size >= 5,
  `${screenUvs.size} distinct v values: ${[...screenUvs].sort().join(', ')}`);
check('wall v spans foot to top exactly once', screenUvs.has('0.000') && screenUvs.has('1.000'));
// The ceiling is not 1.0 because a lay-by's square end measures u along the
// panel the edge sweeps, not along chainage, so its upper profile points
// advance a little faster than they travel (see _emitStyledBarrierSegment).
check('wall u runs along the route as world chainage', runEdges > 100 && worstDensity <= 1.3 && fastEdges / runEdges > 0.5,
  `${fastEdges}/${runEdges} edges at full chainage density, worst ${worstDensity.toFixed(3)}`);
check('wall u stays anchored near its own segment', uReach <= 2, `peak |u| ${uReach.toFixed(2)} tiles`);

// Highest vertex anywhere near the ramp centreline, ignoring the deck itself:
// the tall screen must reach well above the 1.15 m parapet it replaced.
const samples = ramp8.surfaceFrames.filter((_, index) => index % 40 === 0).slice(0, 12);
let peak = 0;
for (const mesh of styled.group.children.flatMap((child) => child.children || [])) {
  const position = mesh.geometry?.attributes?.position;
  if (!position) continue;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    for (const frame of samples) {
      const dx = x - frame.position.x;
      const dz = z - frame.position.z;
      if (dx * dx + dz * dz > 400) continue;
      peak = Math.max(peak, y - frame.position.y);
      break;
    }
  }
}
check('tall screen geometry reaches above 3.2 m', peak > 3.2, `peak +${peak.toFixed(2)} m over the deck`);

// A heightScale world must physically build taller than the same style at 1.
const tallerWalls = new HighwayMap(null, {
  roadBarriers: { version: 1, routes: { ramp_8: [{ side: 'both', start: 0, end: null, style: 'shutokoTall', heightScale: 1.4 }] } },
}).wallSegments.filter((wall) => wall.routeId === 'ramp_8' && wall.type === 'outer');
const expected = style.collisionHeight * 1.4;
check('height multiplier reaches collision', tallerWalls.length > 0 && tallerWalls.every((wall) => Math.abs(wall.height - expected) < 1e-6),
  `${tallerWalls.length} walls at ${expected.toFixed(2)} m`);

console.log('3. empty document is inert');
const bucketSignature = (map) => {
  const rows = [];
  map.group.traverse((object) => {
    const count = object.geometry?.attributes?.position?.count;
    if (count) rows.push(`${object.name}|${count}`);
  });
  if (!rows.length) throw new Error('signature is empty — the probe is not reading any geometry');
  return rows.sort().join('\n');
};
const baseline = new HighwayMap(null, { roadBarriers: { version: 1, routes: {} } });
const withDefaultsOnly = new HighwayMap(null, {
  roadBarriers: { version: 1, routes: { ramp_8: [{ side: 'both', start: 0, end: null, style: 'parapet' }] } },
});
check('explicit parapet override reproduces the shipped geometry',
  bucketSignature(baseline) === bucketSignature(withDefaultsOnly));
check('styled world differs from the baseline', bucketSignature(styled) !== bucketSignature(baseline));

console.log(failures ? `\nFAIL — ${failures} check(s) failed` : '\nPASS — all checks green');
process.exit(failures ? 1 : 0);
