import * as THREE from 'three';

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
  return { id, type, layer, name, object3D, editable: false, source };
}

function makeRepresentativeWorld(onProgress) {
  onProgress('Building representative highway scene');
  const world = new THREE.Group();
  world.name = 'HESI representative world';

  const asphalt = standard(0x171b21, { roughness: 0.92 });
  const concrete = standard(0x66707a);
  const metal = standard(0x8d9aa5, { roughness: 0.38, metalness: 0.68 });
  const markingMaterial = new THREE.MeshBasicMaterial({ color: 0xe7edf0 });
  const buildingMaterials = [standard(0x172230), standard(0x202937), standard(0x121a25)];
  const glass = standard(0x22465c, { emissive: 0x0b1d29, emissiveIntensity: 0.8 });

  const roads = new THREE.Group();
  roads.name = 'Roads';
  addBox(roads, [18, 0.7, 190], [0, 7.5, 0], asphalt, 'Elevated highway deck');
  addBox(roads, [14, 0.55, 116], [45, 15, -8], asphalt, 'Cross route deck').rotation.y = Math.PI / 2;
  world.add(roads);

  const markings = new THREE.Group();
  markings.name = 'Markings';
  for (let z = -84; z <= 84; z += 12) addBox(markings, [0.18, 0.035, 5], [0, 7.89, z], markingMaterial, 'Lane dash');
  for (const x of [-8.2, 8.2]) addBox(markings, [0.16, 0.035, 184], [x, 7.89, 0], markingMaterial, 'Edge line');
  world.add(markings);

  const guardrails = new THREE.Group();
  guardrails.name = 'Guardrails';
  for (const x of [-9.15, 9.15]) {
    addBox(guardrails, [0.18, 0.28, 188], [x, 8.55, 0], metal, 'Guardrail rail');
    for (let z = -90; z <= 90; z += 6) addBox(guardrails, [0.16, 1.2, 0.16], [x, 8.15, z], metal, 'Guardrail post');
  }
  world.add(guardrails);

  const pillars = new THREE.Group();
  pillars.name = 'Pillars';
  for (let z = -72; z <= 72; z += 24) {
    addBox(pillars, [2.2, 15, 2.2], [0, 0, z], concrete, 'Expressway pillar');
    addBox(pillars, [12, 1.2, 2.8], [0, 6.3, z], concrete, 'Pillar cap');
  }
  world.add(pillars);

  const buildings = new THREE.Group();
  buildings.name = 'Buildings';
  const buildingDefs = [
    [-32, 12, -52, 18, 25, 22], [-38, 20, -10, 23, 41, 18], [-30, 15, 36, 18, 31, 23],
    [34, 13, -62, 20, 27, 20], [38, 24, -22, 21, 49, 24], [33, 17, 43, 26, 35, 20],
  ];
  buildingDefs.forEach(([x, y, z, w, h, d], index) => {
    addBox(buildings, [w, h, d], [x, y, z], buildingMaterials[index % buildingMaterials.length], `Building ${index + 1}`);
    addBox(buildings, [w * 0.72, 0.06, d * 0.72], [x, y + h / 2 + 0.04, z], glass, 'Rooftop glow');
  });
  world.add(buildings);

  const props = new THREE.Group();
  props.name = 'Props';
  for (const z of [-58, -18, 22, 62]) {
    addBox(props, [0.3, 6, 0.3], [-12, 11, z], metal, 'Light pole');
    const lamp = new THREE.PointLight(0x79d9ff, 7, 22, 2);
    lamp.position.set(-12, 14, z);
    props.add(lamp);
  }
  addBox(props, [10, 3.5, 0.25], [0, 14, -36], glass, 'Overhead route sign');
  addBox(props, [0.25, 7, 0.25], [-4.5, 10.5, -36], metal, 'Sign post');
  addBox(props, [0.25, 7, 0.25], [4.5, 10.5, -36], metal, 'Sign post');
  world.add(props);

  const garage = new THREE.Group();
  garage.name = 'Garage';
  addBox(garage, [25, 8, 20], [-31, 4, 72], concrete, 'Garage shell');
  addBox(garage, [12, 5, 0.2], [-31, 3, 61.9], new THREE.MeshBasicMaterial({ color: 0xf0a74a }), 'Garage door');
  world.add(garage);

  const lighting = new THREE.Group();
  lighting.name = 'Lighting';
  const moon = new THREE.DirectionalLight(0xa9c9ff, 1.6);
  moon.position.set(45, 80, 30);
  lighting.add(moon);
  lighting.add(new THREE.HemisphereLight(0x32516e, 0x080a0d, 1.8));
  world.add(lighting);

  const entities = [
    entity('roads:representative-network', 'network', 'Roads', 'Representative expressway', roads),
    entity('markings:representative-network', 'road-markings', 'Markings', 'Lane and edge markings', markings),
    entity('guardrails:representative-network', 'guardrail-system', 'Guardrails', 'Highway guardrails', guardrails),
    entity('pillars:representative-network', 'support-system', 'Pillars', 'Elevated deck supports', pillars),
    entity('buildings:representative-city', 'city-block', 'Buildings', 'Representative city blocks', buildings),
    entity('props:representative-dressing', 'prop-collection', 'Props', 'Lights and signage', props),
    entity('garage:representative-pa', 'garage', 'Garage', 'Representative PA garage', garage),
    entity('lighting:representative-rig', 'lighting-rig', 'Lighting', 'Editor preview lighting', lighting),
  ];

  return {
    group: world,
    entities,
    strategy: 'representative',
    label: 'Representative scene',
    warning: null,
    focusTarget: world,
    dispose() { disposeObject(world); },
  };
}

async function makeFullWorld(onProgress) {
  onProgress('Importing the current HESI map generator');
  const { HighwayMap } = await import('/js/map.js');
  onProgress('Building the current HESI world (this may take a moment)');
  const map = new HighwayMap({ quality: 'low', applyFog: false });
  return {
    group: map.group,
    entities: [entity(
      'world:current-hesi-map',
      'generated-world',
      'Roads',
      'Current generated HESI world (read-only)',
      map.group,
      'js/map.js',
    )],
    strategy: 'full',
    label: 'Current HESI world',
    warning: 'The generated world is exposed as one read-only high-level entity in Checkpoint 1.',
    focusTarget: map.group,
    dispose() { map.dispose(); },
  };
}

export async function loadWorld({ mode = 'representative', onProgress = () => {} } = {}) {
  if (mode !== 'full') return makeRepresentativeWorld(onProgress);
  try {
    return await makeFullWorld(onProgress);
  } catch (error) {
    const fallback = makeRepresentativeWorld(onProgress);
    fallback.strategy = 'representative-fallback';
    fallback.label = 'Representative scene (fallback)';
    fallback.warning = `Full world could not load: ${error?.message || error}`;
    return fallback;
  }
}
