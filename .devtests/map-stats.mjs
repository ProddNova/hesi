import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const map = new HighwayMap(null, {});
let meshes = 0, instanced = 0, geos = new Set(), byName = {};
map.group.traverse(o => {
  if (o.isInstancedMesh) { instanced++; }
  else if (o.isMesh) { meshes++; const k = (o.name||'unnamed').replace(/[0-9.]+/g,'#'); byName[k]=(byName[k]||0)+1; }
  if (o.geometry) geos.add(o.geometry);
});
console.log('regular meshes:', meshes, '| instanced meshes:', instanced, '| unique geometries:', geos.size);
const top = Object.entries(byName).sort((a,b)=>b[1]-a[1]).slice(0,12);
for (const [k,v] of top) console.log(String(v).padStart(4), k);
console.log('stats:', JSON.stringify(map.getNetworkStats()));
// junction platform vs road height check
const j = map.junctions[0];
console.log('junction platform top y offset vs road:', (j.point.y - 0.56 + 1.15/2 - j.point.y).toFixed(3));
