import { normalizeSkyboxConfig, skyboxConfigErrors } from '../../../../js/skybox-config.js';
import {
  isDefaultLighting,
  LOCAL_LIGHT_ASSET_ID,
  localLightConfigErrors,
  normalizeLighting,
} from '../../../../js/lighting-config.js';

export const PROJECT_SCHEMA_VERSION = 1;
export const DEFAULT_PROJECT_PATH = 'data/editor/hesi-world-project.json';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ProjectValidationError extends Error {
  constructor(errors) {
    super(`Invalid HESI editor project:\n- ${errors.join('\n- ')}`);
    this.name = 'ProjectValidationError';
    this.errors = errors;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteVector(value, length, path, errors) {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => !Number.isFinite(item))) {
    errors.push(`${path} must contain ${length} finite numbers`);
    return false;
  }
  return true;
}

function validateTransform(transform, path, errors) {
  if (!isRecord(transform)) { errors.push(`${path} must be an object`); return; }
  finiteVector(transform.position, 3, `${path}.position`, errors);
  finiteVector(transform.rotation, 3, `${path}.rotation`, errors);
  finiteVector(transform.scale, 3, `${path}.scale`, errors);
}

function validateFaceTextures(faceTextures, path, errors, textureIds = null) {
  if (!isRecord(faceTextures)) { errors.push(`${path} must be an object`); return; }
  for (const [slot, style] of Object.entries(faceTextures)) {
    const slotPath = `${path}.${slot}`;
    if (!/^\d+:\d+$/.test(slot)) errors.push(`${slotPath} must use a meshIndex:materialIndex key`);
    if (!isRecord(style)) { errors.push(`${slotPath} must be an object`); continue; }
    if (typeof style.texture !== 'string' || !/^tex:[a-z0-9][a-z0-9_-]{0,80}$/i.test(style.texture)) {
      errors.push(`${slotPath}.texture must be a texture id`);
    } else if (textureIds && !textureIds.has(style.texture)) errors.push(`${slotPath}.texture references missing texture ${style.texture}`);
    if (style.fit !== undefined && !['stretch', 'cover'].includes(style.fit)) errors.push(`${slotPath}.fit must be stretch or cover`);
    for (const key of ['flipX', 'flipY']) if (style[key] !== undefined && typeof style[key] !== 'boolean') errors.push(`${slotPath}.${key} must be boolean`);
  }
}

function validateJsonValue(value, path, errors, depth = 0) {
  if (depth > 20) { errors.push(`${path} is nested too deeply`); return; }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, errors, depth + 1));
    return;
  }
  if (!isRecord(value)) { errors.push(`${path} is not JSON data`); return; }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`${path}.${key} is forbidden`);
    else validateJsonValue(child, `${path}.${key}`, errors, depth + 1);
  }
}

export function validateProjectDocument(document, { entityIds = null, assetIds = null, textureIds = null } = {}) {
  const errors = [];
  if (!isRecord(document)) throw new ProjectValidationError(['root must be an object']);
  if (document.version !== PROJECT_SCHEMA_VERSION) errors.push(`version must be ${PROJECT_SCHEMA_VERSION}`);
  if (!isRecord(document.project)) errors.push('project must be an object');
  else if (typeof document.project.name !== 'string' || !document.project.name.trim() || document.project.name.length > 160) errors.push('project.name must be a non-empty string of at most 160 characters');
  if (!isRecord(document.entityOverrides)) errors.push('entityOverrides must be an object');
  else {
    for (const [id, override] of Object.entries(document.entityOverrides)) {
      if (!id || FORBIDDEN_KEYS.has(id)) errors.push(`invalid entity override ID: ${id || '(empty)'}`);
      if (entityIds && !entityIds.has(id)) errors.push(`unknown entity ID: ${id}`);
      if (!isRecord(override)) { errors.push(`entityOverrides.${id} must be an object`); continue; }
      if (override.transform !== undefined) validateTransform(override.transform, `entityOverrides.${id}.transform`, errors);
      if (override.faceTextures !== undefined) validateFaceTextures(override.faceTextures, `entityOverrides.${id}.faceTextures`, errors, textureIds);
      for (const key of ['visible', 'disabled', 'locked']) {
        if (override[key] !== undefined && typeof override[key] !== 'boolean') errors.push(`entityOverrides.${id}.${key} must be boolean`);
      }
      if (override.name !== undefined && (typeof override.name !== 'string' || !override.name.trim() || override.name.length > 200)) errors.push(`entityOverrides.${id}.name is invalid`);
    }
  }
  if (!Array.isArray(document.placedObjects)) errors.push('placedObjects must be an array');
  else {
    const ids = new Set();
    document.placedObjects.forEach((placed, index) => {
      const path = `placedObjects[${index}]`;
      if (!isRecord(placed)) { errors.push(`${path} must be an object`); return; }
      if (typeof placed.id !== 'string' || !placed.id.trim()) errors.push(`${path}.id is required`);
      else if (ids.has(placed.id)) errors.push(`duplicate placed object ID: ${placed.id}`);
      else {
        ids.add(placed.id);
        if (entityIds?.has(placed.id)) errors.push(`placed object ID collides with generated entity: ${placed.id}`);
      }
      if (typeof placed.assetId !== 'string' || !placed.assetId.trim()) errors.push(`${path}.assetId is required`);
      else if (assetIds && !assetIds.has(placed.assetId)) errors.push(`unknown asset ID: ${placed.assetId}`);
      if (typeof placed.layer !== 'string' || !placed.layer.trim()) errors.push(`${path}.layer is required`);
      if (placed.name !== undefined && (typeof placed.name !== 'string' || !placed.name.trim() || placed.name.length > 200)) errors.push(`${path}.name is invalid`);
      validateTransform(placed.transform, `${path}.transform`, errors);
      if (placed.light !== undefined) {
        errors.push(...localLightConfigErrors(placed.light, { path: `${path}.light` }));
      } else if (placed.assetId === LOCAL_LIGHT_ASSET_ID) {
        errors.push(`${path}.light is required for a placed soft light`);
      }
      if (placed.faceTextures !== undefined) validateFaceTextures(placed.faceTextures, `${path}.faceTextures`, errors, textureIds);
      for (const key of ['visible', 'locked']) if (placed[key] !== undefined && typeof placed[key] !== 'boolean') errors.push(`${path}.${key} must be boolean`);
    });
  }
  if (!Array.isArray(document.groups)) errors.push('groups must be an array');
  if (document.environment !== undefined) {
    if (!isRecord(document.environment)) errors.push('environment must be an object');
    else {
      if (document.environment.skybox !== undefined && document.environment.skybox !== null) {
        errors.push(...skyboxConfigErrors(document.environment.skybox, {
          textureIds,
          path: 'environment.skybox',
        }));
      }
      const lighting = document.environment.lighting;
      if (lighting !== undefined && lighting !== null) {
        if (!isRecord(lighting)) errors.push('environment.lighting must be an object');
        else {
          if (lighting.intensity !== undefined && !Number.isFinite(lighting.intensity)) errors.push('environment.lighting.intensity must be a number');
          if (lighting.temperature !== undefined && !Number.isFinite(lighting.temperature)) errors.push('environment.lighting.temperature must be a number');
          if (lighting.tint !== undefined && !/^#?[0-9a-f]{6}$/i.test(String(lighting.tint))) errors.push('environment.lighting.tint must be a #rrggbb colour');
          if (lighting.streetLampColor !== undefined && !/^#?[0-9a-f]{6}$/i.test(String(lighting.streetLampColor))) errors.push('environment.lighting.streetLampColor must be a #rrggbb colour');
          if (lighting.streetLampIntensity !== undefined && !Number.isFinite(lighting.streetLampIntensity)) errors.push('environment.lighting.streetLampIntensity must be a number');
          if (lighting.streetLampTemperature !== undefined && !Number.isFinite(lighting.streetLampTemperature)) errors.push('environment.lighting.streetLampTemperature must be a number');
        }
      }
      const gloss = document.environment.surfaceGloss;
      if (gloss !== undefined && gloss !== null && !Number.isFinite(gloss)) errors.push('environment.surfaceGloss must be a number');
    }
  }
  if (!isRecord(document.editorState)) errors.push('editorState must be an object');
  validateJsonValue(document, 'projectDocument', errors);
  if (errors.length) throw new ProjectValidationError(errors);
  return true;
}

const roundNumber = (value) => Object.is(value, -0) ? 0 : Math.round(value * 100000) / 100000;

function stableValue(value) {
  if (typeof value === 'number') return roundNumber(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function canonicalizeProjectDocument(document) {
  validateProjectDocument(document);
  const entityOverrides = Object.fromEntries(Object.keys(document.entityOverrides).sort().map((id) => [id, stableValue(document.entityOverrides[id])]));
  const placedObjects = document.placedObjects.map(stableValue).sort((a, b) => a.id.localeCompare(b.id));
  const groups = document.groups.map(stableValue).sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  const skybox = document.environment?.skybox ? normalizeSkyboxConfig(document.environment.skybox) : null;
  const lighting = document.environment?.lighting ? normalizeLighting(document.environment.lighting) : null;
  const surfaceGloss = document.environment?.surfaceGloss;
  const environment = {};
  if (skybox) environment.skybox = stableValue(skybox);
  if (lighting && !isDefaultLighting(lighting)) environment.lighting = stableValue(lighting);
  if (Number.isFinite(surfaceGloss) && Math.abs(surfaceGloss - 1) > 1e-3) {
    environment.surfaceGloss = roundNumber(Math.min(3, Math.max(0, surfaceGloss)));
  }
  return {
    version: PROJECT_SCHEMA_VERSION,
    project: stableValue(document.project),
    entityOverrides,
    placedObjects,
    groups,
    environment,
    editorState: stableValue(document.editorState),
  };
}

export function serializeProjectDocument(document) {
  return `${JSON.stringify(canonicalizeProjectDocument(document), null, 2)}\n`;
}

export function parseProjectDocument(text, options = {}) {
  let document;
  try { document = JSON.parse(text); }
  catch (error) { throw new ProjectValidationError([`JSON parse failed: ${error.message}`]); }
  validateProjectDocument(document, options);
  return canonicalizeProjectDocument(document);
}

export function blankProjectDocument(name = 'HESI Main World') {
  return { version: PROJECT_SCHEMA_VERSION, project: { name }, entityOverrides: {}, placedObjects: [], groups: [], environment: {}, editorState: {} };
}
