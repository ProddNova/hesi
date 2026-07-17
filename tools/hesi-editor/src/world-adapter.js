import * as THREE from 'three';
import { discoverHesiEntities } from './world/entity-discovery.js';

const EARTH_RADIUS_METRES = 6371000;

function standard(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.08, ...extra });
}

function addBox(group, size, position, material, name) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.name = name;
  group.add(mesh);
  return mesh;
}

function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
    else if (object.material) materials.add(object.material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function entity(id, type, layer, name, object3D, source = 'representative') {
  return { id, type, layer, name, object3D, editable: false, generated: true, source, metadata: {} };
}

function framePreset(box, label) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const direction = new THREE.Vector3(0.72, 0.82, 0.72).normalize();
  const distance = Math.max(200, sphere.radius * 2.45);
  return {
    id: 'entire-world',
    label,
    position: sphere.center.clone().addScaledVector(direction, distance),
    target: sphere.center.clone(),
    near: Math.max(0.5, distance / 30000),
    far: Math.max(120000, distance * 4),
    chunkMode: 'all',
  };
}

function makeRepresentativeWorld(onProgress, { fallbackError = null } = {}) {
  onProgress('Building explicit representative demo scene');
  const world = new THREE.Group();
  world.name = 'HESI representative world';
  const asphalt = standard(0x171b21, { roughness: 0.92 });
  const concrete = standard(0x66707a);
  const metal = standard(0x8d9aa5, { roughness: 0.38, metalness: 0.68 });
  const marking = new THREE.MeshBasicMaterial({ color: 0xe7edf0 });
  const roads = new THREE.Group();
  roads.name = 'Roads';
  addBox(roads, [18, 0.7, 190], [0, 7.5, 0], asphalt, 'Elevated highway deck');
  addBox(roads, [14, 0.55, 116], [45, 15, -8], asphalt, 'Cross route deck').rotation.y = Math.PI / 2;
  world.add(roads);
  const markings = new THREE.Group();
  markings.name = 'Road markings';
  for (let z = -84; z <= 84; z += 12) addBox(markings, [0.18, 0.035, 5], [0, 7.89, z], marking, 'Lane dash');
  world.add(markings);
  const pillars = new THREE.Group();
  pillars.name = 'Pillars';
  for (let z = -72; z <= 72; z += 24) addBox(pillars, [2.2, 15, 2.2], [0, 0, z], concrete, 'Expressway pillar');
  world.add(pillars);
  const props = new THREE.Group();
  props.name = 'Props';
  addBox(props, [10, 3.5, 0.25], [0, 14, -36], metal, 'Overhead route sign');
  world.add(props);
  const bounds = new THREE.Box3().setFromObject(world);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const presets = new Map([
    ['initial-spawn', { id: 'initial-spawn', label: 'Demo start', position: new THREE.Vector3(105, 72, 118), target: center.clone(), chunkMode: 'all' }],
    ['map-center', { id: 'map-center', label: 'Demo center', position: center.clone().add(new THREE.Vector3(90, 80, 90)), target: center.clone(), chunkMode: 'all' }],
    ['entire-world', framePreset(bounds, 'Entire demo')],
  ]);
  const entities = [
    entity('roads:representative-network', 'network', 'Roads', 'Representative expressway', roads),
    entity('markings:representative-network', 'road-markings', 'Road Markings', 'Representative markings', markings),
    entity('pillars:representative-network', 'support-system', 'Pillars', 'Representative supports', pillars),
    entity('props:representative-dressing', 'prop-collection', 'Props', 'Representative props', props),
  ];
  const demoPickIndex = new WeakMap();
  entities.forEach((demoEntity) => demoEntity.object3D?.traverse((object) => demoPickIndex.set(object, demoEntity)));
  return {
    group: world,
    entities,
    strategy: fallbackError ? 'demo-fallback' : 'demo',
    label: fallbackError ? 'DEMO FALLBACK' : 'Explicit demo world',
    isRealWorld: false,
    warning: fallbackError
      ? `REAL HESI WORLD FAILED TO LOAD. This is the demo fallback, not production data. ${fallbackError.message || fallbackError}`
      : 'Explicit demo mode requested with ?world=demo.',
    fallbackError,
    focusTarget: world,
    bounds,
    metadata: {
      worldCenter: center, worldSize: size, routeCount: 0, mapOrigin: null, mapScale: '1 unit = 1 metre',
      approximateAreaKm2: size.x * size.z / 1e6, coordinateSystem: 'Local demo coordinates; no GPS conversion',
    },
    presets,
    getPreset(id) { return presets.get(id) || null; },
    resolveSelection(object) {
      let current = object;
      while (current) { if (demoPickIndex.has(current)) return demoPickIndex.get(current); current = current.parent; }
      return null;
    },
    setChunkMode() {},
    updateForCamera() {},
    dispose() { disposeObject(world); },
  };
}

function localToGps(origin, x, z) {
  if (!origin || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const radians = Math.PI / 180;
  return {
    lat: origin.lat + z / (EARTH_RADIUS_METRES * radians),
    lon: origin.lon + x / (EARTH_RADIUS_METRES * radians * Math.cos(origin.lat * radians)),
  };
}

async function makeFullWorld(onProgress) {
  onProgress('Importing the production HESI map generator');
  const { HighwayMap } = await import('/js/map.js');
  onProgress('Generating real routes, structures, terrain, and props');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const map = new HighwayMap({ quality: 'low', applyFog: false });
  onProgress(`Measuring ${map._chunks?.size || 0} generated world chunks`);

  const chunks = [...(map._chunks?.values?.() || [])];
  const savedVisibility = chunks.map((chunk) => chunk.group.visible);
  chunks.forEach((chunk) => { chunk.group.visible = true; });
  map.group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(map.group);
  chunks.forEach((chunk, index) => { chunk.group.visible = savedVisibility[index]; });
  map.update(map.initialSpawn?.position, 0);
  onProgress('Discovering deterministic semantic world entities');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const discovery = discoverHesiEntities(map);

  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const origin = map.networkMeta?.origin || null;
  const spawn = map.getInitialSpawn?.() || map.initialSpawn;
  const tatsumi = map.serviceAreas?.find((area) => area.id === 'tatsumi_pa') || null;
  const spawnTarget = spawn?.position?.clone?.() || center.clone();
  const spawnForward = spawn?.tangent?.clone?.() || new THREE.Vector3(0, 0, -1);
  const spawnPosition = spawnTarget.clone().addScaledVector(spawnForward, -52).add(new THREE.Vector3(0, 26, 0));
  const presets = new Map();
  if (tatsumi?.center) {
    const target = tatsumi.center.clone();
    const tangent = tatsumi.tangent?.clone?.() || spawnForward;
    presets.set('tatsumi-pa', {
      id: 'tatsumi-pa', label: 'Tatsumi PA', position: target.clone().addScaledVector(tangent, -75).add(new THREE.Vector3(0, 42, 0)),
      target, near: 0.1, far: 120000, chunkMode: 'nearby', source: 'serviceAreas:tatsumi_pa',
    });
  }
  presets.set('initial-spawn', {
    id: 'initial-spawn', label: spawn?.label || 'Initial spawn', position: spawnPosition, target: spawnTarget,
    near: 0.1, far: 120000, chunkMode: 'nearby', source: spawn?.serviceAreaId || spawn?.routeId || 'map.initialSpawn',
  });
  presets.set('map-center', {
    id: 'map-center', label: 'Map center', position: center.clone().add(new THREE.Vector3(900, 1200, 900)), target: center.clone(),
    near: 0.5, far: 120000, chunkMode: 'nearby', source: 'calculated world bounds',
  });
  presets.set('entire-world', framePreset(bounds, 'Entire real world'));

  let chunkMode = 'nearby';
  const setChunkMode = (mode, cameraPosition = null) => {
    chunkMode = mode === 'all' ? 'all' : 'nearby';
    if (chunkMode === 'all') chunks.forEach((chunk) => { chunk.group.visible = true; });
    else {
      map._visibleKey = null;
      map.update(cameraPosition || spawnTarget, performance.now() / 1000);
    }
  };

  const minimap = map.getMinimapData?.();
  const metadata = {
    worldBounds: bounds,
    worldCenter: center,
    worldSize: size,
    mapOrigin: origin,
    mapScale: '1 world unit = 1 metre',
    routeCount: map.routes?.size || minimap?.routes?.length || 0,
    sourceRouteCount: map.networkMeta?.stats?.routeCount ?? null,
    chunkCount: chunks.length,
    serviceAreaCount: map.serviceAreas?.length || 0,
    junctionCount: map.junctions?.length || 0,
    approximateAreaKm2: size.x * size.z / 1e6,
    coordinateSystem: 'Local equirectangular metres: +X east, +Z north, +Y up',
    conversion: origin ? 'Exact inverse of HighwayMap._ll local equirectangular projection' : null,
    worldToGps: origin ? (position) => localToGps(origin, position.x, position.z) : null,
  };

  return {
    map,
    group: map.group,
    entities: discovery.entities,
    strategy: 'real',
    label: 'REAL HESI WORLD',
    isRealWorld: true,
    warning: null,
    focusTarget: bounds,
    bounds,
    metadata,
    presets,
    getPreset(id) { return presets.get(id) || null; },
    resolveSelection: discovery.resolveSelection,
    discovery,
    setChunkMode,
    updateForCamera(position, timeSeconds) { if (chunkMode === 'nearby') map.update(position, timeSeconds); },
    dispose() { map.dispose(); },
  };
}

export async function loadWorld({ mode = 'real', onProgress = () => {} } = {}) {
  if (mode === 'demo') return makeRepresentativeWorld(onProgress);
  try {
    return await makeFullWorld(onProgress);
  } catch (error) {
    console.error('[hesi-editor] real world failed; activating explicit fallback warning', error);
    return makeRepresentativeWorld(onProgress, { fallbackError: error });
  }
}

export { makeFullWorld, makeRepresentativeWorld, localToGps };
