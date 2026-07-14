import * as THREE from 'three';
import ROUTE_DATA from '../data/routes.js';

/**
 * Shutoko Nights world module — the real Shuto Expressway, rebuilt from
 * OpenStreetMap ground truth (data/routes.js, generated offline by
 * tools/extract-osm.js — the game never calls any API at runtime).
 *
 * Coordinates: metres. +X east, +Z north, +Y up, true 1:1 scale projected
 * around 35.68 N 139.77 E. Every route is a ONE-WAY carriageway travelled
 * from distance 0 to route.length (direction +1); opposing carriageways are
 * independent corridors, exactly as OSM maps them.
 *
 * Network: C1 loops, Route 11 Daiba + Rainbow Bridge, Bayshore B between
 * Tatsumi and Daikoku (Tokyo Port Tunnel), Route 9 Fukagawa, Route 1 Haneda
 * (Hamazakibashi-Haneda, Heiwajima PA), the Route 6 Mukojima stitch, K1
 * Yokohane and the K5 Daikoku line into the Daikoku JCT stack — plus every
 * interconnecting motorway_link ramp OSM has, and the four PAs (Shibaura +
 * garage, Tatsumi, Heiwajima, Daikoku) at their real locations.
 *
 * Construction rules the generator enforces STRUCTURALLY:
 *  - Connections exist only where the OSM topology graph has them.
 *  - Diverges/merges are re-anchored to the OUTER side of the carriageway
 *    they leave/join: a parallel taper runs alongside the mainline (deck
 *    heights glued), then peels away — a ramp can never split a carriageway
 *    down the middle, and staying in lane never captures you onto a ramp.
 *  - Collision is the union of route corridors: a point is drivable iff it
 *    is inside at least one corridor (or a PA lot) at a matching elevation,
 *    so barriers are continuous, gores seal themselves, and walls can never
 *    be disabled.
 */

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();
const TMP_MAT = new THREE.Matrix4();
const EPSILON = 1e-5;

const LANE_W = 3.55;
const MEDIAN_W = 3.0;
const SHOULDER_W = 1.3;
const CHUNK = 600;
const CHUNK_VISIBLE = 1500;
const LEVEL = { T: -15, G: 0, E: 12, H: 24, S: 36 };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrap(value, length) {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

function vec(x, y, z) {
  return new THREE.Vector3(x, y, z);
}

/** Directed curve normal — the driver's RIGHT when travelling along tangent. */
function horizontalNormal(tangent, target = new THREE.Vector3()) {
  target.set(-tangent.z, 0, tangent.x);
  if (target.lengthSq() < EPSILON) target.set(1, 0, 0);
  return target.normalize();
}

function yawQuaternion(tangent, target = new THREE.Quaternion()) {
  const flat = TMP_C.set(tangent.x, 0, tangent.z);
  if (flat.lengthSq() < EPSILON) return target.identity();
  flat.normalize();
  return target.setFromUnitVectors(FORWARD, flat);
}

function xzDistanceSq(a, b) {
  const x = a.x - b.x;
  const z = a.z - b.z;
  return x * x + z * z;
}

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

export class HighwayMap {
  constructor(sceneOrOptions = null, maybeOptions = {}) {
    const isScene = sceneOrOptions && sceneOrOptions.isScene;
    this.scene = isScene ? sceneOrOptions : (sceneOrOptions?.scene || null);
    this.options = isScene ? maybeOptions : (sceneOrOptions || {});
    this.seed = Number.isFinite(this.options.seed) ? this.options.seed : 0x51a7c1;
    this.random = mulberry32(this.seed);

    this.group = new THREE.Group();
    this.group.name = 'Shutoko world';
    this.routes = new Map();
    this.routeOrder = [];
    this.routeAliases = new Map();
    this.edges = [];              // directed junction edges
    this.connections = new Map(); // legacy per-route view of edges
    this.junctions = [];
    this.serviceAreas = [];
    this.wallSegments = [];
    this.routeSamples = Object.create(null);
    this.animatedMarkers = [];
    this.blinkers = [];
    // Quality-scalable effect layers (light pools / wet-asphalt streaks):
    // instanced meshes whose geometry name is in _effectTypes get collected so
    // setQuality can hide them on Low.
    this._effectTypes = new Set(['lightStreak']);
    this._effectMeshes = [];
    this._quality = this.options.quality === 'low' ? 'low' : 'high';
    this._signMaterials = new Map();
    this._ownedTextures = new Set();
    this._disposed = false;

    // Spatial index: cell key -> [{route, sampleIndex}]
    this._grid = new Map();
    this._gridCell = 260;

    // Chunked world: key -> { group, center, alwaysVisible }
    this._chunks = new Map();
    this._chunkBuckets = new Map();   // key -> matName -> {positions, indices, colors|null}
    this._chunkInstances = new Map(); // key -> typeName -> records[]
    this._visibleKey = null;
    this._lastVisibleUpdate = -Infinity;

    this.materials = this._createMaterials();
    this._defineNetwork();
    this._defineServiceAreas();
    this._finalizeNetwork();
    this._buildWorld();
    this._buildMinimapData();

    // Group aliases resolve to that group's longest carriageway.
    for (const groupId of this.groups.keys()) {
      const chains = this._groupChains(groupId);
      if (chains.length) this.routeAliases.set(groupId, { id: chains[0].id, direction: 1 });
    }
    const aliasTo = (name, groupId) => {
      const chains = this._groupChains(groupId);
      if (chains.length) this.routeAliases.set(name, { id: chains[0].id, direction: 1 });
    };
    aliasTo('c1_outer', 'c1');
    aliasTo('c1_inner', 'c1');
    aliasTo('yokohane', 'k1');
    aliasTo('bayshore', 'wangan');
    aliasTo('b', 'wangan');
    aliasTo('rainbow', 'r11');
    aliasTo('11', 'r11');
    this.trafficLanes = this.getTrafficLanes();

    const garageArea = this.serviceAreas.find((area) => area.hasGarage);
    const mainRoute = this.routes.get(garageArea.routeId);
    const spawnDistance = mainRoute.closed
      ? wrap(garageArea.mainDistance + garageArea.direction * 620, mainRoute.length)
      : clamp(garageArea.mainDistance + garageArea.direction * 620, 60, mainRoute.length - 140);
    this.initialSpawn = this.sampleLane(garageArea.routeId, spawnDistance, 0, garageArea.direction);
    this.initialSpawn.position.y += 0.65;
    this.initialSpawn.serviceAreaId = garageArea.id;
    this.initialSpawn.label = 'Shibaura PA outbound merge';
    this.garagePosition = garageArea.garageEntrance.clone();

    if (this.scene) {
      this.scene.add(this.group);
      if (this.options.applyFog !== false) {
        this.scene.background = new THREE.Color(0x03050e);
        this.scene.fog = new THREE.FogExp2(0x050713, this.options.fogDensity || 0.00125);
      }
    }
    this.update(this.initialSpawn.position, 0);
  }

  _createMaterials() {
    // PS2 target: smooth shading, clean emissive surfaces. Merged quads keep
    // flat face normals from computeVertexNormals, curved shapes shade smooth.
    const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({
      color, fog: true, ...extra,
    });
    const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({
      color, fog: true, toneMapped: false, ...extra,
    });
    this._facadeSpecs = {};
    const facade = (name, spec) => {
      const texture = this._facadeTexture(spec);
      this._facadeSpecs[name] = spec;
      return texture
        ? new THREE.MeshBasicMaterial({ map: texture, fog: true, toneMapped: false })
        : lambert(0x151a24);
    };
    return {
      facadeOffice: facade('facadeOffice', { cols: 10, rows: 13, lit: 0.44, warm: 0.45, base: '#141823', cellW: 3.4, cellH: 3.3, seed: 0x1a2b3c }),
      facadeDark: facade('facadeDark', { cols: 10, rows: 13, lit: 0.13, warm: 0.55, base: '#0f1219', cellW: 3.4, cellH: 3.3, seed: 0x2b3c4d }),
      facadeHotel: facade('facadeHotel', { cols: 12, rows: 14, lit: 0.32, warm: 0.85, base: '#171a21', cellW: 2.8, cellH: 3.0, seed: 0x3c4d5e }),
      facadeIndustrial: facade('facadeIndustrial', { cols: 7, rows: 5, lit: 0.2, warm: 0.35, base: '#171a1e', cellW: 5.5, cellH: 4.2, seed: 0x4d5e6f }),
      road: lambert(0x14171f),
      roadAlt: lambert(0x171a23),
      roadService: lambert(0x1d2029),
      // Concrete/steel carry a small emissive floor so barriers stay readable
      // under the dark PS2 night lighting (they define the road edge at speed).
      concrete: lambert(0x848a94, { side: THREE.DoubleSide, emissive: 0x1e2126 }),
      concreteDark: lambert(0x272a31),
      barrier: lambert(0x9096a0, { side: THREE.DoubleSide, emissive: 0x2e3138 }),
      railMetal: lambert(0xaab2bc, { side: THREE.DoubleSide, emissive: 0x23262c }),
      tunnelWall: lambert(0x2c2f36, { side: THREE.DoubleSide }),
      tunnelDark: lambert(0x191c22, { side: THREE.DoubleSide }),
      portal: lambert(0x3a3d44),
      marking: basic(0xd8d6bf),
      amber: basic(0xe8a844),
      reflector: basic(0xffc36a),
      lampSodium: basic(0xff9b42),
      lampWhite: basic(0xffe9c4),
      tunnelLampOrange: basic(0xffb15e),
      tunnelLampWhite: basic(0xf3f7e8),
      exitGreen: basic(0x37e57f),
      matrix: basic(0xff8b1f),
      redBlink: basic(0xff3040),
      building: lambert(0x11141e),
      neon: basic(0xffffff),
      shed: lambert(0x1a1d24),
      crane: lambert(0x233042),
      container: lambert(0x54331f),
      water: lambert(0x061019, { transparent: true, opacity: 0.9 }),
      ground: lambert(0x080a11),
      towerWhite: lambert(0xb8bcc4),
      cable: basic(0x9aa3ad),
      cableLight: basic(0xcfe6ff),
      garage: lambert(0x222632),
      shutter: lambert(0x6e7379),
      vending: basic(0x8ad9ff),
      konbini: basic(0xd8ffe9),
      canopy: basic(0xfff2c9),
      fence: lambert(0x30343b),
      cushion: basic(0xe0b52f),
      parkedBody: lambert(0xffffff),
      parkedGlass: lambert(0x0e1620),
      marker: basic(0x57e3ff, { transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
      billboardGlow: basic(0xffffff),
      signGreen: basic(0x0c604e, { side: THREE.DoubleSide }),
      signBack: basic(0x23262c),
      chevron: this._chevronTexture()
        ? new THREE.MeshBasicMaterial({ map: this._chevronTexture(), fog: true, toneMapped: false })
        : basic(0xffc21f),
      // Additive decals: sodium pools under lamps + stretched wet-asphalt
      // streaks — the cheap PS2 stand-in for real reflections.
      lightPool: new THREE.MeshBasicMaterial({
        map: this._glowTexture(), color: 0xff9b42, transparent: true, opacity: 0.34,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: true, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
      lightStreak: new THREE.MeshBasicMaterial({
        map: this._glowTexture(), color: 0xffb066, transparent: true, opacity: 0.26,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: true, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      }),
    };
  }

  /** Yellow curve-warning chevron board texture (3 arrows pointing right). */
  _chevronTexture() {
    if (typeof document === 'undefined') return null;
    if (this._chevTex) return this._chevTex;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 88;
    const context = canvas.getContext('2d');
    context.fillStyle = '#101114';
    context.fillRect(0, 0, 128, 88);
    this._roundRectPath(context, 3, 3, 122, 82, 8);
    context.fillStyle = '#17181c';
    context.fill();
    context.strokeStyle = '#3a3d44';
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = '#ffce24';
    for (let i = 0; i < 3; i += 1) {
      const x = 16 + i * 36;
      context.beginPath();
      context.moveTo(x, 16);
      context.lineTo(x + 22, 44);
      context.lineTo(x, 72);
      context.lineTo(x + 12, 72);
      context.lineTo(x + 34, 44);
      context.lineTo(x + 12, 16);
      context.closePath();
      context.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    this._ownedTextures.add(texture);
    this._chevTex = texture;
    return texture;
  }

  /** Paired tunnel jet fans: two ducts + ceiling mount, one instanced geometry. */
  _jetFanGeometry() {
    const parts = [];
    for (const x of [-0.62, 0.62]) {
      const duct = new THREE.CylinderGeometry(0.5, 0.5, 2.9, 8);
      duct.rotateX(Math.PI * 0.5);
      duct.translate(x, 0, 0);
      parts.push(duct);
    }
    const mount = new THREE.BoxGeometry(1.9, 0.2, 0.6);
    mount.translate(0, 0.68, 0);
    parts.push(mount);
    return this._mergeGeometries(parts);
  }

  /** Soft radial glow sprite texture (white core, transparent edge). */
  _glowTexture() {
    if (typeof document === 'undefined') return null;
    if (this._glowTex) return this._glowTex;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    this._ownedTextures.add(texture);
    this._glowTex = texture;
    return texture;
  }

  /** Concatenate simple geometries (position+normal) into one non-indexed buffer. */
  _mergeGeometries(geometries) {
    const positions = [];
    const normals = [];
    for (const geometry of geometries) {
      const flat = geometry.index ? geometry.toNonIndexed() : geometry;
      positions.push(...flat.getAttribute('position').array);
      normals.push(...flat.getAttribute('normal').array);
      if (flat !== geometry) flat.dispose();
      geometry.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    merged.computeBoundingSphere();
    return merged;
  }

  /**
   * Proper highway lamppost: base flange, tapered pole, curved arm sweeping
   * up-and-over, luminaire housing. Local +X is the road side; the emissive
   * lens is instanced separately so it stays full-bright.
   */
  _lampGeometry() {
    const parts = [];
    const flange = new THREE.CylinderGeometry(0.24, 0.3, 0.24, 7);
    flange.translate(0, 0.12, 0);
    parts.push(flange);
    const pole = new THREE.CylinderGeometry(0.09, 0.17, 7.6, 7);
    pole.translate(0, 3.8, 0);
    parts.push(pole);
    const arm = new THREE.TorusGeometry(1.75, 0.075, 5, 8, Math.PI * 0.5);
    arm.rotateZ(Math.PI * 0.5);
    arm.translate(1.75, 7.6, 0);
    parts.push(arm);
    const housing = new THREE.BoxGeometry(1.3, 0.17, 0.4);
    housing.translate(2.28, 9.36, 0);
    parts.push(housing);
    return this._mergeGeometries(parts);
  }

  /**
   * Night facade texture: a grid of small emissive windows with a believable
   * random lit pattern (warm/cool whites, dim TVs, dark floors) on a dark
   * wall. Tiled per building with whole-window UV repeats so grids stay
   * aligned to the silhouette — the classic PS2 Tokyo-at-night look.
   */
  _facadeTexture(spec) {
    if (typeof document === 'undefined') return null;
    const random = mulberry32(this.seed ^ spec.seed);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    context.fillStyle = spec.base;
    context.fillRect(0, 0, 256, 256);
    const cellW = 256 / spec.cols;
    const cellH = 256 / spec.rows;
    // faint floor slabs + mullions so unlit walls still read as structure
    context.fillStyle = 'rgba(255,255,255,0.05)';
    for (let row = 0; row <= spec.rows; row += 1) context.fillRect(0, Math.round(row * cellH), 256, 1);
    context.fillStyle = 'rgba(0,0,0,0.35)';
    for (let col = 0; col <= spec.cols; col += 1) context.fillRect(Math.round(col * cellW), 0, 1, 256);
    // some floors go fully dark / fully lit so towers band like real offices
    const floorBias = [];
    for (let row = 0; row < spec.rows; row += 1) {
      const roll = random();
      floorBias.push(roll < 0.14 ? 0 : roll > 0.86 ? 2.4 : 1);
    }
    for (let row = 0; row < spec.rows; row += 1) {
      for (let col = 0; col < spec.cols; col += 1) {
        const x = Math.round(col * cellW + cellW * 0.2);
        const y = Math.round(row * cellH + cellH * 0.26);
        const w = Math.max(2, Math.round(cellW * 0.6));
        const h = Math.max(2, Math.round(cellH * 0.5));
        const roll = random();
        let fill;
        if (roll < spec.lit * floorBias[row]) {
          const warm = random() < spec.warm;
          const dim = random() < 0.25 ? 0.55 : 1;
          fill = warm
            ? `rgba(255,${205 + Math.floor(random() * 30)},${145 + Math.floor(random() * 45)},${dim})`
            : `rgba(${185 + Math.floor(random() * 35)},${212 + Math.floor(random() * 25)},255,${dim})`;
        } else if (roll < spec.lit * floorBias[row] + 0.06) {
          fill = 'rgba(110,125,160,0.4)';
        } else {
          fill = `rgba(6,8,13,${0.8 + random() * 0.2})`;
        }
        context.fillStyle = fill;
        context.fillRect(x, y, w, h);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this._ownedTextures.add(texture);
    return texture;
  }

  // ------------------------------------------------------------------
  // Network definition
  // ------------------------------------------------------------------

  _defineNetwork() {
    const data = ROUTE_DATA;
    this.networkMeta = data.meta;
    this.groups = new Map((data.groups || []).map((group) => [group.id, group]));
    this._terrainSlabs = data.terrain || [];
    this._dataServiceAreas = data.serviceAreas || [];
    this._dataEdges = data.edges || [];

    const groupKind = (groupId) => this.groups.get(groupId)?.kind || 'arterial';
    const isEndRef = (ref, routeData, which) => (which === 'start'
      ? ref.distance < 50
      : ref.distance > routeData.length - 50);

    // Index edges per data route so anchoring can find each route's own
    // endpoint connections.
    const startEdgeOf = new Map(); // routeId -> edge arriving at its start
    const endEdgeOf = new Map();   // routeId -> edge leaving from its end
    for (const edge of this._dataEdges) {
      const toRoute = data.routes.find((entry) => entry.id === edge.to.route);
      const fromRoute = data.routes.find((entry) => entry.id === edge.from.route);
      if (toRoute && !toRoute.closed && isEndRef(edge.to, toRoute, 'start') && !startEdgeOf.has(toRoute.id)) {
        startEdgeOf.set(toRoute.id, edge);
      }
      if (fromRoute && !fromRoute.closed && isEndRef(edge.from, fromRoute, 'end') && !endEdgeOf.has(fromRoute.id)) {
        endEdgeOf.set(fromRoute.id, edge);
      }
    }

    // Register in dependency order: a route whose endpoints diverge from /
    // merge into another route needs that route's curve first so the
    // endpoint can be re-anchored onto its outer edge.
    const pending = [...data.routes];
    let guard = pending.length + 4;
    while (pending.length && guard > 0) {
      guard -= 1;
      let progressed = false;
      for (let i = 0; i < pending.length; i += 1) {
        const routeData = pending[i];
        const startEdge = startEdgeOf.get(routeData.id);
        const endEdge = endEdgeOf.get(routeData.id);
        const needs = [];
        if (startEdge && startEdge.kind === 'diverge') needs.push(startEdge.from.route);
        if (endEdge && endEdge.kind === 'merge') needs.push(endEdge.to.route);
        if (needs.some((id) => id !== routeData.id && !this.routes.has(id))) continue;
        this._registerDataRoute(routeData, groupKind(routeData.group), startEdge, endEdge);
        pending.splice(i, 1);
        i -= 1;
        progressed = true;
      }
      if (!progressed) {
        // dependency cycle (braided ramps) — register the rest un-anchored
        for (const routeData of pending) {
          console.warn('Shutoko map: registering', routeData.id, 'without endpoint anchoring (cycle)');
          this._registerDataRoute(routeData, groupKind(routeData.group), null, null);
        }
        pending.length = 0;
      }
    }

    // Connectivity edges. Endpoint diverge/merge edges were added during
    // anchoring; add everything else (continuations, mid-route merges).
    for (const edge of this._dataEdges) {
      if (edge._handled) continue;
      const from = this.routes.get(edge.from.route);
      const to = this.routes.get(edge.to.route);
      if (!from || !to) continue;
      const fromRef = edge.from.distance > (this._routeDataLength(from) - 50)
        ? { routeId: from.id, distance: 'end', direction: 1 }
        : { routeId: from.id, at: vec(edge.point[0], 0, edge.point[1]), direction: 1 };
      const toRef = edge.to.distance < 50 && !to.closed
        ? { routeId: to.id, distance: 0, direction: 1 }
        : { routeId: to.id, at: vec(edge.point[0], 0, edge.point[1]), direction: 1 };
      this._addEdge({ from: fromRef, to: toRef, kind: edge.kind, name: edge.kind, probability: edge.kind === 'diverge' ? 0.3 : 1 });
    }

    for (const junction of data.junctions || []) {
      const routes = (junction.groups || []).flatMap((groupId) => this._groupChains(groupId).map((route) => route.id));
      const point = vec(junction.x, this._groundYAt(junction.x, junction.z), junction.z);
      this._registerJunction(junction.id, junction.name || junction.nameJa || 'JCT', point, routes);
    }
  }

  /** All mainline chains of a route group, longest first. */
  _groupChains(groupId) {
    return [...this.routes.values()]
      .filter((route) => route.group === groupId && route.kind !== 'ramp' && route.kind !== 'service')
      .sort((a, b) => b.length - a.length);
  }

  _routeDataLength(route) {
    return route.dataLength ?? route.length;
  }

  /** Deck height of the nearest carriageway (junction markers etc.). */
  _groundYAt(x, z) {
    const nearest = this.getNearestRoute(vec(x, 0, z), { maxDistance: 400, includeService: false });
    return nearest ? nearest.point.y : 10;
  }

  /**
   * Register one data carriageway. Endpoints participating in a diverge or
   * merge are re-anchored onto the OUTER edge of the carriageway they
   * leave/join: a parallel taper alongside the mainline (deck heights glued)
   * before/after peeling — the structural guarantee that ramps never split a
   * carriageway down the middle.
   */
  _registerDataRoute(routeData, kind, startEdge, endEdge) {
    let points = routeData.points.map((entry) => vec(entry[0], entry[1], entry[2]));
    const routeKind = routeData.kind === 'ramp' ? 'ramp' : kind;
    let divergeInfo = null;
    let mergeInfo = null;

    if (!routeData.closed) {
      const endDrop = Math.abs(routeData.points[0][1] - routeData.points[routeData.points.length - 1][1]);
      const steep = endDrop > routeData.length * 0.05;
      const anchorSpan = steep ? 30 : Math.min(95, Math.max(30, routeData.length * 0.22));
      if (startEdge && startEdge.kind === 'diverge' && this.routes.has(startEdge.from.route)) {
        divergeInfo = this._anchorEndpoint(points, routeData, startEdge, 'start', anchorSpan);
        if (divergeInfo) points = divergeInfo.points;
      }
      if (endEdge && endEdge.kind === 'merge' && this.routes.has(endEdge.to.route)) {
        mergeInfo = this._anchorEndpoint(points, routeData, endEdge, 'end', anchorSpan);
        if (mergeInfo) points = mergeInfo.points;
      }
    }

    const route = this._registerRoute({
      id: routeData.id,
      code: routeData.code || 'R',
      name: routeData.name || routeData.id,
      kind: routeKind,
      group: routeData.group,
      synthetic: !!routeData.synthetic,
      closed: !!routeData.closed,
      oneWay: true,
      bidirectional: false,
      oneWayDirection: 1,
      lanes: routeData.lanes || (routeData.kind === 'ramp' ? 1 : 2),
      laneWidth: LANE_W,
      speedLimit: routeData.speedLimit || 60,
      points,
      destinations: routeData.destinations || [],
      tunnelRanges: routeData.tunnels || [],
      bridgeRanges: routeData.bridges || [],
      dataLength: routeData.length,
      paId: routeData.paId || null,
    });

    if (divergeInfo) {
      const edge = this._addEdge({
        from: { routeId: divergeInfo.hostId, distance: divergeInfo.hostDistance, direction: 1 },
        to: { routeId: route.id, distance: 0, direction: 1 },
        kind: 'diverge',
        name: routeData.name || route.id,
        probability: route.kind === 'ramp' ? 0.3 : 0.45,
      });
      edge.side = divergeInfo.side;
      if (startEdge) startEdge._handled = true;
    }
    if (mergeInfo) {
      const edge = this._addEdge({
        from: { routeId: route.id, distance: 'end', direction: 1 },
        to: { routeId: mergeInfo.hostId, distance: mergeInfo.hostDistance, direction: 1 },
        kind: 'merge',
        name: routeData.name || route.id,
      });
      edge.side = mergeInfo.side;
      // vehicles arriving from a side merge land in the lane on that side
      edge.mergeLane = mergeInfo.side < 0 ? null : 0;
      if (endEdge) endEdge._handled = true;
    }
    return route;
  }

  /**
   * Re-anchor one endpoint of a route onto the outer edge of its host
   * carriageway. Returns the new point list plus the host edge reference
   * (shifted 30 m along travel so transfers land where the vehicle already
   * is).
   */
  _anchorEndpoint(points, routeData, edge, which, anchorSpan) {
    const host = this.routes.get(which === 'start' ? edge.from.route : edge.to.route);
    const connection = vec(edge.point[0], 0, edge.point[1]);
    const projection = this._projectToRoute(host, connection);
    let hostDistanceAtMouth = projection.distance;
    // The taper needs real room on the host: keep the mouth stations away
    // from an open host's ends.
    if (!host.closed) {
      const low = which === 'start' ? 34 : anchorSpan + 6;
      const high = which === 'start' ? host.length - anchorSpan - 6 : host.length - 34;
      if (high <= low) return null; // host too short — keep raw geometry
      hostDistanceAtMouth = clamp(hostDistanceAtMouth, low, high);
    }

    // Which side does the branch leave/arrive on? Probe its own geometry
    // ~45 m from the shared node, measured against the host's base normal.
    const probe = this._pointAlongPolyline(points, which === 'start' ? 45 : -45);
    const probeProjection = this._projectToRoute(host, probe);
    const side = (probeProjection.signedLateral >= 0 ? 1 : -1);
    const hostHalf = this._halfWidthAt(host, hostDistanceAtMouth);
    const lateral = side * Math.max(0.6, hostHalf - 2.0);

    const edgePoint = (distance) => {
      const sample = this._sampleCenter(host, this._normalizeDistance(host, distance), 1);
      return sample.position.clone().addScaledVector(sample.normal, lateral);
    };

    // BLENDED TAPER: over the first 2*anchorSpan of the branch, each point
    // is a smoothstep mix of the host's outer edge (at the matching
    // station) and the raw geometry — a true transition curve with no
    // corner anywhere. Beyond the blend, raw geometry continues untouched.
    const blendLength = anchorSpan * 2;
    const ordered = which === 'start' ? points : [...points].reverse();
    const alongSign = which === 'start' ? 1 : -1;
    const blended = [];
    let travelled = 0;
    let restFrom = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      if (i > 0) travelled += ordered[i].distanceTo(ordered[i - 1]);
      if (travelled > blendLength) { restFrom = i; break; }
      const t = travelled / blendLength;
      const smooth = t * t * (3 - 2 * t);
      const station = hostDistanceAtMouth + alongSign * travelled;
      const hostEdge = edgePoint(station);
      const rawY = ordered[i].y;
      const mixed = hostEdge.lerp(ordered[i], smooth);
      // PLAN blend only: the extractor already holds the branch's heights
      // to the host's deck profile through the taper — data heights are
      // the validated truth.
      mixed.y = rawY;
      blended.push(mixed);
    }
    const rest = ordered.slice(restFrom);
    const lead = edgePoint(hostDistanceAtMouth - alongSign * 30);
    const merged = [lead, ...blended, ...rest];
    const result = which === 'start' ? merged : merged.reverse();

    if (which === 'start') {
      return {
        points: result,
        hostId: host.id,
        hostDistance: this._normalizeDistance(host, hostDistanceAtMouth - 30),
        side,
      };
    }
    return {
      points: result,
      hostId: host.id,
      hostDistance: this._normalizeDistance(host, hostDistanceAtMouth + 30),
      side,
    };
  }

  /** Point at arc distance along a raw point list (negative = from the end). */
  _pointAlongPolyline(points, distance) {
    const fromEnd = distance < 0;
    const target = Math.abs(distance);
    let travelled = 0;
    const ordered = fromEnd ? [...points].reverse() : points;
    for (let i = 1; i < ordered.length; i += 1) {
      const step = ordered[i].distanceTo(ordered[i - 1]);
      if (travelled + step >= target && step > 0) {
        const t = (target - travelled) / step;
        return ordered[i - 1].clone().lerp(ordered[i], t);
      }
      travelled += step;
    }
    return ordered[ordered.length - 1].clone();
  }

  /** Remove points within `span` metres of the start/end of a point list. */
  _dropPolylineNear(points, which, span) {
    const ordered = which === 'start' ? points : [...points].reverse();
    const kept = [];
    let travelled = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      if (i > 0) travelled += ordered[i].distanceTo(ordered[i - 1]);
      if (travelled >= span) kept.push(ordered[i]);
    }
    // never hollow the route out completely
    if (kept.length < 2) kept.push(...ordered.slice(-2));
    return which === 'start' ? kept : kept.reverse();
  }

  _registerRoute(config) {
    const points = config.points.map((point) => point.clone());
    // Centripetal parameterisation: interpolates every control point with
    // no overshoot/loops on uneven spacing, and — unlike the old near-zero
    // tension uniform spline — spreads curvature smoothly between points
    // instead of degenerating each span into a straight chord with a corner
    // at the control point (the faceted-centreline root cause).
    const curve = new THREE.CatmullRomCurve3(points, !!config.closed, 'centripetal');
    curve.arcLengthDivisions = Math.max(240, Math.ceil(this._polylineLength(points, !!config.closed) / 14));
    curve.updateArcLengths();
    const length = curve.getLength();
    const bidirectional = config.bidirectional !== false && !config.oneWay;
    const lanes = Math.max(1, config.lanes || 2);
    const laneWidth = config.laneWidth || LANE_W;
    const medianWidth = bidirectional ? (config.medianWidth ?? MEDIAN_W) : 0;
    const shoulder = config.shoulder ?? (config.kind === 'service' || config.kind === 'ramp' ? 0.95 : SHOULDER_W);
    const halfWidth = bidirectional
      ? medianWidth * 0.5 + lanes * laneWidth + shoulder
      : lanes * laneWidth * 0.5 + shoulder;

    const route = {
      destinations: [],
      ...config,
      points,
      curve,
      length,
      lanes,
      lanesPerDirection: lanes,
      laneWidth,
      medianWidth,
      shoulder,
      halfWidth,
      roadWidth: halfWidth * 2,
      bidirectional,
      oneWay: !bidirectional,
      oneWayDirection: config.oneWayDirection || 1,
      traffic: config.traffic !== false && config.kind !== 'service',
      tunnels: [],
      tunnelZones: config.tunnelZones || [],
      bridgeZone: config.bridgeZone || null,
      bridge: null,
      taperStart: null, // {over, to} halfWidth taper toward distance 0
      taperEnd: null,
      samples: [],
      renderFrames: [],
      surfaceFrames: [],
    };
    this.routes.set(route.id, route);
    this.routeOrder.push(route.id);
    this.connections.set(route.id, []);
    this._prepareRouteSamples(route);
    this._buildBankTable(route);
    return route;
  }

  _polylineLength(points, closed) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += points[i].distanceTo(points[i - 1]);
    if (closed && points.length > 2) total += points[points.length - 1].distanceTo(points[0]);
    return total;
  }

  _prepareRouteSamples(route) {
    const count = Math.max(10, Math.ceil(route.length / 40));
    route.samples.length = 0;
    for (let i = 0; i <= count; i += 1) {
      if (route.closed && i === count) continue;
      const u = i / count;
      const point = route.curve.getPointAt(u);
      const tangent = route.curve.getTangentAt(u).normalize();
      const normal = horizontalNormal(tangent);
      const sample = { u, distance: u * route.length, point, position: point, tangent, normal };
      route.samples.push(sample);
      const key = this._gridKey(point.x, point.z);
      if (!this._grid.has(key)) this._grid.set(key, []);
      this._grid.get(key).push({ route, index: route.samples.length - 1 });
    }
    route._spatialSamples = route.samples;
    this.routeSamples[route.id] = route.samples;
  }

  _gridKey(x, z) {
    return `${Math.floor(x / this._gridCell)},${Math.floor(z / this._gridCell)}`;
  }

  _registerJunction(id, name, point, routeIds) {
    this.junctions.push({ id, name, point: point.clone(), position: point.clone(), routes: routeIds.slice(), radius: 70 });
  }

  /**
   * Register a directed connectivity edge. `distance: 'end'` resolves to the
   * route length. Kinds: continuation (endpoint to endpoint), diverge
   * (mid-route exit, outer lane), merge (arrival into mid-route outer lane).
   */
  _addEdge({ from, to, kind, name = '', probability = 0.3 }) {
    const resolve = (ref) => {
      const route = this.routes.get(ref.routeId);
      const distance = ref.distance === 'end' ? route.length : (Number.isFinite(ref.distance) ? ref.distance : this._projectToRoute(route, ref.at).distance + (ref.offset || 0));
      return { routeId: ref.routeId, distance: clamp(distance, 0, route.length), direction: ref.direction };
    };
    const edge = { from: resolve(from), to: resolve(to), kind, name, probability };
    this.edges.push(edge);
    const point = this._sampleCenter(edge.from.routeId, edge.from.distance, 1).position.clone()
      .lerp(this._sampleCenter(edge.to.routeId, edge.to.distance, 1).position, 0.5);
    this.connections.get(edge.from.routeId).push({
      routeId: edge.to.routeId, fromDistance: edge.from.distance, toDistance: edge.to.distance,
      name: name || kind, point, direction: edge.to.direction, kind,
    });
    return edge;
  }

  // ------------------------------------------------------------------
  // Service areas (PAs)
  // ------------------------------------------------------------------

  _defineServiceAreas() {
    // PAs from OSM: real centroid, anchored to the real carriageway, on the
    // real side. The deceleration/acceleration access lane is synthesized
    // (diverge -> lot -> merge, probability 0 so AI never takes it), and lots
    // that sit far off the viaduct (Daikoku, under the JCT stack) descend to
    // ground level along the access legs.
    for (const def of this._dataServiceAreas) {
      const route = this.routes.get(def.routeId);
      if (!route) {
        console.warn('Shutoko map: PA anchor route missing:', def.routeId);
        continue;
      }
      const projection = this._projectToRoute(route, vec(def.x, 0, def.z));
      const distance = projection.distance;
      const sample = this._sampleCenter(route, distance, 1);
      // Base normal = tangent x up = the driver's LEFT: geographic 'left'
      // from the extractor is +1 along it. If the OSM-preferred side would
      // drop the lot onto another carriageway (the centroid is often a tiny
      // on-road feature), flip to the clear side.
      const offset = Math.max(route.halfWidth + def.width * 0.5 + 8, Math.abs(projection.signedLateral));
      // Sample the whole candidate lot footprint against every other
      // corridor (at lot elevation, so grade-separated decks overhead
      // do not count as conflicts).
      const clearanceOn = (sign) => {
        let nearest = Infinity;
        for (const alongFraction of [-0.42, -0.2, 0, 0.2, 0.42]) {
          for (const acrossFraction of [-0.4, 0, 0.4]) {
            const candidate = sample.position.clone()
              .addScaledVector(sample.tangent, alongFraction * def.length)
              .addScaledVector(sample.normal, sign * (offset + acrossFraction * def.width));
            for (const { route: other, index } of this._candidateRoutes(candidate).values()) {
              if (other === route) continue;
              const otherProjection = this._projectToRoute(other, candidate, index);
              if (otherProjection.endOvershoot > 4) continue;
              if (def.grounded && otherProjection.point.y > 8) continue; // deck overhead
              nearest = Math.min(nearest, Math.abs(otherProjection.signedLateral));
            }
          }
        }
        return nearest;
      };
      let sideSign = def.side === 'left' ? 1 : -1;
      const need = 10;
      const preferred = clearanceOn(sideSign);
      if (preferred < need && clearanceOn(-sideSign) > preferred) {
        console.warn(`Shutoko map: flipping ${def.id} to the clear side`);
        sideSign = -sideSign;
      }
      const outward = sample.normal.clone().multiplyScalar(sideSign);
      const grounded = !!def.grounded;
      const center = sample.position.clone().addScaledVector(outward, offset);
      const elevation = grounded ? 1.35 : sample.position.y + 0.15;
      center.y = elevation;
      const tangent = sample.tangent.clone();

      // Entry and exit hosts are chosen independently: a roadside PA uses
      // its own carriageway for both, but a JCT-island PA (Daikoku) enters
      // from one road and exits onto another, exactly like the real lot.
      const lotEntry = center.clone().addScaledVector(tangent, -def.length * 0.52);
      const lotExit = center.clone().addScaledVector(tangent, def.length * 0.52);
      const pickHost = (target, need) => {
        let bestHost = null;
        for (const candidate of this.routes.values()) {
          if (candidate.kind === 'service' || candidate.synthetic) continue;
          const candidateProjection = this._projectToRoute(candidate, target);
          if (candidateProjection.endOvershoot > 40) continue;
          const planDistance = Math.hypot(
            candidateProjection.point.x - target.x,
            candidateProjection.point.z - target.z,
          );
          if (planDistance > 420) continue;
          const room = candidate.closed
            ? Infinity
            : (need === 'before' ? candidateProjection.distance : candidate.length - candidateProjection.distance);
          const score = planDistance
            + (room < 320 ? 4000 : 0)
            + Math.abs(candidateProjection.point.y - elevation) * 2
            + (candidate === route ? -60 : 0);
          if (!bestHost || score < bestHost.score) {
            bestHost = { route: candidate, distance: candidateProjection.distance, score, room };
          }
        }
        return bestHost;
      };
      const entryHost = pickHost(lotEntry, 'before') || { route, distance, room: distance };
      const exitHost = pickHost(lotExit, 'after') || { route, distance, room: route.length - distance };

      // Mouths on the hosts' outer edges (the side facing the lot).
      const mouth = (host, atDistance, toward) => {
        const hostSample = this._sampleCenter(host.route, this._normalizeDistance(host.route, atDistance), 1);
        const towardLot = TMP_A.copy(toward).sub(hostSample.position);
        const mouthSide = towardLot.dot(hostSample.normal) >= 0 ? 1 : -1;
        const lateral = mouthSide * Math.max(0.8, host.route.halfWidth - 1.6);
        return {
          point: hostSample.position.clone().addScaledVector(hostSample.normal, lateral),
          tangent: hostSample.tangent.clone(),
        };
      };
      const entryLeg = Math.min(entryHost.room - 90, 360);
      const exitLeg = Math.min(exitHost.room - 90, 360);
      const entryStart = this._normalizeDistance(entryHost.route, entryHost.distance - entryLeg);
      const exitEnd = this._normalizeDistance(exitHost.route, exitHost.distance + exitLeg);
      const inMouthA = mouth(entryHost, entryStart, lotEntry);
      const inMouthB = mouth(entryHost, entryStart + 60, lotEntry);
      const outMouthA = mouth(exitHost, exitEnd - 60, lotExit);
      const outMouthB = mouth(exitHost, exitEnd, lotExit);

      // Descent/ascent paths; when the drop outruns a ~5 % grade over the
      // direct run, wind a spiral at the lot end to earn the length (the
      // Daikoku spiral, rediscovered by the generator).
      const spiralPoints = (from, to, approachTangent) => {
        // Tangent-entry helix: the circle sits perpendicular off the
        // approach direction, so entering it needs no kink; sweep enough
        // turns to keep the descent under ~5 %.
        const points = [];
        const drop = Math.abs(from.y - to.y);
        const direct = Math.hypot(to.x - from.x, to.z - from.z);
        const neededRun = drop / 0.05;
        if (neededRun <= direct + 60) return points;
        const radius = 82;
        const dirX = approachTangent.x;
        const dirZ = approachTangent.z;
        const norm = Math.hypot(dirX, dirZ) || 1;
        // choose the perpendicular that curls toward the target
        const perpAx = -dirZ / norm;
        const perpAz = dirX / norm;
        const towardX = to.x - from.x;
        const towardZ = to.z - from.z;
        const side = (perpAx * towardX + perpAz * towardZ) >= 0 ? 1 : -1;
        const centerX = from.x + perpAx * side * radius;
        const centerZ = from.z + perpAz * side * radius;
        const startAngle = Math.atan2(from.x - centerX, from.z - centerZ);
        const turns = clamp((neededRun - direct * 0.5) / (Math.PI * 2 * radius), 0.75, 2.2);
        const steps = Math.max(10, Math.round(turns * 14));
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          const angle = startAngle + t * turns * Math.PI * 2 * -side;
          points.push(vec(
            centerX + Math.sin(angle) * radius,
            from.y + (to.y - from.y) * t,
            centerZ + Math.cos(angle) * radius,
          ));
        }
        return points;
      };

      const entrySpiral = spiralPoints(inMouthB.point, lotEntry, inMouthB.tangent);
      const exitSpiral = spiralPoints(lotExit, outMouthA.point, tangent);
      const accessPoints = [
        inMouthA.point,
        inMouthB.point,
        ...entrySpiral,
        lotEntry.clone().addScaledVector(outward, -def.width * 0.1),
        center.clone().addScaledVector(outward, -def.width * 0.16),
        lotExit.clone().addScaledVector(outward, -def.width * 0.1),
        ...exitSpiral,
        outMouthA.point,
        outMouthB.point,
      ];
      // Elevation profile: host decks at the mouths, lot level between,
      // linear in path length across each leg.
      accessPoints[0].y = this._sampleCenter(entryHost.route, entryStart, 1).position.y;
      accessPoints[1].y = this._sampleCenter(entryHost.route, this._normalizeDistance(entryHost.route, entryStart + 60), 1).position.y;
      accessPoints[accessPoints.length - 2].y = this._sampleCenter(exitHost.route, this._normalizeDistance(exitHost.route, exitEnd - 60), 1).position.y;
      accessPoints[accessPoints.length - 1].y = this._sampleCenter(exitHost.route, exitEnd, 1).position.y;
      const smoothLeg = (fromIndex, toIndex) => {
        let total = 0;
        for (let i = fromIndex + 1; i <= toIndex; i += 1) total += accessPoints[i].distanceTo(accessPoints[i - 1]);
        let travelled = 0;
        const yA = accessPoints[fromIndex].y;
        const yB = accessPoints[toIndex].y;
        for (let i = fromIndex + 1; i < toIndex; i += 1) {
          travelled += accessPoints[i].distanceTo(accessPoints[i - 1]);
          accessPoints[i].y = yA + (yB - yA) * (total > 0 ? travelled / total : 0);
        }
      };
      // legs: mouth pair -> first lot point, last lot point -> mouth pair
      const lotStartIndex = 2 + entrySpiral.length;
      for (let i = lotStartIndex; i <= lotStartIndex + 2; i += 1) accessPoints[i].y = elevation;
      smoothLeg(1, lotStartIndex);
      smoothLeg(lotStartIndex + 2, accessPoints.length - 2);

      const accessRoute = this._registerRoute({
        id: `${def.id}_access`, code: 'PA', name: `${def.name} lane`, kind: 'service',
        group: def.id,
        points: accessPoints, lanes: 1, laneWidth: 4.6, oneWay: true, bidirectional: false,
        speedLimit: 30, traffic: false, shoulder: 1.0,
        destinations: [[def.name.toUpperCase(), 'パーキング']],
      });
      this._addEdge({
        from: { routeId: entryHost.route.id, distance: entryStart, direction: 1 },
        to: { routeId: accessRoute.id, distance: 0, direction: 1 },
        kind: 'diverge', name: `${def.name} entry`, probability: 0,
      });
      this._addEdge({
        from: { routeId: accessRoute.id, distance: 'end', direction: 1 },
        to: { routeId: exitHost.route.id, distance: exitEnd, direction: 1 },
        kind: 'merge', name: `${def.name} exit`,
      });

      const area = this._pushServiceArea(def, route, distance, center, tangent, outward, elevation, accessRoute.id);
      area.sideSign = sideSign;
    }
  }

  _pushServiceArea(def, route, distance, center, tangent, outward, elevation, accessRouteId) {
    const area = {
      id: def.id,
      name: def.name,
      routeId: def.routeId,
      direction: def.direction ?? 1,
      hasGarage: !!def.hasGarage,
      density: def.density || 'light',
      width: def.width,
      length: def.length,
      mainDistance: distance,
      center,
      position: center,
      tangent,
      normal: outward,
      elevation,
      accessRouteId,
      entryPosition: center.clone().addScaledVector(tangent, -def.length * 0.5),
      exitPosition: center.clone().addScaledVector(tangent, def.length * 0.5),
      refuelPosition: center.clone().addScaledVector(outward, def.width * 0.18).addScaledVector(tangent, def.length * 0.22),
      bankRadius: Math.min(def.width, def.length) * 0.44,
    };
    area.garageEntrance = def.hasGarage
      ? center.clone().addScaledVector(outward, def.width * 0.46).addScaledVector(tangent, -14)
      : null;
    this.serviceAreas.push(area);
    return area;
  }

  // ------------------------------------------------------------------
  // Network finalization
  // ------------------------------------------------------------------

  _finalizeNetwork() {
    for (const route of this.routes.values()) {
      // Tunnel/bridge zones come from OSM as arc-distance ranges over the
      // raw polyline; rescale onto the fitted curve's length.
      const scale = route.dataLength ? route.length / route.dataLength : 1;
      for (const zone of route.tunnelRanges || []) {
        const long = zone.end - zone.start > 1400;
        route.tunnels.push({
          name: zone.name || (route.group === 'wangan' && long ? 'Tokyo Port Tunnel' : `${route.name} tunnel`),
          style: route.group === 'wangan' ? 'orange' : 'white',
          startDistance: zone.start * scale,
          endDistance: zone.end * scale,
        });
      }
      // Only long spans count as "bridge" (pillar suppression + dressing):
      // OSM tags most viaducts bridge=yes, which is what the pillars ARE for.
      const spans = (route.bridgeRanges || []).filter((zone) => zone.end - zone.start > 400);
      if (spans.length) {
        const main = spans.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
        route.bridge = { startDistance: main.start * scale, endDistance: main.end * scale };
      }
    }
    // Taper wide routes into narrower continuations so the corridor union has
    // no lateral steps at seams (e.g. 3-lane Wangan into 2-lane R9).
    for (const edge of this.edges) {
      if (edge.kind !== 'continuation') continue;
      const from = this.routes.get(edge.from.routeId);
      const to = this.routes.get(edge.to.routeId);
      if (!from || !to || from.halfWidth <= to.halfWidth + 0.05) continue;
      const taper = { over: 420, to: to.halfWidth };
      if (edge.from.distance < from.length * 0.5) from.taperStart = taper;
      else from.taperEnd = taper;
    }
  }

  _halfWidthAt(route, distance) {
    let half = route.halfWidth;
    if (route.taperStart && distance < route.taperStart.over) {
      const t = clamp(distance / route.taperStart.over, 0, 1);
      half = route.taperStart.to + (route.halfWidth - route.taperStart.to) * t;
    }
    if (route.taperEnd && distance > route.length - route.taperEnd.over) {
      const t = clamp((route.length - distance) / route.taperEnd.over, 0, 1);
      half = route.taperEnd.to + (route.halfWidth - route.taperEnd.to) * t;
    }
    return half;
  }

  _endIsOpen(route, whichEnd) {
    if (route.closed) return true;
    const endDistance = whichEnd > 0 ? route.length : 0;
    return this.edges.some((edge) => edge.from.routeId === route.id
      && Math.abs(edge.from.distance - endDistance) < 60 && edge.kind !== 'diverge')
      || this.edges.some((edge) => edge.to.routeId === route.id && Math.abs(edge.to.distance - endDistance) < 60);
  }

  // ------------------------------------------------------------------
  // Projection / sampling
  // ------------------------------------------------------------------

  _candidateRoutes(position) {
    const cx = Math.floor(position.x / this._gridCell);
    const cz = Math.floor(position.z / this._gridCell);
    const best = new Map(); // route id -> {route, index, distSq}
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const bucket = this._grid.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const entry of bucket) {
          const sample = entry.route.samples[entry.index];
          const distSq = xzDistanceSq(position, sample.point);
          const current = best.get(entry.route.id);
          if (!current || distSq < current.distSq) best.set(entry.route.id, { route: entry.route, index: entry.index, distSq });
        }
      }
    }
    return best;
  }

  /** Refined nearest point on a route, seeded from the spatial grid or a full scan. */
  _projectToRoute(route, position, seedIndex = null) {
    let bestU = 0;
    let bestDistanceSq = Infinity;
    if (seedIndex !== null && route.samples[seedIndex]) {
      const span = 3;
      for (let i = seedIndex - span; i <= seedIndex + span; i += 1) {
        const index = route.closed ? ((i % route.samples.length) + route.samples.length) % route.samples.length : clamp(i, 0, route.samples.length - 1);
        const sample = route.samples[index];
        const distanceSq = sample.point.distanceToSquared(position);
        if (distanceSq < bestDistanceSq) { bestDistanceSq = distanceSq; bestU = sample.u; }
      }
    } else {
      for (const sample of route.samples) {
        const distanceSq = sample.point.distanceToSquared(position);
        if (distanceSq < bestDistanceSq) { bestDistanceSq = distanceSq; bestU = sample.u; }
      }
    }
    let step = 1 / Math.max(8, route.samples.length);
    for (let pass = 0; pass < 10; pass += 1) {
      let passU = bestU;
      for (const candidate of [bestU - step, bestU + step]) {
        const u = route.closed ? wrap(candidate, 1) : clamp(candidate, 0, 1);
        const point = route.curve.getPointAt(u);
        const distanceSq = point.distanceToSquared(position);
        if (distanceSq < bestDistanceSq) { bestDistanceSq = distanceSq; passU = u; }
      }
      bestU = passU;
      step *= 0.5;
    }
    const point = route.curve.getPointAt(bestU);
    const tangent = route.curve.getTangentAt(bestU).normalize();
    const normal = horizontalNormal(tangent);
    const delta = TMP_A.copy(position).sub(point);
    // Longitudinal overrun past an OPEN route end: the projection clamps to
    // the endpoint, so a point far beyond it along the tangent would read as
    // "laterally inside". Corridor logic must know about the overrun.
    let endOvershoot = 0;
    if (!route.closed) {
      const along = delta.x * tangent.x + delta.z * tangent.z;
      if (bestU >= 1 - EPSILON && along > 0) endOvershoot = along;
      else if (bestU <= EPSILON && along < 0) endOvershoot = -along;
    }
    return {
      route, routeId: route.id, u: bestU, distance: bestU * route.length,
      point, position: point, tangent, normal,
      signedLateral: delta.dot(normal),
      verticalDistance: delta.y,
      endOvershoot,
      worldDistance: Math.sqrt(point.distanceToSquared(position)),
      distanceSq: point.distanceToSquared(position),
    };
  }

  _normalizeDistance(route, distance) {
    return route.closed ? wrap(distance, route.length) : clamp(distance, 0, route.length);
  }

  _sampleCenter(routeId, distance, direction = 1) {
    const route = typeof routeId === 'string' ? this.routes.get(routeId) : routeId;
    if (!route) throw new Error(`Unknown highway route: ${routeId}`);
    const normalizedDistance = this._normalizeDistance(route, distance);
    const u = route.length > 0 ? normalizedDistance / route.length : 0;
    const position = route.curve.getPointAt(u);
    const baseTangent = route.curve.getTangentAt(u).normalize();
    const tangent = baseTangent.clone().multiplyScalar(direction >= 0 ? 1 : -1);
    const normal = horizontalNormal(tangent);
    return { route, routeId: route.id, distance: normalizedDistance, u, position, point: position, tangent, baseTangent, normal };
  }

  /**
   * Lateral offset of a lane centre from the route centreline, measured along
   * the BASE normal. Left-hand traffic: direction +1 lanes sit on the negative
   * base-normal side; lane 0 is nearest the median.
   */
  _laneOffset(route, laneIndex, direction) {
    const lane = clamp(Math.floor(Number.isFinite(laneIndex) ? laneIndex : 0), 0, route.lanes - 1);
    if (route.bidirectional) {
      return -direction * (route.medianWidth * 0.5 + route.laneWidth * (lane + 0.5));
    }
    return -(lane - (route.lanes - 1) * 0.5) * route.laneWidth;
  }

  /** Sample the centre of a traffic lane. Lane 0 is nearest the median. */
  sampleLane(routeId, distance, lane = 0, direction = null) {
    const { route, alias, requestedId } = this._resolveRoute(routeId);
    const resolvedDirection = route.oneWay
      ? route.oneWayDirection
      : ((direction ?? alias?.direction ?? 1) >= 0 ? 1 : -1);
    const laneIndex = clamp(Math.floor(Number.isFinite(lane) ? lane : 0), 0, route.lanes - 1);
    const center = this._sampleCenter(route, distance, resolvedDirection);
    const baseOffset = this._laneOffset(route, laneIndex, resolvedDirection);
    // center.normal is the DIRECTED normal (= base normal * direction)
    const alongDirected = baseOffset * resolvedDirection;
    const position = center.position.clone().addScaledVector(center.normal, alongDirected);
    const lookAhead = clamp(route.length * 0.002, 4, 14);
    const before = this._sampleCenter(route, center.distance - lookAhead * resolvedDirection, resolvedDirection).tangent;
    const after = this._sampleCenter(route, center.distance + lookAhead * resolvedDirection, resolvedDirection).tangent;
    const crossY = before.z * after.x - before.x * after.z;
    const dot = clamp(before.x * after.x + before.z * after.z, -1, 1);
    const curvature = Math.atan2(crossY, dot) / (lookAhead * 2);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(FORWARD, center.tangent);
    const heading = Math.atan2(center.tangent.x, center.tangent.z);

    return {
      routeId: route.id,
      requestedRouteId: requestedId,
      routeName: route.name,
      code: route.code,
      distance: center.distance,
      s: center.distance,
      length: route.length,
      laneLength: route.length,
      closed: !!route.closed,
      normalizedDistance: route.length ? center.distance / route.length : 0,
      lane: laneIndex,
      laneIndex,
      direction: resolvedDirection,
      position,
      point: position,
      center: center.position,
      tangent: center.tangent,
      forward: center.tangent,
      normal: center.normal,
      right: center.normal.clone(),
      left: center.normal.clone().multiplyScalar(-1),
      up: UP.clone(),
      quaternion,
      rotation: quaternion,
      heading,
      curvature,
      roadWidth: route.roadWidth,
      laneWidth: route.laneWidth,
      speedLimit: route.speedLimit,
      tunnel: this._isTunnel(route, center.distance),
      laneRef: {
        id: `${route.id}:${laneIndex}:${resolvedDirection > 0 ? '+' : '-'}`,
        routeId: route.id,
        laneIndex,
        lane: laneIndex,
        direction: resolvedDirection,
        length: route.length,
        closed: !!route.closed,
        laneCount: route.lanes,
        laneWidth: route.laneWidth,
        speedLimit: route.speedLimit,
      },
    };
  }

  _resolveRoute(routeId) {
    const key = typeof routeId === 'string' ? routeId.toLowerCase() : routeId?.id;
    const alias = this.routeAliases.get(key);
    const canonical = alias ? alias.id : key;
    const route = this.routes.get(canonical);
    if (!route) throw new Error(`Unknown highway route: ${routeId}`);
    return { route, alias, requestedId: key };
  }

  getRoute(routeId) {
    return this._resolveRoute(routeId).route;
  }

  getRouteIds({ includeService = false } = {}) {
    return this.routeOrder.filter((id) => includeService || this.routes.get(id).kind !== 'service');
  }

  getRouteSamples(routeId, spacing = 100, lane = null, direction = null) {
    const { route } = this._resolveRoute(routeId);
    const count = Math.max(2, Math.ceil(route.length / Math.max(5, spacing)));
    const result = [];
    for (let i = 0; i <= count; i += 1) {
      if (route.closed && i === count) continue;
      const distance = route.length * i / count;
      if (lane === null || lane === undefined) {
        const sample = this._sampleCenter(route, distance, direction || 1);
        result.push({
          routeId: route.id, distance,
          position: sample.position, point: sample.position,
          tangent: sample.tangent, normal: sample.normal,
          tunnel: this._isTunnel(route, distance),
        });
      } else {
        result.push(this.sampleLane(routeId, distance, lane, direction));
      }
    }
    return result;
  }

  getLaneSamples(routeId, lane = 0, direction = 1, spacing = 80) {
    return this.getRouteSamples(routeId, spacing, lane, direction);
  }

  getInitialSpawn() {
    const spawn = this.initialSpawn;
    return {
      ...spawn,
      position: spawn.position.clone(),
      point: spawn.position.clone(),
      center: spawn.center.clone(),
      tangent: spawn.tangent.clone(),
      forward: spawn.tangent.clone(),
      normal: spawn.normal.clone(),
      right: spawn.right.clone(),
      up: spawn.up.clone(),
      quaternion: spawn.quaternion.clone(),
      rotation: spawn.quaternion.clone(),
    };
  }

  _isTunnel(route, distance) {
    const normalized = this._normalizeDistance(route, distance);
    for (const tunnel of route.tunnels) {
      if (normalized >= tunnel.startDistance && normalized <= tunnel.endDistance) return tunnel;
    }
    return null;
  }

  _isBridge(route, distance) {
    if (!route.bridge) return false;
    const normalized = this._normalizeDistance(route, distance);
    return normalized >= route.bridge.startDistance && normalized <= route.bridge.endDistance;
  }

  /**
   * Deck bank angle (visual + height) from curvature; subtle, PSX-friendly.
   * Served from a per-route table (built once in _registerRoute) so the roll
   * of the road frame is slew-limited: the raw clamped-curvature bank
   * saturates at ±0.075 for almost any bend and used to FLIP sign within a
   * couple of metres at every S-curve inflection — a 0.7 m deck-edge step
   * that physics, asphalt and markings all inherited. The table smooths the
   * transition over ~50 m. One source: getRoadInfo (physics), _corridorsAt,
   * the deck builder and the marking painter all read this.
   */
  _bankAt(route, distance) {
    if (route.kind === 'service') return 0;
    const table = route.bankTable;
    if (table && table.length > 1) {
      const normalized = this._normalizeDistance(route, distance);
      const slot = normalized / route.bankStep;
      const index = Math.floor(slot);
      const t = slot - index;
      const a = table[clamp(index, 0, table.length - 1)];
      const b = table[route.closed ? (index + 1) % table.length : clamp(index + 1, 0, table.length - 1)];
      return a + (b - a) * t;
    }
    return this._rawBankAt(route, distance);
  }

  /** Instantaneous clamped-curvature bank — table source only. */
  _rawBankAt(route, distance) {
    const lookAhead = 26;
    const before = this._sampleCenter(route, distance - lookAhead, 1).tangent;
    const after = this._sampleCenter(route, distance + lookAhead, 1).tangent;
    const crossY = before.z * after.x - before.x * after.z;
    const dot = clamp(before.x * after.x + before.z * after.z, -1, 1);
    const curvature = Math.atan2(crossY, dot) / (lookAhead * 2);
    return clamp(curvature * 620, -0.075, 0.075);
  }

  /** Sample + smooth the bank profile; ~50 m moving average kills roll flips. */
  _buildBankTable(route) {
    if (route.kind === 'service' || route.length < 30) return;
    const step = 6;
    const count = Math.max(4, Math.ceil(route.length / step));
    route.bankStep = route.length / count;
    const raw = new Float32Array(count + (route.closed ? 0 : 1));
    for (let i = 0; i < raw.length; i += 1) raw[i] = this._rawBankAt(route, i * route.bankStep);
    const radius = 4; // ±4 samples ≈ ±24 m
    const smooth = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      let sum = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const j = route.closed
          ? ((i + k) % raw.length + raw.length) % raw.length
          : clamp(i + k, 0, raw.length - 1);
        sum += raw[j];
        n += 1;
      }
      smooth[i] = sum / n;
    }
    route.bankTable = smooth;
  }

  // ------------------------------------------------------------------
  // Corridor union — road info + solid barriers
  // ------------------------------------------------------------------

  /**
   * All route corridors containing or near `position`. Each entry carries the
   * projection plus the corridor's drivable lateral band(s).
   */
  _corridorsAt(position, lateralMargin = 0, verticalWindow = 5.5) {
    const candidates = this._candidateRoutes(position);
    const corridors = [];
    for (const { route, index } of candidates.values()) {
      let projection = this._projectToRoute(route, position, index);
      // The spatial grid seeds by XZ distance: on plan-self-crossing routes
      // (spirals, stacked loops) that can lock onto the wrong level — retry
      // with a full 3D scan before trusting a big vertical mismatch.
      if (Math.abs(position.y - projection.point.y) > 8) {
        projection = this._projectToRoute(route, position);
      }
      const half = this._halfWidthAt(route, projection.distance);
      if (Math.abs(projection.signedLateral) > half + lateralMargin + 14) continue;
      // Past an OPEN end the corridor no longer exists (the continuation
      // route's corridor takes over); past a CLOSED end the end wall
      // correction still applies, so keep the corridor.
      if (projection.endOvershoot > 4
        && this._endIsOpen(route, projection.u > 0.5 ? 1 : -1)) continue;
      const bank = this._bankAt(route, projection.distance);
      const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral;
      const vertical = position.y - deckY;
      if (vertical < -verticalWindow || vertical > verticalWindow + 2.5) continue;
      corridors.push({
        route, projection, half, bank, deckY, vertical,
        absLateral: Math.abs(projection.signedLateral),
      });
    }
    return corridors;
  }

  /**
   * Is a lateral position within the drivable band of a corridor?
   * Returns 0 when free, otherwise the signed lateral correction needed.
   */
  _lateralCorrection(corridor, lateral, radius) {
    const route = corridor.route;
    const outer = Math.max(0.4, corridor.half - Math.max(0.35, radius));
    if (route.bidirectional) {
      const inner = route.medianWidth * 0.5 + Math.max(0.35, radius) * 0.72;
      const side = lateral >= 0 ? 1 : -1;
      const abs = Math.abs(lateral);
      if (abs > outer) return side * outer - lateral;
      if (abs < inner) {
        // Inside the median strip: push out to the nearer carriageway.
        return side * inner - lateral;
      }
      return 0;
    }
    if (lateral > outer) return outer - lateral;
    if (lateral < -outer) return -outer - lateral;
    return 0;
  }

  /** Longitudinal correction for capped route ends (dead ends, lot edges). */
  _longitudinalCorrection(corridor, radius) {
    const route = corridor.route;
    if (route.closed) return 0;
    const d = corridor.projection.distance;
    const pad = Math.max(0.6, radius);
    if (d < pad && !this._endIsOpen(route, -1)) return pad - d;
    if (d > route.length - pad && !this._endIsOpen(route, 1)) return (route.length - pad) - d;
    return 0;
  }

  _lotAt(position, margin = 0) {
    for (const area of this.serviceAreas) {
      if (Math.abs(position.y - area.elevation) > 6 + Math.max(0, margin)) continue;
      const delta = TMP_A.copy(position).sub(area.center);
      const longitudinal = delta.dot(area.tangent);
      const lateral = delta.dot(area.normal);
      if (Math.abs(longitudinal) <= area.length * 0.5 + margin
        && Math.abs(lateral) <= area.width * 0.5 + margin) {
        return { area, longitudinal, lateral };
      }
    }
    return null;
  }

  getRoadInfo(position, hint = null) {
    const lot = this._lotAt(position, 0);
    if (lot) return this._lotRoadInfo(position, lot);

    const corridors = this._corridorsAt(position, 8);
    let best = null;
    let bestScore = Infinity;
    for (const corridor of corridors) {
      const lateralRatio = corridor.absLateral / Math.max(1, corridor.half);
      let score = lateralRatio + Math.abs(corridor.vertical) * 0.6;
      if (hint && corridor.route.id === hint) score -= 0.22;
      if (corridor.route.kind === 'service') score += 0.3;
      if (score < bestScore) { bestScore = score; best = corridor; }
    }
    if (!best) {
      // Fall back to a wide nearest-route scan so tow/recover still work.
      const nearest = this.getNearestRoute(position, { maxDistance: 400 });
      if (!nearest) return null;
      best = {
        route: nearest.route,
        projection: nearest,
        half: this._halfWidthAt(nearest.route, nearest.distance),
        bank: 0,
        deckY: nearest.point.y,
        vertical: position.y - nearest.point.y,
        absLateral: Math.abs(nearest.signedLateral),
      };
    }

    const route = best.route;
    const projection = best.projection;
    const absLateral = best.absLateral;
    const onSurface = absLateral <= best.half + 0.3 && Math.abs(best.vertical) < 5.5;
    let direction = 1;
    let lane = 0;
    let medianDistance = Infinity;
    let drivable = onSurface;
    if (route.bidirectional) {
      direction = projection.signedLateral <= 0 ? 1 : -1;
      medianDistance = absLateral - route.medianWidth * 0.5;
      drivable = drivable && medianDistance >= -0.2;
      lane = clamp(Math.floor(Math.max(0, medianDistance) / route.laneWidth), 0, route.lanes - 1);
    } else {
      direction = route.oneWayDirection;
      const centered = -projection.signedLateral / route.laneWidth + (route.lanes - 1) * 0.5;
      lane = clamp(Math.round(centered), 0, route.lanes - 1);
    }
    const laneCenterSample = this.sampleLane(route.id, projection.distance, lane, direction);
    const proximity = this.getServiceAreaProximity(position, 220);
    const height = best.deckY;

    return {
      route,
      routeId: route.id,
      routeName: route.name,
      code: route.code,
      u: projection.u,
      distance: projection.distance,
      normalizedDistance: route.length ? projection.distance / route.length : 0,
      point: projection.point,
      position: projection.point,
      center: laneCenterSample.position,
      routeCenter: projection.point,
      tangent: laneCenterSample.tangent,
      normal: laneCenterSample.normal,
      right: laneCenterSample.normal.clone(),
      up: UP.clone(),
      surfaceNormal: UP.clone(),
      signedLateral: projection.signedLateral,
      lateralOffset: projection.signedLateral * direction, // along driver's right
      verticalDistance: best.vertical,
      worldDistance: projection.worldDistance,
      height,
      roadHeight: height,
      y: height,
      bank: best.bank,
      grade: laneCenterSample.tangent.y,
      heading: laneCenterSample.heading,
      surfaceGrip: onSurface ? 1 : 0.58,
      lane,
      laneWidth: route.laneWidth,
      lanes: route.lanes,
      direction,
      roadHalfWidth: best.half,
      halfWidth: best.half,
      roadWidth: best.half * 2,
      edgeDistance: best.half - absLateral,
      medianDistance,
      onRoadSurface: onSurface,
      onRoad: drivable,
      drivable,
      inServiceArea: false,
      serviceArea: proximity?.inside ? proximity.area : null,
      serviceAreaId: proximity?.inside ? proximity.id : null,
      tunnel: this._isTunnel(route, projection.distance),
      bridge: this._isBridge(route, projection.distance),
      speedLimit: route.speedLimit,
      junction: this._nearbyJunction(position),
      district: this._districtLabel(route, projection.distance, position),
    };
  }

  _districtLabel(route, distance, position) {
    const tunnel = this._isTunnel(route, distance);
    if (tunnel) return tunnel.name.toUpperCase();
    if (this._isBridge(route, distance) && route.group === 'r11') return 'RAINBOW BRIDGE';
    const junction = this._nearbyJunction(position);
    if (junction) return junction.name.toUpperCase();
    return 'SHUTO EXPRESSWAY';
  }

  _lotRoadInfo(position, lot) {
    const { area, longitudinal, lateral } = lot;
    const point = area.center.clone()
      .addScaledVector(area.tangent, longitudinal)
      .addScaledVector(area.normal, lateral);
    point.y = area.elevation;
    return {
      routeId: area.accessRouteId,
      routeName: `${area.name}`,
      code: 'PA',
      distance: longitudinal + area.length * 0.5,
      normalizedDistance: (longitudinal + area.length * 0.5) / area.length,
      point, center: point, position: point,
      tangent: area.tangent.clone(),
      normal: area.normal.clone(),
      right: area.normal.clone(),
      up: UP.clone(),
      surfaceNormal: UP.clone(),
      height: area.elevation,
      roadHeight: area.elevation,
      y: area.elevation,
      surfaceGrip: 0.94,
      grade: 0,
      bank: 0,
      heading: Math.atan2(area.tangent.x, area.tangent.z),
      signedLateral: lateral,
      lateralOffset: lateral,
      verticalDistance: position.y - area.elevation,
      worldDistance: Math.abs(position.y - area.elevation),
      lane: -1,
      direction: 1,
      roadHalfWidth: area.width * 0.5,
      halfWidth: area.width * 0.5,
      roadWidth: area.width,
      edgeDistance: Math.min(area.width * 0.5 - Math.abs(lateral), area.length * 0.5 - Math.abs(longitudinal)),
      medianDistance: Infinity,
      onRoadSurface: true, onRoad: true, drivable: true,
      tunnel: false, bridge: false,
      speedLimit: 20,
      serviceArea: area,
      serviceAreaId: area.id,
      inServiceArea: true,
      junction: null,
    };
  }

  getNearestRoute(position, maxDistanceOrOptions = Infinity) {
    const options = typeof maxDistanceOrOptions === 'object'
      ? maxDistanceOrOptions
      : { maxDistance: maxDistanceOrOptions };
    const maxDistance = options.maxDistance ?? Infinity;
    const includeService = options.includeService !== false;
    const routeIds = options.routeIds ? new Set(options.routeIds.map((id) => this._resolveRoute(id).route.id)) : null;
    let best = null;

    const candidates = this._candidateRoutes(position);
    const scan = candidates.size
      ? [...candidates.values()].map((entry) => ({ route: entry.route, seed: entry.index }))
      : [...this.routes.values()].map((route) => ({ route, seed: null }));
    for (const { route, seed } of scan) {
      if (!includeService && route.kind === 'service') continue;
      if (routeIds && !routeIds.has(route.id)) continue;
      const candidate = this._projectToRoute(route, position, seed);
      if (!best || candidate.distanceSq < best.distanceSq) best = candidate;
    }
    if (!best && candidates.size) return this.getNearestRoute(position, { ...options, forceFull: true });
    if (!best || best.worldDistance > maxDistance) return null;
    const junction = this._nearbyJunction(position);
    return {
      ...best,
      routeName: best.route.name,
      code: best.route.code,
      laneWidth: best.route.laneWidth,
      lanes: best.route.lanes,
      roadWidth: best.route.roadWidth,
      halfWidth: best.route.halfWidth,
      speedLimit: best.route.speedLimit,
      tunnel: this._isTunnel(best.route, best.distance),
      junction,
    };
  }

  _nearbyJunction(position) {
    let nearest = null;
    let nearestSq = Infinity;
    for (const junction of this.junctions) {
      const distanceSq = xzDistanceSq(position, junction.point);
      if (distanceSq <= junction.radius * junction.radius && distanceSq < nearestSq) {
        nearest = junction;
        nearestSq = distanceSq;
      }
    }
    return nearest;
  }

  isPointDrivable(position, margin = 0) {
    if (this._lotAt(position, margin)) return true;
    const corridors = this._corridorsAt(position, margin);
    for (const corridor of corridors) {
      if (this._lateralCorrection(corridor, corridor.projection.signedLateral, -margin) === 0
        && this._longitudinalCorrection(corridor, -margin) === 0) return true;
    }
    return false;
  }

  /** Legacy-shaped bounds for the best corridor. Walls are never disabled. */
  getWallCollisionBounds(position, vehicleRadius = 0) {
    const lot = this._lotAt(position, vehicleRadius + 6);
    if (lot) {
      const { area, longitudinal, lateral } = lot;
      return {
        type: 'service-area',
        routeId: area.accessRouteId,
        serviceArea: area,
        center: area.center.clone(),
        tangent: area.tangent.clone(),
        normal: area.normal.clone(),
        longitudinal,
        signedLateral: lateral,
        minLongitudinal: -area.length * 0.5 + vehicleRadius,
        maxLongitudinal: area.length * 0.5 - vehicleRadius,
        minLateral: -area.width * 0.5 + vehicleRadius,
        maxLateral: area.width * 0.5 - vehicleRadius,
        disabled: false,
      };
    }
    const info = this.getRoadInfo(position);
    if (!info || !info.route) return null;
    const route = info.route;
    const outerLimit = Math.max(0.1, info.halfWidth - vehicleRadius);
    const side = info.signedLateral >= 0 ? 1 : -1;
    const innerLimit = route.bidirectional ? route.medianWidth * 0.5 + vehicleRadius : -outerLimit;
    const baseNormal = horizontalNormal(this._sampleCenter(route, info.distance, 1).tangent);
    return {
      type: 'route',
      routeId: route.id,
      route,
      distance: info.distance,
      center: info.routeCenter.clone(),
      tangent: info.tangent.clone(),
      normal: baseNormal,
      signedLateral: info.signedLateral,
      side,
      innerLimit,
      outerLimit,
      minLateral: route.bidirectional ? side * innerLimit : -outerLimit,
      maxLateral: side * outerLimit,
      junction: info.junction,
      disabled: false,
      tunnel: info.tunnel,
    };
  }

  getCollisionBounds(position, vehicleRadius = 0) {
    return this.getWallCollisionBounds(position, vehicleRadius);
  }

  /**
   * Push a position back inside the corridor union. The point is FREE if any
   * corridor (or PA lot) accepts it; otherwise it is corrected against the
   * corridor needing the smallest push. Returns the legacy result shape.
   */
  resolveWallCollision(position, velocityOrRadius = null, maybeRadius = 1.25) {
    const velocity = velocityOrRadius?.isVector3 ? velocityOrRadius : null;
    const radius = Number.isFinite(velocityOrRadius) ? velocityOrRadius : maybeRadius;
    const corrected = position.clone();
    const correctedVelocity = velocity ? velocity.clone() : null;

    const lot = this._lotAt(position, radius + 4);
    const corridors = this._corridorsAt(position, radius + 4);
    let bestFix = null; // {distSq, apply(vec3)}

    if (lot) {
      const { area, longitudinal, lateral } = lot;
      const targetLong = clamp(longitudinal, -area.length * 0.5 + radius, area.length * 0.5 - radius);
      const targetLat = clamp(lateral, -area.width * 0.5 + radius, area.width * 0.5 - radius);
      if (targetLong === longitudinal && targetLat === lateral) {
        return { hit: false, position: corrected, velocity: correctedVelocity, bounds: null };
      }
      const fixed = area.center.clone()
        .addScaledVector(area.tangent, targetLong)
        .addScaledVector(area.normal, targetLat);
      fixed.y = position.y;
      bestFix = { distSq: fixed.distanceToSquared(position), point: fixed, type: 'parking-wall' };
    }

    for (const corridor of corridors) {
      const lateralFix = this._lateralCorrection(corridor, corridor.projection.signedLateral, radius);
      const longFix = this._longitudinalCorrection(corridor, radius);
      if (lateralFix === 0 && longFix === 0) {
        // Free inside this corridor — no collision at all.
        return { hit: false, position: corrected, velocity: correctedVelocity, bounds: null };
      }
      const fixed = position.clone();
      if (lateralFix !== 0) fixed.addScaledVector(corridor.projection.normal, lateralFix);
      if (longFix !== 0) fixed.addScaledVector(corridor.projection.tangent, longFix);
      const distSq = fixed.distanceToSquared(position);
      if (!bestFix || distSq < bestFix.distSq) {
        const type = longFix !== 0 ? 'end-wall'
          : (corridor.route.bidirectional && corridor.absLateral < corridor.route.medianWidth) ? 'median' : 'outer-wall';
        bestFix = { distSq, point: fixed, type };
      }
    }

    if (!bestFix) {
      // Nowhere near any corridor (deep escape) — snap back to nearest route lane.
      const nearest = this.getNearestRoute(position, { maxDistance: Infinity });
      if (!nearest) return { hit: false, position: corrected, velocity: correctedVelocity, bounds: null };
      const lane = this.sampleLane(nearest.routeId, nearest.distance, 0, nearest.route.bidirectional ? (nearest.signedLateral <= 0 ? 1 : -1) : 1);
      const fixed = lane.position.clone();
      fixed.y += 0.4;
      bestFix = { distSq: fixed.distanceToSquared(position), point: fixed, type: 'outer-wall' };
    }

    corrected.copy(bestFix.point);
    const outwardNormal = position.clone().sub(corrected).setY(0);
    if (outwardNormal.lengthSq() < EPSILON) outwardNormal.set(1, 0, 0);
    outwardNormal.normalize();
    if (correctedVelocity) {
      const outwardSpeed = correctedVelocity.dot(outwardNormal);
      if (outwardSpeed > 0) correctedVelocity.addScaledVector(outwardNormal, -outwardSpeed * 1.32);
    }
    return {
      hit: true,
      type: bestFix.type,
      position: corrected,
      velocity: correctedVelocity,
      normal: outwardNormal.clone().multiplyScalar(-1),
      bounds: null,
      penetration: 0,
      correctionDistance: Math.sqrt(bestFix.distSq),
    };
  }

  /**
   * Continuous sweep between two positions. Probes every <= maxStep metres so
   * barriers stay solid at any speed; the median band (>= ~4.4 m with vehicle
   * radius) can never be jumped at a 1.5 m step.
   */
  sweepWallCollision(from, to, velocity = null, vehicleRadius = 1.25, maxStep = 1.5) {
    const distance = from.distanceTo(to);
    const steps = Math.max(1, Math.ceil(distance / Math.max(0.5, maxStep)));
    for (let i = 1; i <= steps; i += 1) {
      const fraction = i / steps;
      const probe = TMP_B.copy(from).lerp(to, fraction);
      const result = this.resolveWallCollision(probe, velocity, vehicleRadius);
      if (result.hit) return { ...result, fraction, probe: probe.clone() };
    }
    return {
      hit: false,
      fraction: 1,
      position: to.clone(),
      velocity: velocity?.clone() || null,
      bounds: null,
    };
  }

  getWallSegments(position = null, radius = 500) {
    if (!position) return this.wallSegments;
    const radiusSq = radius * radius;
    return this.wallSegments.filter((segment) =>
      xzDistanceSq(position, segment.start) <= radiusSq || xzDistanceSq(position, segment.end) <= radiusSq);
  }

  // ------------------------------------------------------------------
  // Connectivity + traffic API
  // ------------------------------------------------------------------

  getRouteConnections(routeId, distance, threshold = 110) {
    const { route } = this._resolveRoute(routeId);
    return (this.connections.get(route.id) || []).filter((connection) => {
      let delta = Math.abs(connection.fromDistance - this._normalizeDistance(route, distance));
      if (route.closed) delta = Math.min(delta, route.length - delta);
      return delta <= threshold;
    }).map((connection) => ({ ...connection, point: connection.point.clone() }));
  }

  getConnectedRoutes(routeId, distance, threshold = 110) {
    return this.getRouteConnections(routeId, distance, threshold);
  }

  _edgesFrom(routeId, direction, atDistance, tolerance = 60, kinds = null) {
    return this.edges.filter((edge) => edge.from.routeId === routeId
      && edge.from.direction === direction
      && Math.abs(edge.from.distance - atDistance) <= tolerance
      && (!kinds || kinds.includes(edge.kind)));
  }

  /** Follow the network from a lane state by deltaDistance metres of travel. */
  advanceAlongRoute(stateOrRouteId, deltaDistance, lane = 0, direction = 1, branchIndex = 0) {
    const state = typeof stateOrRouteId === 'object'
      ? stateOrRouteId
      : { routeId: stateOrRouteId, distance: 0, lane, direction };
    let { route } = this._resolveRoute(state.routeId);
    let distance = Number.isFinite(state.distance) ? state.distance : 0;
    let travelDirection = (state.direction ?? direction) >= 0 ? 1 : -1;
    let laneIndex = state.lane ?? lane;
    let remaining = Math.max(0, deltaDistance);
    let guard = 0;
    let transferred = false;

    while (guard < 8) {
      guard += 1;
      const target = distance + remaining * travelDirection;
      if (route.closed) {
        distance = wrap(target, route.length);
        remaining = 0;
        break;
      }
      if (target >= 0 && target <= route.length) {
        distance = target;
        remaining = 0;
        break;
      }
      const atEnd = target > route.length;
      const endDistance = atEnd ? route.length : 0;
      const overrun = atEnd ? target - route.length : -target;
      const options = this._edgesFrom(route.id, travelDirection, endDistance, 60, ['continuation', 'merge']);
      if (!options.length) {
        distance = clamp(target, 0, route.length);
        remaining = 0;
        break;
      }
      const edge = options[Math.abs(branchIndex) % options.length];
      const nextRoute = this.routes.get(edge.to.routeId);
      if (edge.kind === 'merge') laneIndex = edge.mergeLane ?? nextRoute.lanes - 1;
      laneIndex = clamp(laneIndex, 0, nextRoute.lanes - 1);
      route = nextRoute;
      distance = edge.to.distance;
      travelDirection = edge.to.direction;
      remaining = overrun;
      transferred = true;
      if (remaining <= EPSILON) break;
    }

    const sample = this.sampleLane(route.id, distance, laneIndex, travelDirection);
    sample.transferred = transferred;
    return sample;
  }

  getTrafficSpawn(randomSource = Math.random, allowedRoutes = null) {
    if (randomSource && typeof randomSource === 'object' && typeof randomSource !== 'function') {
      const request = randomSource;
      const rng = typeof request.random === 'function' ? request.random : Math.random;
      const playerPosition = request.playerPosition || request.position;
      const road = playerPosition ? this.getRoadInfo(playerPosition) : null;
      if (road?.routeId && !road.inServiceArea && road.route?.traffic) {
        const route = this.routes.get(road.routeId);
        const direction = route.bidirectional && rng() < 0.2 ? -road.direction : road.direction;
        const laneIndex = Math.floor(rng() * route.lanes);
        const minimum = request.minDistance ?? 120;
        const maximum = request.maxDistance ?? 900;
        const offset = (minimum + rng() * Math.max(1, maximum - minimum)) * (rng() < 0.5 ? -1 : 1);
        return this.sampleLane(route.id, road.distance + offset * direction, laneIndex, direction);
      }
      randomSource = rng;
      allowedRoutes = request.allowedRoutes || null;
    }
    if (typeof randomSource !== 'function') randomSource = Math.random;
    const allowed = allowedRoutes
      ? allowedRoutes.map((id) => this._resolveRoute(id).route).filter((route) => route.traffic)
      : [...this.routes.values()].filter((route) => route.traffic);
    const totalLength = allowed.reduce((sum, route) => sum + route.length, 0);
    let pick = randomSource() * totalLength;
    let route = allowed[0];
    for (const candidate of allowed) {
      pick -= candidate.length;
      if (pick <= 0) { route = candidate; break; }
    }
    const distance = randomSource() * route.length;
    const direction = route.bidirectional && randomSource() < 0.5 ? -1 : 1;
    const laneIndex = Math.floor(randomSource() * route.lanes);
    return this.sampleLane(route.id, distance, laneIndex, direction);
  }

  getTrafficLanes(position, radius) {
    const searchRadius = Number.isFinite(radius) ? radius : Infinity;
    const routeAllowed = (route) => {
      if (!route.traffic) return false;
      if (!position || !Number.isFinite(searchRadius)) return true;
      return route.samples.some((sample) => xzDistanceSq(position, sample.point) <= (searchRadius + 180) ** 2);
    };
    const lanes = [];
    for (const route of this.routes.values()) {
      if (!routeAllowed(route)) continue;
      const directions = route.bidirectional ? [1, -1] : [route.oneWayDirection];
      for (const direction of directions) {
        for (let laneIndex = 0; laneIndex < route.lanes; laneIndex += 1) {
          lanes.push({
            id: `${route.id}:${laneIndex}:${direction > 0 ? '+' : '-'}`,
            routeId: route.id,
            route,
            laneIndex,
            lane: laneIndex,
            direction,
            length: route.length,
            closed: !!route.closed,
            laneCount: route.lanes,
            laneWidth: route.laneWidth,
            speedLimit: route.speedLimit,
          });
        }
      }
    }
    return lanes;
  }

  getNearbyTrafficLanes(position, radius = 1200) {
    return this.getTrafficLanes(position, radius);
  }

  sampleTrafficLane(laneRef, distance) {
    if (!laneRef) return null;
    const routeId = laneRef.routeId ?? laneRef.route?.id ?? laneRef.id;
    if (routeId == null) return null;
    const laneIndex = laneRef.laneIndex ?? laneRef.lane ?? laneRef.index ?? 0;
    const direction = laneRef.direction ?? 1;
    const route = this.routes.get(typeof routeId === 'string' ? routeId : String(routeId));
    if (route && !route.closed && (distance < -1 || distance > route.length + 1)) return null;
    const sample = this.sampleLane(routeId, distance, laneIndex, direction);
    return { ...sample, laneRef: { ...sample.laneRef, ...laneRef, routeId: sample.routeId, laneIndex: sample.laneIndex } };
  }

  getLaneSample(routeId, laneIndex, distance, direction = 1) {
    return this.sampleLane(routeId, distance, laneIndex, direction);
  }

  projectToTrafficLane(position, laneRef) {
    if (!laneRef) return null;
    const routeId = laneRef.routeId ?? laneRef.route?.id ?? laneRef.id;
    const { route } = this._resolveRoute(routeId);
    const nearest = this._projectToRoute(route, position);
    const sample = this.sampleTrafficLane(laneRef, nearest.distance);
    if (!sample) return null;
    return {
      ...sample,
      s: nearest.distance,
      distance: nearest.distance,
      lateralDistance: position.distanceTo(sample.position),
      signedLateral: TMP_A.copy(position).sub(sample.position).dot(sample.right),
    };
  }

  projectToLane(position, laneRef) {
    return this.projectToTrafficLane(position, laneRef);
  }

  getAdjacentTrafficLane(laneRef, laneDelta) {
    if (!laneRef) return null;
    const routeId = laneRef.routeId ?? laneRef.route?.id;
    const route = this.routes.get(routeId);
    if (!route) return null;
    const laneIndex = (laneRef.laneIndex ?? laneRef.lane ?? 0) + Math.sign(laneDelta || 0);
    if (laneIndex < 0 || laneIndex >= route.lanes) return null;
    return {
      ...laneRef,
      id: `${route.id}:${laneIndex}:${(laneRef.direction ?? 1) > 0 ? '+' : '-'}`,
      routeId: route.id,
      route,
      laneIndex,
      lane: laneIndex,
      length: route.length,
      closed: !!route.closed,
      laneCount: route.lanes,
    };
  }

  getAdjacentLane(laneRef, laneDelta) {
    return this.getAdjacentTrafficLane(laneRef, laneDelta);
  }

  _laneRefFor(route, laneIndex, direction) {
    const lane = clamp(laneIndex, 0, route.lanes - 1);
    return {
      id: `${route.id}:${lane}:${direction > 0 ? '+' : '-'}`,
      routeId: route.id,
      route,
      laneIndex: lane,
      lane,
      direction,
      length: route.length,
      closed: !!route.closed,
      laneCount: route.lanes,
      laneWidth: route.laneWidth,
      speedLimit: route.speedLimit,
    };
  }

  getNextTrafficLane(laneRef, _vehicle = null, randomSource = Math.random) {
    if (!laneRef) return null;
    const routeId = laneRef.routeId ?? laneRef.route?.id;
    const route = this.routes.get(routeId);
    if (!route) return null;
    if (route.closed) return { ...laneRef, length: route.length, closed: true };
    const direction = laneRef.direction ?? 1;
    const endpoint = direction >= 0 ? route.length : 0;
    const options = this._edgesFrom(route.id, direction, endpoint, 60, ['continuation', 'merge']);
    if (!options.length) return null;
    const rng = typeof randomSource === 'function' ? randomSource : Math.random;
    const edge = options[Math.floor(rng() * options.length)];
    const nextRoute = this.routes.get(edge.to.routeId);
    const laneIndex = edge.kind === 'merge'
      ? (edge.mergeLane ?? nextRoute.lanes - 1)
      : clamp(laneRef.laneIndex ?? 0, 0, nextRoute.lanes - 1);
    return this._laneRefFor(nextRoute, laneIndex, edge.to.direction);
  }

  getNextLane(laneRef, vehicle = null, randomSource = Math.random) {
    return this.getNextTrafficLane(laneRef, vehicle, randomSource);
  }

  chooseTrafficConnection(laneRef, vehicle = null, randomSource = Math.random) {
    return this.getNextTrafficLane(laneRef, vehicle, randomSource);
  }

  /**
   * Advance a traffic vehicle. Handles: closed loops, endpoint continuations
   * and merges (arriving in the outer lane), optional mid-route diverges for
   * vehicles in the outermost lane, and lane funnelling ahead of narrower
   * continuations. Reports transfer + lateral jump so the traffic system can
   * blend the visual position.
   */
  advanceTraffic(request) {
    if (!request) return null;
    const laneRef = request.laneRef ?? request.lane;
    if (!laneRef) return null;
    const routeId = laneRef.routeId ?? laneRef.route?.id;
    const route = this.routes.get(routeId);
    if (!route) return null;
    let laneIndex = clamp(laneRef.laneIndex ?? laneRef.lane ?? 0, 0, route.lanes - 1);
    const direction = (laneRef.direction ?? 1) >= 0 ? 1 : -1;
    const s0 = Number.isFinite(request.s) ? request.s : (request.distanceAlongRoute ?? 0);
    const travel = Math.max(0, request.distance ?? request.delta ?? request.advance ?? 0);
    const vehicle = request.vehicle || null;
    const beforePosition = this.sampleLane(route.id, s0, laneIndex, direction).position;

    // Mid-route diverge: outermost lane only, seeded per vehicle+edge.
    if (route.traffic && laneIndex === route.lanes - 1 && travel > 0) {
      const s1 = s0 + travel * direction;
      for (const edge of this.edges) {
        if (edge.kind !== 'diverge' || edge.probability <= 0) continue;
        if (edge.from.routeId !== route.id || edge.from.direction !== direction) continue;
        const d = edge.from.distance;
        const crossed = direction > 0 ? (s0 < d && s1 >= d) : (s0 > d && s1 <= d);
        if (!crossed) continue;
        const targetRoute = this.routes.get(edge.to.routeId);
        if (!targetRoute?.traffic) continue;
        const hash = ((vehicle?.poolIndex ?? 0) * 2654435761 + Math.floor(d)) >>> 0;
        if ((hash % 1000) / 1000 >= edge.probability) continue;
        const overrun = Math.abs(s1 - d);
        const sample = this.sampleLane(targetRoute.id, edge.to.distance + overrun, 0, edge.to.direction);
        return this._trafficResult(sample, beforePosition, true);
      }
    }

    const result = this.advanceAlongRoute(
      { routeId: route.id, distance: s0, lane: laneIndex, direction },
      travel, laneIndex, direction, vehicle?.poolIndex ?? 0,
    );

    // Funnel down ahead of a narrower continuation so cars never ride a lane
    // that is about to disappear into the taper.
    const outRoute = this.routes.get(result.routeId);
    if (!result.transferred && outRoute && !outRoute.closed) {
      const endDistance = result.direction > 0 ? outRoute.length : 0;
      const distToEnd = Math.abs(endDistance - result.distance);
      if (distToEnd < 460) {
        const nexts = this._edgesFrom(outRoute.id, result.direction, endDistance, 60, ['continuation', 'merge']);
        if (nexts.length) {
          const minLanes = Math.min(...nexts.map((edge) => this.routes.get(edge.to.routeId).lanes));
          if (result.laneIndex >= minLanes) {
            const blended = this.sampleLane(outRoute.id, result.distance, minLanes - 1, result.direction);
            const t = 1 - clamp(distToEnd / 460, 0, 1);
            result.position.lerp(blended.position, t * t);
          }
        }
      }
    }
    return this._trafficResult(result, beforePosition, !!result.transferred);
  }

  _trafficResult(sample, beforePosition, transferred) {
    return {
      ...sample,
      s: sample.distance,
      laneRef: sample.laneRef,
      transferred,
      lateralJump: transferred ? beforePosition.distanceTo(sample.position) : 0,
      mapState: { routeId: sample.routeId, direction: sample.direction },
    };
  }

  // ------------------------------------------------------------------
  // Service area queries
  // ------------------------------------------------------------------

  getServiceAreaProximity(position, maxDistance = 250) {
    let best = null;
    for (const area of this.serviceAreas) {
      const delta = TMP_A.copy(position).sub(area.center);
      const longitudinal = delta.dot(area.tangent);
      const lateral = delta.dot(area.normal);
      const outsideLong = Math.max(Math.abs(longitudinal) - area.length * 0.5, 0);
      const outsideSide = Math.max(Math.abs(lateral) - area.width * 0.5, 0);
      const vertical = Math.max(Math.abs(position.y - area.elevation) - 5, 0);
      const edgeDistance = Math.hypot(outsideLong, outsideSide, vertical);
      const centerDistance = Math.hypot(longitudinal, lateral);
      if (!best || edgeDistance < best.distance) {
        const inside = outsideLong === 0 && outsideSide === 0 && vertical === 0;
        const garageDistance = area.garageEntrance
          ? Math.sqrt(xzDistanceSq(position, area.garageEntrance))
          : Infinity;
        const garageNearby = !!area.hasGarage && garageDistance <= 18 && Math.abs(position.y - area.elevation) < 8;
        const proximityArea = area.hasGarage
          ? { ...area, hasGarage: garageNearby, garage: garageNearby, garageDistance }
          : area;
        best = {
          id: area.id,
          name: area.name,
          area: proximityArea,
          service: proximityArea,
          position: area.center.clone(),
          distance: edgeDistance,
          centerDistance,
          longitudinal,
          lateral,
          inside,
          canBank: inside,
          canRefuel: inside,
          hasGarage: garageNearby,
          garage: garageNearby,
          garageDistance,
          garageEntrance: area.garageEntrance?.clone() || null,
          refuelPosition: area.refuelPosition.clone(),
        };
      }
    }
    return best && best.distance <= maxDistance ? best : null;
  }

  getServiceAreas() {
    return this.serviceAreas.map((area) => ({
      ...area,
      garage: !!area.hasGarage,
      radius: Math.min(area.width, area.length) * 0.5,
      triggerRadius: Math.min(area.width, area.length) * 0.5,
      center: area.center.clone(),
      position: area.center.clone(),
      tangent: area.tangent.clone(),
      normal: area.normal.clone(),
      entryPosition: area.entryPosition.clone(),
      exitPosition: area.exitPosition.clone(),
      refuelPosition: area.refuelPosition.clone(),
      garageEntrance: area.garageEntrance?.clone() || null,
    }));
  }

  isInServiceArea(position) {
    return this._lotAt(position, 0)?.area || null;
  }

  getGarageTransition(position, radius = 13) {
    const garage = this.serviceAreas.find((area) => area.hasGarage);
    if (!garage?.garageEntrance) return null;
    const horizontalDistance = Math.sqrt(xzDistanceSq(position, garage.garageEntrance));
    const verticalDistance = Math.abs(position.y - garage.garageEntrance.y);
    if (horizontalDistance > radius || verticalDistance > 8) return null;
    return {
      triggered: true,
      garageId: 'player_garage',
      serviceAreaId: garage.id,
      serviceArea: garage,
      position: garage.garageEntrance.clone(),
      distance: horizontalDistance,
      radius,
    };
  }

  checkGarageTransition(position, radius = 13) {
    return this.getGarageTransition(position, radius);
  }

  getGarageEntrance() {
    const area = this.serviceAreas.find((candidate) => candidate.hasGarage);
    return area ? {
      serviceAreaId: area.id,
      position: area.garageEntrance.clone(),
      tangent: area.normal.clone(),
      radius: 13,
    } : null;
  }

  // ------------------------------------------------------------------
  // Chunked geometry infrastructure
  // ------------------------------------------------------------------

  _chunkKey(x, z) {
    return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
  }

  _chunkFor(key) {
    if (!this._chunks.has(key)) {
      const [cx, cz] = key.split(',').map(Number);
      const group = new THREE.Group();
      group.name = `chunk ${key}`;
      group.visible = false;
      this.group.add(group);
      this._chunks.set(key, {
        key,
        group,
        center: vec((cx + 0.5) * CHUNK, 0, (cz + 0.5) * CHUNK),
        alwaysVisible: false,
      });
    }
    return this._chunks.get(key);
  }

  _bucket(position, materialName) {
    const key = this._chunkKey(position.x, position.z);
    if (!this._chunkBuckets.has(key)) this._chunkBuckets.set(key, new Map());
    const buckets = this._chunkBuckets.get(key);
    if (!buckets.has(materialName)) buckets.set(materialName, { positions: [], indices: [], uvs: [] });
    return buckets.get(materialName);
  }

  /** Push a quad a→b→c→d. Optional uv = [u0, v0, u1, v1]: a=(u0,v0), b=(u1,v0), c=(u1,v1), d=(u0,v1). */
  _pushQuad(bucket, a, b, c, d, uv = null) {
    const start = bucket.positions.length / 3;
    bucket.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    const [u0, v0, u1, v1] = uv || [0, 0, 1, 1];
    bucket.uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    bucket.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  _pushBox(bucket, center, size, quaternion = null) {
    const hx = size.x * 0.5;
    const hy = size.y * 0.5;
    const hz = size.z * 0.5;
    const corners = [
      vec(-hx, -hy, -hz), vec(hx, -hy, -hz), vec(hx, hy, -hz), vec(-hx, hy, -hz),
      vec(-hx, -hy, hz), vec(hx, -hy, hz), vec(hx, hy, hz), vec(-hx, hy, hz),
    ];
    for (const corner of corners) {
      if (quaternion) corner.applyQuaternion(quaternion);
      corner.add(center);
    }
    const faces = [
      [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3],
    ];
    for (const [a, b, c, d] of faces) this._pushQuad(bucket, corners[a], corners[b], corners[c], corners[d]);
  }

  _instance(position, scale, quaternion = null, color = null, type = 'box:concrete') {
    const key = this._chunkKey(position.x, position.z);
    if (!this._chunkInstances.has(key)) this._chunkInstances.set(key, new Map());
    const types = this._chunkInstances.get(key);
    if (!types.has(type)) types.set(type, []);
    types.get(type).push({
      position: position.clone(),
      scale: scale.clone(),
      quaternion: quaternion ? quaternion.clone() : null,
      color,
    });
  }

  _addChunkMesh(mesh, positionForChunk = null, alwaysVisible = false) {
    if (alwaysVisible) {
      this.group.add(mesh);
      return mesh;
    }
    const p = positionForChunk || mesh.position;
    const chunk = this._chunkFor(this._chunkKey(p.x, p.z));
    chunk.group.add(mesh);
    return mesh;
  }

  _finalizeChunks() {
    // merged buffer geometry per chunk per material
    for (const [key, buckets] of this._chunkBuckets) {
      const chunk = this._chunkFor(key);
      for (const [materialName, bucket] of buckets) {
        if (!bucket.positions.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
        if (bucket.uvs.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
        geometry.setIndex(bucket.indices.length > 65535 * 3 || bucket.positions.length / 3 > 65535
          ? new THREE.Uint32BufferAttribute(bucket.indices, 1)
          : new THREE.Uint16BufferAttribute(bucket.indices, 1));
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, this.materials[materialName] || this.materials.concrete);
        mesh.name = `chunk ${key} ${materialName}`;
        chunk.group.add(mesh);
      }
    }
    this._chunkBuckets.clear();

    // instanced meshes per chunk per type ("geometry:material")
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitPlane = new THREE.PlaneGeometry(1, 1);
    const unitPool = new THREE.PlaneGeometry(1, 1);
    unitPool.rotateX(-Math.PI * 0.5);
    this._unitGeometries = {
      box: unitBox, plane: unitPlane, pool: unitPool,
      lamppost: this._lampGeometry(), jetfan: this._jetFanGeometry(),
    };
    const identityQuat = new THREE.Quaternion();
    for (const [key, types] of this._chunkInstances) {
      const chunk = this._chunkFor(key);
      for (const [type, records] of types) {
        if (!records.length) continue;
        const [geoName, matName] = type.split(':');
        const material = this.materials[matName] || this.materials.concrete;
        const hasColors = records.some((record) => record.color !== null && record.color !== undefined);
        let instanceMaterial = material;
        if (hasColors) {
          instanceMaterial = material.clone();
          instanceMaterial.color.set(0xffffff);
          this._ownedTextures.add({ dispose: () => instanceMaterial.dispose() });
        }
        const mesh = new THREE.InstancedMesh(this._unitGeometries[geoName] || unitBox, instanceMaterial, records.length);
        mesh.name = `chunk ${key} ${type}`;
        records.forEach((record, index) => {
          TMP_MAT.compose(record.position, record.quaternion || identityQuat, record.scale);
          mesh.setMatrixAt(index, TMP_MAT);
          if (hasColors) mesh.setColorAt(index, new THREE.Color(record.color ?? material.color));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.frustumCulled = true;
        mesh.computeBoundingSphere?.();
        if (matName === 'redBlink') this.blinkers.push(mesh);
        if (this._effectTypes?.has(matName)) {
          this._effectMeshes.push(mesh);
          mesh.visible = this._quality !== 'low';
        }
        chunk.group.add(mesh);
      }
    }
    this._chunkInstances.clear();
  }

  // ------------------------------------------------------------------
  // World building
  // ------------------------------------------------------------------

  _buildWorld() {
    this._buildEnvironment();
    for (const route of this.routes.values()) {
      this._prepareRenderFrames(route);
      this._buildRouteGeometry(route);
      this._queueRouteDetails(route);
    }
    this._dressGores();
    this._buildBridge();
    this._buildSignage();
    this._buildServiceAreaDressing();
    this._buildCity();
    this._buildBackdrop();
    this._finalizeChunks();
  }

  _buildEnvironment() {
    // Water everywhere below sea level; land slabs (projected from real
    // Tokyo Bay geography by the extractor) raise the city floor.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const route of this.routes.values()) {
      for (const sample of route.samples) {
        minX = Math.min(minX, sample.point.x);
        maxX = Math.max(maxX, sample.point.x);
        minZ = Math.min(minZ, sample.point.z);
        maxZ = Math.max(maxZ, sample.point.z);
      }
    }
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(maxX - minX + 24000, maxZ - minZ + 24000, 1, 1),
      this.materials.water,
    );
    water.name = 'Tokyo Bay';
    water.rotation.x = -Math.PI * 0.5;
    water.position.set((minX + maxX) * 0.5, -0.9, (minZ + maxZ) * 0.5);
    this.group.add(water);

    for (const def of this._terrainSlabs) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(def.w, 1.0, def.d), this.materials.ground);
      mesh.position.set(def.x, -0.62, def.z);
      mesh.name = def.name;
      this.group.add(mesh);
    }

    if (this.options.addLighting !== false) {
      const hemisphere = new THREE.HemisphereLight(0x314167, 0x05050a, 0.72);
      hemisphere.name = 'Night ambient light';
      const moon = new THREE.DirectionalLight(0x7884a4, 0.26);
      moon.name = 'Cool city fill light';
      moon.position.set(-2, 6, -3);
      this.group.add(hemisphere, moon);
    }
  }

  /**
   * THE authoritative road frame at longitudinal distance `s`, evaluated
   * analytically from the route spline — the same `curve.getPointAt` /
   * `_bankAt` / `_halfWidthAt` primitives `getRoadInfo` samples for physics
   * (deck surface: y(s, l) = curveY(s) + tan(bank(s))·l along the horizontal
   * normal). Every piece of rendered road geometry must be built from these
   * frames so asphalt, markings and physics share one mathematical surface.
   * The frame is a function of `s` alone (yaw normal + bank roll): stable on
   * 3D curves and slopes, no parallel-transport drift, no flips on loops.
   */
  _frameAt(route, distance) {
    const normalized = this._normalizeDistance(route, distance);
    const u = route.length > 0 ? normalized / route.length : 0;
    const position = route.curve.getPointAt(u);
    const tangent = route.curve.getTangentAt(u).normalize();
    const normal = horizontalNormal(tangent);
    const bank = this._bankAt(route, normalized);
    // Banked lateral: the deck surface direction across the road (unit
    // horizontal displacement, matching _deckPoint), and the surface up.
    const lateral = vec(normal.x, Math.tan(bank), normal.z);
    const up = new THREE.Vector3().crossVectors(lateral, tangent);
    if (up.y < 0) up.multiplyScalar(-1);
    up.normalize();
    return {
      u,
      distance: normalized,
      position,
      tangent,
      normal,
      lateral,
      up,
      grade: tangent.y,
      half: this._halfWidthAt(route, normalized),
      laneWidth: route.laneWidth,
      lanes: route.lanes,
      bank,
      tunnel: this._isTunnel(route, normalized),
      bridge: this._isBridge(route, normalized),
    };
  }

  /**
   * Refine one frame span with quarter/midpoint analytic samples. `limits`
   * describes one consumer level; every accepted station still comes from
   * the single authoritative `_frameAt` sampler.
   */
  _refineFrameSpan(route, a, b, limits, frames, depth, knownMid = null) {
    const spanError = (a, b, samples) => {
      let vertical = 0;
      let lateral = 0;
      const startPoints = [-1, 0, 1].map((side) => this._deckPoint(a, side * a.half));
      const endPoints = [-1, 0, 1].map((side) => this._deckPoint(b, side * b.half));
      for (const sample of samples) {
        for (let track = 0; track < 3; track += 1) {
          const side = track - 1;
          const analytic = this._deckPoint(sample.frame, side * sample.frame.half);
          const chord = startPoints[track].clone().lerp(endPoints[track], sample.t);
          vertical = Math.max(vertical, Math.abs(analytic.y - chord.y));
          lateral = Math.max(lateral, Math.hypot(analytic.x - chord.x, analytic.z - chord.z));
        }
      }
      return { vertical, lateral };
    };
    const tangentAngle = (a, b) => Math.acos(clamp(a.tangent.dot(b.tangent), -1, 1));
    const span = b.distance - a.distance;
    if (depth <= 0 || span <= limits.minSegment * 2) return;
    const samples = [0.25, 0.5, 0.75].map((t) => {
      const distance = a.distance + span * t;
      const frame = t === 0.5 && knownMid ? knownMid : this._frameAt(route, distance);
      frame.distance = distance; // keep monotonic across a closed-route wrap
      return { t, frame };
    });
    const error = spanError(a, b, samples);
    const tangentSamples = [a, ...samples.map((sample) => sample.frame), b];
    let angle = tangentAngle(a, b);
    for (let i = 1; i < tangentSamples.length; i += 1) {
      angle = Math.max(angle, tangentAngle(tangentSamples[i - 1], tangentSamples[i]));
    }
    if (span <= limits.maxSegment
      && error.vertical <= limits.maxVertical
      && error.lateral <= limits.maxLateral
      && angle <= limits.maxTangentAngle) return;
    const mid = samples[1].frame;
    this._refineFrameSpan(route, a, mid, limits, frames, depth - 1, samples[0].frame);
    frames.push(mid);
    this._refineFrameSpan(route, mid, b, limits, frames, depth - 1, samples[2].frame);
  }

  /**
   * Build two render-station levels from the same `_frameAt` surface:
   *
   * - `renderFrames` preserves the measured coarse level for tunnel shells,
   *   collision metadata and other non-silhouette work;
   * - `surfaceFrames` is a dense superset for asphalt, fascia, paint and the
   *   complete visible road-edge/barrier silhouette.
   *
   * The dense level starts from the accepted coarse spans, reuses their
   * frame objects, and adds only the quarter/midpoint samples it needs.
   */
  _prepareRenderFrames(route) {
    const step = route.kind === 'service' ? 14 : (route.kind === 'ramp' ? 16 : (route.kind === 'loop' ? 24 : 30));
    const coarseLimits = {
      maxVertical: 0.035,
      maxLateral: 0.3,
      maxTangentAngle: THREE.MathUtils.degToRad(3),
      maxSegment: 24,
      minSegment: 1.5,
    };
    const surfaceLimits = {
      maxVertical: 0.03,
      maxLateral: 0.06,
      maxTangentAngle: THREE.MathUtils.degToRad(0.75),
      maxSegment: 8,
      minSegment: 1.5,
    };
    const frames = route.renderFrames;
    frames.length = 0;
    const segmentCount = Math.max(3, Math.ceil(route.length / step));
    let previous = null;
    for (let i = 0; i <= segmentCount; i += 1) {
      const distance = route.length * i / segmentCount;
      const isWrap = route.closed && i === segmentCount;
      const frame = this._frameAt(route, isWrap ? 0 : distance);
      if (isWrap) frame.distance = route.length;
      if (previous) this._refineFrameSpan(route, previous, frame, coarseLimits, frames, 7);
      if (!isWrap && i < segmentCount + (route.closed ? 0 : 1)) frames.push(frame);
      previous = frame;
    }

    const surfaceFrames = route.surfaceFrames;
    surfaceFrames.length = 0;
    const count = route.closed ? frames.length : frames.length - 1;
    for (let i = 0; i < count; i += 1) {
      const a = frames[i];
      let b = frames[(i + 1) % frames.length];
      if (route.closed && i === frames.length - 1) {
        b = this._frameAt(route, 0);
        b.distance = route.length;
      }
      surfaceFrames.push(a);
      this._refineFrameSpan(route, a, b, surfaceLimits, surfaceFrames, 7);
    }
    if (!route.closed && frames.length) surfaceFrames.push(frames[frames.length - 1]);
  }

  _forEachFrameSegment(route, callback, frames = route.renderFrames) {
    const count = route.closed ? frames.length : frames.length - 1;
    for (let i = 0; i < count; i += 1) callback(frames[i], frames[(i + 1) % frames.length], i);
  }

  _forEachSurfaceFrameSegment(route, callback) {
    this._forEachFrameSegment(route, callback, route.surfaceFrames);
  }

  /** Deck edge point with banking applied. lateral along the base normal. */
  _deckPoint(frame, lateral, lift = 0) {
    const point = frame.position.clone().addScaledVector(frame.normal, lateral);
    point.y += Math.tan(frame.bank) * lateral + lift;
    return point;
  }

  /**
   * Paint a longitudinal stripe [sStart, sEnd] onto the deck as merged quads.
   * The stripe walks the route's surface frames and interpolates the SAME
   * corner points the deck triangles interpolate, so paint sits in the drawn
   * surface's own planes — it bends with curves, pitches with grades and
   * rolls with banking, and can never float off the asphalt.
   * `lateralAt(frame)` gives the stripe centre along the base normal at a
   * station (so edge lines follow width tapers). Stations where the deck has
   * no room for the stripe (taper throats) are skipped.
   */
  _paintStrip(route, materialName, sStart, sEnd, lateralAt, width, lift = 0.055) {
    const frames = route.surfaceFrames;
    const count = route.closed ? frames.length : frames.length - 1;
    const halfWidth = width * 0.5;
    for (let i = 0; i < count; i += 1) {
      const a = frames[i];
      const b = frames[(i + 1) % frames.length];
      const segStart = a.distance;
      const segEnd = route.closed && i === frames.length - 1 ? route.length : b.distance;
      const lo = Math.max(sStart, segStart);
      const hi = Math.min(sEnd, segEnd);
      if (hi - lo < 0.05) continue;
      const la = lateralAt(a);
      const lb = lateralAt(b);
      if (la === null || lb === null) continue;
      const span = Math.max(segEnd - segStart, EPSILON);
      let t0 = (lo - segStart) / span;
      let t1 = (hi - segStart) / span;
      // A lane boundary can enter/leave the paved deck during a width taper.
      // Clip at that exact crossing instead of discarding this entire render
      // span merely because one endpoint is too narrow.
      const clearanceA = a.half - 0.3 - halfWidth - Math.abs(la);
      const clearanceB = b.half - 0.3 - halfWidth - Math.abs(lb);
      if (clearanceA < 0 && clearanceB < 0) continue;
      if ((clearanceA < 0) !== (clearanceB < 0)) {
        const crossing = clamp(clearanceA / (clearanceA - clearanceB), 0, 1);
        if (clearanceA < 0) t0 = Math.max(t0, crossing);
        else t1 = Math.min(t1, crossing);
      }
      if (t1 - t0 < 1e-4) continue;
      const innerA = this._deckPoint(a, la - halfWidth, lift);
      const outerA = this._deckPoint(a, la + halfWidth, lift);
      const innerB = this._deckPoint(b, lb - halfWidth, lift);
      const outerB = this._deckPoint(b, lb + halfWidth, lift);
      const inner0 = innerA.clone().lerp(innerB, t0);
      const outer0 = outerA.clone().lerp(outerB, t0);
      const inner1 = innerA.lerp(innerB, t1);
      const outer1 = outerA.lerp(outerB, t1);
      const bucket = this._bucket(TMP_A.copy(inner0).lerp(outer1, 0.5), materialName);
      this._pushQuad(bucket, outer0, outer1, inner1, inner0); // up-facing, like the deck
    }
  }

  /** Paint dashes from one route-absolute phase; frames/chunks never reset it. */
  _paintDashedStrip(route, materialName, lateralAt, width, period, dashLength, phase = 0) {
    const first = Math.ceil((-dashLength * 0.5 - phase) / period);
    const last = Math.floor((route.length + dashLength * 0.5 - phase) / period);
    for (let index = first; index <= last; index += 1) {
      const center = phase + index * period;
      this._paintStrip(route, materialName,
        Math.max(0, center - dashLength * 0.5),
        Math.min(route.length, center + dashLength * 0.5),
        lateralAt, width);
    }
  }

  /**
   * True when an outer-barrier element at `point` would sit on ANOTHER
   * carriageway's drivable surface or double up its rail — i.e. exactly the
   * gore mouths, merge throats and PA gates where rails used to criss-cross.
   * Ramps/service lanes yield to mainlines where the corridors coincide.
   * Purely visual: collision (the corridor union) is untouched.
   */
  _barrierSuppressed(point, route) {
    const yields = route.kind === 'ramp' || route.kind === 'service';
    const candidates = this._candidateRoutes(point);
    for (const { route: other, index } of candidates.values()) {
      if (other === route) continue;
      const projection = this._projectToRoute(other, point, index);
      if (projection.endOvershoot > 2) continue; // beyond the other surface's end
      const half = this._halfWidthAt(other, projection.distance);
      const abs = Math.abs(projection.signedLateral);
      const deckY = projection.point.y + Math.tan(this._bankAt(other, projection.distance)) * projection.signedLateral;
      if (Math.abs(point.y - deckY) > 4) continue;
      if (abs < half - 0.2) return true;
      if (yields && other.kind !== 'ramp' && other.kind !== 'service' && abs < half + 1.2) return true;
    }
    if (this._lotAt(point, 1.5)) return true;
    return false;
  }

  _buildRouteGeometry(route) {
    const roadMaterialName = route.kind === 'service' ? 'roadService'
      : (this.routeOrder.indexOf(route.id) % 2 ? 'roadAlt' : 'road');
    const barrierHeight = route.kind === 'service' ? 0.9 : 1.15;
    const medianHeight = 1.0;

    // Surface frames can sit ~1.5 m apart; suppression zones (gore mouths, PA
    // gates) span tens of metres, so re-probe _barrierSuppressed only every
    // ~9 m per side — finer than the old 16-30 m step, at a fraction of the
    // projections.
    const suppressionCache = { 1: null, [-1]: null };
    const barrierSuppressedNear = (probe, side) => {
      const cached = suppressionCache[side];
      if (cached && xzDistanceSq(cached.point, probe) < 9 * 9) return cached.result;
      const result = this._barrierSuppressed(probe, route);
      suppressionCache[side] = { point: probe.clone(), result };
      return result;
    };

    this._forEachSurfaceFrameSegment(route, (a, b) => {
      // fresh vector: _barrierSuppressed re-uses the TMP registers mid-loop
      const mid = a.position.clone().lerp(b.position, 0.5);
      const bucketRoad = this._bucket(mid, roadMaterialName);
      const leftA = this._deckPoint(a, a.half);
      const leftB = this._deckPoint(b, b.half);
      const rightA = this._deckPoint(a, -a.half);
      const rightB = this._deckPoint(b, -b.half);
      // Deck top, wound UP-facing. It was wound the other way for years: the
      // single-sided road material culled the real deck from above and the
      // game was actually showing the fascia UNDERSIDE 0.5-1.35 m below the
      // physics surface — the reported "glass floor over a sunken road".
      this._pushQuad(bucketRoad, leftA, leftB, rightB, rightA);

      // fascia (deck sides) for elevated sections — outward faces
      const elevated = a.position.y > 2.5 && !a.tunnel;
      const fasciaDepth = elevated ? 1.35 : 0.5;
      const bucketFascia = this._bucket(mid, 'concreteDark');
      const dropLA = leftA.clone(); dropLA.y -= fasciaDepth;
      const dropLB = leftB.clone(); dropLB.y -= fasciaDepth;
      const dropRA = rightA.clone(); dropRA.y -= fasciaDepth;
      const dropRB = rightB.clone(); dropRB.y -= fasciaDepth;
      this._pushQuad(bucketFascia, dropLA, dropLB, leftB, leftA);
      this._pushQuad(bucketFascia, rightA, rightB, dropRB, dropRA);

      // Outer barriers — capped concrete parapet + steel handrail,
      // PS2-highway style. Every metre of the
      // network keeps its wallSegments record (collision metadata identical);
      // only the VISUAL is omitted where a segment would criss-cross another
      // carriageway at a gore mouth or PA gate.
      const bucketBarrier = this._bucket(mid, 'barrier');
      const bucketRail = this._bucket(mid, 'railMetal');
      for (const side of [1, -1]) {
        const baseA = this._deckPoint(a, side * (a.half - 0.42), 0.02);
        const baseB = this._deckPoint(b, side * (b.half - 0.42), 0.02);
        const probe = TMP_B.copy(baseA).lerp(baseB, 0.5);
        if (barrierSuppressedNear(probe, side)) continue;
        const lean = 0.85;
        const innerTopA = this._deckPoint(a, side * (a.half - 0.3), lean);
        const innerTopB = this._deckPoint(b, side * (b.half - 0.3), lean);
        const capA = this._deckPoint(a, side * (a.half - 0.06), lean + 0.06);
        const capB = this._deckPoint(b, side * (b.half - 0.06), lean + 0.06);
        const outA = this._deckPoint(a, side * a.half, 0.0);
        const outB = this._deckPoint(b, side * b.half, 0.0);
        // `barrier` is DoubleSide: cap + outer wall preserve the same deck-edge
        // silhouette from chase and exterior views without storing a third,
        // hidden inner-profile sheet at every dense surface station.
        if (side > 0) {
          this._pushQuad(bucketBarrier, innerTopA, innerTopB, capB, capA);
          this._pushQuad(bucketBarrier, capB, outB, outA, capA);
        } else {
          this._pushQuad(bucketBarrier, innerTopB, innerTopA, capA, capB);
          this._pushQuad(bucketBarrier, capA, outA, outB, capB);
        }
        // steel handrail on top of the parapet (skipped inside tunnels)
        if (!a.tunnel) {
          const railA = this._deckPoint(a, side * (a.half - 0.18), 1.12);
          const railB = this._deckPoint(b, side * (b.half - 0.18), 1.12);
          const railTopA = railA.clone(); railTopA.y += 0.09;
          const railTopB = railB.clone(); railTopB.y += 0.09;
          if (side > 0) this._pushQuad(bucketRail, railA, railB, railTopB, railTopA);
          else this._pushQuad(bucketRail, railB, railA, railTopA, railTopB);
        }
      }

      // Median barrier — proper jersey profile: wide base, sloped waist,
      // tapered neck, narrow cap.
      if (route.bidirectional) {
        const bucketMedian = this._bucket(mid, 'concrete');
        const profile = [[0.36, 0.02], [0.3, 0.3], [0.11, 0.92]];
        for (const side of [1, -1]) {
          for (let i = 0; i < profile.length - 1; i += 1) {
            const [w0, h0] = profile[i];
            const [w1, h1] = profile[i + 1];
            const lowA = this._deckPoint(a, side * w0, h0);
            const lowB = this._deckPoint(b, side * w0, h0);
            const highA = this._deckPoint(a, side * w1, h1);
            const highB = this._deckPoint(b, side * w1, h1);
            if (side > 0) this._pushQuad(bucketMedian, lowA, lowB, highB, highA);
            else this._pushQuad(bucketMedian, lowB, lowA, highA, highB);
          }
        }
        const [wTop, hTop] = profile[profile.length - 1];
        const capLA = this._deckPoint(a, wTop, hTop + 0.04);
        const capLB = this._deckPoint(b, wTop, hTop + 0.04);
        const capRA = this._deckPoint(a, -wTop, hTop + 0.04);
        const capRB = this._deckPoint(b, -wTop, hTop + 0.04);
        this._pushQuad(bucketMedian, capLA, capLB, capRB, capRA);
      }
    });

    // Collision metadata and the enclosed tunnel shell do not define the
    // open-road silhouette, so they retain the coarser render level. The
    // collision corridor itself remains analytic and is not changed here.
    this._forEachFrameSegment(route, (a, b) => {
      const mid = a.position.clone().lerp(b.position, 0.5);
      const elevated = a.position.y > 2.5 && !a.tunnel;
      if (elevated) {
        const fasciaDepth = 1.35;
        const dropLA = this._deckPoint(a, a.half); dropLA.y -= fasciaDepth;
        const dropLB = this._deckPoint(b, b.half); dropLB.y -= fasciaDepth;
        const dropRA = this._deckPoint(a, -a.half); dropRA.y -= fasciaDepth;
        const dropRB = this._deckPoint(b, -b.half); dropRB.y -= fasciaDepth;
        this._pushQuad(this._bucket(mid, 'concreteDark'), dropRA, dropRB, dropLB, dropLA);
      }
      for (const side of [1, -1]) {
        this.wallSegments.push({
          routeId: route.id, type: 'outer', side,
          start: this._deckPoint(a, side * (a.half - 0.42), 0.02),
          end: this._deckPoint(b, side * (b.half - 0.42), 0.02),
          height: barrierHeight,
          distanceStart: a.distance, distanceEnd: b.distance,
        });
      }
      if (route.bidirectional) {
        this.wallSegments.push({
          routeId: route.id, type: 'median', side: 0,
          start: this._deckPoint(a, 0.36, 0.02), end: this._deckPoint(b, 0.36, 0.02), height: medianHeight,
          distanceStart: a.distance, distanceEnd: b.distance,
        });
      }
      if (a.tunnel && b.tunnel) {
        const bucketTunnel = this._bucket(mid, 'tunnelWall');
        const height = 6.1;
        const wallLA = this._deckPoint(a, a.half + 0.4);
        const wallLB = this._deckPoint(b, b.half + 0.4);
        const wallRA = this._deckPoint(a, -a.half - 0.4);
        const wallRB = this._deckPoint(b, -b.half - 0.4);
        const roofLA = wallLA.clone(); roofLA.y += height;
        const roofLB = wallLB.clone(); roofLB.y += height;
        const roofRA = wallRA.clone(); roofRA.y += height;
        const roofRB = wallRB.clone(); roofRB.y += height;
        this._pushQuad(bucketTunnel, wallLA, wallLB, roofLB, roofLA);
        this._pushQuad(bucketTunnel, roofRA, roofRB, wallRB, wallRA);
        this._pushQuad(bucketTunnel, roofLA, roofLB, roofRB, roofRA);
      }
    });

    // dead-end cap + crash cushions
    if (route.deadEnd) {
      this._buildDeadEnd(route);
    }
  }

  _buildDeadEnd(route) {
    {
      const endFrame = route.surfaceFrames[route.surfaceFrames.length - 1];
      const bucket = this._bucket(endFrame.position, 'barrier');
      const left = this._deckPoint(endFrame, endFrame.half);
      const right = this._deckPoint(endFrame, -endFrame.half);
      const leftTop = left.clone(); leftTop.y += 2.4;
      const rightTop = right.clone(); rightTop.y += 2.4;
      this._pushQuad(bucket, left, right, rightTop, leftTop);
      this._pushQuad(bucket, right, left, leftTop, rightTop);
      const quaternion = yawQuaternion(endFrame.tangent);
      for (const lateral of [-1.4, 0, 1.4]) {
        const cushion = this._deckPoint(endFrame, lateral);
        cushion.addScaledVector(endFrame.tangent, -1.6);
        cushion.y += 0.6;
        this._instance(cushion, vec(1.25, 1.2, 1.1), quaternion, null, 'box:cushion');
      }
      const sign = this._makeSignMesh('通行止|ROAD CLOSED', '#8a1a1a', 5.2, 2.2);
      const signPos = this._deckPoint(endFrame, 0);
      signPos.addScaledVector(endFrame.tangent, -3.2);
      signPos.y += 3.4;
      sign.position.copy(signPos);
      sign.quaternion.copy(yawQuaternion(endFrame.tangent.clone().multiplyScalar(-1)));
      this._addChunkMesh(sign, signPos);
    }
  }

  /**
   * Junction gore dressing. For every diverge/merge between a mainline and a
   * ramp: find the physical split point (where the two paved edges separate),
   * paint the chevron wedge between the mouth and the split, and terminate
   * the barrier V with a yellow/black crash cushion.
   */
  _dressGores() {
    for (const edge of this.edges) {
      if (edge.kind !== 'diverge' && edge.kind !== 'merge') continue;
      const rampRef = edge.kind === 'diverge' ? edge.to : edge.from;
      const mainRef = edge.kind === 'diverge' ? edge.from : edge.to;
      const ramp = this.routes.get(rampRef.routeId);
      const main = this.routes.get(mainRef.routeId);
      if (!ramp || !main || ramp === main) continue;
      if (ramp.kind !== 'ramp' && ramp.kind !== 'service') continue;
      const fromStart = edge.kind === 'diverge';

      // walk the ramp away from the shared mouth until the paved edges split
      let tip = null;
      const stripes = [];
      for (let s = 24; s <= Math.min(320, ramp.length - 6); s += 9) {
        const rampDist = fromStart ? s : ramp.length - s;
        if (rampDist < 2 || rampDist > ramp.length - 2) break;
        const sample = this._sampleCenter(ramp, rampDist, 1);
        const projection = this._projectToRoute(main, sample.position);
        if (Math.abs(sample.position.y - projection.point.y) > 5) break;
        const halfMain = this._halfWidthAt(main, projection.distance);
        const gap = Math.abs(projection.signedLateral) + ramp.halfWidth - halfMain;
        const sideSign = projection.signedLateral >= 0 ? 1 : -1;
        const mainEdge = projection.point.clone().addScaledVector(projection.normal, sideSign * (halfMain - 0.55));
        const toMain = projection.point.clone().sub(sample.position).setY(0);
        if (toMain.lengthSq() < EPSILON) toMain.copy(projection.normal).multiplyScalar(-sideSign);
        toMain.normalize();
        const rampEdge = sample.position.clone().addScaledVector(toMain, ramp.halfWidth - 0.55);
        const wedge = mainEdge.clone().lerp(rampEdge, 0.5);
        const wedgeWidth = mainEdge.distanceTo(rampEdge);
        if (gap > 1.2) {
          tip = { wedge, tangent: sample.tangent.clone() };
          break;
        }
        if (wedgeWidth > 1.1) stripes.push({ wedge, tangent: sample.tangent.clone(), width: wedgeWidth });
      }

      // chevron paint across the wedge
      let flip = 1;
      for (const stripe of stripes) {
        const position = stripe.wedge.clone();
        position.y += 0.06;
        const skew = new THREE.Quaternion().setFromAxisAngle(UP, flip * 0.62);
        flip *= -1;
        const quaternion = yawQuaternion(stripe.tangent).multiply(skew);
        this._instance(position, vec(0.3, 0.025, Math.min(4.2, stripe.width * 1.15)), quaternion, null, 'box:marking');
      }

      // crash cushion at the barrier split
      if (tip) {
        const quaternion = yawQuaternion(tip.tangent);
        const base = tip.wedge.clone();
        base.y += 0.55;
        this._instance(base, vec(1.15, 1.05, 1.7), quaternion, null, 'box:cushion');
        const stripe = base.clone();
        stripe.y += 0.12;
        this._instance(stripe, vec(1.2, 0.3, 1.75), quaternion, 0x16171b, 'box:parkedBody');
        const marker = base.clone();
        marker.y += 0.95;
        this._instance(marker, vec(0.5, 0.55, 0.35), quaternion, 0xffd24a, 'box:reflector');
      }
    }
  }

  // ------------------------------------------------------------------
  // Route dressing (instanced details)
  // ------------------------------------------------------------------

  _queueRouteDetails(route) {
    const isService = route.kind === 'service';
    const isRamp = route.kind === 'ramp';

    // Lane divider dashes + solid edge lines + median amber lines — all
    // painted onto the deck through _paintStrip so they share the road's
    // authoritative frame (see _frameAt) instead of floating as world-
    // horizontal boxes.
    const dashStep = isService ? 26 : 15;
    const dashLength = 6.2;
    const dividerOffsets = [];
    if (route.bidirectional) {
      for (let lane = 1; lane < route.lanes; lane += 1) {
        const boundary = route.medianWidth * 0.5 + lane * route.laneWidth;
        dividerOffsets.push(boundary, -boundary);
      }
    } else {
      for (let lane = 1; lane < route.lanes; lane += 1) dividerOffsets.push((lane - route.lanes * 0.5) * route.laneWidth);
    }
    for (const offset of dividerOffsets) {
      this._paintDashedStrip(route, 'marking', () => offset, 0.14, dashStep, dashLength, 6);
    }
    for (const side of [1, -1]) {
      this._paintStrip(route, 'marking', 0, route.length,
        (frame) => side * (frame.half - 0.75), 0.16);
      if (route.bidirectional) {
        this._paintStrip(route, 'amber', 0, route.length,
          () => side * (route.medianWidth * 0.5 + 0.28), 0.13);
      }
    }

    // Support pillars for elevated decks (every ~30 m per blueprint).
    if (!isService) {
      const pillarStep = 32;
      for (let distance = pillarStep * 0.5; distance < route.length; distance += pillarStep) {
        const center = this._sampleCenter(route, distance, 1);
        if (center.position.y < 3.5 || this._isTunnel(route, distance)) continue;
        if (this._isBridge(route, distance)) continue;
        // Never stab a pillar through a lower carriageway at a grade-separated
        // crossing — those spans borrow the neighbours' pillars.
        let piercesDeck = false;
        for (const { route: other, index } of this._candidateRoutes(center.position).values()) {
          if (other === route) continue;
          const projection = this._projectToRoute(other, center.position, index);
          if (Math.abs(projection.signedLateral) < this._halfWidthAt(other, projection.distance) + 1.6
            && projection.point.y < center.position.y - 2.5) { piercesDeck = true; break; }
        }
        if (piercesDeck) continue;
        const height = center.position.y - 1.1;
        const position = center.position.clone();
        position.y = height * 0.5 - 0.4;
        const girth = route.lanes >= 3 ? 2.5 : 1.9;
        this._instance(position, vec(girth, height + 0.8, girth * 0.82), yawQuaternion(center.baseTangent), null, 'box:concreteDark');
        // cross-head under the deck
        const head = center.position.clone();
        head.y -= 1.35;
        this._instance(head, vec(this._halfWidthAt(route, distance) * 1.7, 0.9, 2.2), yawQuaternion(center.baseTangent), null, 'box:concreteDark');
      }
    }

    // Sodium lampposts: tapered pole + curved arm + luminaire (one merged
    // instanced geometry), an emissive lens, an additive light pool on the
    // asphalt and a stretched wet-reflection streak (hidden on Low quality).
    const lampStep = isService ? 55 : (isRamp ? 70 : 42);
    const halfTurn = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
    let lampSide = 1;
    for (let distance = lampStep * 0.4; distance < route.length; distance += lampStep) {
      const center = this._sampleCenter(route, distance, 1);
      const half = this._halfWidthAt(route, distance);
      if (this._isTunnel(route, distance)) continue;
      const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
      const side = route.bidirectional ? (lampSide *= -1) : 1;
      const base = this._deckPoint(frame, side * (half - 0.62), 0.01);
      if (this._barrierSuppressed(base, route)) continue;
      // local +X of the lamp geometry maps to -normal under yawQuaternion;
      // mirror with a half turn for the other edge so the arm reaches the road
      const quaternion = yawQuaternion(center.baseTangent);
      if (side < 0) quaternion.multiply(halfTurn);
      this._instance(base, vec(1, 1, 1), quaternion, null, 'lamppost:concrete');
      const lens = base.clone().addScaledVector(frame.normal, -side * 2.28);
      lens.y = base.y + 9.26;
      this._instance(lens, vec(1.1, 0.1, 0.34), quaternion, null, 'box:lampSodium');
      const pool = this._deckPoint(frame, side * (half - 3.6), 0.07);
      this._instance(pool, vec(11, 1, 15.5), yawQuaternion(center.baseTangent), null, 'pool:lightPool');
      const streak = this._deckPoint(frame, side * (half - 3.2), 0.1);
      this._instance(streak, vec(1.1, 1, 30), yawQuaternion(center.baseTangent), null, 'pool:lightStreak');
    }

    // Emergency phone boxes on elevated open sections (green beacon + cabinet).
    if (!isService && !isRamp) {
      for (let distance = 240; distance < route.length; distance += 430) {
        if (this._isTunnel(route, distance) || this._isBridge(route, distance)) continue;
        const center = this._sampleCenter(route, distance, 1);
        const half = this._halfWidthAt(route, distance);
        const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
        const base = this._deckPoint(frame, half - 1.05, 0.02);
        if (this._barrierSuppressed(base, route)) continue;
        const quaternion = yawQuaternion(center.baseTangent);
        const cabinet = base.clone(); cabinet.y += 0.62;
        this._instance(cabinet, vec(0.56, 1.24, 0.5), quaternion, 0x2c3440, 'box:parkedBody');
        const beacon = base.clone(); beacon.y += 1.44;
        this._instance(beacon, vec(0.34, 0.34, 0.34), quaternion, null, 'box:exitGreen');
      }
    }

    // Barrier reflectors.
    if (!isService) {
      for (let distance = 18; distance < route.length; distance += 38) {
        const center = this._sampleCenter(route, distance, 1);
        const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
        const quaternion = yawQuaternion(center.baseTangent);
        const half = this._halfWidthAt(route, distance);
        for (const side of [-1, 1]) {
          const position = this._deckPoint(frame, side * (half - 0.18), 0.97);
          if (this._barrierSuppressed(position, route)) continue;
          this._instance(position, vec(0.12, 0.13, 0.3), quaternion, side > 0 ? 0xffb45b : 0xe7efff, 'box:reflector');
        }
      }
    }

    // Tunnel interiors: wall panels, ceiling light strips, jet fans,
    // emergency exits, cabinets, portals.
    for (const tunnel of route.tunnels) {
      const style = tunnel.style === 'orange' ? 'tunnelLampOrange' : 'tunnelLampWhite';
      const lightStep = 17;
      for (let distance = tunnel.startDistance + 8; distance < tunnel.endDistance; distance += lightStep) {
        const center = this._sampleCenter(route, distance, 1);
        const quaternion = yawQuaternion(center.baseTangent);
        const half = this._halfWidthAt(route, distance);
        for (const side of route.bidirectional ? [-half * 0.5 - route.medianWidth * 0.25, half * 0.5 + route.medianWidth * 0.25] : [0]) {
          const position = center.position.clone().addScaledVector(horizontalNormal(center.baseTangent), side);
          position.y += 5.7;
          this._instance(position, vec(0.55, 0.1, 2.6), quaternion, null, `box:${style}`);
        }
        // wall panels
        for (const side of [1, -1]) {
          const panel = center.position.clone().addScaledVector(horizontalNormal(center.baseTangent), side * (half + 0.18));
          panel.y += 2.1;
          this._instance(panel, vec(0.14, 2.6, lightStep - 0.9), quaternion, 0x3d444d, 'box:concrete');
        }
      }
      // ceiling ribs give the shell its segmented interior
      for (let distance = tunnel.startDistance + 17; distance < tunnel.endDistance; distance += 34) {
        const center = this._sampleCenter(route, distance, 1);
        const quaternion = yawQuaternion(center.baseTangent);
        const half = this._halfWidthAt(route, distance);
        const rib = center.position.clone();
        rib.y += 5.98;
        this._instance(rib, vec(half * 2 + 0.8, 0.22, 0.42), quaternion, null, 'box:portal');
      }
      // paired cylindrical jet fans
      for (let distance = tunnel.startDistance + 90; distance < tunnel.endDistance - 60; distance += 150) {
        const center = this._sampleCenter(route, distance, 1);
        const quaternion = yawQuaternion(center.baseTangent);
        const fan = center.position.clone();
        fan.y += 5.05;
        this._instance(fan, vec(1, 1, 1), quaternion, null, 'jetfan:railMetal');
      }
      for (let distance = tunnel.startDistance + 150; distance < tunnel.endDistance - 100; distance += 300) {
        const center = this._sampleCenter(route, distance, 1);
        const quaternion = yawQuaternion(center.baseTangent);
        const half = this._halfWidthAt(route, distance);
        const normal = horizontalNormal(center.baseTangent);
        // emergency exit: glowing green sign + door + cabinet
        const door = center.position.clone().addScaledVector(normal, half + 0.1);
        door.y += 1.25;
        this._instance(door, vec(0.22, 2.5, 1.7), quaternion, 0x39514a, 'box:concrete');
        const sign = center.position.clone().addScaledVector(normal, half - 0.35);
        sign.y += 3.3;
        this._instance(sign, vec(0.16, 0.62, 1.5), quaternion, null, 'box:exitGreen');
        const cabinet = center.position.clone().addScaledVector(normal, -(half + 0.05));
        cabinet.y += 0.95;
        this._instance(cabinet, vec(0.5, 1.9, 1.2), quaternion, 0x49525e, 'box:concrete');
      }
      // portals: header, flared wing walls, name board on both approaches
      for (const endDistance of [tunnel.startDistance, tunnel.endDistance]) {
        const center = this._sampleCenter(route, endDistance, 1);
        const quaternion = yawQuaternion(center.baseTangent);
        const normal = horizontalNormal(center.baseTangent);
        const half = this._halfWidthAt(route, endDistance) + 0.6;
        const beam = center.position.clone();
        beam.y += 7.0;
        this._instance(beam, vec(half * 2 + 3.4, 2.2, 3.0), quaternion, null, 'box:portal');
        for (const side of [1, -1]) {
          const post = center.position.clone().addScaledVector(normal, side * (half + 0.6));
          post.y += 3.0;
          this._instance(post, vec(1.5, 6.6, 3.0), quaternion, null, 'box:portal');
          const flare = new THREE.Quaternion().setFromAxisAngle(UP, side * -0.5);
          const wing = center.position.clone()
            .addScaledVector(normal, side * (half + 3.1))
            .addScaledVector(center.baseTangent, endDistance === tunnel.startDistance ? -1.7 : 1.7);
          wing.y += 2.4;
          this._instance(wing, vec(0.9, 5.4, 5.6), quaternion.clone().multiply(flare), null, 'box:portal');
        }
        if (typeof document !== 'undefined') {
          const outward = endDistance === tunnel.startDistance ? -1 : 1;
          const board = this._makeSignMesh(`${tunnel.name}|SHUTO EXPWY`, '#0b5142', 6.4, 1.7, true);
          const boardPos = center.position.clone().addScaledVector(center.baseTangent, outward * 1.6);
          boardPos.y += 7.05;
          board.position.copy(boardPos);
          board.quaternion.copy(yawQuaternion(TMP_C.copy(center.baseTangent).multiplyScalar(outward)));
          this._addChunkMesh(board, boardPos);
        }
      }
    }

    // Curve warning chevron boards on the outside of every bend, one facing
    // each travel direction (the mirrored back arrow is correct for the
    // opposite carriageway's turn), on short posts above the parapet.
    if (!isService && !isRamp) {
      for (let distance = 60; distance < route.length; distance += 45) {
        const bank = this._bankAt(route, distance);
        if (Math.abs(bank) < 0.052 || this._isTunnel(route, distance)) continue;
        const center = this._sampleCenter(route, distance, 1);
        const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank };
        const half = this._halfWidthAt(route, distance);
        const side = bank > 0 ? -1 : 1;
        const position = this._deckPoint(frame, side * (half - 0.3), 2.05);
        if (this._barrierSuppressed(position, route)) continue;
        for (const facing of [1, -1]) {
          const board = position.clone().addScaledVector(center.baseTangent, facing * -0.04);
          this._instance(board, vec(1.55, 1.05, 1), yawQuaternion(TMP_C.copy(center.baseTangent).multiplyScalar(facing)), null, 'plane:chevron');
        }
        const pole = this._deckPoint(frame, side * (half - 0.3), 1.15);
        this._instance(pole, vec(0.12, 0.85, 0.12), null, null, 'box:concrete');
      }
    }
  }

  // ------------------------------------------------------------------
  // Signage
  // ------------------------------------------------------------------

  _roundRectPath(context, x, y, w, h, r) {
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + w, y, x + w, y + h, r);
    context.arcTo(x + w, y + h, x, y + h, r);
    context.arcTo(x, y + h, x, y, r);
    context.arcTo(x, y, x + w, y, r);
    context.closePath();
  }

  /**
   * PS2-clean sign face: rounded backlit board, crisp border, big kanji +
   * romaji, optional route shield and per-lane down arrows.
   */
  _signCanvas(lines, background, width, height, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    // dark frame, rounded board, crisp inset border
    context.fillStyle = '#22262c';
    context.fillRect(0, 0, width, height);
    const radius = Math.round(height * 0.07);
    this._roundRectPath(context, 3, 3, width - 6, height - 6, radius);
    context.fillStyle = background;
    context.fill();
    this._roundRectPath(context, 10, 10, width - 20, height - 20, Math.max(2, Math.round(radius * 0.7)));
    context.strokeStyle = 'rgba(238,243,232,0.95)';
    context.lineWidth = Math.max(2, Math.round(height * 0.028));
    context.stroke();

    let textCenterX = width * 0.5;
    const arrowBand = opts.arrows ? height * 0.22 : 0;
    if (opts.shield) {
      const shieldW = height * 0.42;
      const shieldX = 20 + shieldW * 0.5;
      const shieldY = height * 0.3;
      this._roundRectPath(context, shieldX - shieldW * 0.5, shieldY - shieldW * 0.36, shieldW, shieldW * 0.72, shieldW * 0.16);
      context.fillStyle = 'rgba(8,28,22,0.9)';
      context.fill();
      context.strokeStyle = '#e7ecdf';
      context.lineWidth = Math.max(2, Math.round(height * 0.02));
      context.stroke();
      context.fillStyle = '#f2f5e9';
      context.font = `bold ${Math.round(shieldW * 0.4)}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(opts.shield), shieldX, shieldY);
      textCenterX = width * 0.5 + shieldW * 0.3;
    }
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const rows = lines.length;
    const textHeight = height - arrowBand;
    lines.forEach((line, index) => {
      const y = textHeight * (index + 0.62) / (rows + 0.25);
      context.fillStyle = line.color || '#f0f3e5';
      const size = index === 0 ? textHeight / (rows + 0.55) : textHeight / (rows + 1.2);
      context.font = `bold ${Math.round(line.size || size)}px ${line.font || 'sans-serif'}`;
      context.fillText(line.text, textCenterX, y);
    });
    // per-lane down arrows along the bottom of gantry boards
    if (opts.arrows) {
      context.fillStyle = '#f0f3e5';
      const lanes = opts.arrows;
      const y0 = height - arrowBand * 0.72;
      for (let i = 0; i < lanes; i += 1) {
        const x = width * (i + 0.5) / lanes;
        const s = arrowBand * 0.48;
        context.beginPath();
        context.moveTo(x, y0 + s);
        context.lineTo(x - s * 0.55, y0 + s * 0.3);
        context.lineTo(x - s * 0.2, y0 + s * 0.3);
        context.lineTo(x - s * 0.2, y0 - s * 0.45);
        context.lineTo(x + s * 0.2, y0 - s * 0.45);
        context.lineTo(x + s * 0.2, y0 + s * 0.3);
        context.lineTo(x + s * 0.55, y0 + s * 0.3);
        context.closePath();
        context.fill();
      }
    }
    return canvas;
  }

  _getSignMaterial(text, background = '#0c604e', wide = false, opts = {}) {
    const key = `${background}:${wide}:${text}:${opts.shield || ''}:${opts.arrows || 0}`;
    if (this._signMaterials.has(key)) return this._signMaterials.get(key);
    if (typeof document === 'undefined') {
      const fallback = this.materials.signGreen.clone();
      this._signMaterials.set(key, fallback);
      return fallback;
    }
    const lines = text.split('|').map((row, index) => ({
      text: row,
      font: index === 0 ? 'sans-serif' : 'monospace',
    }));
    const canvas = this._signCanvas(lines, background, wide ? 512 : 256, wide ? 160 : 112, opts);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this._ownedTextures.add(texture);
    const material = new THREE.MeshBasicMaterial({
      map: texture, color: 0xffffff, fog: true, toneMapped: false, side: THREE.FrontSide,
    });
    this._signMaterials.set(key, material);
    return material;
  }

  /** Sign plane with a dark back panel so the reverse never shows mirrored text. */
  _makeSignMesh(text, background, width, height, wide = false, opts = {}) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this._getSignMaterial(text, background, wide, opts));
    mesh.name = `sign ${text}`;
    if (!opts.noBack) {
      const back = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.materials.signBack);
      back.rotation.y = Math.PI;
      back.position.z = -0.05;
      mesh.add(back);
    }
    return mesh;
  }

  /**
   * Overhead sign gantry: legs planted outside the barriers, a proper truss
   * spanning the full carriageway, and one green panel per direction — both
   * hung from the SAME beam height (the old code offset each panel by the
   * deck bank, which put the two directions' signs at different heights).
   */
  _buildGantry(route, distance, label, secondary = '') {
    if (this._isTunnel(route, distance)) return;
    const center = this._sampleCenter(route, distance, 1);
    const quaternion = yawQuaternion(center.baseTangent);
    const half = this._halfWidthAt(route, distance) + 1.15;
    const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
    const legL = this._deckPoint(frame, half, 0);
    const legR = this._deckPoint(frame, -half, 0);
    const beamY = Math.max(legL.y, legR.y) + 6.3;
    for (const leg of [legL, legR]) {
      const bottom = leg.y - 1.45; // bolt into the deck fascia
      const legHeight = beamY + 1.75 - bottom;
      const legCenter = leg.clone();
      legCenter.y = bottom + legHeight * 0.5;
      this._instance(legCenter, vec(0.52, legHeight, 0.52), quaternion, null, 'box:concrete');
    }
    // truss: top/bottom chords + alternating diagonal web
    const spanCenter = this._deckPoint(frame, 0, 0);
    for (const chordY of [beamY + 0.22, beamY + 1.58]) {
      const chord = spanCenter.clone();
      chord.y = chordY;
      this._instance(chord, vec(half * 2 + 0.6, 0.22, 0.22), quaternion, null, 'box:concrete');
    }
    const webCount = Math.max(4, Math.round((half * 2) / 2.6));
    for (let i = 0; i < webCount; i += 1) {
      const lateral = -half + ((i + 0.5) / webCount) * half * 2;
      const web = this._deckPoint(frame, lateral, 0);
      web.y = beamY + 0.9;
      const tilt = new THREE.Quaternion().setFromAxisAngle(FORWARD, (i % 2 ? 1 : -1) * 0.72);
      this._instance(web, vec(0.13, 1.65, 0.13), quaternion.clone().multiply(tilt), null, 'box:concrete');
    }
    // one panel per carriageway, each facing ONLY its oncoming direction
    // (direction +1 travels on the negative-lateral side, left-hand traffic)
    const sides = route.bidirectional ? [-1, 1] : [0];
    for (const side of sides) {
      const lateral = side === 0 ? 0 : side * (route.medianWidth * 0.5 + route.lanes * route.laneWidth * 0.5);
      const facingSign = side === 0 ? -(route.oneWayDirection || 1) : side;
      const facing = center.baseTangent.clone().multiplyScalar(facingSign);
      const panel = this._makeSignMesh(label, '#0b5142',
        Math.min(9.8, route.lanes * route.laneWidth + 1.2), 2.9, true,
        { shield: route.code, arrows: route.lanes });
      const position = this._deckPoint(frame, lateral, 0);
      position.y = beamY + 0.9;
      panel.position.copy(position);
      panel.quaternion.copy(yawQuaternion(facing));
      this._addChunkMesh(panel, position);
      if (secondary) {
        const board = this._makeSignMesh(secondary, '#174c72');
        const boardPos = position.clone();
        boardPos.y = beamY - 1.35;
        board.position.copy(boardPos);
        board.quaternion.copy(yawQuaternion(facing));
        board.scale.set(0.62, 0.55, 1);
        this._addChunkMesh(board, boardPos);
      }
    }
  }

  _buildSignage() {
    for (const route of this.routes.values()) {
      if (route.kind === 'service') continue;
      const isRamp = route.kind === 'ramp';
      const interval = isRamp ? 900 : (route.group === 'c1' ? 950 : 1050);
      let signIndex = 0;
      for (let distance = Math.min(400, route.length * 0.3); distance < route.length - 120; distance += interval) {
        const destination = route.destinations[signIndex % Math.max(1, route.destinations.length)] || [route.name.toUpperCase(), ''];
        const [kanji, romaji] = Array.isArray(destination) ? destination : [destination, ''];
        this._buildGantry(route, distance, `${kanji}|${romaji}`);
        signIndex += 1;
      }
      // km posts, mounted on their own poles
      if (!isRamp) {
        for (let distance = 500; distance < route.length; distance += 1000) {
          const center = this._sampleCenter(route, distance, 1);
          if (this._isTunnel(route, distance)) continue;
          const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
          const half = this._halfWidthAt(route, distance);
          const position = this._deckPoint(frame, half + 0.45, 2.3);
          if (this._barrierSuppressed(position, route)) continue;
          const facingSign = route.bidirectional ? 1 : -(route.oneWayDirection || 1);
          const post = this._makeSignMesh(`${route.code} ${(distance / 1000).toFixed(1)}|km`, '#174c72', 1.45, 1.1);
          post.position.copy(position);
          post.quaternion.copy(yawQuaternion(center.baseTangent.clone().multiplyScalar(facingSign)));
          this._addChunkMesh(post, position);
          const pole = this._deckPoint(frame, half + 0.45, 0.85);
          this._instance(pole, vec(0.12, 1.7, 0.12), null, null, 'box:concrete');
        }
      }
      // orange matrix boards on their own mini-gantry before junctions
      if (!isRamp && !route.closed) {
        for (const endDistance of [route.length * 0.32, route.length * 0.78]) {
          if (this._isTunnel(route, endDistance)) continue;
          const center = this._sampleCenter(route, endDistance, 1);
          const quaternion = yawQuaternion(center.baseTangent);
          const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, endDistance) };
          const half = this._halfWidthAt(route, endDistance) + 1.0;
          const legL = this._deckPoint(frame, half, 0);
          const legR = this._deckPoint(frame, -half, 0);
          const beamY = Math.max(legL.y, legR.y) + 5.6;
          for (const leg of [legL, legR]) {
            const bottom = leg.y - 1.45;
            const legCenter = leg.clone();
            legCenter.y = bottom + (beamY + 0.5 - bottom) * 0.5;
            this._instance(legCenter, vec(0.4, beamY + 0.5 - bottom, 0.4), quaternion, null, 'box:concrete');
          }
          const beam = this._deckPoint(frame, 0, 0);
          beam.y = beamY + 0.35;
          this._instance(beam, vec(half * 2 + 0.5, 0.3, 0.3), quaternion, null, 'box:concrete');
          const sides = route.bidirectional ? [-1, 1] : [0];
          for (const side of sides) {
            const lateral = side === 0 ? 0 : side * (route.medianWidth * 0.5 + route.lanes * route.laneWidth * 0.5);
            const facingSign = side === 0 ? -(route.oneWayDirection || 1) : side;
            const board = this._makeSignMesh('渋滞注意|SLOW DOWN', '#241a05', 5.4, 1.5, true);
            const position = this._deckPoint(frame, lateral, 0);
            position.y = beamY + 1.35;
            board.position.copy(position);
            board.quaternion.copy(yawQuaternion(center.baseTangent.clone().multiplyScalar(facingSign)));
            this._addChunkMesh(board, position);
          }
        }
      }
    }

    // Junction name masts (double-faced boards on a planted pole).
    for (const junction of this.junctions) {
      const position = junction.point.clone();
      position.y += 15;
      const mast = vec(position.x, (position.y + 1.1) * 0.5 - 0.5, position.z);
      this._instance(mast, vec(0.5, position.y + 1.1, 0.5), null, null, 'box:concreteDark');
      for (const flip of [0, Math.PI]) {
        const board = this._makeSignMesh(`${junction.name}|JUNCTION`, '#123c78', 6.4, 2.1, true);
        board.position.copy(position);
        board.quaternion.setFromAxisAngle(UP, flip);
        board.translateZ(0.08);
        this._addChunkMesh(board, position);
      }
    }
    // PA advance boards (blue P), on poles, facing their carriageway.
    for (const area of this.serviceAreas) {
      if (!area.routeId || !this.routes.has(area.routeId)) continue;
      const route = this.routes.get(area.routeId);
      for (const ahead of [500, 300, 100]) {
        const distance = wrap(area.mainDistance - (ahead + area.length * 0.5 + 330), route.length);
        if (this._isTunnel(route, distance)) continue;
        const center = this._sampleCenter(route, distance, 1);
        const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
        const half = this._halfWidthAt(route, distance);
        const lateral = (area.sideSign || -1) * (half + 0.6);
        const position = this._deckPoint(frame, lateral, 3.2);
        if (this._barrierSuppressed(position, route)) continue;
        const sign = this._makeSignMesh(`P ${area.name}|${ahead}m`, '#175ba5', 2.7, 1.75);
        sign.position.copy(position);
        sign.quaternion.copy(yawQuaternion(center.tangent.clone().multiplyScalar(-1)));
        this._addChunkMesh(sign, position);
        const pole = this._deckPoint(frame, lateral, 1.2);
        this._instance(pole, vec(0.14, 2.4, 0.14), null, null, 'box:concrete');
      }
    }
  }

  // ------------------------------------------------------------------
  // Rainbow Bridge — landmark #1
  // ------------------------------------------------------------------

  _buildBridge() {
    // Rainbow Bridge dressing spans BOTH carriageways: the longest r11 chain
    // is the spine; the sibling's lateral offset widens towers and cables so
    // one suspension structure carries the pair, like the real deck.
    const chains = this._groupChains('r11');
    const route = chains.find((chain) => chain.bridge);
    if (!route?.bridge) return;
    const sibling = chains.find((chain) => chain !== route && chain.bridge) || null;
    const { startDistance, endDistance } = route.bridge;
    const span = endDistance - startDistance;
    const towerDistances = [startDistance + span * 0.22, startDistance + span * 0.78];
    const towerTops = [];

    // Lateral band the pair occupies, measured along the spine's normal.
    const pairBand = (distance) => {
      const center = this._sampleCenter(route, distance, 1);
      let inner = -route.halfWidth;
      let outer = route.halfWidth;
      if (sibling) {
        const projection = this._projectToRoute(sibling, center.position);
        const toSibling = TMP_A.copy(projection.point).sub(center.position);
        const lateral = toSibling.dot(horizontalNormal(center.baseTangent));
        inner = Math.min(inner, lateral - sibling.halfWidth);
        outer = Math.max(outer, lateral + sibling.halfWidth);
      }
      return { center, inner, outer, mid: (inner + outer) * 0.5, half: (outer - inner) * 0.5 };
    };

    for (const distance of towerDistances) {
      const band = pairBand(distance);
      const center = band.center;
      const quaternion = yawQuaternion(center.baseTangent);
      const normal = horizontalNormal(center.baseTangent);
      const deckY = center.position.y;
      const towerHeight = 62;
      for (const side of [-1, 1]) {
        const legBase = center.position.clone().addScaledVector(normal, band.mid + side * (band.half + 2.4));
        // leg from water to above deck
        const leg = legBase.clone();
        leg.y = (deckY + towerHeight) * 0.5 - 10;
        this._instance(leg, vec(3.2, deckY + towerHeight + 20, 3.6), quaternion, null, 'box:towerWhite');
      }
      // cross beams
      for (const beamY of [deckY + 14, deckY + towerHeight - 6]) {
        const beam = center.position.clone().addScaledVector(normal, band.mid);
        beam.y = beamY;
        this._instance(beam, vec(band.half * 2 + 9, 3.0, 2.6), quaternion, null, 'box:towerWhite');
      }
      // aircraft blinker
      const blinkerPos = center.position.clone();
      blinkerPos.y = deckY + towerHeight + 1.5;
      const blinker = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), this.materials.redBlink.clone());
      blinker.position.copy(blinkerPos);
      this._addChunkMesh(blinker, blinkerPos);
      this.blinkers.push(blinker);
      towerTops.push({ distance, topY: deckY + towerHeight - 4, center: center.position.clone(), normal });
    }

    // Main catenary cables + hangers + light chain.
    const cableSpans = [
      { a: startDistance - 60, b: towerDistances[0], sag: 0.25 },
      { a: towerDistances[0], b: towerDistances[1], sag: 0.5 },
      { a: towerDistances[1], b: endDistance + 60, sag: 0.25 },
    ];
    const topFor = (distance) => {
      const tower = towerTops.find((candidate) => Math.abs(candidate.distance - distance) < 1);
      return tower ? tower.topY : null;
    };
    for (const spanDef of cableSpans) {
      const steps = 16;
      for (const side of [-1, 1]) {
        let previous = null;
        for (let i = 0; i <= steps; i += 1) {
          const t = i / steps;
          const distance = spanDef.a + (spanDef.b - spanDef.a) * t;
          const band = pairBand(this._normalizeDistance(route, distance));
          const center = band.center;
          const normal = horizontalNormal(center.baseTangent);
          const deckY = center.position.y;
          const yA = topFor(spanDef.a) ?? deckY + 6;
          const yB = topFor(spanDef.b) ?? deckY + 6;
          // parabola between the span end heights
          const sagDepth = spanDef.sag * 42;
          const cableY = yA + (yB - yA) * t - 4 * sagDepth * t * (1 - t);
          const point = center.position.clone().addScaledVector(normal, band.mid + side * (band.half + 2.4));
          point.y = cableY;
          if (previous) {
            const mid = previous.clone().lerp(point, 0.5);
            const segment = point.clone().sub(previous);
            const length = segment.length();
            const cableQuat = new THREE.Quaternion().setFromUnitVectors(FORWARD, segment.clone().normalize());
            this._instance(mid, vec(0.28, 0.28, length + 0.4), cableQuat, null, 'box:cable');
            // light chain
            this._instance(mid.clone().add(vec(0, 0.55, 0)), vec(0.5, 0.5, 0.5), null, null, 'box:cableLight');
          }
          // vertical hanger down to the deck edge
          if (i % 2 === 0 && cableY - center.position.y > 2.5) {
            const hangerMid = point.clone();
            hangerMid.y = (cableY + center.position.y + 1) * 0.5;
            this._instance(hangerMid, vec(0.14, cableY - center.position.y - 1, 0.14), null, null, 'box:cable');
          }
          previous = point;
        }
      }
    }

    // Rainbow Bridge signature: light chain along both carriageways' edges.
    for (const chain of chains) {
      if (!chain.bridge) continue;
      for (let distance = chain.bridge.startDistance - 40; distance <= chain.bridge.endDistance + 40; distance += 16) {
        const center = this._sampleCenter(chain, this._normalizeDistance(chain, distance), 1);
        const normal = horizontalNormal(center.baseTangent);
        for (const side of [-1, 1]) {
          const bulb = center.position.clone().addScaledVector(normal, side * (chain.halfWidth + 0.35));
          bulb.y += 1.42;
          this._instance(bulb, vec(0.24, 0.24, 0.24), null, null, 'box:cableLight');
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Service area dressing
  // ------------------------------------------------------------------

  _buildServiceAreaDressing() {
    const random = mulberry32(this.seed ^ 0x9e3779b9);
    const carColors = [0xb3324a, 0x3a68b6, 0xcfcfd4, 0x18191d, 0xd8a63a, 0x74306e, 0x2d7a52, 0x8a2f24];
    for (const area of this.serviceAreas) {
      const orientation = yawQuaternion(area.tangent);
      const packed = area.density === 'packed';
      const carCount = packed ? 34 : area.density === 'medium' ? 12 : 8;

      // deck slab (roadside PAs float at deck level; Daikoku sits on the ground)
      const slabCenter = area.center.clone();
      slabCenter.y -= 0.55;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(area.width, 1.1, area.length), this.materials.roadService);
      slab.position.copy(slabCenter);
      slab.quaternion.copy(orientation); // local +Z (length) runs along the lot tangent
      slab.name = `${area.name} deck`;
      this._addChunkMesh(slab, slabCenter);

      // support pillars when elevated
      if (area.elevation > 4) {
        for (const along of [-area.length * 0.36, 0, area.length * 0.36]) {
          for (const across of [-area.width * 0.32, area.width * 0.32]) {
            const position = area.center.clone()
              .addScaledVector(area.tangent, along)
              .addScaledVector(area.normal, across);
            const height = area.elevation - 1;
            position.y = height * 0.5 - 0.4;
            this._instance(position, vec(2.2, height + 0.8, 2.0), orientation, null, 'box:concreteDark');
          }
        }
      }

      // kerb line under the perimeter fence
      for (const side of [-1, 1]) {
        const kerb = area.center.clone().addScaledVector(area.normal, side * (area.width * 0.5 - 0.28));
        kerb.y = area.elevation + 0.09;
        this._instance(kerb, vec(0.5, 0.18, area.length), orientation, 0x8f959e, 'box:parkedBody');
      }

      // perimeter fence (visual; the lot corridor is the collision)
      const fenceY = area.elevation + 0.6;
      for (const side of [-1, 1]) {
        const rail = area.center.clone().addScaledVector(area.normal, side * (area.width * 0.5 - 0.3));
        rail.y = fenceY;
        this._instance(rail, vec(0.3, 1.2, area.length), orientation, null, 'box:fence');
      }
      for (const endSide of [-1, 1]) {
        // One rail on the outward half only: the access lane crosses the lot
        // ends on the road side, so that side stays open.
        const rail = area.center.clone()
          .addScaledVector(area.tangent, endSide * (area.length * 0.5 - 0.3))
          .addScaledVector(area.normal, area.width * 0.26);
        rail.y = fenceY;
        this._instance(rail, vec(area.width * 0.44, 1.2, 0.3), orientation, null, 'box:fence');
      }

      // painted stalls: rows along the lot
      const rows = packed ? [-area.width * 0.3, -area.width * 0.05, area.width * 0.22] : [-area.width * 0.28, area.width * 0.18];
      const stallPitch = 6.4;
      const stallSlots = [];
      for (const across of rows) {
        for (let along = -area.length * 0.38; along <= area.length * 0.38; along += stallPitch) {
          const position = area.center.clone()
            .addScaledVector(area.tangent, along)
            .addScaledVector(area.normal, across);
          position.y = area.elevation + 0.03;
          this._instance(position, vec(0.12, 0.03, 5.2), orientation, null, 'box:marking');
          stallSlots.push({ along: along + stallPitch * 0.5, across });
        }
      }

      // parked static cars
      for (let i = 0; i < carCount && stallSlots.length; i += 1) {
        const slotIndex = Math.floor(random() * stallSlots.length);
        const slot = stallSlots.splice(slotIndex, 1)[0];
        const color = carColors[Math.floor(random() * carColors.length)];
        const position = area.center.clone()
          .addScaledVector(area.tangent, slot.along)
          .addScaledVector(area.normal, slot.across);
        position.y = area.elevation + 0.55;
        const yaw = orientation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, (random() < 0.5 ? 0 : Math.PI) + (random() - 0.5) * 0.14));
        this._instance(position, vec(1.72, 0.6, 4.1), yaw, color, 'box:parkedBody');
        const cabin = position.clone(); cabin.y += 0.5;
        this._instance(cabin, vec(1.5, 0.42, 2.0), yaw, null, 'box:parkedGlass');
        if (packed && random() < 0.3) {
          // open hood
          const hood = position.clone(); hood.y += 0.62;
          const hoodQuat = yaw.clone().multiply(new THREE.Quaternion().setFromAxisAngle(vec(1, 0, 0), -0.85));
          this._instance(hood, vec(1.5, 0.06, 1.1), hoodQuat, color, 'box:parkedBody');
        }
      }

      // konbini building with glowing front
      const buildingPos = area.center.clone()
        .addScaledVector(area.normal, area.width * 0.36)
        .addScaledVector(area.tangent, area.length * (packed ? 0.18 : 0.28));
      buildingPos.y = area.elevation + 2.6;
      this._instance(buildingPos, vec(22, 5.2, 11), orientation, null, 'box:garage');
      const glassPos = buildingPos.clone().addScaledVector(area.normal, -5.7);
      glassPos.y = area.elevation + 1.5;
      this._instance(glassPos, vec(20, 2.2, 0.25), orientation, null, 'box:konbini');
      const shopSign = this._makeSignMesh(packed ? '7-HEAVEN  大黒店|OPEN 24H' : `7-HEAVEN|${area.name}`, '#0f4632', 12, 2.4, true);
      const shopSignPos = buildingPos.clone().addScaledVector(area.normal, -5.9);
      shopSignPos.y = area.elevation + 4.6;
      shopSign.position.copy(shopSignPos);
      shopSign.quaternion.copy(yawQuaternion(area.normal.clone().multiplyScalar(-1)));
      this._addChunkMesh(shopSign, shopSignPos);

      // vending machines
      const vendingBase = area.center.clone()
        .addScaledVector(area.normal, area.width * 0.4)
        .addScaledVector(area.tangent, -area.length * 0.12);
      for (let i = 0; i < (packed ? 5 : 3); i += 1) {
        const position = vendingBase.clone().addScaledVector(area.tangent, i * 2.1);
        position.y = area.elevation + 1.15;
        this._instance(position, vec(1.55, 2.3, 0.85), yawQuaternion(area.normal), i % 2 ? 0xff5f6d : 0x8ad9ff, 'box:vending');
      }

      // gas station at Daikoku
      if (packed) {
        const stationPos = area.center.clone()
          .addScaledVector(area.tangent, -area.length * 0.3)
          .addScaledVector(area.normal, area.width * 0.3);
        stationPos.y = area.elevation + 5.2;
        this._instance(stationPos, vec(18, 0.7, 13), orientation, null, 'box:canopy');
        for (const dx of [-6, 0, 6]) {
          const pillar = stationPos.clone().addScaledVector(area.tangent, dx);
          pillar.y = area.elevation + 2.6;
          this._instance(pillar, vec(0.5, 5.2, 0.5), orientation, null, 'box:concrete');
          const pump = pillar.clone().addScaledVector(area.normal, 2.2);
          pump.y = area.elevation + 0.65;
          this._instance(pump, vec(0.8, 1.3, 0.55), orientation, 0xd44242, 'box:vending');
        }
      }

      // sodium lot lights (proper lampposts + pools); the lamp's local +X
      // (arm side) maps to -horizontalNormal(tangent) under yawQuaternion
      const armDirection = horizontalNormal(area.tangent, new THREE.Vector3()).multiplyScalar(-1);
      for (const along of [-area.length * 0.33, 0, area.length * 0.33]) {
        const position = area.center.clone().addScaledVector(area.tangent, along);
        position.y = area.elevation;
        this._instance(position, vec(1, 1, 1), orientation, null, 'lamppost:concrete');
        const lens = position.clone().addScaledVector(armDirection, 2.28);
        lens.y = area.elevation + 9.26;
        this._instance(lens, vec(1.1, 0.1, 0.34), orientation, null, 'box:lampSodium');
        const pool = position.clone().addScaledVector(armDirection, 3.4);
        pool.y = area.elevation + 0.07;
        this._instance(pool, vec(11, 1, 14), orientation, null, 'pool:lightPool');
      }

      // refuel pad marker
      const fuelMarker = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.12, 12), this.materials.amber);
      fuelMarker.position.copy(area.refuelPosition);
      fuelMarker.position.y = area.elevation + 0.1;
      fuelMarker.name = `${area.name} refuel pad`;
      this._addChunkMesh(fuelMarker, fuelMarker.position);

      // PA name sign
      const paSign = this._makeSignMesh(`${area.name}|パーキングエリア P`, '#175ba5', 7.5, 2.6, true);
      const paSignPos = area.center.clone()
        .addScaledVector(area.normal, -area.width * 0.46)
        .addScaledVector(area.tangent, area.length * 0.35);
      paSignPos.y = area.elevation + 4.3;
      paSign.position.copy(paSignPos);
      paSign.quaternion.copy(yawQuaternion(area.tangent));
      this._addChunkMesh(paSign, paSignPos);

      if (area.hasGarage) this._buildGarageExterior(area);
    }
  }

  _buildGarageExterior(area) {
    const frontNormal = area.normal.clone();
    const orientation = yawQuaternion(frontNormal);
    const buildingPos = area.garageEntrance.clone().addScaledVector(frontNormal, 18);
    buildingPos.y = area.elevation + 6.2;
    this._instance(buildingPos, vec(48, 12.4, 34), orientation, null, 'box:garage');

    const shutterPos = area.garageEntrance.clone().addScaledVector(frontNormal, 0.8);
    shutterPos.y = area.elevation + 3.45;
    this._instance(shutterPos, vec(24, 6.8, 0.42), orientation, null, 'box:vending');
    const sign = this._makeSignMesh('WANGAN WORKS|湾岸整備工場', '#582b72', 17, 3.25, true);
    const signPos = area.garageEntrance.clone().addScaledVector(frontNormal, 0.45);
    signPos.y = area.elevation + 8.5;
    sign.position.copy(signPos);
    sign.quaternion.copy(yawQuaternion(frontNormal.clone().multiplyScalar(-1)));
    this._addChunkMesh(sign, signPos);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(10.5, 0.72, 4, 18), this.materials.marker);
    ring.position.copy(area.garageEntrance);
    ring.position.y = area.elevation + 0.45;
    ring.rotation.x = Math.PI * 0.5;
    ring.name = 'Garage transition marker';
    this._addChunkMesh(ring, ring.position);
    this.animatedMarkers.push(ring);

    const beacon = new THREE.PointLight(0x55ccff, 1.4, 46, 1.8);
    beacon.position.copy(area.garageEntrance).add(vec(0, 5, 0));
    this._addChunkMesh(beacon, beacon.position);
  }

  // ------------------------------------------------------------------
  // City, industry, port, backdrop
  // ------------------------------------------------------------------

  _distanceToRouteXZ(position, routeIds = null) {
    let bestSq = Infinity;
    const candidates = this._candidateRoutes(position);
    for (const { route, distSq } of candidates.values()) {
      if (routeIds && !routeIds.includes(route.id)) continue;
      bestSq = Math.min(bestSq, distSq);
    }
    return Math.sqrt(bestSq);
  }

  /** Circle-footprint placement test: no building intersections, no clipping into corridors or PA lots. */
  _canPlaceBuilding(x, z, radius, routeClearance = 15) {
    const probe = new THREE.Vector3(x, 0, z);
    if (this._distanceToRouteXZ(probe) < routeClearance + radius) return false;
    if (this._lotAt(probe, radius + 6)) return false;
    const cell = 140;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const bucket = this._footprints.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const footprint of bucket) {
          const ddx = footprint.x - x;
          const ddz = footprint.z - z;
          const limit = radius + footprint.r;
          if (ddx * ddx + ddz * ddz < limit * limit) return false;
        }
      }
    }
    return true;
  }

  _recordFootprint(x, z, r) {
    const cell = 140;
    const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    if (!this._footprints.has(key)) this._footprints.set(key, []);
    this._footprints.get(key).push({ x, z, r });
  }

  /**
   * Textured building box: 4 facade quads with whole-window UV repeats into
   * the chunk bucket for `matName`, dark roof quad. Returns the top Y.
   */
  _pushBuildingBox(matName, random, x, z, baseY, width, height, depth, yaw) {
    const spec = this._facadeSpecs[matName] || { cols: 10, rows: 13, cellW: 3.4, cellH: 3.3 };
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const hw = width * 0.5;
    const hd = depth * 0.5;
    const corners = [
      [x - rx * hw - fx * hd, z - rz * hw - fz * hd],
      [x + rx * hw - fx * hd, z + rz * hw - fz * hd],
      [x + rx * hw + fx * hd, z + rz * hw + fz * hd],
      [x - rx * hw + fx * hd, z - rz * hw + fz * hd],
    ];
    const centerVec = vec(x, baseY, z);
    const bucket = this._bucket(centerVec, matName);
    const floors = Math.max(2, Math.round(height / spec.cellH));
    const v1 = floors / spec.rows;
    for (let i = 0; i < 4; i += 1) {
      const p0 = corners[i];
      const p1 = corners[(i + 1) % 4];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const windows = Math.max(2, Math.round(len / spec.cellW));
      const u1 = windows / spec.cols;
      const offU = Math.floor(random() * spec.cols) / spec.cols;
      const offV = Math.floor(random() * spec.rows) / spec.rows;
      this._pushQuad(bucket,
        vec(p1[0], baseY, p1[1]), vec(p0[0], baseY, p0[1]),
        vec(p0[0], baseY + height, p0[1]), vec(p1[0], baseY + height, p1[1]),
        [offU, offV, offU + u1, offV + v1]);
    }
    const roof = this._bucket(centerVec, 'building');
    this._pushQuad(roof,
      vec(corners[3][0], baseY + height, corners[3][1]),
      vec(corners[2][0], baseY + height, corners[2][1]),
      vec(corners[1][0], baseY + height, corners[1][1]),
      vec(corners[0][0], baseY + height, corners[0][1]));
    return baseY + height;
  }

  static BILLBOARDS = [
    ['月光タイヤ', 'GEKKO TIRES', '#7a1f4d'], ['NIGHTFUEL', '夜間燃料', '#173f78'],
    ['ハイパー缶コーヒー', 'KAN COFFEE', '#7a4d15'], ['首都高保険', 'EXPRESSWAY INS.', '#1f6a54'],
    ['ネオン電機', 'NEON DENKI', '#28246e'], ['湾岸ホテル', 'BAY HOTEL', '#5e1f78'],
    ['真夜中運輸', 'MIDNIGHT EXPRESS', '#6e2424'], ['スターダスト録音', 'STARDUST AUDIO', '#1f5c78'],
  ];

  /**
   * One dressed building. Archetypes: slab office tower, stepped tower,
   * narrow mixed-use w/ neon, low commercial w/ rooftop billboard, crown
   * (lit top floor), hotel/residential, industrial shed, port warehouse.
   * `opts.face` is the unit vector pointing from the building toward the road
   * (signage/shopfront orientation).
   */
  _buildStructure(random, x, z, yaw, archetype, width, height, depth, opts = {}) {
    const baseY = opts.baseY ?? -0.1;
    const face = opts.face || null;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const local = (dx, dz, y) => vec(x + rx * dx + fx * dz, y, z + rz * dx + fz * dz);
    const faceHalf = face
      ? Math.abs(face.x * rx + face.z * rz) * width * 0.5 + Math.abs(face.x * fx + face.z * fz) * depth * 0.5
      : 0;
    const faceLen = face
      ? Math.abs(face.x * fx + face.z * fz) * width + Math.abs(face.x * rx + face.z * rz) * depth
      : width;
    const topY = baseY + height;
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(UP, yaw);

    const blinker = (y = topY + 0.8) => this._instance(vec(x, y, z), vec(1.15, 1.15, 1.15), null, null, 'box:redBlink');
    const waterTank = () => this._instance(
      local((random() - 0.5) * width * 0.4, (random() - 0.5) * depth * 0.4, topY + 1.25),
      vec(2.6, 2.5, 2.6), yawQuat, null, 'box:concreteDark');
    const antenna = () => {
      const h = 4.5 + random() * 5;
      this._instance(local((random() - 0.5) * width * 0.5, (random() - 0.5) * depth * 0.5, topY + h * 0.5),
        vec(0.28, h, 0.28), null, null, 'box:concrete');
    };
    const rooftopBillboard = () => {
      if (!face || typeof document === 'undefined') return;
      const [kanji, romaji, color] = HighwayMap.BILLBOARDS[Math.floor(random() * HighwayMap.BILLBOARDS.length)];
      const w = Math.min(16, faceLen * 0.8);
      const h = w * 0.34;
      const board = this._makeSignMesh(`${kanji}|${romaji}`, color, w, h, true);
      const pos = vec(x, topY + h * 0.5 + 1.1, z);
      board.position.copy(pos);
      board.quaternion.copy(yawQuaternion(face));
      this._addChunkMesh(board, pos);
      for (const side of [-1, 1]) {
        this._instance(vec(x + face.x * -0.4, topY + 0.7, z + face.z * -0.4)
          .add(vec(-face.z * side * w * 0.3, 0, face.x * side * w * 0.3)),
        vec(0.26, 1.6, 0.26), null, null, 'box:concreteDark');
      }
    };
    const wallBillboard = () => {
      if (!face || typeof document === 'undefined') return;
      const [kanji, romaji, color] = HighwayMap.BILLBOARDS[Math.floor(random() * HighwayMap.BILLBOARDS.length)];
      const w = Math.min(15, faceLen * 0.72);
      const board = this._makeSignMesh(`${kanji}|${romaji}`, color, w, w * 0.36, true);
      const pos = vec(x + face.x * (faceHalf + 0.5), baseY + height * 0.62, z + face.z * (faceHalf + 0.5));
      board.position.copy(pos);
      board.quaternion.copy(yawQuaternion(face));
      this._addChunkMesh(board, pos);
    };

    switch (archetype) {
      case 'stepped': {
        this._pushBuildingBox('facadeOffice', random, x, z, baseY, width, height * 0.58, depth, yaw);
        this._pushBuildingBox('facadeOffice', random, x, z, baseY + height * 0.58, width * 0.76, height * 0.26, depth * 0.76, yaw);
        this._pushBuildingBox('facadeDark', random, x, z, baseY + height * 0.84, width * 0.52, height * 0.16, depth * 0.52, yaw);
        if (height > 88) blinker(); else antenna();
        break;
      }
      case 'crown': {
        this._pushBuildingBox(random() < 0.7 ? 'facadeOffice' : 'facadeDark', random, x, z, baseY, width, height, depth, yaw);
        this._instance(vec(x, topY - 0.95, z), vec(width + 0.35, 1.5, depth + 0.35), yawQuat, 0xffedc2, 'box:neon');
        if (height > 88) blinker(topY + 0.9);
        waterTank();
        break;
      }
      case 'narrow': {
        this._pushBuildingBox('facadeHotel', random, x, z, baseY, width, height, depth, yaw);
        if (face) {
          const colors = [0xff5f7a, 0x67d7ff, 0xffc65b, 0x7dffb8, 0xff8de5];
          this._instance(vec(x + face.x * (faceHalf + 0.45), baseY + height * 0.5, z + face.z * (faceHalf + 0.45)),
            vec(0.75, height * 0.6, 0.75), yawQuat, colors[Math.floor(random() * colors.length)], 'box:neon');
        }
        antenna();
        break;
      }
      case 'commercial': {
        this._pushBuildingBox('facadeOffice', random, x, z, baseY, width, height, depth, yaw);
        if (face) {
          this._instance(vec(x + face.x * (faceHalf + 0.22), baseY + 1.5, z + face.z * (faceHalf + 0.22)),
            vec(faceLen * 0.8, 2.4, 0.3), yawQuaternion(TMP_C.set(-face.z, 0, face.x)), 0xffd9a0, 'box:neon');
        }
        if (random() < 0.6) rooftopBillboard();
        break;
      }
      case 'hotel': {
        this._pushBuildingBox('facadeHotel', random, x, z, baseY, width, height, depth, yaw);
        waterTank();
        if (height > 88) blinker();
        break;
      }
      case 'shed': {
        this._pushBuildingBox('facadeIndustrial', random, x, z, baseY, width, height, depth, yaw);
        for (let i = 0; i < 2; i += 1) {
          this._instance(local((random() - 0.5) * width * 0.5, (random() - 0.5) * depth * 0.5, topY + 0.5),
            vec(1.4, 1, 1.4), yawQuat, null, 'box:concreteDark');
        }
        break;
      }
      case 'warehouse': {
        this._pushBuildingBox('facadeIndustrial', random, x, z, baseY, width, height, depth, yaw);
        if (face) {
          const doors = 2 + Math.floor(random() * 2);
          for (let i = 0; i < doors; i += 1) {
            const along = (i - (doors - 1) * 0.5) * (faceLen / (doors + 0.5));
            this._instance(vec(x + face.x * (faceHalf + 0.2) - face.z * along, baseY + 1.9, z + face.z * (faceHalf + 0.2) + face.x * along),
              vec(3.4, 3.6, 0.28), yawQuaternion(TMP_C.set(-face.z, 0, face.x)), 0xffc890, 'box:neon');
          }
        }
        break;
      }
      case 'slab':
      default: {
        this._pushBuildingBox(random() < 0.62 ? 'facadeOffice' : 'facadeDark', random, x, z, baseY, width, height, depth, yaw);
        if (random() < 0.55) waterTank();
        if (random() < 0.5) antenna();
        if (height > 92) blinker();
        if (height > 34 && random() < 0.14) wallBillboard();
        break;
      }
    }
  }

  /** Project lat/lon to local metres with the extractor's origin. */
  _ll(lat, lon) {
    const origin = this.networkMeta?.origin || { lat: 35.68, lon: 139.77 };
    const rad = Math.PI / 180;
    const earth = 6371008.8;
    return vec(
      (lon - origin.lon) * rad * Math.cos(origin.lat * rad) * earth,
      0,
      (lat - origin.lat) * rad * earth,
    );
  }

  _buildCity() {
    const random = mulberry32(this.seed ^ 0xa73b91);
    this._footprints = new Map();

    // --- C1 canyon: two rows of towers hard against both sides of the loop
    // so the C1 reads as a lit canyon with no bare gaps. The spine is the
    // longest C1 carriageway; _canPlaceBuilding keeps towers off the sibling
    // carriageway and every ramp.
    const c1 = this._groupChains('c1')[0];
    if (!c1) return;
    for (let distance = 0; distance < c1.length; distance += 44) {
      const center = this._sampleCenter(c1, distance, 1);
      if (this._isTunnel(c1, distance)) continue;
      const normal = horizontalNormal(center.baseTangent);
      const heading = Math.atan2(center.baseTangent.x, center.baseTangent.z);
      for (const side of [-1, 1]) {
        for (const row of [0, 1]) {
          if (random() < (row ? 0.22 : 0.08)) continue;
          const setback = row ? 64 + random() * 62 : 22 + random() * 26;
          const width = row ? 26 + random() * 28 : 17 + random() * 18;
          const depth = row ? 22 + random() * 26 : 16 + random() * 16;
          const height = row ? 30 + Math.pow(random(), 1.5) * 108 : 18 + Math.pow(random(), 1.4) * 58;
          const position = center.position.clone().addScaledVector(normal, side * (c1.halfWidth + setback + width * 0.5));
          const radius = Math.max(width, depth) * 0.62;
          if (!this._canPlaceBuilding(position.x, position.z, radius)) continue;
          const yaw = heading + (random() - 0.5) * 0.07 + (random() < 0.22 ? Math.PI * 0.5 : 0);
          const roll = random();
          const archetype = row
            ? (roll < 0.34 ? 'slab' : roll < 0.58 ? 'stepped' : roll < 0.74 ? 'crown' : 'hotel')
            : (roll < 0.28 ? 'slab' : roll < 0.46 ? 'narrow' : roll < 0.66 ? 'commercial' : roll < 0.85 ? 'hotel' : 'stepped');
          this._buildStructure(random, position.x, position.z, yaw, archetype, width, height, depth, {
            face: normal.clone().multiplyScalar(-side),
          });
          this._recordFootprint(position.x, position.z, radius);
        }
      }
    }

    // --- Route 9 Fukagawa + Route 1 Haneda: lighter mixed rows so the
    // connectors are not bare.
    const mixedSpines = [this._groupChains('r9')[0], this._groupChains('r1')[0]].filter(Boolean);
    for (const r9 of mixedSpines) {
    for (let distance = 200; distance < r9.length - 200; distance += 70) {
      const center = this._sampleCenter(r9, distance, 1);
      const normal = horizontalNormal(center.baseTangent);
      const heading = Math.atan2(center.baseTangent.x, center.baseTangent.z);
      for (const side of [-1, 1]) {
        if (random() < 0.4) continue;
        const setback = 26 + random() * 60;
        const width = 18 + random() * 22;
        const depth = 16 + random() * 20;
        const height = 14 + Math.pow(random(), 1.5) * 46;
        const position = center.position.clone().addScaledVector(normal, side * (r9.halfWidth + setback + width * 0.5));
        const radius = Math.max(width, depth) * 0.62;
        if (!this._canPlaceBuilding(position.x, position.z, radius)) continue;
        const roll = random();
        this._buildStructure(random, position.x, position.z, heading + (random() - 0.5) * 0.1,
          roll < 0.4 ? 'slab' : roll < 0.6 ? 'hotel' : roll < 0.8 ? 'commercial' : 'narrow',
          width, height, depth, { face: normal.clone().multiplyScalar(-side) });
        this._recordFootprint(position.x, position.z, radius);
      }
    }
    }

    // --- K1 industrial: low sheds, warehouses, smokestacks with red blinkers.
    const k1 = this._groupChains('k1')[0];
    if (!k1) return;
    for (let distance = 0; distance < k1.length; distance += 56) {
      const center = this._sampleCenter(k1, distance, 1);
      const normal = horizontalNormal(center.baseTangent);
      const heading = Math.atan2(center.baseTangent.x, center.baseTangent.z);
      for (const side of [-1, 1]) {
        if (random() < 0.26) continue;
        const setback = 24 + random() * 92;
        const width = 26 + random() * 42;
        const depth = 20 + random() * 30;
        const height = 7 + random() * 12;
        const position = center.position.clone().addScaledVector(normal, side * (k1.halfWidth + setback + width * 0.5));
        const radius = Math.max(width, depth) * 0.6;
        if (!this._canPlaceBuilding(position.x, position.z, radius)) continue;
        this._buildStructure(random, position.x, position.z, heading + (random() < 0.3 ? Math.PI * 0.5 : 0),
          random() < 0.72 ? 'shed' : 'warehouse', width, height, depth,
          { face: normal.clone().multiplyScalar(-side) });
        this._recordFootprint(position.x, position.z, radius);
        if (random() < 0.11) {
          const stackHeight = 34 + random() * 30;
          const stack = position.clone();
          stack.y = stackHeight * 0.5;
          this._instance(stack, vec(3.2, stackHeight, 3.2), null, null, 'box:concreteDark');
          this._instance(vec(position.x, stackHeight + 0.8, position.z), vec(1.1, 1.1, 1.1), null, null, 'box:redBlink');
        }
      }
    }

    // Wangan port: cranes, container stacks, warehouses on the LAND side.
    // Which side is land varies along the real Bayshore, so aim at the
    // nearest terrain slab centre.
    const wangan = this._groupChains('wangan')[0];
    if (!wangan) return;
    for (let distance = 300; distance < wangan.length; distance += 110) {
      if (this._isTunnel(wangan, distance)) continue;
      const center = this._sampleCenter(wangan, distance, 1);
      const normal = horizontalNormal(center.baseTangent);
      let landSide = 1;
      {
        let nearest = null;
        let nearestSq = Infinity;
        for (const slab of this._terrainSlabs) {
          const dx = slab.x - center.position.x;
          const dz = slab.z - center.position.z;
          const dSq = dx * dx + dz * dz;
          if (dSq < nearestSq) { nearestSq = dSq; nearest = slab; }
        }
        if (nearest) {
          const toLand = TMP_A.set(nearest.x - center.position.x, 0, nearest.z - center.position.z);
          landSide = toLand.dot(normal) >= 0 ? 1 : -1;
        }
      }
      if (random() < 0.35) {
        // container stack rows
        const setback = 40 + random() * 120;
        const base = center.position.clone().addScaledVector(normal, landSide * (wangan.halfWidth + setback));
        if (this._distanceToRouteXZ(base) > wangan.halfWidth + 16) {
          const containerColors = [0x54331f, 0x1f4654, 0x5a1f24, 0x2e4a1f, 0x4a3d1f];
          const yaw = yawQuaternion(center.baseTangent);
          for (let row = 0; row < 2 + Math.floor(random() * 3); row += 1) {
            for (let level = 0; level < 1 + Math.floor(random() * 3); level += 1) {
              const box = base.clone().addScaledVector(normal, row * 3.4);
              box.y = 1.3 + level * 2.6;
              this._instance(box, vec(2.9, 2.55, 12.2), yaw, containerColors[Math.floor(random() * containerColors.length)], 'box:container');
            }
          }
        }
      }
      if (random() < 0.16) {
        // gantry crane on the waterfront
        const setback = 60 + random() * 60;
        const base = center.position.clone().addScaledVector(normal, landSide * (wangan.halfWidth + setback));
        if (this._distanceToRouteXZ(base) > wangan.halfWidth + 16) {
          const yaw = yawQuaternion(center.baseTangent);
          for (const legOffset of [-9, 9]) {
            const leg = base.clone().addScaledVector(center.baseTangent, legOffset);
            leg.y = 17;
            this._instance(leg, vec(2.2, 34, 2.2), yaw, null, 'box:crane');
          }
          const beam = base.clone();
          beam.y = 34;
          this._instance(beam, vec(3, 2.6, 46), yaw, null, 'box:crane');
          const jib = base.clone().addScaledVector(normal, -landSide * 14);
          jib.y = 34;
          this._instance(jib, vec(2.4, 2.2, 20), yaw.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI * 0.5)), null, 'box:crane');
          const blinker = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), this.materials.redBlink.clone());
          blinker.position.copy(base);
          blinker.position.y = 36.4;
          this._addChunkMesh(blinker, blinker.position);
          this.blinkers.push(blinker);
        }
      }
      if (random() < 0.32) {
        const setback = 90 + random() * 220;
        const width = 40 + random() * 55;
        const depth = 24 + random() * 26;
        const height = 10 + random() * 10;
        const position = center.position.clone().addScaledVector(normal, landSide * (wangan.halfWidth + setback + width * 0.5));
        const radius = Math.max(width, depth) * 0.6;
        if (this._canPlaceBuilding(position.x, position.z, radius)) {
          const heading = Math.atan2(center.baseTangent.x, center.baseTangent.z);
          this._buildStructure(random, position.x, position.z, heading, 'warehouse', width, height, depth,
            { face: normal.clone().multiplyScalar(-landSide) });
          this._recordFootprint(position.x, position.z, radius);
        }
      }
    }
  }

  _buildBackdrop() {
    // Distant skyline silhouettes with lit windows, close enough to read
    // through the PSX fog. Placed on the far side of the bay from the
    // Rainbow Bridge and behind Daikoku.
    const random = mulberry32(this.seed ^ 0x517cc1);
    const at = (lat, lon) => this._ll(lat, lon);
    const clusters = [
      { ...at(35.6440, 139.7480), spread: 1500, count: 26, tall: 130, streak: [1, -0.2] },  // Shibaura bank, faces the bridge
      { ...at(35.6300, 139.7950), spread: 1200, count: 18, tall: 90, streak: [-1, -0.2] },  // Daiba east bank
      { ...at(35.4750, 139.6600), spread: 1400, count: 16, tall: 70, streak: [1, -0.1] },   // Yokohama shore behind Daikoku
      { ...at(35.6560, 139.8300), spread: 1500, count: 16, tall: 80, streak: [-0.2, -1] },  // Tatsumi postcard
    ];
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.count; i += 1) {
        const x = cluster.x + (random() - 0.5) * cluster.spread;
        const z = cluster.z + (random() - 0.5) * cluster.spread * 0.6;
        const width = 30 + random() * 42;
        const depth = width * (0.7 + random() * 0.5);
        const height = 24 + Math.pow(random(), 1.4) * cluster.tall;
        const radius = Math.max(width, depth) * 0.6;
        if (!this._canPlaceBuilding(x, z, radius, 60)) continue;
        const roll = random();
        this._buildStructure(random, x, z, random() * Math.PI, roll < 0.5 ? 'slab' : roll < 0.8 ? 'stepped' : 'crown',
          width, height, depth, {});
        this._recordFootprint(x, z, radius);
      }
      // skyline reflection streaks on the bay water in front of each cluster
      if (cluster.streak) {
        const direction = vec(cluster.streak[0], 0, cluster.streak[1]).normalize();
        const streakQuat = yawQuaternion(direction);
        const perpendicular = vec(-direction.z, 0, direction.x);
        for (let i = 0; i < 9; i += 1) {
          const across = (i - 4) * cluster.spread * 0.1 + (random() - 0.5) * 60;
          const position = vec(cluster.x, -0.78, cluster.z)
            .addScaledVector(perpendicular, across)
            .addScaledVector(direction, cluster.spread * 0.42 + random() * 240);
          const warm = random() < 0.4;
          this._instance(position, vec(2.4 + random() * 2, 1, 70 + random() * 90), streakQuat,
            warm ? 0xd8c9a0 : 0x9fb8d8, 'pool:lightPool');
        }
      }
    }

    // Broadcast tower at the real Tokyo Tower spot, inside the C1 west arc.
    const towerPos = this._ll(35.6586, 139.7454);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(4, 22, 240, 6), this.materials.towerWhite);
    tower.position.copy(towerPos);
    tower.position.y = 120;
    tower.name = 'Broadcast tower';
    this._addChunkMesh(tower, towerPos);
    const towerBlinker = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), this.materials.redBlink.clone());
    towerBlinker.position.set(towerPos.x, 243, towerPos.z);
    this._addChunkMesh(towerBlinker, towerBlinker.position);
    this.blinkers.push(towerBlinker);

    // Ferris wheel on Daiba (Palette Town, PS2-era Tokyo Bay signature).
    const wheelCenter = this._ll(35.6249, 139.7815);
    wheelCenter.y = 66;
    const wheelGroup = new THREE.Group();
    wheelGroup.name = 'Bay ferris wheel';
    const rim = new THREE.Mesh(new THREE.TorusGeometry(52, 1.6, 5, 22), this.materials.crane);
    wheelGroup.add(rim);
    for (let i = 0; i < 11; i += 1) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.9, 102, 0.9), this.materials.crane);
      spoke.rotation.z = (i / 11) * Math.PI;
      wheelGroup.add(spoke);
      const gondolaAngle = (i / 11) * Math.PI * 2;
      const gondola = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 2.6, 2.6),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(i / 11, 0.85, 0.6), fog: true, toneMapped: false }),
      );
      gondola.position.set(Math.cos(gondolaAngle) * 52, Math.sin(gondolaAngle) * 52, 0);
      wheelGroup.add(gondola);
      this._ownedTextures.add({ dispose: () => gondola.material.dispose() });
    }
    for (const legSide of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(2.4, 76, 2.4), this.materials.crane);
      leg.position.set(legSide * 16, -30, 0);
      leg.rotation.z = legSide * 0.32;
      wheelGroup.add(leg);
    }
    wheelGroup.position.copy(wheelCenter);
    wheelGroup.rotation.y = Math.PI * 0.32;
    this._addChunkMesh(wheelGroup, wheelCenter);
  }

  // ------------------------------------------------------------------
  // Minimap / stats / runtime
  // ------------------------------------------------------------------

  _buildMinimapData() {
    const colors = {
      c1: '#ffb454',
      wangan: '#4fc9ff',
      k1: '#e87bff',
      k5: '#7fc4ff',
      r11: '#ffe667',
      r9: '#79e690',
      r1: '#ff9f7a',
      r6: '#a0e0d0',
      ramp: '#8b98ab',
      service: '#aeb8c8',
    };
    const routes = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const route of this.routes.values()) {
      const count = Math.max(12, Math.ceil(route.length / (route.kind === 'service' || route.kind === 'ramp' ? 40 : 110)));
      const points = [];
      for (let i = 0; i <= count; i += 1) {
        if (route.closed && i === count) continue;
        const point = route.curve.getPointAt(i / count);
        points.push({ x: point.x, y: point.y, z: point.z });
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
      routes.push({
        id: route.id,
        name: route.name,
        code: route.code,
        kind: route.kind,
        closed: !!route.closed,
        points,
        color: colors[route.group] || colors[route.kind] || '#d6d6d6',
        width: route.kind === 'service' || route.kind === 'ramp' ? 1 : (route.lanes >= 3 ? 3 : 2),
        length: route.length,
      });
    }
    const padding = 800;
    const bounds = {
      minX: minX - padding,
      maxX: maxX + padding,
      minZ: minZ - padding,
      maxZ: maxZ + padding,
      width: maxX - minX + padding * 2,
      height: maxZ - minZ + padding * 2,
    };
    const serviceAreas = this.serviceAreas.map((area) => ({
      id: area.id,
      name: area.name,
      x: area.center.x,
      y: area.center.y,
      z: area.center.z,
      position: { x: area.center.x, y: area.center.y, z: area.center.z },
      hasGarage: area.hasGarage,
    }));
    const garageArea = this.serviceAreas.find((area) => area.hasGarage);
    this.minimapData = {
      routes,
      bounds,
      serviceAreas,
      garage: garageArea ? {
        id: 'player_garage',
        serviceAreaId: garageArea.id,
        x: garageArea.garageEntrance.x,
        y: garageArea.garageEntrance.y,
        z: garageArea.garageEntrance.z,
        position: {
          x: garageArea.garageEntrance.x,
          y: garageArea.garageEntrance.y,
          z: garageArea.garageEntrance.z,
        },
      } : null,
      junctions: this.junctions.map((junction) => ({
        id: junction.id,
        name: junction.name,
        x: junction.point.x,
        y: junction.point.y,
        z: junction.point.z,
        routes: [...junction.routes],
      })),
      networkLength: [...this.routes.values()].filter((route) => route.kind !== 'service').reduce((sum, route) => sum + route.length, 0),
    };
  }

  getMinimapData() {
    return this.minimapData;
  }

  worldToMinimap(position, width = 1, height = 1, padding = 0) {
    const bounds = this.minimapData.bounds;
    const usableWidth = Math.max(0, width - padding * 2);
    const usableHeight = Math.max(0, height - padding * 2);
    return {
      x: padding + (position.x - bounds.minX) / bounds.width * usableWidth,
      y: padding + (position.z - bounds.minZ) / bounds.height * usableHeight,
    };
  }

  getNetworkStats() {
    const majorRoutes = [...this.routes.values()].filter((route) => route.kind !== 'service');
    return {
      routeCount: majorRoutes.length,
      totalLengthMeters: majorRoutes.reduce((sum, route) => sum + route.length, 0),
      totalLengthKm: majorRoutes.reduce((sum, route) => sum + route.length, 0) / 1000,
      junctionCount: this.junctions.length,
      serviceAreaCount: this.serviceAreas.length,
      tunnelCount: majorRoutes.reduce((sum, route) => sum + route.tunnels.length, 0),
      edgeCount: this.edges.length,
      chunkCount: this._chunks.size,
    };
  }

  build() {
    return this;
  }

  /** Quality scaling for the effect layers: Low hides the wet-asphalt streaks. */
  setQuality(quality) {
    if (quality === this._quality) return;
    this._quality = quality;
    const visible = quality !== 'low';
    for (const mesh of this._effectMeshes) mesh.visible = visible;
  }

  update(playerPosition = null, timeSeconds = 0) {
    // Chunk streaming: toggle visibility around the player. Cheap enough to
    // run whenever the player crosses into a new cell or every 0.6 s.
    if (playerPosition) {
      const key = this._chunkKey(playerPosition.x, playerPosition.z);
      if (key !== this._visibleKey || timeSeconds - this._lastVisibleUpdate > 0.6) {
        this._visibleKey = key;
        this._lastVisibleUpdate = timeSeconds;
        for (const chunk of this._chunks.values()) {
          const dx = chunk.center.x - playerPosition.x;
          const dz = chunk.center.z - playerPosition.z;
          chunk.group.visible = chunk.alwaysVisible || (dx * dx + dz * dz) <= (CHUNK_VISIBLE + CHUNK * 0.71) ** 2;
        }
      }
    }
    const pulse = 1 + Math.sin(timeSeconds * 3.2) * 0.12;
    for (const marker of this.animatedMarkers) {
      if (marker.__spin) {
        marker.rotation.y = timeSeconds * 0.4;
        continue;
      }
      marker.scale.setScalar(pulse);
      marker.rotation.z = timeSeconds * 0.35;
      if (marker.material) marker.material.opacity = 0.62 + Math.sin(timeSeconds * 4.1) * 0.18;
    }
    const blinkOn = Math.floor(timeSeconds * 0.9) % 2 === 0;
    for (const blinker of this.blinkers) blinker.visible = blinkOn;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.group.parent) this.group.parent.remove(this.group);
    const geometries = new Set();
    const materials = new Set();
    this.group.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
      else if (object.material) materials.add(object.material);
    });
    Object.values(this.materials).forEach((material) => materials.add(material));
    this._signMaterials.forEach((material) => materials.add(material));
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this._ownedTextures.forEach((texture) => texture.dispose());
    this.group.clear();
  }
}

export default HighwayMap;
