import * as THREE from 'three';

/**
 * Tatsumi No.1 PA — the lot you stand in.
 *
 * Dressing for the WALKABLE zone (js/tatsumi-pa.js), the scene you arrive in
 * through the lay-by gate with your car parked in front of you. The drivable
 * deck out on the expressway stays a bare paved clearing; everything the
 * reference photographs show is built here, at the scale you walk it.
 *
 * THE LOT IS A STRIP, NOT A YARD
 *
 * Every aerial of 辰巳第一PA shows the same thing: a long narrow ribbon between
 * the carriageways. The building and its canopy sit against ONE long side, the
 * large-vehicle bays take the rest of that side, the small-car row runs the
 * whole of the other side, and a single aisle separates them. A near-square
 * yard with the canopy floating in the middle of it is the one shape the place
 * never has — hence 150 x 34 (see PA_LOT in js/tatsumi-pa.js).
 *
 * THE CANOPY IS AN ARCH ACROSS THE FRONTAGE
 *
 * In the photographs the shell springs from a low eave at each END of the
 * frontage, climbs to a crown in the middle and extends forward off the
 * building as a vault — you look INTO it. Its ends are open. What you actually
 * read is white steel: arch ribs, longitudinals and alternating braces make the
 * reference lozenges, a bold white tube runs the whole rim, and the green
 * glazing is the fill between them. Seen from above it is a DARK roof, not a
 * green one, which is why there are two surfaces here and not one.
 *
 * Model it the other way round — arching front-to-back, amplitude tapered to
 * nothing at both ends — and you get a lens floating over the yard. That was
 * the previous pass and it is the thing to avoid.
 *
 * EDITOR CONTRACT
 *
 * TatsumiPaSystem's children are addressed by build-order index, and the saved
 * build (data/editor/tatsumi-pa-build.json) hides children 5..10. Everything
 * here is APPENDED after every existing child, as named groups — one per part,
 * so the editor can move or hide "PA building" without touching "PA parking",
 * and nothing that already had an index can move.
 *
 * COLLISION
 *
 * Solid pieces are individual meshes pushed onto `pa.staticColliders`
 * (refreshColliders takes their world AABB). Repeated flat/overhead pieces —
 * paint, rim, ribs, glazing, wheels, light pools — go into InstancedMesh
 * batches, which must NOT be colliders: one AABB over a whole batch would wall
 * off the lot.
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

/** Deterministic noise — screenshots have to be comparable between runs. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hasCanvas = () => typeof document !== 'undefined';

function canvasTexture(width, height, draw, { repeatX = 1, repeatY = 1 } = {}) {
  if (!hasCanvas()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  if (repeatX !== 1 || repeatY !== 1) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
  }
  if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Worn night asphalt. A 150 m deck with a flat colour reads as a backdrop. */
function asphaltTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    const rng = seeded(0x7a15);
    c.fillStyle = '#343941';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 5600; i += 1) {
      const level = Math.round(38 + rng() * 34);
      c.fillStyle = `rgba(${level},${level + 3},${level + 7},0.55)`;
      c.fillRect(rng() * w, rng() * h, 1 + rng() * 2.4, 1 + rng() * 2.4);
    }
    // Faint patch seams — the real deck is a mosaic of resurfacing jobs.
    c.strokeStyle = 'rgba(22,25,30,0.5)';
    c.lineWidth = 2;
    for (let i = 0; i < 5; i += 1) {
      c.beginPath();
      c.moveTo(rng() * w, 0);
      c.lineTo(rng() * w, h);
      c.stroke();
    }
  }, { repeatX: 24, repeatY: 6 });
}

/**
 * The pool a mast throws on the deck. The aerials read almost entirely by
 * these: bright teal discs down the strip with black between them. Cheaper
 * than a PointLight and it survives the night mix, so the far end of a 150 m
 * lot is not a void.
 */
function lightPoolTexture() {
  return canvasTexture(128, 128, (c, w, h) => {
    const gradient = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(0.22, 'rgba(216,247,238,0.62)');
    gradient.addColorStop(0.55, 'rgba(150,214,198,0.26)');
    gradient.addColorStop(1, 'rgba(120,190,180,0)');
    c.fillStyle = gradient;
    c.fillRect(0, 0, w, h);
  });
}

/**
 * The backlit glass-block wall: individual blocks with dark grout between
 * them, brighter towards the middle of each block. A flat green panel with
 * drawn-on mullions reads as a painted board; the wall in the reference is a
 * field of separate glowing squares, and that is the whole look of it.
 */
function glassBlockTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#0a1a14';
    c.fillRect(0, 0, w, h);
    const cells = 8;
    const size = w / cells;
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        const x = column * size;
        const y = row * size;
        const inset = size * 0.09;
        const gradient = c.createLinearGradient(x, y, x + size, y + size);
        gradient.addColorStop(0, '#3fae7c');
        gradient.addColorStop(0.45, '#7df0b4');
        gradient.addColorStop(1, '#2f8d63');
        c.fillStyle = gradient;
        c.fillRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
        // the pressed-glass cross every block carries
        c.strokeStyle = 'rgba(220,255,238,0.35)';
        c.lineWidth = Math.max(1, size * 0.045);
        c.beginPath();
        c.moveTo(x + size * 0.5, y + inset);
        c.lineTo(x + size * 0.5, y + size - inset);
        c.moveTo(x + inset, y + size * 0.5);
        c.lineTo(x + size - inset, y + size * 0.5);
        c.stroke();
      }
    }
  }, { repeatX: 6, repeatY: 1.5 });
}

/**
 * The frontage's green tile. Unlit (basic) on purpose: the real wall is washed
 * by the canopy floods, and a Lambert wall in this scene goes to black between
 * the masts — which is how the frontage disappeared in the previous pass.
 */
function greenTileTexture() {
  return canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#16302a';
    c.fillRect(0, 0, w, h);
    const cells = 10;
    const size = w / cells;
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        const shade = 1 - row / (cells * 2.4);
        const r = Math.round(38 * shade);
        const g = Math.round(120 * shade);
        const b = Math.round(92 * shade);
        c.fillStyle = `rgb(${r},${g},${b})`;
        c.fillRect(column * size + 1, row * size + 1, size - 2, size - 2);
      }
    }
  }, { repeatX: 8, repeatY: 1 });
}

/** A vending machine front: product rows behind glass, lit price strips. */
function vendingTexture(accent) {
  return canvasTexture(128, 256, (c, w, h) => {
    c.fillStyle = '#141820';
    c.fillRect(0, 0, w, h);
    c.fillStyle = accent;
    c.fillRect(0, 0, w, h * 0.11);              // brand band
    c.fillStyle = '#f4f7ff';
    c.fillRect(w * 0.06, h * 0.145, w * 0.88, h * 0.5);  // lit display
    const rows = 4;
    const columns = 4;
    const bottles = ['#e8493f', '#f2a63c', '#3f7fe8', '#e8e2d2', '#3fa85f', '#d94f8a', '#f0d24a'];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = w * 0.09 + column * (w * 0.82 / columns);
        const y = h * 0.16 + row * (h * 0.48 / rows);
        c.fillStyle = bottles[(row * columns + column) % bottles.length];
        c.fillRect(x, y, w * 0.82 / columns - 2, h * 0.48 / rows - 5);
        c.fillStyle = '#ff3b30';                 // the price strip under each row
        c.fillRect(x, y + h * 0.48 / rows - 5, w * 0.82 / columns - 2, 3);
      }
    }
    c.fillStyle = '#0d1117';                     // delivery flap + coin column
    c.fillRect(w * 0.06, h * 0.68, w * 0.88, h * 0.26);
    c.fillStyle = '#2b3440';
    c.fillRect(w * 0.1, h * 0.72, w * 0.5, h * 0.14);
    c.fillStyle = '#89f2b4';
    c.fillRect(w * 0.68, h * 0.71, w * 0.2, h * 0.035);
  });
}

/** The square 二輪車 board: a black motorcycle pictogram on white. */
function motorcycleSignTexture() {
  return canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#eef2f0';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#1b2026';
    c.lineWidth = 5;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#1b2026';
    c.beginPath();                                // wheels
    c.arc(w * 0.29, h * 0.66, h * 0.15, 0, Math.PI * 2);
    c.arc(w * 0.73, h * 0.66, h * 0.15, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#eef2f0';
    c.beginPath();
    c.arc(w * 0.29, h * 0.66, h * 0.08, 0, Math.PI * 2);
    c.arc(w * 0.73, h * 0.66, h * 0.08, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#1b2026';
    c.lineWidth = 7;
    c.beginPath();                                // frame, tank, bars
    c.moveTo(w * 0.29, h * 0.66);
    c.lineTo(w * 0.44, h * 0.46);
    c.lineTo(w * 0.62, h * 0.46);
    c.lineTo(w * 0.73, h * 0.66);
    c.stroke();
    c.beginPath();
    c.moveTo(w * 0.62, h * 0.46);
    c.lineTo(w * 0.76, h * 0.3);
    c.stroke();
    c.beginPath();
    c.moveTo(w * 0.68, h * 0.28);
    c.lineTo(w * 0.86, h * 0.32);
    c.stroke();
  });
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
  if (!hasCanvas()) {
    material = new THREE.MeshLambertMaterial({ color: 0xcfcdb8 });
  } else {
    const characters = [...glyphs];
    const cell = 128;
    const texture = canvasTexture(cell, cell * characters.length, (c, w) => {
      c.clearRect(0, 0, w, cell * characters.length);
      c.fillStyle = '#ffffff';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `bold ${Math.round(cell * 0.82)}px "Yu Gothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
      characters.forEach((character, index) => c.fillText(character, w * 0.5, cell * (index + 0.5)));
    });
    material = new THREE.MeshLambertMaterial({
      // Emissive floor for the same reason the lane paint carries one: most of
      // this lot is between the mast pools, which are decals and light nothing,
      // and unlit 大型 on unlit asphalt is invisible.
      map: texture, color: 0xcfcdb8, emissive: 0x33383a, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  }
  cache.set(glyphs, material);
  return material;
}

/**
 * The canopy surface — a vault ARCHED ACROSS the frontage.
 *
 *   u ∈ [-1, 1]  along the frontage; ±1 are the two eaves the arch springs from
 *   s ∈ [0, 1]   in depth, 0 = cantilevered forecourt rim, 1 = over the building
 *
 * `lift` is the arch, and it is a semi-ellipse rather than a cosine on purpose:
 * a cosine profile keeps only a quarter of its rise at 80 % out, so the last
 * few metres of shell flatten into a horizontal apron and every rib, purlin
 * and rim lands on it at once — from the side that apron reads as a white
 * plank stuck on the end. The ellipse holds the section out to the springing
 * and then drops.
 *
 * `droop` bleeds a little rise out of the cantilever so the leading rim sits
 * below the back of the crown, which is the forward tip the reference shell
 * has. `bowNear`/`pullFar` take the hard corners off the plan, and `tiltU`
 * leans the whole shell so the rim is not planar.
 */
function canopySurface(c) {
  const lift = (u) => (1 - Math.min(1, u * u)) ** 0.6;
  const droop = (s) => 1 - 0.15 * (1 - s) ** 1.7;
  const at = (u, s) => {
    const l = lift(u);
    const zNear = c.zNear + c.bowNear * (1 - u * u);
    const zFar = c.zFar + c.pullFar * u * u;
    return {
      u,
      s,
      lift: l,
      x: c.centreX + u * c.halfX,
      z: zNear + (zFar - zNear) * s,
      y: c.eave + c.rakeBack * s + c.tiltU * u + (c.crown - c.eave) * l * droop(s),
    };
  };
  return { at, point: (u, s) => { const p = at(u, s); return V(p.x, p.y, p.z); } };
}

/**
 * The deck material for the walkable lot. Exported because the deck plane is
 * TatsumiPaSystem's child 0 and has to stay child 0 — the material can change,
 * the build order cannot.
 */
export function paLotDeckMaterial() {
  const map = asphaltTexture();
  return new THREE.MeshLambertMaterial(map ? { map, color: 0xb9bfc8 } : { color: 0x353b43 });
}

/**
 * The cross-section and the landmarks along the strip, derived from the
 * footprint. Exported because TatsumiPaSystem has to park the car and stand
 * the exit gate on the same numbers the dressing is laid out from — the two
 * drifting apart is how the player's car ended up sitting on the zebra.
 */
export function paLotPlan(lot) {
  const halfX = lot.width * 0.5;
  const halfZ = lot.depth * 0.5;
  const buildingX0 = -31;
  const buildingBack = -halfZ + 0.4;
  const glassFrom = buildingX0 + 3.5;
  const glassTo = glassFrom + 11;
  const toiletX = glassTo + 2.6;          // the doors — the walkway serves these
  const kerbBayZ = 5.6;
  const kerbBayPitch = 5.8;
  const walkHalf = 2.4;                   // half the break the walkway takes
  return {
    halfX,
    halfZ,
    buildingX0,
    buildingX1: 5,
    buildingBack,
    buildingFront: buildingBack + 5.6,
    buildingRoof: 4,
    glassFrom,
    glassTo,
    toiletX,
    largeBack: -halfZ + 0.6,              // large-vehicle bays, deep end
    largeFront: -6,                       // …and their mouth on the aisle
    kerbBayZ,
    kerbBayPitch,
    walkHalf,
    // The player takes the first parallel bay clear of the walkway.
    carBay: { x: toiletX + walkHalf + kerbBayPitch * 0.5, z: kerbBayZ },
    smallFront: 12,
    smallBack: halfZ - 0.4,
    smallFrom: -58,
    smallTo: 50,
    gateX: 6,
    gateGap: 4.6,
  };
}

/**
 * Build the lot into `pa` (a TatsumiPaSystem). `lot` is its footprint, so the
 * layout follows whatever PA_LOT says instead of hard-coding the walls.
 */
export function buildTatsumiPaStructure(pa, lot) {
  // Cross-section of the strip, building side (−Z) to gate side (+Z).
  const P = paLotPlan(lot);
  const {
    halfX: HALF_X, halfZ: HALF_Z,
    buildingX0: BUILDING_X0, buildingX1: BUILDING_X1,
    buildingBack: BUILDING_BACK, buildingFront: BUILDING_FRONT, buildingRoof: BUILDING_ROOF,
    largeBack: LARGE_BACK, largeFront: LARGE_FRONT,
    kerbBayZ: KERB_BAY_Z, kerbBayPitch: KERB_BAY_PITCH, walkHalf: WALK_HALF,
    toiletX: TOILET_X, glassFrom, glassTo,
    smallFront: SMALL_FRONT, smallBack: SMALL_BACK, smallFrom: SMALL_FROM, smallTo: SMALL_TO,
    gateX: GATE_X, gateGap: GATE_GAP,
  } = P;

  const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
  const glassMap = glassBlockTexture();
  const tileMap = greenTileTexture();
  const poolMap = lightPoolTexture();
  const M = {
    // The mast POOLS are decals, not lights, so most of the strip's paint has
    // nothing shining on it; an emissive floor is what keeps the lines and the
    // bay markings readable the length of the lot.
    paint: lambert(0xcfcdb8, { emissive: 0x33383a }),
    concrete: lambert(0x8a9099, { emissive: 0x1a1d22 }),
    dark: lambert(0x272a31),
    wall: lambert(0x2a3039),
    tile: tileMap ? basic(0xffffff, { map: tileMap }) : basic(0x2c6b57),
    // The shell's structure is WHITE and lit: in every reference frame the
    // ribs and the rim tube are the brightest thing in the lot, and a Lambert
    // member up there gets no light at all.
    steel: basic(0xe9eff2),
    steelDim: basic(0x9fadb4),
    steelDark: lambert(0x6b757e, { emissive: 0x20262c }),
    glassBlock: glassMap ? basic(0xffffff, { map: glassMap }) : basic(0x4dbb87),
    glaze: basic(0xffffff, { side: THREE.DoubleSide, vertexColors: true }),
    canopyDeck: lambert(0x2d333b, { side: THREE.DoubleSide }),
    canopyUnder: basic(0xd7dbd6),
    canopyTop: lambert(0x3a4048),
    fascia: basic(0xe8ece8),
    // Parked bodies carry a small emissive floor for the reason the traffic
    // fleet does (js/traffic.js): between the mast pools nothing lights them,
    // and in the aerials the parked vehicles are pale shapes, not black holes.
    truck: lambert(0xe8eef4, { emissive: 0x22262c }),
    tyre: lambert(0x141619),
    glass: lambert(0x0e1620),
    lampHead: basic(0xeafff4),
    blue: basic(0x1d47a0),
    exitGreen: basic(0x2fae6a),
    pylon: basic(0xf4f8f4),
    pool: poolMap
      ? new THREE.MeshBasicMaterial({
          map: poolMap, color: 0x9fe6d6, transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      : null,
  };
  const carColors = [0xb3324a, 0x3a68b6, 0xcfcfd4, 0x18191d, 0xd8a63a, 0x2d7a52, 0x74306e, 0x9aa2ab];
  const carMaterials = carColors.map((color) => lambert(color, { emissive: 0x191c20 }));
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
  unitPlane.rotateX(-Math.PI * 0.5);
  // Wheels are batched, so the geometry carries the axle: rolling radius in
  // X/Y, tread width along Z, and every caller hands in the vehicle's LATERAL
  // direction (not its nose) as the quaternion.
  const unitWheel = new THREE.CylinderGeometry(1, 1, 1, 10);
  unitWheel.rotateX(Math.PI * 0.5);

  const batches = new Map();
  const batch = (key, geometry, material, position, scale, quaternion = null) => {
    let entry = batches.get(key);
    if (!entry) { entry = { key, geometry, material, records: [] }; batches.set(key, entry); }
    entry.records.push({ position, scale, quaternion });
  };
  const paint = (x, z, width, length, angle = 0) =>
    batch('paint', unitBox, M.paint, V(x, 0.02, z), V(width, 0.04, length),
      yawQuaternion(Math.sin(angle), Math.cos(angle)));
  const text = (glyphs, x, z, width, length, angle) =>
    batch(`text:${glyphs}`, unitPlane, paintTextMaterial(textCache, glyphs),
      V(x, 0.035, z), V(width, 1, length), yawQuaternion(Math.sin(angle), Math.cos(angle)));
  /** A member running between two 3-D points: the ribs, the rim, the struts. */
  const member = (key, material, a, b, thickness, extend = 0) => {
    const direction = V(b.x - a.x, b.y - a.y, b.z - a.z);
    const length = direction.length();
    if (length < 1e-4) return;
    direction.multiplyScalar(1 / length);
    batch(key, unitBox, material,
      V((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5),
      V(thickness, thickness, length + extend),
      new THREE.Quaternion().setFromUnitVectors(FORWARD, direction));
  };
  const pool = (x, z, radius) => {
    if (!M.pool) return;
    batch('pool', unitPlane, M.pool, V(x, 0.05, z), V(radius * 2, 1, radius * 2));
  };

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
  // 1. Service building
  //
  // One low block along the −Z side: glass-block wall, toilets, vending. The
  // frontage is banded the way the real one is — dark plinth, green tile,
  // dark eaves band — and the tile is the piece that has to stay readable at
  // night, so it is unlit.
  // ------------------------------------------------------------------
  const BUILDING_X = (BUILDING_X0 + BUILDING_X1) * 0.5;
  const BUILDING_W = BUILDING_X1 - BUILDING_X0;
  const BUILDING_Z = (BUILDING_BACK + BUILDING_FRONT) * 0.5;
  const BUILDING_D = BUILDING_FRONT - BUILDING_BACK;
  boxPiece('PA building', M.wall, BUILDING_X, BUILDING_ROOF * 0.5, BUILDING_Z,
    BUILDING_W, BUILDING_ROOF, BUILDING_D, { solid: true, name: 'PA building block' });
  // Tiled frontage, then the plinth and the eaves band over it.
  boxPiece('PA building', M.tile, BUILDING_X, 1.95, BUILDING_FRONT + 0.06, BUILDING_W - 0.4, 2.5, 0.12);
  boxPiece('PA building', M.dark, BUILDING_X, 0.35, BUILDING_FRONT + 0.1, BUILDING_W, 0.7, 0.2);
  boxPiece('PA building', M.dark, BUILDING_X, BUILDING_ROOF + 0.18, BUILDING_Z, BUILDING_W + 0.8, 0.36, BUILDING_D + 0.8);
  boxPiece('PA building', M.canopyUnder, BUILDING_X, 3.42, BUILDING_FRONT + 0.14, BUILDING_W, 0.14, 0.24);

  // The backlit glass-block wall, in its recessed steel surround.
  const glassX = (glassFrom + glassTo) * 0.5;
  const glassPanel = boxPiece('PA building', M.glassBlock, glassX, 1.9, BUILDING_FRONT + 0.14, 11, 2.1, 0.2);
  glassPanel.name = 'PA glass block wall';
  for (const [dy, sy] of [[3.04, 0.12], [0.8, 0.12]]) {
    batch('trim', unitBox, M.steelDim, V(glassX, dy, BUILDING_FRONT + 0.16), V(11.2, sy, 0.26));
  }
  for (const x of [glassFrom - 0.1, glassTo + 0.1]) {
    batch('trim', unitBox, M.steelDim, V(x, 1.9, BUILDING_FRONT + 0.16), V(0.14, 2.36, 0.26));
  }

  // Toilets: dark recess, lit header, step.
  boxPiece('PA building', M.glass, TOILET_X, 1.2, BUILDING_FRONT + 0.09, 3.4, 2.4, 0.14);
  boxPiece('PA building', M.canopyUnder, TOILET_X, 2.62, BUILDING_FRONT + 0.16, 3.6, 0.32, 0.12);
  boxPiece('PA building', M.concrete, TOILET_X, 0.09, BUILDING_FRONT + 0.9, 3.6, 0.18, 1.6);

  // ------------------------------------------------------------------
  // 2. Vending row under its flat canopy
  //
  // The canopy is a WHITE-soffited slab with a lit fascia — from the forecourt
  // it is a bright band over the machines, not a dark shelf.
  // ------------------------------------------------------------------
  const vendingAccents = ['#e8253c', '#1f7fd0', '#f4f2e8', '#e8253c', '#1f7fd0', '#d9377f'];
  const VEND_PITCH = 1.34;
  const VEND_COUNT = 6;
  const VEND_FROM = TOILET_X + 4.2;
  for (let i = 0; i < VEND_COUNT; i += 1) {
    const x = VEND_FROM + i * VEND_PITCH;
    boxPiece('PA vending', M.dark, x, 0.95, BUILDING_FRONT + 0.62, VEND_PITCH - 0.06, 1.9, 0.85, { solid: true });
    const map = vendingTexture(vendingAccents[i % vendingAccents.length]);
    const front = new THREE.Mesh(
      new THREE.PlaneGeometry(VEND_PITCH - 0.14, 1.78),
      map ? new THREE.MeshBasicMaterial({ map }) : basic(0xf2f4f8),
    );
    front.position.set(x, 0.99, BUILDING_FRONT + 1.05);
    group('PA vending').add(front);
  }
  const flatCanopyX = VEND_FROM + (VEND_COUNT - 1) * VEND_PITCH * 0.5;
  const flatCanopyW = VEND_COUNT * VEND_PITCH + 2.6;
  boxPiece('PA vending', M.canopyTop, flatCanopyX, 3.62, BUILDING_FRONT + 1.5, flatCanopyW, 0.26, 3.6);
  boxPiece('PA vending', M.canopyUnder, flatCanopyX, 3.47, BUILDING_FRONT + 1.5, flatCanopyW - 0.3, 0.06, 3.3);
  boxPiece('PA vending', M.fascia, flatCanopyX, 3.5, BUILDING_FRONT + 3.32, flatCanopyW, 0.34, 0.1);
  for (const x of [flatCanopyX - flatCanopyW * 0.42, flatCanopyX + flatCanopyW * 0.42]) {
    boxPiece('PA vending', M.steelDark, x, 1.74, BUILDING_FRONT + 3.1, 0.2, 3.48, 0.2, { solid: true });
  }
  // The tall lit pylon at the corner of the frontage.
  const PYLON_X = flatCanopyX + flatCanopyW * 0.5 + 1.4;
  boxPiece('PA vending', M.steelDark, PYLON_X, 1.5, BUILDING_FRONT + 1.1, 0.18, 3.0, 0.18);
  boxPiece('PA vending', M.pylon, PYLON_X, 2.6, BUILDING_FRONT + 1.1, 0.7, 2.2, 0.24);

  // ------------------------------------------------------------------
  // 3. THE CANOPY
  //
  // 27 m across the frontage, 14.4 m of depth, eave 4.9 m, crown 10.8 m: an
  // arch you look into, standing over the forecourt and reaching back over
  // the building roof.
  // ------------------------------------------------------------------
  const CANOPY = {
    centreX: BUILDING_X0 + 18,
    halfX: 13.2,
    zNear: 1.2,
    zFar: BUILDING_FRONT - 1.6,
    bowNear: 1.2,
    pullFar: 0.6,
    eave: 4.8,
    crown: 10.4,
    rakeBack: 0.5,
    tiltU: 0.55,
  };
  const canopy = canopySurface(CANOPY);
  const RIBS = 7;                    // arch ribs, across the frontage
  const PURLINS = 12;                // longitudinals, front to back
  const ARCH_STEPS = 26;

  // 3a. Two surfaces, not one: green glazing you see from underneath, and a
  //     dark roof deck 14 cm over it. From the aerials this thing is a black
  //     roof; from the forecourt it glows.
  {
    const columns = 56;
    const rows = 18;
    const stride = rows + 1;
    const positions = [];
    const roofPositions = [];
    const colors = [];
    const indices = [];
    const crown = new THREE.Color(0x53c78d);
    const foot = new THREE.Color(0x0d4530);
    const colour = new THREE.Color();
    for (let i = 0; i <= columns; i += 1) {
      const u = -1 + (2 * i) / columns;
      for (let j = 0; j <= rows; j += 1) {
        const point = canopy.at(u, j / rows);
        positions.push(point.x, point.y, point.z);
        roofPositions.push(point.x, point.y + 0.14, point.z);
        colour.copy(foot).lerp(crown, Math.min(1, point.lift ** 0.8));
        colors.push(colour.r, colour.g, colour.b);
      }
    }
    for (let i = 0; i < columns; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        const a = i * stride + j;
        indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
    const glazing = new THREE.BufferGeometry();
    glazing.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    glazing.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    glazing.setIndex(indices);
    glazing.computeVertexNormals();
    const glass = new THREE.Mesh(glazing, M.glaze);
    glass.name = 'PA canopy glazing';
    group('PA canopy').add(glass);

    const roof = new THREE.BufferGeometry();
    roof.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
    roof.setIndex(indices.slice());
    roof.computeVertexNormals();
    const deck = new THREE.Mesh(roof, M.canopyDeck);
    deck.name = 'PA canopy roof';
    group('PA canopy').add(deck);
  }

  // 3a-bis. The tympanum shutting the back of the vault down onto the building.
  //     Without it the arch's far opening stands 6 m clear of a 4 m roof and
  //     you look straight through the shell at the night sky — a black hole
  //     right in the middle of the frontage, which is the one thing the
  //     reference never shows.
  {
    const positions = [];
    const colors = [];
    const indices = [];
    // Deliberately much darker than the vault: this is the far wall of a lit
    // space, and matching the glazing's value would turn the middle of the
    // frontage into a flat green screen.
    const crown = new THREE.Color(0x1c5a3e);
    const foot = new THREE.Color(0x061a13);
    const colour = new THREE.Color();
    const columns = 40;
    for (let i = 0; i <= columns; i += 1) {
      const u = -1 + (2 * i) / columns;
      const top = canopy.at(u, 1);
      const base = Math.min(top.y, BUILDING_ROOF);
      positions.push(top.x, top.y, top.z, top.x, base, top.z);
      colour.copy(foot).lerp(crown, Math.min(1, top.lift ** 0.9));
      colors.push(colour.r, colour.g, colour.b, foot.r, foot.g, foot.b);
      if (i === 0) continue;
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const gable = new THREE.Mesh(geometry, M.glaze);
    gable.name = 'PA canopy tympanum';
    group('PA canopy').add(gable);
    // No mullions of its own: the posts that carry the back rim down onto the
    // roof (3d) already stand in this plane, and a second offset set of
    // verticals over the same glass reads as a fringe hanging off the crown.
  }

  // 3b. The steel. Arch ribs across, longitudinals along, one brace per bay —
  //     which is what turns the grid into the reference's lozenges without a
  //     scribble of full diagonals. All of it white: the shell reads as a
  //     white frame with green in the gaps, never as a green blob.
  const structural = (u, s, drop = 0.2) => {
    const point = canopy.point(u, s);
    point.y -= drop;
    return point;
  };
  for (let rib = 0; rib < RIBS; rib += 1) {
    const s = rib / (RIBS - 1);
    let previous = null;
    for (let step = 0; step <= ARCH_STEPS; step += 1) {
      const point = structural(-1 + (2 * step) / ARCH_STEPS, s);
      if (previous) member('rib', M.steel, previous, point, 0.3, 0.04);
      previous = point;
    }
  }
  for (let purlin = 0; purlin <= PURLINS; purlin += 1) {
    const u = -1 + (2 * purlin) / PURLINS;
    let previous = null;
    for (let step = 0; step <= 10; step += 1) {
      const point = structural(u, step / 10, 0.34);
      if (previous) member('purlin', M.steelDim, previous, point, 0.15, 0.03);
      previous = point;
    }
  }
  for (let purlin = 0; purlin < PURLINS; purlin += 1) {
    for (let rib = 0; rib < RIBS - 1; rib += 1) {
      const u0 = -1 + (2 * purlin) / PURLINS;
      const u1 = -1 + (2 * (purlin + 1)) / PURLINS;
      const s0 = rib / (RIBS - 1);
      const s1 = (rib + 1) / (RIBS - 1);
      const flip = (rib + purlin) % 2 === 0;
      member('purlin', M.steelDim,
        structural(flip ? u0 : u1, s0, 0.34), structural(flip ? u1 : u0, s1, 0.34), 0.12, 0.03);
    }
  }

  // 3c. The rim tube: the bold white outline the whole shape reads by. Both
  //     eaves, and closed round the two open arch ends.
  {
    let previousNear = null;
    let previousFar = null;
    for (let step = 0; step <= ARCH_STEPS * 2; step += 1) {
      const u = -1 + step / ARCH_STEPS;
      const near = structural(u, 0, 0.08);
      const far = structural(u, 1, 0.08);
      if (previousNear) {
        member('rim', M.steel, previousNear, near, 0.42, 0.05);
        member('rim', M.steel, previousFar, far, 0.34, 0.05);
      }
      previousNear = near;
      previousFar = far;
    }
    for (const u of [-1, 1]) {
      let previous = null;
      for (let step = 0; step <= 12; step += 1) {
        const point = structural(u, step / 12, 0.08);
        if (previous) member('rim', M.steel, previous, point, 0.4, 0.05);
        previous = point;
      }
    }
  }

  // 3d. What holds it up: two stayed columns standing in the forecourt, short
  //     posts where the back rim lands on the building roof, and the flying
  //     strut with its knuckle off the cantilevered end.
  for (const u of [-0.48, 0.48]) {
    const head = structural(u, 0.42, 0.34);
    boxPiece('PA canopy', M.steel, head.x, head.y * 0.5, head.z, 0.34, head.y, 0.34, { solid: true });
    for (const spread of [-0.13, 0.13]) {
      member('purlin', M.steelDim, V(head.x, head.y - 2.6, head.z), structural(u + spread, 0.14, 0.34), 0.14);
    }
  }
  for (let i = 0; i <= 6; i += 1) {
    const u = -1 + i / 3;
    const foot = structural(u, 1, 0.34);
    if (foot.y - BUILDING_ROOF < 0.15) continue;
    member('purlin', M.steelDim, foot, V(foot.x, BUILDING_ROOF, foot.z), 0.16);
  }
  {
    const tip = structural(-1, 0.24, 0.08);
    const boom = V(tip.x - 3.1, tip.y - 0.9, tip.z + 0.4);
    member('rim', M.steel, tip, boom, 0.24);
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 8), M.steel);
    knuckle.position.copy(boom);
    group('PA canopy').add(knuckle);
    member('purlin', M.steelDim, boom, structural(-0.8, 0.0, 0.34), 0.13);
    member('purlin', M.steelDim, boom, structural(-0.8, 0.5, 0.34), 0.13);
  }

  // ------------------------------------------------------------------
  // 4. The forecourt: curved kerb, railing, zebra
  //
  // The reference kerb is a long arc that bows out of the building line into
  // the lot and turns back at both ends — the shape the whole end of the
  // strip is laid out around, and the thing you see from the air.
  // ------------------------------------------------------------------
  const FORE = { x0: BUILDING_X0 - 2, x1: BUILDING_X1 + 2, bow: 13.5 };
  const kerbAt = (t) => V(
    FORE.x0 + (FORE.x1 - FORE.x0) * t, 0,
    BUILDING_FRONT + FORE.bow * Math.sin(Math.PI * t) ** 0.7,
  );
  // The break the walkway goes through, in t, aligned on the toilet doors.
  const gapCentre = (TOILET_X - FORE.x0) / (FORE.x1 - FORE.x0);
  const GAP = 0.055;
  {
    const steps = 56;
    let previous = null;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const point = kerbAt(t);
      const inGap = Math.abs(t - gapCentre) < GAP;
      if (previous && !inGap) {
        member('kerb', M.concrete, V(previous.x, 0.11, previous.z), V(point.x, 0.11, point.z), 0.34, 0.12);
        for (const y of [0.56, 1.0]) {
          member('rail', M.steelDark,
            V(previous.x, y, previous.z - 0.42), V(point.x, y, point.z - 0.42), 0.07, 0.04);
        }
        if (i % 3 === 0) batch('railpost', unitBox, M.steelDark, V(point.x, 0.5, point.z - 0.42), V(0.08, 1.0, 0.08));
      }
      previous = inGap ? null : point;
    }
  }
  {
    const walkway = kerbAt(gapCentre);
    for (let i = 0; i < 5; i += 1) paint(walkway.x - 1.9 + i * 0.95, walkway.z + 2.9, 0.55, 5.6);
  }

  // ------------------------------------------------------------------
  // 5. Parking
  // ------------------------------------------------------------------
  const parkCar = (x, z, rotationY, index) => {
    boxPiece('PA parking', carMaterials[index % carMaterials.length], x, 0.66, z, 4.3, 0.6, 1.78, { rotationY, solid: true });
    boxPiece('PA parking', M.glass, x - Math.cos(rotationY) * 0.35, 1.14, z + Math.sin(rotationY) * 0.35, 2.15, 0.48, 1.62, { rotationY });
    // A car body is 4.3 long on local X, so its lateral axis is local +Z.
    const axle = yawQuaternion(Math.sin(rotationY), Math.cos(rotationY));
    for (const [dx, dz] of [[-1.42, -0.86], [-1.42, 0.86], [1.42, -0.86], [1.42, 0.86]]) {
      batch('wheel', unitWheel, M.tyre,
        V(x + Math.cos(rotationY) * dx - Math.sin(rotationY) * dz, 0.33,
          z + Math.sin(rotationY) * dx + Math.cos(rotationY) * dz),
        V(0.33, 0.33, 0.22), axle);
    }
  };
  /** `angle` points where the nose points; the truck is drawn back from there. */
  const parkTruck = (x, z, angle, dark = false) => {
    const nose = V(Math.sin(angle), 0, Math.cos(angle));
    const at = (distance) => V(x + nose.x * distance, 0, z + nose.z * distance);
    const shell = dark ? M.steelDark : M.truck;
    const chassis = at(0); boxPiece('PA parking', M.dark, chassis.x, 0.62, chassis.z, 2.2, 0.6, 8.6, { rotationY: angle, solid: true });
    const body = at(-2.1); boxPiece('PA parking', shell, body.x, 2.2, body.z, 2.5, 2.9, 6.2, { rotationY: angle, solid: true });
    const skirt = at(-2.1); boxPiece('PA parking', M.dark, skirt.x, 0.76, skirt.z, 2.42, 0.18, 6.2, { rotationY: angle });
    const cab = at(3.4); boxPiece('PA parking', M.truck, cab.x, 1.6, cab.z, 2.35, 2.1, 2.3, { rotationY: angle, solid: true });
    const screen = at(4.52); boxPiece('PA parking', M.glass, screen.x, 2.15, screen.z, 2.1, 1.0, 0.16, { rotationY: angle });
    const grille = at(4.52); boxPiece('PA parking', M.dark, grille.x, 0.9, grille.z, 2.2, 1.1, 0.14, { rotationY: angle });
    // A truck body is 8.6 long on local Z, so its lateral axis is local +X.
    const axle = yawQuaternion(Math.cos(angle), -Math.sin(angle));
    for (const [dx, dd] of [[-1.12, 3.2], [1.12, 3.2], [-1.12, -2.7], [1.12, -2.7], [-1.12, -4.2], [1.12, -4.2]]) {
      const centre = at(dd);
      batch('wheel', unitWheel, M.tyre,
        V(centre.x + Math.cos(angle) * dx, 0.52, centre.z - Math.sin(angle) * dx),
        V(0.52, 0.52, 0.3), axle);
    }
  };

  // 5a. Parallel bays along the forecourt — where TatsumiPaSystem parks YOU
  //     (the middle one), and where the reference always has a couple of cars
  //     nosed up against the railing.
  // The row is BROKEN at the walkway: the zebra that comes off the kerb gap
  // crosses here on its way to the aisle, and a bay painted over it is a bay
  // the game then parks the player's car in — on the crossing.
  const kerbBayRuns = [
    { from: TOILET_X - WALK_HALF, direction: -1, bays: 3 },
    { from: TOILET_X + WALK_HALF, direction: 1, bays: 4 },
  ];
  for (const run of kerbBayRuns) {
    for (let i = 0; i <= run.bays; i += 1) paint(run.from + run.direction * i * KERB_BAY_PITCH, KERB_BAY_Z, 0.12, 2.9);
    const span = run.bays * KERB_BAY_PITCH;
    paint(run.from + run.direction * span * 0.5, KERB_BAY_Z - 1.45, span, 0.12);
  }
  const kerbBayAt = (run, i) => run.from + run.direction * (i + 0.5) * KERB_BAY_PITCH;
  parkCar(kerbBayAt(kerbBayRuns[0], 1), KERB_BAY_Z, 0, 2);
  parkCar(kerbBayAt(kerbBayRuns[1], 2), KERB_BAY_Z, 0, 5);

  // 5b. The 45° large-vehicle comb — the aerial's signature. Bays lean towards
  //     +X so a truck coming down the aisle turns straight into one.
  const COMB_FROM = 12;
  const COMB_BAYS = 10;
  const COMB_ANGLE = Math.PI * 0.75;                       // nose towards (+X, −Z)
  const combAxis = V(Math.sin(COMB_ANGLE), 0, Math.cos(COMB_ANGLE));
  const COMB_DEPTH = (LARGE_FRONT - LARGE_BACK) / -combAxis.z;   // bay length along its axis
  const COMB_PITCH = 3.65 / Math.abs(combAxis.x);               // spacing measured along X
  for (let i = 0; i <= COMB_BAYS; i += 1) {
    const x = COMB_FROM + i * COMB_PITCH;
    paint(x + combAxis.x * COMB_DEPTH * 0.5, LARGE_FRONT + combAxis.z * COMB_DEPTH * 0.5,
      0.14, COMB_DEPTH, COMB_ANGLE);
    if (i === COMB_BAYS) break;
    const cx = x + COMB_PITCH * 0.5 + combAxis.x * 5.2;
    const cz = LARGE_FRONT + combAxis.z * 5.2;
    text('大型', cx, cz, 2.3, 4.4, COMB_ANGLE + Math.PI);
  }
  paint(COMB_FROM + COMB_BAYS * COMB_PITCH * 0.5, LARGE_FRONT, COMB_BAYS * COMB_PITCH, 0.16);
  for (const i of [1, 4, 5, 8]) {
    parkTruck(COMB_FROM + (i + 0.5) * COMB_PITCH + combAxis.x * 9.5,
      LARGE_FRONT + combAxis.z * 9.5, COMB_ANGLE, i === 5);
  }

  // 5c. The perpendicular large-vehicle row at the far end of the strip.
  const PERP_FROM = -63;
  const PERP_BAYS = 7;
  const PERP_PITCH = 3.7;
  for (let i = 0; i <= PERP_BAYS; i += 1) {
    const x = PERP_FROM + i * PERP_PITCH;
    paint(x, (LARGE_BACK + LARGE_FRONT) * 0.5, 0.14, LARGE_FRONT - LARGE_BACK);
    if (i === PERP_BAYS) break;
    text('大型', x + PERP_PITCH * 0.5, LARGE_FRONT - 3.4, 2.5, 4.6, 0);
  }
  paint(PERP_FROM + PERP_BAYS * PERP_PITCH * 0.5, LARGE_FRONT, PERP_BAYS * PERP_PITCH, 0.16);
  for (const i of [0, 3, 4]) {
    parkTruck(PERP_FROM + (i + 0.5) * PERP_PITCH, LARGE_BACK + 5.2, Math.PI, i === 3);
  }

  // 5d. The 小型 row down the whole gate side, with the walkway break the exit
  //     gate opens onto and one wide accessible bay at the end.
  const SMALL_PITCH = 2.7;
  const SMALL_BAYS = Math.floor((SMALL_TO - SMALL_FROM) / SMALL_PITCH);
  const smallOccupancy = seeded(0x51a7);
  for (let i = 0; i <= SMALL_BAYS; i += 1) {
    const x = SMALL_FROM + i * SMALL_PITCH;
    const centre = x + SMALL_PITCH * 0.5;
    const blocked = Math.abs(x - GATE_X) < GATE_GAP;
    if (!blocked) paint(x, (SMALL_FRONT + SMALL_BACK) * 0.5, 0.12, SMALL_BACK - SMALL_FRONT);
    if (i === SMALL_BAYS) break;
    if (Math.abs(centre - GATE_X) < GATE_GAP) continue;
    text('小型', centre, SMALL_FRONT + 2.9, 1.9, 3.2, Math.PI);
    if (smallOccupancy() < 0.34) parkCar(centre, SMALL_FRONT + 2.4, Math.PI * 0.5, i);
  }
  paint((SMALL_FROM + SMALL_TO) * 0.5, SMALL_FRONT, SMALL_TO - SMALL_FROM, 0.16);
  {
    const accessible = SMALL_TO + 2.4;
    paint(SMALL_TO, (SMALL_FRONT + SMALL_BACK) * 0.5, 0.12, SMALL_BACK - SMALL_FRONT);
    paint(accessible + 2.4, (SMALL_FRONT + SMALL_BACK) * 0.5, 0.12, SMALL_BACK - SMALL_FRONT);
    batch('pad', unitPlane, M.blue, V(accessible, 0.03, SMALL_FRONT + 2.4), V(4.4, 1, 4.2));
  }
  // Zebra from the gate break through to the aisle.
  for (let i = 0; i < 5; i += 1) paint(GATE_X - 1.9 + i * 0.95, SMALL_FRONT + 2.4, 0.55, 4.4);

  // 5e. Lane paint on the aisle itself: an edge line each side and the dashed
  //     centre the reference lot runs down the middle of the strip.
  paint(0, LARGE_FRONT + 0.9, HALF_X * 1.86, 0.14);
  for (let x = -HALF_X + 6; x < HALF_X - 6; x += 5.2) paint(x, 2.0, 2.6, 0.14);

  // 5f. Gore chevrons at both ends, where the real strip tapers into the ramps.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i += 1) {
      const x = side * (HALF_X - 4 - i * 3.4);
      for (const arm of [-1, 1]) {
        paint(x, arm * 2.6, 0.16, 5.4, arm * side * 0.62);
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Gate back to the expressway (positioned onto the exit portal by
  //    TatsumiPaSystem.refreshExitMarkers, so it follows the saved build).
  // ------------------------------------------------------------------
  for (const x of [-3.4, 3.4]) {
    boxPiece('PA gate', M.concrete, x, 1.7, 0, 0.8, 3.4, 0.8, { solid: true });
  }
  boxPiece('PA gate', M.concrete, 0, 3.6, 0, 8, 0.5, 0.8);
  boxPiece('PA gate', M.exitGreen, 0, 3.05, -0.45, 5.4, 0.5, 0.1);
  group('PA gate').position.set(pa.exitPortal?.position.x ?? GATE_X, 0, pa.exitPortal?.position.z ?? (HALF_Z - 0.5));

  // ------------------------------------------------------------------
  // 7. Lighting — the saved build hides all four original sodium masts, so the
  //    lot brings its own. Twin-headed like the reference, one down each side
  //    in a stagger, and every one of them lays an additive pool on the deck:
  //    that is what the strip reads by from the air, and it costs nothing.
  // ------------------------------------------------------------------
  const lights = [];
  const addLight = (light, x, y, z) => {
    light.position.set(x, y, z);
    light.userData.gameSceneLight = true;
    group('PA lighting').add(light);
    lights.push(light);
    return light;
  };
  const MAST_Z = HALF_Z - 1.2;
  const masts = [
    [-56, -MAST_Z, 1, true], [-30, MAST_Z, -1, true], [-4, MAST_Z, -1, true],
    [22, -MAST_Z, 1, true], [42, -MAST_Z, 1, true], [50, MAST_Z, -1, false],
    [64, -MAST_Z, 1, false], [-70, MAST_Z, -1, false],
  ];
  for (const [x, z, facing, lit] of masts) {
    boxPiece('PA lighting', M.dark, x, 4.6, z, 0.26, 9.2, 0.26, { solid: true });
    boxPiece('PA lighting', M.dark, x + facing * 0.9, 9.2, z, 1.9, 0.16, 0.16);
    for (const arm of [-1, 1]) {
      boxPiece('PA lighting', M.lampHead, x + facing * (0.9 + arm * 0.64), 9.1, z, 0.88, 0.2, 0.5);
    }
    pool(x + facing * 5, z - facing * 5, 15);
    if (lit) addLight(new THREE.PointLight(0xd8f0e8, 16, 52, 1.4), x + facing * 1.2, 8.8, z);
  }
  // The wash under the shell and the warm one on the vending row.
  pool(CANOPY.centreX, (CANOPY.zNear + CANOPY.zFar) * 0.5 + 3, 16);
  addLight(new THREE.PointLight(0x8fe8bd, 14, 40, 1.6),
    CANOPY.centreX, 6.4, (CANOPY.zNear + CANOPY.zFar) * 0.5);
  addLight(new THREE.PointLight(0xffe9c4, 6, 20, 2), flatCanopyX, 3.2, BUILDING_FRONT + 1.6);

  // ------------------------------------------------------------------
  // 8. Signage
  // ------------------------------------------------------------------
  const board = (groupName, label, width, height, x, y, z, rotationY, background = '#175ba5') => {
    const map = canvasTexture(512, Math.round(512 * height / width), (c, w, h) => {
      c.fillStyle = background;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(238,243,232,0.95)';
      c.lineWidth = Math.max(3, h * 0.04);
      c.strokeRect(6, 6, w - 12, h - 12);
      const lines = label.split('|');
      c.fillStyle = '#f0f3e5';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      lines.forEach((line, index) => {
        const size = h / (lines.length + 0.6);
        c.font = `bold ${Math.round(size * (index ? 0.68 : 0.92))}px sans-serif`;
        c.fillText(line, w * 0.5, h * (index + 0.62) / (lines.length + 0.24));
      });
    });
    if (!map) return null;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map }));
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    mesh.name = `PA sign ${label}`;
    group(groupName).add(mesh);
    return mesh;
  };
  board('PA building', 'トイレ|TOILET', 3.2, 1.35, TOILET_X, 2.95, BUILDING_FRONT + 0.24, 0);
  board('PA building', '辰巳第一PA|TATSUMI No.1 PA', 6.4, 2.2, BUILDING_X0 + 6, 5.2, BUILDING_BACK - 0.2, Math.PI);
  {
    const map = motorcycleSignTexture();
    const x = glassFrom + 0.6;
    const z = BUILDING_FRONT + 1.9;
    if (map) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map }));
      mesh.position.set(x, 2.25, z);
      mesh.name = 'PA sign motorcycle';
      group('PA forecourt').add(mesh);
    }
    batch('trim', unitBox, M.steelDark, V(x, 0.85, z), V(0.1, 1.7, 0.1));
  }

  // ------------------------------------------------------------------
  // 9. Finalize
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
    // The additive pools sit on the deck with depth writes off, so they have
    // to draw after the paint that shares that surface.
    if (entry.key === 'pool') mesh.renderOrder = 3;
    group('PA paint').add(mesh);
  }
  const order = ['PA paint', 'PA parking', 'PA building', 'PA vending', 'PA canopy', 'PA forecourt', 'PA gate', 'PA lighting'];
  for (const name of order) if (groups[name]) pa.root.add(groups[name]);
  for (const mesh of solids) pa.staticColliders.push(mesh);

  return { groups, lights, solids: solids.length };
}

export default buildTatsumiPaStructure;
