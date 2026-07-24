// Declarative skybox settings shared by the editor project, build output,
// editor preview, and playable game. This file intentionally has no DOM or
// Three.js dependency so the Node validation tests/server can import it too.

export const SKYBOX_DEFAULTS = Object.freeze({
  enabled: true,
  texture: null,
  rotation: Object.freeze([0, 0, 0]), // pitch (X), heading (Y), roll (Z), radians
  offset: Object.freeze([0, 0]), // panorama UV pan
  zoom: 1,
  intensity: 1,
  flipX: false,
});

export const SKYBOX_LIMITS = Object.freeze({
  offset: Object.freeze([-1, 1]),
  zoom: Object.freeze([0.25, 4]),
  intensity: Object.freeze([0, 4]),
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, [minimum, maximum]) => Math.min(maximum, Math.max(minimum, value));
const finiteVector = (value, length) => Array.isArray(value)
  && value.length === length
  && value.every((item) => Number.isFinite(item));

export function skyboxConfigErrors(value, { textureIds = null, path = 'skybox' } = {}) {
  const errors = [];
  if (!isRecord(value)) return [`${path} must be an object`];
  if (typeof value.enabled !== 'boolean') errors.push(`${path}.enabled must be boolean`);
  if (value.texture !== null && (typeof value.texture !== 'string' || !/^tex:[a-z0-9][a-z0-9_-]{0,80}$/i.test(value.texture))) {
    errors.push(`${path}.texture must be null or a texture id`);
  } else if (value.texture && textureIds && !textureIds.has(value.texture)) {
    errors.push(`${path}.texture references missing texture ${value.texture}`);
  }
  if (!finiteVector(value.rotation, 3)) errors.push(`${path}.rotation must contain 3 finite numbers`);
  if (!finiteVector(value.offset, 2)) errors.push(`${path}.offset must contain 2 finite numbers`);
  if (!Number.isFinite(value.zoom) || value.zoom < SKYBOX_LIMITS.zoom[0] || value.zoom > SKYBOX_LIMITS.zoom[1]) {
    errors.push(`${path}.zoom must be between ${SKYBOX_LIMITS.zoom.join(' and ')}`);
  }
  if (!Number.isFinite(value.intensity) || value.intensity < SKYBOX_LIMITS.intensity[0] || value.intensity > SKYBOX_LIMITS.intensity[1]) {
    errors.push(`${path}.intensity must be between ${SKYBOX_LIMITS.intensity.join(' and ')}`);
  }
  if (typeof value.flipX !== 'boolean') errors.push(`${path}.flipX must be boolean`);
  return errors;
}

export function normalizeSkyboxConfig(value = {}) {
  const source = isRecord(value) ? value : {};
  const rotation = finiteVector(source.rotation, 3) ? source.rotation.map(Number) : [...SKYBOX_DEFAULTS.rotation];
  const offset = finiteVector(source.offset, 2)
    ? source.offset.map((item) => clamp(Number(item), SKYBOX_LIMITS.offset))
    : [...SKYBOX_DEFAULTS.offset];
  return {
    enabled: source.enabled === undefined ? SKYBOX_DEFAULTS.enabled : Boolean(source.enabled),
    texture: typeof source.texture === 'string' ? source.texture : null,
    rotation,
    offset,
    zoom: clamp(Number.isFinite(Number(source.zoom)) ? Number(source.zoom) : SKYBOX_DEFAULTS.zoom, SKYBOX_LIMITS.zoom),
    intensity: clamp(Number.isFinite(Number(source.intensity)) ? Number(source.intensity) : SKYBOX_DEFAULTS.intensity, SKYBOX_LIMITS.intensity),
    flipX: Boolean(source.flipX),
  };
}
