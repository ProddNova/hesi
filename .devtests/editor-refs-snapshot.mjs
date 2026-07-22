/**
 * Dumps every address the editor's saved files can point at, for the world as
 * the generator builds it RIGHT NOW.
 *
 * data/editor/hesi-world-build.json addresses instances by (mesh name, index)
 * and data/editor/hesi-world-project.json addresses entities by an ordinal
 * (`prop:ramp-8:0087`) handed out during discovery. Both are positional only by
 * accident: remove or reorder an `_instance()` call and every later address in
 * that bucket silently re-points at a different piece.
 *
 * Take this snapshot BEFORE touching a generator pass that instances anything,
 * then run editor-refs-migrate.mjs after — it re-points the saved files at the
 * pieces they were actually saved against.
 *
 * Run: node .devtests/editor-refs-snapshot.mjs <out.json>
 */
import { writeFileSync } from 'node:fs';
import { HighwayMap } from '../js/map.js';
import { discoverHesiEntities } from '../tools/hesi-editor/src/world/entity-discovery.js';
import { instanceWorldMatrix } from '../tools/hesi-editor/src/world/world-metadata.js';

const out = process.argv[2];
if (!out) { console.error('usage: node .devtests/editor-refs-snapshot.mjs <out.json>'); process.exit(1); }

const map = new HighwayMap(null, {});
const round = (value) => Number(value.toFixed(3));

// Every instanced bucket, by the exact name the build file uses.
const buckets = {};
map.group.traverse((object) => {
  if (!object.isInstancedMesh || buckets[object.name]) return;
  buckets[object.name] = Array.from({ length: object.count }, (unused, index) => {
    const elements = instanceWorldMatrix(object, index).elements;
    return [round(elements[12]), round(elements[13]), round(elements[14])];
  });
});

// Every entity id the project file can carry an override for, with the bucket
// slot behind it (null for meshes/semantic entities, which never shift).
const { entities } = discoverHesiEntities(map);
const ids = {};
for (const entity of entities) {
  const mesh = entity.metadata?.instanceMesh;
  ids[entity.id] = mesh
    ? { mesh: mesh.name, index: entity.metadata.instanceIndex }
    : { mesh: null, index: null };
}

writeFileSync(out, JSON.stringify({ buckets, ids }));
console.log(`${out}: ${Object.keys(buckets).length} buckets, ${Object.keys(ids).length} entity ids`);
