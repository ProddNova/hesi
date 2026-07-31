import * as THREE from 'three';

/**
 * Tatsumi No.1 PA — the real lot, built from the reference photography.
 *
 * The deck itself (rectangle, elevation, aisle, connectors, spawn, garage
 * trigger) is fitted in map.js `_defineTatsumiDeck`; this module only dresses
 * it. What it lays out, following the aerials and the two driver-eye shots:
 *
 *   ramp kerb   — the signature 45° large-vehicle comb, 大型 painted in every
 *                 bay, box trucks nose-in against the back kerb, and a second
 *                 perpendicular large-vehicle block at the exit end;
 *   aisle       — one-way, edge lines and straight arrows, kept clear end to
 *                 end because the entry/exit connectors ride it;
 *   far kerb    — the 小型 small-car row and one wide accessible bay, then the
 *                 forecourt: a curved kerb island carrying the service
 *                 building, its green glass-block wall, the toilets, the
 *                 vending row under a flat canopy, and the arched green-lit
 *                 roof that is the thing you actually recognise the PA by.
 *
 * WHY IT IS ITS OWN PASS, OUTSIDE THE CHUNK BUCKETS
 *
 * The deck is a suppression rectangle: `_instance` zero-scales anything placed
 * inside it and `_addChunkMesh` hides it, which is what keeps the lot a bare
 * paved clearing and what the old `_buildTatsumiPaDressing` tombstones live
 * in. Two consequences, and this module is shaped by both:
 *
 *  - the sanctioned way to put VISIBLE geometry on the deck is to build after
 *    `_finalizeChunks`, straight into `map.group`, flagged
 *    `userData.tatsumiClearingSurface` — the same door `_buildZoneEntrances`
 *    and `_buildTatsumiBayLamps` go through;
 *  - the user's saved editor edits address props by (mesh name, instance
 *    index) in the chunk meshes. Nothing here touches those buckets, so this
 *    whole lot cannot move a single saved edit — and the old dressing is left
 *    running, still suppressed, precisely because its tombstones are what hold
 *    those indices open.
 *
 * Everything is visual. Lot collision stays the flat deck slab, as before.
 */

const FORWARD = new THREE.Vector3(0, 0, 1);
const IDENTITY = new THREE.Quaternion();

const vec = (x, y, z) => new THREE.Vector3(x, y, z);

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local +Z onto `direction` (flattened), matching map.js `yawQuaternion`. */
function yawQuaternion(direction) {
  const flat = vec(direction.x, 0, direction.z);
  if (flat.lengthSq() < 1e-10) return new THREE.Quaternion();
  flat.normalize();
  return new THREE.Quaternion().setFromUnitVectors(FORWARD, flat);
}

/**
 * Road paint that is TEXT: white glyphs stacked down a transparent tile.
 *
 * Orientation matters more than the glyphs do. The tile's top row lands on the
 * decal's local -Z, so a decal whose +Z points AT the driver reads the right
 * way up from the seat, first character farthest — which is how road text is
 * painted. Every caller here passes the direction from the paint to the aisle.
 */
function paintTextMaterial(map, glyphs) {
  const key = `paLotPaint:${glyphs}`;
  if (map._signMaterials.has(key)) return map._signMaterials.get(key);
  let material;
  if (typeof document === 'undefined') {
    // Headless (probes): no canvas, so the text becomes plain paint. Same
    // instance count and the same placement either way.
    material = map.materials.marking;
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
    map._ownedTextures.add(texture);
    // Lambert like the `marking` palette entry, for the same reason: a Basic
    // material would glow white under the dark night mix. depthWrite off +
    // polygon offset keeps it off the slab without floating.
    material = new THREE.MeshLambertMaterial({
      map: texture,
      color: 0xd8d6bf,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }
  map._signMaterials.set(key, material);
  return material;
}

/**
 * Dress the Tatsumi deck. Called from `HighwayMap._buildWorld`, last, after
 * `_finalizeChunks` (it needs `map._unitGeometries`).
 */
export function buildTatsumiPaLot(map) {
  const area = (map.serviceAreas || []).find((candidate) => candidate.id === 'tatsumi_pa');
  if (!area || area.dressing !== 'tatsumi' || !map._unitGeometries) return null;

  const random = mulberry32((map.seed ^ 0x7a75c1a1) >>> 0);
  const R = area.rampSideSign ?? -1;        // large-vehicle side (the ramp_8 kerb)
  const F = -R;                             // far side: small cars, building
  const halfL = area.length * 0.5;
  const halfW = area.width * 0.5;
  const aisleV = area.aisleV ?? 0;
  const aisleHalf = area.tatsumiPlan?.aisleHalf ?? 3.3;
  const tangent = area.tangent;
  const outward = area.normal;

  // Deck frame: u along the one-way flow, v across (+v is `area.normal`).
  const at = (u, v, y = 0) => {
    const point = area.center.clone().addScaledVector(tangent, u).addScaledVector(outward, v);
    point.y = area.elevation + y;
    return point;
  };
  const direction = (angle) => vec(
    tangent.x * Math.cos(angle) + outward.x * Math.sin(angle),
    0,
    tangent.z * Math.cos(angle) + outward.z * Math.sin(angle),
  );
  const facing = (angle) => yawQuaternion(direction(angle));
  const ALONG = facing(0);

  // ------------------------------------------------------------------
  // Emission: one InstancedMesh per (geometry, material), into map.group.
  // ------------------------------------------------------------------
  const parts = new Map();
  const put = (name, geometry, material, position, scale, quaternion = null, color = null) => {
    let part = parts.get(name);
    if (!part) {
      part = { geometry, material, records: [] };
      parts.set(name, part);
    }
    part.records.push({ position, scale, quaternion, color });
  };
  const prop = (type, position, scale, quaternion = null, color = null) => {
    const [geometryName, materialName] = type.split(':');
    put(type, map._unitGeometries[geometryName] || map._unitGeometries.box,
      map.materials[materialName] || map.materials.concrete, position, scale, quaternion, color);
  };
  // Box sizes are (across, up, along) in the box's OWN frame; `angle` turns
  // that frame in the deck plane (0 = along the flow, +pi/2 = toward +v).
  const box = (type, u, v, y, size, angle = 0, color = null) =>
    prop(type, at(u, v, y), size, facing(angle), color);
  // Flat paint: a thin slab, same convention as the rest of the generator.
  const line = (u, v, width, length, angle = 0) =>
    prop('box:marking', at(u, v, 0.03), vec(width, 0.03, length), facing(angle));
  const text = (glyphs, u, v, width, length, angle) =>
    put(`text ${glyphs}`, map._unitGeometries.pool, paintTextMaterial(map, glyphs),
      at(u, v, 0.05), vec(width, 1, length), facing(angle));
  const pool = (u, v, width, length) =>
    prop('pool:lightPool', at(u, v, 0.07), vec(width, 1, length), ALONG);

  // Bands. The aisle is the one thing nothing may stand in: both connectors
  // ride it and the player spawns on it at u = 0.
  const kerbR = R * (halfW - 0.6);
  const kerbF = F * (halfW - 0.6);
  const edgeR = aisleV + R * (aisleHalf + 0.5);
  const edgeF = aisleV + F * (aisleHalf + 0.5);

  // ------------------------------------------------------------------
  // 1. Deck edges and the one-way aisle
  // ------------------------------------------------------------------
  for (const side of [R, F]) {
    line(0, side * (halfW - 0.3), 0.3, area.length - 1, 0);
    // Cheap white delineators: the lot is deliberately open-edged (no
    // parapet — see TATSUMI_PA_STATUS), so the edge has to read some other way.
    for (let u = -halfL + 6; u <= halfL - 6; u += 9) {
      box('box:concrete', u, side * (halfW - 0.45), 0.45, vec(0.12, 0.9, 0.12));
    }
  }
  line(8, edgeR, 0.15, 168, 0);
  line(-32, edgeF, 0.15, 82, 0);
  line(66.5, edgeF, 0.15, 45, 0);
  for (const u of [-72, -34, 4, 42, 78]) {   // straight-ahead arrows down the aisle
    line(u - 0.9, aisleV, 0.34, 2.4);
    // Both barbs have to END at the tip, or the head opens downstream and the
    // arrow reads as pointing back up the aisle.
    for (const side of [-1, 1]) {
      const angle = side * 0.85;
      prop('box:marking',
        at(u + 1.4 - Math.cos(angle) * 0.75, aisleV - side * Math.sin(Math.abs(angle)) * 0.75, 0.03),
        vec(0.3, 0.03, 1.5), facing(angle), null);
    }
  }
  // Wedge gores at both gates, the way the real strip tapers into them.
  for (const [uFrom, uTo, side, gate] of [
    [-halfL + 2, -halfL + 20, F, 'from'], [-halfL + 2, -halfL + 20, R, 'from'],
    [halfL - 9, halfL - 2, F, 'to'], [halfL - 7, halfL - 2, R, 'to'],
  ]) {
    const vIn = side === F ? edgeF : edgeR;
    const vOut = side * (halfW - 0.9);
    for (let u = uFrom; u <= uTo; u += 2.4) {
      const t = gate === 'from' ? (u - uFrom) / (uTo - uFrom) : (uTo - u) / (uTo - uFrom);
      const span = (vOut - vIn) * (0.12 + 0.88 * t);
      if (Math.abs(span) < 1.2) continue;
      prop('box:marking', at(u, vIn + span * 0.5, 0.03),
        vec(0.42, 0.03, Math.abs(span) / 0.87), facing(side * 1.05), null);
    }
  }

  // ------------------------------------------------------------------
  // 2. Large-vehicle comb, 45° nose-in against the ramp kerb
  //
  // Trucks turn in forward off the aisle, so every bay leans downstream:
  // mouth at the aisle upstream, nose on the back kerb downstream. That lean
  // is the shape the whole lot is recognisable by from the air.
  // ------------------------------------------------------------------
  const bayAngle = R * Math.PI * 0.25;
  const bayAxis = { u: Math.cos(bayAngle), v: Math.sin(bayAngle) };
  const bayDepth = Math.abs(kerbR - edgeR);
  const bayLength = bayDepth * Math.SQRT2;
  const COMB_PITCH = 5.1;
  const COMB_FROM = -68;
  const COMB_BAYS = 20;
  // Cool whites: the lot lamps are warm, and a body tinted anywhere near cream
  // comes out tan under them instead of the reference's white box trucks.
  const truckColors = [0xf2f6f8, 0xe8eef4, 0xdde7f0, 0xeef0f2];
  const parkTruck = (u, v, angle, color) => {
    const nose = { u: Math.cos(angle), v: Math.sin(angle) };
    const offset = (distance, y, type, size, tint = null) =>
      box(type, u + nose.u * distance, v + nose.v * distance, y, size, angle, tint);
    offset(0, 0.5, 'box:concreteDark', vec(2.25, 0.7, 8.6));
    offset(-2.0, 2.05, 'box:parkedBody', vec(2.5, 2.9, 6.0), color);
    offset(3.2, 1.5, 'box:parkedBody', vec(2.35, 2.2, 2.3), color);
    offset(4.32, 2.0, 'box:parkedGlass', vec(2.1, 1.0, 0.16));
  };
  for (let i = 0; i <= COMB_BAYS; i += 1) {
    const u = COMB_FROM + i * COMB_PITCH;
    line(u - bayAxis.u * bayLength * 0.5, kerbR - bayAxis.v * bayLength * 0.5,
      0.14, bayLength, bayAngle);
    if (i === COMB_BAYS) break;
    const centreU = u + COMB_PITCH * 0.5;
    text('大型', centreU - bayAxis.u * 4.6, kerbR - bayAxis.v * 4.6, 2.1, 4.6, bayAngle + Math.PI);
    if (random() < 0.45) {
      parkTruck(centreU - bayAxis.u * 4.9, kerbR - bayAxis.v * 4.9, bayAngle,
        truckColors[Math.floor(random() * truckColors.length)]);
    }
  }

  // ------------------------------------------------------------------
  // 3. Perpendicular large-vehicle block at the exit end
  // ------------------------------------------------------------------
  const BLOCK_FROM = 44;
  const BLOCK_PITCH = 5.2;
  const BLOCK_BAYS = 8;
  const blockDepth = 9.0;
  for (let i = 0; i <= BLOCK_BAYS; i += 1) {
    const u = BLOCK_FROM + i * BLOCK_PITCH;
    line(u, kerbR - R * blockDepth * 0.5, 0.14, blockDepth, Math.PI * 0.5);
    if (i === BLOCK_BAYS) break;
    const centreU = u + BLOCK_PITCH * 0.5;
    text('大型', centreU, kerbR - R * 3.2, 1.9, 4.2, -R * Math.PI * 0.5);
    if (random() < 0.45) {
      parkTruck(centreU, kerbR - R * 4.4, R * Math.PI * 0.5,
        truckColors[Math.floor(random() * truckColors.length)]);
    }
  }
  line(BLOCK_FROM + BLOCK_BAYS * BLOCK_PITCH * 0.5, kerbR - R * blockDepth,
    0.15, BLOCK_BAYS * BLOCK_PITCH, 0);

  // ------------------------------------------------------------------
  // 4. Small-car row, backed in against the far kerb
  // ------------------------------------------------------------------
  const SMALL_PITCH = 2.55;
  const SMALL_FROM = -70;
  const SMALL_BAYS = 30;
  const smallDepth = area.tatsumiPlan?.smallDepth ?? 5.0;
  const smallFront = kerbF - F * smallDepth;
  const carColors = [0xb3324a, 0x3a68b6, 0xcfcfd4, 0x18191d, 0xd8a63a, 0x74306e, 0x2d7a52, 0x8a2f24];
  const parkCar = (u, v, angle, color) => {
    const nose = { u: Math.cos(angle), v: Math.sin(angle) };
    box('box:parkedBody', u, v, 0.62, vec(1.78, 0.62, 4.3), angle, color);
    box('box:parkedGlass', u - nose.u * 0.35, v - nose.v * 0.35, 1.12,
      vec(1.62, 0.48, 2.15), angle);
  };
  for (let i = 0; i <= SMALL_BAYS; i += 1) {
    const u = SMALL_FROM + i * SMALL_PITCH;
    line(u, kerbF - F * smallDepth * 0.5, 0.12, smallDepth, Math.PI * 0.5);
    if (i === SMALL_BAYS) break;
    const centreU = u + SMALL_PITCH * 0.5;
    text('小型', centreU, kerbF - F * 3.5, 1.5, 2.9, -F * Math.PI * 0.5);
    if (random() < 0.55) {
      parkCar(centreU, kerbF - F * 2.35, -F * Math.PI * 0.5 + (random() - 0.5) * 0.08,
        carColors[Math.floor(random() * carColors.length)]);
    }
  }
  line(SMALL_FROM + SMALL_BAYS * SMALL_PITCH * 0.5, smallFront, 0.15, SMALL_BAYS * SMALL_PITCH, 0);
  // One wide accessible bay closing the row, kept empty, blue pad.
  const accessibleU = SMALL_FROM + SMALL_BAYS * SMALL_PITCH + 1.9;
  line(accessibleU + 1.9, kerbF - F * smallDepth * 0.5, 0.12, smallDepth, Math.PI * 0.5);
  line(accessibleU, smallFront, 0.15, 3.8, 0);
  box('box:marker', accessibleU, kerbF - F * 2.6, 0.028, vec(3.2, 0.02, 4.4), Math.PI * 0.5);

  // ------------------------------------------------------------------
  // 5. Forecourt island — the curved kerb the building sits behind
  //
  // A straight front closed by quarter-turns back to the deck edge: from
  // above that is the rounded end the aerials show, and on the ground it is
  // what stops the aisle from running into the vending row.
  // ------------------------------------------------------------------
  const ISLAND_FROM = 21;
  const ISLAND_TO = 39;
  const ISLAND_V = F * 5.4;
  const ISLAND_RADIUS = 4.2;
  const kerbPiece = (u, v, angle, length) =>
    box('box:concrete', u, v, 0.11, vec(0.42, 0.22, length), angle);
  for (let u = ISLAND_FROM; u <= ISLAND_TO; u += 1.3) kerbPiece(u, ISLAND_V, 0, 1.34);
  for (const end of [-1, 1]) {
    const cornerU = end < 0 ? ISLAND_FROM : ISLAND_TO;
    const steps = 7;
    for (let step = 0; step < steps; step += 1) {
      const phi = ((step + 0.5) / steps) * Math.PI * 0.5;
      const u = cornerU + end * ISLAND_RADIUS * Math.sin(phi);
      const v = ISLAND_V + F * ISLAND_RADIUS * (1 - Math.cos(phi));
      // Tangent of the quarter-turn, in the deck frame: +u toward +v.
      kerbPiece(u, v, Math.atan2(F * Math.sin(phi), end * Math.cos(phi)),
        ISLAND_RADIUS * (Math.PI * 0.5 / steps) * 1.1);
    }
    const straightU = cornerU + end * ISLAND_RADIUS;
    const from = ISLAND_V + F * ISLAND_RADIUS;
    const to = F * (halfW - 0.6);
    kerbPiece(straightU, (from + to) * 0.5, Math.PI * 0.5, Math.abs(to - from));
  }
  // Zebra from the aisle onto the island's upstream end.
  for (let i = 0; i < 5; i += 1) {
    line(11.5 + i * 1.15, (edgeF + ISLAND_V) * 0.5, 0.6, Math.abs(ISLAND_V - edgeF), Math.PI * 0.5);
  }

  // ------------------------------------------------------------------
  // 6. The service building: toilets, the green glass-block wall, the doors
  // ------------------------------------------------------------------
  const BUILDING_U = 30;
  const buildingV = F * (halfW - 3.2);
  const buildingFront = buildingV - F * 2.8;
  box('box:garage', BUILDING_U, buildingV, 1.65, vec(5.6, 3.3, 21));
  box('box:concreteDark', BUILDING_U, buildingV, 3.45, vec(6.2, 0.3, 21.6));
  // Backlit glass block, the wall that makes the whole forecourt read green.
  box('box:konbini', 23.8, buildingFront - F * 0.06, 1.55, vec(0.16, 1.9, 8.4));
  for (let u = 19.8; u <= 28.1; u += 0.84) {
    box('box:concreteDark', u, buildingFront - F * 0.15, 1.55, vec(0.1, 2.0, 0.09));
  }
  for (const y of [0.68, 1.24, 1.86, 2.42]) {
    box('box:concreteDark', 23.8, buildingFront - F * 0.15, y, vec(0.1, 0.09, 8.4));
  }
  // Toilet entrance: dark opening, lit header, sign.
  box('box:parkedGlass', 30.4, buildingFront - F * 0.05, 1.2, vec(0.14, 2.4, 3.4));
  box('box:canopy', 30.4, buildingFront - F * 0.12, 2.62, vec(0.12, 0.32, 3.6));
  box('box:concrete', 30.4, buildingFront - F * 0.9, 0.09, vec(1.6, 0.18, 3.6));

  // ------------------------------------------------------------------
  // 7. Vending row under its flat canopy, and the forecourt railing
  // ------------------------------------------------------------------
  const vendingColors = [0xff5f6d, 0x8ad9ff, 0xfff2c9, 0xff5f6d, 0x8ad9ff, 0xffb0d0];
  for (let i = 0; i < 6; i += 1) {
    const u = 33.2 + i * 1.4;
    box('box:concreteDark', u, buildingFront - F * 0.5, 1.03, vec(0.9, 2.06, 1.28));
    box('box:vending', u, buildingFront - F * 0.96, 1.2, vec(0.1, 1.5, 1.12), 0, vendingColors[i]);
  }
  box('box:concreteDark', 34.5, buildingFront - F * 0.4, 3.75, vec(2.9, 0.3, 15));
  box('box:canopy', 34.5, buildingFront - F * 0.5, 3.55, vec(1.8, 0.08, 13));
  for (const u of [32, 36.5, 41]) {
    box('box:railMetal', u, buildingFront - F * 1.5, 1.85, vec(0.22, 3.7, 0.22));
  }
  // Forecourt railing, just inside the kerb (the one you stand at with a can).
  const railV = ISLAND_V + F * 0.5;
  for (const y of [0.55, 0.98]) box('box:railMetal', 30.5, railV, y, vec(0.07, 0.07, 17));
  for (let u = 22.5; u <= 38.5; u += 2) box('box:railMetal', u, railV, 0.5, vec(0.08, 1.0, 0.08));

  // ------------------------------------------------------------------
  // 8. The arched canopy
  //
  // A barrel vault across the forecourt: white steel ribs and purlins with
  // green-lit glazing between them. Built rib-segment by rib-segment because
  // each piece needs its own basis — local X along the deck, local Z along
  // the arc — which a yaw quaternion cannot give.
  // ------------------------------------------------------------------
  const ARCH_U = 29;
  const ARCH_LENGTH = 22;
  const ARCH_RIBS = 7;
  const ARCH_SEGMENTS = 8;
  const archNear = F * 6.6;
  const archFar = F * (halfW - 0.5);
  const archPoint = (s) => ({
    v: archNear + (archFar - archNear) * s,
    y: 5.2 + 0.4 * s + 3.7 * Math.sin(Math.PI * (s ** 0.92)),
  });
  const archBasis = (dv, dy) => {
    const zAxis = vec(outward.x * dv, dy, outward.z * dv).normalize();
    const xAxis = vec(tangent.x, 0, tangent.z).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    return {
      quaternion: new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
      ),
      normal: yAxis,
    };
  };
  const ribPitch = ARCH_LENGTH / (ARCH_RIBS - 1);
  for (let segment = 0; segment < ARCH_SEGMENTS; segment += 1) {
    const a = archPoint(segment / ARCH_SEGMENTS);
    const b = archPoint((segment + 1) / ARCH_SEGMENTS);
    const dv = b.v - a.v;
    const dy = b.y - a.y;
    const span = Math.hypot(dv, dy);
    const { quaternion, normal } = archBasis(dv, dy);
    const midV = (a.v + b.v) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    for (let gap = 0; gap < ARCH_RIBS - 1; gap += 1) {   // glazing
      const u = ARCH_U - ARCH_LENGTH * 0.5 + (gap + 0.5) * ribPitch;
      // Dimmed off the palette's exit green, brighter across the crown than at
      // the springings: at full strength the roof is a neon slab that owns the
      // whole aerial, and the reference is a lit panel, not a light source.
      // Instance colour REPLACES the base (the clone goes white), so this is
      // the absolute colour — exitGreen scaled, not a multiplier.
      const crown = 0.5 + 0.4 * Math.sin(Math.PI * ((segment + 0.5) / ARCH_SEGMENTS));
      const shade = new THREE.Color(0.216 * crown, 0.898 * crown, 0.498 * crown).getHex();
      put('box:exitGreen', map._unitGeometries.box, map.materials.exitGreen,
        at(u, midV, midY), vec(ribPitch - 0.12, 0.12, span - 0.1), quaternion, shade);
    }
    for (let rib = 0; rib < ARCH_RIBS; rib += 1) {       // ribs, under the glazing
      const u = ARCH_U - ARCH_LENGTH * 0.5 + rib * ribPitch;
      const position = at(u, midV, midY).addScaledVector(normal, -0.24);
      put('box:railMetal', map._unitGeometries.box, map.materials.railMetal,
        position, vec(0.3, 0.34, span + 0.06), quaternion);
    }
  }
  for (let node = 0; node <= ARCH_SEGMENTS; node += 1) { // longitudinal purlins
    const point = archPoint(node / ARCH_SEGMENTS);
    box('box:railMetal', ARCH_U, point.v, point.y - 0.3, vec(0.2, 0.2, ARCH_LENGTH));
  }
  const springing = archPoint(0);
  box('box:railMetal', ARCH_U, springing.v, springing.y, vec(0.46, 0.46, ARCH_LENGTH + 1.4));
  for (const u of [ARCH_U - 9.5, ARCH_U, ARCH_U + 9.5]) {
    box('box:barrier', u, archNear, springing.y * 0.5, vec(0.36, springing.y, 0.36));
    // The far springing lands on the building roof; short posts close the gap.
    const far = archPoint(1);
    box('box:railMetal', u, archFar, (far.y + 3.6) * 0.5, vec(0.2, far.y - 3.6, 0.2));
  }
  // The forecourt glow the aerials pick the PA out by.
  pool(ARCH_U, F * 9.5, 19, 30);
  pool(BUILDING_U + 6, buildingFront - F * 2.0, 8, 16);

  // ------------------------------------------------------------------
  // 9. Lot lighting — cool white, unlike the sodium row on the expressway
  // ------------------------------------------------------------------
  const lamp = (u, side) => {
    const poleV = side * (halfW - 1.1);
    const quaternion = facing(side > 0 ? 0 : Math.PI);
    prop('lamppost:concrete', at(u, poleV, 0), vec(1, 1, 1), quaternion);
    prop('box:lampWhite', at(u, poleV - side * 2.28, 9.36), vec(1.2, 0.12, 0.4), quaternion);
    pool(u, poleV - side * 4.2, 13, 17);
  };
  for (const u of [-62, -26, 10, 46, 78]) lamp(u, R);
  for (const u of [-62, -26, 6, 58, 82]) lamp(u, F);

  // ------------------------------------------------------------------
  // 10. Signage
  // ------------------------------------------------------------------
  const signs = [];
  const board = (label, background, width, height, u, v, y, angle, posted = true) => {
    // The post is instanced either way: a headless build (probes) has no
    // canvas for the board itself, and should still produce the same lot.
    if (posted) {
      const post = y - height * 0.5;
      box('box:concrete', u, v, post * 0.5, vec(0.16, post, 0.16));
    }
    if (typeof document === 'undefined') return;
    const mesh = map._makeSignMesh(label, background, width, height, width > 3.2);
    mesh.position.copy(at(u, v, y));
    mesh.quaternion.copy(facing(angle));
    mesh.userData.tatsumiClearingSurface = true;
    mesh.name = `Tatsumi PA sign ${label}`;
    signs.push(mesh);
  };
  board('辰巳第一PA|TATSUMI No.1 PA', '#175ba5', 6.4, 2.2, -halfL + 8, F * (halfW - 2.2), 4.0, Math.PI);
  board('P', '#1958a8', 1.9, 1.9, -halfL + 8, R * (halfW - 2.2), 3.4, Math.PI);
  board('トイレ|TOILET', '#175ba5', 3.2, 1.35, 30.4, buildingFront - F * 0.42, 2.95, -F * Math.PI * 0.5, false);
  board('二輪車|MOTORCYCLE', '#123a72', 1.5, 1.5, 22.5, ISLAND_V + F * 1.6, 2.4, -F * Math.PI * 0.5);
  board('出口|EXIT', '#0f6a3f', 3.4, 1.5, halfL - 6, R * (halfW - 2.2), 3.3, Math.PI);

  // ------------------------------------------------------------------
  // 11. Finalize
  // ------------------------------------------------------------------
  const matrix = new THREE.Matrix4();
  const meshes = [];
  for (const [name, part] of parts) {
    const tinted = part.records.some((record) => record.color !== null && record.color !== undefined);
    // Per-instance colour needs a white base, exactly like _instancedChunkMesh.
    const material = tinted ? part.material.clone() : part.material;
    if (tinted) material.color.set(0xffffff);
    const mesh = new THREE.InstancedMesh(part.geometry, material, part.records.length);
    mesh.name = `Tatsumi PA lot ${name}`;
    // The lot is the thing that is MEANT to stand inside the clearing
    // rectangle (see _addChunkMesh / _buildZoneEntrances).
    mesh.userData.tatsumiClearingSurface = true;
    part.records.forEach((record, index) => {
      matrix.compose(record.position, record.quaternion || IDENTITY, record.scale);
      mesh.setMatrixAt(index, matrix);
      if (tinted) mesh.setColorAt(index, new THREE.Color(record.color ?? part.material.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere?.();
    map.group.add(mesh);
    meshes.push(mesh);
  }
  for (const sign of signs) map.group.add(sign);

  // The lamp lenses and the lit canopy are fixtures like any other: let the
  // player's paint shader pick them up, the way the bay lamps do.
  const paintLight = { lampWhite: { range: 26, strength: 0.7 } };
  for (const u of [-62, -26, 10, 46, 78]) {
    const point = at(u, R * (halfW - 1.1) - R * 2.28, 9.36);
    const key = map._chunkKey(point.x, point.z);
    if (!map._carPaintLightChunks.has(key)) map._carPaintLightChunks.set(key, []);
    map._carPaintLightChunks.get(key).push({
      position: point,
      materialName: 'lampWhite',
      range: paintLight.lampWhite.range,
      strength: paintLight.lampWhite.strength,
      distanceSq: Infinity,
    });
  }

  return { meshes: meshes.length, instances: [...parts.values()].reduce((sum, part) => sum + part.records.length, 0) };
}

export default buildTatsumiPaLot;
