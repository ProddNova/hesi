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

const box = (name, scale, position, color) => ({
  kind: 'box',
  name,
  position,
  rotation: [0, 0, 0],
  scale,
  color,
  faces: {},
});

const wheel = (name, x, y, z, radius, width) => ({
  kind: 'cylinder',
  name,
  position: [x, y, z],
  rotation: [0, 0, Math.PI / 2],
  scale: [radius * 2, width, radius * 2],
  segments: 10,
  color: '#080a0d',
  faces: {},
});

/**
 * Editable primitive source for a traffic class.  It mirrors the runtime
 * dimensions and adds explicit body/cab/glass/wheel/light parts so every
 * visible element is immediately reachable by the normal Modeler tools.
 */
export function trafficCarDefinition(typeOrId, assetId = null) {
  const type = typeof typeOrId === 'string' ? TRAFFIC_CAR_BY_ID[typeOrId] : typeOrId;
  if (!type) return null;
  const { width: w, length: l, height: h } = type;
  const bodyColor = '#39ff14';
  const parts = [];

  if (type.id === 'car') {
    parts.push(
      box('Body', [w, h * 0.48, l], [0, h * 0.35, 0], bodyColor),
      box('Cabin and glass', [w * 0.78, h * 0.45, l * 0.48], [0, h * 0.76, -l * 0.03], '#101820'),
    );
  } else if (type.id === 'van') {
    parts.push(
      box('Van body', [w, h * 0.82, l], [0, h * 0.45, 0], bodyColor),
      box('Windscreen', [w * 0.78, h * 0.3, 0.08], [0, h * 0.72, l * 0.5 + 0.02], '#101820'),
    );
  } else {
    const cabLength = Math.min(3.4, l * 0.25);
    const trailerLength = l - cabLength - 0.45;
    parts.push(
      box('TIR cab', [w, h * 0.88, cabLength], [0, h * 0.47, l * 0.5 - cabLength * 0.5], bodyColor),
      box('TIR trailer', [w * 0.98, h * 0.92, trailerLength], [0, h * 0.49, -l * 0.5 + trailerLength * 0.5], bodyColor),
      box('Windscreen', [w * 0.76, h * 0.28, 0.08], [0, h * 0.7, l * 0.5 + 0.02], '#101820'),
    );
  }

  const radius = Math.min(0.56, Math.max(0.28, h * 0.22));
  const axleZ = type.id === 'truck'
    ? [l * 0.37, -l * 0.34, -l * 0.43]
    : [l * 0.31, -l * 0.31];
  for (const [axle, z] of axleZ.entries()) {
    parts.push(
      wheel(`Wheel L${axle + 1}`, -w * 0.48, radius, z, radius, Math.max(0.16, w * 0.11)),
      wheel(`Wheel R${axle + 1}`, w * 0.48, radius, z, radius, Math.max(0.16, w * 0.11)),
    );
  }
  const lampW = Math.min(0.32, w * 0.18);
  for (const side of [-1, 1]) {
    parts.push(
      box(`Headlamp ${side < 0 ? 'L' : 'R'}`, [lampW, 0.16, 0.06], [side * w * 0.32, h * 0.5, l * 0.5 + 0.03], '#fff0be'),
      box(`Taillamp ${side < 0 ? 'L' : 'R'}`, [lampW, 0.18, 0.06], [side * w * 0.32, h * 0.5, -l * 0.5 - 0.03], '#8a1512'),
    );
  }

  return {
    id: assetId,
    label: `${type.label} custom`,
    description: `Editable replacement for every ${type.label.toLowerCase()} in live traffic`,
    layer: 'Vehicles',
    createdAt: new Date().toISOString(),
    parts,
  };
}
