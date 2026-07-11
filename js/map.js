import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();
const TMP_MAT = new THREE.Matrix4();
const TMP_QUAT = new THREE.Quaternion();
const EPSILON = 1e-5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrap(value, length) {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

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

function vec(x, y, z) {
  return new THREE.Vector3(x, y, z);
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

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Procedural, low-poly recreation of a large Shutoko-style expressway network.
 *
 * Coordinate system: metres, +Y up. Curves are authored in their nominal
 * outbound direction. Japan-style traffic occupies the left-hand carriageway:
 * direction +1 is on the positive curve-normal side and direction -1 is on the
 * negative side.
 */
export class HighwayMap {
  constructor(sceneOrOptions = null, maybeOptions = {}) {
    const isScene = sceneOrOptions && sceneOrOptions.isScene;
    this.scene = isScene ? sceneOrOptions : (sceneOrOptions?.scene || null);
    this.options = isScene ? maybeOptions : (sceneOrOptions || {});
    this.seed = Number.isFinite(this.options.seed) ? this.options.seed : 0x51a7c1;
    this.random = mulberry32(this.seed);

    this.group = new THREE.Group();
    this.group.name = 'Shutoko procedural world';
    this.routes = new Map();
    this.routeOrder = [];
    this.routeAliases = new Map();
    this.connections = new Map();
    this.junctions = [];
    this.serviceAreas = [];
    this.wallSegments = [];
    this.routeSamples = Object.create(null);
    this.animatedMarkers = [];
    this._signMaterials = new Map();
    this._ownedTextures = new Set();
    this._disposed = false;

    this._markingInstances = [];
    this._reflectorInstances = [];
    this._pillarInstances = [];
    this._poleInstances = [];
    this._lampInstances = [];
    this._tunnelLampInstances = [];

    this.materials = this._createMaterials();
    this._createNetwork();
    this._createServiceAreaRoutes();
    this._buildEnvironment();
    this._buildRoadNetwork();
    this._buildJunctionPlatforms();
    this._buildServiceAreas();
    this._buildInstancedDetails();
    this._buildCity();
    this._buildSignage();
    this._buildMinimapData();

    this.routeAliases.set('c1_outer', { id: 'c1', direction: 1 });
    this.routeAliases.set('c1_inner', { id: 'c1', direction: -1 });
    this.routeAliases.set('c1o', { id: 'c1', direction: 1 });
    this.routeAliases.set('c1i', { id: 'c1', direction: -1 });
    this.routeAliases.set('k1', { id: 'yokohane', direction: 1 });
    this.routeAliases.set('bayshore', { id: 'wangan', direction: 1 });
    this.trafficLanes = this.getTrafficLanes();

    const garageArea = this.serviceAreas.find((area) => area.hasGarage);
    const spawnDistance = wrap(garageArea.mainDistance + 430, this.routes.get(garageArea.routeId).length);
    this.initialSpawn = this.sampleLane(garageArea.routeId, spawnDistance, 0, 1);
    this.initialSpawn.position.y += 0.65;
    this.initialSpawn.serviceAreaId = garageArea.id;
    this.initialSpawn.label = 'Shiba PA outbound merge';
    this.garagePosition = garageArea.garageEntrance.clone();

    if (this.scene) {
      this.scene.add(this.group);
      if (this.options.applyFog !== false) {
        this.scene.background = new THREE.Color(0x03050e);
        this.scene.fog = new THREE.FogExp2(0x050713, this.options.fogDensity || 0.000095);
      }
    }
  }

  _createMaterials() {
    const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({
      color,
      flatShading: true,
      fog: true,
      ...extra,
    });
    const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({
      color,
      fog: true,
      toneMapped: false,
      ...extra,
    });

    return {
      road: lambert(0x151923),
      roadAlternate: lambert(0x191d27),
      concrete: lambert(0x51535a),
      concreteDark: lambert(0x292c34),
      tunnel: lambert(0x20232a, { side: THREE.DoubleSide }),
      tunnelRib: lambert(0x3f4248),
      marking: basic(0xd5d3b9),
      amberMarking: basic(0xeaa942),
      reflector: basic(0xffc36a),
      lamp: basic(0xff9b42),
      tunnelLamp: basic(0xffd69a),
      signGreen: basic(0x0c604e, { side: THREE.DoubleSide }),
      ground: lambert(0x070910),
      water: lambert(0x07101c, { transparent: true, opacity: 0.88 }),
      building: lambert(0x111522),
      garage: lambert(0x222632),
      shutter: lambert(0x6e7379),
      vending: basic(0x8ad9ff),
      serviceRoad: lambert(0x20242d),
      marker: basic(0x57e3ff, { transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
    };
  }

  _createNetwork() {
    this._registerRoute({
      id: 'c1',
      code: 'C1',
      name: 'C1 Inner Circular Route',
      kind: 'loop',
      closed: true,
      lanes: 2,
      speedLimit: 80,
      points: [
        vec(1700, 46, -800), vec(1450, 40, -1650), vec(500, 34, -2300),
        vec(-650, 36, -2200), vec(-1450, 48, -1500), vec(-1850, 52, -450),
        vec(-1600, 43, 700), vec(-900, 36, 1750), vec(250, 32, 2250),
        vec(1200, 38, 1750), vec(1750, 50, 800), vec(1850, 46, 0),
      ],
      tunnels: [
        { start: 0.075, end: 0.17, name: 'Ginza tunnel' },
        { start: 0.345, end: 0.43, name: 'Kasumigaseki tunnel' },
        { start: 0.675, end: 0.755, name: 'Shiodome tunnel' },
      ],
      destinations: ['C1 LOOP', 'GINZA', 'SHIBA'],
    });

    this._registerRoute({
      id: 'wangan',
      code: 'B',
      name: 'Wangan / Bayshore Route',
      kind: 'arterial',
      lanes: 3,
      speedLimit: 100,
      points: [
        vec(1750, 50, 800), vec(2600, 54, 600), vec(4200, 60, 500),
        vec(6200, 55, 700), vec(8300, 45, 1100), vec(10300, 38, 1500),
        vec(12000, 34, 2300), vec(13200, 30, 3500), vec(13000, 28, 5000),
        vec(11600, 34, 5900), vec(9800, 42, 6250), vec(8000, 48, 6600),
        vec(6000, 40, 7600),
      ],
      tunnels: [{ start: 0.44, end: 0.535, name: 'Tokyo Bay tunnel' }],
      destinations: ['WANGAN', 'AIRPORT', 'YOKOHAMA'],
    });

    this._registerRoute({
      id: 'yokohane',
      code: 'K1',
      name: 'Yokohane Route K1',
      kind: 'arterial',
      lanes: 2,
      speedLimit: 90,
      points: [
        vec(-900, 36, 1750), vec(-1750, 46, 2600), vec(-2300, 52, 3900),
        vec(-1900, 46, 5200), vec(-900, 38, 6300), vec(600, 34, 7000),
        vec(2200, 36, 7350), vec(3900, 38, 7200), vec(5100, 42, 7400),
        vec(6000, 40, 7600),
      ],
      tunnels: [{ start: 0.11, end: 0.245, name: 'Yokohane cut tunnel' }],
      destinations: ['K1 YOKOHANE', 'HANEDA', 'DAIKOKU'],
    });

    this._registerRoute({
      id: 'shinjuku',
      code: '4',
      name: 'Shinjuku Route',
      kind: 'branch',
      lanes: 2,
      speedLimit: 80,
      points: [
        vec(-1850, 52, -450), vec(-2900, 60, -900), vec(-4300, 54, -500),
        vec(-5200, 42, 700), vec(-5100, 35, 2100), vec(-4100, 44, 3000),
        vec(-2800, 56, 2750), vec(-2000, 48, 1700), vec(-1600, 43, 700),
      ],
      tunnels: [{ start: 0.26, end: 0.43, name: 'Shinjuku tunnel' }],
      destinations: ['SHINJUKU', 'C1', 'TAKAIDO'],
    });

    this._registerRoute({
      id: 'rainbow',
      code: '11',
      name: 'Daiba / Rainbow Route 11',
      kind: 'connector',
      lanes: 2,
      speedLimit: 80,
      points: [
        vec(1200, 38, 1750), vec(1750, 58, 2350), vec(2750, 83, 2500),
        vec(3700, 74, 1650), vec(4200, 60, 500),
      ],
      destinations: ['DAIBA', 'WANGAN', 'C1'],
    });

    this._registerRoute({
      id: 'bay_link',
      code: 'K5',
      name: 'Daikoku Bay Link K5',
      kind: 'connector',
      lanes: 2,
      speedLimit: 90,
      points: [
        vec(3900, 38, 7200), vec(5000, 55, 8100), vec(6700, 70, 8400),
        vec(8500, 65, 8000), vec(10100, 50, 7000), vec(11600, 34, 5900),
      ],
      tunnels: [{ start: 0.37, end: 0.47, name: 'Bay link tunnel' }],
      destinations: ['K5 DAIKOKU', 'WANGAN', 'YOKOHAMA'],
    });

    const c1Wangan = this._nearestOnRoute(this.routes.get('c1'), vec(1750, 50, 800)).distance;
    const c1Yokohane = this._nearestOnRoute(this.routes.get('c1'), vec(-900, 36, 1750)).distance;
    const c1ShinjukuA = this._nearestOnRoute(this.routes.get('c1'), vec(-1850, 52, -450)).distance;
    const c1ShinjukuB = this._nearestOnRoute(this.routes.get('c1'), vec(-1600, 43, 700)).distance;
    const c1Rainbow = this._nearestOnRoute(this.routes.get('c1'), vec(1200, 38, 1750)).distance;
    const wanganRainbow = this._nearestOnRoute(this.routes.get('wangan'), vec(4200, 60, 500)).distance;
    const yokoBay = this._nearestOnRoute(this.routes.get('yokohane'), vec(3900, 38, 7200)).distance;
    const wanganBay = this._nearestOnRoute(this.routes.get('wangan'), vec(11600, 34, 5900)).distance;

    this._connectRoutes('c1', c1Wangan, 'wangan', 0, 'Edobashi JCT', 56);
    this._connectRoutes('c1', c1Yokohane, 'yokohane', 0, 'Hamazakibashi JCT', 54);
    this._connectRoutes('wangan', this.routes.get('wangan').length, 'yokohane', this.routes.get('yokohane').length, 'Daikoku JCT', 64);
    this._connectRoutes('c1', c1ShinjukuA, 'shinjuku', 0, 'Nishi-Shinjuku JCT', 52);
    this._connectRoutes('c1', c1ShinjukuB, 'shinjuku', this.routes.get('shinjuku').length, 'Takebashi JCT', 48);
    this._connectRoutes('c1', c1Rainbow, 'rainbow', 0, 'Shibaura JCT', 56);
    this._connectRoutes('wangan', wanganRainbow, 'rainbow', this.routes.get('rainbow').length, 'Ariake JCT', 58);
    this._connectRoutes('yokohane', yokoBay, 'bay_link', 0, 'Namamugi JCT', 58);
    this._connectRoutes('wangan', wanganBay, 'bay_link', this.routes.get('bay_link').length, 'Honmoku JCT', 60);
  }

  _registerRoute(config) {
    const points = config.points.map((point) => point.clone());
    const curve = new THREE.CatmullRomCurve3(points, !!config.closed, 'catmullrom', config.tension ?? 0.14);
    curve.arcLengthDivisions = Math.max(240, Math.ceil(this._polylineLength(points, !!config.closed) / 18));
    curve.updateArcLengths();
    const length = curve.getLength();
    const bidirectional = config.bidirectional !== false && !config.oneWay;
    const lanes = Math.max(1, config.lanes || 2);
    const laneWidth = config.laneWidth || 3.55;
    const medianWidth = bidirectional ? (config.medianWidth ?? 1.65) : 0;
    const shoulder = config.shoulder ?? (config.kind === 'service' ? 0.75 : 1.15);
    const halfWidth = bidirectional
      ? medianWidth * 0.5 + lanes * laneWidth + shoulder
      : lanes * laneWidth * 0.5 + shoulder;

    const route = {
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
      tunnels: (config.tunnels || []).map((zone) => ({
        ...zone,
        startDistance: zone.start <= 1 ? zone.start * length : zone.start,
        endDistance: zone.end <= 1 ? zone.end * length : zone.end,
      })),
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
    const count = Math.max(12, Math.ceil(route.length / 80));
    route.samples.length = 0;
    for (let i = 0; i <= count; i += 1) {
      if (route.closed && i === count) continue;
      const u = i / count;
      const point = route.curve.getPointAt(u);
      const tangent = route.curve.getTangentAt(u).normalize();
      const normal = horizontalNormal(tangent);
      route.samples.push({ u, distance: u * route.length, point, position: point, tangent, normal });
    }
    route._spatialSamples = route.samples;
    this.routeSamples[route.id] = route.samples;
  }

  _nearestOnRoute(route, position) {
    let bestU = 0;
    let bestDistanceSq = Infinity;
    for (const sample of route._spatialSamples) {
      const distanceSq = sample.point.distanceToSquared(position);
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestU = sample.u;
      }
    }

    let step = 1 / Math.max(8, route._spatialSamples.length);
    for (let pass = 0; pass < 9; pass += 1) {
      let passU = bestU;
      for (const candidate of [bestU - step, bestU + step]) {
        const u = route.closed ? wrap(candidate, 1) : clamp(candidate, 0, 1);
        const point = route.curve.getPointAt(u);
        const distanceSq = point.distanceToSquared(position);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          passU = u;
        }
      }
      bestU = passU;
      step *= 0.5;
    }

    const point = route.curve.getPointAt(bestU);
    const tangent = route.curve.getTangentAt(bestU).normalize();
    const normal = horizontalNormal(tangent);
    const delta = TMP_A.copy(position).sub(point);
    return {
      route,
      routeId: route.id,
      u: bestU,
      distance: bestU * route.length,
      point,
      position: point,
      tangent,
      normal,
      signedLateral: delta.dot(normal),
      verticalDistance: delta.y,
      worldDistance: Math.sqrt(bestDistanceSq),
      distanceSq: bestDistanceSq,
    };
  }

  _connectRoutes(routeA, distanceA, routeB, distanceB, name, radius = 50) {
    const sampleA = this._sampleCenter(routeA, distanceA, 1);
    const sampleB = this._sampleCenter(routeB, distanceB, 1);
    const point = sampleA.position.clone().lerp(sampleB.position, 0.5);
    const connectionA = { routeId: routeB, fromDistance: distanceA, toDistance: distanceB, name, point };
    const connectionB = { routeId: routeA, fromDistance: distanceB, toDistance: distanceA, name, point };
    this.connections.get(routeA).push(connectionA);
    this.connections.get(routeB).push(connectionB);

    const existing = this.junctions.find((junction) => junction.point.distanceToSquared(point) < 25);
    if (existing) {
      if (!existing.routes.includes(routeA)) existing.routes.push(routeA);
      if (!existing.routes.includes(routeB)) existing.routes.push(routeB);
      existing.radius = Math.max(existing.radius, radius);
    } else {
      this.junctions.push({
        id: `jct_${this.junctions.length + 1}`,
        name,
        point,
        position: point,
        routes: [routeA, routeB],
        radius,
      });
    }
  }

  _createServiceAreaRoutes() {
    const definitions = [
      { id: 'shiba_pa', name: 'Shiba PA', routeId: 'c1', fraction: 0.025, side: 1, hasGarage: true, width: 112, length: 250 },
      { id: 'tatsumi_pa', name: 'Tatsumi PA', routeId: 'wangan', fraction: 0.185, side: -1, width: 120, length: 270 },
      { id: 'heiwajima_pa', name: 'Heiwajima PA', routeId: 'yokohane', fraction: 0.39, side: -1, width: 108, length: 240 },
      { id: 'daikoku_pa', name: 'Daikoku PA', routeId: 'wangan', fraction: 0.89, side: 1, width: 150, length: 330 },
    ];

    for (const definition of definitions) {
      const mainRoute = this.routes.get(definition.routeId);
      const distance = mainRoute.length * definition.fraction;
      const centerSample = this._sampleCenter(mainRoute.id, distance, 1);
      const tangent = centerSample.tangent.clone();
      const baseNormal = horizontalNormal(tangent);
      const normal = baseNormal.multiplyScalar(definition.side);
      const elevation = centerSample.position.y + 0.18;
      const offset = mainRoute.halfWidth + definition.width * 0.5 + 25;
      const center = centerSample.position.clone().addScaledVector(normal, offset);
      center.y = elevation;

      const before = mainRoute.closed ? wrap(distance - 310, mainRoute.length) : clamp(distance - 310, 0, mainRoute.length);
      const after = mainRoute.closed ? wrap(distance + 310, mainRoute.length) : clamp(distance + 310, 0, mainRoute.length);
      const start = this._sampleCenter(mainRoute.id, before, 1);
      const end = this._sampleCenter(mainRoute.id, after, 1);
      const startNormal = horizontalNormal(start.tangent).multiplyScalar(definition.side);
      const endNormal = horizontalNormal(end.tangent).multiplyScalar(definition.side);

      const accessPoints = [
        start.position.clone().addScaledVector(startNormal, mainRoute.halfWidth - 2),
        this._sampleCenter(mainRoute.id, mainRoute.closed ? wrap(distance - 180, mainRoute.length) : Math.max(0, distance - 180), 1).position.clone().addScaledVector(normal, mainRoute.halfWidth + 10),
        center.clone().addScaledVector(tangent, -definition.length * 0.42),
        center.clone(),
        center.clone().addScaledVector(tangent, definition.length * 0.42),
        this._sampleCenter(mainRoute.id, mainRoute.closed ? wrap(distance + 180, mainRoute.length) : Math.min(mainRoute.length, distance + 180), 1).position.clone().addScaledVector(normal, mainRoute.halfWidth + 10),
        end.position.clone().addScaledVector(endNormal, mainRoute.halfWidth - 2),
      ];
      for (const point of accessPoints) point.y = elevation;

      const accessRoute = this._registerRoute({
        id: `${definition.id}_access`,
        code: 'PA',
        name: `${definition.name} access lane`,
        kind: 'service',
        points: accessPoints,
        lanes: 1,
        laneWidth: 4.1,
        oneWay: true,
        bidirectional: false,
        speedLimit: 30,
        traffic: false,
        shoulder: 1.0,
        destinations: [definition.name.toUpperCase()],
      });

      const area = {
        ...definition,
        mainDistance: distance,
        center,
        position: center,
        tangent,
        normal,
        elevation,
        accessRouteId: accessRoute.id,
        entryPosition: accessPoints[0].clone(),
        exitPosition: accessPoints[accessPoints.length - 1].clone(),
        refuelPosition: center.clone().addScaledVector(normal, -definition.width * 0.28).addScaledVector(tangent, definition.length * 0.18),
        bankRadius: Math.min(definition.width, definition.length) * 0.44,
      };
      area.garageEntrance = definition.hasGarage
        ? center.clone().addScaledVector(normal, definition.width * 0.48).addScaledVector(tangent, -12)
        : null;
      this.serviceAreas.push(area);

      this._connectRoutes(mainRoute.id, before, accessRoute.id, 0, `${definition.name} entry`, 31);
      this._connectRoutes(mainRoute.id, after, accessRoute.id, accessRoute.length, `${definition.name} exit`, 31);
    }
  }

  _resolveRoute(routeId) {
    const key = typeof routeId === 'string' ? routeId.toLowerCase() : routeId?.id;
    const alias = this.routeAliases.get(key);
    const canonical = alias ? alias.id : key;
    const route = this.routes.get(canonical);
    if (!route) throw new Error(`Unknown highway route: ${routeId}`);
    return { route, alias, requestedId: key };
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

  /** Sample the centre of a traffic lane. Lane 0 is nearest the median. */
  sampleLane(routeId, distance, lane = 0, direction = null) {
    const { route, alias, requestedId } = this._resolveRoute(routeId);
    const resolvedDirection = route.oneWay
      ? route.oneWayDirection
      : ((direction ?? alias?.direction ?? 1) >= 0 ? 1 : -1);
    const laneIndex = clamp(Math.floor(Number.isFinite(lane) ? lane : 0), 0, route.lanes - 1);
    const center = this._sampleCenter(route, distance, resolvedDirection);
    const laneOffset = route.bidirectional
      ? route.medianWidth * 0.5 + route.laneWidth * (laneIndex + 0.5)
      : (laneIndex - (route.lanes - 1) * 0.5) * route.laneWidth;
    const position = center.position.clone().addScaledVector(center.normal, laneOffset);
    const lookAhead = Math.min(14, Math.max(4, route.length * 0.002));
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
      right: center.normal.clone().multiplyScalar(-1),
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
          routeId: route.id,
          distance,
          position: sample.position,
          point: sample.position,
          tangent: sample.tangent,
          normal: sample.normal,
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

  getNearestRoute(position, maxDistanceOrOptions = Infinity) {
    const options = typeof maxDistanceOrOptions === 'object'
      ? maxDistanceOrOptions
      : { maxDistance: maxDistanceOrOptions };
    const maxDistance = options.maxDistance ?? Infinity;
    const includeService = options.includeService !== false;
    const routeIds = options.routeIds ? new Set(options.routeIds.map((id) => this._resolveRoute(id).route.id)) : null;
    let best = null;

    for (const route of this.routes.values()) {
      if (!includeService && route.kind === 'service') continue;
      if (routeIds && !routeIds.has(route.id)) continue;
      let coarseBestSq = best?.distanceSq ?? Infinity;
      let plausible = false;
      for (const sample of route._spatialSamples) {
        const distanceSq = sample.point.distanceToSquared(position);
        if (distanceSq < coarseBestSq + 10000) {
          plausible = true;
          coarseBestSq = Math.min(coarseBestSq, distanceSq);
        }
      }
      if (!plausible) continue;
      const candidate = this._nearestOnRoute(route, position);
      if (!best || candidate.distanceSq < best.distanceSq) best = candidate;
    }

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

  getRoadInfo(position) {
    const lot = this._serviceAreaAt(position, 0);
    if (lot) {
      const { area, longitudinal, lateral } = lot;
      const parkingRight = horizontalNormal(area.tangent).multiplyScalar(-1);
      const parkingLateralOffset = TMP_B.copy(position).sub(area.center).dot(parkingRight);
      const point = area.center.clone()
        .addScaledVector(area.tangent, longitudinal)
        .addScaledVector(area.normal, lateral);
      return {
        routeId: area.accessRouteId,
        routeName: `${area.name} parking area`,
        code: 'PA',
        distance: longitudinal + area.length * 0.5,
        normalizedDistance: (longitudinal + area.length * 0.5) / area.length,
        point,
        center: point,
        position: point,
        tangent: area.tangent.clone(),
        normal: area.normal.clone(),
        up: UP.clone(),
        right: parkingRight,
        surfaceNormal: UP.clone(),
        height: area.elevation,
        roadHeight: area.elevation,
        surfaceGrip: 0.94,
        grade: 0,
        signedLateral: lateral,
        lateralOffset: parkingLateralOffset,
        verticalDistance: position.y - area.elevation,
        worldDistance: Math.abs(position.y - area.elevation),
        lane: -1,
        direction: 1,
        roadHalfWidth: area.width * 0.5,
        halfWidth: area.width * 0.5,
        roadWidth: area.width,
        edgeDistance: Math.min(area.width * 0.5 - Math.abs(lateral), area.length * 0.5 - Math.abs(longitudinal)),
        medianDistance: Infinity,
        onRoadSurface: true,
        onRoad: true,
        drivable: true,
        tunnel: false,
        speedLimit: 20,
        serviceArea: area,
        serviceAreaId: area.id,
        inServiceArea: true,
        junction: null,
      };
    }

    const nearest = this.getNearestRoute(position);
    if (!nearest) return null;
    const { route } = nearest;
    const absLateral = Math.abs(nearest.signedLateral);
    const onSurface = absLateral <= route.halfWidth + 0.25 && Math.abs(nearest.verticalDistance) < 8;
    let direction = route.oneWay ? route.oneWayDirection : (nearest.signedLateral >= 0 ? 1 : -1);
    let lane = 0;
    let drivable = onSurface;
    let medianDistance = Infinity;
    if (route.bidirectional) {
      medianDistance = absLateral - route.medianWidth * 0.5;
      drivable = drivable && medianDistance >= 0;
      lane = clamp(Math.floor(Math.max(0, medianDistance) / route.laneWidth), 0, route.lanes - 1);
    } else {
      lane = clamp(Math.round(nearest.signedLateral / route.laneWidth + (route.lanes - 1) * 0.5), 0, route.lanes - 1);
      direction = route.oneWayDirection;
    }
    const proximity = this.getServiceAreaProximity(position, 220);
    const laneCenterSample = this.sampleLane(route.id, nearest.distance, lane, direction);

    return {
      ...nearest,
      center: laneCenterSample.position,
      routeCenter: nearest.point,
      height: nearest.point.y,
      roadHeight: nearest.point.y,
      y: nearest.point.y,
      surfaceGrip: onSurface ? 1 : 0.58,
      grade: laneCenterSample.tangent.y,
      up: UP.clone(),
      surfaceNormal: UP.clone(),
      right: nearest.normal.clone().multiplyScalar(-1),
      lateralOffset: -nearest.signedLateral,
      heading: laneCenterSample.heading,
      normalizedDistance: route.length ? nearest.distance / route.length : 0,
      lane,
      direction,
      roadHalfWidth: route.halfWidth,
      halfWidth: route.halfWidth,
      edgeDistance: route.halfWidth - absLateral,
      medianDistance,
      onRoadSurface: onSurface,
      onRoad: drivable,
      drivable,
      inServiceArea: false,
      serviceArea: proximity?.inside ? proximity.area : null,
      serviceAreaId: proximity?.inside ? proximity.id : null,
    };
  }

  isPointDrivable(position, margin = 0) {
    const area = this._serviceAreaAt(position, margin);
    if (area) return true;
    const info = this.getRoadInfo(position);
    if (!info) return false;
    if (info.junction && xzDistanceSq(position, info.junction.point) <= (info.junction.radius + margin) ** 2) return true;
    if (!info.route) return info.drivable;
    const route = info.route;
    if (route.bidirectional && Math.abs(info.signedLateral) < route.medianWidth * 0.5 - margin) return false;
    return Math.abs(info.signedLateral) <= route.halfWidth + margin && Math.abs(info.verticalDistance) < 9;
  }

  _isTunnel(route, distance) {
    const normalized = this._normalizeDistance(route, distance);
    for (const tunnel of route.tunnels) {
      if (tunnel.startDistance <= tunnel.endDistance) {
        if (normalized >= tunnel.startDistance && normalized <= tunnel.endDistance) return tunnel;
      } else if (normalized >= tunnel.startDistance || normalized <= tunnel.endDistance) {
        return tunnel;
      }
    }
    return null;
  }

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

  advanceAlongRoute(stateOrRouteId, deltaDistance, lane = 0, direction = 1, branchIndex = 0) {
    const state = typeof stateOrRouteId === 'object'
      ? stateOrRouteId
      : { routeId: stateOrRouteId, distance: 0, lane, direction };
    let { route } = this._resolveRoute(state.routeId);
    let distance = Number.isFinite(state.distance) ? state.distance : 0;
    let travelDirection = state.direction ?? direction;
    let remaining = deltaDistance;
    let guard = 0;

    while (Math.abs(remaining) > EPSILON && guard < 8) {
      guard += 1;
      const signedTravel = remaining * (travelDirection >= 0 ? 1 : -1);
      const target = distance + signedTravel;
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
      const overrun = atEnd ? target - route.length : -target;
      distance = atEnd ? route.length : 0;
      const endpointConnections = (this.connections.get(route.id) || []).filter((connection) =>
        Math.abs(connection.fromDistance - distance) < 90);
      if (!endpointConnections.length) {
        remaining = 0;
        break;
      }
      const connection = endpointConnections[Math.abs(branchIndex) % endpointConnections.length];
      const nextRoute = this.routes.get(connection.routeId);
      const nearerStart = connection.toDistance <= nextRoute.length * 0.5;
      route = nextRoute;
      distance = connection.toDistance;
      travelDirection = nearerStart ? 1 : -1;
      remaining = overrun;
    }

    return this.sampleLane(route.id, distance, state.lane ?? lane, travelDirection);
  }

  getTrafficSpawn(randomSource = Math.random, allowedRoutes = null) {
    if (randomSource && typeof randomSource === 'object' && typeof randomSource !== 'function') {
      const request = randomSource;
      const rng = typeof request.random === 'function' ? request.random : Math.random;
      const playerPosition = request.playerPosition || request.position;
      const road = playerPosition ? this.getRoadInfo(playerPosition) : null;
      if (road?.routeId && !road.inServiceArea) {
        const route = this.routes.get(road.routeId);
        const direction = route.bidirectional && rng() < 0.16 ? -road.direction : road.direction;
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
      if (pick <= 0) {
        route = candidate;
        break;
      }
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
      return route._spatialSamples.some((sample) => xzDistanceSq(position, sample.point) <= (searchRadius + 180) ** 2);
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
    if (!routeId) return null;
    const laneIndex = laneRef.laneIndex ?? laneRef.lane ?? laneRef.index ?? 0;
    const direction = laneRef.direction ?? 1;
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
    const nearest = this._nearestOnRoute(route, position);
    const sample = this.sampleTrafficLane(laneRef, nearest.distance);
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

  getNextTrafficLane(laneRef, _vehicle = null, randomSource = Math.random) {
    if (!laneRef) return null;
    const routeId = laneRef.routeId ?? laneRef.route?.id;
    const route = this.routes.get(routeId);
    if (!route) return null;
    if (route.closed) return { ...laneRef, length: route.length, closed: true };
    const direction = laneRef.direction ?? 1;
    const endpoint = direction >= 0 ? route.length : 0;
    const possible = (this.connections.get(route.id) || []).filter((connection) => Math.abs(connection.fromDistance - endpoint) < 95);
    if (!possible.length) return null;
    const rng = typeof randomSource === 'function' ? randomSource : Math.random;
    const connection = possible[Math.floor(rng() * possible.length)];
    const nextRoute = this.routes.get(connection.routeId);
    const nextDirection = connection.toDistance < nextRoute.length * 0.5 ? 1 : -1;
    const laneIndex = clamp(laneRef.laneIndex ?? laneRef.lane ?? 0, 0, nextRoute.lanes - 1);
    return {
      id: `${nextRoute.id}:${laneIndex}:${nextDirection > 0 ? '+' : '-'}`,
      routeId: nextRoute.id,
      route: nextRoute,
      laneIndex,
      lane: laneIndex,
      direction: nextDirection,
      length: nextRoute.length,
      closed: !!nextRoute.closed,
      laneCount: nextRoute.lanes,
      laneWidth: nextRoute.laneWidth,
      speedLimit: nextRoute.speedLimit,
    };
  }

  getNextLane(laneRef, vehicle = null, randomSource = Math.random) {
    return this.getNextTrafficLane(laneRef, vehicle, randomSource);
  }

  chooseTrafficConnection(laneRef, vehicle = null, randomSource = Math.random) {
    return this.getNextTrafficLane(laneRef, vehicle, randomSource);
  }

  advanceTraffic(request) {
    if (!request) return null;
    const laneRef = request.laneRef ?? request.lane;
    if (!laneRef) return null;
    const routeId = laneRef.routeId ?? laneRef.route?.id;
    const laneIndex = laneRef.laneIndex ?? laneRef.lane ?? 0;
    const direction = laneRef.direction ?? 1;
    const result = this.advanceAlongRoute(
      { routeId, distance: request.s ?? request.distanceAlongRoute ?? 0, lane: laneIndex, direction },
      request.distance ?? request.delta ?? request.advance ?? 0,
      laneIndex,
      direction,
      request.vehicle?.poolIndex ?? 0,
    );
    return {
      ...result,
      s: result.distance,
      laneRef: result.laneRef,
      mapState: { routeId: result.routeId, direction: result.direction },
    };
  }

  _serviceAreaAt(position, margin = 0) {
    for (const area of this.serviceAreas) {
      if (Math.abs(position.y - area.elevation) > 10 + Math.max(0, margin)) continue;
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
    return this._serviceAreaAt(position, 0)?.area || null;
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

  _nearbyJunction(position) {
    let nearest = null;
    let nearestSq = Infinity;
    for (const junction of this.junctions) {
      const distanceSq = xzDistanceSq(position, junction.point);
      if (distanceSq <= junction.radius * junction.radius && distanceSq < nearestSq
        && Math.abs(position.y - junction.point.y) < 12) {
        nearest = junction;
        nearestSq = distanceSq;
      }
    }
    return nearest;
  }

  getWallCollisionBounds(position, vehicleRadius = 0) {
    const lot = this._serviceAreaAt(position, vehicleRadius + 6);
    const inAccessOpening = lot
      && Math.abs(lot.longitudinal) > lot.area.length * 0.4
      && Math.abs(lot.lateral) < 11;
    if (lot && !inAccessOpening) {
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

    const nearest = this.getNearestRoute(position, { maxDistance: 90, includeService: true });
    if (!nearest) return null;
    const route = nearest.route;
    const junction = this._nearbyJunction(position);
    const baseNormal = nearest.normal;
    const outerLimit = Math.max(0.1, route.halfWidth - vehicleRadius);
    const side = nearest.signedLateral >= 0 ? 1 : -1;
    const innerLimit = route.bidirectional ? route.medianWidth * 0.5 + vehicleRadius : -outerLimit;
    const innerPosition = route.bidirectional
      ? nearest.point.clone().addScaledVector(baseNormal, side * innerLimit)
      : nearest.point.clone().addScaledVector(baseNormal, -outerLimit);
    const outerPosition = nearest.point.clone().addScaledVector(baseNormal, side * outerLimit);
    return {
      type: 'route',
      routeId: route.id,
      route,
      distance: nearest.distance,
      center: nearest.point.clone(),
      tangent: nearest.tangent.clone(),
      normal: baseNormal.clone(),
      signedLateral: nearest.signedLateral,
      side,
      innerLimit,
      outerLimit,
      minLateral: route.bidirectional ? side * innerLimit : -outerLimit,
      maxLateral: side * outerLimit,
      innerPosition,
      outerPosition,
      leftEdge: nearest.point.clone().addScaledVector(baseNormal, route.halfWidth),
      rightEdge: nearest.point.clone().addScaledVector(baseNormal, -route.halfWidth),
      medianLeft: nearest.point.clone().addScaledVector(baseNormal, route.medianWidth * 0.5),
      medianRight: nearest.point.clone().addScaledVector(baseNormal, -route.medianWidth * 0.5),
      junction,
      disabled: !!junction,
      tunnel: this._isTunnel(route, nearest.distance),
    };
  }

  getCollisionBounds(position, vehicleRadius = 0) {
    return this.getWallCollisionBounds(position, vehicleRadius);
  }

  resolveWallCollision(position, velocityOrRadius = null, maybeRadius = 1.25) {
    const velocity = velocityOrRadius?.isVector3 ? velocityOrRadius : null;
    const radius = Number.isFinite(velocityOrRadius) ? velocityOrRadius : maybeRadius;
    const corrected = position.clone();
    const correctedVelocity = velocity ? velocity.clone() : null;
    const bounds = this.getWallCollisionBounds(position, radius);
    if (!bounds || bounds.disabled) {
      return { hit: false, position: corrected, velocity: correctedVelocity, bounds };
    }

    let hit = false;
    let collisionType = null;
    let outwardNormal = null;
    if (bounds.type === 'service-area') {
      const targetLong = clamp(bounds.longitudinal, bounds.minLongitudinal, bounds.maxLongitudinal);
      const targetSide = clamp(bounds.signedLateral, bounds.minLateral, bounds.maxLateral);
      if (Math.abs(targetLong - bounds.longitudinal) > EPSILON || Math.abs(targetSide - bounds.signedLateral) > EPSILON) {
        hit = true;
        collisionType = 'parking-wall';
        corrected.copy(bounds.center)
          .addScaledVector(bounds.tangent, targetLong)
          .addScaledVector(bounds.normal, targetSide);
        corrected.y = position.y;
        outwardNormal = position.clone().sub(corrected).setY(0).normalize();
      }
    } else {
      const { route, signedLateral, side, normal } = bounds;
      let targetLateral = signedLateral;
      if (route.bidirectional) {
        const signedInner = side * bounds.innerLimit;
        const signedOuter = side * bounds.outerLimit;
        if (Math.abs(signedLateral) < bounds.innerLimit) {
          targetLateral = signedInner;
          collisionType = 'median';
        } else if (Math.abs(signedLateral) > bounds.outerLimit) {
          targetLateral = signedOuter;
          collisionType = 'outer-wall';
        }
      } else if (signedLateral < -bounds.outerLimit || signedLateral > bounds.outerLimit) {
        targetLateral = clamp(signedLateral, -bounds.outerLimit, bounds.outerLimit);
        collisionType = 'outer-wall';
      }
      if (collisionType) {
        hit = true;
        corrected.addScaledVector(normal, targetLateral - signedLateral);
        outwardNormal = position.clone().sub(corrected).setY(0).normalize();
      }
    }

    if (hit && correctedVelocity && outwardNormal?.lengthSq() > EPSILON) {
      const outwardSpeed = correctedVelocity.dot(outwardNormal);
      if (outwardSpeed > 0) correctedVelocity.addScaledVector(outwardNormal, -outwardSpeed * 1.35);
    }
    const correctionDistance = hit ? position.distanceTo(corrected) : 0;
    return {
      hit,
      type: collisionType,
      position: corrected,
      velocity: correctedVelocity,
      normal: outwardNormal?.clone().multiplyScalar(-1) || null,
      bounds,
      // Position/velocity are already fully corrected. Keep penetration zero so
      // downstream rigid-body adapters do not apply the correction a second time.
      penetration: 0,
      correctionDistance,
    };
  }

  sweepWallCollision(from, to, velocity = null, vehicleRadius = 1.25, maxStep = 5) {
    const distance = from.distanceTo(to);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, maxStep)));
    for (let i = 1; i <= steps; i += 1) {
      const fraction = i / steps;
      const probe = from.clone().lerp(to, fraction);
      const result = this.resolveWallCollision(probe, velocity, vehicleRadius);
      if (result.hit) return { ...result, fraction, probe };
    }
    return {
      hit: false,
      fraction: 1,
      position: to.clone(),
      velocity: velocity?.clone() || null,
      bounds: this.getWallCollisionBounds(to, vehicleRadius),
    };
  }

  getWallSegments(position = null, radius = 500) {
    if (!position) return this.wallSegments;
    const radiusSq = radius * radius;
    return this.wallSegments.filter((segment) =>
      xzDistanceSq(position, segment.start) <= radiusSq || xzDistanceSq(position, segment.end) <= radiusSq);
  }

  _buildEnvironment() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(36000, 26000, 1, 1), this.materials.ground);
    ground.name = 'Dark low-poly Tokyo ground';
    ground.rotation.x = -Math.PI * 0.5;
    ground.position.set(3800, -0.3, 2800);
    this.group.add(ground);

    const water = new THREE.Mesh(new THREE.PlaneGeometry(16000, 10500, 1, 1), this.materials.water);
    water.name = 'Tokyo Bay';
    water.rotation.x = -Math.PI * 0.5;
    water.position.set(7200, 0.02, 5600);
    this.group.add(water);

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
    const step = route.kind === 'service' ? 18 : (route.kind === 'loop' ? 35 : 45);
    const segmentCount = Math.max(3, Math.ceil(route.length / step));
    const frameCount = route.closed ? segmentCount : segmentCount + 1;
    route.renderFrames.length = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const u = route.closed ? i / segmentCount : i / segmentCount;
      const position = route.curve.getPointAt(u);
      const tangent = route.curve.getTangentAt(u).normalize();
      route.renderFrames.push({
        u,
        distance: u * route.length,
        position,
        tangent,
        normal: horizontalNormal(tangent),
      });
    }
  }

  _forEachFrameSegment(route, callback) {
    const frames = route.renderFrames;
    const count = route.closed ? frames.length : frames.length - 1;
    for (let i = 0; i < count; i += 1) callback(frames[i], frames[(i + 1) % frames.length], i);
  }

  _routeStripGeometry(route, halfWidth = route.halfWidth, yOffset = 0) {
    const positions = [];
    const indices = [];
    for (const frame of route.renderFrames) {
      const left = frame.position.clone().addScaledVector(frame.normal, halfWidth);
      const right = frame.position.clone().addScaledVector(frame.normal, -halfWidth);
      left.y += yOffset;
      right.y += yOffset;
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    }
    const segmentCount = route.closed ? route.renderFrames.length : route.renderFrames.length - 1;
    for (let i = 0; i < segmentCount; i += 1) {
      const next = (i + 1) % route.renderFrames.length;
      const a = i * 2;
      const b = a + 1;
      const c = next * 2;
      const d = c + 1;
      // Counter-clockwise from above so the drivable surface faces +Y.
      indices.push(a, c, b, b, c, d);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  _pushQuad(positions, indices, a, b, c, d) {
    const start = positions.length / 3;
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  _ribbonGeometry(route, offsets, lowerOffset, upperOffset, skipJunctions = false) {
    const positions = [];
    const indices = [];
    this._forEachFrameSegment(route, (frameA, frameB) => {
      const midpoint = frameA.position.clone().lerp(frameB.position, 0.5);
      if (skipJunctions && this._nearbyJunction(midpoint)) return;
      for (const offset of offsets) {
        const a = frameA.position.clone().addScaledVector(frameA.normal, offset);
        const b = frameB.position.clone().addScaledVector(frameB.normal, offset);
        const c = b.clone();
        const d = a.clone();
        a.y += lowerOffset;
        b.y += lowerOffset;
        c.y += upperOffset;
        d.y += upperOffset;
        this._pushQuad(positions, indices, a, b, c, d);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    if (positions.length) geometry.computeBoundingSphere();
    return geometry;
  }

  _barrierGeometry(route) {
    const positions = [];
    const indices = [];
    const barriers = [
      { offset: route.halfWidth, type: 'outer', side: 1, height: route.kind === 'service' ? 0.85 : 1.2 },
      { offset: -route.halfWidth, type: 'outer', side: -1, height: route.kind === 'service' ? 0.85 : 1.2 },
    ];
    if (route.bidirectional) {
      barriers.push(
        { offset: route.medianWidth * 0.5, type: 'median', side: 1, height: 1.05 },
        { offset: -route.medianWidth * 0.5, type: 'median', side: -1, height: 1.05 },
      );
    }

    this._forEachFrameSegment(route, (frameA, frameB) => {
      const midpoint = frameA.position.clone().lerp(frameB.position, 0.5);
      if (this._nearbyJunction(midpoint)) return;
      for (const barrier of barriers) {
        const a = frameA.position.clone().addScaledVector(frameA.normal, barrier.offset);
        const b = frameB.position.clone().addScaledVector(frameB.normal, barrier.offset);
        const c = b.clone().setY(b.y + barrier.height);
        const d = a.clone().setY(a.y + barrier.height);
        a.y += 0.05;
        b.y += 0.05;
        this._pushQuad(positions, indices, a, b, c, d);
        this.wallSegments.push({
          routeId: route.id,
          type: barrier.type,
          side: barrier.side,
          start: a.clone(),
          end: b.clone(),
          height: barrier.height,
          distanceStart: frameA.distance,
          distanceEnd: frameB.distance,
        });
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    if (positions.length) geometry.computeBoundingSphere();
    return geometry;
  }

  _tunnelGeometry(route) {
    if (!route.tunnels.length) return null;
    const positions = [];
    const indices = [];
    const shellHalfWidth = route.halfWidth + 0.65;
    this._forEachFrameSegment(route, (frameA, frameB) => {
      const midpointDistance = (frameA.distance + frameB.distance) * 0.5;
      if (!this._isTunnel(route, midpointDistance)) return;
      const leftA = frameA.position.clone().addScaledVector(frameA.normal, shellHalfWidth);
      const leftB = frameB.position.clone().addScaledVector(frameB.normal, shellHalfWidth);
      const rightA = frameA.position.clone().addScaledVector(frameA.normal, -shellHalfWidth);
      const rightB = frameB.position.clone().addScaledVector(frameB.normal, -shellHalfWidth);
      const roofLeftA = leftA.clone().setY(leftA.y + 6.4);
      const roofLeftB = leftB.clone().setY(leftB.y + 6.4);
      const roofRightA = rightA.clone().setY(rightA.y + 6.4);
      const roofRightB = rightB.clone().setY(rightB.y + 6.4);
      this._pushQuad(positions, indices, leftA, leftB, roofLeftB, roofLeftA);
      this._pushQuad(positions, indices, roofRightA, roofRightB, rightB, rightA);
      this._pushQuad(positions, indices, roofLeftA, roofLeftB, roofRightB, roofRightA);
    });
    if (!positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  _buildRoadNetwork() {
    const roads = new THREE.Group();
    roads.name = 'Connected expressway decks';
    this.group.add(roads);

    for (const route of this.routes.values()) {
      this._prepareRenderFrames(route);
      const roadMaterial = route.kind === 'service' ? this.materials.serviceRoad
        : (this.routeOrder.indexOf(route.id) % 2 ? this.materials.roadAlternate : this.materials.road);
      const road = new THREE.Mesh(this._routeStripGeometry(route, route.halfWidth, 0), roadMaterial);
      road.name = `${route.code} ${route.name} road surface`;
      roads.add(road);

      const fascia = new THREE.Mesh(
        this._ribbonGeometry(route, [route.halfWidth, -route.halfWidth], -1.25, -0.02, false),
        this.materials.concreteDark,
      );
      fascia.name = `${route.code} deck fascia`;
      roads.add(fascia);

      const barrier = new THREE.Mesh(this._barrierGeometry(route), this.materials.concrete);
      barrier.name = `${route.code} guardrails and median barriers`;
      roads.add(barrier);

      const tunnelGeometry = this._tunnelGeometry(route);
      if (tunnelGeometry) {
        const tunnel = new THREE.Mesh(tunnelGeometry, this.materials.tunnel);
        tunnel.name = `${route.code} tunnel shell`;
        roads.add(tunnel);
      }

      this._queueRouteDetails(route);
    }
  }

  _instanceRecord(position, scale, quaternion = null, color = null) {
    return {
      position: position.clone(),
      scale: scale.clone(),
      quaternion: quaternion ? quaternion.clone() : new THREE.Quaternion(),
      color,
    };
  }

  _queueRouteDetails(route) {
    const markingStep = route.kind === 'service' ? 28 : 42;
    const shoulderStep = route.kind === 'service' ? 19 : 23;
    const dashLength = route.kind === 'service' ? 10 : 17;

    for (let distance = 10; distance < route.length; distance += markingStep) {
      const sample = this._sampleCenter(route, distance, 1);
      const quaternion = yawQuaternion(sample.tangent);
      const offsets = [];
      if (route.bidirectional) {
        for (let lane = 1; lane < route.lanes; lane += 1) {
          const boundary = route.medianWidth * 0.5 + lane * route.laneWidth;
          offsets.push(boundary, -boundary);
        }
      } else {
        for (let lane = 1; lane < route.lanes; lane += 1) offsets.push((lane - route.lanes * 0.5) * route.laneWidth);
      }
      for (const offset of offsets) {
        const position = sample.position.clone().addScaledVector(sample.normal, offset);
        position.y += 0.085;
        this._markingInstances.push(this._instanceRecord(position, vec(0.13, 0.035, dashLength), quaternion));
      }
    }

    for (let distance = 4; distance < route.length; distance += shoulderStep) {
      const sample = this._sampleCenter(route, distance, 1);
      const quaternion = yawQuaternion(sample.tangent);
      const shoulderOffset = route.halfWidth - Math.max(0.24, route.shoulder * 0.46);
      for (const offset of [shoulderOffset, -shoulderOffset]) {
        const position = sample.position.clone().addScaledVector(sample.normal, offset);
        position.y += 0.09;
        this._markingInstances.push(this._instanceRecord(position, vec(0.18, 0.04, Math.min(18, shoulderStep - 2)), quaternion));
      }
      if (route.bidirectional) {
        for (const side of [-1, 1]) {
          const position = sample.position.clone().addScaledVector(sample.normal, side * (route.medianWidth * 0.5 + 0.16));
          position.y += 0.095;
          this._markingInstances.push(this._instanceRecord(position, vec(0.13, 0.04, Math.min(18, shoulderStep - 2)), quaternion, 0xe8a444));
        }
      }
    }

    const supportStep = route.kind === 'service' ? 90 : 175;
    for (let distance = supportStep * 0.5; distance < route.length; distance += supportStep) {
      const sample = this._sampleCenter(route, distance, 1);
      if (this._isTunnel(route, distance) || this._nearbyJunction(sample.position)) continue;
      const height = Math.max(4, sample.position.y - 1.2);
      const position = sample.position.clone();
      position.y = height * 0.5;
      this._pillarInstances.push(this._instanceRecord(position, vec(route.kind === 'service' ? 0.75 : 1.05, height, route.kind === 'service' ? 0.75 : 1.05)));
    }

    const lightStep = route.kind === 'service' ? 72 : 165;
    for (let distance = lightStep * 0.3; distance < route.length; distance += lightStep) {
      const sample = this._sampleCenter(route, distance, 1);
      const quaternion = yawQuaternion(sample.tangent);
      if (this._isTunnel(route, distance)) {
        const position = sample.position.clone();
        position.y += 6.05;
        this._tunnelLampInstances.push(this._instanceRecord(position, vec(0.65, 0.12, 1.5), quaternion));
      } else {
        const polePosition = sample.position.clone();
        polePosition.y += 3.15;
        this._poleInstances.push(this._instanceRecord(polePosition, vec(0.12, 6.3, 0.12)));
        const lampPosition = sample.position.clone();
        lampPosition.y += 6.35;
        this._lampInstances.push(this._instanceRecord(lampPosition, vec(0.5, 0.16, 1.45), quaternion));
      }
    }

    if (route.kind !== 'service') {
      for (let distance = 30; distance < route.length; distance += 92) {
        const sample = this._sampleCenter(route, distance, 1);
        const quaternion = yawQuaternion(sample.tangent);
        for (const side of [-1, 1]) {
          const position = sample.position.clone().addScaledVector(sample.normal, side * (route.halfWidth - 0.12));
          position.y += 0.65;
          this._reflectorInstances.push(this._instanceRecord(position, vec(0.13, 0.14, 0.36), quaternion, side > 0 ? 0xffb45b : 0xe7efff));
        }
      }
    }
  }

  _addBox(parent, size, position, quaternion, material, name = '') {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
    mesh.position.copy(position);
    if (quaternion) mesh.quaternion.copy(quaternion);
    mesh.name = name;
    parent.add(mesh);
    return mesh;
  }

  _buildJunctionPlatforms() {
    const group = new THREE.Group();
    group.name = 'Open interchange gore platforms';
    for (const junction of this.junctions) {
      const platform = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.min(30, junction.radius * 0.58), Math.min(31, junction.radius * 0.6), 1.15, 12),
        this.materials.road,
      );
      platform.position.copy(junction.point);
      platform.position.y -= 0.56;
      platform.name = junction.name;
      group.add(platform);

      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 1.1), this.materials.lamp);
      lamp.position.copy(junction.point).add(vec(0, 7.5, 0));
      group.add(lamp);
    }
    this.group.add(group);
  }

  _buildServiceAreas() {
    const group = new THREE.Group();
    group.name = 'Service and parking areas';
    this.group.add(group);

    for (const area of this.serviceAreas) {
      const orientation = yawQuaternion(area.tangent);
      const platformPosition = area.center.clone();
      platformPosition.y -= 0.65;
      this._addBox(
        group,
        vec(area.width, 1.3, area.length),
        platformPosition,
        orientation,
        this.materials.serviceRoad,
        `${area.name} elevated parking deck`,
      );

      const addSideRail = (side, startAlong, endAlong) => {
        const segmentLength = Math.max(0, endAlong - startAlong);
        if (segmentLength < 2) return;
        const railPosition = area.center.clone()
          .addScaledVector(area.normal, side * area.width * 0.5)
          .addScaledVector(area.tangent, (startAlong + endAlong) * 0.5);
        railPosition.y += 0.55;
        this._addBox(group, vec(0.42, 1.1, segmentLength), railPosition, orientation, this.materials.concrete, `${area.name} parking guardrail`);
      };
      addSideRail(-1, -area.length * 0.5, area.length * 0.5);
      if (area.hasGarage) {
        const garageAlong = TMP_A.copy(area.garageEntrance).sub(area.center).dot(area.tangent);
        addSideRail(1, -area.length * 0.5, garageAlong - 14);
        addSideRail(1, garageAlong + 14, area.length * 0.5);
      } else {
        addSideRail(1, -area.length * 0.5, area.length * 0.5);
      }
      const endOpening = 13;
      const endRailLength = (area.width - endOpening * 2) * 0.5;
      for (const endSide of [-1, 1]) {
        for (const acrossSide of [-1, 1]) {
          const across = acrossSide * (endOpening + endRailLength * 0.5);
          const railPosition = area.center.clone()
            .addScaledVector(area.tangent, endSide * area.length * 0.5)
            .addScaledVector(area.normal, across);
          railPosition.y += 0.55;
          this._addBox(group, vec(endRailLength, 1.1, 0.42), railPosition, orientation, this.materials.concrete, `${area.name} entry guardrail`);
        }
      }

      const cornerAcross = area.width * 0.36;
      const cornerAlong = area.length * 0.36;
      for (const across of [-cornerAcross, cornerAcross]) {
        for (const along of [-cornerAlong, cornerAlong]) {
          const pillarPosition = area.center.clone()
            .addScaledVector(area.normal, across)
            .addScaledVector(area.tangent, along);
          const height = Math.max(4, area.elevation - 1.1);
          pillarPosition.y = height * 0.5;
          this._pillarInstances.push(this._instanceRecord(pillarPosition, vec(1.25, height, 1.25)));
        }
      }

      for (let along = -area.length * 0.31; along <= area.length * 0.31; along += 24) {
        for (const across of [-area.width * 0.23, area.width * 0.23]) {
          const linePosition = area.center.clone()
            .addScaledVector(area.tangent, along)
            .addScaledVector(area.normal, across);
          linePosition.y += 0.08;
          this._markingInstances.push(this._instanceRecord(linePosition, vec(0.14, 0.04, 15), orientation));
        }
      }
      for (const across of [-area.width * 0.35, 0, area.width * 0.35]) {
        const linePosition = area.center.clone().addScaledVector(area.normal, across);
        linePosition.y += 0.09;
        const crossOrientation = orientation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI * 0.5));
        this._markingInstances.push(this._instanceRecord(linePosition, vec(0.17, 0.04, area.width * 0.22), crossOrientation));
      }

      for (const along of [-area.length * 0.3, 0, area.length * 0.3]) {
        const polePosition = area.center.clone().addScaledVector(area.tangent, along);
        polePosition.y += 3.6;
        this._poleInstances.push(this._instanceRecord(polePosition, vec(0.14, 7.2, 0.14)));
        const lampPosition = area.center.clone().addScaledVector(area.tangent, along);
        lampPosition.y += 7.25;
        this._lampInstances.push(this._instanceRecord(lampPosition, vec(0.65, 0.17, 1.8), orientation));
      }

      const vendingBase = area.center.clone()
        .addScaledVector(area.normal, -area.width * 0.38)
        .addScaledVector(area.tangent, -area.length * 0.08);
      const vendingOrientation = yawQuaternion(area.normal);
      for (let index = 0; index < 3; index += 1) {
        const vendingPosition = vendingBase.clone().addScaledVector(area.tangent, (index - 1) * 2.15);
        vendingPosition.y += 1.2;
        this._addBox(group, vec(1.65, 2.4, 0.85), vendingPosition, vendingOrientation, this.materials.vending, `${area.name} glowing vending machine`);
        const casingPosition = vendingPosition.clone().addScaledVector(area.normal, -0.48);
        this._addBox(group, vec(1.78, 2.55, 0.16), casingPosition, vendingOrientation, this.materials.concreteDark);
      }

      const fuelMarker = new THREE.Mesh(
        new THREE.CylinderGeometry(2.4, 2.4, 0.12, 12),
        this.materials.amberMarking,
      );
      fuelMarker.position.copy(area.refuelPosition);
      fuelMarker.position.y += 0.1;
      fuelMarker.name = `${area.name} refuel pad`;
      group.add(fuelMarker);

      const paSignPosition = area.center.clone()
        .addScaledVector(area.normal, -area.width * 0.46)
        .addScaledVector(area.tangent, area.length * 0.35);
      paSignPosition.y += 4.3;
      const paSign = new THREE.Mesh(
        new THREE.PlaneGeometry(7.5, 2.6),
        this._getSignMaterial(`${area.name.toUpperCase()}|パーキングエリア`, '#175ba5'),
      );
      paSign.position.copy(paSignPosition);
      paSign.quaternion.copy(yawQuaternion(area.tangent));
      paSign.name = `${area.name} illuminated sign`;
      group.add(paSign);

      if (area.hasGarage) this._buildGarageExterior(group, area);
    }
  }

  _buildGarageExterior(parent, area) {
    const frontNormal = area.normal.clone();
    const buildingOrientation = yawQuaternion(frontNormal);
    const buildingPosition = area.garageEntrance.clone().addScaledVector(frontNormal, 18);
    buildingPosition.y += 6.2;
    this._addBox(parent, vec(48, 12.4, 34), buildingPosition, buildingOrientation, this.materials.garage, 'Player garage exterior');

    const shutterPosition = area.garageEntrance.clone().addScaledVector(frontNormal, 0.8);
    shutterPosition.y += 3.45;
    this._addBox(parent, vec(24, 6.8, 0.42), shutterPosition, buildingOrientation, this.materials.shutter, 'Player garage shutter');

    const signPosition = area.garageEntrance.clone().addScaledVector(frontNormal, 0.45);
    signPosition.y += 8.5;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(17, 3.25),
      this._getSignMaterial('MIDNIGHT GARAGE|湾岸整備工場', '#582b72'),
    );
    sign.position.copy(signPosition);
    sign.quaternion.copy(yawQuaternion(frontNormal.clone().multiplyScalar(-1)));
    sign.name = 'Midnight Garage sign';
    parent.add(sign);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(10.5, 0.72, 4, 18), this.materials.marker);
    ring.position.copy(area.garageEntrance);
    ring.position.y += 0.45;
    ring.rotation.x = Math.PI * 0.5;
    ring.name = 'Garage transition marker';
    parent.add(ring);
    this.animatedMarkers.push(ring);

    const beacon = new THREE.PointLight(0x55ccff, 1.4, 46, 1.8);
    beacon.position.copy(area.garageEntrance).add(vec(0, 5, 0));
    parent.add(beacon);
  }

  _createInstancedMesh(records, material, name) {
    if (!records.length) return null;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    let instanceMaterial = material;
    const hasColors = records.some((record) => record.color !== null && record.color !== undefined);
    if (hasColors) {
      instanceMaterial = material.clone();
      instanceMaterial.color.set(0xffffff);
    }
    const mesh = new THREE.InstancedMesh(geometry, instanceMaterial, records.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    records.forEach((record, index) => {
      TMP_MAT.compose(record.position, record.quaternion, record.scale);
      mesh.setMatrixAt(index, TMP_MAT);
      if (hasColors) mesh.setColorAt(index, new THREE.Color(record.color ?? material.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  _buildInstancedDetails() {
    this._createInstancedMesh(this._markingInstances, this.materials.marking, 'Lane and parking markings');
    this._createInstancedMesh(this._reflectorInstances, this.materials.reflector, 'Guardrail reflectors');
    this._createInstancedMesh(this._pillarInstances, this.materials.concreteDark, 'Expressway support pillars');
    this._createInstancedMesh(this._poleInstances, this.materials.concrete, 'Sodium lamp poles');
    this._createInstancedMesh(this._lampInstances, this.materials.lamp, 'Sodium vapor luminaires');
    this._createInstancedMesh(this._tunnelLampInstances, this.materials.tunnelLamp, 'Tunnel luminaires');
  }

  _distanceToRoadXZ(position) {
    let bestSq = Infinity;
    for (const route of this.routes.values()) {
      if (route.kind === 'service') continue;
      for (const sample of route._spatialSamples) bestSq = Math.min(bestSq, xzDistanceSq(position, sample.point));
    }
    return Math.sqrt(bestSq);
  }

  _buildCity() {
    const random = mulberry32(this.seed ^ 0xa73b91);
    const buildings = [];
    const windowBands = [];
    const count = this.options.cityBuildingCount ?? 680;
    for (let attempt = 0; attempt < count * 4 && buildings.length < count; attempt += 1) {
      const denseCore = random() < 0.58;
      const x = denseCore ? -3000 + random() * 7000 : -6500 + random() * 21000;
      const z = denseCore ? -3200 + random() * 7200 : -3600 + random() * 13200;
      const position = vec(x, 0, z);
      if (this._distanceToRoadXZ(position) < 62) continue;
      const overBay = x > 3000 && z > 2600;
      if (overBay && random() < 0.84) continue;
      const width = 20 + random() * (denseCore ? 52 : 78);
      const depth = 20 + random() * (denseCore ? 52 : 70);
      const height = 16 + Math.pow(random(), 1.8) * (denseCore ? 185 : 105);
      const yaw = Math.floor(random() * 4) * Math.PI * 0.5 + (random() - 0.5) * 0.12;
      const quaternion = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
      position.y = height * 0.5 - 0.1;
      const palette = [0x111622, 0x151925, 0x1a1c28, 0x10141d, 0x20202a];
      buildings.push(this._instanceRecord(position, vec(width, height, depth), quaternion, palette[Math.floor(random() * palette.length)]));

      if (random() < 0.34 && height > 35) {
        const bandPosition = position.clone();
        bandPosition.y = 8 + random() * Math.max(5, height - 16);
        const color = random() < 0.72 ? 0x665a39 : 0x33445f;
        windowBands.push(this._instanceRecord(bandPosition, vec(width + 0.35, 0.7, depth + 0.35), quaternion, color));
      }
    }

    this._createInstancedMesh(buildings, this.materials.building, 'Low-poly Tokyo skyline');
    this._createInstancedMesh(windowBands, this.materials.lamp, 'Sparse city window glow');

    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(18, 28, 260, 8),
      this.materials.concreteDark,
    );
    tower.position.set(-250, 130, 300);
    tower.name = 'Low-poly broadcast tower landmark';
    this.group.add(tower);
    const towerLight = new THREE.Mesh(new THREE.BoxGeometry(7, 7, 7), this.materials.reflector);
    towerLight.position.set(-250, 264, 300);
    this.group.add(towerLight);
  }

  _getSignMaterial(text, background = '#12644d') {
    const key = `${background}:${text}`;
    if (this._signMaterials.has(key)) return this._signMaterials.get(key);

    if (typeof document === 'undefined') {
      const fallback = this.materials.signGreen.clone();
      this._signMaterials.set(key, fallback);
      return fallback;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#e8f0de';
    context.lineWidth = 5;
    context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
    const lines = text.split('|');
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#f0f3e5';
    context.font = 'bold 23px monospace';
    context.fillText(lines[0] || '', 128, lines.length > 1 ? 37 : 49);
    if (lines.length > 1) {
      context.font = 'bold 16px sans-serif';
      context.fillText(lines[1], 128, 67);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this._ownedTextures.add(texture);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      color: 0xffffff,
      fog: true,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this._signMaterials.set(key, material);
    return material;
  }

  _buildGantry(group, route, distance, label) {
    const sample = this._sampleCenter(route, distance, 1);
    if (this._isTunnel(route, distance)) return;
    const orientation = yawQuaternion(sample.tangent);
    const width = route.roadWidth + 4.5;
    const beamPosition = sample.position.clone();
    beamPosition.y += 6.35;
    this._addBox(group, vec(width, 0.34, 0.34), beamPosition, orientation, this.materials.concrete, `${route.code} gantry beam`);
    for (const side of [-1, 1]) {
      const postPosition = sample.position.clone().addScaledVector(sample.normal, side * (route.halfWidth + 1.35));
      postPosition.y += 3.15;
      this._addBox(group, vec(0.3, 6.3, 0.3), postPosition, orientation, this.materials.concrete, `${route.code} gantry post`);
    }
    const signPosition = sample.position.clone().addScaledVector(sample.normal, route.halfWidth * 0.22);
    signPosition.y += 7.7;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(9.2, width * 0.55), 2.55), this._getSignMaterial(label));
    sign.position.copy(signPosition);
    sign.quaternion.copy(orientation);
    sign.name = `${route.code} overhead sign ${label}`;
    group.add(sign);
  }

  _buildDistanceBoard(group, route, distance) {
    const sample = this._sampleCenter(route, distance, 1);
    const orientation = yawQuaternion(sample.tangent);
    const position = sample.position.clone().addScaledVector(sample.normal, route.halfWidth + 0.2);
    position.y += 2.45;
    const kilometre = Math.round(distance / 100) / 10;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(2.35, 1.65),
      this._getSignMaterial(`${route.code} ${kilometre.toFixed(1)}|距離標`, '#174c72'),
    );
    board.position.copy(position);
    board.quaternion.copy(orientation);
    board.name = `${route.code} ${kilometre.toFixed(1)} km distance board`;
    group.add(board);
  }

  _buildTunnelPortal(group, route, distance, name) {
    const sample = this._sampleCenter(route, distance, 1);
    const orientation = yawQuaternion(sample.tangent);
    const beamPosition = sample.position.clone();
    beamPosition.y += 6.15;
    this._addBox(group, vec(route.roadWidth + 2.2, 0.65, 0.75), beamPosition, orientation, this.materials.tunnelRib, `${name} portal lintel`);
    for (const side of [-1, 1]) {
      const sidePosition = sample.position.clone().addScaledVector(sample.normal, side * (route.halfWidth + 0.75));
      sidePosition.y += 3.05;
      this._addBox(group, vec(0.72, 6.1, 0.75), sidePosition, orientation, this.materials.tunnelRib, `${name} portal side`);
    }
  }

  _buildSignage() {
    const group = new THREE.Group();
    group.name = 'Gantry signs, portals and distance boards';
    this.group.add(group);

    for (const route of this.routes.values()) {
      if (route.kind === 'service') continue;
      const interval = route.id === 'c1' ? 1450 : (route.kind === 'connector' ? 1800 : 2350);
      let signIndex = 0;
      for (let distance = Math.min(620, route.length * 0.16); distance < route.length - 150; distance += interval) {
        const destination = route.destinations?.[signIndex % route.destinations.length] || route.name.toUpperCase();
        const secondary = route.destinations?.[(signIndex + 1) % route.destinations.length] || '首都高';
        this._buildGantry(group, route, distance, `${route.code}  ${destination}|${secondary}  NEXT JCT`);
        signIndex += 1;
      }
      for (let distance = 850; distance < route.length; distance += 1000) this._buildDistanceBoard(group, route, distance);
      for (const tunnel of route.tunnels) {
        this._buildTunnelPortal(group, route, tunnel.startDistance, tunnel.name);
        this._buildTunnelPortal(group, route, tunnel.endDistance, tunnel.name);
      }
    }

    for (const junction of this.junctions.filter((candidate) => candidate.radius >= 45)) {
      const polePosition = junction.point.clone();
      polePosition.y += 5.4;
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(7.5, 2.2),
        this._getSignMaterial(`${junction.name.toUpperCase()}|分岐  JUNCTION`, '#1b604d'),
      );
      label.position.copy(polePosition);
      const route = this.routes.get(junction.routes[0]);
      const nearest = this._nearestOnRoute(route, junction.point);
      label.quaternion.copy(yawQuaternion(nearest.tangent));
      label.name = junction.name;
      group.add(label);
    }
  }

  _buildMinimapData() {
    const colors = {
      c1: '#ffb454',
      wangan: '#4fc9ff',
      yokohane: '#e87bff',
      shinjuku: '#79e690',
      rainbow: '#ffe667',
      bay_link: '#f07777',
      service: '#aeb8c8',
    };
    const routes = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const route of this.routes.values()) {
      const count = Math.max(12, Math.ceil(route.length / (route.kind === 'service' ? 34 : 105)));
      const points = [];
      for (let i = 0; i <= count; i += 1) {
        if (route.closed && i === count) continue;
        const point = route.curve.getPointAt(i / count);
        const plain = { x: point.x, y: point.y, z: point.z };
        points.push(plain);
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
        width: route.kind === 'service' ? 1 : (route.lanes >= 3 ? 3 : 2),
        length: route.length,
      });
    }
    const padding = 550;
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
    };
  }

  build() {
    return this;
  }

  update(_playerPosition = null, timeSeconds = 0) {
    const pulse = 1 + Math.sin(timeSeconds * 3.2) * 0.12;
    for (const marker of this.animatedMarkers) {
      marker.scale.setScalar(pulse);
      marker.rotation.z = timeSeconds * 0.35;
      if (marker.material) marker.material.opacity = 0.62 + Math.sin(timeSeconds * 4.1) * 0.18;
    }
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
