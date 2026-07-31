import * as THREE from 'three';

/**
 * Tatsumi No.1 PA — the lot you stand in.
 *
 * Dressing for the WALKABLE zone (js/tatsumi-pa.js), the scene you arrive in
 * through the lay-by gate with your car parked in front of you. The drivable
 * deck out on the expressway stays a bare paved clearing; everything the
 * reference photographs show is built here, at the scale you walk it.
 *
 * THE CANOPY IS THE BUILDING
 *
 * The thing that makes the place recognisable is the roof, and it is not a
 * barrel vault: it is a shallow shell on an ELLIPTICAL plan — a lens. It comes
 * down to a rim at every edge, tips forward off the building so the leading
 * edge cantilevers over the forecourt, and it carries a DIAGRID (two crossing
 * diagonal families of white members, lozenges not ribs) under green glazing,
 * with a bold white tube running the whole rim and a flying strut off the
 * cantilevered tip. Modelling it as a half-cylinder with parallel ribs is what
 * makes a version of this lot read as a draft. So the glazing here is a real
 * parametric surface (spherical-cap height over an elliptical plan) and the
 * structure is laid on it, not around it.
 *
 * EDITOR CONTRACT
 *
 * TatsumiPaSystem's children are addressed by build-order index, and the saved
 * build (data/editor/tatsumi-pa-build.json) hides children 5..10. Everything
 * here is therefore APPENDED after every existing child, as a handful of named
 * groups — one per part, so the editor can move or hide "PA building" without
 * touching "PA parking", and nothing that already had an index can move.
 * here is APPENDED after every existing child, as named groups — one per part,
 * so the editor can move or hide "PA building" without touching "PA parking",
 * and nothing that already had an index can move.
 *
 * COLLISION
 *
 * Solid pieces are individual meshes pushed onto `pa.staticColliders`
 * (refreshColliders takes their world AABB). Repeated flat/overhead pieces —
 * paint, mullions, diagrid members, glazing — go into InstancedMesh batches,
 * which must NOT be colliders: one AABB over a whole batch would wall off the
 * lot.
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
      map: texture, color: 0xcfcdb8, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  }
  cache.set(glyphs, material);
  return material;
}

/**
 * The canopy surface.
 *
 * An ARCH in section — that is what the thing is, and modelling it as a dome
 * flattens it into a disc — with the arch's amplitude tapered towards both ends
 * by `envelope`, so the ends sweep down to the eave line instead of being a
 * cylinder cut off square. Plus a sweep (`tiltU`) and a rake (`tiltS`), which
 * is what stops the rim from being planar.
 *
 *   u ∈ [-1, 1]  along the length
 *   s ∈ [0, 1]   across, near (forecourt) edge to far (building) edge
 */
function canopySurface({ centreX, halfX, zNear, zFar, eave, rise, tiltS, tiltU }) {
  const envelope = (u) => (1 - u * u) ** 0.35;
  const arch = (s) => Math.sin(Math.PI * (s ** 0.95));
  const lift = (u, s) => arch(s) * envelope(u);
  const at = (u, s) => ({
    u,
    s,
    x: centreX + u * halfX,
    z: zNear + (zFar - zNear) * s,
    y: eave + tiltS * s + tiltU * u + rise * lift(u, s),
    lift: lift(u, s),
  });
  return { at, point: (u, s) => { const p = at(u, s); return new THREE.Vector3(p.x, p.y, p.z); } };
}

/**
 * Build the lot into `pa` (a TatsumiPaSystem). `lot` is its footprint, so the
 * layout follows whatever PA_LOT says instead of hard-coding the walls.
 */
export function buildTatsumiPaStructure(pa, lot) {
  const HALF_X = lot.width * 0.5;
  const HALF_Z = lot.depth * 0.5;

  const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
  const glassMap = glassBlockTexture();
  const M = {
    paint: lambert(0xcfcdb8),
    concrete: lambert(0x8a9099, { emissive: 0x1a1d22 }),
    dark: lambert(0x272a31),
    wall: lambert(0x2a3039),
    tile: lambert(0x1e2a2a),
    // The shell's structure is WHITE and lit: in every reference frame the
    // diagrid and the rim tube are the brightest thing in the lot.
    steel: basic(0xdfe6ea),
    steelDim: lambert(0x9aa3ad, { emissive: 0x2a3038 }),
    glassBlock: glassMap ? basic(0xffffff, { map: glassMap }) : basic(0x4dbb87),
    // Glazing: green, seen from both sides, and translucent enough that the
    // diagrid under it shows through from outside.
    glaze: basic(0xffffff, { side: THREE.DoubleSide, vertexColors: true }),
    canopyUnder: basic(0xd7dbd6),
    canopyTop: lambert(0x3a4048),
    fascia: basic(0xe8ece8),
    truck: lambert(0xe8eef4),
    tyre: lambert(0x141619),
    glass: lambert(0x0e1620),
    lampHead: basic(0xeafff4),
    blue: basic(0x1d47a0),
    exitGreen: basic(0x2fae6a),
    pylon: basic(0xf4f8f4),
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
  unitPlane.rotateX(-Math.PI * 0.5);

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
  /** A member running between two 3-D points: the diagrid, the rim, the struts. */
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
  // ------------------------------------------------------------------
  const BUILDING_Z = -HALF_Z + 5;
  const BUILDING_FRONT = BUILDING_Z + 3;
  const BUILDING_W = Math.min(32, lot.width - 20);
  boxPiece('PA building', M.wall, 0, 1.7, BUILDING_Z, BUILDING_W, 3.4, 6, { solid: true, name: 'PA building block' });
  boxPiece('PA building', M.dark, 0, 3.55, BUILDING_Z, BUILDING_W + 1, 0.3, 6.6);
  // Dark tiled dado under the glazing, the way the real frontage is banded.
  boxPiece('PA building', M.tile, 0, 0.32, BUILDING_FRONT + 0.06, BUILDING_W, 0.64, 0.14);

  const glassFrom = -BUILDING_W * 0.5 + 1.6;
  const glassTo = glassFrom + 11;
  const glassPanel = boxPiece('PA building', M.glassBlock,
    (glassFrom + glassTo) * 0.5, 1.72, BUILDING_FRONT + 0.1, 11, 2.1, 0.2);
  glassPanel.name = 'PA glass block wall';
  // Frame: the blocks sit in a recessed steel surround, not flush on the wall.
  for (const [dy, sy, sz] of [[2.86, 0.12, 0.26], [0.62, 0.12, 0.26]]) {
    batch('trim', unitBox, M.steelDim, V((glassFrom + glassTo) * 0.5, dy, BUILDING_FRONT + 0.12), V(11.2, sy, sz));
  }
  for (const x of [glassFrom - 0.1, glassTo + 0.1]) {
    batch('trim', unitBox, M.steelDim, V(x, 1.72, BUILDING_FRONT + 0.12), V(0.14, 2.36, 0.26));
  }

  // Toilets: dark recess, lit header, step.
  boxPiece('PA building', M.glass, 0.5, 1.2, BUILDING_FRONT + 0.05, 3.4, 2.4, 0.14);
  boxPiece('PA building', M.canopyUnder, 0.5, 2.62, BUILDING_FRONT + 0.12, 3.6, 0.32, 0.12);
  boxPiece('PA building', M.concrete, 0.5, 0.09, BUILDING_FRONT + 0.9, 3.6, 0.18, 1.6);

  // ------------------------------------------------------------------
  // 2. Vending row under its flat canopy
  //
  // The canopy is a WHITE-soffited slab with a lit fascia — from the forecourt
  // it is a bright band over the machines, not a dark shelf.
  // ------------------------------------------------------------------
  const vendingAccents = ['#e8253c', '#1f7fd0', '#f4f2e8', '#e8253c', '#1f7fd0', '#d9377f'];
  const VEND_FROM = 4.2;
  const VEND_PITCH = 1.32;
  for (let i = 0; i < 7; i += 1) {
    const x = VEND_FROM + i * VEND_PITCH;
    boxPiece('PA vending', M.dark, x, 0.95, BUILDING_FRONT + 0.6, VEND_PITCH - 0.06, 1.9, 0.85, { solid: true });
    const map = vendingTexture(vendingAccents[i % vendingAccents.length]);
    const front = new THREE.Mesh(
      new THREE.PlaneGeometry(VEND_PITCH - 0.14, 1.78),
      map ? new THREE.MeshBasicMaterial({ map }) : basic(0xf2f4f8),
    );
    front.position.set(x, 0.99, BUILDING_FRONT + 1.03);
    group('PA vending').add(front);
  }
  const flatCanopyX = VEND_FROM + 3 * VEND_PITCH;
  const flatCanopyW = 7 * VEND_PITCH + 2.6;
  boxPiece('PA vending', M.canopyTop, flatCanopyX, 3.62, BUILDING_FRONT + 1.5, flatCanopyW, 0.26, 3.6);
  boxPiece('PA vending', M.canopyUnder, flatCanopyX, 3.47, BUILDING_FRONT + 1.5, flatCanopyW - 0.3, 0.06, 3.3);
  boxPiece('PA vending', M.fascia, flatCanopyX, 3.5, BUILDING_FRONT + 3.32, flatCanopyW, 0.34, 0.1);
  for (const x of [flatCanopyX - flatCanopyW * 0.42, flatCanopyX + flatCanopyW * 0.42]) {
    boxPiece('PA vending', M.steelDim, x, 1.74, BUILDING_FRONT + 3.1, 0.2, 3.48, 0.2, { solid: true });
  }
  // The tall lit pylon at the corner of the frontage.
  boxPiece('PA vending', M.steelDim, VEND_FROM - 2.1, 1.5, BUILDING_FRONT + 1.1, 0.18, 3.0, 0.18);
  boxPiece('PA vending', M.pylon, VEND_FROM - 2.1, 2.5, BUILDING_FRONT + 1.1, 0.7, 2.0, 0.24);

  // ------------------------------------------------------------------
  // 3. The canopy
  //
  // Real proportions: 26 m along the frontage, 16 m of forecourt covered,
  // crown ~10.5 m over a 5 m eave. That depth is the whole reason PA_LOT had
  // to grow — squeezed into a 9 m forecourt this arch reads as a lid.
  // ------------------------------------------------------------------
  const KERB_Z = -1.0;
  const CANOPY = {
    centreX: -2,
    halfX: 13,
    zNear: -3.5,
    zFar: BUILDING_FRONT + 0.5,
    eave: 5.0,
    rise: 5.4,
    tiltS: 1.6,               // rakes up towards the building
    tiltU: 0.6,               // and sweeps along the frontage
  };
  const canopy = canopySurface(CANOPY);
  const RIBS = 9;
  const PURLINS = 5;
  const ARCH_STEPS = 14;

  // 3a. Glazing: one surface over the (u, s) grid, shaded by how high the arch
  //     stands — bright across the crown, deep green down at the eaves.
  {
    const positions = [];
    const colors = [];
    const indices = [];
    const crown = new THREE.Color(0x2fa76a);
    const foot = new THREE.Color(0x0e4c33);
    const colour = new THREE.Color();
    const columns = 48;
    const rows = 20;
    for (let i = 0; i <= columns; i += 1) {
      const u = -1 + (2 * i) / columns;
      for (let j = 0; j <= rows; j += 1) {
        const point = canopy.at(u, j / rows);
        positions.push(point.x, point.y, point.z);
        colour.copy(foot).lerp(crown, Math.min(1, point.lift * 1.15));
        colors.push(colour.r, colour.g, colour.b);
      }
    }
    const stride = rows + 1;
    for (let i = 0; i < columns; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        const a = i * stride + j;
        indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const glazing = new THREE.Mesh(geometry, M.glaze);
    glazing.name = 'PA canopy glazing';
    group('PA canopy').add(glazing);
  }

  // 3b. Ribs across the arch — the members you actually read the shape by —
  //     purlins along it, and one brace per bay, which is what turns the grid
  //     into the reference's lozenges without a scribble of full diagonals.
  const structural = (u, s, drop = 0.16) => {
    const point = canopy.point(u, s);
    point.y -= drop;
    return point;
  };
  for (let rib = 0; rib < RIBS; rib += 1) {
    const u = -1 + (2 * rib) / (RIBS - 1);
    let previous = null;
    for (let step = 0; step <= ARCH_STEPS; step += 1) {
      const point = structural(u, step / ARCH_STEPS);
      if (previous) member('rib', M.steel, previous, point, 0.28, 0.04);
      previous = point;
    }
  }
  for (let purlin = 0; purlin <= PURLINS; purlin += 1) {
    const s = purlin / PURLINS;
    let previous = null;
    for (let step = 0; step <= 24; step += 1) {
      const point = structural(-1 + (2 * step) / 24, s, 0.3);
      if (previous) member('purlin', M.steelDim, previous, point, 0.16, 0.03);
      previous = point;
    }
  }
  for (let rib = 0; rib < RIBS - 1; rib += 1) {
    for (let purlin = 0; purlin < PURLINS; purlin += 1) {
      const u0 = -1 + (2 * rib) / (RIBS - 1);
      const u1 = -1 + (2 * (rib + 1)) / (RIBS - 1);
      const s0 = purlin / PURLINS;
      const s1 = (purlin + 1) / PURLINS;
      const flip = (rib + purlin) % 2 === 0;
      member('purlin', M.steelDim,
        structural(flip ? u0 : u1, s0, 0.3), structural(flip ? u1 : u0, s1, 0.3), 0.13, 0.03);
    }
  }

  // 3c. The rim tube: the bold white outline the whole shape reads by. It runs
  //     the two long eaves and closes round the swept ends.
  {
    let previousNear = null;
    let previousFar = null;
    for (let step = 0; step <= 48; step += 1) {
      const u = -1 + (2 * step) / 48;
      const near = structural(u, 0, 0.06);
      const far = structural(u, 1, 0.06);
      if (previousNear) {
        member('rim', M.steel, previousNear, near, 0.4, 0.05);
        member('rim', M.steel, previousFar, far, 0.32, 0.05);
      }
      previousNear = near;
      previousFar = far;
    }
    for (const u of [-1, 1]) {
      let previous = null;
      for (let step = 0; step <= ARCH_STEPS; step += 1) {
        const point = structural(u, step / ARCH_STEPS, 0.06);
        if (previous) member('rim', M.steel, previous, point, 0.4, 0.05);
        previous = point;
      }
    }
  }

  // 3d. Props: two stayed columns in front of the building, and the flying
  //     strut with its knuckle off the cantilevered end.
  for (const u of [-0.5, 0.5]) {
    const head = structural(u, 0.86, 0.3);
    boxPiece('PA canopy', M.steelDim, head.x, (head.y - 0.35) * 0.5, head.z, 0.36, head.y - 0.35, 0.36, { solid: true });
    for (const spread of [-0.14, 0.14]) {
      member('purlin', M.steelDim, V(head.x, head.y - 2.2, head.z), structural(u + spread, 0.6, 0.3), 0.15);
    }
  }
  {
    const tip = structural(-1, 0.42, 0.06);
    const boom = V(tip.x - 2.8, tip.y - 0.7, tip.z);
    member('rim', M.steel, tip, boom, 0.22);
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 8), M.steel);
    knuckle.position.copy(boom);
    group('PA canopy').add(knuckle);
    member('purlin', M.steelDim, boom, structural(-0.78, 0.14, 0.3), 0.13);
    member('purlin', M.steelDim, boom, structural(-0.78, 0.72, 0.3), 0.13);
  }

  // ------------------------------------------------------------------
  // 4. Forecourt: the curved kerb, railing and the walkway
  //
  // The reference kerb is not a straight line — it bows out into the parking
  // and turns back to the building at both ends, which is the shape the whole
  // lot is laid out around.
  // ------------------------------------------------------------------
  const KERB_HALF = BUILDING_W * 0.5 + 1.5;
  const KERB_BOW = 1.9;
  const kerbAt = (t) => {              // t in -1..1 across the frontage
    const x = t * KERB_HALF;
    const bow = Math.cos(t * Math.PI * 0.5) ** 1.4;
    return V(x, 0, KERB_Z - KERB_BOW * bow + KERB_BOW);
  };
  const GAP = 0.09;                    // the walkway break, in t
  const gapCentre = 0.5 / KERB_HALF;
  {
    const steps = 40;
    let previous = null;
    for (let i = 0; i <= steps; i += 1) {
      const t = -1 + (2 * i) / steps;
      const point = kerbAt(t);
      const inGap = Math.abs(t - gapCentre) < GAP;
      if (previous && !inGap && Math.abs(t - 2 / steps - gapCentre) >= GAP) {
        member('kerb', M.concrete, V(previous.x, 0.11, previous.z), V(point.x, 0.11, point.z), 0.32, 0.1);
        for (const y of [0.55, 0.98]) {
          member('rail', M.steelDim,
            V(previous.x, y, previous.z - 0.5), V(point.x, y, point.z - 0.5), 0.07, 0.04);
        }
        if (i % 3 === 0) {
          batch('railpost', unitBox, M.steelDim, V(point.x, 0.5, point.z - 0.5), V(0.08, 1.0, 0.08));
        }
      }
      previous = point;
    }
  }
  const walkwayZ = kerbAt(gapCentre).z;
  for (let i = 0; i < 5; i += 1) {
    paint(0.5 - 1.9 + i * 0.95, walkwayZ - 1.9, 0.55, 3.6);
  }

  // ------------------------------------------------------------------
  // 5. Parking
  // ------------------------------------------------------------------
  // Kerbside bays; the middle one is where TatsumiPaSystem parks YOU.
  const BAY_Z = 2;
  for (let i = -3; i <= 4; i += 1) paint(i * 5.6 - 2.8, BAY_Z, 0.12, 2.8);
  paint(0, BAY_Z - 1.4, 39.2, 0.12);
  const parkCar = (x, z, rotationY, index) => {
    boxPiece('PA parking', carMaterials[index % carMaterials.length], x, 0.66, z, 4.3, 0.6, 1.78, { rotationY, solid: true });
    boxPiece('PA parking', M.glass, x - Math.cos(rotationY) * 0.35, 1.14, z + Math.sin(rotationY) * 0.35, 2.15, 0.48, 1.62, { rotationY });
    for (const [dx, dz] of [[-1.42, -0.86], [-1.42, 0.86], [1.42, -0.86], [1.42, 0.86]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 10), M.tyre);
      wheel.rotation.set(Math.PI * 0.5, 0, rotationY);
      wheel.position.set(
        x + Math.cos(rotationY) * dx - Math.sin(rotationY) * dz, 0.33,
        z + Math.sin(rotationY) * dx + Math.cos(rotationY) * dz,
      );
      group('PA parking').add(wheel);
    }
  };
  parkCar(-11.2, BAY_Z, 0, 1);
  parkCar(11.2, BAY_Z, 0, 4);

  const COMB_X = -HALF_X + 1.5;
  const combAxis = V(-Math.SQRT1_2, 0, -Math.SQRT1_2);
  const combLength = 15;
  const combAngle = Math.atan2(combAxis.x, combAxis.z);
  const parkTruck = (x, z, angle) => {
    const nose = V(Math.sin(angle), 0, Math.cos(angle));
    const at = (distance) => V(x + nose.x * distance, 0, z + nose.z * distance);
    const chassis = at(0); boxPiece('PA parking', M.dark, chassis.x, 0.62, chassis.z, 2.2, 0.6, 8.2, { rotationY: angle, solid: true });
    const body = at(-2.0); boxPiece('PA parking', M.truck, body.x, 2.15, body.z, 2.5, 2.8, 6.0, { rotationY: angle, solid: true });
    const skirt = at(-2.0); boxPiece('PA parking', M.dark, skirt.x, 0.74, skirt.z, 2.42, 0.18, 6.0, { rotationY: angle });
    const cab = at(3.2); boxPiece('PA parking', M.truck, cab.x, 1.6, cab.z, 2.35, 2.1, 2.3, { rotationY: angle, solid: true });
    const screen = at(4.32); boxPiece('PA parking', M.glass, screen.x, 2.15, screen.z, 2.1, 1.0, 0.16, { rotationY: angle });
    const grille = at(4.32); boxPiece('PA parking', M.dark, grille.x, 0.9, grille.z, 2.2, 1.1, 0.14, { rotationY: angle });
    for (const [dx, dd] of [[-1.12, 3.0], [1.12, 3.0], [-1.12, -2.6], [1.12, -2.6], [-1.12, -4.0], [1.12, -4.0]]) {
      const centre = at(dd);
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.3, 10), M.tyre);
      wheel.rotation.set(Math.PI * 0.5, 0, angle);
      wheel.position.set(centre.x + Math.cos(angle) * dx, 0.52, centre.z - Math.sin(angle) * dx);
      group('PA parking').add(wheel);
    }
  };
  const combStations = [-16, -11, -6, -1, 4, 9];
  for (const z of combStations) {
    paint(COMB_X - combAxis.x * combLength * 0.5, z - combAxis.z * combLength * 0.5, 0.14, combLength, combAngle);
    text('大型', COMB_X - combAxis.x * 4.6, z - combAxis.z * 4.6 + 2.55, 2.1, 4.6, combAngle + Math.PI);
  }
  paint(COMB_X - combAxis.x * combLength * 0.5, combStations[combStations.length - 1] + 5 - combAxis.z * combLength * 0.5,
    0.14, combLength, combAngle);
  parkTruck(COMB_X - combAxis.x * 4.9, combStations[1] + 2.55 - combAxis.z * 4.9, combAngle);
  parkTruck(COMB_X - combAxis.x * 4.9, combStations[3] + 2.55 - combAxis.z * 4.9, combAngle);

  const SMALL_X = HALF_X - 1.5;
  const SMALL_DEPTH = 5;
  const SMALL_PITCH = 2.6;
  const smallFrom = -16;
  const smallCount = 14;
  for (let i = 0; i <= smallCount; i += 1) {
    paint(SMALL_X - SMALL_DEPTH * 0.5, smallFrom + i * SMALL_PITCH, SMALL_DEPTH, 0.12);
    if (i === smallCount) break;
    const z = smallFrom + (i + 0.5) * SMALL_PITCH;
    text('小型', SMALL_X - 3.5, z, 2.9, 1.5, -Math.PI * 0.5);
    if (i % 3 === 1) parkCar(SMALL_X - 2.35, z, 0, i);
  }
  paint(SMALL_X - SMALL_DEPTH, smallFrom + smallCount * SMALL_PITCH * 0.5, 0.15, smallCount * SMALL_PITCH);
  const accessibleZ = smallFrom + smallCount * SMALL_PITCH + 1.9;
  paint(SMALL_X - SMALL_DEPTH * 0.5, accessibleZ + 1.9, SMALL_DEPTH, 0.12);
  batch('pad', unitPlane, M.blue, V(SMALL_X - 2.6, 0.03, accessibleZ), V(4.4, 1, 3.2));

  // ------------------------------------------------------------------
  // 6. Gate back to the expressway
  // ------------------------------------------------------------------
  for (const x of [-3.4, 3.4]) {
    boxPiece('PA gate', M.concrete, x, 1.7, 0, 0.8, 3.4, 0.8, { solid: true });
  }
  boxPiece('PA gate', M.concrete, 0, 3.6, 0, 8, 0.5, 0.8);
  boxPiece('PA gate', M.exitGreen, 0, 3.05, -0.45, 5.4, 0.5, 0.1);
  group('PA gate').position.set(0, 0, pa.exitPortal?.position.z ?? (HALF_Z - 0.5));

  // ------------------------------------------------------------------
  // 7. Lighting — the saved build hides all four original sodium masts, so
  //    the lot brings its own. Twin-headed, like the masts in the reference.
  // ------------------------------------------------------------------
  const lights = [];
  const addLight = (light, x, y, z) => {
    light.position.set(x, y, z);
    light.userData.gameSceneLight = true;
    group('PA lighting').add(light);
    lights.push(light);
    return light;
  };
  for (const [x, z, facing] of [
    [-HALF_X + 8, -8, 1], [HALF_X - 8, -8, -1],
    [-HALF_X + 8, HALF_Z - 8, 1], [HALF_X - 8, HALF_Z - 8, -1],
  ]) {
    boxPiece('PA lighting', M.dark, x, 4.3, z, 0.26, 8.6, 0.26, { solid: true });
    boxPiece('PA lighting', M.dark, x + facing * 0.9, 8.6, z, 1.8, 0.16, 0.16);
    for (const arm of [-1, 1]) {
      boxPiece('PA lighting', M.lampHead, x + facing * (0.9 + arm * 0.62), 8.5, z, 0.86, 0.2, 0.5);
    }
    addLight(new THREE.PointLight(0xd8f0e8, 11, 40, 1.6), x + facing * 0.9, 8.2, z);
  }
  addLight(new THREE.PointLight(0x8fe8bd, 12, 38, 1.7),
    CANOPY.centreX, 6.2, (CANOPY.zNear + CANOPY.zFar) * 0.5);
  addLight(new THREE.PointLight(0xffe9c4, 5, 18, 2), flatCanopyX, 3.2, BUILDING_FRONT + 1.6);

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
  board('PA building', 'トイレ|TOILET', 3.2, 1.35, 0.5, 2.95, BUILDING_FRONT + 0.2, 0);
  board('PA building', '辰巳第一PA|TATSUMI No.1 PA', 6.4, 2.2, -BUILDING_W * 0.5 + 5, 4.9, BUILDING_Z - 3.1, Math.PI);
  {
    const map = motorcycleSignTexture();
    const x = glassFrom + 1.2;
    const z = BUILDING_FRONT + 1.5;
    if (map) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map }));
      mesh.position.set(x, 2.25, z);
      mesh.name = 'PA sign motorcycle';
      group('PA forecourt').add(mesh);
    }
    batch('trim', unitBox, M.steelDim, V(x, 0.85, z), V(0.1, 1.7, 0.1));
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
    group('PA paint').add(mesh);
  }
  const order = ['PA paint', 'PA parking', 'PA building', 'PA vending', 'PA canopy', 'PA forecourt', 'PA gate', 'PA lighting'];
  for (const name of order) if (groups[name]) pa.root.add(groups[name]);
  for (const mesh of solids) pa.staticColliders.push(mesh);

  return { groups, lights, solids: solids.length };
}

export default buildTatsumiPaStructure;
