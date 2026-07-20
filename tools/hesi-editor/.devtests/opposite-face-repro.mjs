// Repro for the broken "⇄ Opposite" clone on mesh parts with custom apexes.
import {
  clonePartFaceToOpposite, convertPartToMesh, meshInsertVertexAtPoint, partFaceNames,
} from '../../../js/custom-assets.js';

const boxPart = () => ({
  kind: 'box', name: 'Box', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#9aa7b5', faces: {},
});

const fmt = (v) => `[${v.map((x) => x.toFixed(3)).join(', ')}]`;

function edgeReport(part) {
  const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const edges = new Map();
  for (const t of part.triangles) {
    for (let i = 0; i < 3; i += 1) {
      const k = key(t.v[i], t.v[(i + 1) % 3]);
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  const bad = [...edges.entries()].filter(([, count]) => count !== 2);
  return bad;
}

function nearDuplicates(part, tol = 0.06) {
  const out = [];
  for (let i = 0; i < part.vertices.length; i += 1) {
    for (let j = i + 1; j < part.vertices.length; j += 1) {
      const a = part.vertices[i]; const b = part.vertices[j];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < tol) out.push([i, j, d]);
    }
  }
  return out;
}

function report(label, part) {
  console.log(`\n=== ${label} ===`);
  console.log(`vertices: ${part.vertices.length}, triangles: ${part.triangles.length}`);
  part.vertices.forEach((v, i) => console.log(`  v${i}: ${fmt(v)}`));
  const bad = edgeReport(part);
  console.log(`non-manifold edges (used != 2 times): ${bad.length}`);
  for (const [k, c] of bad) console.log(`  edge ${k} used ${c}x`);
  const dupes = nearDuplicates(part);
  console.log(`near-duplicate vertex pairs (<0.06 apart): ${dupes.length}`);
  for (const [i, j, d] of dupes) console.log(`  v${i} ~ v${j} (d=${d.toFixed(4)})`);
}

// --- Scenario 1: ridge apex (paired insert near shared edge), asymmetric edit, clone front->back
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  console.log('face names:', names);
  const added = meshInsertVertexAtPoint(part, [0, 0.35, 0.5], { faceIndex: names.indexOf('front') });
  console.log('insert result:', JSON.stringify(added));
  if (!added) process.exit(1);
  console.log('apex A base pos:', fmt(part.vertices[added.vertexIndex]));
  if (Number.isInteger(added.oppositeVertexIndex)) {
    console.log('apex B base pos:', fmt(part.vertices[added.oppositeVertexIndex]));
  }
  // user pulls the FRONT apex only (asymmetric edit)
  part.vertices[added.vertexIndex] = [0.1, 0.85, 0.4];
  report('scenario 1: BEFORE clone', part);
  const result = clonePartFaceToOpposite(part, 'front');
  console.log('clone result:', result);
  report('scenario 1: AFTER clone front->back', part);
  // faces of triangles per face index
  const perFace = new Map();
  for (const t of part.triangles) perFace.set(t.face || 0, (perFace.get(t.face || 0) || 0) + 1);
  console.log('triangles per face:', [...perFace.entries()].map(([f, c]) => `${names[f]}=${c}`).join(', '));
}

// --- Scenario 2: interior apex insert (no shared face), pulled, clone front->back
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const added = meshInsertVertexAtPoint(part, [0.05, 0.1, 0.5], { faceIndex: names.indexOf('front') });
  console.log('\n\ninsert result (scenario 2):', JSON.stringify(added));
  if (!added) process.exit(1);
  part.vertices[added.vertexIndex] = [0.15, 0.2, 0.9];
  const result = clonePartFaceToOpposite(part, 'front');
  console.log('clone result:', result);
  report('scenario 2: AFTER clone front->back', part);
}

// --- Scenario 3: like 1 but then clone a SIDE face (left->right) with the ridge in place
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const added = meshInsertVertexAtPoint(part, [0, 0.35, 0.5], { faceIndex: names.indexOf('front') });
  if (!added) process.exit(1);
  // symmetric roof: pull both apexes up
  part.vertices[added.vertexIndex] = [0, 0.9, 0.5];
  if (Number.isInteger(added.oppositeVertexIndex)) part.vertices[added.oppositeVertexIndex] = [0, 0.9, -0.5];
  const result = clonePartFaceToOpposite(part, 'left');
  console.log('\n\nscenario 3 clone left->right result:', result);
  report('scenario 3: AFTER clone left->right', part);
}

// --- Scenario 4: RIDGE — edge-split insert on the front/top shared edge, chord across top,
// asymmetric edit of the front apex, then clone front->back
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const added = meshInsertVertexAtPoint(part, [0, 0.49, 0.5], { faceIndex: names.indexOf('front') });
  console.log('\n\nscenario 4 insert result:', JSON.stringify(added));
  if (!added) process.exit(1);
  console.log('apex A:', fmt(part.vertices[added.vertexIndex]), 'apex B:', fmt(part.vertices[added.oppositeVertexIndex]));
  const facesOf = (vi) => [...new Set(part.triangles.filter((t) => t.v.includes(vi)).map((t) => names[t.face || 0]))];
  console.log('faces using A:', facesOf(added.vertexIndex), '| faces using B:', facesOf(added.oppositeVertexIndex));
  // user pulls the FRONT apex only
  part.vertices[added.vertexIndex] = [0.1, 0.85, 0.4];
  report('scenario 4: BEFORE clone', part);
  const result = clonePartFaceToOpposite(part, 'front');
  console.log('clone result:', result);
  report('scenario 4: AFTER clone front->back', part);
  const perFace = new Map();
  for (const t of part.triangles) perFace.set(t.face || 0, (perFace.get(t.face || 0) || 0) + 1);
  console.log('triangles per face:', [...perFace.entries()].map(([f, c]) => `${names[f]}=${c}`).join(', '));
}

// --- Scenario 5: NOTCH — cut into the face by moving a boundary-edge vertex inward, clone
{
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const added = meshInsertVertexAtPoint(part, [0, 0.49, 0.5], { faceIndex: names.indexOf('front') });
  console.log('\n\nscenario 5 insert result:', JSON.stringify(added));
  if (!added) process.exit(1);
  // push the shared-edge vertex DOWN into the face: a notch in the silhouette
  part.vertices[added.vertexIndex] = [0, 0.1, 0.5];
  report('scenario 5: BEFORE clone', part);
  const result = clonePartFaceToOpposite(part, 'front');
  console.log('clone result:', result);
  report('scenario 5: AFTER clone front->back', part);
}
