import { PSX_CAR_MODELS } from './psx-car-pack.js';

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

export const TRAFFIC_CAR_SETTING_FIELDS = Object.freeze([
  Object.freeze({ key: 'width', label: 'Collision width', unit: 'm', min: 0.6, max: 5, step: 0.01 }),
  Object.freeze({ key: 'length', label: 'Collision length', unit: 'm', min: 1.5, max: 30, step: 0.01 }),
  Object.freeze({ key: 'height', label: 'Collision height', unit: 'm', min: 0.5, max: 8, step: 0.01 }),
  Object.freeze({ key: 'minSpeedKmh', label: 'Minimum cruise', unit: 'km/h', min: 20, max: 220, step: 1 }),
  Object.freeze({ key: 'maxSpeedKmh', label: 'Maximum cruise', unit: 'km/h', min: 20, max: 260, step: 1 }),
  Object.freeze({ key: 'acceleration', label: 'Acceleration', unit: 'm/s²', min: 0.1, max: 15, step: 0.05 }),
  Object.freeze({ key: 'braking', label: 'Braking', unit: 'm/s²', min: 0.5, max: 25, step: 0.1 }),
  Object.freeze({ key: 'weight', label: 'Spawn weight', unit: '', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ key: 'laneBias', label: 'Lane bias', unit: '0 fast · 1 outer', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ key: 'laneSpread', label: 'Lane spread', unit: '', min: 0.05, max: 2, step: 0.01 }),
]);

export function trafficCarSettings(typeOrId) {
  const type = typeof typeOrId === 'string' ? TRAFFIC_CAR_BY_ID[typeOrId] : typeOrId;
  if (!type) return {};
  return {
    width: type.width,
    length: type.length,
    height: type.height,
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
  const saved = carModelEntry(document, carModelTarget('traffic', base.id))?.settings || {};
  const finite = (key, fallback) => Number.isFinite(saved[key]) ? saved[key] : fallback;
  return {
    ...base,
    width: finite('width', base.width),
    length: finite('length', base.length),
    height: finite('height', base.height),
    minSpeed: finite('minSpeedKmh', base.minSpeed * 3.6) / 3.6,
    maxSpeed: finite('maxSpeedKmh', base.maxSpeed * 3.6) / 3.6,
    acceleration: finite('acceleration', base.acceleration),
    braking: finite('braking', base.braking),
    weight: finite('weight', base.weight),
    laneBias: finite('laneBias', base.laneBias),
    laneSpread: finite('laneSpread', base.laneSpread),
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
  const headY = type.id === 'truck' ? 1.2 : h * 0.5;
  const tailY = type.id === 'truck' ? 1.05 : h * 0.52;
  const frontZ = half - 0.04;
  const rearZ = -half + 0.04;
  const lampW = Math.min(0.3, w * 0.17);
  return [
    { role: 'body', name: 'Body', scale: [w, h, l], position: [0, h * 0.5, 0], color: '#39ff14' },
    { role: 'headlamp', name: 'Headlamp L', scale: [lampW, 0.16, 0.06], position: [-w * 0.33, headY, frontZ], color: '#fff0be' },
    { role: 'headlamp', name: 'Headlamp R', scale: [lampW, 0.16, 0.06], position: [w * 0.33, headY, frontZ], color: '#fff0be' },
    { role: 'taillamp', name: 'Taillamp L', scale: [lampW, 0.18, 0.06], position: [-w * 0.34, tailY, rearZ], color: '#8a1512' },
    { role: 'taillamp', name: 'Taillamp R', scale: [lampW, 0.18, 0.06], position: [w * 0.34, tailY, rearZ], color: '#8a1512' },
    { role: 'indicator-left', name: 'Indicator L', scale: [0.12, 0.16, 0.06], position: [-(w * 0.34 + 0.22), tailY, rearZ], color: '#ffa51f' },
    { role: 'indicator-right', name: 'Indicator R', scale: [0.12, 0.16, 0.06], position: [w * 0.34 + 0.22, tailY, rearZ], color: '#ffa51f' },
  ];
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
