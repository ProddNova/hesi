import * as THREE from 'three';

/**
 * Tatsumi No.1 PA — the lot you stand in.
 *
 * This is the dressing for the WALKABLE zone (js/tatsumi-pa.js), the scene you
 * arrive in through the lay-by gate with your car parked in front of you. The
 * drivable deck out on the expressway stays a bare paved clearing; everything
 * the reference photographs show — the service building with its backlit green
 * glass-block wall, the arched green-lit canopy over the forecourt, the vending
 * row under its flat canopy, the 45° large-vehicle comb with 大型 painted in
 * every bay, the 小型 small-car row — is built here, at the scale you walk it.
 *
 * EDITOR CONTRACT
 *
 * TatsumiPaSystem's children are addressed by build-order index, and the saved
 * build (data/editor/tatsumi-pa-build.json) hides children 5..10. Everything
 * here is therefore APPENDED after every existing child, as a handful of named
 * groups — one per part, so the editor can move or hide "PA building" without
 * touching "PA parking", and nothing that already had an index can move.
 *
 * COLLISION
 *
 * Solid pieces are individual meshes pushed onto `pa.staticColliders`
 * (refreshColliders takes their world AABB). Repeated flat/overhead pieces —
 * paint, mullions, arch ribs and glazing — go into InstancedMesh batches, which
 * must NOT be colliders: one AABB over a whole batch would wall off the lot.
 */

const FORWARD = new THREE.Vector3(0, 0, 1);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Local +Z onto a flat direction (same convention as map.js). */
function yawQuaternion(x, z) {
  const flat = V(x, 0, z);
  if (flat.lengthSq() < 1e-10) return new THREE.Quaternion();
  flat.normalize();
  return new THREE.Quaternion().setFromUnitVectors(FORWARD, flat);
}

/**
 * Road paint that is TEXT: white glyphs stacked down a transparent tile.
 *
 * The tile's top row lands on the decal's local −Z, so a decal whose +Z points
 * AT the reader shows the right way up with the first character farthest —
 * which is how road text is actually painted. Every caller passes the direction
 * from the paint towards whoever reads it.
 */
function paintTextMaterial(cache, glyphs) {
  if (cache.has(glyphs)) return cache.get(glyphs);
  let material;
  if (typeof document === 'undefined') {
    material = new THREE.MeshLambertMaterial({ color: 0xcfcdb8 });
  } else {
    const characters = [...glyphs];
    const cell = 128;
    const canvas = document.createElement('canvas');
    canvas.width = cell;
    canvas.height = cell * characters.length;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `bold ${Math.round(cell * 0.82)}px "Yu Gothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
    characters.forEach((character, index) => {
      context.fillText(character, cell * 0.5, cell * (index + 0.5));
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    material = new THREE.MeshLambertMaterial({
      map: texture, color: 0xcfcdb8, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  }
  cache.set(glyphs, material);
  return material;
}

/**
 * Build the lot into `pa` (a TatsumiPaSystem). `lot` is its footprint, so the
 * layout follows whatever PA_LOT says instead of hard-coding the walls.
 *
 * Returns the groups and the lights it added, so the caller can keep a handle
 * on them.
 */
export function buildTatsumiPaStructure(pa, lot) {
  const HALF_X = lot.width * 0.5;
  const HALF_Z = lot.depth * 0.5;

  // ------------------------------------------------------------------
  // Materials. Flat-shaded lambert like the rest of the scene; the lit
  // surfaces are Basic so they hold up with the masts switched off (the
  // saved build hides the four original ones).
  // ------------------------------------------------------------------
  const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
  const M = {
    paint: lambert(0xcfcdb8),
    concrete: lambert(0x8a9099, { emissive: 0x1a1d22 }),
    dark: lambert(0x272a31),
    wall: lambert(0x2a3039),
    steel: lambert(0xaab2bc, { emissive: 0x23262c }),
    glassBlock: basic(0x4dbb87),
    // The canopy is a LIT PANEL, not a light source. Unshaded Basic green at
    // full strength turns the whole lot into a neon tent; these are the
    // reference's deeper green, brighter across the crown than at the
    // springings, which is also what makes the arc read as an arc.
    canopyCrown: basic(0x1e7d50),
    canopyMid: basic(0x176544),
    canopySpring: basic(0x104a33),
    canopyLight: basic(0xfff2c9),
    truck: lambert(0xe8eef4),
    glass: lambert(0x0e1620),
    lampHead: basic(0xeafff4),
    blue: basic(0x1d47a0),
    exitGreen: basic(0x2fae6a),
  };
  const carColors = [0xb3324a, 0x3a68b6, 0xcfcfd4, 0x18191d, 0xd8a63a, 0x2d7a52, 0x74306e];
  const carMaterials = carColors.map((color) => lambert(color));
  const textCache = new Map();

  // ------------------------------------------------------------------
  // Emission helpers
  // ------------------------------------------------------------------
  const groups = {};
  const group = (name) => {
    if (!groups[name]) {
      const created = new THREE.Group();
      created.name = name;
      groups[name] = created;
    }
    return groups[name];
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  unitPlane.rotateX(-Math.PI * 0.5);   // flat, normal +Y

  // Batched (never a collider).
  const batches = new Map();
  const batch = (key, geometry, material, position, scale, quaternion = null) => {
    let entry = batches.get(key);
    if (!entry) { entry = { key, geometry, material, records: [] }; batches.set(key, entry); }
    entry.records.push({ position, scale, quaternion });
  };
  /** Flat paint slab. `angle` turns it about Y (0 = long axis on Z). */
  const paint = (x, z, width, length, angle = 0) =>
    batch('paint', unitBox, M.paint, V(x, 0.02, z), V(width, 0.04, length),
      yawQuaternion(Math.sin(angle), Math.cos(angle)));
  const text = (glyphs, x, z, width, length, angle) =>
    batch(`text:${glyphs}`, unitPlane, paintTextMaterial(textCache, glyphs),
      V(x, 0.035, z), V(width, 1, length), yawQuaternion(Math.sin(angle), Math.cos(angle)));

  // Individual mesh, optionally solid.
  const solids = [];
  const piece = (groupName, geometry, material, position, { rotationY = 0, quaternion = null, solid = false, name = '' } = {}) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    if (quaternion) mesh.quaternion.copy(quaternion);
    else mesh.rotation.y = rotationY;
    if (name) mesh.name = name;
    group(groupName).add(mesh);
    if (solid) solids.push(mesh);
    return mesh;
  };
  const boxPiece = (groupName, material, x, y, z, sx, sy, sz, options = {}) =>
    piece(groupName, new THREE.BoxGeometry(sx, sy, sz), material, V(x, y, z), options);

  // ------------------------------------------------------------------
  // 1. The service building — the back wall of the lot
  // ------------------------------------------------------------------
  const BUILDING_Z = -HALF_Z + 5;          // 6 m deep, 2 m clear of the wall
  const BUILDING_FRONT = BUILDING_Z + 3;
  const BUILDING_W = Math.min(30, lot.width - 16);
  boxPiece('PA building', M.wall, 0, 1.7, BUILDING_Z, BUILDING_W, 3.4, 6, { solid: true, name: 'PA building block' });
  boxPiece('PA building', M.dark, 0, 3.55, BUILDING_Z, BUILDING_W + 1, 0.3, 6.6);
  // Backlit glass block: the wall that makes the whole forecourt read green.
  const glassFrom = -BUILDING_W * 0.5 + 2;
  const glassTo = glassFrom + 10;
  boxPiece('PA building', M.glassBlock, (glassFrom + glassTo) * 0.5, 1.55, BUILDING_FRONT + 0.04, 10, 1.9, 0.16);
  for (let x = glassFrom; x <= glassTo + 0.01; x += 0.83) {
    batch('trim', unitBox, M.dark, V(x, 1.55, BUILDING_FRONT + 0.13), V(0.09, 2.0, 0.1));
  }
  for (const y of [0.68, 1.24, 1.86, 2.42]) {
    batch('trim', unitBox, M.dark, V((glassFrom + glassTo) * 0.5, y, BUILDING_FRONT + 0.13), V(10, 0.09, 0.1));
  }
  // Toilets: dark opening, lit header, step.
  boxPiece('PA building', M.glass, 0.5, 1.2, BUILDING_FRONT + 0.05, 3.4, 2.4, 0.14);
  boxPiece('PA building', M.canopyLight, 0.5, 2.62, BUILDING_FRONT + 0.12, 3.6, 0.32, 0.12);
  boxPiece('PA building', M.concrete, 0.5, 0.09, BUILDING_FRONT + 0.9, 3.6, 0.18, 1.6);

  // ------------------------------------------------------------------
  // 2. Vending row under its flat canopy
  // ------------------------------------------------------------------
  const vendingColors = [0xff5f6d, 0x8ad9ff, 0xfff2c9, 0xff5f6d, 0x8ad9ff, 0xffb0d0];
  const VEND_FROM = 4.6;
  for (let i = 0; i < 6; i += 1) {
    const x = VEND_FROM + i * 1.45;
    boxPiece('PA vending', M.dark, x, 1.03, BUILDING_FRONT + 0.55, 1.3, 2.06, 0.9, { solid: true });
    boxPiece('PA vending', basic(vendingColors[i]), x, 1.2, BUILDING_FRONT + 1.02, 1.14, 1.5, 0.1);
  }
  const flatCanopyX = VEND_FROM + 3.6;
  boxPiece('PA vending', M.dark, flatCanopyX, 3.75, BUILDING_FRONT + 1.5, 11.5, 0.3, 3.4);
  boxPiece('PA vending', M.canopyLight, flatCanopyX, 3.55, BUILDING_FRONT + 1.5, 9.5, 0.08, 1.8);
  for (const x of [flatCanopyX - 4.6, flatCanopyX, flatCanopyX + 4.6]) {
    boxPiece('PA vending', M.steel, x, 1.85, BUILDING_FRONT + 2.9, 0.22, 3.7, 0.22, { solid: true });
  }

  // ------------------------------------------------------------------
  // 3. The arched canopy over the forecourt
  //
  // A barrel vault: white steel ribs and purlins with green-lit glazing
  // between them. Each piece needs its own basis — local X across the lot,
  // local Z along the arc — which a yaw quaternion cannot give.
  // ------------------------------------------------------------------
  const ARCH_X = -1;
  const ARCH_SPAN = Math.min(26, BUILDING_W - 4);
  const KERB_Z = -5.2;
  const archNear = KERB_Z + 0.6;
  const archFar = BUILDING_FRONT - 0.2;
  const RIBS = 7;
  const SEGMENTS = 8;
  const archPoint = (s) => ({
    z: archNear + (archFar - archNear) * s,
    y: 5.2 + 0.4 * s + 3.7 * Math.sin(Math.PI * (s ** 0.92)),
  });
  const ribPitch = ARCH_SPAN / (RIBS - 1);
  const shades = [M.canopySpring, M.canopyMid, M.canopyCrown];
  for (let segment = 0; segment < SEGMENTS; segment += 1) {
    const a = archPoint(segment / SEGMENTS);
    const b = archPoint((segment + 1) / SEGMENTS);
    const dz = b.z - a.z;
    const dy = b.y - a.y;
    const span = Math.hypot(dz, dy);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(FORWARD, V(0, dy / span, dz / span));
    const midZ = (a.z + b.z) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    // Brighter across the crown than at the springings: a lit panel, not a
    // light source. Three shades instead of a per-instance colour so the
    // batches stay on shared materials.
    const lift = Math.sin(Math.PI * ((segment + 0.5) / SEGMENTS));
    const shade = shades[lift > 0.86 ? 2 : lift > 0.55 ? 1 : 0];
    for (let gap = 0; gap < RIBS - 1; gap += 1) {
      const x = ARCH_X - ARCH_SPAN * 0.5 + (gap + 0.5) * ribPitch;
      batch(`glaze${shades.indexOf(shade)}`, unitBox, shade,
        V(x, midY, midZ), V(ribPitch - 0.12, 0.12, span - 0.1), quaternion);
    }
    for (let rib = 0; rib < RIBS; rib += 1) {
      const x = ARCH_X - ARCH_SPAN * 0.5 + rib * ribPitch;
      // Ribs hang under the glazing — from below they read across the green,
      // which is the thing the reference is recognisable by.
      batch('rib', unitBox, M.steel,
        V(x, midY - 0.22, midZ), V(0.3, 0.34, span + 0.06), quaternion);
    }
  }
  for (let node = 0; node <= SEGMENTS; node += 1) {
    const point = archPoint(node / SEGMENTS);
    batch('purlin', unitBox, M.steel, V(ARCH_X, point.y - 0.3, point.z), V(ARCH_SPAN, 0.2, 0.2));
  }
  const springing = archPoint(0);
  const crownFar = archPoint(1);
  boxPiece('PA canopy', M.steel, ARCH_X, springing.y, springing.z, ARCH_SPAN + 1.4, 0.46, 0.46);
  for (const x of [ARCH_X - ARCH_SPAN * 0.38, ARCH_X, ARCH_X + ARCH_SPAN * 0.38]) {
    boxPiece('PA canopy', M.concrete, x, springing.y * 0.5, springing.z, 0.36, springing.y, 0.36, { solid: true });
    // The far springing lands on the building roof; short posts close the gap.
    boxPiece('PA canopy', M.steel, x, (crownFar.y + 3.6) * 0.5, archFar, 0.2, crownFar.y - 3.6, 0.2);
  }

  // ------------------------------------------------------------------
  // 4. Forecourt kerb, railing and the walkway to the doors
  // ------------------------------------------------------------------
  const KERB_FROM = -BUILDING_W * 0.5 - 1;
  const KERB_TO = BUILDING_W * 0.5 + 1;
  const GAP_FROM = -2;                    // the way in, in front of the doors
  const GAP_TO = 3;
  for (const [from, to] of [[KERB_FROM, GAP_FROM], [GAP_TO, KERB_TO]]) {
    batch('kerb', unitBox, M.concrete, V((from + to) * 0.5, 0.11, KERB_Z), V(to - from, 0.22, 0.42));
    for (const y of [0.55, 0.98]) {
      boxPiece('PA forecourt', M.steel, (from + to) * 0.5, y, KERB_Z - 0.45, to - from, 0.07, 0.07, { solid: y > 0.9 });
    }
    for (let x = from + 1; x < to; x += 2) {
      batch('railpost', unitBox, M.steel, V(x, 0.5, KERB_Z - 0.45), V(0.08, 1.0, 0.08));
    }
  }
  for (let i = 0; i < 5; i += 1) {   // zebra: parking -> doors
    paint(GAP_FROM + 0.6 + i * 0.95, KERB_Z - 1.8, 0.55, 3.4);
  }

  // ------------------------------------------------------------------
  // 5. Parking — parallel bays along the kerb (yours is the middle one),
  //    the 45° large-vehicle comb on one side, the 小型 row on the other
  // ------------------------------------------------------------------
  const BAY_Z = -3;                  // the stall TatsumiPaSystem parks you in
  for (let i = -2; i <= 3; i += 1) paint(i * 5.6 - 2.8, BAY_Z, 0.12, 2.8);
  paint(0, BAY_Z - 1.4, 28, 0.12);
  const parkCar = (x, z, rotationY, index) => {
    boxPiece('PA parking', carMaterials[index % carMaterials.length], x, 0.62, z, 4.3, 0.62, 1.78, { rotationY, solid: true });
    boxPiece('PA parking', M.glass, x - Math.cos(rotationY) * 0.35, 1.12, z + Math.sin(rotationY) * 0.35, 2.15, 0.48, 1.62, { rotationY });
  };
  parkCar(-11.2, BAY_Z, 0, 1);
  parkCar(11.2, BAY_Z, 0, 4);

  // 45° comb, nose to the wall: box trucks lean the way they turn in.
  const COMB_X = -HALF_X + 1.5;
  const combAxis = V(-Math.SQRT1_2, 0, -Math.SQRT1_2);   // mouth -> nose
  const combLength = 15;
  const combAngle = Math.atan2(combAxis.x, combAxis.z);
  const parkTruck = (x, z, angle) => {
    const nose = V(Math.sin(angle), 0, Math.cos(angle));
    const at = (distance) => V(x + nose.x * distance, 0, z + nose.z * distance);
    const chassis = at(0); boxPiece('PA parking', M.dark, chassis.x, 0.5, chassis.z, 2.25, 0.7, 8.6, { rotationY: angle, solid: true });
    const body = at(-2.0); boxPiece('PA parking', M.truck, body.x, 2.05, body.z, 2.5, 2.9, 6.0, { rotationY: angle, solid: true });
    const cab = at(3.2); boxPiece('PA parking', M.truck, cab.x, 1.5, cab.z, 2.35, 2.2, 2.3, { rotationY: angle, solid: true });
    const screen = at(4.32); boxPiece('PA parking', M.glass, screen.x, 2.0, screen.z, 2.1, 1.0, 0.16, { rotationY: angle });
  };
  const combStations = [-13, -8, -3, 2];
  for (const z of combStations) {
    paint(COMB_X - combAxis.x * combLength * 0.5, z - combAxis.z * combLength * 0.5, 0.14, combLength, combAngle);
    text('大型', COMB_X - combAxis.x * 4.6, z - combAxis.z * 4.6 + 2.55, 2.1, 4.6, combAngle + Math.PI);
  }
  paint(COMB_X - combAxis.x * combLength * 0.5, combStations[combStations.length - 1] + 5 - combAxis.z * combLength * 0.5,
    0.14, combLength, combAngle);
  parkTruck(COMB_X - combAxis.x * 4.9, combStations[1] + 2.55 - combAxis.z * 4.9, combAngle);
  parkTruck(COMB_X - combAxis.x * 4.9, combStations[3] + 2.55 - combAxis.z * 4.9, combAngle);

  // 小型 row, backed in against the far wall.
  const SMALL_X = HALF_X - 1.5;
  const SMALL_DEPTH = 5;
  const SMALL_PITCH = 2.6;
  const smallFrom = -12;
  const smallCount = 10;
  for (let i = 0; i <= smallCount; i += 1) {
    paint(SMALL_X - SMALL_DEPTH * 0.5, smallFrom + i * SMALL_PITCH, SMALL_DEPTH, 0.12);
    if (i === smallCount) break;
    const z = smallFrom + (i + 0.5) * SMALL_PITCH;
    text('小型', SMALL_X - 3.5, z, 2.9, 1.5, -Math.PI * 0.5);
    if (i % 3 === 1) parkCar(SMALL_X - 2.35, z, 0, i);
  }
  paint(SMALL_X - SMALL_DEPTH, smallFrom + smallCount * SMALL_PITCH * 0.5, 0.15, smallCount * SMALL_PITCH);
  // One wide accessible bay closing the row, blue pad, kept empty.
  const accessibleZ = smallFrom + smallCount * SMALL_PITCH + 1.9;
  paint(SMALL_X - SMALL_DEPTH * 0.5, accessibleZ + 1.9, SMALL_DEPTH, 0.12);
  batch('pad', unitPlane, M.blue, V(SMALL_X - 2.6, 0.03, accessibleZ), V(4.4, 1, 3.2));

  // ------------------------------------------------------------------
  // 6. The gate back to the expressway, framing the exit marker
  // ------------------------------------------------------------------
  // Built at the group's LOCAL origin and the group is then snapped onto the
  // exit portal: the portal is what the saved build pins (op childIndex 10)
  // and what refreshExitMarkers derives the exit point from, so the frame has
  // to follow it rather than assume the wall.
  for (const x of [-3.4, 3.4]) {
    boxPiece('PA gate', M.concrete, x, 1.7, 0, 0.8, 3.4, 0.8, { solid: true });
  }
  boxPiece('PA gate', M.concrete, 0, 3.6, 0, 8, 0.5, 0.8);
  boxPiece('PA gate', M.exitGreen, 0, 3.05, -0.45, 5.4, 0.5, 0.1);
  group('PA gate').position.set(0, 0, pa.exitPortal?.position.z ?? (HALF_Z - 0.5));

  // ------------------------------------------------------------------
  // 7. Lighting. The saved build hides the four original sodium masts, so the
  //    lot brings its own: cool white on the kerbs (the expressway keeps the
  //    sodium), a green wash under the canopy, a warm one on the vending row.
  // ------------------------------------------------------------------
  const lights = [];
  const addLight = (light, x, y, z) => {
    light.position.set(x, y, z);
    light.userData.gameSceneLight = true;
    group('PA lighting').add(light);
    lights.push(light);
    return light;
  };
  for (const [x, z] of [[-HALF_X + 8, -8], [HALF_X - 8, -8], [-HALF_X + 8, HALF_Z - 8], [HALF_X - 8, HALF_Z - 8]]) {
    boxPiece('PA lighting', M.dark, x, 4.2, z, 0.28, 8.4, 0.28);
    boxPiece('PA lighting', M.lampHead, x, 8.4, z, 1.5, 0.22, 0.6);
    addLight(new THREE.PointLight(0xd8f0e8, 11, 40, 1.6), x, 8, z);
  }
  addLight(new THREE.PointLight(0x8fe8bd, 9, 30, 1.8), ARCH_X, 5.4, (archNear + archFar) * 0.5);
  addLight(new THREE.PointLight(0xffe9c4, 5, 18, 2), flatCanopyX, 3.2, BUILDING_FRONT + 1.6);

  // ------------------------------------------------------------------
  // 8. Signage
  // ------------------------------------------------------------------
  const sign = (groupName, label, width, height, x, y, z, rotationY, background = '#175ba5') => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = Math.round(512 * height / width);
    const context = canvas.getContext('2d');
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'rgba(238,243,232,0.95)';
    context.lineWidth = Math.max(3, canvas.height * 0.04);
    context.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    const lines = label.split('|');
    context.fillStyle = '#f0f3e5';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    lines.forEach((line, index) => {
      const size = canvas.height / (lines.length + 0.6);
      context.font = `bold ${Math.round(size * (index ? 0.68 : 0.92))}px sans-serif`;
      context.fillText(line, canvas.width * 0.5, canvas.height * (index + 0.62) / (lines.length + 0.24));
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    mesh.name = `PA sign ${label}`;
    group(groupName).add(mesh);
    return mesh;
  };
  sign('PA building', 'トイレ|TOILET', 3.2, 1.35, 0.5, 2.95, BUILDING_FRONT + 0.2, 0);
  sign('PA building', '辰巳第一PA|TATSUMI No.1 PA', 6.4, 2.2, -BUILDING_W * 0.5 + 5, 4.9, BUILDING_Z - 3.1, Math.PI);
  sign('PA forecourt', '二輪車|MOTORCYCLE', 1.5, 1.5, KERB_FROM + 1.5, 2.2, KERB_Z + 0.6, 0, '#123a72');
  boxPiece('PA forecourt', M.concrete, KERB_FROM + 1.5, 0.72, KERB_Z + 0.6, 0.16, 1.45, 0.16);

  // ------------------------------------------------------------------
  // 9. Finalize: one InstancedMesh per batch, then the groups, appended in a
  //    fixed order so saved editor indices stay reproducible.
  // ------------------------------------------------------------------
  const matrix = new THREE.Matrix4();
  const identity = new THREE.Quaternion();
  for (const entry of batches.values()) {
    const mesh = new THREE.InstancedMesh(entry.geometry, entry.material, entry.records.length);
    mesh.name = `PA lot ${entry.key}`;
    entry.records.forEach((record, index) => {
      matrix.compose(record.position, record.quaternion || identity, record.scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere?.();
    group('PA paint').add(mesh);
  }
  const order = ['PA paint', 'PA parking', 'PA building', 'PA vending', 'PA canopy', 'PA forecourt', 'PA gate', 'PA lighting'];
  for (const name of order) if (groups[name]) pa.root.add(groups[name]);
  for (const mesh of solids) pa.staticColliders.push(mesh);

  return { groups, lights, solids: solids.length };
}

export default buildTatsumiPaStructure;
