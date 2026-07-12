import * as THREE from './three-fallback.js';

/**
 * Shutoko Nights world module — a scaled, topologically faithful low-poly
 * recreation of Tokyo's Shuto Expressway at night.
 *
 * Coordinates: metres. +X east, +Z north, +Y up. Heading 0 faces +Z and the
 * world is left-hand traffic: for travel direction d (+1 = along the authored
 * curve) the carriageway occupies the NEGATIVE side of the directed curve
 * normal (the directed normal is the driver's right, so lanes sit to the
 * left of the centreline and lane 0 hugs the median, Japan style).
 *
 * Network (blueprint):
 *   c1      C1 Inner Circular loop (~14.5 km, 2 lanes/dir, level E, one T tunnel)
 *   r11     Route 11 Daiba line + Rainbow Bridge (H deck over open water)
 *   wangan  Bayshore line (~31 km, 3 lanes/dir, Tokyo Port Tunnel at T)
 *   r9      Route 9 Fukagawa connector (E with an H river flyover)
 *   k1      K1 Yokohane line (E over industrial suburbs)
 *   dj      Daikoku JCT loop (H) + spiral (G), U-turn ramp (S), Daikoku PA
 * plus one-way junction ramps, a signed-closed stub at C1-W, and four PAs
 * (Shibaura + garage, Tatsumi, Heiwajima, Daikoku).
 *
 * Junction rule: carriageways NEVER cross at grade. Connectivity is a list of
 * directed edges (diverge / merge / continuation) between routes, and every
 * crossing is grade-separated by authored elevations (T -15, G 0, E +12,
 * H +24, S +36). Collision is the union of route corridors: a point is
 * drivable iff it is inside at least one corridor (or a PA lot) at a matching
 * elevation, so barriers are continuous and can never be disabled.
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

    this.routeAliases.set('c1_outer', { id: 'c1', direction: 1 });
    this.routeAliases.set('c1_inner', { id: 'c1', direction: -1 });
    this.routeAliases.set('c1o', { id: 'c1', direction: 1 });
    this.routeAliases.set('c1i', { id: 'c1', direction: -1 });
    this.routeAliases.set('yokohane', { id: 'k1', direction: 1 });
    this.routeAliases.set('bayshore', { id: 'wangan', direction: 1 });
    this.routeAliases.set('b', { id: 'wangan', direction: 1 });
    this.routeAliases.set('rainbow', { id: 'r11', direction: 1 });
    this.routeAliases.set('11', { id: 'r11', direction: 1 });
    this.routeAliases.set('bay_link', { id: 'dj', direction: 1 });
    this.routeAliases.set('shinjuku', { id: 'c1', direction: 1 });
    this.trafficLanes = this.getTrafficLanes();

    const garageArea = this.serviceAreas.find((area) => area.hasGarage);
    const mainRoute = this.routes.get(garageArea.routeId);
    const spawnDistance = wrap(garageArea.mainDistance + garageArea.direction * 620, mainRoute.length);
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
    const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({
      color, flatShading: false, fog: true, ...extra,
    });
    const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({
      color, fog: true, toneMapped: false, ...extra,
    });
    return {
      road: lambert(0x14171f),
      roadAlt: lambert(0x171a23),
      roadService: lambert(0x1d2029),
      concrete: lambert(0x4c4f57),
      concreteDark: lambert(0x272a31),
      barrier: lambert(0x585b61),
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
      buildingWindow: basic(0x6b5c38),
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
    };
  }

  // ------------------------------------------------------------------
  // Network definition
  // ------------------------------------------------------------------

  _defineNetwork() {
    // C1 inner loop, counterclockwise N -> W -> S -> E, irregular radius
    // 1.9-2.5 km, level E rolling +8..+16 with the Yaesu tunnel on the NE arc.
    this._registerRoute({
      id: 'c1', code: 'C1', name: 'C1 Inner Loop', kind: 'loop', closed: true,
      lanes: 2, speedLimit: 80,
      destinations: [['都心環状', 'C1 LOOP'], ['銀座', 'GINZA'], ['芝浦', 'SHIBAURA'], ['神田橋', 'KANDABASHI']],
      points: [
        vec(0, 14, 2300),      // N JCT
        vec(-1000, 12, 2050),
        vec(-1850, 10, 1350),
        vec(-2150, 12, 700),
        vec(-2300, 12, 0),     // W JCT (closed stub)
        vec(-2200, 14, -800),
        vec(-1400, 12, -1350),
        vec(-700, 10, -1800),
        vec(0, 10, -2300),     // S JCT — Shibaura, R11 departs
        vec(950, 11, -2250),
        vec(1800, 13, -1700),
        vec(2200, 12, -800),
        vec(2300, 12, 0),      // E JCT — R9 arrives (multi-level)
        vec(2400, 8, 750),
        vec(2250, -15, 1400),  // Yaesu tunnel (T) with a curve inside
        vec(1500, -15, 2000),
        vec(700, 6, 2350),
      ],
      tunnelZones: [{ nearA: vec(2340, 0, 1080), nearB: vec(1080, 0, 2210), name: 'Yaesu tunnel', style: 'white' }],
    });

    // Route 11 — Daiba line with the Rainbow Bridge (H deck over open water).
    this._registerRoute({
      id: 'r11', code: '11', name: 'Route 11 Daiba', kind: 'connector',
      lanes: 2, speedLimit: 80,
      destinations: [['台場', 'DAIBA'], ['湾岸線', 'WANGAN'], ['レインボーブリッジ', 'RAINBOW BRIDGE']],
      points: [
        vec(750, 11, -2600),   // start SE of C1-S (ramps hook up here)
        vec(830, 13, -2980),
        vec(700, 18, -3320),
        vec(520, 24, -3650),   // north approach climbs to H
        vec(420, 25, -4100),   // ...over the north tower
        vec(390, 25, -4600),   // main span
        vec(380, 24, -5150),   // south tower
        vec(420, 20, -5580),
        vec(340, 14, -5980),
        vec(180, 11, -6240),
        vec(40, 10, -6420),    // lands beside the Wangan (Daiba JCT)
      ],
      bridgeZone: { nearA: vec(500, 0, -3600), nearB: vec(420, 0, -5620) },
    });

    // Wangan / Bayshore — the backbone. Tatsumi (east end) to Daikoku (west
    // end) with the Tokyo Port Tunnel dipping to T under the bay.
    this._registerRoute({
      id: 'wangan', code: 'B', name: 'Wangan Bayshore', kind: 'arterial',
      lanes: 3, speedLimit: 100,
      destinations: [['湾岸線', 'WANGAN LINE'], ['大黒', 'DAIKOKU'], ['羽田', 'HANEDA'], ['空港中央', 'AIRPORT']],
      points: [
        vec(11000, 12, -5500), // Tatsumi JCT (continues as R9)
        vec(10800, 11, -6050),
        vec(10100, 10, -6400),
        vec(8900, 10, -6550),
        vec(7400, 9, -6450),
        vec(5800, 9, -6350),
        vec(4200, 10, -6300),
        vec(2600, 10, -6350),
        vec(1200, 10, -6450),
        vec(0, 10, -6500),     // Daiba JCT — R11 lands here
        vec(-1000, 8, -6700),
        vec(-1800, 2, -6950),
        vec(-2600, -13, -7150), // Tokyo Port Tunnel (T)
        vec(-3500, -16, -7300),
        vec(-4400, -15, -7400),
        vec(-5200, -6, -7500),
        vec(-6100, 4, -7700),
        vec(-7000, 10, -8000), // Oi JCT — K1 ramps
        vec(-8000, 11, -8900),
        vec(-9200, 10, -9800),
        vec(-10600, 10, -10800),
        vec(-12200, 11, -11700),
        vec(-13800, 10, -12500),
        vec(-15300, 11, -13200),
        vec(-16600, 12, -13750),
        vec(-17500, 12, -14050),
        vec(-18100, 12, -14250), // Daikoku JCT (continues as dj loop)
      ],
      tunnelZones: [{ nearA: vec(-2280, 0, -7080), nearB: vec(-5450, 0, -7550), name: 'Tokyo Port Tunnel', style: 'orange' }],
    });

    // Route 9 — Fukagawa connector, Tatsumi to C1-E, E with an H flyover.
    this._registerRoute({
      id: 'r9', code: '9', name: 'Route 9 Fukagawa', kind: 'connector',
      lanes: 2, speedLimit: 80,
      destinations: [['深川', 'FUKAGAWA'], ['都心環状', 'C1 LOOP'], ['箱崎', 'HAKOZAKI']],
      points: [
        vec(11000, 12, -5500), // == wangan east end (continuation)
        vec(10600, 13, -4900),
        vec(10100, 14, -4100),
        vec(9400, 16, -3200),
        vec(8500, 22, -2400),
        vec(7400, 24, -1700),  // H flyover over the river
        vec(6200, 24, -1150),
        vec(5100, 18, -700),
        vec(4000, 13, -350),
        vec(3050, 12, -100),   // Hakozaki-style approach to C1-E
      ],
    });

    // K1 Yokohane — Oi to Daikoku over the industrial suburbs (inland of B).
    this._registerRoute({
      id: 'k1', code: 'K1', name: 'K1 Yokohane', kind: 'arterial',
      lanes: 2, speedLimit: 90,
      destinations: [['横羽線', 'K1 YOKOHANE'], ['平和島', 'HEIWAJIMA'], ['大黒', 'DAIKOKU'], ['羽田', 'HANEDA']],
      points: [
        vec(-7250, 12, -8350), // Oi end (ramps to/from Wangan)
        vec(-7800, 12, -9000),
        vec(-8600, 13, -9700),
        vec(-9700, 12, -10400),
        vec(-11000, 12, -11000), // Heiwajima PA
        vec(-12400, 13, -11500),
        vec(-13800, 12, -11900),
        vec(-15200, 12, -12300),
        vec(-16400, 13, -12800),
        vec(-17000, 12, -13300),
        vec(-17336, 12, -14143), // Daikoku end (continuation from dj loop)
      ],
    });

    // Daikoku JCT loop — H-level 205-degree turn joining Wangan west end to
    // K1 south end, threading the multi-level stack above the PA.
    this._registerRoute({
      id: 'dj', code: 'B', name: 'Daikoku JCT', kind: 'connector',
      lanes: 2, speedLimit: 60,
      destinations: [['大黒PA', 'DAIKOKU PA'], ['横羽線', 'K1'], ['湾岸線', 'WANGAN']],
      points: [
        vec(-18100, 12, -14250), // == wangan west end
        vec(-18307, 15, -14427),
        vec(-18374, 19, -14689),
        vec(-18280, 23, -14942),
        vec(-18057, 24, -15095), // apex (H) over the PA approaches
        vec(-17786, 24, -15093),
        vec(-17591, 21, -14964),
        vec(-17560, 18, -14400), // NE run rising out of the loop
        vec(-17336, 12, -14143), // == k1 south end
      ],
    });

    // ---------------- junction ramps (one-way) ----------------
    // Shibaura JCT: C1(+1, outer/south carriageway) <-> R11 north end.
    this._addRamp({
      id: 'shibaura_off', name: 'Shibaura off-ramp',
      from: { routeId: 'c1', at: vec(-700, 0, -1800), offset: -420, direction: 1, kind: 'diverge', probability: 0.3 },
      to: { routeId: 'r11', distance: 0, direction: 1 },
      via: [vec(340, 10, -2520)],
    });
    this._addRamp({
      id: 'shibaura_on', name: 'Shibaura on-ramp',
      from: { routeId: 'r11', distance: 0, direction: -1 },
      to: { routeId: 'c1', at: vec(950, 0, -2250), offset: 420, direction: 1, kind: 'merge' },
      via: [vec(1080, 10.5, -2410)],
    });

    // Daiba JCT: R11 south end <-> Wangan.
    this._addRamp({
      id: 'daiba_on', name: 'Daiba on-ramp',
      from: { routeId: 'r11', distance: 'end', direction: 1 },
      to: { routeId: 'wangan', at: vec(-1000, 0, -6700), offset: 260, direction: 1, kind: 'merge' },
      via: [vec(-320, 9.4, -6560)],
    });
    this._addRamp({
      id: 'daiba_off', name: 'Daiba off-ramp',
      from: { routeId: 'wangan', at: vec(1200, 0, -6450), offset: -380, direction: -1, kind: 'diverge', probability: 0.25 },
      to: { routeId: 'r11', distance: 'end', direction: -1 },
      via: [vec(360, 10.4, -6420)],
    });

    // Oi JCT: Wangan <-> K1 north end.
    this._addRamp({
      id: 'oi_off', name: 'Oi off-ramp',
      from: { routeId: 'wangan', at: vec(-6100, 0, -7700), offset: -300, direction: 1, kind: 'diverge', probability: 0.3 },
      to: { routeId: 'k1', distance: 0, direction: 1 },
      via: [vec(-7000, 11.5, -8080)],
    });
    this._addRamp({
      id: 'oi_on', name: 'Oi on-ramp',
      from: { routeId: 'k1', distance: 0, direction: -1 },
      to: { routeId: 'wangan', at: vec(-8000, 0, -8900), offset: -380, direction: -1, kind: 'merge' },
      via: [vec(-7480, 11.5, -8340)],
    });

    // Hakozaki-style C1-E: R9 north end <-> C1(+1, outer/east carriageway).
    this._addRamp({
      id: 'hakozaki_on', name: 'Hakozaki on-ramp',
      from: { routeId: 'r9', distance: 'end', direction: 1 },
      to: { routeId: 'c1', at: vec(2400, 0, 750), offset: -180, direction: 1, kind: 'merge' },
      via: [vec(2660, 11, 260)],
    });
    this._addRamp({
      id: 'hakozaki_off', name: 'Hakozaki off-ramp',
      from: { routeId: 'c1', at: vec(2200, 0, -800), offset: -280, direction: 1, kind: 'diverge', probability: 0.3 },
      to: { routeId: 'r9', distance: 'end', direction: -1 },
      via: [vec(2780, 12, -620)],
      lift: 6,
    });

    // C1-W reserved stub ramp, signed closed — dead end with crash cushions.
    this._addRamp({
      id: 'w_stub', name: 'C1-W reserved ramp',
      from: { routeId: 'c1', at: vec(-2300, 0, 0), offset: -260, direction: 1, kind: 'diverge', probability: 0 },
      to: null,
      via: [vec(-2560, 11, -420), vec(-2650, 10, -560)],
    });

    // Daikoku spiral (H -> G), PA exit ramp (G -> E) and S-level U-turn.
    this._addRamp({
      id: 'daikoku_spiral', name: 'Daikoku spiral',
      kind: 'service',
      from: { routeId: 'dj', at: vec(-18374, 0, -14689), offset: -40, direction: 1, kind: 'diverge', probability: 0 },
      to: { lot: 'daikoku_pa', edge: 'in' },
      spiral: { center: vec(-18210, 0, -15290), radius: 88, turns: 1.1, fromY: 19, toY: 0.35 },
    });
    this._addRamp({
      id: 'daikoku_out', name: 'Daikoku PA exit',
      kind: 'service',
      from: { lot: 'daikoku_pa', edge: 'out' },
      to: { routeId: 'dj', at: vec(-17591 + 140, 0, -14964 + 155), offset: 220, direction: 1, kind: 'merge' },
      via: [vec(-17690, 6, -14690)],
    });
    this._addRamp({
      id: 'daikoku_uturn', name: 'Daikoku U-turn (S deck)',
      from: { routeId: 'dj', at: vec(-18307, 0, -14427), offset: -60, direction: 1, kind: 'diverge', probability: 0.15 },
      to: { routeId: 'dj', at: vec(-18057, 0, -15095), offset: 140, direction: -1, kind: 'merge' },
      via: [
        vec(-18720, 26, -14760),
        vec(-18860, 33, -15180),
        vec(-18640, 36, -15560),
        vec(-18260, 36, -15680),
        vec(-17900, 33, -15540),
        vec(-17740, 28, -15260),
      ],
    });

    this._registerJunction('shibaura_jct', 'Shibaura JCT', vec(150, 10, -2350), ['c1', 'r11']);
    this._registerJunction('daiba_jct', 'Daiba JCT', vec(0, 10, -6500), ['wangan', 'r11']);
    this._registerJunction('tatsumi_jct', 'Tatsumi JCT', vec(11000, 12, -5500), ['wangan', 'r9']);
    this._registerJunction('oi_jct', 'Oi JCT', vec(-7000, 10, -8000), ['wangan', 'k1']);
    this._registerJunction('hakozaki_jct', 'Hakozaki JCT', vec(2400, 12, 400), ['c1', 'r9']);
    this._registerJunction('daikoku_jct', 'Daikoku JCT', vec(-18100, 12, -14700), ['wangan', 'k1', 'dj']);

    // End-to-end continuations (same roadway, new name).
    this._addEdge({ from: { routeId: 'wangan', distance: 0, direction: -1 }, to: { routeId: 'r9', distance: 0, direction: 1 }, kind: 'continuation', name: 'Tatsumi JCT' });
    this._addEdge({ from: { routeId: 'r9', distance: 0, direction: -1 }, to: { routeId: 'wangan', distance: 0, direction: 1 }, kind: 'continuation', name: 'Tatsumi JCT' });
    this._addEdge({ from: { routeId: 'wangan', distance: 'end', direction: 1 }, to: { routeId: 'dj', distance: 0, direction: 1 }, kind: 'continuation', name: 'Daikoku JCT' });
    this._addEdge({ from: { routeId: 'dj', distance: 0, direction: -1 }, to: { routeId: 'wangan', distance: 'end', direction: -1 }, kind: 'continuation', name: 'Daikoku JCT' });
    this._addEdge({ from: { routeId: 'dj', distance: 'end', direction: 1 }, to: { routeId: 'k1', distance: 'end', direction: -1 }, kind: 'continuation', name: 'Daikoku JCT' });
    this._addEdge({ from: { routeId: 'k1', distance: 'end', direction: 1 }, to: { routeId: 'dj', distance: 'end', direction: -1 }, kind: 'continuation', name: 'Daikoku JCT' });
  }

  _registerRoute(config) {
    const points = config.points.map((point) => point.clone());
    const curve = new THREE.CatmullRomCurve3(points, !!config.closed, 'catmullrom', config.tension ?? 0.14);
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
    };
    this.routes.set(route.id, route);
    this.routeOrder.push(route.id);
    this.connections.set(route.id, []);
    this._prepareRouteSamples(route);
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

  /**
   * Author a one-way ramp between carriageways. Anchors are computed on the
   * outer (left) edge of the referenced carriageway so ramp corridors overlap
   * the mainline at the gore — the corridor union keeps barriers sealed.
   */
  _addRamp(def) {
    const lead = 110;
    const points = [];
    let fromEdge = null;
    let toEdge = null;
    const anchorAt = (ref) => {
      const route = this.routes.get(ref.routeId);
      let param;
      if (ref.distance === 'end') param = route.length - 6;
      else if (ref.distance === 0) param = 6;
      else if (Number.isFinite(ref.distance)) param = ref.distance;
      else param = wrap(this._projectToRoute(route, ref.at).distance + (ref.offset || 0), route.length);
      const sample = this._sampleCenter(route.id, param, ref.direction);
      const lateral = route.bidirectional
        ? route.medianWidth * 0.5 + route.lanes * route.laneWidth - 1.4
        : route.halfWidth - 2.2;
      const anchor = sample.position.clone().addScaledVector(sample.normal, -lateral);
      return { route, param, sample, anchor, tangent: sample.tangent.clone() };
    };

    if (def.from.lot) {
      const lot = this._pendingLotAnchor(def.from.lot, def.from.edge);
      points.push(lot.point, lot.point.clone().addScaledVector(lot.tangent, 60));
    } else {
      const a = anchorAt(def.from);
      if (def.from.kind === 'diverge') {
        // Ramp begins 30 m upstream of the anchor; the edge fires there so a
        // transferring vehicle lands exactly where it already is.
        points.push(
          a.anchor.clone().addScaledVector(a.tangent, -30),
          a.anchor.clone().addScaledVector(a.tangent, lead),
        );
        fromEdge = {
          from: {
            routeId: def.from.routeId,
            distance: this._normalizeDistance(a.route, a.param - 30 * def.from.direction),
            direction: def.from.direction,
          },
          kind: 'diverge',
          probability: def.from.probability ?? 0.3,
        };
      } else {
        // Departure from a route endpoint: ramp starts right at the endpoint
        // anchor so the endpoint transfer is seamless.
        points.push(a.anchor.clone(), a.anchor.clone().addScaledVector(a.tangent, lead));
        fromEdge = {
          from: { routeId: def.from.routeId, distance: def.from.distance === 'end' ? a.route.length : 0, direction: def.from.direction },
          kind: 'continuation',
          probability: 1,
        };
      }
    }

    if (def.spiral) {
      const s = def.spiral;
      const steps = Math.max(8, Math.round(s.turns * 10));
      const startAngle = Math.atan2(points[points.length - 1].x - s.center.x, points[points.length - 1].z - s.center.z);
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const angle = startAngle + t * s.turns * Math.PI * 2;
        const y = s.fromY + (s.toY - s.fromY) * t;
        points.push(vec(s.center.x + Math.sin(angle) * s.radius, y, s.center.z + Math.cos(angle) * s.radius));
      }
    }
    for (const viaPoint of def.via || []) points.push(viaPoint.clone());
    if (def.lift) {
      // raise the middle of the ramp so it clears whatever it crosses
      const mid = points[Math.floor(points.length / 2)];
      mid.y += def.lift;
    }

    if (def.to && def.to.lot) {
      const lot = this._pendingLotAnchor(def.to.lot, def.to.edge);
      points.push(lot.point.clone().addScaledVector(lot.tangent, -60), lot.point);
    } else if (def.to) {
      const b = anchorAt(def.to);
      if (def.to.kind === 'merge') {
        // Ramp overshoots the anchor by 30 m; the edge lands the vehicle at
        // that same spot on the mainline.
        points.push(
          b.anchor.clone().addScaledVector(b.tangent, -lead),
          b.anchor.clone().addScaledVector(b.tangent, 30),
        );
        toEdge = {
          to: {
            routeId: def.to.routeId,
            distance: this._normalizeDistance(b.route, b.param + 30 * def.to.direction),
            direction: def.to.direction,
          },
          kind: 'merge',
        };
      } else {
        // Arrival at a route endpoint: land at the anchor param, travelling on.
        points.push(b.anchor.clone().addScaledVector(b.tangent, -lead), b.anchor.clone());
        toEdge = { to: { routeId: def.to.routeId, distance: b.param, direction: def.to.direction }, kind: 'continuation' };
      }
    }

    const route = this._registerRoute({
      id: def.id, code: def.code || 'R', name: def.name, kind: def.kind === 'service' ? 'service' : 'ramp',
      oneWay: true, bidirectional: false, lanes: def.lanes || 1, laneWidth: 4.3,
      speedLimit: def.speedLimit || 50, points, traffic: def.kind !== 'service' && def.to !== null,
      destinations: def.destinations || [],
    });

    if (fromEdge) {
      this._addEdge({
        from: fromEdge.from,
        to: { routeId: route.id, distance: 0, direction: 1 },
        kind: fromEdge.kind === 'diverge' ? 'diverge' : 'continuation',
        name: def.name, probability: fromEdge.probability,
      });
    }
    if (toEdge) {
      this._addEdge({
        from: { routeId: route.id, distance: 'end', direction: 1 },
        to: toEdge.to,
        kind: toEdge.kind, name: def.name,
      });
    }
    if (def.to === null) route.deadEnd = true;
    return route;
  }

  /** Lot anchors used before service areas exist — Daikoku PA is authored here. */
  _pendingLotAnchor(lotId, edge) {
    if (!this._lotAnchors) {
      const center = vec(-18010, 0.3, -15080);
      const tangent = vec(0.94, 0, 0.34).normalize(); // lot long axis, roughly W->E
      const normal = horizontalNormal(tangent);
      this._lotAnchors = {
        daikoku_pa: {
          center, tangent, normal, width: 96, length: 190,
          in: { point: center.clone().addScaledVector(tangent, -95).addScaledVector(normal, -18), tangent: tangent.clone() },
          out: { point: center.clone().addScaledVector(tangent, 95).addScaledVector(normal, -18), tangent: tangent.clone() },
        },
      };
    }
    return this._lotAnchors[lotId][edge];
  }

  // ------------------------------------------------------------------
  // Service areas (PAs)
  // ------------------------------------------------------------------

  _defineServiceAreas() {
    const roadside = [
      {
        id: 'shibaura_pa', name: 'Shibaura PA', routeId: 'c1',
        at: vec(520, 0, -2320), direction: 1, width: 118, length: 250,
        hasGarage: true, density: 'medium',
      },
      {
        id: 'tatsumi_pa', name: 'Tatsumi PA', routeId: 'wangan',
        at: vec(9500, 0, -6480), direction: -1, width: 100, length: 215,
        density: 'light',
      },
      {
        id: 'heiwajima_pa', name: 'Heiwajima PA', routeId: 'k1',
        at: vec(-11000, 0, -11000), direction: 1, width: 104, length: 225,
        density: 'light',
      },
    ];

    for (const def of roadside) {
      const route = this.routes.get(def.routeId);
      const distance = this._projectToRoute(route, def.at).distance;
      const sample = this._sampleCenter(route.id, distance, def.direction);
      const outward = sample.normal.clone().multiplyScalar(-1); // driver's left
      const offset = route.halfWidth + def.width * 0.5 + 16;
      const center = sample.position.clone().addScaledVector(outward, offset);
      const elevation = sample.position.y + 0.15;
      center.y = elevation;
      const tangent = sample.tangent.clone();

      const legLength = def.length * 0.5 + 330;
      const inSample = this._sampleCenter(route.id, distance - def.direction * legLength, def.direction);
      const outSample = this._sampleCenter(route.id, distance + def.direction * legLength, def.direction);
      const laneEdge = route.medianWidth * 0.5 + route.lanes * route.laneWidth - 1.4;
      const accessPoints = [
        inSample.position.clone().addScaledVector(inSample.normal, -laneEdge),
        this._sampleCenter(route.id, distance - def.direction * (def.length * 0.5 + 170), def.direction).position.clone()
          .addScaledVector(outward, route.halfWidth + 7),
        center.clone().addScaledVector(tangent, -def.length * 0.42).addScaledVector(outward, -def.width * 0.18),
        center.clone().addScaledVector(outward, -def.width * 0.16),
        center.clone().addScaledVector(tangent, def.length * 0.42).addScaledVector(outward, -def.width * 0.18),
        this._sampleCenter(route.id, distance + def.direction * (def.length * 0.5 + 170), def.direction).position.clone()
          .addScaledVector(outward, route.halfWidth + 7),
        outSample.position.clone().addScaledVector(outSample.normal, -laneEdge),
      ];
      for (let i = 1; i < accessPoints.length - 1; i += 1) accessPoints[i].y = elevation;
      accessPoints[0].y = inSample.position.y;
      accessPoints[accessPoints.length - 1].y = outSample.position.y;

      const accessRoute = this._registerRoute({
        id: `${def.id}_access`, code: 'PA', name: `${def.name} lane`, kind: 'service',
        points: accessPoints, lanes: 1, laneWidth: 4.6, oneWay: true, bidirectional: false,
        speedLimit: 30, traffic: false, shoulder: 1.0,
        destinations: [[def.name.toUpperCase(), 'パーキング']],
      });
      this._addEdge({
        from: { routeId: def.routeId, distance: distance - def.direction * legLength, direction: def.direction },
        to: { routeId: accessRoute.id, distance: 0, direction: 1 },
        kind: 'diverge', name: `${def.name} entry`, probability: 0,
      });
      this._addEdge({
        from: { routeId: accessRoute.id, distance: 'end', direction: 1 },
        to: { routeId: def.routeId, distance: distance + def.direction * legLength, direction: def.direction },
        kind: 'merge', name: `${def.name} exit`,
      });

      this._pushServiceArea(def, route, distance, center, tangent, outward, elevation, accessRoute.id);
    }

    // Daikoku PA — ground-level meet under the stack, fed by the spiral.
    const lot = this._pendingLotAnchor('daikoku_pa', 'in');
    const anchors = this._lotAnchors.daikoku_pa;
    const daikokuDef = {
      id: 'daikoku_pa', name: 'Daikoku PA', routeId: 'daikoku_spiral',
      width: anchors.width, length: anchors.length, density: 'packed', direction: 1,
    };
    this._pushServiceArea(
      daikokuDef, this.routes.get('daikoku_spiral'), this.routes.get('daikoku_spiral').length,
      anchors.center.clone(), anchors.tangent.clone(), anchors.normal.clone().multiplyScalar(-1), anchors.center.y,
      'daikoku_spiral',
    );
    void lot;
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
      for (const zone of route.tunnelZones) {
        const a = this._projectToRoute(route, zone.nearA).distance;
        const b = this._projectToRoute(route, zone.nearB).distance;
        route.tunnels.push({
          name: zone.name, style: zone.style || 'white',
          startDistance: Math.min(a, b), endDistance: Math.max(a, b),
        });
      }
      if (route.bridgeZone) {
        const a = this._projectToRoute(route, route.bridgeZone.nearA).distance;
        const b = this._projectToRoute(route, route.bridgeZone.nearB).distance;
        route.bridge = { startDistance: Math.min(a, b), endDistance: Math.max(a, b) };
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
    return {
      route, routeId: route.id, u: bestU, distance: bestU * route.length,
      point, position: point, tangent, normal,
      signedLateral: delta.dot(normal),
      verticalDistance: delta.y,
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

  /** Deck bank angle (visual + height) from curvature; subtle, PSX-friendly. */
  _bankAt(route, distance) {
    if (route.kind === 'service') return 0;
    const lookAhead = 26;
    const before = this._sampleCenter(route, distance - lookAhead, 1).tangent;
    const after = this._sampleCenter(route, distance + lookAhead, 1).tangent;
    const crossY = before.z * after.x - before.x * after.z;
    const dot = clamp(before.x * after.x + before.z * after.z, -1, 1);
    const curvature = Math.atan2(crossY, dot) / (lookAhead * 2);
    return clamp(curvature * 620, -0.075, 0.075);
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
      const projection = this._projectToRoute(route, position, index);
      const half = this._halfWidthAt(route, projection.distance);
      if (Math.abs(projection.signedLateral) > half + lateralMargin + 14) continue;
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
      // Physics samples the analytic spline deck rather than rendered triangles;
      // this keeps seams between extruded mesh segments from kicking the car.
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
    if (this._isBridge(route, distance)) return 'RAINBOW BRIDGE';
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
      // Physics samples the analytic spline deck rather than rendered triangles;
      // this keeps seams between extruded mesh segments from kicking the car.
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
      if (edge.kind === 'merge') laneIndex = nextRoute.lanes - 1;
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
    const laneIndex = edge.kind === 'merge' ? nextRoute.lanes - 1 : clamp(laneRef.laneIndex ?? 0, 0, nextRoute.lanes - 1);
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
    if (!buckets.has(materialName)) buckets.set(materialName, { positions: [], indices: [] });
    return buckets.get(materialName);
  }

  _pushQuad(bucket, a, b, c, d) {
    const start = bucket.positions.length / 3;
    bucket.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
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
    this._unitGeometries = { box: unitBox, plane: unitPlane };
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
    this._buildBridge();
    this._buildSignage();
    this._buildServiceAreaDressing();
    this._buildCity();
    this._buildBackdrop();
    this._finalizeChunks();
  }

  _buildEnvironment() {
    // Water everywhere below sea level; land slabs raise the city floor.
    const water = new THREE.Mesh(new THREE.PlaneGeometry(58000, 46000, 1, 1), this.materials.water);
    water.name = 'Tokyo Bay';
    water.rotation.x = -Math.PI * 0.5;
    water.position.set(-3000, -0.9, -6000);
    this.group.add(water);

    const slab = (x, z, w, d, name) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 1.0, d), this.materials.ground);
      mesh.position.set(x, -0.62, z);
      mesh.name = name;
      this.group.add(mesh);
      return mesh;
    };
    slab(0, 1200, 26000, 12000, 'central Tokyo');          // C1 basin + north bank
    slab(6500, -4600, 22000, 5600, 'Koto / Tatsumi land'); // east port strip
    slab(-4200, -8200, 9000, 4800, 'Shinagawa waterfront');
    slab(-11500, -10600, 9000, 5200, 'Keihin industrial belt');
    slab(-17800, -14900, 5800, 4600, 'Daikoku island');
    slab(500, -6900, 4200, 2600, 'Daiba island');

    if (this.options.addLighting !== false) {
      const hemisphere = new THREE.HemisphereLight(0x314167, 0x05050a, 0.72);
      hemisphere.name = 'Night ambient light';
      const moon = new THREE.DirectionalLight(0x7884a4, 0.26);
      moon.name = 'Cool city fill light';
      moon.position.set(-2, 6, -3);
      this.group.add(hemisphere, moon);
    }
  }

  _prepareRenderFrames(route) {
    const step = route.kind === 'service' ? 14 : (route.kind === 'ramp' ? 16 : (route.kind === 'loop' ? 24 : 30));
    const segmentCount = Math.max(3, Math.ceil(route.length / step));
    const frameCount = route.closed ? segmentCount : segmentCount + 1;
    route.renderFrames.length = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const u = (route.closed ? i : Math.min(i, segmentCount)) / segmentCount;
      const distance = u * route.length;
      const position = route.curve.getPointAt(u);
      const tangent = route.curve.getTangentAt(u).normalize();
      route.renderFrames.push({
        u,
        distance,
        position,
        tangent,
        normal: horizontalNormal(tangent),
        half: this._halfWidthAt(route, distance),
        bank: this._bankAt(route, distance),
        tunnel: this._isTunnel(route, distance),
        bridge: this._isBridge(route, distance),
      });
    }
  }

  _forEachFrameSegment(route, callback) {
    const frames = route.renderFrames;
    const count = route.closed ? frames.length : frames.length - 1;
    for (let i = 0; i < count; i += 1) callback(frames[i], frames[(i + 1) % frames.length], i);
  }

  /** Deck edge point with banking applied. lateral along the base normal. */
  _deckPoint(frame, lateral, lift = 0) {
    const point = frame.position.clone().addScaledVector(frame.normal, lateral);
    point.y += Math.tan(frame.bank) * lateral + lift;
    return point;
  }

  _buildRouteGeometry(route) {
    const roadMaterialName = route.kind === 'service' ? 'roadService'
      : (this.routeOrder.indexOf(route.id) % 2 ? 'roadAlt' : 'road');
    const barrierHeight = route.kind === 'service' ? 0.9 : 1.15;
    const medianHeight = 1.0;

    this._forEachFrameSegment(route, (a, b) => {
      const mid = TMP_A.copy(a.position).lerp(b.position, 0.5);
      const bucketRoad = this._bucket(mid, roadMaterialName);
      const leftA = this._deckPoint(a, a.half);
      const leftB = this._deckPoint(b, b.half);
      const rightA = this._deckPoint(a, -a.half);
      const rightB = this._deckPoint(b, -b.half);
      // deck (facing up)
      this._pushQuad(bucketRoad, rightA, rightB, leftB, leftA);

      // fascia (deck sides) for elevated sections
      const elevated = a.position.y > 2.5 && !a.tunnel;
      const fasciaDepth = elevated ? 1.35 : 0.5;
      const bucketFascia = this._bucket(mid, 'concreteDark');
      const dropLA = leftA.clone(); dropLA.y -= fasciaDepth;
      const dropLB = leftB.clone(); dropLB.y -= fasciaDepth;
      const dropRA = rightA.clone(); dropRA.y -= fasciaDepth;
      const dropRB = rightB.clone(); dropRB.y -= fasciaDepth;
      this._pushQuad(bucketFascia, leftA, leftB, dropLB, dropLA);
      this._pushQuad(bucketFascia, dropRA, dropRB, rightB, rightA);
      if (elevated) this._pushQuad(bucketFascia, dropLA, dropLB, dropRB, dropRA); // underside

      // outer barriers — always, both sides, every metre of the network
      const bucketBarrier = this._bucket(mid, 'barrier');
      for (const side of [1, -1]) {
        const baseA = this._deckPoint(a, side * (a.half - 0.18), 0.03);
        const baseB = this._deckPoint(b, side * (b.half - 0.18), 0.03);
        const topA = baseA.clone(); topA.y += barrierHeight;
        const topB = baseB.clone(); topB.y += barrierHeight;
        if (side > 0) this._pushQuad(bucketBarrier, baseA, baseB, topB, topA);
        else this._pushQuad(bucketBarrier, baseB, baseA, topA, topB);
        // outward face so barriers read from outside/below too
        const outA = this._deckPoint(a, side * a.half, 0.03);
        const outB = this._deckPoint(b, side * b.half, 0.03);
        const outTopA = outA.clone(); outTopA.y += barrierHeight;
        const outTopB = outB.clone(); outTopB.y += barrierHeight;
        if (side > 0) this._pushQuad(bucketBarrier, outB, outA, outTopA, outTopB);
        else this._pushQuad(bucketBarrier, outA, outB, outTopB, outTopA);
        this._pushQuad(bucketBarrier, topA, topB, outTopB, outTopA);
        this.wallSegments.push({
          routeId: route.id, type: 'outer', side,
          start: baseA.clone(), end: baseB.clone(), height: barrierHeight,
          distanceStart: a.distance, distanceEnd: b.distance,
        });
      }

      // median barrier
      if (route.bidirectional) {
        const half = route.medianWidth * 0.5 - 0.35;
        const bucketMedian = this._bucket(mid, 'concrete');
        const lA = this._deckPoint(a, half, 0.03);
        const lB = this._deckPoint(b, half, 0.03);
        const rA = this._deckPoint(a, -half, 0.03);
        const rB = this._deckPoint(b, -half, 0.03);
        const lTopA = lA.clone(); lTopA.y += medianHeight;
        const lTopB = lB.clone(); lTopB.y += medianHeight;
        const rTopA = rA.clone(); rTopA.y += medianHeight;
        const rTopB = rB.clone(); rTopB.y += medianHeight;
        this._pushQuad(bucketMedian, lA, lB, lTopB, lTopA);
        this._pushQuad(bucketMedian, rB, rA, rTopA, rTopB);
        this._pushQuad(bucketMedian, lTopA, lTopB, rTopB, rTopA);
        this.wallSegments.push({
          routeId: route.id, type: 'median', side: 0,
          start: lA.clone(), end: lB.clone(), height: medianHeight,
          distanceStart: a.distance, distanceEnd: b.distance,
        });
      }

      // tunnel shell
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
      const endFrame = route.renderFrames[route.renderFrames.length - 1];
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

  // ------------------------------------------------------------------
  // Route dressing (instanced details)
  // ------------------------------------------------------------------

  _queueRouteDetails(route) {
    const isService = route.kind === 'service';
    const isRamp = route.kind === 'ramp';

    // Lane divider dashes + solid edge lines + median amber lines.
    const dashStep = isService ? 26 : 15;
    for (let distance = 6; distance < route.length; distance += dashStep) {
      const center = this._sampleCenter(route, distance, 1);
      const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
      const quaternion = yawQuaternion(center.baseTangent);
      const half = this._halfWidthAt(route, distance);
      const offsets = [];
      if (route.bidirectional) {
        for (let lane = 1; lane < route.lanes; lane += 1) {
          const boundary = route.medianWidth * 0.5 + lane * route.laneWidth;
          if (boundary < half - 0.8) offsets.push(boundary, -boundary);
        }
      } else {
        for (let lane = 1; lane < route.lanes; lane += 1) offsets.push((lane - route.lanes * 0.5) * route.laneWidth);
      }
      for (const offset of offsets) {
        const position = this._deckPoint(frame, offset, 0.055);
        this._instance(position, vec(0.14, 0.03, 6.2), quaternion, null, 'box:marking');
      }
    }
    const edgeStep = isService ? 30 : 21;
    for (let distance = 3; distance < route.length; distance += edgeStep) {
      const center = this._sampleCenter(route, distance, 1);
      const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
      const quaternion = yawQuaternion(center.baseTangent);
      const half = this._halfWidthAt(route, distance);
      for (const side of [1, -1]) {
        const position = this._deckPoint(frame, side * (half - 0.75), 0.055);
        this._instance(position, vec(0.16, 0.03, edgeStep - 1.2), quaternion, null, 'box:marking');
      }
      if (route.bidirectional) {
        for (const side of [1, -1]) {
          const position = this._deckPoint(frame, side * (route.medianWidth * 0.5 + 0.28), 0.055);
          this._instance(position, vec(0.13, 0.03, edgeStep - 1.2), quaternion, 0xe8a444, 'box:marking');
        }
      }
    }

    // Support pillars for elevated decks (every ~30 m per blueprint).
    if (!isService) {
      const pillarStep = 32;
      for (let distance = pillarStep * 0.5; distance < route.length; distance += pillarStep) {
        const center = this._sampleCenter(route, distance, 1);
        if (center.position.y < 3.5 || this._isTunnel(route, distance)) continue;
        if (this._isBridge(route, distance)) continue;
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

    // Sodium lamps on curved poles along every elevated/open section.
    const lampStep = isService ? 55 : (isRamp ? 70 : 42);
    let lampSide = 1;
    for (let distance = lampStep * 0.4; distance < route.length; distance += lampStep) {
      const center = this._sampleCenter(route, distance, 1);
      const quaternion = yawQuaternion(center.baseTangent);
      const half = this._halfWidthAt(route, distance);
      if (this._isTunnel(route, distance)) continue;
      const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
      const side = route.bidirectional ? (lampSide *= -1) : 1;
      const base = this._deckPoint(frame, side * (half - 0.45));
      const pole = base.clone(); pole.y += 4.6;
      this._instance(pole, vec(0.16, 9.2, 0.16), null, null, 'box:concrete');
      const arm = base.clone().addScaledVector(frame.normal, -side * 1.6); arm.y += 9.1;
      this._instance(arm, vec(side > 0 ? 3.4 : 3.4, 0.14, 0.14), quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(FORWARD, 0)), null, 'box:concrete');
      const head = base.clone().addScaledVector(frame.normal, -side * 3.0); head.y += 8.95;
      this._instance(head, vec(1.5, 0.2, 0.5), quaternion, null, 'box:lampSodium');
    }

    // Barrier reflectors.
    if (!isService) {
      for (let distance = 18; distance < route.length; distance += 38) {
        const center = this._sampleCenter(route, distance, 1);
        const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
        const quaternion = yawQuaternion(center.baseTangent);
        const half = this._halfWidthAt(route, distance);
        for (const side of [-1, 1]) {
          const position = this._deckPoint(frame, side * (half - 0.22), 0.78);
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
      for (let distance = tunnel.startDistance + 90; distance < tunnel.endDistance - 60; distance += 150) {
        const center = this._sampleCenter(route, distance, 1);
        const quaternion = yawQuaternion(center.baseTangent);
        // jet fans, paired
        for (const side of [-1.9, 1.9]) {
          const fan = center.position.clone().addScaledVector(horizontalNormal(center.baseTangent), side);
          fan.y += 5.1;
          this._instance(fan, vec(1.1, 1.1, 2.9), quaternion, 0x767d88, 'box:concrete');
        }
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
      // portals
      for (const endDistance of [tunnel.startDistance, tunnel.endDistance]) {
        const center = this._sampleCenter(route, endDistance, 1);
        const quaternion = yawQuaternion(center.baseTangent);
        const half = this._halfWidthAt(route, endDistance) + 0.6;
        const beam = center.position.clone();
        beam.y += 6.7;
        this._instance(beam, vec(half * 2 + 1.6, 1.6, 2.2), quaternion, null, 'box:portal');
        for (const side of [1, -1]) {
          const post = center.position.clone().addScaledVector(horizontalNormal(center.baseTangent), side * (half + 0.5));
          post.y += 3.0;
          this._instance(post, vec(1.4, 6.4, 2.2), quaternion, null, 'box:portal');
        }
      }
    }

    // Curve warning chevrons where curvature spikes.
    if (!isService && !isRamp) {
      for (let distance = 60; distance < route.length; distance += 45) {
        const bank = this._bankAt(route, distance);
        if (Math.abs(bank) < 0.052 || this._isTunnel(route, distance)) continue;
        const center = this._sampleCenter(route, distance, 1);
        const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank };
        const half = this._halfWidthAt(route, distance);
        // chevron board on the OUTSIDE of the bend
        const side = bank > 0 ? -1 : 1;
        const position = this._deckPoint(frame, side * (half - 0.35), 1.9);
        this._instance(position, vec(0.18, 1.05, 1.6), yawQuaternion(center.baseTangent), 0xffc21f, 'box:amber');
      }
    }
  }

  // ------------------------------------------------------------------
  // Signage
  // ------------------------------------------------------------------

  _signCanvas(lines, background, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#e8f0de';
    context.lineWidth = Math.max(3, Math.round(height * 0.045));
    context.strokeRect(4, 4, width - 8, height - 8);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const rows = lines.length;
    lines.forEach((line, index) => {
      const y = height * (index + 0.55) / (rows + 0.1);
      context.fillStyle = line.color || '#f0f3e5';
      context.font = `bold ${Math.round(line.size || height / (rows + 0.6))}px ${line.font || 'sans-serif'}`;
      context.fillText(line.text, width / 2, y);
    });
    return canvas;
  }

  _getSignMaterial(text, background = '#0c604e', wide = false) {
    const key = `${background}:${wide}:${text}`;
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
    const canvas = this._signCanvas(lines, background, wide ? 512 : 256, wide ? 128 : 96);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this._ownedTextures.add(texture);
    const material = new THREE.MeshBasicMaterial({
      map: texture, color: 0xffffff, fog: true, toneMapped: false, side: THREE.DoubleSide,
    });
    this._signMaterials.set(key, material);
    return material;
  }

  _makeSignMesh(text, background, width, height, wide = false) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this._getSignMaterial(text, background, wide));
    mesh.name = `sign ${text}`;
    return mesh;
  }

  _buildGantry(route, distance, label, secondary = '') {
    if (this._isTunnel(route, distance)) return;
    const center = this._sampleCenter(route, distance, 1);
    const quaternion = yawQuaternion(center.baseTangent);
    const half = this._halfWidthAt(route, distance) + 1.3;
    const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
    const beam = this._deckPoint(frame, 0, 6.4);
    this._instance(beam, vec(half * 2, 0.4, 0.4), quaternion, null, 'box:concrete');
    for (const side of [1, -1]) {
      const post = this._deckPoint(frame, side * half, 3.2);
      this._instance(post, vec(0.34, 6.4, 0.34), quaternion, null, 'box:concrete');
    }
    // one green panel per carriageway
    const sides = route.bidirectional ? [-1, 1] : [0];
    for (const side of sides) {
      const lateral = side === 0 ? 0 : side * (route.medianWidth * 0.5 + route.lanes * route.laneWidth * 0.5);
      const panel = this._makeSignMesh(label, '#0c604e', Math.min(10.5, half * 0.95), 2.9, true);
      const position = this._deckPoint(frame, lateral, 8.0);
      panel.position.copy(position);
      panel.quaternion.copy(quaternion);
      this._addChunkMesh(panel, position);
      if (secondary) {
        const board = this._makeSignMesh(secondary, '#174c72');
        const boardPos = this._deckPoint(frame, lateral, 5.35);
        board.position.copy(boardPos);
        board.quaternion.copy(quaternion);
        board.scale.set(0.62, 0.55, 1);
        this._addChunkMesh(board, boardPos);
      }
    }
  }

  _buildSignage() {
    for (const route of this.routes.values()) {
      if (route.kind === 'service') continue;
      const isRamp = route.kind === 'ramp';
      const interval = isRamp ? 900 : (route.id === 'c1' ? 950 : 1050);
      let signIndex = 0;
      for (let distance = Math.min(400, route.length * 0.3); distance < route.length - 120; distance += interval) {
        const destination = route.destinations[signIndex % Math.max(1, route.destinations.length)] || [route.name.toUpperCase(), ''];
        const [kanji, romaji] = Array.isArray(destination) ? destination : [destination, ''];
        this._buildGantry(route, distance, `${kanji}|${route.code}  ${romaji}`);
        signIndex += 1;
      }
      // km posts
      if (!isRamp) {
        for (let distance = 500; distance < route.length; distance += 1000) {
          const center = this._sampleCenter(route, distance, 1);
          if (this._isTunnel(route, distance)) continue;
          const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
          const half = this._halfWidthAt(route, distance);
          const post = this._makeSignMesh(`${route.code} ${(distance / 1000).toFixed(1)}|km`, '#174c72', 1.7, 1.25);
          const position = this._deckPoint(frame, half + 0.4, 2.1);
          post.position.copy(position);
          post.quaternion.copy(yawQuaternion(center.baseTangent));
          this._addChunkMesh(post, position);
        }
      }
      // orange matrix boards before junctions
      if (!isRamp && !route.closed) {
        for (const endDistance of [route.length * 0.32, route.length * 0.78]) {
          if (this._isTunnel(route, endDistance)) continue;
          const center = this._sampleCenter(route, endDistance, 1);
          const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, endDistance) };
          const board = this._makeSignMesh('渋滞注意|SLOW DOWN', '#241a05', 6.4, 1.7, true);
          const position = this._deckPoint(frame, 0, 6.2);
          board.position.copy(position);
          board.quaternion.copy(yawQuaternion(center.baseTangent));
          this._addChunkMesh(board, position);
          const boardBack = this._makeSignMesh('渋滞注意|SLOW DOWN', '#241a05', 6.4, 1.7, true);
          boardBack.position.copy(position);
          boardBack.quaternion.copy(yawQuaternion(center.baseTangent.clone().multiplyScalar(-1)));
          this._addChunkMesh(boardBack, position);
        }
      }
    }

    // Junction approach boards (blue, both directions) + PA advance signs.
    for (const junction of this.junctions) {
      const board = this._makeSignMesh(`${junction.name}|JUNCTION`, '#123c78', 6.8, 2.3, true);
      const position = junction.point.clone();
      position.y += 16;
      board.position.copy(position);
      this._addChunkMesh(board, position);
      this.animatedMarkers.push(Object.assign(board, { __spin: true }));
    }
    for (const area of this.serviceAreas) {
      if (!area.routeId || !this.routes.has(area.routeId)) continue;
      const route = this.routes.get(area.routeId);
      for (const ahead of [500, 300, 100]) {
        const distance = wrap(area.mainDistance - area.direction * (ahead + area.length * 0.5 + 330), route.length);
        if (this._isTunnel(route, distance)) continue;
        const center = this._sampleCenter(route, distance, area.direction);
        const frame = { position: center.position, tangent: center.baseTangent, normal: horizontalNormal(center.baseTangent), bank: this._bankAt(route, distance) };
        const half = this._halfWidthAt(route, distance);
        const lateral = -area.direction * (half + 0.6);
        const sign = this._makeSignMesh(`P ${area.name}|${ahead}m`, '#175ba5', 2.9, 1.9);
        const position = this._deckPoint(frame, lateral, 3.1);
        sign.position.copy(position);
        sign.quaternion.copy(yawQuaternion(center.tangent));
        this._addChunkMesh(sign, position);
      }
    }
  }

  // ------------------------------------------------------------------
  // Rainbow Bridge — landmark #1
  // ------------------------------------------------------------------

  _buildBridge() {
    const route = this.routes.get('r11');
    if (!route?.bridge) return;
    const { startDistance, endDistance } = route.bridge;
    const span = endDistance - startDistance;
    const towerDistances = [startDistance + span * 0.22, startDistance + span * 0.78];
    const towerTops = [];

    for (const distance of towerDistances) {
      const center = this._sampleCenter(route, distance, 1);
      const quaternion = yawQuaternion(center.baseTangent);
      const normal = horizontalNormal(center.baseTangent);
      const deckY = center.position.y;
      const towerHeight = 62;
      for (const side of [-1, 1]) {
        const legBase = center.position.clone().addScaledVector(normal, side * (route.halfWidth + 2.4));
        // leg from water to above deck
        const leg = legBase.clone();
        leg.y = (deckY + towerHeight) * 0.5 - 10;
        this._instance(leg, vec(3.2, deckY + towerHeight + 20, 3.6), quaternion, null, 'box:towerWhite');
      }
      // cross beams
      for (const beamY of [deckY + 14, deckY + towerHeight - 6]) {
        const beam = center.position.clone();
        beam.y = beamY;
        this._instance(beam, vec(route.halfWidth * 2 + 9, 3.0, 2.6), quaternion, null, 'box:towerWhite');
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
          const center = this._sampleCenter(route, distance, 1);
          const normal = horizontalNormal(center.baseTangent);
          const deckY = center.position.y;
          const yA = topFor(spanDef.a) ?? deckY + 6;
          const yB = topFor(spanDef.b) ?? deckY + 6;
          // parabola between the span end heights
          const sagDepth = spanDef.sag * 42;
          const cableY = yA + (yB - yA) * t - 4 * sagDepth * t * (1 - t);
          const point = center.position.clone().addScaledVector(normal, side * (route.halfWidth + 2.4));
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

      // sodium lot lights
      for (const along of [-area.length * 0.33, 0, area.length * 0.33]) {
        const position = area.center.clone().addScaledVector(area.tangent, along);
        position.y = area.elevation + 4.4;
        this._instance(position, vec(0.16, 8.8, 0.16), null, null, 'box:concrete');
        const head = position.clone();
        head.y = area.elevation + 8.9;
        this._instance(head, vec(2.2, 0.2, 0.7), orientation, null, 'box:lampSodium');
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

  _buildCity() {
    const random = mulberry32(this.seed ^ 0xa73b91);
    const palette = [0x111622, 0x151925, 0x1a1c28, 0x10141d, 0x20202a];
    const windowColors = [0x665a39, 0x33445f, 0x584a2e];

    // C1 canyon: mid/tall buildings tight against both sides of the loop.
    const c1 = this.routes.get('c1');
    for (let distance = 0; distance < c1.length; distance += 52) {
      const center = this._sampleCenter(c1, distance, 1);
      if (this._isTunnel(c1, distance)) continue;
      const normal = horizontalNormal(center.baseTangent);
      for (const side of [-1, 1]) {
        if (random() < 0.18) continue;
        const setback = 28 + random() * 55;
        const width = 22 + random() * 34;
        const depth = 22 + random() * 30;
        const height = 22 + Math.pow(random(), 1.6) * 105;
        const position = center.position.clone().addScaledVector(normal, side * (c1.halfWidth + setback + width * 0.5));
        if (this._distanceToRouteXZ(position) < c1.halfWidth + 10) continue;
        position.y = height * 0.5 - 0.1;
        const yaw = new THREE.Quaternion().setFromAxisAngle(UP, Math.floor(random() * 4) * Math.PI * 0.5 + (random() - 0.5) * 0.1);
        this._instance(position, vec(width, height, depth), yaw, palette[Math.floor(random() * palette.length)], 'box:building');
        // lit window bands
        const bands = 1 + Math.floor(random() * 3);
        for (let bandIndex = 0; bandIndex < bands; bandIndex += 1) {
          const band = position.clone();
          band.y = 6 + random() * Math.max(6, height - 12);
          this._instance(band, vec(width + 0.4, 0.8, depth + 0.4), yaw, windowColors[Math.floor(random() * windowColors.length)], 'box:buildingWindow');
        }
        // billboard facing the road on some buildings
        if (random() < 0.16 && height > 30) {
          const billboardTexts = [
            ['月光タイヤ', 'GEKKO TIRES'], ['NIGHTFUEL', '夜間燃料'], ['ハイパー缶コーヒー', 'KAN COFFEE'],
            ['首都高保険', 'EXPRESSWAY INS.'], ['ネオン電機', 'NEON DENKI'], ['湾岸ホテル', 'BAY HOTEL'],
          ];
          const [kanji, romaji] = billboardTexts[Math.floor(random() * billboardTexts.length)];
          const colors = ['#7a1f4d', '#173f78', '#7a4d15', '#1f6a54'];
          const board = this._makeSignMesh(`${kanji}|${romaji}`, colors[Math.floor(random() * colors.length)], 16, 6, true);
          const boardPos = center.position.clone().addScaledVector(normal, side * (c1.halfWidth + setback - 2));
          boardPos.y = height * 0.55 + 6;
          board.position.copy(boardPos);
          board.quaternion.copy(yawQuaternion(normal.clone().multiplyScalar(-side)));
          this._addChunkMesh(board, boardPos);
        }
        // red blinker on tall towers
        if (height > 95 && random() < 0.7) {
          const blinker = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), this.materials.redBlink.clone());
          blinker.position.copy(position);
          blinker.position.y = height + 1;
          this._addChunkMesh(blinker, blinker.position);
          this.blinkers.push(blinker);
        }
      }
    }

    // K1 industrial: low sheds, canals, smokestacks with red blinkers.
    const k1 = this.routes.get('k1');
    for (let distance = 0; distance < k1.length; distance += 64) {
      const center = this._sampleCenter(k1, distance, 1);
      const normal = horizontalNormal(center.baseTangent);
      for (const side of [-1, 1]) {
        if (random() < 0.3) continue;
        const setback = 26 + random() * 90;
        const width = 26 + random() * 48;
        const depth = 20 + random() * 34;
        const height = 7 + random() * 14;
        const position = center.position.clone().addScaledVector(normal, side * (k1.halfWidth + setback + width * 0.5));
        if (this._distanceToRouteXZ(position) < k1.halfWidth + 8) continue;
        position.y = height * 0.5 - 0.1;
        const yaw = new THREE.Quaternion().setFromAxisAngle(UP, Math.floor(random() * 4) * Math.PI * 0.5);
        this._instance(position, vec(width, height, depth), yaw, palette[Math.floor(random() * palette.length)], 'box:shed');
        if (random() < 0.12) {
          const stackHeight = 34 + random() * 30;
          const stack = position.clone();
          stack.y = stackHeight * 0.5;
          this._instance(stack, vec(3.2, stackHeight, 3.2), null, null, 'box:concreteDark');
          const blinker = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), this.materials.redBlink.clone());
          blinker.position.copy(position);
          blinker.position.y = stackHeight + 0.8;
          this._addChunkMesh(blinker, blinker.position);
          this.blinkers.push(blinker);
        }
      }
    }

    // Wangan port: cranes, container stacks, warehouses on the LAND side
    // (north/west of travel direction +1 => positive base-normal side).
    const wangan = this.routes.get('wangan');
    for (let distance = 300; distance < wangan.length; distance += 110) {
      if (this._isTunnel(wangan, distance)) continue;
      const center = this._sampleCenter(wangan, distance, 1);
      const normal = horizontalNormal(center.baseTangent);
      const landSide = 1; // +normal = inland (the bay is on the -normal side)
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
      if (random() < 0.3) {
        const setback = 90 + random() * 220;
        const width = 40 + random() * 70;
        const height = 10 + random() * 12;
        const position = center.position.clone().addScaledVector(normal, landSide * (wangan.halfWidth + setback + width * 0.5));
        if (this._distanceToRouteXZ(position) > wangan.halfWidth + 14) {
          position.y = height * 0.5;
          this._instance(position, vec(width, height, 24 + random() * 26), yawQuaternion(center.baseTangent), palette[Math.floor(random() * palette.length)], 'box:shed');
        }
      }
    }
  }

  _buildBackdrop() {
    // Distant skyline silhouettes with lit windows, close enough to read
    // through the PSX fog. Placed on the far side of the bay from the
    // Rainbow Bridge and behind Daikoku.
    const random = mulberry32(this.seed ^ 0x517cc1);
    const clusters = [
      { x: -1400, z: -4600, spread: 1500, count: 26, tall: 130 }, // skyline behind the bridge (west bank)
      { x: 2400, z: -4400, spread: 1200, count: 18, tall: 90 },  // east bank
      { x: -15200, z: -14900, spread: 1400, count: 16, tall: 70 }, // Daikoku shore
      { x: 8600, z: -4300, spread: 1500, count: 16, tall: 80 },  // Tatsumi postcard
    ];
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.count; i += 1) {
        const position = vec(
          cluster.x + (random() - 0.5) * cluster.spread,
          0,
          cluster.z + (random() - 0.5) * cluster.spread * 0.6,
        );
        if (this._distanceToRouteXZ(position) < 60) continue;
        const width = 30 + random() * 45;
        const height = 24 + Math.pow(random(), 1.4) * cluster.tall;
        position.y = height * 0.5;
        this._instance(position, vec(width, height, width * (0.7 + random() * 0.5)), null, 0x0e1119, 'box:building');
        for (let band = 0; band < 2; band += 1) {
          const bandPos = position.clone();
          bandPos.y = 5 + random() * Math.max(5, height - 10);
          this._instance(bandPos, vec(width + 0.4, 0.7, width * 0.8), null, random() < 0.6 ? 0x665a39 : 0x33445f, 'box:buildingWindow');
        }
      }
    }

    // Broadcast tower near the C1 west arc.
    const towerPos = vec(-1450, 0, -2950);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(4, 22, 240, 6), this.materials.towerWhite);
    tower.position.copy(towerPos);
    tower.position.y = 120;
    tower.name = 'Broadcast tower';
    this._addChunkMesh(tower, towerPos);
    const towerBlinker = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), this.materials.redBlink.clone());
    towerBlinker.position.set(towerPos.x, 243, towerPos.z);
    this._addChunkMesh(towerBlinker, towerBlinker.position);
    this.blinkers.push(towerBlinker);

    // Ferris wheel near the Daikoku end of the bay.
    const wheelCenter = vec(-16350, 66, -15600);
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
      r11: '#ffe667',
      r9: '#79e690',
      dj: '#f07777',
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
        color: colors[route.id] || colors[route.kind] || '#d6d6d6',
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
