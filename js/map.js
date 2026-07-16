import * as THREE from 'three';
// Offline-faired centrelines (tools/build-smoothed-routes.mjs): same schema
// as data/routes.js but with the extractor's chord-polygon noise removed in
// XZ (raw OSM data stays in data/routes.js — regenerate with the tool after
// any extractor run).
import ROUTE_DATA from '../data/routes-smoothed.js';
import { buildProgressiveTransitions } from './progressive-merge.js';
import { PROGRESSIVE_MERGE_PROTOTYPES } from './progressive-merge-prototypes.js';

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

// Preserve the existing 15 m terrain lift and add the requested 10 m raise.
// Apply the total once, at the authoritative data-control-point boundary, so
// curves and every system derived from them inherit exactly the same lift
// without changing X/Z or any route-to-route height difference.
export const ROAD_NETWORK_BASE_Y_OFFSET = 15.0;
export const ROAD_NETWORK_EXTRA_Y_OFFSET = 10.0;
export const ROAD_NETWORK_Y_OFFSET = ROAD_NETWORK_BASE_Y_OFFSET + ROAD_NETWORK_EXTRA_Y_OFFSET;

// One authoritative multiplier keeps every procedural city building and all
// height-dependent rooftop details in proportion.
export const CITY_BUILDING_HEIGHT_SCALE = 1.8;

// TEMPORARY (lateral-junction rebuild): the synthesized PA access lanes —
// the decel/accel legs and descent spirals _defineServiceAreas builds around
// each parking area — are broken and will be rebuilt in their own pass.
// This flag removes them from the RUNTIME map only: no route is registered,
// so their asphalt, collision corridor, guardrails/wall segments, markings,
// minimap polyline and traffic connections all disappear together. The raw
// (data/routes.js) and smoothed (data/routes-smoothed.js) network data are
// untouched; set the flag to false (or pass options.paAccessLanes = true) to
// restore every lane. This now includes the garage connector (Shibaura,
// hasGarage in data): the lot and its dressing stay, but the lane is gone,
// so the garage flow never drives it — spawn/tow/exit already land on the
// R11 mainline (initialSpawn) and the ENTER GARAGE trigger relocates to the
// mainline shoulder beside the lot (see _defineServiceAreas).
const PA_ACCESS_LANES_DISABLED = true;

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
    // (null, options) — headless probes — must not silently drop options
    this.options = isScene ? maybeOptions : (sceneOrOptions || maybeOptions || {});
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
    this.progressiveTransitions = [];
    this.progressiveCandidateClassifications = [];
    this.progressiveTransitionById = new Map();
    this.routeSamples = Object.create(null);
    this.animatedMarkers = [];
    // options.markingDebug: per-piece paint/suppression records (see
    // _paintStrip / _dressGores). Besides orientation, the A-B junction
    // probe needs to explain which system attempted every boundary and why
    // a candidate span was retained or rejected.
    this._markingLog = [];
    this._markingTag = null;
    this._markingOwner = null;
    this._markingClassification = null;
    this._markingBoundary = null;
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
    if (this.options.progressiveCorridorDebug) this._buildProgressiveCorridorDebugOverlay();
    if (this.options.progressiveMergeHandoffDebug) this._buildP2HandoffDebugOverlay();
    if (this.options.progressiveOwnershipDebug) this._buildP4OwnershipDebugOverlay();
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
    let points = routeData.points.map((entry) => vec(
      entry[0], entry[1] + ROAD_NETWORK_Y_OFFSET, entry[2],
    ));
    const routeKind = routeData.kind === 'ramp' ? 'ramp' : kind;
    let divergeInfo = null;
    let mergeInfo = null;

    if (!routeData.closed) {
      const endDrop = Math.abs(routeData.points[0][1] - routeData.points[routeData.points.length - 1][1]);
      const steep = endDrop > routeData.length * 0.05;
      const anchorSpan = steep ? 30 : Math.min(95, Math.max(30, routeData.length * 0.22));
      const anchorsStart = !!(startEdge && startEdge.kind === 'diverge' && this.routes.has(startEdge.from.route));
      const anchorsEnd = !!(endEdge && endEdge.kind === 'merge' && this.routes.has(endEdge.to.route));
      const doubleAnchored = anchorsStart && anchorsEnd;
      if (anchorsStart) {
        divergeInfo = this._anchorEndpoint(points, routeData, startEdge, 'start', anchorSpan, doubleAnchored);
        if (divergeInfo) points = divergeInfo.points;
      }
      if (anchorsEnd) {
        mergeInfo = this._anchorEndpoint(points, routeData, endEdge, 'end', anchorSpan, doubleAnchored);
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
      const host = this.routes.get(mergeInfo.hostId);
      const edge = this._addEdge({
        from: { routeId: route.id, distance: 'end', direction: 1 },
        to: { routeId: mergeInfo.hostId, distance: mergeInfo.hostDistance, direction: 1 },
        kind: 'merge',
        name: routeData.name || route.id,
      });
      edge.side = mergeInfo.side;
      // The branch's lanes are glued onto the host's outermost lanes on
      // that side (see _anchorEndpoint), so branch lane L lands exactly on
      // host lane mergeLaneBase + L — a zero-jump hand-off.
      edge.mergeLaneBase = mergeInfo.side > 0 ? 0 : Math.max(0, host.lanes - route.lanes);
      edge.mergeLane = edge.mergeLaneBase;
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
  _anchorEndpoint(points, routeData, edge, which, anchorSpan, doubleAnchored = false) {
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
    // LANE-ALIGNED glue line: the branch's lanes overlap the host's
    // outermost `branchLanes` lanes on that side, so the transition ends ON
    // the host's lane grid. This is width-continuous by construction (a
    // ramp's narrower shoulder ends 0.35 m inside the host's paved edge, an
    // equal-width merge overlaps exactly) and traffic transfers land where
    // the vehicle already is — the old edge-anchored line (hostHalf − 2 m)
    // left every branch ~1.1 m outside the outer lane centre, so vehicles
    // rode the shoulder and snapped laterally at the hand-off.
    const branchLanes = Math.max(1, routeData.lanes || (routeData.kind === 'ramp' ? 1 : 2));
    const lateral = side * Math.max(0, host.lanes - branchLanes) * (host.laneWidth || LANE_W) * 0.5;

    const edgePoint = (distance) => {
      const sample = this._sampleCenter(host, this._normalizeDistance(host, distance), 1);
      return sample.position.clone().addScaledVector(sample.normal, lateral);
    };

    // BLENDED TAPER: over the first `blendLength` of the branch, each point
    // mixes the host's lane-aligned glue line (at the matching station)
    // with the raw geometry using a SQUARED smoothstep — tangent-continuous
    // at both ends (weight slope 0 at t=0 and t=1), and heavily skewed so
    // the branch is fully glued near the mouth and does its lateral glide
    // far out where the pavements are still separate: no last-moment
    // diagonal at the merge point. The length comes from route metadata:
    // at least the anchoring span, stretched to what the branch's speed
    // limit needs for a comfortable glide, capped by available geometry
    // (steep diving ramps keep the short span — their heights are pinned
    // to the host only briefly; double-anchored connectors keep their two
    // blends disjoint).
    const speedNeed = ((routeData.speedLimit || 60) / 3.6) * 9;
    const lengthCap = routeData.length * (doubleAnchored ? 0.45 : 0.7);
    const ordered = which === 'start' ? points : [...points].reverse();
    // The blend must never reach the branch's FAR endpoint: that point can
    // be another route's continuation anchor (ramp_39 hands off onto
    // ramp_46's start), and pulling it toward the glue line tears the
    // hand-off open. Cap by the polyline's own arc so the far end always
    // keeps raw geometry.
    let polylineArc = 0;
    for (let i = 1; i < ordered.length; i += 1) polylineArc += ordered[i].distanceTo(ordered[i - 1]);
    const blendLength = Math.min(
      Math.max(anchorSpan * 2, Math.min(anchorSpan > 31 ? speedNeed : 0, lengthCap, 240)),
      polylineArc * 0.8,
    );
    const alongSign = which === 'start' ? 1 : -1;
    const blended = [];
    let travelled = 0;
    let restFrom = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      if (i > 0) travelled += ordered[i].distanceTo(ordered[i - 1]);
      if (travelled > blendLength) { restFrom = i; break; }
      const t = travelled / blendLength;
      const step = t * t * (3 - 2 * t);
      const smooth = step * step;
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
    // TWO lead points on the glue line pin the curve's endpoint tangent to
    // the host direction (an open Catmull-Rom's end tangent leans toward
    // the next interior point — one lead alone let the mouth start/end
    // 5-8 deg off-axis with a ~0.6 m bulge).
    const lead = edgePoint(hostDistanceAtMouth - alongSign * 30);
    const lead2 = edgePoint(hostDistanceAtMouth - alongSign * 15);
    const merged = [lead, lead2, ...blended, ...rest];
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

      // PA access lanes are temporarily disabled (see PA_ACCESS_LANES_DISABLED),
      // the garage connector included: the lot itself stays (dressing, refuel,
      // proximity, its own wall collision), but no access route, corridor,
      // rails or edges are created for it. The garage stays usable without
      // its lane: the ENTER GARAGE trigger point (area.garageEntrance, read
      // by getGarageTransition / getServiceAreaProximity / the minimap
      // marker) moves onto the host carriageway's shoulder beside the lot,
      // while the physical building keeps its lot anchor (garageLotAnchor).
      const laneDisabled = this.options.paAccessLanes === true ? false : PA_ACCESS_LANES_DISABLED;
      if (laneDisabled) {
        const area = this._pushServiceArea(def, route, distance, center, tangent, outward, elevation, null);
        area.sideSign = sideSign;
        area.accessDisabled = true;
        if (area.hasGarage) {
          const shoulder = sample.position.clone()
            .addScaledVector(sample.normal, sideSign * Math.max(1.2, route.halfWidth - 1.8));
          shoulder.y = sample.position.y + 0.15;
          area.garageEntrance = shoulder;
        }
        continue;
      }

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
    // The lot-local anchor the garage BUILDING is dressed around; the
    // functional entrance trigger (garageEntrance) defaults to it but moves
    // to the mainline shoulder while the access lane is disabled.
    area.garageLotAnchor = def.hasGarage
      ? center.clone().addScaledVector(outward, def.width * 0.46).addScaledVector(tangent, -14)
      : null;
    area.garageEntrance = area.garageLotAnchor ? area.garageLotAnchor.clone() : null;
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

  /** Active one-sided progressive envelope for a host route station. */
  _progressiveEnvelopeAt(route, distance) {
    const transitions = route._progressiveTransitionsAsHost;
    if (!transitions) return null;
    for (const transition of transitions) {
      if (!transition.containsHost(distance, 0.01)) continue;
      return { transition, envelope: transition.envelopeAt(distance) };
    }
    return null;
  }

  /** True rendered/collision edge lateral, including a progressive envelope. */
  _surfaceEdgeLateral(frame, side, inset = 0) {
    const progressive = frame.route
      ? this._progressiveEnvelopeAt(frame.route, frame.distance)
      : null;
    if (progressive && progressive.transition.sideSign === side) {
      return progressive.envelope.outerLateral - side * inset;
    }
    return side * (frame.half - inset);
  }

  _endIsOpen(route, whichEnd) {
    if (route.closed) return true;
    const endDistance = whichEnd > 0 ? route.length : 0;
    return this.edges.some((edge) => edge.from.routeId === route.id
      && Math.abs(edge.from.distance - endDistance) < 60 && edge.kind !== 'diverge')
      || this.edges.some((edge) => edge.to.routeId === route.id && Math.abs(edge.to.distance - endDistance) < 60);
  }

  // ------------------------------------------------------------------
  // Same-level lateral junction mouths
  //
  // Every diverge/merge edge joins a BRANCH end to a HOST carriageway with
  // an anchored taper whose heights are glued to the host deck. Before this
  // pass the branch drew its own full-width ribbon through that taper —
  // coplanar duplicated asphalt z-fighting on the host — and a sliver hole
  // opened between the two paved edges at the gore. The mouth system turns
  // each junction into ONE coherent paved surface, purely by construction
  // of the drawn deck; physics (corridor union), wall segments and the
  // authoritative road frames are untouched:
  //
  //  - where a branch cross-section lies inside the host's paved surface at
  //    deck level, it is not drawn (the host IS the surface there);
  //  - where it straddles the host's edge, the branch deck starts exactly
  //    at the host edge and tucks 0.35 m under it (watertight against the
  //    host's chorded edge, no coplanar overlap);
  //  - where a narrow near-level gap opens at the gore, an apron extends
  //    the branch deck across the sliver and under the host edge, closing
  //    the hole until the surfaces have genuinely separated;
  //  - branch cross-sections that are inside the host's plan extent but
  //    vertically clear of its surface (a ramp lifting away, a stacked
  //    deck) are drawn untouched — vertical separations are real geometry
  //    and stay out of this system's scope.
  // ------------------------------------------------------------------

  /** Register mouth spans on each branch route (called once, before build). */
  _prepareJunctionMouths() {
    const SCAN_STEP = 7;
    const SCAN_MAX = 340;
    for (const edge of this.edges) {
      if (edge.kind !== 'diverge' && edge.kind !== 'merge') continue;
      const isDiverge = edge.kind === 'diverge';
      const branch = this.routes.get(isDiverge ? edge.to.routeId : edge.from.routeId);
      const host = this.routes.get(isDiverge ? edge.from.routeId : edge.to.routeId);
      if (!branch || !host || branch === host || branch.closed) continue;
      const which = isDiverge ? 'start' : 'end';
      // Side of the host the branch peels to/arrives from (base normal +1 =
      // driver's left). Prefer the anchoring's own record, measure otherwise.
      let side = edge.side;
      if (side === undefined) {
        const probeAt = which === 'start'
          ? Math.min(60, branch.length * 0.4)
          : Math.max(branch.length - 60, branch.length * 0.6);
        const probe = this._sampleCenter(branch, probeAt, 1);
        side = this._projectToRoute(host, probe.position).signedLateral >= 0 ? 1 : -1;
      }
      // Scan the branch away from the mouth: the mouth span lasts while the
      // branch corridor stays laterally engaged with the host (overlapping
      // or within gore-gap range) at ~deck level. It ends where the paved
      // edges have clearly separated or the decks part vertically.
      let span = 0;
      let clear = 0;
      for (let s = 0; s <= Math.min(SCAN_MAX, branch.length); s += SCAN_STEP) {
        const station = which === 'start' ? s : branch.length - s;
        const sample = this._sampleCenter(branch, station, 1);
        const projection = this._projectToRoute(host, sample.position);
        if (projection.endOvershoot > 4) break;
        const hostHalf = this._halfWidthAt(host, projection.distance);
        const branchHalf = this._halfWidthAt(branch, station);
        const separation = Math.abs(projection.signedLateral) - (hostHalf + branchHalf);
        const bank = this._bankAt(host, projection.distance);
        const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral;
        const dy = Math.abs(sample.position.y - deckY);
        if (separation < 1.6 && dy < 2.0) {
          span = s;
          clear = 0;
        } else {
          clear += 1;
          if (clear >= 2) break;
        }
      }
      if (span <= 0) continue;
      span = Math.min(span + SCAN_STEP, branch.length);
      if (!branch.junctionMouths) branch.junctionMouths = [];
      branch.junctionMouths.push({ which, host, side, span, kind: edge.kind });
    }
    // Both ends of a short connector can own mouths; keep them disjoint so
    // one frame is never claimed by two mouths.
    for (const route of this.routes.values()) {
      const mouths = route.junctionMouths;
      if (!mouths || mouths.length < 2) continue;
      const start = mouths.find((mouth) => mouth.which === 'start');
      const end = mouths.find((mouth) => mouth.which === 'end');
      if (start && end && start.span + end.span > route.length) {
        const overflow = start.span + end.span - route.length;
        start.span -= overflow * 0.5;
        end.span -= overflow * 0.5;
      }
    }
    this._prepareJunctionZones();
    this.progressiveTransitions = buildProgressiveTransitions(this, PROGRESSIVE_MERGE_PROTOTYPES);
    this.progressiveTransitionById = new Map(
      this.progressiveTransitions.map((transition) => [transition.id, transition]),
    );
  }

  /**
   * Evaluate one branch cross-section against the renderer's authoritative
   * mouth clip. Junction consumers must use this record instead of repeating
   * overlap/height guesses with their own tolerances.
   */
  _junctionMouthRow(route, mouth, bS, hostSeed = null) {
    // The three exact ownership predicates share their topology brackets.
    // Reuse an evaluated section instead of re-projecting its centre and
    // both deck edges for each predicate's bisection.
    const cache = mouth._markingRowCache || (mouth._markingRowCache = new Map());
    const cacheKey = bS.toFixed(6);
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const host = mouth.host;
    const side = mouth.side;
    const frame = this._frameAt(route, bS);
    const projection = this._projectToRoute(
      host,
      frame.position,
      hostSeed === null ? null : this._hostSeedIndex(host, hostSeed),
    );
    if (projection.endOvershoot > 4) {
      cache.set(cacheKey, null);
      return null;
    }
    const hostHalf = this._halfWidthAt(host, projection.distance);
    const bank = this._bankAt(host, projection.distance);
    const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral;
    const e = side * projection.signedLateral;
    const dy = frame.position.y - deckY;
    let clip = null;
    let removed = null;
    let covered = null;
    let dyEnds = null;
    let Lends = null;
    if (Math.abs(dy) < 1.6) {
      frame._jxSeed = projection.distance;
      clip = this._mouthClipAt(route, frame);
      if (clip && clip.mouth === mouth && clip.removed) removed = clip.removed;
      const gauge = frame._jxGauge;
      if (gauge && gauge.mouth === mouth) {
        covered = gauge.covered;
        dyEnds = gauge.dyEnds;
        Lends = gauge.Lends;
      }
    }
    const unionOuter = Math.max(hostHalf, e + frame.half);
    let crossOuter = unionOuter;
    let shelfFree = true;
    if (covered) {
      const dyAtT = (t) => dyEnds[0] + (dyEnds[1] - dyEnds[0]) * t;
      const sLatT = (t) => side * (Lends[0] + (Lends[1] - Lends[0]) * t);
      const tOf = (lat) => (lat + frame.half) / (2 * frame.half);
      let t0 = tOf(covered[0]);
      let t1 = tOf(covered[1]);
      const s0 = sLatT(t0);
      const s1 = sLatT(t1);
      if (!(s0 < 0 && s1 < 0)) {
        if (s0 < 0) t0 += (0 - s0) / (s1 - s0) * (t1 - t0);
        else if (s1 < 0) t1 = t0 + (0 - s0) / (s1 - s0) * (t1 - t0);
        // This is the same top-surface threshold consumed by the visible
        // paved-union/collision hand-off. A higher shelf is a second deck.
        shelfFree = Math.max(dyAtT(t0), dyAtT(t1)) < 0.35;
      }
      const edgeLat = covered[1] < frame.half - 0.05
        ? covered[1]
        : (covered[0] > -frame.half + 0.05 ? covered[0] : null);
      if (edgeLat !== null && Math.abs(dyAtT(tOf(edgeLat))) > 0.18) {
        crossOuter = Math.min(crossOuter, hostHalf);
      }
    }
    const row = {
      bS,
      hS: projection.distance,
      e,
      hostHalf,
      half: frame.half,
      unionOuter,
      crossOuter,
      innerEdge: e - frame.half,
      dy,
      merged: removed !== null && shelfFree,
      apron: !!clip?.apron,
      removed,
      covered,
      dyEnds,
      Lends,
      frame,
    };
    cache.set(cacheKey, row);
    return row;
  }

  /** Refine one geometry-predicate transition to centimetre chainage. */
  _refineJunctionTransition(route, mouth, a, b, predicate, unwrap) {
    let lo = a;
    let hi = b;
    const stateLo = predicate(lo);
    for (let iteration = 0; iteration < 18 && Math.abs(hi.bS - lo.bS) > 0.005; iteration += 1) {
      const mid = this._junctionMouthRow(
        route,
        mouth,
        (lo.bS + hi.bS) * 0.5,
        (lo.hS + hi.hS) * 0.5,
      );
      if (!mid) break;
      mid.hU = unwrap(mid.hS);
      if (predicate(mid) === stateLo) lo = mid;
      else hi = mid;
    }
    const boundary = this._junctionMouthRow(
      route,
      mouth,
      (lo.bS + hi.bS) * 0.5,
      (lo.hS + hi.hS) * 0.5,
    ) || hi;
    boundary.hU = unwrap(boundary.hS);
    return boundary;
  }

  /**
   * Exact predicate bands bracketed by the audit rows. Sampling locates a
   * component; final boundaries are analytic mouth-geometry evaluations,
   * never render-frame stations or hand-tuned metre offsets.
   */
  _exactJunctionBands(route, mouth, rows, predicate, unwrap) {
    const bands = [];
    let start = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const active = predicate(row);
      if (active && !start) {
        start = index === 0 || predicate(rows[index - 1])
          ? row
          : this._refineJunctionTransition(route, mouth, rows[index - 1], row, predicate, unwrap);
      }
      if (!active && start) {
        const end = this._refineJunctionTransition(route, mouth, rows[index - 1], row, predicate, unwrap);
        bands.push({ start, end });
        start = null;
      }
    }
    if (start) bands.push({ start, end: rows[rows.length - 1] });
    return bands.map((band) => ({
      ...band,
      branch: [Math.min(band.start.bS, band.end.bS), Math.max(band.start.bS, band.end.bS)],
      host: [Math.min(band.start.hU, band.end.hU), Math.max(band.start.hU, band.end.hU)],
    }));
  }

  /**
   * ONE data-driven local representation per same-level merge/diverge —
   * the single source every consumer reads (asphalt already reads the
   * mouth clip, which is this envelope in per-frame detail; markings,
   * guardrails, traffic and the probes read the records built here), so
   * no subsystem guesses on its own where a junction begins or ends.
   *
   * Everything is measured from the actual route curves and widths:
   *   e          side-signed lateral of the branch centre in the host frame
   *   unionOuter side-signed outer edge of the paved union at that station
   *   innerEdge  side-signed hostward edge of the branch pavement
   *   dy         branch deck height above the host's banked deck
   *
   * Derived intervals (host or branch chainage; on a closed host they are
   * stored unwrapped around `hostRef` — use zone.hostContains):
   *   crossable         branch pavement continuous with the host (the
   *                     boundary a driver may cross)
   *   hostEdgeSuppress  host solid edge line suppressed (union wider than
   *                     the host, pavement continuous)
   *   dash              dashed lane-separation boundary (crossable AND the
   *                     merge/exit lane is usable), at host lateral dashLat
   *   hostRailOpen      host-side rail suppressed
   *   branchOuterRailOn branch outer rail forced on (it is the union's
   *                     outer edge through the zone)
   *   branchOuterRailOff branch outer rail forced off (thin-wing tail
   *                     where the host rail has resumed)
   *   branchInnerRailOff branch hostward rail forced off (crossable zone
   *                     and gore nose — no rail between joined lanes)
   */
  _prepareJunctionZones() {
    this.junctionZones = [];
    for (const route of this.routes.values()) {
      if (!route.junctionMouths) continue;
      for (const mouth of route.junctionMouths) {
        const host = mouth.host;
        const side = mouth.side;
        const which = mouth.which;
        const laneEdge = host.lanes * host.laneWidth * 0.5;
        const step = 4;
        const rows = [];
        let hostSeed = null;
        for (let s = 0; s <= mouth.span + step; s += step) {
          const bS = which === 'start'
            ? Math.min(s, route.length)
            : Math.max(0, route.length - s);
          const authoritativeRow = this._junctionMouthRow(route, mouth, bS, hostSeed);
          if (!authoritativeRow) continue;
          hostSeed = authoritativeRow.hS;
          rows.push(authoritativeRow);
        }
        if (rows.length < 2) {
          delete mouth._markingRowCache;
          continue;
        }
        // Unwrap host chainage around the zone middle so intervals on a
        // closed loop crossing station 0 stay contiguous.
        const hostRef = rows[Math.floor(rows.length / 2)].hS;
        const unwrap = (h) => {
          if (!host.closed) return h;
          let delta = h - hostRef;
          delta -= Math.round(delta / host.length) * host.length;
          return hostRef + delta;
        };
        for (const row of rows) row.hU = unwrap(row.hS);

        // A row is continuous when the drawn union is one surface there
        // (the clip removed a coplanar strip) AND the branch pavement
        // actually overlaps the host. The old |dy| < 1.5 re-derivation
        // called rows crossable where the renderer draws two separate
        // decks — markings, rails and the collision walk all disagreed
        // with the visible asphalt over those rows.
        const continuous = (r) => r.merged && r.innerEdge < r.hostHalf - 0.3;
        const range = (pred) => {
          let hLo = Infinity;
          let hHi = -Infinity;
          let bLo = Infinity;
          let bHi = -Infinity;
          for (const r of rows) {
            if (!pred(r)) continue;
            hLo = Math.min(hLo, r.hU);
            hHi = Math.max(hHi, r.hU);
            bLo = Math.min(bLo, r.bS);
            bHi = Math.max(bHi, r.bS);
          }
          return hLo <= hHi ? { host: [hLo, hHi], branch: [bLo, bHi] } : null;
        };
        // MOUTH-CONNECTED component: rows are ordered from the transfer
        // end outward, so the opening a driver can actually use is the
        // first contiguous continuous run. A later disjoint qualifying
        // stretch (decks re-converging further out) is not part of this
        // opening — one min/max over all rows used to smear intervals
        // across the non-crossable span between them.
        let c0 = -1;
        let c1 = -1;
        for (let i = 0; i < rows.length; i += 1) {
          if (continuous(rows[i])) { if (c0 < 0) c0 = i; c1 = i; } else if (c0 >= 0) break;
        }
        for (let i = 0; i < rows.length; i += 1) rows[i].crossable = c0 >= 0 && i >= c0 && i <= c1;
        const rangeIn = (pred) => {
          let hLo = Infinity;
          let hHi = -Infinity;
          let bLo = Infinity;
          let bHi = -Infinity;
          for (let i = c0; c0 >= 0 && i <= c1; i += 1) {
            const r = rows[i];
            if (!pred(r)) continue;
            hLo = Math.min(hLo, r.hU);
            hHi = Math.max(hHi, r.hU);
            bLo = Math.min(bLo, r.bS);
            bHi = Math.max(bHi, r.bS);
          }
          return hLo <= hHi ? { host: [hLo, hHi], branch: [bLo, bHi] } : null;
        };

        // Marking width uses unionOuter, not crossOuter, INSIDE the
        // crossable run: every row in [c0,c1] already cleared shelfFree
        // (<=0.35 m, the same test `merged`/`continuous` used to admit it
        // here), so crossOuter's extra 0.18 m lip veto can no longer be
        // distinguishing a genuine wing (that would already have failed
        // shelfFree and never reached this range) — on a shallow, truly
        // level merge taper it just re-tests noise in the dy interpolation
        // and flickers crossOuter back to hostHalf for stretches of rows
        // even while the paved union stays smoothly wide. That flicker
        // fragmented the open/dash interval down to a short window near
        // one end of the true taper, leaving the rest of the merge lane
        // marked by neither the host's suppressed edge nor a dash — the
        // gap the branch's own (still-drawn) edge line then filled,
        // duplicating/pre-empting the boundary tens of metres early.
        const crossable = rangeIn(() => true);
        const open = rangeIn((r) => r.unionOuter > r.hostHalf + 0.25);
        const dash = rangeIn((r) => r.unionOuter - laneEdge >= 2.0);

        // A-B marking opening: the exact mouth-connected component of the
        // SAME `continuous` predicate used by the rendered paved union. The
        // 4 m rows only bracket topology; bisection evaluates fresh analytic
        // mouth clips for the final cut points.
        // Refine only the mouth-connected component already located by
        // c0/c1. Solving every later, disconnected overlap component wasted
        // thousands of curve projections and could never affect this mouth.
        let openingBand = null;
        if (c0 >= 0) {
          const start = c0 === 0
            ? rows[c0]
            : this._refineJunctionTransition(route, mouth, rows[c0 - 1], rows[c0], continuous, unwrap);
          const end = c1 === rows.length - 1
            ? rows[c1]
            : this._refineJunctionTransition(route, mouth, rows[c1], rows[c1 + 1], continuous, unwrap);
          openingBand = {
            start,
            end,
            branch: [Math.min(start.bS, end.bS), Math.max(start.bS, end.bS)],
            host: [Math.min(start.hU, end.hU), Math.max(start.hU, end.hU)],
          };
        }
        let markingOpening = null;
        let openingRows = [];
        if (openingBand) {
          const envelopeRows = [
            openingBand.start,
            ...rows.filter((row) => row.bS > openingBand.branch[0] + 0.001
              && row.bS < openingBand.branch[1] - 0.001 && continuous(row)),
            openingBand.end,
          ];
          openingRows = envelopeRows;
          const hostValues = envelopeRows.map((row) => row.hU);
          openingBand.host = [Math.min(...hostValues), Math.max(...hostValues)];
          const lower = [];
          const upper = [];
          const envelope = [];
          for (const row of envelopeRows) {
            if (!row.removed) continue;
            const loPoint = this._deckPoint(row.frame, row.removed[0], 0.06);
            const hiPoint = this._deckPoint(row.frame, row.removed[1], 0.06);
            const pointOf = (point) => ({ x: point.x, y: point.y, z: point.z });
            lower.push(pointOf(loPoint));
            upper.push(pointOf(hiPoint));
            envelope.push({
              branchS: row.bS,
              hostS: row.hU,
              removed: [...row.removed],
              covered: row.covered ? [...row.covered] : null,
              lower: pointOf(loPoint),
              upper: pointOf(hiPoint),
            });
          }
          markingOpening = {
            exact: true,
            source: 'rendered-mouth-clip-connected-component',
            branch: [...openingBand.branch],
            host: [...openingBand.host],
            envelope,
            polygon: [...lower, ...upper.reverse()],
          };
        }

        const sameOpening = (band) => markingOpening
          && band.branch[1] >= markingOpening.branch[0] - 0.01
          && band.branch[0] <= markingOpening.branch[1] + 0.01;
        // The host's default solid edge is not an opening boundary. Suppress
        // it over the complete authoritative A-B component, including the
        // narrow nose/tail where the junction owner intentionally paints no
        // substitute. This also makes A/B themselves the only hand-off cuts.
        const hostEdgeSuppressPieces = markingOpening ? [[...markingOpening.host]] : [];
        const exactDashBands = this._exactJunctionBands(
          route, mouth, openingRows,
          (row) => continuous(row) && row.unionOuter - laneEdge >= 2.0,
          unwrap,
        ).filter(sameOpening);
        const dashPieces = exactDashBands.map((band) => ({ from: band.host[0], to: band.host[1] }));
        const hostEdgeSuppress = hostEdgeSuppressPieces.length
          ? [Math.min(...hostEdgeSuppressPieces.map((piece) => piece[0])), Math.max(...hostEdgeSuppressPieces.map((piece) => piece[1]))]
          : (markingOpening ? null : open?.host || null);
        const exactDash = dashPieces.length
          ? { from: Math.min(...dashPieces.map((piece) => piece.from)), to: Math.max(...dashPieces.map((piece) => piece.to)) }
          : (markingOpening ? null : (dash ? { from: dash.host[0], to: dash.host[1] } : null));
        // THE RAIL-BLOCKED BAND — one physical rule for every opening:
        // the host rail (footprint laterals [hostHalf - 0.42, hostHalf])
        // must not stand where the branch pavement reaches under it
        // (outer edge past hostHalf - 0.15) while the hostward edge has
        // not cleared it (innerEdge < hostHalf + 0.5), with the branch
        // surface inside the barrier's own height band (dy in
        // (-1.6, 1.35), the _barrierSuppressed window: an at-level
        // opening OR a second deck the rail must not pierce). This IS the
        // paved opening envelope; the old tip-tied intervals either ran
        // ~300 m past it or blanket-forced rail ACROSS the exit path.
        const railBlocked = (r) => r.dy < 1.35 && r.dy > -1.6
          && r.e + r.half > r.hostHalf - 0.15
          && r.innerEdge < r.hostHalf + 0.5;
        const bands = [];
        if (c0 >= 0) {
          for (let i = c0; i < rows.length; i += 1) {
            if (!railBlocked(rows[i])) continue;
            const band = { from: i, to: i };
            while (i + 1 < rows.length && railBlocked(rows[i + 1])) { i += 1; band.to = i; }
            bands.push(band);
          }
        }
        // the band reaching past the crossable interior owns the opening
        const band = bands.find((candidate) => candidate.to >= c1) || bands[bands.length - 1] || null;
        const bandInterval = band
          ? [Math.min(rows[band.from].hU, rows[band.to].hU) - 2, Math.max(rows[band.from].hU, rows[band.to].hU) + 2]
          : null;
        // Outer rail hand-off: the branch's own outer rail must switch ON
        // no later than the mouth-ward edge of the SAME rail-blocked band
        // that opens the host's rail (band.from) — both derive from one
        // physical row, so the hand-off happens at one envelope station
        // by construction. Deriving the branch tip from a separate,
        // stricter threshold (unionOuter past hostHalf by a full 0.6 m,
        // rather than railBlocked's 0.15 m) left a station range where the
        // host's rail had already opened (a real conflict, correctly
        // suppressed) but the branch's own outer rail had not yet turned
        // on — an unguarded 20-40 m gap along the outer edge with no rail
        // on either route. Where no band reaches the crossable interior
        // (no genuine conflict anywhere near the mouth) the old
        // union-width scan still marks the tip.
        let tipIndex = -1;
        if (band) {
          tipIndex = band.from;
        } else {
          for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].unionOuter >= rows[i].hostHalf + 0.6) { tipIndex = i; break; }
          }
        }
        const lastEngaged = rows.length - 1;
        const branchInterval = (a, b) => [Math.min(rows[a].bS, rows[b].bS), Math.max(rows[a].bS, rows[b].bS)];
        // Forced-on pieces, not one blind span to lastEngaged: on a route
        // whose data kinks back near the host well beyond the merge (the
        // documented steering-snap families), a second, disjoint engaged
        // stretch can appear deep in the approach with a genuinely CLEAR
        // gap in between (neither railBlocked nor a real wing) — forcing
        // "on" straight through that gap put the branch's outer rail
        // right where the host's own independently-visible rail already
        // stands nearby, doubling up (measured: a genuinely clear 2-row
        // gap is exactly where the host's own rail flickers back on for
        // one sample, so even bridging a short gap re-created the
        // doubling — every clear row splits the run and the per-frame
        // probe decides in between). railBlocked alone (not OR'd with a
        // bare width threshold) is the engagement test: its own dy gate
        // already excludes a wing that has genuinely separated onto
        // another deck, which a plain union-width check does not.
        const engaged = railBlocked;
        const onPieces = [];
        if (tipIndex >= 0) {
          let runFrom = null;
          for (let i = tipIndex; i <= lastEngaged; i += 1) {
            if (engaged(rows[i])) {
              if (runFrom === null) runFrom = i;
            } else if (runFrom !== null) {
              onPieces.push(branchInterval(runFrom, i - 1));
              runFrom = null;
            }
          }
          if (runFrom !== null) onPieces.push(branchInterval(runFrom, lastEngaged));
        }
        const outerOn = tipIndex >= 0 ? { branch: branchInterval(tipIndex, lastEngaged), pieces: onPieces } : null;
        const outerOff = tipIndex > 0 ? { branch: branchInterval(0, tipIndex - 1) } : (tipIndex < 0 ? { branch: branchInterval(0, lastEngaged) } : null);
        const innerOff = range((r) => r.innerEdge < r.hostHalf + 0.9 && Math.abs(r.dy) < 2.5);
        let hostRailOpen = null;
        let hostRailOn = null;
        if (crossable && bandInterval) {
          hostRailOpen = bandInterval;
          // Force the rail ON through the covered interior (where the yield
          // probe sees the buried branch corridor and would wrongly kill the
          // widened host edge's rail), from 15 m mouthward of the transfer
          // up to the opening. Outward of the opening the exact point probe
          // rules: a wing still overlapping the host there is a real second
          // deck the rail must not pierce ('off' wins inside the opening).
          const interiorEnds = [rows[c0].hU, rows[band.from].hU];
          const mouthward = rows[c0].hU <= rows[c1].hU ? -15 : 15;
          hostRailOn = [
            Math.min(interiorEnds[0] + mouthward, interiorEnds[1]),
            Math.max(interiorEnds[0] + mouthward, interiorEnds[1]),
          ];
          if (hostRailOn[1] - hostRailOn[0] < 1) hostRailOn = null;
        } else if (crossable) {
          // branch never blocks the rail line — keep the edge guarded
          // through the union (the yield probe would kill it over the
          // buried corridor)
          hostRailOn = [crossable.host[0] - 15, crossable.host[1] + 15];
        }

        // Branch-frame lateral sign pointing at the host, measured (the
        // edge whose projection sits deeper inside the host) — a branch
        // can wander across the host centreline, so -side is not reliable.
        const midRow = rows[Math.floor(rows.length / 2)];
        const midFrame = this._frameAt(route, midRow.bS);
        const plusDepth = Math.abs(this._projectToRoute(host, this._deckPoint(midFrame, midFrame.half)).signedLateral);
        const minusDepth = Math.abs(this._projectToRoute(host, this._deckPoint(midFrame, -midFrame.half)).signedLateral);
        const branchHostward = plusDepth < minusDepth ? 1 : -1;

        const zone = {
          id: `J${this.junctionZones.length}:${mouth.kind}:${host.id}:${route.id}:${which}`,
          kind: mouth.kind,
          which,
          side,
          hostwardSign: branchHostward,
          host,
          branch: route,
          hostRef,
          laneEdge,
          dashLat: side * laneEdge,
          samples: rows,
          branchSpan: [Math.min(rows[0].bS, rows[rows.length - 1].bS), Math.max(rows[0].bS, rows[rows.length - 1].bS)],
          hostSpan: crossable ? crossable.host : null,
          crossable,
          markingOpening,
          hostEdgeSuppress,
          hostEdgeSuppressPieces,
          dash: exactDash,
          dashPieces,
          hostRailOpen,
          hostRailOn,
          branchOuterRailOn: outerOn ? outerOn.branch : null,
          branchOuterRailOnPieces: outerOn ? outerOn.pieces : null,
          branchOuterRailOff: outerOff ? outerOff.branch : null,
          branchInnerRailOff: innerOff ? innerOff.branch : null,
          hostContains(interval, h) {
            if (!interval) return false;
            let value = h;
            if (host.closed) {
              let delta = value - hostRef;
              delta -= Math.round(delta / host.length) * host.length;
              value = hostRef + delta;
            }
            return value >= interval[0] && value <= interval[1];
          },
        };
        const branchDividers = this._laneDividerOffsets(route);
        const hostDividers = this._laneDividerOffsets(host);
        zone.markingBoundaries = [
          {
            id: `${zone.id}:branch-host-edge`,
            physicalBoundary: 'branch edge facing host',
            route: route.id,
            lateral: branchHostward,
            interval: markingOpening?.branch || null,
            outsideOwner: `route:${route.id}`,
            openingOwner: 'none',
            reason: 'edge disappears into one crossable paved union',
          },
          {
            id: `${zone.id}:branch-outer-edge`,
            physicalBoundary: 'outer edge of paved union',
            route: route.id,
            lateral: -branchHostward,
            interval: markingOpening?.branch || null,
            outsideOwner: `route:${route.id}`,
            openingOwner: `route:${route.id}`,
            reason: 'separated physical road edge remains visible',
          },
          ...branchDividers.map((lateral, index) => ({
            id: `${zone.id}:branch-divider:${index}`,
            physicalBoundary: `branch lane divider ${index}`,
            route: route.id,
            lateral,
            interval: markingOpening?.branch || null,
            outsideOwner: `route:${route.id}`,
            openingOwner: 'none',
            reason: 'route-local lane topology is absorbed by the junction union',
          })),
          ...hostDividers.map((lateral, index) => ({
            id: `${zone.id}:host-divider:${index}`,
            physicalBoundary: `host lane divider ${index}`,
            route: host.id,
            lateral,
            interval: markingOpening?.host || null,
            outsideOwner: `route:${host.id}`,
            openingOwner: `route:${host.id}`,
            reason: 'unrelated host lane boundary continues through the opening',
          })),
          {
            id: `${zone.id}:host-edge`,
            physicalBoundary: 'host outer edge facing branch',
            route: host.id,
            lateral: side,
            interval: hostEdgeSuppress,
            pieces: hostEdgeSuppressPieces.map((piece) => [...piece]),
            outsideOwner: `route:${host.id}`,
            openingOwner: dashPieces.length ? `junction:${zone.id}` : 'none',
            reason: dashPieces.length
              ? 'junction owns the broken merge boundary'
              : 'legal opening has no solid edge marking',
          },
        ];
        this.junctionZones.push(zone);
        mouth.zone = zone;
        if (!host._zonesAsHost) host._zonesAsHost = [];
        host._zonesAsHost.push(zone);
        if (!route._zonesAsBranch) route._zonesAsBranch = [];
        route._zonesAsBranch.push(zone);
        if (markingOpening) {
          if (!route._markingOpeningCuts) route._markingOpeningCuts = [];
          route._markingOpeningCuts.push(...markingOpening.branch);
          route._markingOpeningCuts.sort((left, right) => left - right);
        }

        // Rail ownership intervals for the barrier builder. Modes: 'off'
        // (opening — never draw), 'on' (the union's outer edge — always
        // draw, overriding the yield probe that used to kill a ramp's
        // outer rail 1.6 m before the pavements even met). 'off' wins.
        this._addRailZone(host, side, zone.hostRailOpen, 'off');
        this._addRailZone(host, side, zone.hostRailOn, 'on');
        this._addRailZone(route, branchHostward, zone.branchInnerRailOff, 'off');
        if (zone.branchOuterRailOnPieces) {
          for (const piece of zone.branchOuterRailOnPieces) this._addRailZone(route, -branchHostward, piece, 'on');
        } else {
          this._addRailZone(route, -branchHostward, zone.branchOuterRailOn, 'on');
        }
        this._addRailZone(route, -branchHostward, zone.branchOuterRailOff, 'off');
        // Bisection rows are build-time scratch. The zone retains only plain
        // intervals/envelope points, so do not pin thousands of frame/vector
        // objects for the lifetime of the map.
        delete mouth._markingRowCache;
      }
    }
  }

  /** Register a rail ownership interval (chainage pieces) on a route side. */
  _addRailZone(route, sideSign, interval, mode) {
    if (!interval) return;
    if (!route._railZones) route._railZones = { 1: [], [-1]: [] };
    for (const [from, to] of this._zoneIntervalPieces(route, interval)) {
      route._railZones[sideSign].push({ from, to, mode });
    }
  }

  /**
   * Rail visibility per surface frame per side, with the decision source:
   * zone ownership intervals where a junction zone claims the edge, the
   * ~9 m-cached point probe elsewhere. Also records the visible RUNS per
   * side on route._railRuns (chainage + end laterals + causes of the cuts)
   * so the guardrail probe audits exactly what the builder drew.
   */
  _computeBarrierVisibility(route) {
    const frames = route.surfaceFrames;
    const barrierVisible = { 1: new Array(frames.length), [-1]: new Array(frames.length) };
    const causes = { 1: new Array(frames.length), [-1]: new Array(frames.length) };
    // Every frame probes EXACTLY. The old ~9 m verdict cache smeared stale
    // results past the true suppression boundary (ragged 20-30 m holes
    // near junction mouths) and skipped conflicts narrower than its
    // radius (rails left standing across a crossing deck).
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i];
      for (const side of [1, -1]) {
        const mode = this._railZoneMode(route, side, frame.distance);
        let visible;
        let cause;
        if (mode === 'off') { visible = false; cause = 'zone-off'; }
        else if (mode === 'on') { visible = true; cause = 'zone-on'; }
        else {
          const probe = this._deckPoint(frame, this._surfaceEdgeLateral(frame, side, 0.42), 0.02);
          visible = !this._barrierSuppressed(probe, route);
          cause = visible ? 'probe-on' : 'probe-off';
        }
        barrierVisible[side][i] = visible;
        causes[side][i] = cause;
      }
    }
    route._railRuns = { 1: [], [-1]: [] };
    for (const side of [1, -1]) {
      let run = null;
      for (let i = 0; i < frames.length; i += 1) {
        if (barrierVisible[side][i]) {
          if (!run) run = {
            from: frames[i].distance,
            fromIndex: i,
            fromHalf: Math.abs(this._surfaceEdgeLateral(frames[i], side)),
          };
          run.to = frames[i].distance;
          run.toIndex = i;
          run.toHalf = Math.abs(this._surfaceEdgeLateral(frames[i], side));
        } else if (run) {
          run.cutCause = causes[side][i];
          route._railRuns[side].push(run);
          run = null;
        }
      }
      if (run) route._railRuns[side].push(run);
      // why each gap between runs exists (cause at the first hidden frame)
      route._railRuns[side].gapCauses = causes[side];
    }
    return barrierVisible;
  }

  /** Zone-forced rail mode at a chainage ('off' | 'on' | null = probe). */
  _railZoneMode(route, sideSign, distance) {
    const hostTransitions = route._progressiveTransitionsAsHost;
    if (hostTransitions) {
      for (const transition of hostTransitions) {
        if (transition.sideSign === sideSign && transition.containsHost(distance, 0.01)) {
          return transition.hostRailModeAt?.(distance) || 'on';
        }
      }
    }
    const branchTransitions = route._progressiveTransitionsAsBranch;
    if (branchTransitions) {
      for (const transition of branchTransitions) {
        const explicitMode = transition.branchRailModeAt?.(distance, sideSign);
        if (explicitMode) return explicitMode;
        const phase = transition.phaseAtBranch(distance);
        if (!phase) continue;
        if (transition.type === 'merge' && phase !== 'approach') return 'off';
        if (transition.type === 'diverge' && (phase === 'approach' || phase === 'opening' || phase === 'parallel')) return 'off';
      }
    }
    const zones = route._railZones?.[sideSign];
    if (!zones) return null;
    let mode = null;
    for (const zone of zones) {
      if (distance < zone.from || distance > zone.to) continue;
      if (zone.mode === 'off') return 'off';
      mode = zone.mode;
    }
    return mode;
  }

  /**
   * Junction-mouth clip record for one branch surface/render frame, cached
   * on the frame. null = draw the cross-section untouched. Otherwise the
   * record lists the DRAWN lateral intervals of the cross-section (at most
   * two — the wing outside the removed strip and, when the decks scissor,
   * a lifted shelf on the far side), each with optional flap vertices that
   * skirt the interval's cut edge down under the host surface. `skip`
   * means the host covers the whole section.
   *
   * The removed strip is exactly {inside the host's paved extent} ∩
   * {|Δy to the host surface| < COPLANAR}: the coplanar duplicate. Parts
   * of the section vertically clear of the host (a ramp lifting away, a
   * stacked deck, a buried sheet) are real geometry and stay drawn.
   */
  _mouthClipAt(route, frame) {
    if (frame._jx !== undefined) return frame._jx;
    frame._jx = null;
    const mouths = route.junctionMouths;
    if (!mouths) return null;
    const mouth = mouths.find((candidate) => (candidate.which === 'start'
      ? frame.distance <= candidate.span
      : frame.distance >= route.length - candidate.span));
    if (!mouth) return null;
    const host = mouth.host;
    const half = frame.half;
    const completedMerge = (route._progressiveTransitionsAsBranch || []).find((transition) => {
      if (transition.topology !== '2+3-merge') return false;
      const hostS = transition.hostAtBranch(frame.distance);
      return hostS !== null && hostS >= transition.fiveLaneStart - 1e-4;
    });
    if (completedMerge) {
      // At FULL 5 the ramp's real lane centres have reached the two appended
      // slots. From this exact handoff onward the progressive host envelope
      // is the sole pavement owner; retaining the old source ribbon would
      // reintroduce two phantom lanes underneath the downstream 5→4→3 taper.
      frame._jx = {
        mouth,
        hostward: completedMerge.sourceZone.hostwardSign,
        skip: true,
        intervals: [],
        progressive: completedMerge.id,
        removed: [-half, half],
      };
      return frame._jx;
    }

    // Signed distance of a cross-section point OUTSIDE the host's paved
    // edge (g < 0 = inside the host surface), plus the vertical gap to the
    // host's banked deck there. Side-agnostic on purpose: a lane-aligned
    // branch can drift across the host centreline (or a lifting 2-lane
    // ramp can lean over the "wrong" side for a stretch), and the old
    // side-signed distance then reported points far PAST the opposite
    // paved edge as deeply inside — clipping real wing surface into holes.
    const measure = (lateral) => {
      const point = this._deckPoint(frame, lateral);
      const projection = this._projectToRoute(host, point, this._hostSeedIndex(host, frame._jxSeed));
      frame._jxSeed = projection.distance;
      const hostHalf = this._halfWidthAt(host, projection.distance);
      const progressive = this._progressiveEnvelopeAt(host, projection.distance);
      const lower = progressive?.envelope.lateralMin ?? -hostHalf;
      const upper = progressive?.envelope.lateralMax ?? hostHalf;
      const bank = this._bankAt(host, projection.distance);
      const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral;
      let outside;
      if (projection.signedLateral < lower) outside = lower - projection.signedLateral;
      else if (projection.signedLateral > upper) outside = projection.signedLateral - upper;
      else outside = -Math.min(projection.signedLateral - lower, upper - projection.signedLateral);
      return {
        L: projection.signedLateral,
        H: hostHalf,
        lower,
        upper,
        progressive: progressive?.transition || null,
        g: outside,
        dy: point.y - deckY,
        overshoot: projection.endOvershoot,
      };
    };
    const lo = measure(-half);
    const hi = measure(half);
    if (lo.overshoot > 2 || hi.overshoot > 2) return null;
    const hostward = hi.g < lo.g ? 1 : -1;
    const inner = hostward > 0 ? hi : lo;   // cross-section end nearer the host centre
    // dy is locally linear across the short cross-section
    const latForDy = (dy) => {
      if (Math.abs(hi.dy - lo.dy) < 1e-6) return null;
      return -half + ((dy - lo.dy) / (hi.dy - lo.dy)) * (2 * half);
    };
    // Signed-linear "outside the pavement" distance on the section's own
    // side of the host — only used by the apron path, where the section is
    // fully outside and therefore cannot straddle the host centreline.
    const sideSign = (hostward > 0 ? hi.L : lo.L) >= 0 ? 1 : -1;
    const gSide0 = sideSign * lo.L - (sideSign > 0 ? lo.upper : -lo.lower);
    const gSide1 = sideSign * hi.L - (sideSign > 0 ? hi.upper : -hi.lower);
    const latForG = (g) => {
      if (Math.abs(gSide1 - gSide0) < 1e-6) return null;
      return -half + ((g - gSide0) / (gSide1 - gSide0)) * (2 * half);
    };
    // Flap vertex: at `lat`, hug the host surface from just below.
    const flapVertex = (rawLat) => {
      if (rawLat === null) return null;
      const lat = clamp(rawLat, -half - 3, half + 3); // ill-conditioned crossings stay local
      const gauge = measure(lat);
      const point = this._deckPoint(frame, lat);
      point.y = (point.y - gauge.dy) - 0.06; // host deck surface − 6 cm (clear of the z-fight band)
      return { lat, point };
    };

    // |dy| below which host/branch decks are one surface. Wide enough that
    // the linear endpoint interpolation of dy across the section (true dy
    // curves with bank/projection differences) cannot leave drawn strips
    // grazing the host within the z-fight band.
    // A progressive transition owns one shared host plane. It may absorb a
    // source branch whose centre plane is still easing by up to 0.75 m; its
    // cut flap lands on the host plane, and physics defers to the same host
    // envelope. Legacy mouths retain the exact 0.18 m coplanar tolerance.
    const progressiveOwner = lo.progressive || hi.progressive;
    const COPLANAR = progressiveOwner ? 0.75 : 0.18;
    const TUCK = 0.35;      // how far a cut edge slides under the host surface
    const GORE_FILL = 1.2;  // widest sliver the gore apron closes
    const APRON_DY = 0.35;  // largest level offset the apron may bridge

    if (inner.g >= 0 && lo.L * hi.L >= 0) {
      // Fully outside the host pavement ON ONE SIDE: close the gore
      // sliver while the gap is narrow and the decks are still at one
      // level. The apron fades back to the branch's own edge as the gap
      // or level offset grows, so the fill closes smoothly instead of
      // ending in a face. (A section whose two ends sit outside OPPOSITE
      // host edges — a branch wider than its host — is a straddle, not a
      // gore: it falls through to the exact covered-strip clip below,
      // which otherwise never ran and left a full-width coplanar ribbon
      // z-fighting over the host.)
      const separation = inner.g;
      if (separation >= GORE_FILL || Math.abs(inner.dy) >= APRON_DY) return null;
      let width = clamp((GORE_FILL - separation) / 0.35, 0, 1);
      width *= clamp((APRON_DY - Math.abs(inner.dy)) / 0.15, 0, 1);
      if (width <= 0.02) return null;
      const flap = flapVertex(latForG(-TUCK * width + separation * (1 - width)));
      if (!flap) return null;
      const interval = hostward > 0
        ? { lo: -half, hi: half, flapLo: null, flapHi: flap }
        : { lo: -half, hi: half, flapLo: flap, flapHi: null };
      frame._jx = { mouth, hostward, skip: false, apron: true, intervals: [interval] };
      return frame._jx;
    }

    // Removed strip R = {covered by host pavement} ∩ {|dy| < COPLANAR}.
    // Covered = {|L(t)| ≤ H(t)} solved exactly as two linear constraints
    // (L−H ≤ 0 and L+H ≥ 0): a lane-aligned branch can lie fully inside
    // the host or straddle its centreline, where any single-root cut
    // misclassifies half the section (drawn coplanar sheets or holes).
    let tMin = 0;
    let tMax = 1;
    const clipConstraint = (f0, f1, keepNegative) => {
      const s0 = keepNegative ? f0 : -f0;
      const s1 = keepNegative ? f1 : -f1; // want s ≤ 0
      if (s0 > 0 && s1 > 0) { tMin = 1; tMax = 0; return; }
      if (s0 <= 0 && s1 <= 0) return;
      const root = s0 / (s0 - s1);
      if (s0 > 0) tMin = Math.max(tMin, root);
      else tMax = Math.min(tMax, root);
    };
    clipConstraint(lo.L - lo.upper, hi.L - hi.upper, true);
    clipConstraint(lo.lower - lo.L, hi.lower - hi.L, true);
    if (tMin >= tMax) return null; // host covers none of the section
    const coveredLo = -half + tMin * 2 * half;
    const coveredHi = -half + tMax * 2 * half;
    // Deck-overlap gauge for physics/zone consumers: the host-covered
    // lateral band and the (locally linear) branch-above-host offsets at
    // the section ends. Recorded even when nothing ends up coplanar —
    // a buried or shelving sheet still overlaps the host, and surface
    // ownership must know about it.
    frame._jxGauge = {
      mouth,
      covered: [coveredLo, coveredHi],
      dyEnds: [lo.dy, hi.dy],
      Lends: [lo.L, hi.L],
      half,
    };
    let planarLo = -half;
    let planarHi = half;
    if (Math.abs(hi.dy - lo.dy) < 1e-6) {
      if (Math.abs(lo.dy) >= COPLANAR) planarLo = half; // nowhere coplanar
    } else {
      const rootA = latForDy(-COPLANAR);
      const rootB = latForDy(COPLANAR);
      planarLo = Math.max(planarLo, Math.min(rootA, rootB));
      planarHi = Math.min(planarHi, Math.max(rootA, rootB));
    }
    const removedLo = Math.max(coveredLo, planarLo);
    const removedHi = Math.min(coveredHi, planarHi);
    if (removedHi - removedLo < 0.05) return null; // nothing coplanar-covered

    const intervals = [];
    if (removedLo - (-half) > 0.25) {
      const flapWidth = Math.min(TUCK, removedHi - removedLo);
      intervals.push({
        lo: -half,
        hi: removedLo,
        flapLo: null,
        flapHi: flapVertex(removedLo + flapWidth),
      });
    }
    if (half - removedHi > 0.25) {
      const flapWidth = Math.min(TUCK, removedHi - removedLo);
      intervals.push({
        lo: removedHi,
        hi: half,
        flapLo: flapVertex(removedHi - flapWidth),
        flapHi: null,
      });
    }
    frame._jx = {
      mouth,
      hostward,
      skip: intervals.length === 0,
      intervals,
      progressive: progressiveOwner?.id || null,
      // Coplanar strip handed to the host deck (frame laterals) — the
      // authoritative "these decks are one surface here" record that
      // junction zones and physics consume, so crossability, collision
      // and the drawn union can never disagree.
      removed: [removedLo, removedHi],
    };
    return frame._jx;
  }

  /** Sample-index seed for host projections near a known host distance. */
  _hostSeedIndex(host, distance) {
    if (!Number.isFinite(distance) || !host.samples.length) return null;
    const spacing = host.length / host.samples.length;
    const index = Math.round(distance / Math.max(1e-6, spacing));
    return clamp(index, 0, host.samples.length - 1);
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
      const baseHalf = this._halfWidthAt(route, projection.distance);
      const progressive = this._progressiveEnvelopeAt(route, projection.distance);
      const lateralMin = progressive?.envelope.lateralMin ?? -baseHalf;
      const lateralMax = progressive?.envelope.lateralMax ?? baseHalf;
      const half = Math.max(Math.abs(lateralMin), Math.abs(lateralMax));
      if (projection.signedLateral < lateralMin - lateralMargin - 14
        || projection.signedLateral > lateralMax + lateralMargin + 14) continue;
      // Past an OPEN end the corridor no longer exists (the continuation
      // route's corridor takes over); past a CLOSED end the end wall
      // correction still applies, so keep the corridor.
      if (projection.endOvershoot > 4
        && this._endIsOpen(route, projection.u > 0.5 ? 1 : -1)) continue;
      // Junction mouth: where the drawn cross-section strip was handed to
      // the host deck (coplanar duplicate removed), the branch has no
      // surface of its own — the host corridor owns physics there, same
      // as it owns the visible asphalt.
      if (route._zonesAsBranch
        && this._surfaceDefersToHost(route, projection.distance, projection.signedLateral)) continue;
      const bank = this._bankAt(route, projection.distance);
      const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral
        + this._progressiveBranchDeckOffsetAt(route, projection.distance, projection.signedLateral);
      const vertical = position.y - deckY;
      if (vertical < -verticalWindow || vertical > verticalWindow + 2.5) continue;
      corridors.push({
        route, projection, half, baseHalf, lateralMin, lateralMax,
        transition: progressive?.transition || null,
        bank, deckY, vertical,
        absLateral: Math.abs(projection.signedLateral),
      });
    }
    return corridors;
  }

  /**
   * TRUE when the drawn asphalt at this branch station/lateral is the
   * HOST's deck: the junction-zone row nearest the station shows the
   * lateral inside the host-covered band with the branch deck at or
   * below the host's top surface (a removed coplanar strip or a buried
   * sheet — neither carries the car; the host's surface is the road).
   * A shelf rising above the host keeps its own corridor. Uses the
   * precomputed zone rows — no projections at query time.
   */
  _surfaceDefersToHost(route, distance, lateral) {
    for (const zone of route._zonesAsBranch) {
      const [b0, b1] = zone.branchSpan;
      if (distance < b0 - 2 || distance > b1 + 2) continue;
      if (zone.progressive) {
        const hostS = zone.progressive.hostAtBranch(distance);
        const phase = hostS === null ? null : zone.progressive.phaseAt(hostS);
        // During approach the branch is still an independent carriageway.
        // Once the opening begins, hand a point to the host only after the
        // widened envelope contains a full vehicle footprint around it. The
        // renderer keeps the branch's outside wing wherever that is not yet
        // true, so collision follows the same visible surface union instead
        // of putting an invisible wall through the source lane centre.
        if (hostS !== null && phase === 'approach' && zone.progressive.type === 'merge') return false;
        if (hostS !== null && zone.progressive.topology === '2+3-merge'
          && hostS >= zone.progressive.fiveLaneStart - 1e-4) {
          // Visible ramp geometry terminates at the same full-five handoff.
          // Collision must not resurrect that source corridor as the host
          // envelope subsequently absorbs its two temporary lanes.
          return true;
        }
        if (hostS !== null) {
          const frame = this._frameAt(route, distance);
          const point = this._deckPoint(frame, lateral);
          const projection = this._projectToRoute(zone.host, point, this._hostSeedIndex(zone.host, hostS));
          const envelope = zone.progressive.envelopeAt(projection.distance);
          const bank = this._bankAt(zone.host, projection.distance);
          const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral;
          const handoffInset = 1.35;
          if (projection.signedLateral > envelope.lateralMin + handoffInset
            && projection.signedLateral < envelope.lateralMax - handoffInset
            && point.y - deckY < 0.8) return true;
        }
        // The progressive record is authoritative for this interval. If its
        // host envelope cannot own the full footprint yet, retain the branch
        // corridor instead of falling through to the narrower legacy clip.
        return false;
      }
      let best = null;
      let bestDelta = Infinity;
      for (const row of zone.samples) {
        const delta = Math.abs(row.bS - distance);
        if (delta < bestDelta) { bestDelta = delta; best = row; }
      }
      if (!best?.covered || lateral <= best.covered[0] || lateral >= best.covered[1]) continue;
      const t = (lateral + best.half) / (2 * best.half);
      const dy = best.dyEnds[0] + (best.dyEnds[1] - best.dyEnds[0]) * t;
      // On a section that IS partially merged (a strip was removed), the
      // whole covered band within the renderer's one-level tolerance
      // (APRON_DY) rides the host: the leftover slivers hovering under
      // 0.35 m are cosmetic ghosts, not decks. A section with NO strip
      // keeps its corridor unless it is buried — a full-width ribbon
      // above the host is a real second deck and carries the car.
      if (dy < (best.removed ? 0.35 : 0.18)) return true;
    }
    return false;
  }

  /**
   * Is a lateral position within the drivable band of a corridor?
   * Returns 0 when free, otherwise the signed lateral correction needed.
   */
  _lateralCorrection(corridor, lateral, radius) {
    const route = corridor.route;
    const inset = Math.max(0.35, radius);
    if (corridor.transition) {
      const minimum = corridor.lateralMin + inset;
      const maximum = corridor.lateralMax - inset;
      if (lateral < minimum) return minimum - lateral;
      if (lateral > maximum) return maximum - lateral;
      return 0;
    }
    const outer = Math.max(0.4, corridor.half - inset);
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
    const onSurface = projection.signedLateral >= (best.lateralMin ?? -best.half) - 0.3
      && projection.signedLateral <= (best.lateralMax ?? best.half) + 0.3
      && Math.abs(best.vertical) < 5.5;
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
      lateralMin: best.lateralMin ?? -best.half,
      lateralMax: best.lateralMax ?? best.half,
      transitionId: best.transition?.id || null,
      edgeDistance: Math.min(
        projection.signedLateral - (best.lateralMin ?? -best.half),
        (best.lateralMax ?? best.half) - projection.signedLateral,
      ),
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
      minLateral: route.bidirectional ? side * innerLimit : (info.lateralMin ?? -outerLimit) + vehicleRadius,
      maxLateral: route.bidirectional ? side * outerLimit : (info.lateralMax ?? outerLimit) - vehicleRadius,
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
      if (edge.kind === 'merge') {
        // lane-aligned hand-off: branch lane L sits ON host lane base + L
        laneIndex = edge.mergeLaneBase !== undefined
          ? edge.mergeLaneBase + laneIndex
          : (edge.mergeLane ?? nextRoute.lanes - 1);
      }
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
      ? (edge.mergeLaneBase !== undefined
        ? edge.mergeLaneBase + (laneRef.laneIndex ?? 0)
        : (edge.mergeLane ?? nextRoute.lanes - 1))
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

    // Mid-route diverge: only from the outermost lane ON THE EXIT'S SIDE
    // (a left exit takes left-lane vehicles — the old outermost-right gate
    // sent cars snapping across the full carriageway at left diverges),
    // seeded per vehicle+edge. They land in the branch's matching lane.
    if (route.traffic && travel > 0) {
      const s1 = s0 + travel * direction;
      for (const edge of this.edges) {
        if (edge.kind !== 'diverge' || edge.probability <= 0) continue;
        if (edge.from.routeId !== route.id || edge.from.direction !== direction) continue;
        const exitLane = (edge.side ?? -1) > 0 ? 0 : route.lanes - 1;
        if (laneIndex !== exitLane) continue;
        const d = edge.from.distance;
        const crossed = direction > 0 ? (s0 < d && s1 >= d) : (s0 > d && s1 <= d);
        if (!crossed) continue;
        const targetRoute = this.routes.get(edge.to.routeId);
        if (!targetRoute?.traffic) continue;
        const hash = ((vehicle?.poolIndex ?? 0) * 2654435761 + Math.floor(d)) >>> 0;
        if ((hash % 1000) / 1000 >= edge.probability) continue;
        const overrun = Math.abs(s1 - d);
        const landingLane = (edge.side ?? -1) > 0 ? 0 : targetRoute.lanes - 1;
        const sample = this.sampleLane(targetRoute.id, edge.to.distance + overrun, landingLane, edge.to.direction);
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

  /** Push a single triangle a→b→c (junction mouth apexes). */
  _pushTri(bucket, a, b, c) {
    const start = bucket.positions.length / 3;
    bucket.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    bucket.uvs.push(0, 0, 1, 0, 1, 1);
    bucket.indices.push(start, start + 1, start + 2);
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
    this._prepareJunctionMouths();
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
      route,
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
      const startPoints = [-1, 0, 1].map((side) => this._deckPoint(a,
        side === 0 ? 0 : this._surfaceEdgeLateral(a, side)));
      const endPoints = [-1, 0, 1].map((side) => this._deckPoint(b,
        side === 0 ? 0 : this._surfaceEdgeLateral(b, side)));
      for (const sample of samples) {
        for (let track = 0; track < 3; track += 1) {
          const side = track - 1;
          const analytic = this._deckPoint(sample.frame,
            side === 0 ? 0 : this._surfaceEdgeLateral(sample.frame, side));
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
  _progressiveBranchDeckOffsetAt(route, distance, lateral) {
    const transitions = route?._progressiveTransitionsAsBranch;
    if (!transitions) return 0;
    let offset = 0;
    for (const transition of transitions) offset += transition.branchDeckOffsetAt(distance, lateral);
    return offset;
  }

  _deckPoint(frame, lateral, lift = 0) {
    const point = frame.position.clone().addScaledVector(frame.normal, lateral);
    point.y += Math.tan(frame.bank) * lateral;
    // The source route eases onto/off the authoritative host plane over the
    // shared transition phases. This removes the sub-metre shelf that would
    // otherwise remain when two audited centrelines meet at slightly
    // different bank/elevation samples.
    point.y += this._progressiveBranchDeckOffsetAt(frame.route, frame.distance, lateral);
    point.y += lift;
    return point;
  }

  /** Signed room from a marking path to the current one-sided paved edge. */
  _markingClearance(frame, lateral, halfWidth) {
    const progressive = frame.route
      ? this._progressiveEnvelopeAt(frame.route, frame.distance)
      : null;
    const lower = progressive?.envelope.lateralMin ?? -frame.half;
    const upper = progressive?.envelope.lateralMax ?? frame.half;
    return Math.min(
      lateral - lower - 0.3 - halfWidth,
      upper - lateral - 0.3 - halfWidth,
    );
  }

  /**
   * Diagnostic membership of a route-local span in the shared junction-zone
   * model. Kept behind `markingDebug`: production rendering pays no cost.
   */
  _markingDebugContext(route, sFrom, sTo) {
    const memberships = [];
    for (const zone of route._zonesAsBranch || []) {
      const interval = zone.crossable?.branch;
      if (!interval || sTo < interval[0] || sFrom > interval[1]) continue;
      memberships.push({ zoneId: zone.id, role: 'branch', opening: 'crossable' });
    }
    for (const zone of route._zonesAsHost || []) {
      if (!zone.crossable?.host) continue;
      const intersects = this._zoneIntervalPieces(route, zone.crossable.host)
        .some(([from, to]) => sTo >= from && sFrom <= to);
      if (intersects) memberships.push({ zoneId: zone.id, role: 'host', opening: 'crossable' });
    }
    return {
      junctionZoneIds: memberships.map((entry) => entry.zoneId),
      junctionMemberships: memberships,
      intersectsTrueOpening: memberships.length > 0,
    };
  }

  /**
   * Exact clipping for marking paths on a branch mouth. The intended path is
   * split at the geometry-refined A/B stations before any quad is emitted;
   * surviving/suppressed pieces are independent.
   */
  _paintMouthStripSegment(route, materialName, a, b, segStart, segEnd, lo, hi, lateralAt, width, lift) {
    const halfWidth = width * 0.5;
    const sampleOf = (value) => {
      if (typeof value === 'number') {
        return { lateral: value, intendedLateral: value, suppressionReason: null, zoneId: null };
      }
      if (value && typeof value === 'object') {
        return {
          ...value,
          intendedLateral: value.intendedLateral ?? value.lateral,
        };
      }
      return {
        lateral: null,
        intendedLateral: null,
        suppressionReason: 'marking-path-undefined',
        zoneId: null,
      };
    };
    const stateAt = (distance, knownFrame = null) => {
      const frame = knownFrame || this._frameAt(route, distance);
      if (!knownFrame) frame.distance = distance;
      const sample = sampleOf(lateralAt(frame));
      let allowed = sample.lateral !== null;
      let reason = sample.suppressionReason;
      const intended = sample.intendedLateral;
      if (intended === null) {
        allowed = false;
        reason ||= 'marking-path-undefined';
      } else if (this._markingClearance(frame, intended, halfWidth) < 0) {
        allowed = false;
        reason = 'outside-route-paved-width';
      }
      return {
        distance,
        frame,
        intended,
        allowed,
        reason: reason || null,
        zoneId: sample.zoneId || null,
      };
    };

    // A/B have already been solved from the authoritative mouth geometry.
    // Split the surface-frame span at those exact stations first, then
    // classify each independent piece at its interior. This avoids both the
    // old whole-frame dropout and an expensive second geometric bisection
    // during paint generation.
    const cuts = [lo, hi];
    for (const zone of route._zonesAsBranch || []) {
      const opening = zone.markingOpening?.branch;
      if (!opening) continue;
      for (const boundary of opening) {
        if (boundary > lo + 0.001 && boundary < hi - 0.001) cuts.push(boundary);
      }
    }
    cuts.sort((left, right) => left - right);
    const rawPieces = [];
    for (let index = 1; index < cuts.length; index += 1) {
      const from = cuts[index - 1];
      const to = cuts[index];
      const midState = stateAt((from + to) * 0.5);
      rawPieces.push({
        from,
        to,
        allowed: midState.allowed,
        reason: midState.reason,
        zoneId: midState.zoneId,
      });
    }
    const pieces = [];
    for (const piece of rawPieces) {
      const previous = pieces[pieces.length - 1];
      if (previous && previous.allowed === piece.allowed
        && previous.reason === piece.reason && previous.zoneId === piece.zoneId
        && Math.abs(previous.to - piece.from) < 0.006) {
        previous.to = piece.to;
      } else pieces.push({ ...piece });
    }

    const baseA = sampleOf(lateralAt(a)).intendedLateral;
    const baseB = sampleOf(lateralAt(b)).intendedLateral;
    if (baseA === null || baseB === null) return;
    const span = Math.max(segEnd - segStart, EPSILON);
    for (const piece of pieces) {
      if (piece.to - piece.from < 0.004) continue;
      const t0 = (piece.from - segStart) / span;
      const t1 = (piece.to - segStart) / span;
      const lat0 = baseA + (baseB - baseA) * t0;
      const lat1 = baseA + (baseB - baseA) * t1;
      if (!piece.allowed) {
        if (this.options.markingDebug && materialName !== 'amber') {
          const context = this._markingDebugContext(route, piece.from, piece.to);
          this._markingLog.push({
            kind: 'suppressedStrip',
            tag: this._markingTag || 'untagged',
            markingType: this._markingTag || 'untagged',
            routeId: route.id,
            owner: this._markingOwner || `route:${route.id}`,
            classification: this._markingClassification || 'route-local',
            boundary: this._markingBoundary,
            material: materialName,
            sFrom: piece.from,
            sTo: piece.to,
            latFrom: lat0,
            latTo: lat1,
            suppressionReason: piece.reason || 'marking-path-undefined',
            suppressionZoneId: piece.zoneId,
            ...context,
          });
        }
        continue;
      }
      const innerA = this._deckPoint(a, baseA - halfWidth, lift);
      const outerA = this._deckPoint(a, baseA + halfWidth, lift);
      const innerB = this._deckPoint(b, baseB - halfWidth, lift);
      const outerB = this._deckPoint(b, baseB + halfWidth, lift);
      const inner0 = innerA.clone().lerp(innerB, t0);
      const outer0 = outerA.clone().lerp(outerB, t0);
      const inner1 = innerA.lerp(innerB, t1);
      const outer1 = outerA.lerp(outerB, t1);
      const bucket = this._bucket(TMP_A.copy(inner0).lerp(outer1, 0.5), materialName);
      this._pushQuad(bucket, outer0, outer1, inner1, inner0);
      if (this.options.markingDebug && materialName !== 'amber') {
        const start = inner0.clone().lerp(outer0, 0.5);
        const end = inner1.clone().lerp(outer1, 0.5);
        const fromFrame = this._frameAt(route, piece.from);
        const toFrame = this._frameAt(route, piece.to);
        const meanTangent = fromFrame.tangent.clone().add(toFrame.tangent).normalize();
        const context = this._markingDebugContext(route, piece.from, piece.to);
        this._markingLog.push({
          kind: 'strip',
          tag: this._markingTag || 'untagged',
          markingType: this._markingTag || 'untagged',
          routeId: route.id,
          owner: this._markingOwner || `route:${route.id}`,
          classification: this._markingClassification || 'route-local',
          boundary: this._markingBoundary,
          material: materialName,
          sFrom: piece.from,
          sTo: piece.to,
          latFrom: lat0,
          latTo: lat1,
          start: { x: start.x, y: start.y, z: start.z },
          end: { x: end.x, y: end.y, z: end.z },
          tangent: { x: meanTangent.x, y: meanTangent.y, z: meanTangent.z },
          tangentFrom: { x: fromFrame.tangent.x, y: fromFrame.tangent.y, z: fromFrame.tangent.z },
          tangentTo: { x: toFrame.tangent.x, y: toFrame.tangent.y, z: toFrame.tangent.z },
          suppressionReason: null,
          ...context,
        });
      }
    }
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
    const openingCuts = route._markingOpeningCuts;
    for (let i = 0; i < count; i += 1) {
      const a = frames[i];
      const b = frames[(i + 1) % frames.length];
      const segStart = a.distance;
      const segEnd = route.closed && i === frames.length - 1 ? route.length : b.distance;
      const lo = Math.max(sStart, segStart);
      const hi = Math.min(sEnd, segEnd);
      if (hi - lo < 0.05) continue;
      // Ordinary spans retain the established surface-frame paint path.
      // Only a span that actually contains an exact A or B cut needs the
      // independent-piece cutter; spans wholly inside are already rejected
      // by mouthPaintLat at both endpoints.
      let crossesOpeningCut = false;
      if (this.options.junctionMouthSurfaces !== false && openingCuts) {
        for (const boundary of openingCuts) {
          if (boundary >= hi - 0.001) break;
          if (boundary > lo + 0.001) { crossesOpeningCut = true; break; }
        }
      }
      if (crossesOpeningCut) {
        this._paintMouthStripSegment(
          route, materialName, a, b, segStart, segEnd, lo, hi, lateralAt, width, lift,
        );
        continue;
      }
      const rawA = lateralAt(a);
      const rawB = lateralAt(b);
      const sampleOf = (value) => {
        if (typeof value === 'number') return { lateral: value, suppressionReason: null, zoneId: null };
        if (value && typeof value === 'object') return value;
        return { lateral: null, suppressionReason: 'marking-path-undefined', zoneId: null };
      };
      const sampleA = sampleOf(rawA);
      const sampleB = sampleOf(rawB);
      const la = sampleA.lateral;
      const lb = sampleB.lateral;
      if (la === null || lb === null) {
        if (this.options.markingDebug && materialName !== 'amber') {
          const context = this._markingDebugContext(route, lo, hi);
          this._markingLog.push({
            kind: 'suppressedStrip',
            tag: this._markingTag || 'untagged',
            markingType: this._markingTag || 'untagged',
            routeId: route.id,
            owner: this._markingOwner || `route:${route.id}`,
            classification: this._markingClassification || 'route-local',
            boundary: this._markingBoundary,
            material: materialName,
            sFrom: lo,
            sTo: hi,
            latFrom: la,
            latTo: lb,
            suppressionReason: sampleA.suppressionReason || sampleB.suppressionReason || 'marking-path-undefined',
            suppressionZoneId: sampleA.zoneId || sampleB.zoneId || null,
            ...context,
          });
        }
        continue;
      }
      const span = Math.max(segEnd - segStart, EPSILON);
      let t0 = (lo - segStart) / span;
      let t1 = (hi - segStart) / span;
      // A lane boundary can enter/leave the paved deck during a width taper.
      // Clip at that exact crossing instead of discarding this entire render
      // span merely because one endpoint is too narrow.
      const clearanceA = this._markingClearance(a, la, halfWidth);
      const clearanceB = this._markingClearance(b, lb, halfWidth);
      if (clearanceA < 0 && clearanceB < 0) {
        if (this.options.markingDebug && materialName !== 'amber') {
          const context = this._markingDebugContext(route, lo, hi);
          this._markingLog.push({
            kind: 'suppressedStrip',
            tag: this._markingTag || 'untagged',
            markingType: this._markingTag || 'untagged',
            routeId: route.id,
            owner: this._markingOwner || `route:${route.id}`,
            classification: this._markingClassification || 'route-local',
            boundary: this._markingBoundary,
            material: materialName,
            sFrom: lo,
            sTo: hi,
            latFrom: la,
            latTo: lb,
            suppressionReason: 'outside-route-paved-width',
            suppressionZoneId: null,
            ...context,
          });
        }
        continue;
      }
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
      // Marking-orientation instrumentation (options.markingDebug): one
      // record per painted piece — the piece's own world direction vs the
      // intended marking-path tangent at that station — so a probe can
      // detect diagonal/zig-zag paint instead of trusting interval maths.
      if (this.options.markingDebug && materialName !== 'amber') {
        const start = inner0.clone().lerp(outer0, 0.5);
        const end = inner1.clone().lerp(outer1, 0.5);
        // Mean end tangent ~ the mid tangent: on an arc, the chord of a
        // constant-lateral stripe is parallel to it regardless of how
        // sharp the curve is, so only REAL lateral drift reads diagonal.
        const meanTangent = a.tangent.clone().add(b.tangent).normalize();
        const context = this._markingDebugContext(route, lo, hi);
        this._markingLog.push({
          kind: 'strip',
          tag: this._markingTag || 'untagged',
          markingType: this._markingTag || 'untagged',
          routeId: route.id,
          owner: this._markingOwner || `route:${route.id}`,
          classification: this._markingClassification || 'route-local',
          boundary: this._markingBoundary,
          material: materialName,
          sFrom: lo,
          sTo: hi,
          latFrom: la + (lb - la) * t0,
          latTo: la + (lb - la) * t1,
          start: { x: start.x, y: start.y, z: start.z },
          end: { x: end.x, y: end.y, z: end.z },
          tangent: { x: meanTangent.x, y: meanTangent.y, z: meanTangent.z },
          tangentFrom: { x: a.tangent.x, y: a.tangent.y, z: a.tangent.z },
          tangentTo: { x: b.tangent.x, y: b.tangent.y, z: b.tangent.z },
          suppressionReason: null,
          ...context,
        });
      }
    }
  }

  /**
   * Paint one transition-owned world path. Progressive 2+2 markings can run
   * across the union of host and branch pavement while being outside either
   * route ribbon considered alone; routing those pieces through _paintStrip
   * therefore created a real gap between the two independent painters.
   * These points already come from the authoritative, deck-conformed model.
   */
  _paintProgressivePathStrip(route, path, materialName, sStart, sEnd, width) {
    if (!path?.points?.length || sEnd <= sStart) return;
    const halfWidth = width * 0.5;
    for (let index = 1; index < path.points.length; index += 1) {
      const left = path.points[index - 1];
      const right = path.points[index];
      const lo = Math.max(sStart, left.hostS);
      const hi = Math.min(sEnd, right.hostS);
      if (hi - lo < 0.004) continue;
      const span = Math.max(1e-6, right.hostS - left.hostS);
      const t0 = clamp((lo - left.hostS) / span, 0, 1);
      const t1 = clamp((hi - left.hostS) / span, 0, 1);
      const start = new THREE.Vector3(
        left.position.x + (right.position.x - left.position.x) * t0,
        left.position.y + (right.position.y - left.position.y) * t0,
        left.position.z + (right.position.z - left.position.z) * t0,
      );
      const end = new THREE.Vector3(
        left.position.x + (right.position.x - left.position.x) * t1,
        left.position.y + (right.position.y - left.position.y) * t1,
        left.position.z + (right.position.z - left.position.z) * t1,
      );
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-5) continue;
      const normal = new THREE.Vector3(-dz / length * halfWidth, 0, dx / length * halfWidth);
      const leftStart = start.clone().add(normal);
      const leftEnd = end.clone().add(normal);
      const rightStart = start.clone().sub(normal);
      const rightEnd = end.clone().sub(normal);
      this._pushQuad(
        this._bucket(start.clone().lerp(end, 0.5), materialName),
        leftStart,
        leftEnd,
        rightEnd,
        rightStart,
      );
      if (this.options.markingDebug && materialName !== 'amber') {
        const context = this._markingDebugContext(route, lo, hi);
        const tangent = end.clone().sub(start).normalize();
        this._markingLog.push({
          kind: 'strip',
          tag: this._markingTag || 'untagged',
          markingType: this._markingTag || 'untagged',
          routeId: route.id,
          owner: this._markingOwner || `route:${route.id}`,
          classification: this._markingClassification || 'route-local',
          boundary: this._markingBoundary,
          material: materialName,
          sFrom: lo,
          sTo: hi,
          latFrom: left.lateral + (right.lateral - left.lateral) * t0,
          latTo: left.lateral + (right.lateral - left.lateral) * t1,
          start: { x: start.x, y: start.y, z: start.z },
          end: { x: end.x, y: end.y, z: end.z },
          tangent: { x: tangent.x, y: tangent.y, z: tangent.z },
          tangentFrom: { x: tangent.x, y: tangent.y, z: tangent.z },
          tangentTo: { x: tangent.x, y: tangent.y, z: tangent.z },
          suppressionReason: null,
          ...context,
        });
      }
    }
  }

  _paintProgressivePathDashed(
    route,
    path,
    materialName,
    width,
    period,
    dashLength,
    phase,
    sFrom,
    sTo,
  ) {
    const first = Math.ceil((sFrom - dashLength * 0.5 - phase) / period);
    const last = Math.floor((sTo + dashLength * 0.5 - phase) / period);
    for (let index = first; index <= last; index += 1) {
      const centre = phase + index * period;
      const lo = Math.max(sFrom, centre - dashLength * 0.5);
      const hi = Math.min(sTo, centre + dashLength * 0.5);
      if (hi - lo < 0.05) continue;
      this._paintProgressivePathStrip(route, path, materialName, lo, hi, width);
    }
  }

  /**
   * Paint dashes from one route-absolute phase; frames/chunks never reset
   * it, and a clipped range (junction-zone dashed boundaries) never
   * re-bases it — dashes inside [sFrom, sTo] land exactly where the
   * full-route pattern would put them.
   */
  _paintDashedStrip(route, materialName, lateralAt, width, period, dashLength, phase = 0, sFrom = 0, sTo = null) {
    const end = sTo === null ? route.length : Math.min(sTo, route.length);
    const from = Math.max(0, sFrom);
    const first = Math.ceil((from - dashLength * 0.5 - phase) / period);
    const last = Math.floor((end + dashLength * 0.5 - phase) / period);
    for (let index = first; index <= last; index += 1) {
      const center = phase + index * period;
      const lo = Math.max(from, center - dashLength * 0.5);
      const hi = Math.min(end, center + dashLength * 0.5);
      if (hi - lo < 0.05) continue;
      this._paintStrip(route, materialName, lo, hi, lateralAt, width);
    }
  }

  /**
   * Chainage pieces of an unwrapped zone interval on this route (closed
   * routes: an interval crossing station 0 splits into two pieces).
   */
  _zoneIntervalPieces(route, interval) {
    if (!interval) return [];
    let [a, b] = interval;
    if (b <= a) return [];
    if (!route.closed) return [[clamp(a, 0, route.length), clamp(b, 0, route.length)]];
    const start = wrap(a, route.length);
    const span = Math.min(b - a, route.length);
    if (start + span <= route.length) return [[start, start + span]];
    return [[start, route.length], [0, start + span - route.length]];
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
    for (const { route: other, index, distSq } of candidates.values()) {
      if (other === route) continue;
      // conflicts need lateral <= half + 1.2; grid samples sit <= ~22 m
      // from the true nearest curve point (40 m spacing + bowing), so
      // anything further than half + 30 cannot conflict — skip the
      // costly projection (this probe now runs for EVERY surface frame)
      const reach = other.halfWidth + 30;
      if (distSq > reach * reach) continue;
      const projection = this._projectToRoute(other, point, index);
      if (projection.endOvershoot > 2) continue; // beyond the other surface's end
      const half = this._halfWidthAt(other, projection.distance);
      const abs = Math.abs(projection.signedLateral);
      const deckY = projection.point.y + Math.tan(this._bankAt(other, projection.distance)) * projection.signedLateral
        + this._progressiveBranchDeckOffsetAt(other, projection.distance, projection.signedLateral);
      // Conflict only when the other deck sits within the barrier's own
      // height band: surface between 1.35 m below the base (a rail on a
      // sunken sliver still reads doubled) and 1.6 m above it (a slab low
      // enough to chop the profile). The old ±4 m band also killed
      // parapets on decks BRIDGING another road 2-4 m away — read in game
      // as unexplained 20-70 m rail holes at every close grade separation.
      const dyRail = point.y - deckY;
      if (dyRail > 1.35 || dyRail < -1.6) continue;
      if (abs < half - 0.2) return true;
      if (yields && other.kind !== 'ramp' && other.kind !== 'service' && abs < half + 1.2) return true;
      // Doubled-rail tie-break: where another carriageway's own rail line
      // (its edge at half - 0.42) runs within a metre at the same level —
      // chain abutments, u-turn stubs, tight braids — exactly one of the
      // two coincident rails may draw. The earlier-registered route owns
      // the shared edge; this one yields.
      if (Math.abs(abs - (half - 0.42)) < 1.0
        && this.routeOrder.indexOf(other.id) < this.routeOrder.indexOf(route.id)) return true;
    }
    if (this._lotAt(point, 1.5)) return true;
    return false;
  }

  _roadMaterialName(route) {
    return route.kind === 'service' ? 'roadService'
      : (this.routeOrder.indexOf(route.id) % 2 ? 'roadAlt' : 'road');
  }

  /**
   * Junction-mouth deck emission for one branch surface-frame segment.
   * Returns false when neither frame carries a mouth clip (caller draws the
   * normal full-width deck), true when the segment was handled here:
   *
   *  - removed (host-covered coplanar) strips draw nothing — the host deck
   *    IS the junction surface there;
   *  - each drawn interval sits on the authoritative frame plane; its cut
   *    edges carry flaps that skirt 0.35 m past the cut and tuck 3 cm under
   *    the host surface, so the union is watertight against the host's
   *    chorded edge with no coplanar overlap;
   *  - gore slivers are closed by the same flap mechanism (an apron off the
   *    wing's host-side edge);
   *  - intervals appearing/disappearing between stations emit apex
   *    triangles so wings grow progressively instead of popping.
   *
   * Mouth quads use the HOST's road material so the junction reads as one
   * paved surface. Wall segments, corridors and barrier logic are untouched.
   */
  _emitMouthDeck(route, a, b, mid) {
    if (this.options.junctionMouthSurfaces === false) return false; // A/B: legacy ribbons
    if (!route.junctionMouths) return false;
    const jxA = this._mouthClipAt(route, a);
    const jxB = this._mouthClipAt(route, b);
    if (!jxA && !jxB) return false;
    const record = jxA || jxB;
    const full = (frame) => [{ lo: -frame.half, hi: frame.half, flapLo: null, flapHi: null }];
    const listA = jxA ? (jxA.skip ? [] : jxA.intervals) : full(a);
    const listB = jxB ? (jxB.skip ? [] : jxB.intervals) : full(b);
    if (!listA.length && !listB.length) return true; // host covers the whole segment

    const bucketRoad = this._bucket(mid, this._roadMaterialName(record.mouth.host));
    const bucketFascia = this._bucket(mid, 'concreteDark');
    const elevated = a.position.y > 2.5 && !a.tunnel;
    const fasciaDepth = elevated ? 1.35 : 0.5;
    const P = (frame, lat) => this._deckPoint(frame, lat);

    // Up-facing winding: higher-lateral corners first (matches the base deck).
    const quad = (hiA, hiB, loB, loA) => this._pushQuad(bucketRoad, hiA, hiB, loB, loA);

    const emitPair = (ivA, ivB) => {
      const aLo = P(a, ivA.lo);
      const aHi = P(a, ivA.hi);
      const bLo = P(b, ivB.lo);
      const bHi = P(b, ivB.hi);
      quad(aHi, bHi, bLo, aLo);
      // flaps: skirt strips past the cut edges (degenerate side → triangle)
      const flapStrip = (edgeA, edgeB, flapA, flapB, highSide) => {
        if (!flapA && !flapB) return;
        const fA = flapA ? flapA.point : edgeA;
        const fB = flapB ? flapB.point : edgeB;
        if (flapA && flapB) {
          if (highSide) quad(fA, fB, edgeB, edgeA);
          else quad(edgeA, edgeB, fB, fA);
        } else if (flapA) {
          if (highSide) this._pushTri(bucketRoad, fA, edgeB, edgeA);
          else this._pushTri(bucketRoad, edgeA, edgeB, fA);
        } else {
          if (highSide) this._pushTri(bucketRoad, fB, edgeB, edgeA);
          else this._pushTri(bucketRoad, edgeA, edgeB, fB);
        }
      };
      flapStrip(aHi, bHi, ivA.flapHi, ivB.flapHi, true);
      flapStrip(aLo, bLo, ivA.flapLo, ivB.flapLo, false);
      // fascia only on a true outer deck edge (not on cut edges)
      const fasciaEdge = (latA, latB, highSide) => {
        const eA = P(a, latA);
        const eB = P(b, latB);
        const dA = eA.clone(); dA.y -= fasciaDepth;
        const dB = eB.clone(); dB.y -= fasciaDepth;
        if (highSide) this._pushQuad(bucketFascia, dA, dB, eB, eA);
        else this._pushQuad(bucketFascia, eA, eB, dB, dA);
      };
      if (ivA.hi > a.half - 0.01 && ivB.hi > b.half - 0.01) fasciaEdge(ivA.hi, ivB.hi, true);
      if (ivA.lo < -a.half + 0.01 && ivB.lo < -b.half + 0.01) fasciaEdge(ivA.lo, ivB.lo, false);
    };

    // An interval with no partner at the other station transitions into a
    // region the host covers: emit the full quad, with the missing side's
    // corners tucked under BOTH decks (min of branch plane and host
    // surface, minus 3 cm) so the deck dives cleanly under the covering
    // surface instead of leaving an unpaved notch.
    const host = record.mouth.host;
    const tucked = (frame, lat) => {
      const point = this._deckPoint(frame, lat);
      const projection = this._projectToRoute(host, point);
      const bank = this._bankAt(host, projection.distance);
      const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral;
      point.y = Math.min(point.y, deckY) - 0.06;
      return point;
    };
    const emitTucked = (iv, solidFrame, emptyFrame, solidIsA) => {
      const sLo = P(solidFrame, iv.lo);
      const sHi = P(solidFrame, iv.hi);
      const eLo = tucked(emptyFrame, iv.lo);
      const eHi = tucked(emptyFrame, iv.hi);
      if (solidIsA) quad(sHi, eHi, eLo, sLo);
      else quad(eHi, sHi, sLo, eLo);
      const flapStrip = (flap, edge, edgeLat, highSide) => {
        if (!flap) return;
        const eFlap = tucked(emptyFrame, flap.lat);
        const eEdge = tucked(emptyFrame, edgeLat);
        if (highSide) {
          if (solidIsA) quad(flap.point, eFlap, eEdge, edge);
          else quad(eFlap, flap.point, edge, eEdge);
        } else {
          if (solidIsA) quad(edge, eEdge, eFlap, flap.point);
          else quad(eEdge, edge, flap.point, eFlap);
        }
      };
      flapStrip(iv.flapHi, sHi, iv.hi, true);
      flapStrip(iv.flapLo, sLo, iv.lo, false);
    };

    // Pair intervals across the two stations by lateral overlap.
    const usedB = new Set();
    for (const ivA of listA) {
      let best = null;
      let bestOverlap = 0.01;
      for (const ivB of listB) {
        if (usedB.has(ivB)) continue;
        const overlap = Math.min(ivA.hi, ivB.hi) - Math.max(ivA.lo, ivB.lo);
        if (overlap > bestOverlap) { bestOverlap = overlap; best = ivB; }
      }
      if (best) {
        usedB.add(best);
        emitPair(ivA, best);
      } else {
        emitTucked(ivA, a, b, true);
      }
    }
    for (const ivB of listB) {
      if (!usedB.has(ivB)) emitTucked(ivB, b, a, false);
    }
    return true;
  }

  /**
   * Closing face for a parapet run terminal (junction-mouth openings): the
   * capped profile is sealed with one vertical quad so rails terminate
   * cleanly before a gore and restart cleanly after it, instead of showing
   * a hollow open cross-section. The material is DoubleSide, so one face
   * serves both run ends.
   */
  _emitBarrierEndCap(bucket, frame, side, factor = 1) {
    const p = this._parapetProfile(frame, side, factor);
    this._pushQuad(bucket, p.base, p.top, p.cap, p.out);
  }

  /**
   * Parapet cross-section at one frame, scaled by a terminal factor:
   * factor 1 is the full profile; toward 0 the profile sinks to deck level
   * and squeezes toward the outer edge — the ramped end terminal every
   * junction-mouth rail run now finishes with, instead of a full-height
   * profile chopped mid-air.
   */
  _parapetProfile(frame, side, factor = 1) {
    const squeeze = 0.36 * (1 - factor);
    const lean = 0.02 + 0.83 * factor;
    const edge = this._surfaceEdgeLateral(frame, side);
    return {
      base: this._deckPoint(frame, edge - side * (0.42 - squeeze), 0.02),
      top: this._deckPoint(frame, edge - side * (0.3 - squeeze * 0.66), lean),
      cap: this._deckPoint(frame, edge - side * 0.06, lean + 0.06 * factor),
      out: this._deckPoint(frame, edge, 0.0),
    };
  }

  _buildRouteGeometry(route) {
    const roadMaterialName = this._roadMaterialName(route);
    const barrierHeight = route.kind === 'service' ? 0.9 : 1.15;
    const medianHeight = 1.0;

    // Rail visibility per surface frame per side. Inside a junction zone
    // the zone's ownership intervals decide (exact chainage boundaries —
    // 'off' across the drivable opening, 'on' along the union's outer
    // edge); everywhere else the ~9 m-cached point probe decides (PA
    // gates, braided complexes).
    const frames = route.surfaceFrames;
    const barrierVisible = this._computeBarrierVisibility(route);
    // Terminal taper: within RAIL_TAPER metres of a visibility boundary the
    // parapet profile ramps down to deck level (see _parapetProfile), so
    // every run finishes as an intentional end terminal.
    const RAIL_TAPER = 7;
    const railFactor = (side, i) => {
      const list = barrierVisible[side];
      if (!list[i]) return 0;
      const s = frames[i].distance;
      let factor = 1;
      for (let j = i + 1; j < list.length; j += 1) {
        const d = frames[j].distance - s;
        if (d > RAIL_TAPER) break;
        if (!list[j]) { factor = Math.min(factor, Math.max(d, 0.8) / RAIL_TAPER); break; }
      }
      for (let j = i - 1; j >= 0; j -= 1) {
        const d = s - frames[j].distance;
        if (d > RAIL_TAPER) break;
        if (!list[j]) { factor = Math.min(factor, Math.max(d, 0.8) / RAIL_TAPER); break; }
      }
      return factor;
    };
    // Parapet runs end/restart at junction-mouth openings; track the runs so
    // each terminal gets a closing face instead of an open hollow profile.
    const barrierRun = { 1: false, [-1]: false };
    // Focused geometry diagnostics for progressive host rails. These samples
    // are taken from the parapet vertices that are actually emitted below,
    // rather than re-deriving a nominal lateral in the guardrail probes. Only
    // the four short prototype intervals are retained (hundreds of records,
    // not a network-wide per-frame log).
    const progressiveHostTransitions = route._progressiveTransitionsAsHost || [];
    const progressiveBranchTransitions = route._progressiveTransitionsAsBranch || [];
    const progressiveRailTransitions = [...progressiveHostTransitions, ...progressiveBranchTransitions];
    const progressiveRailSampleKeys = progressiveRailTransitions.length ? new Set() : null;
    if (progressiveRailTransitions.length) route._progressiveRailSamples = [];
    const recordProgressiveRailSample = (frame, side, profile, factor) => {
      if (!progressiveRailTransitions.length) return;
      let role = 'host-exterior';
      let transition = progressiveHostTransitions.find((candidate) => (
        candidate.sideSign === side && candidate.containsHost(frame.distance, 0.01)));
      if (!transition) {
        transition = progressiveBranchTransitions.find((candidate) => (
          candidate.branchRailModeAt?.(frame.distance, side) === 'on'));
        role = side === transition?.sourceZone.hostwardSign ? 'branch-gore' : 'branch-exterior';
      }
      if (!transition) return;
      const key = `${transition.id}:${role}:${side}:${frame.distance.toFixed(5)}`;
      if (progressiveRailSampleKeys.has(key)) return;
      progressiveRailSampleKeys.add(key);
      const lateralOf = (point) => (point.x - frame.position.x) * frame.normal.x
        + (point.z - frame.position.z) * frame.normal.z;
      route._progressiveRailSamples.push({
        transitionId: transition.id,
        role,
        side,
        distance: frame.distance,
        terminalFactor: factor,
        actualOuterLateral: lateralOf(profile.out),
        actualBaseLateral: lateralOf(profile.base),
        actualBasePosition: { x: profile.base.x, y: profile.base.y, z: profile.base.z },
      });
    };

    this._forEachSurfaceFrameSegment(route, (a, b, segmentIndex) => {
      // fresh vector: _barrierSuppressed re-uses the TMP registers mid-loop
      const mid = a.position.clone().lerp(b.position, 0.5);
      // Junction mouths draw a clipped deck that unions with the host
      // surface (see _emitMouthDeck); everywhere else the full deck.
      if (!this._emitMouthDeck(route, a, b, mid)) {
        const bucketRoad = this._bucket(mid, roadMaterialName);
        const leftA = this._deckPoint(a, this._surfaceEdgeLateral(a, 1));
        const leftB = this._deckPoint(b, this._surfaceEdgeLateral(b, 1));
        const rightA = this._deckPoint(a, this._surfaceEdgeLateral(a, -1));
        const rightB = this._deckPoint(b, this._surfaceEdgeLateral(b, -1));
        // Deck top, wound UP-facing. It was wound the other way for years:
        // the single-sided road material culled the real deck from above and
        // the game was actually showing the fascia UNDERSIDE 0.5-1.35 m below
        // the physics surface — the reported "glass floor over a sunken road".
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
      }

      // Outer barriers — capped concrete parapet + steel handrail,
      // PS2-highway style. Every metre of the
      // network keeps its wallSegments record (collision metadata identical);
      // only the VISUAL is omitted where a segment would criss-cross another
      // carriageway at a gore mouth or PA gate.
      const bucketBarrier = this._bucket(mid, 'barrier');
      const bucketRail = this._bucket(mid, 'railMetal');
      const nextIndex = (segmentIndex + 1) % frames.length;
      for (const side of [1, -1]) {
        const drawn = barrierVisible[side][segmentIndex] && barrierVisible[side][nextIndex];
        if (!drawn) {
          // Run ends at a junction-mouth opening: close the (tapered)
          // profile cleanly instead of leaving a hollow open end.
          if (barrierRun[side]) {
            this._emitBarrierEndCap(bucketBarrier, a, side, railFactor(side, segmentIndex));
            barrierRun[side] = false;
          }
          continue;
        }
        const fA = railFactor(side, segmentIndex);
        const fB = railFactor(side, nextIndex);
        if (!barrierRun[side]) {
          this._emitBarrierEndCap(bucketBarrier, a, side, fA);
          barrierRun[side] = true;
        }
        const pA = this._parapetProfile(a, side, fA);
        const pB = this._parapetProfile(b, side, fB);
        recordProgressiveRailSample(a, side, pA, fA);
        recordProgressiveRailSample(b, side, pB, fB);
        // `barrier` is DoubleSide: cap + outer wall preserve the same deck-edge
        // silhouette from chase and exterior views without storing a third,
        // hidden inner-profile sheet at every dense surface station.
        if (side > 0) {
          this._pushQuad(bucketBarrier, pA.top, pB.top, pB.cap, pA.cap);
          this._pushQuad(bucketBarrier, pB.cap, pB.out, pA.out, pA.cap);
        } else {
          this._pushQuad(bucketBarrier, pB.top, pA.top, pA.cap, pB.cap);
          this._pushQuad(bucketBarrier, pA.cap, pA.out, pB.out, pB.cap);
        }
        // steel handrail on top of the parapet (skipped inside tunnels and
        // over end terminals — it must not float above a sunk profile)
        if (!a.tunnel && fA > 0.96 && fB > 0.96) {
          const railA = this._deckPoint(a, this._surfaceEdgeLateral(a, side, 0.18), 1.12);
          const railB = this._deckPoint(b, this._surfaceEdgeLateral(b, side, 0.18), 1.12);
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
        // Inside a junction mouth the underside follows the clipped deck
        // footprint (covered sections have no underside of their own — the
        // host's covers the area).
        const mouthy = route.junctionMouths && this.options.junctionMouthSurfaces !== false;
        const jxA = mouthy ? this._mouthClipAt(route, a) : null;
        const jxB = mouthy ? this._mouthClipAt(route, b) : null;
        const fasciaDepth = 1.35;
        if (!jxA && !jxB) {
          const dropLA = this._deckPoint(a, this._surfaceEdgeLateral(a, 1)); dropLA.y -= fasciaDepth;
          const dropLB = this._deckPoint(b, this._surfaceEdgeLateral(b, 1)); dropLB.y -= fasciaDepth;
          const dropRA = this._deckPoint(a, this._surfaceEdgeLateral(a, -1)); dropRA.y -= fasciaDepth;
          const dropRB = this._deckPoint(b, this._surfaceEdgeLateral(b, -1)); dropRB.y -= fasciaDepth;
          this._pushQuad(this._bucket(mid, 'concreteDark'), dropRA, dropRB, dropLB, dropLA);
        } else if (!(jxA?.skip) && !(jxB?.skip)) {
          // Underside spans the full drawn footprint (intervals + flaps).
          const span = (frame, jx) => {
            if (!jx) return [-frame.half, frame.half];
            const first = jx.intervals[0];
            const last = jx.intervals[jx.intervals.length - 1];
            return [first.flapLo ? first.flapLo.lat : first.lo, last.flapHi ? last.flapHi.lat : last.hi];
          };
          const [loA, hiA] = span(a, jxA);
          const [loB, hiB] = span(b, jxB);
          const dropLoA = this._deckPoint(a, loA); dropLoA.y -= fasciaDepth;
          const dropLoB = this._deckPoint(b, loB); dropLoB.y -= fasciaDepth;
          const dropHiA = this._deckPoint(a, hiA); dropHiA.y -= fasciaDepth;
          const dropHiB = this._deckPoint(b, hiB); dropHiB.y -= fasciaDepth;
          // down-facing: lower-lateral corners first, like the base underside
          this._pushQuad(this._bucket(mid, 'concreteDark'), dropLoA, dropLoB, dropHiB, dropHiA);
        }
      }
      for (const side of [1, -1]) {
        const transitionManagedWall = progressiveHostTransitions.some((transition) => (
          transition.sideSign === side && transition.containsHost(a.distance, 1.5)))
          || progressiveBranchTransitions.some((transition) => (
            transition.branchRailModeAt?.(a.distance, side) !== null));
        const emittedBarrier = this._railZoneMode(route, side, a.distance) !== 'off'
          && this._railZoneMode(route, side, b.distance) !== 'off';
        if (transitionManagedWall && !emittedBarrier) continue;
        this.wallSegments.push({
          routeId: route.id, type: 'outer', side,
          start: this._deckPoint(a, this._surfaceEdgeLateral(a, side, 0.42), 0.02),
          end: this._deckPoint(b, this._surfaceEdgeLateral(b, side, 0.42), 0.02),
          height: barrierHeight,
          distanceStart: a.distance, distanceEnd: b.distance,
          progressiveTransitionId: transitionManagedWall
            ? (progressiveHostTransitions[0]?.id || progressiveBranchTransitions[0]?.id)
            : null,
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
   * paint the hatched wedge over the GENUINE gore nose only, and terminate
   * the barrier V with a yellow/black crash cushion.
   *
   * The wedge derives from the shared junction-zone record (the same one
   * markings/rails/physics read): stations inside the zone's CROSSABLE
   * interval are the merge/exit lane itself — the longitudinal dashed
   * boundary owns them, and hatching there was the user-reported
   * slash/backslash zig-zag. Stripes also require both paved edges at one
   * level (a wedge between decks 0.3+ m apart is two separate surfaces,
   * not a paintable gore) and are capped to a short nose band. All stripes
   * of one gore lean the SAME way (real 導流帯 hatching), never alternating.
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
      const mouth = (ramp.junctionMouths || []).find((candidate) => (
        candidate.host === main && candidate.which === (fromStart ? 'start' : 'end')));
      const zone = mouth?.zone;
      // The progressive transition owns its complete lane-drop/split zone.
      // It intentionally uses longitudinal guidance only; the legacy gore
      // hatching/cushion would sit inside the new drivable auxiliary lane.
      if (zone?.progressive) continue;

      // walk the ramp away from the shared mouth until the paved edges split;
      // wedge points sit on the BANKED deck surfaces (_frameAt), so the
      // chevron paint and the cushion follow grade and roll instead of
      // floating at bare curve height.
      let tip = null;
      const stripes = [];
      const NOSE_STRIPES_MAX = 6; // ~54 m of hatching, a readable nose band
      for (let s = 24; s <= Math.min(320, ramp.length - 6); s += 9) {
        const rampDist = fromStart ? s : ramp.length - s;
        if (rampDist < 2 || rampDist > ramp.length - 2) break;
        const rampFrame = this._frameAt(ramp, rampDist);
        const projection = this._projectToRoute(main, rampFrame.position);
        if (Math.abs(rampFrame.position.y - projection.point.y) > 5) break;
        const mainFrame = this._frameAt(main, projection.distance);
        const halfMain = mainFrame.half;
        const gap = Math.abs(projection.signedLateral) + ramp.halfWidth - halfMain;
        const sideSign = projection.signedLateral >= 0 ? 1 : -1;
        const mainEdge = this._deckPoint(mainFrame, sideSign * (halfMain - 0.55));
        const toMain = projection.point.clone().sub(rampFrame.position).setY(0);
        if (toMain.lengthSq() < EPSILON) toMain.copy(projection.normal).multiplyScalar(-sideSign);
        toMain.normalize();
        const rampSideSign = toMain.dot(rampFrame.normal) >= 0 ? 1 : -1;
        const rampEdge = this._deckPoint(rampFrame, rampSideSign * (ramp.halfWidth - 0.55));
        const wedge = mainEdge.clone().lerp(rampEdge, 0.5);
        const wedgeWidth = mainEdge.distanceTo(rampEdge);
        if (gap > 1.2) {
          tip = { wedge, tangent: rampFrame.tangent.clone() };
          break;
        }
        // Crossable stations belong to the dashed merge/exit boundary, and
        // split-level "wedges" are separate decks — no hatching on either.
        const crossableHere = !!zone?.crossable
          && (zone.hostContains(zone.crossable.host, projection.distance)
            || (rampDist >= zone.crossable.branch[0] - 2 && rampDist <= zone.crossable.branch[1] + 2));
        const oneLevel = Math.abs(mainEdge.y - rampEdge.y) < 0.25;
        if (wedgeWidth > 1.1 && !crossableHere && oneLevel && stripes.length < NOSE_STRIPES_MAX) {
          stripes.push({ wedge, tangent: rampFrame.tangent.clone(), width: wedgeWidth, sideSign });
        }
      }

      // parallel hatching across the wedge (mirrored by connection side)
      for (const stripe of stripes) {
        const position = stripe.wedge.clone();
        position.y += 0.06;
        const skewAngle = stripe.sideSign * 0.62;
        const skew = new THREE.Quaternion().setFromAxisAngle(UP, skewAngle);
        const quaternion = yawQuaternion(stripe.tangent).multiply(skew);
        this._instance(position, vec(0.3, 0.025, Math.min(4.2, stripe.width * 1.15)), quaternion, null, 'box:marking');
        if (this.options.markingDebug) {
          this._markingLog.push({
            kind: 'chevron',
            tag: 'goreChevron',
            routeId: ramp.id,
            hostId: main.id,
            edgeKind: edge.kind,
            skewDeg: (skewAngle * 180) / Math.PI,
            length: Math.min(4.2, stripe.width * 1.15),
            wedgeWidth: stripe.width,
            position: { x: position.x, y: position.y, z: position.z },
            tangent: { x: stripe.tangent.x, y: stripe.tangent.y, z: stripe.tangent.z },
          });
        }
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

  /** Intended route-local lane boundaries in the route's lateral frame. */
  _laneDividerOffsets(route) {
    const offsets = [];
    if (route.bidirectional) {
      for (let lane = 1; lane < route.lanes; lane += 1) {
        const boundary = route.medianWidth * 0.5 + lane * route.laneWidth;
        offsets.push(boundary, -boundary);
      }
    } else {
      for (let lane = 1; lane < route.lanes; lane += 1) {
        offsets.push((lane - route.lanes * 0.5) * route.laneWidth);
      }
    }
    return offsets;
  }

  _queueRouteDetails(route) {
    const isService = route.kind === 'service';
    const isRamp = route.kind === 'ramp';

    // Lane divider dashes + solid edge lines + median amber lines — all
    // painted onto the deck through _paintStrip so they share the road's
    // authoritative frame (see _frameAt) instead of floating as world-
    // horizontal boxes.
    const dashStep = isService ? 26 : 15;
    const dashLength = 6.2;
    // Junction mouths: paint only on the drawn part of the deck. Sections
    // covered by the host carry the HOST's paint; lines within the clipped
    // strip would float on (or duplicate over) the host surface. Where the
    // gore opens, the branch's host-side edge line reappears naturally and
    // becomes the ramp-side gore line. Dash phase is untouched — clipping
    // skips stations, never re-bases route distance.
    // edgeSide identifies a call as painting the route's OWN edge line on
    // that side (1 or -1), so it can be handed to the zone: once this
    // route is inside a junction zone's crossable span, the host-ward
    // edge is the zone's dash/suppress boundary to draw, not the branch's
    // own line. The per-frame coplanar clip below (_mouthClipAt) only
    // hides paint once the branch cross-section is fully coplanar-covered,
    // which on a shallow merge taper lags the zone's own "one drivable
    // union" verdict by tens of metres — the branch keeps drawing a
    // "ghost" edge line deep into (and past) the merge, duplicating or
    // pre-empting the host's authoritative boundary. One owner per
    // boundary: inside crossable, the zone always wins on that side.
    const mouthPaintLat = (latFn, width, edgeSide = null, boundaryRole = null) => {
      if (this.options.junctionMouthSurfaces === false) return latFn;
      if (!route.junctionMouths) return latFn;
      const margin = width * 0.5 + 0.3;
      return (frame) => {
        const lat = latFn(frame);
        if (lat === null) return {
          lateral: null, intendedLateral: null, suppressionReason: 'marking-path-undefined', zoneId: null,
        };
        if (route._zonesAsBranch) {
          for (const zone of route._zonesAsBranch) {
            if (zone.progressive) {
              const phase = zone.progressive.phaseAtBranch(frame.distance);
              const ownsEdgeSettle = zone.progressive.type === 'diverge'
                && edgeSide === zone.hostwardSign
                && frame.distance >= zone.progressive.transferCompleteBranch - 0.01
                && frame.distance <= zone.progressive.markingSettleEnd + 0.01;
              const transitionOwns = zone.progressive.type === 'merge'
                ? phase && phase !== 'approach'
                : (!!phase || ownsEdgeSettle);
              if (transitionOwns) {
                return {
                  lateral: null,
                  intendedLateral: lat,
                  suppressionReason: 'progressive-transition-owner-handoff',
                  zoneId: zone.id,
                };
              }
            }
            const removesBoundary = boundaryRole === 'laneDivider' || edgeSide === zone.hostwardSign;
            if (!removesBoundary) continue;
            const opening = zone.markingOpening?.branch;
            const afterA = opening && (opening[0] <= 0.001
              ? frame.distance >= opening[0] - 0.001
              : frame.distance > opening[0] + 0.001);
            const beforeB = opening && (opening[1] >= route.length - 0.001
              ? frame.distance <= opening[1] + 0.001
              : frame.distance < opening[1] - 0.001);
            if (afterA && beforeB) {
              return {
                lateral: null,
                intendedLateral: lat,
                suppressionReason: 'junction-opening-no-marking',
                zoneId: zone.id,
              };
            }
            // Backward-compatible fallback for the A/B-disabled surface mode.
            if (!opening && zone.crossable && edgeSide === zone.hostwardSign
              && frame.distance >= zone.crossable.branch[0] - 1
              && frame.distance <= zone.crossable.branch[1] + 1) {
              return {
                lateral: null,
                intendedLateral: lat,
                suppressionReason: 'junction-zone-owner-handoff',
                zoneId: zone.id,
              };
            }
          }
        }
        const jx = this._mouthClipAt(route, frame);
        if (!jx) return { lateral: lat, intendedLateral: lat, suppressionReason: null, zoneId: null };
        if (jx.skip) return {
          lateral: null,
          intendedLateral: lat,
          suppressionReason: 'host-covers-branch-section',
          zoneId: jx.mouth.zone?.id || null,
        };
        // paint must sit on a drawn interval, clear of any cut edge
        for (const interval of jx.intervals) {
          const loBound = interval.lo <= -frame.half + 0.01 ? interval.lo : interval.lo + margin;
          const hiBound = interval.hi >= frame.half - 0.01 ? interval.hi : interval.hi - margin;
          if (lat >= loBound && lat <= hiBound) {
            return { lateral: lat, intendedLateral: lat, suppressionReason: null, zoneId: jx.mouth.zone?.id || null };
          }
        }
        return {
          lateral: null,
          intendedLateral: lat,
          suppressionReason: 'outside-visible-branch-deck',
          zoneId: jx.mouth.zone?.id || null,
        };
      };
    };
    const dividerOffsets = this._laneDividerOffsets(route);
    this._markingTag = 'laneDivider';
    this._markingOwner = `route:${route.id}`;
    this._markingClassification = 'route-local';
    for (let dividerIndex = 0; dividerIndex < dividerOffsets.length; dividerIndex += 1) {
      const offset = dividerOffsets[dividerIndex];
      this._markingBoundary = `lane-divider:${dividerIndex}:${offset.toFixed(3)}`;
      this._paintDashedStrip(route, 'marking', mouthPaintLat(() => offset, 0.14, null, 'laneDivider'), 0.14, dashStep, dashLength, 6);
    }
    // Edge lines with junction-zone marking ownership. Where this route
    // HOSTS a merge/diverge, the zone owns the boundary: the solid edge
    // line is suppressed over the zone's crossable opening (painted only
    // on the complement intervals — exact chainage clipping, no per-frame
    // dropouts) and a dashed lane-separation line marks the mergeable
    // boundary at the host's outer lane edge. The branch's own edge lines
    // are already clipped to its drawn deck (mouthPaintLat), so exactly
    // one route paints each visible boundary.
    for (const side of [1, -1]) {
      const suppress = [];
      for (const zone of route._zonesAsHost || []) {
        if (zone.side !== side || !zone.hostEdgeSuppress) continue;
        const pieces = zone.hostEdgeSuppressPieces?.length
          ? zone.hostEdgeSuppressPieces
          : [zone.hostEdgeSuppress];
        for (const piece of pieces) suppress.push(...this._zoneIntervalPieces(route, piece));
      }
      for (const transition of route._progressiveTransitionsAsHost || []) {
        if (transition.sideSign !== side) continue;
        suppress.push(...this._zoneIntervalPieces(route, transition.hostInterval));
      }
      suppress.sort((a, b) => a[0] - b[0]);
      const kept = [];
      let cursor = 0;
      for (const [from, to] of suppress) {
        if (from > cursor + 0.01) kept.push([cursor, from]);
        cursor = Math.max(cursor, to);
      }
      if (route.length > cursor + 0.01) kept.push([cursor, route.length]);
      this._markingTag = 'edgeLine';
      this._markingOwner = `route:${route.id}`;
      this._markingClassification = 'route-local';
      this._markingBoundary = `edge:${side}`;
      for (const [from, to] of kept) {
        this._paintStrip(route, 'marking', from, to,
          mouthPaintLat((frame) => side * (frame.half - 0.75), 0.16, side), 0.16);
      }
      if (route.bidirectional) {
        this._paintStrip(route, 'amber', 0, route.length,
          () => side * (route.medianWidth * 0.5 + 0.28), 0.13);
      }
    }
    // Dashed merge/diverge boundary: a slightly wider, denser broken line
    // along the host's outer lane edge through each zone's crossable
    // interval, ending where the merge lane stops being usable. Phase is
    // route-absolute like every other dash.
    this._markingTag = 'zoneDash';
    for (const zone of route._zonesAsHost || []) {
      if (zone.progressive) continue;
      if (!zone.dash) continue;
      this._markingOwner = `junction:${zone.id}`;
      this._markingClassification = 'junction-local';
      this._markingBoundary = `merge-boundary:${zone.id}`;
      const pieces = zone.dashPieces?.length ? zone.dashPieces : [zone.dash];
      for (const piece of pieces) {
        for (const [from, to] of this._zoneIntervalPieces(route, [piece.from, piece.to])) {
          this._paintDashedStrip(route, 'marking', () => zone.dashLat, 0.18, 10, 5, 6, from, to);
        }
      }
    }
    // Progressive transition-owned paint. The host and branch route painters
    // are suppressed over the claimed paths above; this is the sole owner of
    // the moving exterior edge and the temporary auxiliary-lane boundary.
    for (const transition of route._progressiveTransitionsAsHost || []) {
      this._markingClassification = 'progressive-transition';
      this._markingOwner = `progressive:${transition.id}`;
      if (transition.type === 'diverge') {
        const path = (id) => transition.markingPaths.find((candidate) => candidate.id === id);
        this._markingTag = 'progressiveOuterEdge';
        this._markingBoundary = `progressive-outer-edge:${transition.id}`;
        this._paintProgressivePathStrip(
          route,
          path('aux-outer-marking'),
          'marking',
          transition.approachStart,
          transition.transferComplete,
          0.16,
        );
        this._markingTag = 'progressiveAuxBoundary';
        this._markingBoundary = `progressive-aux-boundary:${transition.id}`;
        this._paintProgressivePathDashed(
          route,
          path('aux-inner-marking'),
          'marking',
          0.18,
          10,
          5,
          6,
          transition.openingStart,
          transition.transferComplete,
        );
        this._markingTag = 'progressiveExitDivider';
        this._markingBoundary = `progressive-exit-divider:${transition.id}`;
        // Match the final transition dash to the last normal r1_0 dash that
        // is suppressed before transfer. Host/branch chainages do not advance
        // at exactly 1:1 here, so mapping that real dash endpoint avoids the
        // small but visible phase drift left by a constant chainage offset.
        const dividerPeriod = 15;
        const dividerLength = 6.2;
        const routeDividerPhase = 6;
        const lastSuppressedDash = Math.floor((
          transition.transferCompleteBranch
          - dividerLength * 0.5
          - routeDividerPhase
        ) / dividerPeriod);
        const lastSuppressedDashEnd = routeDividerPhase
          + lastSuppressedDash * dividerPeriod
          + dividerLength * 0.5;
        const dividerPhase = transition.hostAtBranch(lastSuppressedDashEnd)
          - dividerLength * 0.5;
        this._paintProgressivePathDashed(
          route,
          path('aux-divider-marking'),
          'marking',
          0.14,
          dividerPeriod,
          dividerLength,
          dividerPhase,
          transition.openingStart,
          transition.transferComplete,
        );
        continue;
      }
      this._markingTag = 'progressiveOuterEdge';
      this._markingBoundary = `progressive-outer-edge:${transition.id}`;
      const hostOuterIntervals = transition.type === 'diverge'
        // The exterior line changes owner where the branch can render the
        // same authoritative path. Keeping host ownership until the later
        // source-deck split extrapolates the curve beyond the widened host
        // envelope, so the painter clips it and leaves a real longitudinal
        // gap. Branch ownership begins at the measured exterior handoff.
        ? [[transition.approachStart, transition.exteriorHandoffStart]]
        : [transition.hostInterval];
      for (const interval of hostOuterIntervals) {
        for (const [from, to] of this._zoneIntervalPieces(route, interval)) {
          this._paintStrip(
            route,
            'marking',
            from,
            to,
            (frame) => transition.type === 'diverge'
              ? transition.auxOuterMarkingLateralAt(frame.distance)
              : transition.outerMarkingLateralAt(frame.distance),
            0.16,
          );
        }
      }
      this._markingTag = 'progressiveAuxBoundary';
      this._markingBoundary = `progressive-aux-boundary:${transition.id}`;
      const hostDashInterval = transition.type === 'diverge'
        ? [transition.openingStart, transition.physicalSplitStart]
        : transition.crossableInterval;
      for (const [from, to] of this._zoneIntervalPieces(route, hostDashInterval)) {
        this._paintDashedStrip(
          route,
          'marking',
          (frame) => transition.type === 'diverge'
            ? transition.auxInnerMarkingLateralAt(frame.distance)
            : transition.boundaryLateralAt(frame.distance),
          0.18,
          10,
          5,
          6,
          from,
          to,
        );
      }
      if (transition.type === 'merge' && transition.auxiliaryLaneCount > 1) {
        this._markingTag = 'progressiveMergeDivider';
        this._markingBoundary = `progressive-first-absorption-boundary:${transition.id}`;
        const firstAbsorptionEnd = transition.absorptionSteps[0]?.to
          ?? transition.secondAbsorptionStart;
        for (const [from, to] of this._zoneIntervalPieces(
          route,
          [transition.openingStart, firstAbsorptionEnd],
        )) {
          this._paintDashedStrip(
            route,
            'marking',
            (frame) => transition.auxDividerLateralAt(frame.distance),
            0.18,
            10,
            5,
            6,
            from,
            to,
          );
        }
      }
    }
    // Branch-owned paint must be emitted while the branch itself is being
    // dressed. Route dressing is intentionally sequential, so attempting to
    // paint this from the host loop can run before the branch has surface
    // frames and silently emit no geometry. Keeping both halves under the
    // transition owner still gives one source of truth, while using the
    // correct route's authoritative deck frames.
    for (const transition of route._progressiveTransitionsAsBranch || []) {
      if (transition.type !== 'diverge') continue;
      this._markingClassification = 'progressive-transition';
      this._markingOwner = `progressive:${transition.id}`;
      this._markingTag = 'progressiveBranchGoreEdge';
      this._markingBoundary = `progressive-branch-gore-edge:${transition.id}`;
      for (const [from, to] of this._zoneIntervalPieces(
        route,
        [transition.transferCompleteBranch, transition.markingSettleEnd],
      )) {
        this._paintStrip(
          route,
          'marking',
          from,
          to,
          (frame) => transition.settledBranchInnerMarkingLateralAt(frame.distance),
          0.16,
        );
      }
    }
    this._markingTag = null;
    this._markingOwner = null;
    this._markingClassification = null;
    this._markingBoundary = null;

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
      if (area.accessDisabled) continue; // no access lane — don't advertise the exit
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
    // Building, shutter and fascia sign stay on the LOT anchor; the pulsing
    // transition ring + beacon follow the functional entrance trigger, which
    // sits on the mainline shoulder while the access lane is disabled.
    const lotAnchor = area.garageLotAnchor || area.garageEntrance;
    const frontNormal = area.normal.clone();
    const orientation = yawQuaternion(frontNormal);
    const buildingPos = lotAnchor.clone().addScaledVector(frontNormal, 18);
    buildingPos.y = area.elevation + 6.2;
    this._instance(buildingPos, vec(48, 12.4, 34), orientation, null, 'box:garage');

    const shutterPos = lotAnchor.clone().addScaledVector(frontNormal, 0.8);
    shutterPos.y = area.elevation + 3.45;
    this._instance(shutterPos, vec(24, 6.8, 0.42), orientation, null, 'box:vending');
    const sign = this._makeSignMesh('WANGAN WORKS|湾岸整備工場', '#582b72', 17, 3.25, true);
    const signPos = lotAnchor.clone().addScaledVector(frontNormal, 0.45);
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
    height *= CITY_BUILDING_HEIGHT_SCALE;
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
      prototypePins: this.progressiveCandidateClassifications.map((candidate) => ({
        id: candidate.id,
        pinId: candidate.pinId,
        label: candidate.label,
        category: candidate.active ? 'progressive-prototype' : 'deferred-progressive-candidate',
        classification: candidate.classification.category,
        classificationReason: candidate.classification.reason,
        collisionDeckOwnership: candidate.classification.metrics.collisionDeckOwnership,
        type: candidate.type,
        side: candidate.side,
        hostRouteId: candidate.hostRouteId,
        branchRouteId: candidate.branchRouteId,
        hostLaneCount: candidate.hostLaneCount,
        branchLaneCount: candidate.branchLaneCount,
        topology: candidate.active ? candidate.transition.topology : null,
        temporaryLaneCount: candidate.active ? candidate.transition.temporaryLaneCount : null,
        finalLaneCount: candidate.active ? candidate.transition.finalLaneCount : null,
        laneSequence: candidate.active && candidate.transition.absorptionSteps.length
          ? [
            candidate.transition.temporaryLaneCount,
            ...candidate.transition.absorptionSteps.map((step) => step.toLaneCount),
          ]
          : null,
        status: candidate.active ? candidate.transition.automationStatus : `deferred-${candidate.classification.category}`,
        teleportRouteId: candidate.hostRouteId,
        distance: candidate.distance,
        phases: candidate.active ? {
          approachStart: candidate.transition.approachStart,
          openingStart: candidate.transition.openingStart,
          parallelStart: candidate.transition.parallelStart,
          absorptionStart: candidate.transition.absorptionStart,
          firstAbsorptionEnd: candidate.transition.firstAbsorptionEnd,
          secondAbsorptionStart: candidate.transition.secondAbsorptionStart,
          transitionEnd: candidate.transition.transitionEnd,
        } : null,
        x: candidate.pin.x,
        y: candidate.pin.y,
        z: candidate.pin.z,
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

  /**
   * Query-only P4 ownership overlay. Every coloured segment comes from paint
   * quads, parapet vertices, or collision walls that were actually emitted by
   * the production builders; the overlay never reconstructs nominal geometry
   * from presentation constants. This makes a missing owner just as visible as
   * a duplicate one.
   */
  _buildP4OwnershipDebugOverlay() {
    const transition = this.progressiveTransitionById.get('J2:diverge:c1_0:r1_0:start');
    if (!transition) return;
    const host = transition.sourceZone.host;
    const branch = transition.sourceZone.branch;
    const group = new THREE.Group();
    group.name = 'P4 emitted ownership debug overlay';
    group.renderOrder = 1100;
    const addRibbon = (name, segments, color, width = 0.3, lift = 0.62) => {
      if (!segments.length) return null;
      const positions = [];
      const indices = [];
      for (const segment of segments) {
        const start = segment.start;
        const end = segment.end;
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-4) continue;
        const nx = -dz / length * width * 0.5;
        const nz = dx / length * width * 0.5;
        const base = positions.length / 3;
        positions.push(
          start.x + nx, start.y + lift, start.z + nz,
          start.x - nx, start.y + lift, start.z - nz,
          end.x + nx, end.y + lift, end.z + nz,
          end.x - nx, end.y + lift, end.z - nz,
        );
        indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
      }
      if (!positions.length) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }));
      mesh.name = name;
      mesh.renderOrder = 1100;
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    };
    const addMarkers = (name, records, color) => {
      if (!records.length) return;
      const material = new THREE.MeshBasicMaterial({
        color, depthTest: false, depthWrite: false, toneMapped: false,
      });
      for (const [index, record] of records.entries()) {
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.48, 10, 7), material);
        marker.name = `${name} ${index + 1}`;
        marker.position.set(record.x, record.y + 0.9, record.z);
        marker.renderOrder = 1102;
        marker.frustumCulled = false;
        group.add(marker);
      }
    };
    const overlaps = (from, to, interval) => to > interval[0] + 0.01
      && from < interval[1] - 0.01;
    const inP4Vicinity = (piece) => {
      if (piece.routeId === host.id) {
        return overlaps(piece.sFrom, piece.sTo, [transition.approachStart - 8, transition.transferComplete + 8]);
      }
      if (piece.routeId === branch.id) {
        return overlaps(piece.sFrom, piece.sTo, [0, transition.markingSettleEnd + 20]);
      }
      return false;
    };
    const retainedPaint = this._markingLog.filter((piece) => (
      piece.kind === 'strip' && inP4Vicinity(piece)));
    const isTransitionPaint = (piece) => piece.owner === `progressive:${transition.id}`;
    const isIllegalRetained = (piece) => {
      if (isTransitionPaint(piece)) return false;
      if (piece.routeId === host.id) {
        return piece.owner === `route:${host.id}`
          && piece.boundary === `edge:${transition.sideSign}`
          && overlaps(piece.sFrom, piece.sTo, transition.hostInterval);
      }
      if (piece.routeId !== branch.id || piece.owner !== `route:${branch.id}`) return false;
      if (overlaps(piece.sFrom, piece.sTo, transition.branchInterval)) return true;
      return piece.boundary === `edge:${transition.sourceZone.hostwardSign}`
        && overlaps(
          piece.sFrom,
          piece.sTo,
          [transition.transferCompleteBranch, transition.markingSettleEnd],
        );
    };
    const illegalPaint = retainedPaint.filter(isIllegalRetained);
    const legalPaint = retainedPaint.filter((piece) => !isIllegalRetained(piece));
    const hostPaint = legalPaint.filter((piece) => (
      piece.routeId === host.id && !isTransitionPaint(piece)));
    const branchPaint = legalPaint.filter((piece) => (
      piece.routeId === branch.id && !isTransitionPaint(piece)));
    const transitionPaint = legalPaint.filter(isTransitionPaint);
    addRibbon('host-emitted markings (red)', hostPaint, 0xff2a2a, 0.3, 0.7);
    addRibbon('branch-emitted markings (green)', branchPaint, 0x38ff68, 0.3, 0.72);
    addRibbon('transition-emitted markings (yellow)', transitionPaint, 0xffe52a, 0.36, 0.78);
    addRibbon('illegal retained markings (magenta)', illegalPaint, 0xff29e6, 0.52, 0.9);
    const suppressedAttempts = this._markingLog.filter((piece) => (
      piece.kind === 'suppressedStrip' && inP4Vicinity(piece)));

    const hostRailSamples = (host._progressiveRailSamples || [])
      .filter((sample) => sample.transitionId === transition.id)
      .sort((left, right) => left.distance - right.distance);
    const branchRailSamples = (branch._progressiveRailSamples || [])
      .filter((sample) => sample.transitionId === transition.id)
      .sort((left, right) => left.distance - right.distance);
    const railSegments = (samples) => samples.slice(1).map((sample, index) => ({
      start: samples[index].actualBasePosition,
      end: sample.actualBasePosition,
      from: samples[index],
      to: sample,
    }));
    const hostRailSegments = railSegments(hostRailSamples);
    const branchRailSegments = railSegments(branchRailSamples);
    addRibbon(
      'host guardrail (blue)',
      hostRailSegments.filter((segment) => (
        (segment.from.distance + segment.to.distance) * 0.5 < transition.openingStart)),
      0x2485ff,
      0.42,
      0.95,
    );
    const sharedRailSegments = [
      ...hostRailSegments.filter((segment) => (
        (segment.from.distance + segment.to.distance) * 0.5 >= transition.openingStart)),
      ...branchRailSegments.filter((segment) => (
        segment.from.role === 'branch-gore' && segment.to.role === 'branch-gore')),
    ];
    addRibbon('transition-owned guardrail (white)', sharedRailSegments, 0xffffff, 0.46, 1.0);
    const branchExteriorSegments = branchRailSegments.filter((segment) => (
      segment.from.role === 'branch-exterior' && segment.to.role === 'branch-exterior'));
    addRibbon('branch guardrail (orange)', branchExteriorSegments, 0xff8b24, 0.42, 0.98);

    const handoffHost = hostRailSamples.at(-1)?.actualBasePosition;
    const exteriorBranchSamples = branchRailSamples.filter((sample) => sample.role === 'branch-exterior');
    const handoffBranch = exteriorBranchSamples[0]?.actualBasePosition;
    const handoffGap = handoffHost && handoffBranch ? Math.hypot(
      handoffHost.x - handoffBranch.x,
      handoffHost.y - handoffBranch.y,
      handoffHost.z - handoffBranch.z,
    ) : Infinity;
    if (Number.isFinite(handoffGap) && handoffGap <= 6) {
      addRibbon(
        'bounded transition rail handoff (white)',
        [{ start: handoffHost, end: handoffBranch }],
        0xffffff,
        0.2,
        1.04,
      );
    }
    const unexplainedRailGaps = [];
    if (!Number.isFinite(handoffGap) || handoffGap > 6) {
      if (handoffHost && handoffBranch) unexplainedRailGaps.push({ start: handoffHost, end: handoffBranch });
    }
    addRibbon('unexplained guardrail gaps (cyan)', unexplainedRailGaps, 0x24f5ff, 0.58, 1.14);

    const corridor = transition.auxiliaryCorridor;
    const proximityToCorridor = (value) => {
      const section = corridor.reduce((best, candidate) => (
        xzDistanceSq(value, candidate.centre) < xzDistanceSq(value, best.centre)
          ? candidate : best
      ));
      const dx = section.outer.x - section.inner.x;
      const dz = section.outer.z - section.inner.z;
      const denominator = dx * dx + dz * dz;
      const t = denominator > 1e-9
        ? clamp(((value.x - section.inner.x) * dx + (value.z - section.inner.z) * dz) / denominator, 0, 1)
        : 0;
      return {
        t,
        distance: Math.hypot(
          value.x - (section.inner.x + dx * t),
          value.z - (section.inner.z + dz * t),
        ),
      };
    };
    const blockedRailSamples = [...hostRailSamples, ...branchRailSamples]
      .filter((sample) => {
        const proximity = proximityToCorridor(sample.actualBasePosition);
        return proximity.t > 0.03 && proximity.t < 0.97 && proximity.distance < 0.45;
      });
    const blockedWallSegments = this.wallSegments.filter((segment) => {
      if (segment.progressiveTransitionId !== transition.id) return false;
      const middle = segment.start.clone().lerp(segment.end, 0.5);
      return [segment.start, middle, segment.end].some((value) => {
        const proximity = proximityToCorridor(value);
        return proximity.t > 0.03 && proximity.t < 0.97 && proximity.distance < 0.45;
      });
    });
    addMarkers(
      'blocked drivable opening (bright red)',
      [
        ...blockedRailSamples.map((sample) => sample.actualBasePosition),
        ...blockedWallSegments.flatMap((segment) => [segment.start, segment.end]),
      ],
      0xff0022,
    );
    group.userData = {
      readOnly: true,
      junctionId: transition.id,
      markings: {
        host: hostPaint.length,
        branch: branchPaint.length,
        transition: transitionPaint.length,
        illegalRetained: illegalPaint.length,
        suppressedAttempts: suppressedAttempts.length,
      },
      rails: {
        hostSegments: hostRailSegments.length,
        branchSegments: branchExteriorSegments.length,
        transitionSegments: sharedRailSegments.length,
        blocked: blockedRailSamples.length + blockedWallSegments.length,
        unexplainedGaps: unexplainedRailGaps.length,
        handoffGap,
      },
    };
    this.group.add(group);
    this.progressiveOwnershipDebugOverlay = group;
  }

  /**
   * Read-only P4 capture overlay, enabled only by the explicit screenshot
   * query option. It visualises the authoritative model records consumed by
   * rendering/physics; it does not create an alternate geometry source.
   */
  _buildProgressiveCorridorDebugOverlay() {
    const transition = this.progressiveTransitionById.get('J2:diverge:c1_0:r1_0:start');
    if (!transition?.auxiliaryCorridor?.length) return;
    const group = new THREE.Group();
    group.name = 'P4 progressive corridor debug overlay';
    group.renderOrder = 1000;
    const material = (color, opacity = 0.96) => new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const line = (name, records, color, lift = 0.32) => {
      const points = records.map((record) => new THREE.Vector3(
        record.x,
        record.y + lift,
        record.z,
      ));
      const object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material(color));
      object.name = name;
      object.renderOrder = 1000;
      object.frustumCulled = false;
      group.add(object);
      return object;
    };
    const auxiliaries = transition.laneCentres.filter((path) => path.id.startsWith('aux:'));
    const inner = transition.laneBoundaries.find((path) => path.id === 'aux-inner-boundary');
    const divider = transition.laneBoundaries.find((path) => path.id === 'aux-divider-boundary');
    const outer = transition.laneBoundaries.find((path) => path.id === 'aux-outer-boundary');
    auxiliaries.forEach((auxiliary, index) => line(
      `auxiliary lane ${index} centre path`,
      auxiliary.points.map((entry) => entry.position),
      index === 0 ? 0x29e6ff : 0x6e7dff,
      0.42,
    ));
    line('exit carriageway inner boundary', inner.points.map((entry) => entry.position), 0xffa52f, 0.36);
    if (divider) {
      line('exit carriageway lane divider', divider.points.map((entry) => entry.position), 0xffffff, 0.4);
    }
    line('exit carriageway outer boundary', outer.points.map((entry) => entry.position), 0xff3fd2, 0.36);

    // Continue both real branch-lane targets beyond the ownership marker so
    // the overlay proves the temporary 2+2 section transfers into r1_0 2+2,
    // rather than collapsing its exterior edge onto the branch divider.
    const targetStart = Math.max(0, transition.exteriorHandoffBranchStart);
    const targetEnd = Math.min(
      transition.sourceZone.branch.length,
      transition.transferCompleteBranch + 48,
    );
    const targetRows = [];
    for (let branchS = targetStart; branchS < targetEnd; branchS += 2) {
      targetRows.push({ branchS });
    }
    targetRows.push({ branchS: targetEnd });
    const debugPoint = (value) => ({ x: value.x, y: value.y, z: value.z });
    transition.branchExitLanes.forEach((lane, index) => {
      const targetLateral = this._laneOffset(transition.sourceZone.branch, lane, 1);
      line(`target branch lane ${lane} centre`, targetRows.map((entry) => {
        const frame = this._frameAt(transition.sourceZone.branch, entry.branchS);
        return debugPoint(this._deckPoint(frame, targetLateral, 0.04));
      }), index === 0 ? 0x70ff55 : 0xb3ff55, 0.48);
    });
    const targetHalf = transition.sourceZone.branch.laneWidth * 0.5;
    const hostwardLane = transition.branchExitLanes[0];
    const outwardLane = transition.branchExitLanes.at(-1);
    const hostwardLateral = this._laneOffset(transition.sourceZone.branch, hostwardLane, 1);
    const outwardLateral = this._laneOffset(transition.sourceZone.branch, outwardLane, 1);
    line('target exit-carriageway inner boundary', targetRows.map((entry) => {
      const frame = this._frameAt(transition.sourceZone.branch, entry.branchS);
      return debugPoint(this._deckPoint(
        frame,
        hostwardLateral + transition.sourceZone.hostwardSign * targetHalf,
        0.04,
      ));
    }), 0xc4ff52, 0.4);
    line('target branch divider', targetRows.map((entry) => {
      const frame = this._frameAt(transition.sourceZone.branch, entry.branchS);
      return debugPoint(this._deckPoint(frame, 0, 0.04));
    }), 0xffffff, 0.42);
    line('target exit-carriageway outer boundary', targetRows.map((entry) => {
      const frame = this._frameAt(transition.sourceZone.branch, entry.branchS);
      return debugPoint(this._deckPoint(
        frame,
        outwardLateral - transition.sourceZone.hostwardSign * targetHalf,
        0.04,
      ));
    }), 0xc4ff52, 0.4);

    const widthVertices = [];
    for (let index = 0; index < transition.auxiliaryCorridor.length; index += 5) {
      const section = transition.auxiliaryCorridor[index];
      widthVertices.push(
        new THREE.Vector3(section.inner.x, section.inner.y + 0.5, section.inner.z),
        new THREE.Vector3(section.outer.x, section.outer.y + 0.5, section.outer.z),
      );
    }
    const widths = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(widthVertices),
      material(0xffffff, 0.8),
    );
    widths.name = 'full-path width samples';
    widths.renderOrder = 1001;
    widths.frustumCulled = false;
    group.add(widths);

    const handoff = transition.auxiliaryCorridor.at(-1).centre;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(1.25, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffee22,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    marker.name = 'branch ownership handoff point';
    marker.position.set(handoff.x, handoff.y + 1.6, handoff.z);
    marker.renderOrder = 1002;
    marker.frustumCulled = false;
    group.add(marker);
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(handoff.x, handoff.y + 0.3, handoff.z),
        new THREE.Vector3(handoff.x, handoff.y + 8, handoff.z),
      ]),
      material(0xffee22),
    );
    stem.name = 'ownership handoff stem';
    stem.renderOrder = 1001;
    group.add(stem);
    group.userData = {
      readOnly: true,
      junctionId: transition.id,
      minimumWidth: Math.min(...transition.auxiliaryCorridor.map((section) => section.width)),
      minimumLaneWidth: Math.min(
        ...transition.auxiliaryLaneCorridors.flat().map((section) => section.width),
      ),
      topology: transition.topology,
      transferCompleteHostS: transition.transferComplete,
      transferCompleteBranchS: transition.transferCompleteBranch,
    };
    this.group.add(group);
    this.progressiveCorridorDebugOverlay = group;
  }

  /** Read-only J48 plan overlay for the branch-to-five-lane handoff audit. */
  _buildP2HandoffDebugOverlay() {
    const transition = this.progressiveTransitionById.get('J48:merge:wangan_1:ramp_41:end');
    if (!transition?.auxiliaryLaneCorridors?.length) return;
    const group = new THREE.Group();
    group.name = 'P2 merge handoff debug overlay';
    group.renderOrder = 1100;
    const material = (color, opacity = 0.96) => new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const line = (name, records, color, lift = 0.42, opacity = 0.96) => {
      const points = records.map((record) => new THREE.Vector3(
        record.x,
        record.y + lift,
        record.z,
      ));
      const object = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        material(color, opacity),
      );
      object.name = name;
      object.renderOrder = 1100;
      object.frustumCulled = false;
      group.add(object);
      return object;
    };
    const laneColors = [0x35d6ff, 0x45ff89, 0xffdf45, 0xff5cdb, 0xa56cff];
    transition.laneCentres.forEach((path, index) => line(
      `${path.id} centre path`,
      path.points.map((entry) => entry.position),
      laneColors[index],
      0.55,
    ));
    const hostLaneEdge = transition.sideSign
      * transition.hostLaneCount * transition.auxiliaryWidth * 0.5;
    const hostReferenceRows = transition.pavedEnvelope.filter((row) => (
      row.hostS >= transition.approachStart - 0.01
      && row.hostS <= transition.fiveLaneEnd + 0.01
    ));
    line('true three-lane host exterior edge', hostReferenceRows.map((row) => {
      const frame = this._frameAt(
        transition.sourceZone.host,
        this._normalizeDistance(transition.sourceZone.host, row.hostS),
      );
      return this._deckPoint(frame, hostLaneEdge, 0.44);
    }), 0xff3b30, 0, 0.92);
    const fullFiveRows = hostReferenceRows.filter((row) => (
      row.hostS >= transition.fiveLaneStart - 0.01
    ));
    [0, 1].forEach((lane) => {
      const lateral = transition.sideSign * (
        transition.hostLaneCount * transition.auxiliaryWidth * 0.5
        + transition.auxiliaryWidth * (lane + 0.5)
      );
      line(`appended temporary slot aux:${lane}`, fullFiveRows.map((row) => {
        const frame = this._frameAt(
          transition.sourceZone.host,
          this._normalizeDistance(transition.sourceZone.host, row.hostS),
        );
        return this._deckPoint(frame, lateral, 0.48);
      }), lane === 0 ? 0xff8ee5 : 0xc2a8ff, 0, 0.44);
    });

    const widthVertices = [];
    const handoffCorridors = transition.auxiliaryLaneCorridors.map((corridor) => (
      corridor.filter((section) => section.hostS <= transition.fiveLaneStart + 0.01)
    ));
    const sampleStride = Math.max(1, Math.floor(handoffCorridors[0].length / 10));
    for (let index = 0; index < handoffCorridors[0].length; index += sampleStride) {
      for (const corridor of handoffCorridors) {
        const section = corridor[index];
        if (!section) continue;
        widthVertices.push(
          new THREE.Vector3(section.inner.x, section.inner.y + 0.7, section.inner.z),
          new THREE.Vector3(section.outer.x, section.outer.y + 0.7, section.outer.z),
        );
      }
    }
    const widths = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(widthVertices),
      material(0xffffff, 0.86),
    );
    widths.name = 'sampled ramp lane widths';
    widths.renderOrder = 1101;
    widths.frustumCulled = false;
    group.add(widths);

    const makeLabel = (text, color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 128;
      const context = canvas.getContext('2d');
      context.fillStyle = 'rgba(2, 5, 12, 0.90)';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = color;
      context.lineWidth = 8;
      context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
      context.fillStyle = '#ffffff';
      context.font = '700 43px ui-monospace, monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(text, canvas.width * 0.5, canvas.height * 0.52);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }));
      sprite.scale.set(76, 9.5, 1);
      sprite.renderOrder = 1103;
      sprite.frustumCulled = false;
      return sprite;
    };
    const phaseMarkers = [
      ['OPENING', transition.mergeOpeningStart, '#ff8f3f', 0xff8f3f],
      ['HANDOFF / FULL 5 START', transition.fiveLaneStart, '#fff04a', 0xfff04a],
      ['FULL 5 END / FIRST ABS', transition.fiveLaneEnd, '#55ff88', 0x55ff88],
      ['SECOND ABS 4->3', transition.secondAbsorptionStart, '#d279ff', 0xd279ff],
      ['STABLE 3-LANE', transition.transitionEnd, '#45dfff', 0x45dfff],
    ];
    for (const [label, hostS, cssColor, color] of phaseMarkers) {
      const frame = this._frameAt(
        transition.sourceZone.host,
        this._normalizeDistance(transition.sourceZone.host, hostS),
      );
      const envelope = transition.envelopeAt(hostS);
      const lower = this._deckPoint(frame, envelope.lateralMin, 0.75);
      const upper = this._deckPoint(frame, envelope.lateralMax, 0.75);
      line(`${label} station`, [lower, upper], color, 0);
      const sprite = makeLabel(`${label}  ${hostS.toFixed(2)}`, cssColor);
      const anchor = this._deckPoint(
        frame,
        envelope.lateralMin - transition.sideSign * 30,
        2.2,
      );
      sprite.position.copy(anchor);
      group.add(sprite);
    }
    const preHandoffWidths = handoffCorridors.flat().map((section) => section.width);
    const temporaryLaneCentreOffsets = [
      ...Array.from({ length: transition.hostLaneCount }, (_, lane) => (
        this._laneOffset(transition.sourceZone.host, lane, 1)
      )),
      ...Array.from({ length: transition.auxiliaryLaneCount }, (_, lane) => (
        transition.sideSign * (
          transition.hostLaneCount * transition.auxiliaryWidth * 0.5
          + transition.auxiliaryWidth * (lane + 0.5)
        )
      )),
    ].sort((left, right) => (transition.sideSign > 0 ? right - left : left - right));
    group.userData = {
      readOnly: true,
      junctionId: transition.id,
      opening: transition.mergeOpeningStart,
      handoffComplete: transition.mergeHandoffComplete,
      fiveLaneStart: transition.fiveLaneStart,
      fiveLaneEnd: transition.fiveLaneEnd,
      firstAbsorptionStart: transition.absorptionStart,
      secondAbsorptionStart: transition.secondAbsorptionStart,
      stableThreeLaneStart: transition.transitionEnd,
      minimumPreHandoffLaneWidth: Math.min(...preHandoffWidths),
      sampledPreHandoffLaneWidths: preHandoffWidths,
      hostExteriorLaneEdgeOffset: hostLaneEdge,
      temporaryLaneCentreOffsets,
    };
    this.group.add(group);
    this.progressiveMergeHandoffDebugOverlay = group;
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
