import * as THREE from 'three';
import { buildCustomAssetGroup } from './custom-assets.js';
import {
  TRAFFIC_CAR_TYPES,
  carModelEntry,
  carModelTarget,
  effectiveTrafficCarType,
} from './car-models.js';

const clamp = THREE.MathUtils.clamp;
const EPSILON = 1e-6;
const UP = new THREE.Vector3(0, 1, 0);

// Only three visual classes exist, by design: a passenger CAR (auto), a VAN /
// box-truck (camioncino / furgone) and an articulated TIR (semi). They are
// deliberately plain boxes — no wheels, no glass — so the effort goes into
// believable real-world dimensions and a realistic spawn / lane distribution.
//   weight     — relative spawn frequency (cars common, tir rare).
//   laneBias   — preferred lane, 0 = fast lane by the median … 1 = slow OUTER
//                (left-hand) lane. Tir hug the outer lane, cars roam.
//   laneSpread — how tightly the class sticks to laneBias.
//   topSpeed   — free-flow cruising speed in m/s (highway limit caps it).
const VEHICLE_TYPES = TRAFFIC_CAR_TYPES;

// Per-class colour palettes. Every traffic vehicle — car, van and tir alike —
// is painted the same fluorescent "neon" green (verde fluo), so the AI traffic
// reads as a single uniform, high-visibility fleet. Each palette holds only
// this one colour, which the random picker below then trivially selects.
const NEON_GREEN = 0x39ff14;
const CAR_COLORS = [NEON_GREEN];
const VAN_COLORS = [NEON_GREEN];
const TRUCK_COLORS = [NEON_GREEN];
const COLORS_BY_ID = { car: CAR_COLORS, van: VAN_COLORS, truck: TRUCK_COLORS };

// Neutral fallback so a hand-built vehicle (tests) still behaves sanely.
const DEFAULT_DRIVER = Object.freeze({ speedMul: 1, gapMul: 1, accelMul: 1, laneChangeBias: 1, patience: 0.6, wanderPhase: 0, wanderAmp: 0 });

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function asVector3(value, fallback = null) {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(finite(value[0], 0), finite(value[1], 0), finite(value[2], 0));
  }
  if (value && Number.isFinite(value.x) && Number.isFinite(value.z)) {
    return new THREE.Vector3(value.x, finite(value.y, 0), value.z);
  }
  return fallback ? fallback.clone() : new THREE.Vector3();
}

/** Allocation-free asVector3: same coercion rules, writes into `target`. */
function copyVector3(target, value) {
  if (value?.isVector3) return target.copy(value);
  if (Array.isArray(value) && value.length >= 3) {
    return target.set(finite(value[0], 0), finite(value[1], 0), finite(value[2], 0));
  }
  if (value && Number.isFinite(value.x) && Number.isFinite(value.z)) {
    return target.set(value.x, finite(value.y, 0), value.z);
  }
  return target.set(0, 0, 0);
}

function seededRandom(seed) {
  let state = (Number(seed) || 0x7f4a7c15) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function speedToMps(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return value > 45 ? value / 3.6 : value;
}

function segmentClosestToOrigin(startX, startZ, endX, endZ) {
  const dx = endX - startX;
  const dz = endZ - startZ;
  const denominator = dx * dx + dz * dz;
  const t = denominator > EPSILON ? clamp(-(startX * dx + startZ * dz) / denominator, 0, 1) : 1;
  const x = startX + dx * t;
  const z = startZ + dz * t;
  return { t, x, z, distance: Math.hypot(x, z) };
}

function segmentVsAabb(startX, startZ, endX, endZ, halfX, halfZ) {
  const dx = endX - startX;
  const dz = endZ - startZ;
  let near = 0;
  let far = 1;
  let hitAxis = 'x';
  let hitSign = 0;
  for (const axis of ['x', 'z']) {
    const start = axis === 'x' ? startX : startZ;
    const delta = axis === 'x' ? dx : dz;
    const half = axis === 'x' ? halfX : halfZ;
    if (Math.abs(delta) < EPSILON) {
      if (start < -half || start > half) return null;
      continue;
    }
    let t1 = (-half - start) / delta;
    let t2 = (half - start) / delta;
    let sign = -Math.sign(delta);
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = Math.sign(delta);
    }
    if (t1 > near) {
      near = t1;
      hitAxis = axis;
      hitSign = sign;
    }
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  if (far < 0 || near > 1) return null;
  return { time: clamp(near, 0, 1), axis: hitAxis, sign: hitSign || 1 };
}

function rectangleSupport(direction, right, forward, halfWidth, halfLength) {
  return Math.abs(direction.dot(right)) * halfWidth + Math.abs(direction.dot(forward)) * halfLength;
}

/**
 * Build the shared box-geometries for one vehicle class. Everything is centred
 * on X/Z with its underside at Y=0 so the mesh group sits flat on the road.
 * Every class — car, van AND tir — is a SINGLE plain box, differentiated only
 * by size (no cab/trailer split, no wheels, no glass). Lamps, brake lights and
 * the two rear turn signals are tiny boxes at the corners.
 */
function buildVehicleGeometry(type) {
  const w = type.width;
  const l = type.length;
  const h = type.height;
  const half = l * 0.5;
  const body = mergedBoxGeometry([[[w, h, l], [0, h * 0.5, 0]]]);
  const headY = type.id === 'truck' ? 1.2 : h * 0.5;
  const tailY = type.id === 'truck' ? 1.05 : h * 0.52;
  const frontZ = half - 0.04;
  const rearZ = -half + 0.04;
  const lampW = Math.min(0.3, w * 0.17);
  const lamps = mergedBoxGeometry([
    [[lampW, 0.16, 0.06], [-w * 0.33, headY, frontZ]],
    [[lampW, 0.16, 0.06], [w * 0.33, headY, frontZ]],
  ]);
  const brake = mergedBoxGeometry([
    [[lampW, 0.18, 0.06], [-w * 0.34, tailY, rearZ]],
    [[lampW, 0.18, 0.06], [w * 0.34, tailY, rearZ]],
  ]);
  // Two rear turn signals — a single amber lamp per side sitting just outboard
  // of the brake lights on the tail, so the blink reads from directly behind
  // the car instead of from boxes stuck on the flanks. Bounding-box X keeps side.
  const blinker = (sign) => mergedBoxGeometry([
    [[0.12, 0.16, 0.06], [sign * (w * 0.34 + 0.22), tailY, rearZ]],
  ]);
  return { body, lamps, brake, blinkerL: blinker(-1), blinkerR: blinker(1) };
}

/**
 * Bake a list of axis-aligned boxes into a single BufferGeometry so each
 * traffic car costs a handful of draw calls instead of ~15. Parts may carry a
 * per-part color which is baked as a vertex-color attribute, letting one
 * shared vertex-color material draw what used to be 4-5 material groups.
 */
function mergedBoxGeometry(parts) {
  const geometries = parts.map(([scale, position]) => {
    const box = new THREE.BoxGeometry(scale[0], scale[1], scale[2]);
    box.translate(position[0], position[1], position[2]);
    return box;
  });
  const hasColors = parts.some((part) => part[2] !== undefined && part[2] !== null);
  let vertexCount = 0;
  let indexCount = 0;
  for (const geometry of geometries) {
    vertexCount += geometry.attributes.position.count;
    indexCount += geometry.index.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const colors = hasColors ? new Float32Array(vertexCount * 3) : null;
  const index = new (vertexCount > 65535 ? Uint32Array : Uint16Array)(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  const tint = new THREE.Color();
  geometries.forEach((geometry, geometryIndex) => {
    position.set(geometry.attributes.position.array, vertexOffset * 3);
    normal.set(geometry.attributes.normal.array, vertexOffset * 3);
    uv.set(geometry.attributes.uv.array, vertexOffset * 2);
    if (colors) {
      tint.set(parts[geometryIndex][2] ?? 0xffffff);
      for (let i = 0; i < geometry.attributes.position.count; i += 1) {
        colors[(vertexOffset + i) * 3] = tint.r;
        colors[(vertexOffset + i) * 3 + 1] = tint.g;
        colors[(vertexOffset + i) * 3 + 2] = tint.b;
      }
    }
    const sourceIndex = geometry.index.array;
    for (let i = 0; i < sourceIndex.length; i += 1) index[indexOffset + i] = sourceIndex[i] + vertexOffset;
    vertexOffset += geometry.attributes.position.count;
    indexOffset += sourceIndex.length;
    geometry.dispose();
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A pooled vehicle is one generic group whose part geometries are swapped to a
 * class at spawn (see TrafficSystem._applyVehicleType). The body carries its
 * own Lambert material so each car gets an individual colour; every other part
 * shares a material. Draw calls stay ~3-4 per visible vehicle.
 */
function makeTrafficMesh(geometries, sharedMaterials) {
  const group = new THREE.Group();
  group.name = 'traffic-vehicle';
  // The body carries a self-lit floor (emissive = its own colour) so the
  // fluorescent fleet reads at any distance instead of falling to a black
  // silhouette once it is outside the player's headlight cone — the reveal as
  // you close on a car should be subtle, not "it just switched on". This is a
  // material property, not a light, so it costs nothing per frame.
  const body = new THREE.Mesh(geometries.body, new THREE.MeshLambertMaterial({ flatShading: true, emissiveIntensity: 0.34 }));
  const lamps = new THREE.Mesh(geometries.lamps, sharedMaterials.headlamp);
  const taillamp = new THREE.Mesh(geometries.brake, sharedMaterials.taillamp);
  const blinkerL = new THREE.Mesh(geometries.blinkerL, sharedMaterials.indicator);
  const blinkerR = new THREE.Mesh(geometries.blinkerR, sharedMaterials.indicator);
  blinkerL.visible = false;
  blinkerR.visible = false;
  group.add(body, lamps, taillamp, blinkerL, blinkerR);

  group.userData.body = body;
  group.userData.lamps = lamps;
  group.userData.headlamps = [];
  group.userData.taillamps = [taillamp];
  // side -1 sits on local -X, side +1 on local +X; the runtime picks the side
  // from the actual lateral movement so the signal always matches the drift.
  group.userData.indicators = [{ side: -1, meshes: [blinkerL] }, { side: 1, meshes: [blinkerR] }];
  group.userData.ownedMaterials = [body.material];
  return group;
}

/**
 * Pooled highway traffic. It accepts a map adapter instead of importing a map
 * module. The adapter can expose high-level traffic spawn/advance methods, lane
 * sampling methods, or simply lane/route arrays containing Three.js curves.
 */
export class TrafficSystem {
  constructor(scene, map = null, options = {}) {
    if (scene && !scene.isScene && !scene.add && typeof scene === 'object' && !map) {
      options = scene;
      scene = options.scene;
      map = options.map;
    }
    this.scene = scene ?? new THREE.Group();
    this.map = map;
    this.options = {
      maxVehicles: Math.max(1, Math.floor(options.maxVehicles ?? Math.max(72, options.count ?? 0))),
      targetVehicles: Math.max(0, Math.floor(options.targetVehicles ?? options.count ?? 50)),
      density: clamp(finite(options.density, 1), 0, 3),
      spawnRadius: Math.max(80, finite(options.spawnRadius, 850)),
      despawnRadius: Math.max(120, finite(options.despawnRadius, 1100)),
      minSpawnDistance: Math.max(20, finite(options.minSpawnDistance, 130)),
      // Anything spawning IN FRONT of the player must be at least this far away,
      // so cars never blink into existence in view. Pushed out past the fog
      // horizon: at 340 m a new car was ~75% visible through the night haze and
      // read as "popping in" — by ~600 m the exponential fog has faded it to a
      // faint shape that simply resolves as the player closes the distance.
      // Behind the player cars may still appear as close as minSpawnDistance
      // (out of sight).
      frontSpawnDistance: Math.max(0, finite(options.frontSpawnDistance, 600)),
      nearMissDistance: clamp(finite(options.nearMissDistance, 2.25), 0.5, 5),
      nearMissMinSpeed: speedToMps(options.nearMissMinSpeed, 100 / 3.6),
      maxSpawnPerFrame: Math.max(1, Math.floor(options.maxSpawnPerFrame ?? 6)),
      seed: options.seed ?? 0x51f15e,
      autoResolvePlayerCollisions: Boolean(options.autoResolvePlayerCollisions),
      onNearMiss: options.onNearMiss ?? null,
      onCollision: options.onCollision ?? null,
      onSpawn: options.onSpawn ?? null,
      onDespawn: options.onDespawn ?? null,
    };
    this.random = seededRandom(this.options.seed);
    this.density = this.options.density;
    this.vehicleTypes = Object.fromEntries(VEHICLE_TYPES.map((type) => [type.id, { ...type }]));
    // Live-tunable behaviour knobs (dev panel). typeWeights sets how common each
    // class is, laneChangeRate scales how often cars change lane (0 = never),
    // speedFactor scales free-flow cruising speed across all traffic.
    this.typeWeights = this._normalizeTypeWeights(options.typeWeights ?? {
      car: this.vehicleTypes.car.weight, van: this.vehicleTypes.van.weight, truck: this.vehicleTypes.truck.weight,
    });
    this.laneChangeRate = clamp(finite(options.laneChangeRate, 1), 0, 3);
    this.speedFactor = clamp(finite(options.speedFactor, 1), 0.4, 1.8);
    this.time = 0;
    this._idCounter = 0;
    this._events = [];
    this._eventQueue = [];
    this._previousPlayerPosition = new THREE.Vector3();
    this._hasPreviousPlayer = false;
    this._laneCache = [];
    this._laneCacheTime = -Infinity;
    this._objectRefIds = new WeakMap();
    this._nextRefId = 1;
    this._disposed = false;
    // One shared geometry-set per class, swapped onto a pooled mesh at spawn.
    this._typeGeometries = Object.fromEntries(Object.values(this.vehicleTypes).map((type) => [type.id, buildVehicleGeometry(type)]));
    this._customModelTemplates = {};
    this._customModelDocument = null;
    this._customModelResolver = null;
    this._sharedMaterials = {
      headlamp: new THREE.MeshBasicMaterial({ color: 0xfff0be, toneMapped: false }),
      taillamp: new THREE.MeshBasicMaterial({ color: 0x8a1512, toneMapped: false }),
      indicator: new THREE.MeshBasicMaterial({ color: 0xffa51f, toneMapped: false }),
    };
    this.pool = [];
    this.active = [];
    for (let i = 0; i < this.options.maxVehicles; i += 1) this._createPooledVehicle(i);
  }

  _createPooledVehicle(index) {
    const type = this.vehicleTypes.car;
    const mesh = makeTrafficMesh(this._typeGeometries[type.id], this._sharedMaterials);
    mesh.visible = false;
    mesh.matrixAutoUpdate = true;
    this.scene.add(mesh);
    const vehicle = {
      id: `traffic-${++this._idCounter}`,
      poolIndex: index,
      active: false,
      type,
      driver: DEFAULT_DRIVER,
      mesh,
      width: type.width,
      length: type.length,
      height: type.height,
      position: mesh.position,
      previousPosition: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      tangent: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      heading: 0,
      speed: 0,
      targetSpeed: 0,
      desiredSpeed: 0,
      acceleration: 0,
      braking: false,
      laneRef: null,
      laneKey: '',
      laneSample: null,
      s: 0,
      mapState: null,
      laneChange: null,
      blendOffset: null,
      indicator: 0,
      decisionTimer: 0,
      nearMissArmed: true,
      collisionCooldown: 0,
      playerContact: false,
      age: 0,
      spawnGrace: 0,
      userData: {},
    };
    mesh.userData.trafficVehicle = vehicle;
    this.pool.push(vehicle);
  }

  setMap(map) {
    this.map = map;
    this._laneCache = [];
    this._laneCacheTime = -Infinity;
    return this;
  }

  setDensity(density) {
    this.density = clamp(finite(density, 1), 0, 3);
    return this.density;
  }

  /** How often cars change lane. 0 disables lane changes, 1 is the default. */
  setLaneChangeRate(rate) {
    this.laneChangeRate = clamp(finite(rate, 1), 0, 3);
    return this.laneChangeRate;
  }

  /** Global free-flow speed multiplier for all traffic. */
  setSpeedFactor(factor) {
    this.speedFactor = clamp(finite(factor, 1), 0.4, 1.8);
    return this.speedFactor;
  }

  /**
   * Set the class mix. `truck` and `van` are fractions of all spawns (0..1);
   * cars take whatever is left. Existing vehicles keep their class until they
   * despawn — only future spawns follow the new mix.
   */
  setTypeMix({ truck, van, car } = {}) {
    this.typeWeights = this._normalizeTypeWeights({
      truck: finite(truck, this.typeWeights.truck),
      van: finite(van, this.typeWeights.van),
      car: finite(car, undefined),
    });
    return this.typeWeights;
  }

  _removeVehicleCustomModel(vehicle) {
    const ud = vehicle?.mesh?.userData;
    if (!ud) return;
    ud.customModel?.removeFromParent?.();
    ud.customModel = null;
    ud.customModelType = null;
    if (ud.body) ud.body.visible = true;
  }

  _disposeCustomModelTemplates() {
    const geometries = new Set();
    const materials = new Set();
    for (const template of Object.values(this._customModelTemplates || {})) {
      template?.traverse?.((object) => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
          if (material) materials.add(material);
        }
      });
    }
    for (const geometry of geometries) geometry.dispose?.();
    // Textures are cached by the shared custom-asset module and can also be
    // used by world objects, so retire materials without disposing their maps.
    for (const material of materials) material.dispose?.();
    this._customModelTemplates = {};
  }

  _syncVehicleCustomModel(vehicle) {
    const typeId = vehicle?.type?.id || 'car';
    const template = this._customModelTemplates[typeId] || null;
    const ud = vehicle?.mesh?.userData;
    if (!ud) return;
    if (ud.customModel && ud.customModelType === typeId && ud.customModelTemplate === template) return;
    this._removeVehicleCustomModel(vehicle);
    ud.customModelTemplate = template;
    if (!template) return;
    const model = template.clone(true);
    model.name = `traffic-custom-${typeId}`;
    model.userData.hesiTrafficCarModel = typeId;
    ud.customModel = model;
    ud.customModelType = typeId;
    ud.body.visible = false;
    vehicle.mesh.add(model);
  }

  /**
   * Applies Modeler car replacements and behavior to the complete pool.
   * Existing active vehicles are rebuilt in place, preserving route, position,
   * speed and lane state; future spawns use the same updated type records.
   */
  applyModelOverrides(document, { resolveAssetPart = () => null } = {}) {
    if (this._disposed) return { models: 0, settings: 0, active: 0 };
    for (const vehicle of this.pool) this._removeVehicleCustomModel(vehicle);
    this._disposeCustomModelTemplates();

    this._customModelDocument = document || null;
    this._customModelResolver = resolveAssetPart;
    const nextTypes = {};
    let modelCount = 0;
    let settingsCount = 0;
    for (const base of VEHICLE_TYPES) {
      const type = effectiveTrafficCarType(base.id, document);
      nextTypes[type.id] = type;
      const entry = carModelEntry(document, carModelTarget('traffic', type.id));
      if (Object.keys(entry?.settings || {}).length) settingsCount += 1;
      const definition = entry?.assetId ? document?.assets?.[entry.assetId] : null;
      if (!definition) continue;
      const template = buildCustomAssetGroup(definition, document?.textures || {}, { resolveAssetPart });
      if (!template.children.length) continue;
      template.name = `traffic-template-${type.id}`;
      template.updateMatrixWorld(true);
      this._customModelTemplates[type.id] = template;
      modelCount += 1;
    }

    const oldGeometries = this._typeGeometries;
    this.vehicleTypes = nextTypes;
    this._typeGeometries = Object.fromEntries(
      Object.values(this.vehicleTypes).map((type) => [type.id, buildVehicleGeometry(type)]),
    );
    this.typeWeights = this._normalizeTypeWeights({
      car: this.vehicleTypes.car.weight,
      van: this.vehicleTypes.van.weight,
      truck: this.vehicleTypes.truck.weight,
    });

    for (const vehicle of this.pool) {
      const nextType = this.vehicleTypes[vehicle.type?.id] || this.vehicleTypes.car;
      const color = vehicle.mesh.userData.body.material.color.getHex();
      this._applyVehicleType(vehicle, nextType, color);
      vehicle.targetSpeed = clamp(
        finite(vehicle.targetSpeed, nextType.minSpeed),
        nextType.minSpeed * 0.72,
        nextType.maxSpeed * 1.15,
      );
    }
    for (const set of Object.values(oldGeometries || {})) {
      for (const geometry of Object.values(set)) geometry.dispose?.();
    }
    return { models: modelCount, settings: settingsCount, active: this.active.length };
  }

  _normalizeTypeWeights(weights = {}) {
    const truck = clamp(finite(weights.truck, this.vehicleTypes.truck.weight), 0, 0.7);
    const van = clamp(finite(weights.van, this.vehicleTypes.van.weight), 0, 0.8);
    // If a car weight is supplied honour it, otherwise cars are the remainder so
    // the three always add up to a full population.
    const car = Number.isFinite(weights.car) ? Math.max(0, weights.car) : Math.max(0.05, 1 - truck - van);
    return { car, van, truck };
  }

  _chooseVehicleType() {
    const w = this.typeWeights;
    const total = Math.max(EPSILON, w.car + w.van + w.truck);
    let roll = this.random() * total;
    if ((roll -= w.truck) < 0) return this.vehicleTypes.truck;
    if ((roll -= w.van) < 0) return this.vehicleTypes.van;
    return this.vehicleTypes.car;
  }

  _resolveType(type) {
    if (!type) return null;
    if (typeof type === 'string') return this.vehicleTypes[type] ?? null;
    if (type.id && this.vehicleTypes[type.id]) return this.vehicleTypes[type.id];
    return null;
  }

  /**
   * A per-vehicle "driver": small random offsets to cruising speed, following
   * distance, acceleration, lane-change appetite and patience. This is what
   * stops every car of a class behaving identically and makes the flow read as
   * real traffic rather than a synced train.
   */
  _makeDriver(type) {
    const r = this.random;
    return {
      speedMul: THREE.MathUtils.lerp(0.9, 1.12, r()),
      gapMul: THREE.MathUtils.lerp(0.82, 1.4, r()),
      accelMul: THREE.MathUtils.lerp(0.85, 1.15, r()),
      laneChangeBias: THREE.MathUtils.lerp(0.55, 1.5, r()) * (type.id === 'truck' ? 0.55 : 1),
      patience: THREE.MathUtils.lerp(0.35, 1, r()),
      wanderPhase: r() * Math.PI * 2,
      wanderAmp: THREE.MathUtils.lerp(0.02, 0.06, r()),
    };
  }

  /**
   * Weighted lane pick for a class: a soft Gaussian around the class's home
   * lane (laneBias), with jitter so a run of same-class cars doesn't stack into
   * an identical column. Lane 0 is the fast lane by the median; the highest
   * index is the slow outer (left) lane where tir belong.
   */
  _pickLaneForType(type, laneCount) {
    const count = Math.max(1, Math.floor(laneCount || 1));
    if (count <= 1) return 0;
    const maxIndex = count - 1;
    const target = (type.laneBias ?? 0.5) * maxIndex;
    const spread = Math.max(0.4, type.laneSpread ?? 0.6) * maxIndex;
    let bestIndex = 0;
    let bestWeight = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const d = (i - target) / (spread || 1);
      // Additive jitter: negligible next to a tight class's peak (tir almost
      // always land outermost) but decisive when a wide class's lanes tie
      // (cars spread across the carriageway instead of stacking one column).
      const weight = Math.exp(-0.5 * d * d) + 0.18 * this.random();
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  _laneCountFor(vehicle) {
    const ref = vehicle.laneRef;
    let count = ref?.laneCount ?? ref?.route?.lanes;
    if (!Number.isFinite(count)) {
      try {
        count = this.map?.getRoute?.(ref?.routeId ?? ref?.route?.id)?.lanes;
      } catch {
        count = null;
      }
    }
    return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  }

  /** Swap a pooled vehicle onto a class and colour, updating its collision box. */
  _applyVehicleType(vehicle, type, color) {
    const geoms = this._typeGeometries[type.id] ?? this._typeGeometries.car;
    const ud = vehicle.mesh.userData;
    ud.body.geometry = geoms.body;
    ud.body.material.color.set(color);
    ud.body.material.emissive.set(color);
    ud.lamps.geometry = geoms.lamps;
    ud.taillamps[0].geometry = geoms.brake;
    ud.taillamps[0].material = this._sharedMaterials.taillamp;
    ud.indicators[0].meshes[0].geometry = geoms.blinkerL;
    ud.indicators[1].meshes[0].geometry = geoms.blinkerR;
    ud.indicators[0].meshes[0].visible = false;
    ud.indicators[1].meshes[0].visible = false;
    vehicle.type = type;
    vehicle.width = type.width;
    vehicle.length = type.length;
    vehicle.height = type.height;
    this._syncVehicleCustomModel(vehicle);
  }

  update(dt, playerState, context = {}) {
    if (this._disposed || !Number.isFinite(dt) || dt <= 0) return [];
    const frameDt = Math.min(dt, 0.12);
    this.time += frameDt;
    this._events = [];
    const player = this._normalizePlayer(playerState);
    if (!player) return this._events;
    if (!this._hasPreviousPlayer) {
      this._previousPlayerPosition.copy(player.position);
      this._hasPreviousPlayer = true;
    }

    const target = Math.min(this.options.maxVehicles, Math.round(this.options.targetVehicles * this.density));
    let spawnBudget = this.options.maxSpawnPerFrame;
    while (this.active.length < target && spawnBudget > 0) {
      // Decide the class first so the spawn can bias it toward the right lane
      // (tir to the outer lanes, cars anywhere).
      const type = this._chooseVehicleType();
      const candidate = this._requestSpawn(player, context, type);
      if (!candidate || !this.spawnVehicle(candidate, { type })) break;
      spawnBudget -= 1;
    }

    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const vehicle = this.active[i];
      vehicle.previousPosition.copy(vehicle.position);
      vehicle.collisionCooldown = Math.max(0, vehicle.collisionCooldown - frameDt);
      vehicle.spawnGrace = Math.max(0, vehicle.spawnGrace - frameDt);
      vehicle.age += frameDt;
      if (!this._updateVehicle(vehicle, frameDt, player, context)) {
        this._deactivate(vehicle, 'route-end');
        continue;
      }
      const horizontalDistance = Math.hypot(vehicle.position.x - player.position.x, vehicle.position.z - player.position.z);
      if (horizontalDistance > this.options.despawnRadius || Math.abs(vehicle.position.y - player.position.y) > 25) {
        this._deactivate(vehicle, 'distance');
        continue;
      }
      this._checkPlayerInteraction(vehicle, player, playerState, context);
    }

    // Cull toward the target no more than a few vehicles per frame: a sudden
    // density drop (admin slider, mode change) previously deactivated the
    // whole surplus in one frame with an O(n) furthest-scan per removal,
    // which is a visible hitch. Spreading it over frames is invisible.
    let cullBudget = 3;
    while (this.active.length > target && cullBudget > 0) {
      let furthest = null;
      let furthestDistance = -1;
      for (const vehicle of this.active) {
        const distance = vehicle.position.distanceToSquared(player.position);
        if (distance > furthestDistance) {
          furthestDistance = distance;
          furthest = vehicle;
        }
      }
      if (!furthest) break;
      this._deactivate(furthest, 'density');
      cullBudget -= 1;
    }

    this._previousPlayerPosition.copy(player.position);
    for (const event of this._events) this._eventQueue.push(event);
    return this._events.slice();
  }

  _normalizePlayer(source) {
    if (!source) return null;
    const state = source.state ?? (typeof source.getState === 'function' ? source.getState() : source);
    if (!state?.position && !source.position) return null;
    // Reused scratch object: this runs every frame and previously allocated
    // ~6 vectors + an object per call (steady GC pressure while driving).
    // Consumers never retain it — events clone any vector they keep.
    const player = this._playerScratch ?? (this._playerScratch = {
      source: null,
      state: null,
      position: new THREE.Vector3(),
      previousPosition: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      speed: 0,
      heading: 0,
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      width: 1.78,
      length: 4.35,
      height: 1.45,
    });
    copyVector3(player.position, state.position ?? source.position);
    copyVector3(player.velocity, state.velocity ?? source.velocity);
    const heading = finite(state.heading ?? state.yaw ?? source.heading, source.mesh?.rotation?.y ?? 0);
    if (state.previousPosition) copyVector3(player.previousPosition, state.previousPosition);
    else player.previousPosition.copy(this._previousPlayerPosition);
    const spec = state.spec ?? source.spec ?? {};
    player.source = source;
    player.state = state;
    player.speed = finite(state.speed, Math.hypot(player.velocity.x, player.velocity.z));
    player.heading = heading;
    player.forward.set(Math.sin(heading), 0, Math.cos(heading));
    player.right.set(Math.cos(heading), 0, -Math.sin(heading));
    player.width = finite(state.width ?? spec.width, 1.78);
    player.length = finite(state.length ?? spec.length, 4.35);
    player.height = finite(state.height ?? spec.height, 1.45);
    return player;
  }

  spawnVehicle(spawn, overrides = {}) {
    const vehicle = this.pool.find((item) => !item.active);
    if (!vehicle) return null;
    const normalized = this._normalizeSpawn(spawn);
    if (!normalized) return null;
    const nearestPlayerDistance = finite(spawn.playerDistance, Infinity);
    if (nearestPlayerDistance < this.options.minSpawnDistance) return null;
    for (const other of this.active) {
      if (other.position.distanceToSquared(normalized.position) < 14 * 14) return null;
    }

    // Assign the class (and an individual colour) to this pooled slot.
    const type = this._resolveType(overrides.type ?? spawn.type) ?? this._chooseVehicleType();
    const palette = COLORS_BY_ID[type.id] ?? CAR_COLORS;
    const color = overrides.color ?? spawn.color ?? palette[Math.floor(this.random() * palette.length)];
    this._applyVehicleType(vehicle, type, color);
    vehicle.driver = this._makeDriver(type);

    vehicle.active = true;
    vehicle.mesh.visible = true;
    vehicle.position.copy(normalized.position);
    vehicle.previousPosition.copy(normalized.position);
    vehicle.tangent.copy(normalized.tangent);
    vehicle.right.copy(normalized.right);
    vehicle.heading = Math.atan2(vehicle.tangent.x, vehicle.tangent.z);
    vehicle.mesh.rotation.set(0, vehicle.heading, 0);
    vehicle.laneRef = normalized.laneRef;
    vehicle.laneKey = this._laneKey(normalized.laneRef, normalized);
    vehicle.laneSample = normalized;
    vehicle.s = normalized.s;
    vehicle.mapState = normalized.mapState ?? spawn.mapState ?? null;
    const limit = speedToMps(normalized.speedLimit, NaN);
    // Each driver has a personal cruising preference; that is the base target,
    // then the highway limit caps it and speedFactor scales the whole flow.
    const randomSpeed = THREE.MathUtils.lerp(vehicle.type.minSpeed, vehicle.type.maxSpeed, this.random()) * vehicle.driver.speedMul;
    vehicle.targetSpeed = clamp(finite(overrides.speed ?? spawn.speed, randomSpeed), vehicle.type.minSpeed * 0.72, vehicle.type.maxSpeed * 1.15);
    if (Number.isFinite(limit)) vehicle.targetSpeed = Math.min(vehicle.targetSpeed, limit * THREE.MathUtils.lerp(0.82, 1.04, this.random()));
    vehicle.desiredSpeed = vehicle.targetSpeed * this.speedFactor;
    vehicle.speed = clamp(finite(overrides.initialSpeed ?? spawn.initialSpeed, vehicle.desiredSpeed * THREE.MathUtils.lerp(0.86, 1, this.random())), 0, vehicle.desiredSpeed);
    vehicle.velocity.copy(vehicle.tangent).multiplyScalar(vehicle.speed);
    vehicle.acceleration = 0;
    vehicle.braking = false;
    vehicle.laneChange = null;
    vehicle.blendOffset = null;
    vehicle.indicator = 0;
    // First lane-change decision is well after spawn so cars settle first.
    vehicle.decisionTimer = THREE.MathUtils.lerp(8, 20, this.random());
    vehicle.nearMissArmed = true;
    vehicle.collisionCooldown = 0;
    vehicle.playerContact = false;
    vehicle.age = 0;
    vehicle.spawnGrace = 0.65;
    vehicle.userData = { ...overrides.userData, ...spawn.userData };
    this._setLights(vehicle, false);
    this.active.push(vehicle);
    this.options.onSpawn?.(vehicle);
    return vehicle;
  }

  _normalizeSpawn(spawn) {
    if (!spawn) return null;
    if (Array.isArray(spawn)) spawn = spawn[Math.floor(this.random() * spawn.length)];
    if (!spawn) return null;
    const laneRef = spawn.laneRef
      ?? spawn.routeRef
      ?? (spawn.lane && typeof spawn.lane === 'object' ? spawn.lane : null)
      ?? spawn.route
      ?? spawn.path
      ?? this._deriveLaneRef(spawn);
    const s = finite(spawn.s ?? spawn.distance ?? spawn.offset, 0);
    let sample = spawn.position || spawn.point ? spawn : null;
    if (!sample && laneRef) sample = this._sampleLane(laneRef, s);
    if (!sample && spawn.ref) sample = this._sampleLane(spawn.ref, s);
    if (!sample) return null;
    return this._normalizeLaneSample(sample, laneRef ?? sample.laneRef ?? sample.lane, s);
  }

  /**
   * True when a candidate spawn sits in front of the player and closer than the
   * front threshold — i.e. it would visibly pop into view. Behind the player
   * (dot <= 0) is always fine because it is off-screen.
   */
  _spawnInView(position, player) {
    if (!player?.forward || this.options.frontSpawnDistance <= 0) return false;
    const dx = position.x - player.position.x;
    const dz = position.z - player.position.z;
    const ahead = dx * player.forward.x + dz * player.forward.z;
    if (ahead <= 0) return false;
    return Math.hypot(dx, dz) < this.options.frontSpawnDistance;
  }

  _requestSpawn(player, context, type = null) {
    const request = {
      playerPosition: player.position,
      playerVelocity: player.velocity,
      minDistance: this.options.minSpawnDistance,
      maxDistance: this.options.spawnRadius,
      activeVehicles: this.active,
      random: this.random,
      context,
    };

    // Prefer the player's current corridor when the map can project roads.
    // This keeps traffic dense even on a very long multi-route network.
    try {
      const road = context.roadInfo ?? this.map?.getRoadInfo?.(player.position);
      if (road?.routeId != null && !road.inServiceArea) {
        const route = this.map?.getRoute?.(road.routeId);
        const laneCount = Math.max(1, Math.floor(route?.lanes ?? road.lanes ?? 1));
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const direction = route?.bidirectional && this.random() < 0.18 ? -(road.direction ?? 1) : (road.direction ?? 1);
          // Bias the lane by class: tir to the outer (slow) lanes, cars anywhere.
          const laneIndex = type ? this._pickLaneForType(type, laneCount) : Math.floor(this.random() * laneCount);
          const offset = THREE.MathUtils.lerp(this.options.minSpawnDistance, this.options.spawnRadius * 0.88, this.random()) * (this.random() < 0.42 ? -1 : 1);
          const laneRef = {
            routeId: road.routeId,
            laneIndex,
            direction,
            length: route?.length,
            closed: route?.closed,
            laneCount,
          };
          const sample = this._sampleLane(laneRef, finite(road.distance, 0) + offset * direction);
          if (!sample) continue;
          const distance = Math.hypot(sample.position.x - player.position.x, sample.position.z - player.position.z);
          if (distance >= this.options.minSpawnDistance && distance <= this.options.spawnRadius && !this._spawnInView(sample.position, player)) {
            return { ...sample, laneRef, playerDistance: distance };
          }
        }
      }
    } catch (error) {
      this._adapterWarning('getRoadInfo', error);
    }

    for (const name of ['getTrafficSpawn', 'getTrafficSpawnPoint', 'randomTrafficSpawn', 'getRandomTrafficSpawn']) {
      const fn = this.map?.[name];
      if (typeof fn !== 'function') continue;
      try {
        const callStyles = name === 'getTrafficSpawn'
          ? [[this.random], [request], [player.position, this.options.minSpawnDistance, this.options.spawnRadius, this.random]]
          : [[request], [player.position, this.options.minSpawnDistance, this.options.spawnRadius, this.random], [this.random]];
        for (const args of callStyles) {
          let result;
          try {
            result = fn.call(this.map, ...args);
          } catch {
            continue;
          }
          if (Array.isArray(result)) result = result[Math.floor(this.random() * result.length)];
          const normalized = this._normalizeSpawn(result);
          if (normalized) {
            const distance = Math.hypot(normalized.position.x - player.position.x, normalized.position.z - player.position.z);
            if (distance >= this.options.minSpawnDistance && distance <= this.options.spawnRadius && !this._spawnInView(normalized.position, player)) {
              return { ...result, ...normalized, playerDistance: distance };
            }
          }
        }
      } catch (error) {
        this._adapterWarning(name, error);
      }
    }

    const lanes = this._getLaneCatalog(player);
    if (!lanes.length) return null;
    let best = null;
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const laneRef = lanes[Math.floor(this.random() * lanes.length)];
      const length = this._laneLength(laneRef);
      let s = this.random() * Math.max(1, length || 1);
      const projection = this._projectToLane(player.position, laneRef);
      if (projection && Number.isFinite(projection.s ?? projection.distance)) {
        const baseS = projection.s ?? projection.distance;
        const sign = this.random() < 0.46 ? -1 : 1;
        s = baseS + sign * THREE.MathUtils.lerp(this.options.minSpawnDistance, this.options.spawnRadius * 0.82, this.random());
      }
      if (length > 0 && this._laneClosed(laneRef)) s = THREE.MathUtils.euclideanModulo(s, length);
      const sample = this._sampleLane(laneRef, s);
      if (!sample) continue;
      const distance = Math.hypot(sample.position.x - player.position.x, sample.position.z - player.position.z);
      if (distance < this.options.minSpawnDistance || distance > this.options.spawnRadius) continue;
      if (this._spawnInView(sample.position, player)) continue;
      const candidate = { ...sample, laneRef, s, playerDistance: distance };
      if (!best || Math.abs(distance - this.options.spawnRadius * 0.5) < Math.abs(best.playerDistance - this.options.spawnRadius * 0.5)) best = candidate;
    }
    return best;
  }

  _getLaneCatalog(player) {
    if (this.time - this._laneCacheTime < 4 && this._laneCache.length) return this._laneCache;
    let lanes = null;
    for (const name of ['getTrafficLanes', 'getNearbyTrafficLanes', 'getLanes']) {
      const fn = this.map?.[name];
      if (typeof fn !== 'function') continue;
      try {
        lanes = fn.length <= 1 ? fn.call(this.map, player.position) : fn.call(this.map, player.position, this.options.spawnRadius);
        if (lanes?.length) break;
      } catch (error) {
        this._adapterWarning(name, error);
      }
    }
    lanes ??= this.map?.trafficLanes ?? this.map?.lanes ?? this.map?.trafficPaths ?? null;
    if (!lanes && Array.isArray(this.map?.routes)) {
      lanes = [];
      for (const route of this.map.routes) {
        if (Array.isArray(route.lanes)) {
          for (let index = 0; index < route.lanes.length; index += 1) {
            const lane = route.lanes[index];
            lanes.push(typeof lane === 'object' ? { route, routeId: route.id, laneIndex: index, ...lane } : { route, routeId: route.id, laneIndex: index });
          }
        } else {
          const count = Math.max(1, Math.floor(route.laneCount ?? route.lanes ?? 1));
          for (let laneIndex = 0; laneIndex < count; laneIndex += 1) lanes.push({ route, routeId: route.id, laneIndex });
        }
      }
    }
    this._laneCache = Array.isArray(lanes) ? lanes.flat().filter(Boolean) : [];
    this._laneCacheTime = this.time;
    return this._laneCache;
  }

  _projectToLane(position, laneRef) {
    for (const name of ['projectToTrafficLane', 'projectToLane', 'nearestPointOnLane']) {
      const fn = this.map?.[name];
      if (typeof fn !== 'function') continue;
      try {
        return fn.length <= 1
          ? fn.call(this.map, { position, lane: laneRef })
          : fn.call(this.map, position, laneRef);
      } catch (error) {
        this._adapterWarning(name, error);
      }
    }
    return null;
  }

  _sampleLane(laneRef, s) {
    if (!laneRef) return null;
    let sample = null;
    for (const name of ['sampleTrafficLane', 'sampleLane', 'getLaneSample']) {
      const fn = this.map?.[name];
      if (typeof fn !== 'function') continue;
      try {
        const routeId = laneRef.routeId ?? laneRef.route?.id ?? laneRef.id;
        const laneIndex = laneRef.laneIndex ?? laneRef.index ?? laneRef.lane ?? 0;
        const direction = laneRef.direction ?? 1;
        if (routeId != null && name === 'sampleLane') sample = fn.call(this.map, routeId, s, laneIndex, direction);
        else if (routeId != null && name === 'getLaneSample') sample = fn.call(this.map, routeId, laneIndex, s, direction);
        else if (fn.length >= 3 && routeId != null) sample = fn.call(this.map, routeId, laneIndex, s, direction);
        else if (fn.length >= 2) sample = fn.call(this.map, laneRef, s);
        else sample = fn.call(this.map, { lane: laneRef, laneRef, s, distance: s });
        if (sample) break;
      } catch (error) {
        this._adapterWarning(name, error);
      }
    }

    if (!sample && typeof laneRef.sample === 'function') sample = laneRef.sample(s);
    if (!sample && typeof laneRef.getPointAt === 'function') sample = this._sampleCurve(laneRef, laneRef, s);
    const curve = laneRef.curve ?? laneRef.path ?? laneRef.centerline ?? laneRef.route?.curve ?? laneRef.route?.path;
    if (!sample && curve?.getPointAt) sample = this._sampleCurve(curve, laneRef, s);
    if (!sample) return null;
    return this._normalizeLaneSample(sample, laneRef, s);
  }

  _sampleCurve(curve, laneRef, s) {
    const length = finite(laneRef.length, typeof curve.getLength === 'function' ? curve.getLength() : 1);
    const closed = this._laneClosed(laneRef);
    let distance = s;
    if (closed) distance = THREE.MathUtils.euclideanModulo(distance, Math.max(EPSILON, length));
    if (!closed && (distance < 0 || distance > length)) return null;
    const u = clamp(distance / Math.max(EPSILON, length), 0, 1);
    return {
      position: curve.getPointAt(u),
      tangent: curve.getTangentAt ? curve.getTangentAt(u) : null,
      s: distance,
      length,
      closed,
      laneRef,
      laneWidth: laneRef.laneWidth ?? laneRef.width,
      speedLimit: laneRef.speedLimit,
    };
  }

  _normalizeLaneSample(sample, laneRef, requestedS) {
    if (!sample) return null;
    const positionSource = sample.position ?? sample.point ?? sample.center ?? (sample.isVector3 ? sample : null);
    if (!positionSource) return null;
    const position = asVector3(positionSource);
    let tangent = asVector3(sample.tangent ?? sample.forward ?? sample.direction, new THREE.Vector3(0, 0, 1));
    tangent.y = finite(tangent.y, 0);
    if (tangent.lengthSq() < EPSILON) tangent.set(0, 0, 1);
    tangent.normalize();
    let right = asVector3(sample.right, new THREE.Vector3(tangent.z, 0, -tangent.x));
    if (right.lengthSq() < EPSILON) right.set(tangent.z, 0, -tangent.x);
    right.normalize();
    const resolvedLaneRef = this._deriveLaneRef(sample, laneRef);
    return {
      ...sample,
      position,
      tangent,
      right,
      up: asVector3(sample.up ?? sample.normal, UP).normalize(),
      laneRef: resolvedLaneRef,
      s: finite(sample.s ?? sample.distance ?? sample.offset, requestedS),
      length: finite(sample.length ?? sample.laneLength, this._laneLength(resolvedLaneRef)),
      laneWidth: finite(sample.laneWidth ?? sample.width, finite(resolvedLaneRef?.laneWidth ?? resolvedLaneRef?.width, 3.45)),
      speedLimit: sample.speedLimit ?? resolvedLaneRef?.speedLimit,
      closed: sample.closed ?? this._laneClosed(resolvedLaneRef),
      mapState: sample.mapState ?? sample.state,
    };
  }

  _deriveLaneRef(sample, fallback = null) {
    if (sample?.laneRef && typeof sample.laneRef === 'object') return sample.laneRef;
    const sampleRouteId = sample?.routeId ?? sample?.route?.id;
    const fallbackRouteId = fallback?.routeId ?? fallback?.route?.id ?? (typeof fallback === 'string' ? fallback : null);
    if (fallback && typeof fallback === 'object' && (sampleRouteId == null || sampleRouteId === fallbackRouteId)) return fallback;
    const routeId = sampleRouteId ?? fallbackRouteId;
    if (routeId == null) return fallback;
    let route = null;
    try {
      route = this.map?.getRoute?.(routeId) ?? null;
    } catch {
      route = null;
    }
    return {
      routeId,
      laneIndex: finite(sample?.laneIndex ?? sample?.lane, 0),
      direction: finite(sample?.direction, 1),
      length: finite(sample?.length, route?.length),
      closed: sample?.closed ?? route?.closed ?? false,
      laneCount: finite(sample?.laneCount, route?.lanes),
      laneWidth: sample?.laneWidth ?? route?.laneWidth,
      speedLimit: sample?.speedLimit ?? route?.speedLimit,
    };
  }

  _laneLength(laneRef) {
    if (!laneRef) return 0;
    if (Number.isFinite(laneRef.length)) return laneRef.length;
    const curve = laneRef.curve ?? laneRef.path ?? laneRef.centerline ?? laneRef.route?.curve ?? laneRef.route?.path ?? (laneRef.getLength ? laneRef : null);
    return typeof curve?.getLength === 'function' ? curve.getLength() : 0;
  }

  _laneClosed(laneRef) {
    return Boolean(laneRef?.closed ?? laneRef?.loop ?? laneRef?.route?.closed ?? laneRef?.route?.loop);
  }

  _laneKey(laneRef, sample = null) {
    if (typeof laneRef === 'string' || typeof laneRef === 'number') return String(laneRef);
    const route = laneRef?.routeId ?? laneRef?.route?.id ?? sample?.routeId ?? laneRef?.id;
    const lane = laneRef?.laneIndex ?? laneRef?.index ?? sample?.laneIndex ?? laneRef?.lane;
    const direction = laneRef?.direction ?? sample?.direction ?? 1;
    if (route != null || lane != null) return `${route ?? 'route'}:${lane ?? 0}:${direction >= 0 ? '+' : '-'}`;
    if (laneRef && typeof laneRef === 'object') {
      if (!this._objectRefIds.has(laneRef)) this._objectRefIds.set(laneRef, this._nextRefId++);
      return `ref:${this._objectRefIds.get(laneRef)}`;
    }
    return 'lane:unknown';
  }

  _updateVehicle(vehicle, dt, player, context) {
    const driver = vehicle.driver || DEFAULT_DRIVER;
    const type = vehicle.type;
    // Free-flow target: personal cruise pref, scaled by the global speed factor,
    // with a slow sinusoidal wander so nobody holds a laser-constant speed.
    const wander = 1 + Math.sin(this.time * 0.13 + (driver.wanderPhase ?? 0)) * (driver.wanderAmp ?? 0);
    vehicle.desiredSpeed = clamp(
      vehicle.targetSpeed * this.speedFactor * wander,
      type.minSpeed * 0.55,
      type.maxSpeed * 1.15,
    );

    const leader = this._findLeader(vehicle, player);
    const accelCap = type.acceleration * (driver.accelMul ?? 1);
    let acceleration = accelCap * (1 - Math.pow(clamp(vehicle.speed / Math.max(1, vehicle.desiredSpeed), 0, 1.4), 4));
    if (leader) {
      // Intelligent-Driver-style gap term; gapMul makes tailgaters and cautious
      // drivers keep visibly different following distances.
      const closingSpeed = vehicle.speed - leader.speed;
      const desiredGap = 3.0 + vehicle.speed * 1.05 * (driver.gapMul ?? 1)
        + vehicle.speed * closingSpeed / (2 * Math.sqrt(accelCap * type.braking));
      acceleration -= accelCap * Math.pow(Math.max(0, desiredGap) / Math.max(1, leader.gap), 2);
    }
    acceleration = clamp(acceleration, -type.braking, accelCap);
    vehicle.acceleration = THREE.MathUtils.lerp(vehicle.acceleration, acceleration, 1 - Math.exp(-dt * 4.5));
    vehicle.speed = Math.max(0, vehicle.speed + vehicle.acceleration * dt);
    vehicle.braking = vehicle.acceleration < -0.65 || (leader && leader.gap < Math.max(8, vehicle.speed * 0.55));

    // Lane changes are deliberately rare: a check only every ~10-26 s, and even
    // then only a fraction commit. Blocked cars overtake in proportion to their
    // patience; free cars very occasionally drift toward their home lane.
    vehicle.decisionTimer -= dt;
    if (!vehicle.laneChange && vehicle.decisionTimer <= 0 && vehicle.age > 3) {
      const rate = this.laneChangeRate;
      if (rate > 0) {
        const blocked = leader && vehicle.speed < vehicle.desiredSpeed * 0.82 && leader.gap < 42;
        const overtakeChance = blocked ? 0.4 * (driver.patience ?? 0.6) : 0;
        const driftChance = 0.045;
        const chance = (overtakeChance + driftChance) * rate * (driver.laneChangeBias ?? 1);
        if (this.random() < chance) this._considerLaneChange(vehicle, leader, blocked);
      }
      vehicle.decisionTimer = THREE.MathUtils.lerp(10, 26, this.random()) / Math.max(0.4, this.laneChangeRate);
    }

    const distance = vehicle.speed * dt;
    let sample = this._advanceVehicleOnMap(vehicle, distance, context);
    if (!sample) return false;
    if (sample.transferred) {
      // Route hand-off (junction ramp/merge). Cancel any half-done lane change
      // (the old lane ref no longer applies) and blend out the lateral jump so
      // the car glides through the gore instead of popping across it.
      vehicle.laneChange = null;
      vehicle.indicator = 0;
      const jump = vehicle.position.distanceTo(sample.position);
      if (jump > 1.1 && jump < 60) {
        vehicle.blendOffset = vehicle.position.clone().sub(sample.position);
        vehicle.blendOffset.y = clamp(vehicle.blendOffset.y, -2.5, 2.5);
      }
    }
    if (vehicle.laneChange) {
      vehicle.laneChange.elapsed += dt;
      // Signal first, then drift. During the lead time the indicator blinks but
      // the car holds its lane; the crossing itself is a long smoothstep so it
      // eases over instead of snapping across.
      const lead = vehicle.laneChange.signalLead ?? 0;
      const activeElapsed = Math.max(0, vehicle.laneChange.elapsed - lead);
      const progress = clamp(activeElapsed / vehicle.laneChange.duration, 0, 1);
      const targetSample = this._sampleLane(vehicle.laneChange.to, vehicle.s);
      if (targetSample) {
        const blend = smoothstep01(progress);
        sample.position.lerp(targetSample.position, blend);
        sample.tangent.lerp(targetSample.tangent, blend).normalize();
        sample.right.set(sample.tangent.z, 0, -sample.tangent.x).normalize();
        if (progress >= 1) {
          vehicle.laneRef = vehicle.laneChange.to;
          vehicle.laneKey = this._laneKey(vehicle.laneRef, targetSample);
          vehicle.laneSample = targetSample;
          vehicle.laneChange = null;
          vehicle.indicator = 0;
        }
      } else {
        vehicle.laneChange = null;
        vehicle.indicator = 0;
      }
    }

    vehicle.position.copy(sample.position);
    if (vehicle.blendOffset) {
      vehicle.blendOffset.multiplyScalar(Math.exp(-dt * 2.6));
      if (vehicle.blendOffset.lengthSq() < 0.01) vehicle.blendOffset = null;
      else vehicle.position.add(vehicle.blendOffset);
    }
    vehicle.tangent.lerp(sample.tangent, 1 - Math.exp(-dt * 8)).normalize();
    vehicle.right.set(vehicle.tangent.z, 0, -vehicle.tangent.x).normalize();
    vehicle.heading = Math.atan2(vehicle.tangent.x, vehicle.tangent.z);
    vehicle.mesh.rotation.y = vehicle.heading;
    vehicle.velocity.subVectors(vehicle.position, vehicle.previousPosition).divideScalar(Math.max(EPSILON, dt));
    vehicle.laneSample = sample;
    this._setLights(vehicle, vehicle.braking);
    return true;
  }

  _advanceVehicleOnMap(vehicle, distance, context) {
    const advance = this.map?.advanceTraffic ?? this.map?.advanceTrafficVehicle;
    if (typeof advance === 'function') {
      const request = {
        vehicle,
        lane: vehicle.laneRef,
        laneRef: vehicle.laneRef,
        s: vehicle.s,
        distance,
        state: vehicle.mapState,
        context,
      };
      try {
        const result = advance.length <= 1
          ? advance.call(this.map, request)
          : advance.call(this.map, vehicle.laneRef, vehicle.s, distance, vehicle.mapState, vehicle);
        if (result) {
          if (result.laneRef || result.lane) {
            vehicle.laneRef = result.laneRef ?? result.lane;
            vehicle.laneKey = this._laneKey(vehicle.laneRef, result);
          }
          vehicle.s = finite(result.s ?? result.distance, vehicle.s + distance);
          vehicle.mapState = result.mapState ?? result.state ?? vehicle.mapState;
          const normalized = this._normalizeLaneSample(result, vehicle.laneRef, vehicle.s);
          if (normalized) return normalized;
        }
      } catch (error) {
        this._adapterWarning('advanceTraffic', error);
      }
    }

    const advanceAlongRoute = this.map?.advanceAlongRoute;
    const routeId = vehicle.laneRef?.routeId ?? vehicle.laneRef?.route?.id;
    if (typeof advanceAlongRoute === 'function' && routeId != null) {
      const lane = vehicle.laneRef?.laneIndex ?? vehicle.laneRef?.lane ?? 0;
      const direction = vehicle.laneRef?.direction ?? vehicle.laneSample?.direction ?? 1;
      const routeState = { routeId, distance: vehicle.s, lane, direction };
      try {
        const result = advanceAlongRoute.call(this.map, routeState, distance, lane, direction, vehicle.poolIndex % 3);
        if (result) {
          const nextRef = this._deriveLaneRef(result, vehicle.laneRef);
          const normalized = this._normalizeLaneSample(result, nextRef, result.distance ?? vehicle.s + distance);
          if (normalized) {
            vehicle.laneRef = normalized.laneRef;
            vehicle.laneKey = this._laneKey(vehicle.laneRef, normalized);
            vehicle.s = normalized.s;
            return normalized;
          }
        }
      } catch (error) {
        this._adapterWarning('advanceAlongRoute', error);
      }
    }

    vehicle.s += distance;
    let length = vehicle.laneSample?.length || this._laneLength(vehicle.laneRef);
    if (length > 0 && vehicle.s > length) {
      if (vehicle.laneSample?.closed || this._laneClosed(vehicle.laneRef)) vehicle.s = THREE.MathUtils.euclideanModulo(vehicle.s, length);
      else {
        const next = this._nextLane(vehicle);
        if (!next) return null;
        vehicle.s -= length;
        vehicle.laneRef = next;
        vehicle.laneKey = this._laneKey(next);
        length = this._laneLength(next);
      }
    }
    return this._sampleLane(vehicle.laneRef, vehicle.s);
  }

  _nextLane(vehicle) {
    for (const name of ['getNextTrafficLane', 'getNextLane', 'chooseTrafficConnection']) {
      const fn = this.map?.[name];
      if (typeof fn !== 'function') continue;
      try {
        const result = fn.length <= 1
          ? fn.call(this.map, { lane: vehicle.laneRef, vehicle, random: this.random })
          : fn.call(this.map, vehicle.laneRef, vehicle, this.random);
        if (Array.isArray(result)) return result[Math.floor(this.random() * result.length)] ?? null;
        if (result) return result;
      } catch (error) {
        this._adapterWarning(name, error);
      }
    }
    const next = vehicle.laneSample?.nextLanes ?? vehicle.laneRef?.nextLanes ?? vehicle.laneRef?.next;
    if (Array.isArray(next)) return next[Math.floor(this.random() * next.length)] ?? null;
    return next ?? null;
  }

  _findLeader(vehicle, player) {
    let best = null;
    const consider = (position, speed, length, sameDirection = true, source = null) => {
      const difference = new THREE.Vector3().subVectors(position, vehicle.position);
      const ahead = difference.dot(vehicle.tangent);
      if (ahead <= 0 || ahead > 90) return;
      const lateral = Math.abs(difference.dot(vehicle.right));
      if (lateral > vehicle.width * 0.55 + finite(source?.width, 1.8) * 0.55 + 0.65) return;
      if (!sameDirection) return;
      const gap = ahead - (vehicle.length + length) * 0.5;
      if (!best || gap < best.gap) best = { gap, speed, source };
    };
    for (const other of this.active) {
      if (other === vehicle || !other.active) continue;
      if (vehicle.laneKey !== other.laneKey && !vehicle.laneChange) continue;
      consider(other.position, other.speed, other.length, vehicle.tangent.dot(other.tangent) > 0.72, other);
    }
    consider(player.position, player.speed, player.length, vehicle.tangent.dot(player.forward) > 0.35, player);
    return best;
  }

  _considerLaneChange(vehicle, leader, urgent) {
    // When blocked, try the faster (lower-index, toward-median) lane first to
    // overtake. When free, prefer easing back toward this class's home lane so
    // tir settle outward and cars don't loiter in the fast lane forever.
    let preferred;
    if (urgent) {
      preferred = -1;
    } else {
      const idx = vehicle.laneRef?.laneIndex ?? vehicle.laneRef?.lane;
      if (Number.isFinite(idx)) {
        const maxIndex = Math.max(0, this._laneCountFor(vehicle) - 1);
        const home = (vehicle.type.laneBias ?? 0.5) * maxIndex;
        preferred = idx > home + 0.5 ? -1 : idx < home - 0.5 ? 1 : (this.random() < 0.5 ? -1 : 1);
      } else {
        preferred = this.random() < 0.5 ? -1 : 1;
      }
    }

    for (const direction of [preferred, -preferred]) {
      const adjacent = this._adjacentLane(vehicle, direction);
      if (!adjacent || !this._laneChangeSafe(vehicle, adjacent)) continue;
      // Signal to the side the car will actually drift toward (robust to any
      // lane-index convention) and cross slowly over 3.5-6 s.
      const targetSample = this._sampleLane(adjacent, vehicle.s);
      const lateralSign = targetSample
        ? (new THREE.Vector3().subVectors(targetSample.position, vehicle.position).dot(vehicle.right) >= 0 ? 1 : -1)
        : direction;
      vehicle.laneChange = {
        from: vehicle.laneRef,
        to: adjacent,
        direction,
        elapsed: 0,
        signalLead: THREE.MathUtils.lerp(0.7, 1.5, this.random()),
        duration: THREE.MathUtils.lerp(3.5, 6.0, this.random()),
        lateralSign,
      };
      vehicle.indicator = lateralSign;
      return true;
    }
    return false;
  }

  _adjacentLane(vehicle, direction) {
    for (const name of ['getAdjacentTrafficLane', 'getAdjacentLane']) {
      const fn = this.map?.[name];
      if (typeof fn !== 'function') continue;
      try {
        const result = fn.length <= 1
          ? fn.call(this.map, { lane: vehicle.laneRef, direction, s: vehicle.s, vehicle })
          : fn.call(this.map, vehicle.laneRef, direction, vehicle.s, vehicle);
        if (result && this._sampleLane(result, vehicle.s)) return result;
      } catch (error) {
        this._adapterWarning(name, error);
      }
    }
    const adjacent = direction < 0
      ? vehicle.laneSample?.leftLane ?? vehicle.laneRef?.leftLane
      : vehicle.laneSample?.rightLane ?? vehicle.laneRef?.rightLane;
    if (adjacent && this._sampleLane(adjacent, vehicle.s)) return adjacent;

    const index = vehicle.laneRef?.laneIndex ?? vehicle.laneRef?.index;
    if (Number.isFinite(index) && typeof vehicle.laneRef === 'object') {
      let laneCount = vehicle.laneRef.laneCount;
      if (!Number.isFinite(laneCount)) {
        try {
          laneCount = this.map?.getRoute?.(vehicle.laneRef.routeId)?.lanes;
        } catch {
          laneCount = null;
        }
      }
      if (index + direction < 0 || (Number.isFinite(laneCount) && index + direction >= laneCount)) return null;
      const candidate = { ...vehicle.laneRef, laneIndex: index + direction, index: index + direction };
      if (index + direction >= 0 && this._sampleLane(candidate, vehicle.s)) return candidate;
    }
    return null;
  }

  _laneChangeSafe(vehicle, targetLane) {
    const sample = this._sampleLane(targetLane, vehicle.s);
    if (!sample) return false;
    for (const other of this.active) {
      if (other === vehicle || !other.active) continue;
      const difference = new THREE.Vector3().subVectors(other.position, sample.position);
      const longitudinal = difference.dot(sample.tangent);
      const lateral = Math.abs(difference.dot(sample.right));
      if (lateral < (vehicle.width + other.width) * 0.55 + 0.5 && longitudinal > -Math.max(18, other.speed * 0.8) && longitudinal < Math.max(14, vehicle.speed * 0.55)) return false;
    }
    return true;
  }

  _setLights(vehicle, braking) {
    // ~1.5 Hz blink, like a real indicator, rather than a fast strobe.
    const blink = Math.floor(this.time * 3) % 2 === 0;
    for (const lamp of vehicle.mesh.userData.taillamps) {
      lamp.material = braking ? this._brakeMaterial() : this._sharedMaterials.taillamp;
    }
    for (const indicator of vehicle.mesh.userData.indicators) {
      const active = vehicle.indicator === indicator.side && blink;
      for (const mesh of indicator.meshes) mesh.visible = active;
    }
  }

  _brakeMaterial() {
    if (!this._sharedMaterials.brake) {
      const brake = new THREE.MeshBasicMaterial({ color: 0xff2520, toneMapped: false });
      // Mirror the tail-lamp's post-processing flags (the game applies
      // dithering to every scene material after construction). With equal
      // flags this material hits the tail-lamp's cached shader program;
      // otherwise the first braking car compiles a new program mid-drive.
      brake.dithering = this._sharedMaterials.taillamp.dithering;
      brake.fog = this._sharedMaterials.taillamp.fog;
      this._sharedMaterials.brake = brake;
    }
    return this._sharedMaterials.brake;
  }

  _checkPlayerInteraction(vehicle, player, originalPlayerSource, context = {}) {
    if (vehicle.spawnGrace > 0) return;
    if (context.playerGhost) {
      vehicle.playerContact = false;
      vehicle.nearMissArmed = true;
      return;
    }
    if (Math.abs(vehicle.position.y - player.position.y) > Math.max(2.4, (vehicle.height + player.height) * 0.65)) {
      vehicle.nearMissArmed = true;
      vehicle.playerContact = false;
      return;
    }
    const trafficForward = vehicle.tangent;
    const trafficRight = vehicle.right;
    const relativeStartWorld = player.previousPosition.clone().sub(vehicle.previousPosition);
    const relativeEndWorld = player.position.clone().sub(vehicle.position);
    const startX = relativeStartWorld.dot(trafficRight);
    const startZ = relativeStartWorld.dot(trafficForward);
    const endX = relativeEndWorld.dot(trafficRight);
    const endZ = relativeEndWorld.dot(trafficForward);
    const playerHalfX = rectangleSupport(trafficRight, player.right, player.forward, player.width * 0.5, player.length * 0.5);
    const playerHalfZ = rectangleSupport(trafficForward, player.right, player.forward, player.width * 0.5, player.length * 0.5);
    const halfX = vehicle.width * 0.5 + playerHalfX;
    const halfZ = vehicle.length * 0.5 + playerHalfZ;
    const hit = segmentVsAabb(startX, startZ, endX, endZ, halfX, halfZ);

    if (hit) {
      if (!vehicle.playerContact && vehicle.collisionCooldown <= 0) {
        const localNormal = hit.axis === 'x'
          ? new THREE.Vector3(hit.sign, 0, 0)
          : new THREE.Vector3(0, 0, hit.sign);
        const normal = trafficRight.clone().multiplyScalar(localNormal.x).addScaledVector(trafficForward, localNormal.z).normalize();
        const relativeVelocity = player.velocity.clone().sub(vehicle.velocity);
        const severity = Math.max(0.5, Math.abs(relativeVelocity.dot(normal)));
        const contactPosition = player.previousPosition.clone().lerp(player.position, hit.time);
        const event = {
          type: 'collision',
          vehicleId: vehicle.id,
          vehicle,
          time: this.time,
          timeOfImpact: hit.time,
          normal,
          position: contactPosition,
          otherVelocity: vehicle.velocity.clone(),
          relativeSpeed: relativeVelocity.length(),
          severity,
          intensity: clamp(severity / 12, 0.2, 2),
          kind: 'traffic',
        };
        this._events.push(event);
        vehicle.collisionCooldown = 0.8;
        vehicle.nearMissArmed = false;
        this.options.onCollision?.(event);
        if (this.options.autoResolvePlayerCollisions) {
          const target = typeof originalPlayerSource?.resolveCollision === 'function'
            ? originalPlayerSource
            : originalPlayerSource?.physics;
          target?.resolveCollision?.(event);
        }
      }
      vehicle.playerContact = true;
      return;
    }

    vehicle.playerContact = false;
    const closest = segmentClosestToOrigin(startX, startZ, endX, endZ);
    const separation = new THREE.Vector3()
      .addScaledVector(trafficRight, closest.x)
      .addScaledVector(trafficForward, closest.z);
    const direction = separation.lengthSq() > EPSILON ? separation.normalize() : trafficRight;
    const trafficSupport = rectangleSupport(direction, trafficRight, trafficForward, vehicle.width * 0.5, vehicle.length * 0.5);
    const playerSupport = rectangleSupport(direction, player.right, player.forward, player.width * 0.5, player.length * 0.5);
    const clearance = closest.distance - trafficSupport - playerSupport;
    const lateralAtClosest = Math.abs(closest.x);
    const overlapAlongside = Math.abs(closest.z) < (vehicle.length + player.length) * 0.5 + 0.8;
    const sideBySide = lateralAtClosest > (vehicle.width + player.width) * 0.27;
    const relativeMotion = Math.hypot(endX - startX, endZ - startZ);
    const relativeSpeed = player.velocity.clone().sub(vehicle.velocity).length();

    if (
      vehicle.nearMissArmed
      && player.speed >= this.options.nearMissMinSpeed
      && relativeSpeed > 5
      && relativeMotion > 0.08
      && overlapAlongside
      && sideBySide
      && clearance >= -0.08
      && clearance <= this.options.nearMissDistance
    ) {
      const closeness = clamp(1 - clearance / this.options.nearMissDistance, 0, 1);
      const speedKmh = player.speed * 3.6;
      const points = Math.round(90 + speedKmh * 1.25 + closeness * closeness * 420 + relativeSpeed * 4);
      const event = {
        type: 'nearMiss',
        vehicleId: vehicle.id,
        vehicle,
        time: this.time,
        clearance: Math.max(0, clearance),
        distance: Math.max(0, clearance),
        speed: player.speed,
        speedKmh,
        relativeSpeed,
        closeness,
        side: closest.x < 0 ? -1 : 1,
        sideName: closest.x < 0 ? 'left' : 'right',
        points,
        position: player.previousPosition.clone().lerp(player.position, closest.t),
      };
      this._events.push(event);
      vehicle.nearMissArmed = false;
      this.options.onNearMiss?.(event);
    } else if (clearance > this.options.nearMissDistance + 4.5) {
      vehicle.nearMissArmed = true;
    }
  }

  _deactivate(vehicle, reason) {
    if (!vehicle?.active) return;
    const index = this.active.indexOf(vehicle);
    if (index >= 0) this.active.splice(index, 1);
    vehicle.active = false;
    vehicle.mesh.visible = false;
    vehicle.velocity.set(0, 0, 0);
    vehicle.laneRef = null;
    vehicle.laneSample = null;
    vehicle.laneChange = null;
    vehicle.blendOffset = null;
    vehicle.indicator = 0;
    this.options.onDespawn?.(vehicle, reason);
  }

  despawnVehicle(vehicleOrId) {
    const vehicle = typeof vehicleOrId === 'string'
      ? this.active.find((item) => item.id === vehicleOrId)
      : vehicleOrId;
    if (!vehicle?.active) return false;
    this._deactivate(vehicle, 'manual');
    return true;
  }

  clear() {
    for (const vehicle of [...this.active]) this._deactivate(vehicle, 'clear');
    this._events.length = 0;
    this._eventQueue.length = 0;
    this._hasPreviousPlayer = false;
  }

  consumeEvents(type = null) {
    if (!type) {
      const events = this._eventQueue.splice(0);
      return events;
    }
    const matched = [];
    const kept = [];
    for (const event of this._eventQueue) (event.type === type ? matched : kept).push(event);
    this._eventQueue = kept;
    return matched;
  }

  getActiveVehicles() {
    return this.active;
  }

  get activeCount() {
    return this.active.length;
  }

  _adapterWarning(method, error) {
    const key = `warned:${method}`;
    if (this[key]) return;
    this[key] = true;
    console.warn(`Traffic map adapter method ${method} failed:`, error);
  }

  dispose() {
    if (this._disposed) return;
    this.clear();
    // Part geometries are shared per class, so dispose them once (below) rather
    // than per mesh; only the per-vehicle body material is owned individually.
    for (const vehicle of this.pool) {
      this._removeVehicleCustomModel(vehicle);
      this.scene.remove(vehicle.mesh);
      for (const material of vehicle.mesh.userData.ownedMaterials ?? []) material.dispose();
    }
    this._disposeCustomModelTemplates();
    for (const set of Object.values(this._typeGeometries)) {
      for (const geometry of Object.values(set)) geometry.dispose();
    }
    for (const material of Object.values(this._sharedMaterials)) material.dispose();
    this.pool.length = 0;
    this._disposed = true;
  }
}

export { VEHICLE_TYPES };
export default TrafficSystem;
