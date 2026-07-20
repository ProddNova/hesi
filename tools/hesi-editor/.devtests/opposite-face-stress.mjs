// Stress the fixed Opposite clone with a realistic car-cover build sequence:
// several opposing vertex pairs, wedge profile sculpting, repeated clones.
import {
  clonePartFaceToOpposite, convertPartToMesh, meshInsertVertexAtPoint, partFaceNames,
} from '../../../js/custom-assets.js';

const boxPart = () => ({
  kind: 'box', name: 'Cover', position: [0, 0.75, 0], rotation: [0, 0, 0], scale: [2, 1.5, 4.25], color: '#9aa7b5', faces: {},
});

const fmt = (v) => `[${v.map((x) => x.toFixed(3)).join(', ')}]`;

function check(label, part, { silent = false } = {}) {
  const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const edges = new Map();
  for (const t of part.triangles) {
    for (let i = 0; i < 3; i += 1) {
      const k = key(t.v[i], t.v[(i + 1) % 3]);
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  const bad = [...edges.entries()].filter(([, count]) => count !== 2);
  const dupes = [];
  for (let i = 0; i < part.vertices.length; i += 1) {
    for (let j = i + 1; j < part.vertices.length; j += 1) {
      const a = part.vertices[i]; const b = part.vertices[j];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < 0.03) dupes.push([i, j, +d.toFixed(4)]);
    }
  }
  const ok = !bad.length && !dupes.length;
  if (!ok || !silent) {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} — ${part.vertices.length}v/${part.triangles.length}t, badEdges=${bad.length}, dupes=${dupes.length}`);
  }
  if (!ok) {
    for (const [k, c] of bad) console.log(`   edge ${k} x${c}`);
    for (const [i, j, d] of dupes) console.log(`   dup v${i}~v${j} d=${d} at ${fmt(part.vertices[i])}`);
  }
  return ok;
}

let failures = 0;
const expectOk = (label, part) => { if (!check(label, part)) failures += 1; };

// Build: wedge cover sculpted on the LEFT face, cloned to RIGHT, iteratively.
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const left = names.indexOf('left');
  console.log('--- sequence A: pairs on left face, sculpt, clone left->right, repeat');
  // pair 1: on the left face near the top-front edge (hood break point)
  const a1 = meshInsertVertexAtPoint(part, [-0.5, 0.74, 0.6], { faceIndex: left });
  console.log('insert 1:', JSON.stringify(a1));
  expectOk('after insert 1', part);
  // pair 2: mid-hood on the left face near the front edge
  const a2 = meshInsertVertexAtPoint(part, [-0.5, 0.2, 1.05], { faceIndex: left });
  console.log('insert 2:', JSON.stringify(a2));
  expectOk('after insert 2', part);
  // sculpt LEFT profile: pull pair-1 point down/forward, pair-2 forward
  if (a1) part.vertices[a1.vertexIndex] = [-0.5, 0.55, 0.45];
  if (a2) part.vertices[a2.vertexIndex] = [-0.5, 0.05, 1.35];
  expectOk('after sculpt', part);
  const r1 = clonePartFaceToOpposite(part, 'left');
  console.log('clone 1 ->', r1);
  expectOk('after clone 1', part);
  // keep editing: move the left points again, clone again
  if (a1) part.vertices[a1.vertexIndex] = [-0.5, 0.6, 0.3];
  const r2 = clonePartFaceToOpposite(part, 'left');
  console.log('clone 2 ->', r2);
  expectOk('after clone 2', part);
  // add a third pair AFTER cloning, sculpt, clone again
  const a3 = meshInsertVertexAtPoint(part, [-0.5, 0.72, -0.8], { faceIndex: left });
  console.log('insert 3:', JSON.stringify(a3));
  expectOk('after insert 3', part);
  if (a3) part.vertices[a3.vertexIndex] = [-0.5, 0.68, -0.6];
  const r3 = clonePartFaceToOpposite(part, 'left');
  console.log('clone 3 ->', r3);
  expectOk('after clone 3', part);
}

// Sequence B: sculpt the FRONT profile (hood slope) via pairs front<->back, clone front->back
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const front = names.indexOf('front');
  console.log('--- sequence B: pairs on front face, wedge slope, clone front->back');
  const b1 = meshInsertVertexAtPoint(part, [0, 0.74, 2.12], { faceIndex: front });
  console.log('insert 1:', JSON.stringify(b1));
  const b2 = meshInsertVertexAtPoint(part, [-0.6, 0.4, 2.12], { faceIndex: front });
  console.log('insert 2:', JSON.stringify(b2));
  expectOk('after inserts', part);
  if (b1) part.vertices[b1.vertexIndex] = [0, 0.1, 2.1];
  if (b2) part.vertices[b2.vertexIndex] = [-0.6, -0.1, 2.0];
  expectOk('after sculpt', part);
  const r = clonePartFaceToOpposite(part, 'front');
  console.log('clone ->', r);
  expectOk('after clone', part);
}

// Sequence C: clone with MISMATCHED sides — target face carries pairs the source lost
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const left = names.indexOf('left');
  const right = names.indexOf('right');
  console.log('--- sequence C: extra pair on the target side, then clone source->target');
  const c1 = meshInsertVertexAtPoint(part, [-0.5, 0.74, 0.6], { faceIndex: left });
  const c2 = meshInsertVertexAtPoint(part, [0.5, 0.5, -1.2], { faceIndex: right }); // pair landing back on left
  console.log('inserts:', JSON.stringify(c1), JSON.stringify(c2));
  expectOk('after inserts', part);
  if (c1) part.vertices[c1.vertexIndex] = [-0.5, 0.5, 0.4];
  if (c2) part.vertices[c2.vertexIndex] = [0.5, 0.35, -1.3];
  const r = clonePartFaceToOpposite(part, 'left');
  console.log('clone left->right ->', r);
  expectOk('after clone', part);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
