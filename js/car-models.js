import { PSX_CAR_MODELS } from './psx-car-pack.js?v=0f17c23a049e';
import { normalizeLocalLight } from './lighting-config.js?v=0f17c23a049e';

/**
 * Shared catalogue for every vehicle shape the Modeler can replace.
 *
 * Player targets name the exact PSXStyleCars model selected by the game.
 * Traffic targets name the three pooled runtime classes.  Keeping these
 * identifiers in one module prevents the editor, schema validator and traffic
 * runtime from quietly drifting apart.
 */
export const TRAFFIC_CAR_TYPES = Object.freeze([
  Object.freeze({
    id: 'car',
    label: 'Traffic car',
    description: 'Passenger cars already driving in the highway traffic pool',
    width: 1.84,
    length: 4.48,
    height: 1.46,
    minSpeed: 26,
    maxSpeed: 37,
    acceleration: 2.7,
    braking: 8,
    weight: 0.72,
    laneBias: 0.36,
    laneSpread: 1.05,
  }),
  Object.freeze({
    id: 'van',
    label: 'Traffic van',
    description: 'Vans and box trucks in the current highway traffic',
    width: 2.08,
    length: 5.85,
    height: 2.44,
    minSpeed: 22,
    maxSpeed: 30,
    acceleration: 1.75,
    braking: 6.4,
    weight: 0.19,
    laneBias: 0.66,
    laneSpread: 0.58,
  }),
  Object.freeze({
    id: 'truck',
    label: 'Traffic TIR',
    description: 'Articulated heavy trucks in the current highway traffic',
    width: 2.55,
    length: 15.6,
    height: 3.95,
    minSpeed: 19,
    maxSpeed: 26,
    acceleration: 1.05,
    braking: 5.2,
    weight: 0.09,
    laneBias: 1,
    laneSpread: 0.32,
  }),
]);

export const TRAFFIC_CAR_BY_ID = Object.freeze(
  Object.fromEntries(TRAFFIC_CAR_TYPES.map((entry) => [entry.id, entry])),
);

export const CAR_MODEL_GROUPS = Object.freeze([
  Object.freeze({
    group: 'Traffic',
    cars: TRAFFIC_CAR_TYPES.map((entry) => Object.freeze({
      scope: 'traffic',
      id: entry.id,
      label: entry.label,
      description: entry.description,
    })),
  }),
  Object.freeze({
    group: 'Player cars',
    cars: PSX_CAR_MODELS.map((entry) => Object.freeze({
      scope: 'player',
      id: entry.id,
      label: entry.label,
      description: `PSXStyleCars player model · ${entry.id}`,
      color: entry.color,
    })),
  }),
]);

const PLAYER_IDS = new Set(PSX_CAR_MODELS.map((entry) => entry.id));

export function carModelTarget(scope, id) {
  return `${scope}:${id}`;
}

export function parseCarModelTarget(target) {
  const match = String(target || '').match(/^(player|traffic):([A-Za-z0-9._-]+)$/);
  if (!match) return null;
  const [, scope, id] = match;
  if (scope === 'player' && !PLAYER_IDS.has(id)) return null;
  if (scope === 'traffic' && !TRAFFIC_CAR_BY_ID[id]) return null;
  return { scope, id };
}

export function isCarModelTarget(target) {
  return Boolean(parseCarModelTarget(target));
}

export function carModelMeta(target) {
  const parsed = parseCarModelTarget(target);
  if (!parsed) return null;
  if (parsed.scope === 'traffic') return TRAFFIC_CAR_BY_ID[parsed.id];
  return PSX_CAR_MODELS.find((entry) => entry.id === parsed.id) || null;
}

export function carModelEntry(document, target) {
  const entry = document?.carModels?.[target];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
}

export const CAR_HITBOX_SETTING_FIELDS = Object.freeze([
  Object.freeze({ key: 'width', label: 'Collision width', unit: 'm', min: 0.6, max: 5, step: 0.01 }),
  Object.freeze({ key: 'length', label: 'Collision length', unit: 'm', min: 1.5, max: 30, step: 0.01 }),
  Object.freeze({ key: 'height', label: 'Collision height', unit: 'm', min: 0.5, max: 8, step: 0.01 }),
  Object.freeze({ key: 'offsetX', label: 'Hitbox offset X', unit: 'm', min: -5, max: 5, step: 0.01, defaultValue: 0 }),
  Object.freeze({ key: 'offsetY', label: 'Hitbox offset Y', unit: 'm', min: -5, max: 5, step: 0.01, defaultValue: 0 }),
  Object.freeze({ key: 'offsetZ', label: 'Hitbox offset Z', unit: 'm', min: -5, max: 5, step: 0.01, defaultValue: 0 }),
]);

export const TRAFFIC_BEHAVIOR_SETTING_FIELDS = Object.freeze([
  Object.freeze({ key: 'minSpeedKmh', label: 'Minimum cruise', unit: 'km/h', min: 20, max: 220, step: 1 }),
  Object.freeze({ key: 'maxSpeedKmh', label: 'Maximum cruise', unit: 'km/h', min: 20, max: 260, step: 1 }),
  Object.freeze({ key: 'acceleration', label: 'Acceleration', unit: 'm/s²', min: 0.1, max: 15, step: 0.05 }),
  Object.freeze({ key: 'braking', label: 'Braking', unit: 'm/s²', min: 0.5, max: 25, step: 0.1 }),
  Object.freeze({ key: 'weight', label: 'Spawn weight', unit: '', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ key: 'laneBias', label: 'Lane bias', unit: '0 fast · 1 outer', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ key: 'laneSpread', label: 'Lane spread', unit: '', min: 0.05, max: 2, step: 0.01 }),
]);

export const TRAFFIC_CAR_SETTING_FIELDS = Object.freeze([
  ...CAR_HITBOX_SETTING_FIELDS,
  ...TRAFFIC_BEHAVIOR_SETTING_FIELDS,
]);

export const CAR_REAR_LIGHT_FIELDS = Object.freeze([
  Object.freeze({ key: 'width', label: 'Lens width', unit: 'm', min: 0.05, max: 1.5, step: 0.01 }),
  Object.freeze({ key: 'height', label: 'Lens height', unit: 'm', min: 0.04, max: 1, step: 0.01 }),
  Object.freeze({ key: 'depth', label: 'Lens depth', unit: 'm', min: 0.02, max: 0.5, step: 0.01 }),
  Object.freeze({ key: 'spacing', label: 'Light spacing', unit: 'm', min: 0.1, max: 4, step: 0.01 }),
  Object.freeze({ key: 'elevation', label: 'Height from road', unit: 'm', min: 0.1, max: 5, step: 0.01 }),
  Object.freeze({ key: 'inset', label: 'Inset from rear', unit: 'm', min: -0.5, max: 2, step: 0.01 }),
  Object.freeze({ key: 'offsetX', label: 'Pair offset X', unit: 'm', min: -5, max: 5, step: 0.01, defaultValue: 0 }),
  Object.freeze({ key: 'offsetY', label: 'Pair offset Y', unit: 'm', min: -5, max: 5, step: 0.01, defaultValue: 0 }),
  Object.freeze({ key: 'offsetZ', label: 'Pair offset Z', unit: 'm', min: -5, max: 5, step: 0.01, defaultValue: 0 }),
]);

// Headlights share the same photometric controls as the editor's Soft Custom
// Light, plus a small lens/placement section tied to the selected car. Keeping
// these ranges in the shared car schema makes the Modeler preview and the live
// player SpotLight consume one authoritative record.
export const CAR_HEADLIGHT_FIELDS = Object.freeze([
  Object.freeze({ key: 'width', label: 'Lens width', unit: 'm', min: 0.05, max: 1.5, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'height', label: 'Lens height', unit: 'm', min: 0.04, max: 1, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'depth', label: 'Lens depth', unit: 'm', min: 0.02, max: 0.5, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'spacing', label: 'Light spacing', unit: 'm', min: 0.1, max: 4, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'elevation', label: 'Height from road', unit: 'm', min: 0.1, max: 5, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'inset', label: 'Inset from front', unit: 'm', min: -0.5, max: 2, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'offsetX', label: 'Pair / beam offset X', unit: 'm', min: -5, max: 5, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'offsetY', label: 'Pair / beam offset Y', unit: 'm', min: -5, max: 5, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'offsetZ', label: 'Pair / beam offset Z', unit: 'm', min: -5, max: 5, step: 0.01, group: 'lens' }),
  Object.freeze({ key: 'temperature', label: 'Temperature', unit: 'warm ↔ cool', min: -1, max: 1, step: 0.02, group: 'beam' }),
  Object.freeze({ key: 'intensity', label: 'Intensity', unit: 'cd', min: 0, max: 3000, step: 25, group: 'beam' }),
  Object.freeze({ key: 'range', label: 'Reach', unit: 'm', min: 0.5, max: 60, step: 0.25, group: 'beam' }),
  Object.freeze({ key: 'radius', label: 'Pool radius', unit: 'm', min: 0.25, max: 30, step: 0.25, group: 'beam' }),
  Object.freeze({ key: 'softness', label: 'Edge softness', unit: '', min: 0, max: 1, step: 0.02, group: 'beam' }),
  Object.freeze({ key: 'decay', label: 'Physical falloff', unit: '', min: 0, max: 3, step: 0.05, group: 'beam' }),
  Object.freeze({ key: 'irregularity', label: 'Cloud irregularity', unit: '', min: 0.15, max: 1, step: 0.02, group: 'beam' }),
  Object.freeze({ key: 'seed', label: 'Cloud seed', unit: '', min: 0, max: 2147483647, step: 1, integer: true, group: 'beam' }),
  Object.freeze({ key: 'aimX', label: 'Aim offset X', unit: 'm', min: -10, max: 10, step: 0.05, group: 'aim' }),
  Object.freeze({ key: 'aimY', label: 'Aim height', unit: 'm', min: -5, max: 5, step: 0.05, group: 'aim' }),
  Object.freeze({ key: 'aimDistance', label: 'Aim distance', unit: 'm', min: 1, max: 120, step: 0.5, group: 'aim' }),
]);

// Body paint is stored per car target instead of per modeled part: one car
// body is spread over several materials and, once a Modeler replacement exists,
// over several mesh parts too, so a single authoritative record is the only way
// a colour change reaches the whole car.
export const CAR_PAINT_FIELDS = Object.freeze([
  Object.freeze({ key: 'metallic', label: 'Metallic flake', unit: '0 flat · 1 metallic', min: 0, max: 1, step: 0.02 }),
  Object.freeze({ key: 'gloss', label: 'Clear-coat gloss', unit: '', min: 0, max: 1, step: 0.02 }),
  // Livery controls. `wrapScale` is how many times the image repeats over the
  // car's own length; 1 = one copy across the whole body.
  Object.freeze({ key: 'wrapScale', label: 'Image scale', unit: 'repeats per car', min: 0.25, max: 6, step: 0.05, textureOnly: true }),
  Object.freeze({ key: 'wrapTint', label: 'Tint by paint colour', unit: '0 image as-is · 1 fully tinted', min: 0, max: 1, step: 0.02, textureOnly: true }),
]);

const CAR_PAINT_FIELD_DEFAULTS = Object.freeze({ metallic: 0, gloss: 0, wrapScale: 1, wrapTint: 0 });

const TRAFFIC_BODY_COLORS = Object.freeze({ car: '#b9c0c9', van: '#e6e8ea', truck: '#4a6274' });

/** The colour the car ships with, used as the starting point of the picker. */
export function stockCarBodyColor(target) {
  const parsed = parseCarModelTarget(target);
  if (!parsed) return '#b9c0c9';
  if (parsed.scope === 'traffic') return TRAFFIC_BODY_COLORS[parsed.id] || '#b9c0c9';
  const model = PSX_CAR_MODELS.find((entry) => entry.id === parsed.id);
  return `#${((model?.color ?? 0xb9c0c9) & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function defaultCarPaint(target) {
  return { color: stockCarBodyColor(target), ...CAR_PAINT_FIELD_DEFAULTS };
}

/**
 * Saved body paint, or `null` when the car keeps its stock material. Returning
 * null (rather than the defaults) is what lets every unpainted car render
 * byte-identically to before this record existed.
 *
 * A saved `texture` names an entry of the document's texture library; it is
 * carried through as an id and turned into an image by applyCarPaint(), which
 * is the only place that knows how a texture record becomes a GPU texture.
 */
export function carPaintSettings(target, document = null) {
  const saved = carModelEntry(document, target)?.paint;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const defaults = defaultCarPaint(target);
  const result = {
    color: /^#[0-9a-f]{6}$/i.test(String(saved.color || ''))
      ? String(saved.color).toLowerCase()
      : defaults.color,
  };
  for (const field of CAR_PAINT_FIELDS) {
    result[field.key] = clampField(saved[field.key], field, defaults[field.key]);
  }
  // An id left behind by a deleted image resolves to nothing downstream and
  // the car simply falls back to plain paint.
  result.texture = typeof saved.texture === 'string' && saved.texture ? saved.texture : null;
  return result;
}

const PLAYER_CAR_HITBOX = Object.freeze({
  width: 1.78,
  length: 4.35,
  height: 1.45,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
});

function clampField(value, field, fallback) {
  return Number.isFinite(value) ? Math.max(field.min, Math.min(field.max, value)) : fallback;
}

/** Collision dimensions for either a player model or a traffic class. */
export function carHitboxSettings(target, document = null, fallback = null) {
  const parsed = parseCarModelTarget(target);
  if (!parsed) return { ...PLAYER_CAR_HITBOX };
  const base = parsed.scope === 'traffic'
    ? TRAFFIC_CAR_BY_ID[parsed.id]
    : { ...PLAYER_CAR_HITBOX, ...(fallback || {}) };
  const saved = carModelEntry(document, target)?.settings || {};
  return Object.fromEntries(CAR_HITBOX_SETTING_FIELDS.map((field) => [
    field.key,
    clampField(saved[field.key], field, base[field.key] ?? field.defaultValue ?? 0),
  ]));
}

/** Default pair of always-unlit rear lenses, scaled from the current hitbox. */
export function defaultCarRearLights(target, document = null) {
  const hitbox = carHitboxSettings(target, document);
  return {
    enabled: true,
    color: '#ff1833',
    width: Math.min(0.34, Math.max(0.18, hitbox.width * 0.16)),
    height: Math.min(0.24, Math.max(0.12, hitbox.height * 0.12)),
    depth: 0.08,
    spacing: Math.max(0.45, hitbox.width * 0.68),
    elevation: Math.max(0.28, hitbox.height * 0.52),
    inset: 0.04,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
  };
}

/**
 * Rear-light appearance/placement shared by the Modeler preview and runtime.
 * MeshBasicMaterial consumes these values, so the lenses stay bright in
 * shadow without adding a PointLight or any per-fragment lighting work.
 */
export function carRearLightSettings(target, document = null) {
  const defaults = defaultCarRearLights(target, document);
  const saved = carModelEntry(document, target)?.rearLights || {};
  const result = {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
    color: /^#[0-9a-f]{6}$/i.test(String(saved.color || '')) ? String(saved.color) : defaults.color,
  };
  for (const field of CAR_REAR_LIGHT_FIELDS) {
    result[field.key] = clampField(saved[field.key], field, defaults[field.key]);
  }
  return result;
}

/** Default visible headlamp pair and the single broad beam used by the player. */
export function defaultCarHeadlights(target, document = null) {
  const hitbox = carHitboxSettings(target, document);
  const parsed = parseCarModelTarget(target);
  const trafficType = parsed?.scope === 'traffic' ? TRAFFIC_CAR_BY_ID[parsed.id] : null;
  return {
    enabled: true,
    color: '#ffe4bd',
    width: Math.min(0.34, Math.max(0.18, hitbox.width * 0.17)),
    height: 0.16,
    depth: 0.06,
    spacing: Math.max(0.45, hitbox.width * 0.66),
    elevation: trafficType?.id === 'truck' ? 1.2 : Math.max(0.35, hitbox.height * 0.5),
    inset: 0.04,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    temperature: -0.12,
    intensity: 1450,
    range: 60,
    radius: 32,
    softness: 0.74,
    decay: 1.35,
    irregularity: 0.42,
    seed: 1,
    aimX: 0,
    aimY: 0.1,
    aimDistance: 30,
  };
}

/**
 * Full car-headlight record. The photometric subset is normalized by the same
 * function as placed Soft Custom Lights, so colour temperature, brightness,
 * reach, pool size, softness, falloff and cloud shape behave identically.
 */
export function carHeadlightSettings(target, document = null) {
  const defaults = defaultCarHeadlights(target, document);
  const saved = carModelEntry(document, target)?.headlights || {};
  const local = normalizeLocalLight({ ...defaults, ...saved });
  const result = {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
    color: local.color,
  };
  for (const field of CAR_HEADLIGHT_FIELDS) {
    if (Object.hasOwn(local, field.key)) {
      result[field.key] = local[field.key];
      continue;
    }
    const fallback = defaults[field.key];
    const value = Number.isFinite(saved[field.key]) ? saved[field.key] : fallback;
    const bounded = Math.max(field.min, Math.min(field.max, value));
    result[field.key] = field.integer ? Math.round(bounded) : bounded;
  }
  return result;
}

export function trafficCarSettings(typeOrId) {
  const type = typeof typeOrId === 'string' ? TRAFFIC_CAR_BY_ID[typeOrId] : typeOrId;
  if (!type) return {};
  return {
    width: type.width,
    length: type.length,
    height: type.height,
    offsetX: type.offsetX ?? 0,
    offsetY: type.offsetY ?? 0,
    offsetZ: type.offsetZ ?? 0,
    minSpeedKmh: type.minSpeed * 3.6,
    maxSpeedKmh: type.maxSpeed * 3.6,
    acceleration: type.acceleration,
    braking: type.braking,
    weight: type.weight,
    laneBias: type.laneBias,
    laneSpread: type.laneSpread,
  };
}

export function effectiveTrafficCarType(id, document = null) {
  const base = TRAFFIC_CAR_BY_ID[id] || TRAFFIC_CAR_BY_ID.car;
  const target = carModelTarget('traffic', base.id);
  const saved = carModelEntry(document, target)?.settings || {};
  const finite = (key, fallback) => Number.isFinite(saved[key]) ? saved[key] : fallback;
  return {
    ...base,
    width: finite('width', base.width),
    length: finite('length', base.length),
    height: finite('height', base.height),
    offsetX: finite('offsetX', base.offsetX ?? 0),
    offsetY: finite('offsetY', base.offsetY ?? 0),
    offsetZ: finite('offsetZ', base.offsetZ ?? 0),
    minSpeed: finite('minSpeedKmh', base.minSpeed * 3.6) / 3.6,
    maxSpeed: finite('maxSpeedKmh', base.maxSpeed * 3.6) / 3.6,
    acceleration: finite('acceleration', base.acceleration),
    braking: finite('braking', base.braking),
    weight: finite('weight', base.weight),
    laneBias: finite('laneBias', base.laneBias),
    laneSpread: finite('laneSpread', base.laneSpread),
    headlights: carHeadlightSettings(target, document),
    rearLights: carRearLightSettings(target, document),
  };
}

const box = (name, scale, position, color, vehicleRole = null) => ({
  kind: 'box',
  name,
  position,
  rotation: [0, 0, 0],
  scale,
  color,
  faces: {},
  ...(vehicleRole ? { vehicleRole } : {}),
});

/**
 * Exact visible boxes used by the live traffic generator.
 *
 * Both the game and the Modeler consume this function, so a traffic class can
 * no longer acquire an editor-only cab, wheel or window that does not exist on
 * the road. Roles let a saved replacement keep brake/indicator behaviour.
 */
export function trafficCarPartSpecs(typeOrId) {
  const type = typeof typeOrId === 'string' ? TRAFFIC_CAR_BY_ID[typeOrId] : typeOrId;
  if (!type) return [];
  const { width: w, length: l, height: h } = type;
  const half = l * 0.5;
  const target = carModelTarget('traffic', type.id);
  const headlights = type.headlights || defaultCarHeadlights(target);
  const frontZ = half - headlights.inset + headlights.offsetZ;
  const rear = type.rearLights || defaultCarRearLights(target);
  const rearZ = -half + rear.inset;
  const tailZ = rearZ + rear.offsetZ;
  const bodyColor = {
    car: '#b9c0c9',
    van: '#e6e8ea',
    truck: '#4a6274',
  }[type.id] || '#b9c0c9';
  const parts = [
    { role: 'body', name: 'Body', scale: [w, h, l], position: [0, h * 0.5, 0], color: bodyColor },
  ];
  if (headlights.enabled) {
    parts.push(
      { role: 'headlamp', name: 'Headlamp L', scale: [headlights.width, headlights.height, headlights.depth], position: [headlights.offsetX - headlights.spacing * 0.5, headlights.elevation + headlights.offsetY, frontZ], color: headlights.color },
      { role: 'headlamp', name: 'Headlamp R', scale: [headlights.width, headlights.height, headlights.depth], position: [headlights.offsetX + headlights.spacing * 0.5, headlights.elevation + headlights.offsetY, frontZ], color: headlights.color },
    );
  }
  if (rear.enabled) {
    parts.push(
      { role: 'taillamp', name: 'Taillamp L', scale: [rear.width, rear.height, rear.depth], position: [rear.offsetX - rear.spacing * 0.5, rear.elevation + rear.offsetY, tailZ], color: rear.color },
      { role: 'taillamp', name: 'Taillamp R', scale: [rear.width, rear.height, rear.depth], position: [rear.offsetX + rear.spacing * 0.5, rear.elevation + rear.offsetY, tailZ], color: rear.color },
    );
  }
  parts.push(
    { role: 'indicator-left', name: 'Indicator L', scale: [0.12, 0.16, 0.06], position: [-(w * 0.34 + 0.22), rear.elevation, rearZ], color: '#ffa51f' },
    { role: 'indicator-right', name: 'Indicator R', scale: [0.12, 0.16, 0.06], position: [w * 0.34 + 0.22, rear.elevation, rearZ], color: '#ffa51f' },
  );
  return parts;
}

/**
 * Editable primitive source for a traffic class. It is deliberately built
 * from the exact same box specifications used by live traffic.
 */
export function trafficCarDefinition(typeOrId, assetId = null) {
  const type = typeof typeOrId === 'string' ? TRAFFIC_CAR_BY_ID[typeOrId] : typeOrId;
  if (!type) return null;
  const parts = trafficCarPartSpecs(type).map((part) => (
    box(part.name, [...part.scale], [...part.position], part.color, part.role)
  ));

  return {
    id: assetId,
    label: `${type.label} custom`,
    description: `Editable replacement for every ${type.label.toLowerCase()} in live traffic`,
    layer: 'Vehicles',
    createdAt: new Date().toISOString(),
    parts,
  };
}
