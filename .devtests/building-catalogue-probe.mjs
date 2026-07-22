/**
 * Building catalogue census: how many buildings the generator places, whether
 * every copy of a type is the SAME box, and how much of each spine has a
 * building beside it (the "completely bare stretch" metric).
 *
 * Run: node .devtests/building-catalogue-probe.mjs [tag]
 */
import { HighwayMap } from '../js/map.js';

const TAG = process.argv[2] || 'now';
const map = new HighwayMap(null, {});
const boxes = map.buildingBoxes || [];

// ---------------------------------------------------------------- census --
const byType = new Map();
for (const box of boxes) {
  const key = box.type || box.material;
  if (!byType.has(key)) byType.set(key, []);
  byType.get(key).push(box);
}

const round = (v) => Math.round(v * 10) / 10;
console.log(`\n=== building catalogue [${TAG}] ===`);
console.log(`total boxes: ${boxes.length}  ·  types: ${byType.size}`);
console.log('type'.padEnd(20), 'count'.padStart(6), 'shapes'.padStart(7), '  size (w x h x d)');
let nonUniform = 0;
for (const [type, list] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
  const shapes = new Set(list.map((b) => `${round(b.width)}x${round(b.height)}x${round(b.depth)}`));
  if (shapes.size > 1) nonUniform += 1;
  const sample = [...shapes].slice(0, 2).join(' , ');
  console.log(
    String(type).padEnd(20),
    String(list.length).padStart(6),
    String(shapes.size).padStart(7),
    `  ${sample}${shapes.size > 2 ? ` … (+${shapes.size - 2})` : ''}`,
  );
}
console.log(`types with more than one shape: ${nonUniform}`);

// ------------------------------------------------------- spine coverage --
// Walk each spine and ask, per side: is there any building whose footprint
// centre falls in the band 0..REACH metres out and within STEP/2 along?
const STEP = 50;
const REACH = 220;
const grid = new Map();
const CELL = 120;
for (const box of boxes) {
  const key = `${Math.floor(box.x / CELL)},${Math.floor(box.z / CELL)}`;
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(box);
}
const near = (x, z, r) => {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  const span = Math.ceil(r / CELL);
  const out = [];
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dz = -span; dz <= span; dz += 1) {
      const bucket = grid.get(`${cx + dx},${cz + dz}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
};

console.log('\nspine coverage (share of 50 m stations with a building on that side)');
let worstRun = 0;
for (const group of ['c1', 'r9', 'r1', 'k1', 'wangan']) {
  const spine = map._groupChains(group)[0];
  if (!spine) continue;
  let stations = 0;
  let covered = 0;
  let run = 0;
  let longestGap = 0;
  let tunnelMetres = 0;
  for (let distance = 0; distance < spine.length; distance += STEP) {
    // In a tunnel the road is underground: nothing beside it is visible and
    // the generator deliberately builds none, so those metres are not a gap.
    if (map._isTunnel(spine, distance)) { tunnelMetres += STEP; continue; }
    const center = map._sampleCenter(spine, distance, 1);
    const normal = { x: -center.baseTangent.z, z: center.baseTangent.x };
    const length = Math.hypot(normal.x, normal.z) || 1;
    normal.x /= length;
    normal.z /= length;
    let any = false;
    for (const side of [-1, 1]) {
      stations += 1;
      const hit = near(center.position.x, center.position.z, REACH).some((box) => {
        const dx = box.x - center.position.x;
        const dz = box.z - center.position.z;
        const lateral = (dx * normal.x + dz * normal.z) * side;
        const along = dx * center.baseTangent.x + dz * center.baseTangent.z;
        return lateral > 0 && lateral < REACH && Math.abs(along) < STEP * 0.5;
      });
      if (hit) { covered += 1; any = true; }
    }
    if (any) { longestGap = Math.max(longestGap, run); run = 0; } else { run += STEP; }
  }
  longestGap = Math.max(longestGap, run);
  worstRun = Math.max(worstRun, longestGap);
  console.log(
    `${group.padEnd(8)} ${String(Math.round((covered / stations) * 100)).padStart(3)}%  `
    + `longest fully bare stretch: ${String(longestGap).padStart(4)} m  `
    + `(${Math.round(spine.length)} m spine, ${tunnelMetres} m of it tunnel)`,
  );
}
console.log(`worst bare stretch overall: ${worstRun} m`);

// ------------------------------------------------------------- geometry --
let quads = 0;
let chunkMeshes = 0;
const facadeBuckets = new Map();
map.group.traverse((object) => {
  if (!object.isMesh || object.isInstancedMesh) return;
  chunkMeshes += 1;
  const match = /^chunk (\S+) (\S+)$/.exec(object.name || '');
  if (!match) return;
  if (!facadeBuckets.has(match[2])) facadeBuckets.set(match[2], 0);
  facadeBuckets.set(match[2], facadeBuckets.get(match[2]) + 1);
  if (object.geometry?.index) quads += object.geometry.index.count / 6;
});
const buildingBuckets = [...facadeBuckets].filter(([name]) => /facade|building/i.test(name));
console.log(`\nchunk meshes: ${chunkMeshes}  ·  building-bucket meshes: ${buildingBuckets.reduce((sum, [, n]) => sum + n, 0)}`);
for (const [name, count] of buildingBuckets.sort((a, b) => b[1] - a[1])) console.log(`  ${name.padEnd(20)} ${count} chunk meshes`);
