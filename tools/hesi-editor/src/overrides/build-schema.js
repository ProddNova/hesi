import { normalizeSkyboxConfig, skyboxConfigErrors } from '../../../../js/skybox-config.js';
import {
  localLightConfigErrors,
  normalizeLighting,
  normalizeLocalLight,
} from '../../../../js/lighting-config.js';

/**
 * Built-map document schema.
 *
 * A build is the *resolved* output of a saved editor project: a flat list of
 * dumb operations the game can replay against the freshly generated world
 * without importing any editor code (no entity discovery, no registry). The
 * editor writes one build file per scene under data/editor/ and the game
 * fetches and applies it at startup through js/editor-map-patch.js.
 *
 * This module is shared between the browser editor and the node dev server,
 * so it must stay dependency free.
 */
export const BUILD_SCHEMA_VERSION = 1;

export const BUILD_PATHS = Object.freeze({
  highway: 'data/editor/hesi-world-build.json',
  garage: 'data/editor/garage-build.json',
});

export const BUILD_PRIMITIVES = Object.freeze(['box', 'cylinder', 'sphere']);

export class BuildValidationError extends Error {
  constructor(errors) {
    super(`Invalid HESI map build:\n- ${errors.join('\n- ')}`);
    this.name = 'BuildValidationError';
    this.errors = errors;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function finiteVector(value, length, path, errors) {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => !Number.isFinite(item))) {
    errors.push(`${path} must contain ${length} finite numbers`);
    return false;
  }
  return true;
}

function validateTransformFields(op, path, errors) {
  finiteVector(op.position, 3, `${path}.position`, errors);
  finiteVector(op.quaternion, 4, `${path}.quaternion`, errors);
  finiteVector(op.scale, 3, `${path}.scale`, errors);
  if (op.visible !== undefined && typeof op.visible !== 'boolean') errors.push(`${path}.visible must be boolean`);
  if (op.faceTextures !== undefined) validateFaceTextures(op.faceTextures, `${path}.faceTextures`, errors);
}

function validateFaceTextures(faceTextures, path, errors) {
  if (!isRecord(faceTextures)) { errors.push(`${path} must be an object`); return; }
  for (const [slot, style] of Object.entries(faceTextures)) {
    const slotPath = `${path}.${slot}`;
    if (!/^\d+:\d+$/.test(slot)) errors.push(`${slotPath} must use a meshIndex:materialIndex key`);
    if (!isRecord(style)) { errors.push(`${slotPath} must be an object`); continue; }
    if (typeof style.texture !== 'string' || !/^tex:[a-z0-9][a-z0-9_-]{0,80}$/i.test(style.texture)) errors.push(`${slotPath}.texture must be a texture id`);
    if (style.fit !== undefined && !['stretch', 'cover'].includes(style.fit)) errors.push(`${slotPath}.fit must be stretch or cover`);
    for (const key of ['flipX', 'flipY']) if (style[key] !== undefined && typeof style[key] !== 'boolean') errors.push(`${slotPath}.${key} must be boolean`);
  }
}

const OPERATION_VALIDATORS = {
  // Overwrite one instanced-mesh slot (lamp, pillar, barrier segment, ...).
  instance(op, path, errors) {
    if (typeof op.mesh !== 'string' || !op.mesh.trim()) errors.push(`${path}.mesh must name the instanced mesh`);
    if (!Number.isInteger(op.index) || op.index < 0) errors.push(`${path}.index must be a non-negative integer`);
    finiteVector(op.matrix, 16, `${path}.matrix`, errors);
  },
  // Transform/hide a named non-instanced object inside the generated map.
  object(op, path, errors) {
    if (typeof op.name !== 'string') errors.push(`${path}.name must be a string`);
    if (!Number.isInteger(op.nameIndex) || op.nameIndex < 0) errors.push(`${path}.nameIndex must be a non-negative integer`);
    validateTransformFields(op, path, errors);
  },
  // Transform/hide a direct child of the garage root, addressed by build index.
  'garage-object'(op, path, errors) {
    if (!Number.isInteger(op.childIndex) || op.childIndex < 0) errors.push(`${path}.childIndex must be a non-negative integer`);
    validateTransformFields(op, path, errors);
  },
  // Add one authored, aimable local light with an organic projected cookie.
  'place-light'(op, path, errors) {
    if (op.name !== undefined && typeof op.name !== 'string') errors.push(`${path}.name must be a string`);
    validateTransformFields(op, path, errors);
    errors.push(...localLightConfigErrors(op.light, { path: `${path}.light` }));
  },
  // Add a placed clone of a generated world asset (geometry donated at runtime).
  place(op, path, errors) {
    if (op.name !== undefined && typeof op.name !== 'string') errors.push(`${path}.name must be a string`);
    validateTransformFields(op, path, errors);
    if (!Array.isArray(op.components) || !op.components.length) {
      errors.push(`${path}.components must be a non-empty array`);
      return;
    }
    op.components.forEach((component, index) => {
      if (!isRecord(component)) { errors.push(`${path}.components[${index}] must be an object`); return; }
      if (typeof component.materialKey !== 'string' || !component.materialKey.trim()) {
        errors.push(`${path}.components[${index}].materialKey is required`);
      }
      finiteVector(component.matrix, 16, `${path}.components[${index}].matrix`, errors);
    });
  },
  // Add an editor-owned primitive (box / cylinder / sphere).
  'place-primitive'(op, path, errors) {
    if (op.name !== undefined && typeof op.name !== 'string') errors.push(`${path}.name must be a string`);
    if (!BUILD_PRIMITIVES.includes(op.primitive)) errors.push(`${path}.primitive must be one of ${BUILD_PRIMITIVES.join(', ')}`);
    validateTransformFields(op, path, errors);
  },
  // Add a Modeler-built custom asset; the game rebuilds it from the shared
  // data/editor/custom-assets.json document (js/custom-assets.js).
  'place-custom'(op, path, errors) {
    if (op.name !== undefined && typeof op.name !== 'string') errors.push(`${path}.name must be a string`);
    if (typeof op.assetId !== 'string' || !/^custom:[a-z0-9][a-z0-9_-]{0,80}$/i.test(op.assetId)) {
      errors.push(`${path}.assetId must be a custom:<id> asset id`);
    }
    validateTransformFields(op, path, errors);
  },
};

export function validateBuildDocument(document) {
  const errors = [];
  if (!isRecord(document)) throw new BuildValidationError(['root must be an object']);
  if (document.version !== BUILD_SCHEMA_VERSION) errors.push(`version must be ${BUILD_SCHEMA_VERSION}`);
  if (!Object.hasOwn(BUILD_PATHS, document.scene)) errors.push(`scene must be one of ${Object.keys(BUILD_PATHS).join(', ')}`);
  if (typeof document.generatedAt !== 'string' || !document.generatedAt.trim()) errors.push('generatedAt must be an ISO timestamp string');
  if (!isRecord(document.project) || typeof document.project.name !== 'string' || !document.project.name.trim()) {
    errors.push('project.name must be a non-empty string');
  } else if (typeof document.project.path !== 'string' || !document.project.path.startsWith('data/editor/')) {
    errors.push('project.path must point under data/editor/');
  } else if (document.project.draftSignature !== undefined
    && !/^fnv1a32:[0-9a-f]{8}$/.test(document.project.draftSignature)) {
    errors.push('project.draftSignature must be an fnv1a32 fingerprint');
  }
  if (!Array.isArray(document.operations)) errors.push('operations must be an array');
  else if (document.operations.length > 20000) errors.push('operations exceeds the 20000 entry limit');
  else {
    document.operations.forEach((op, index) => {
      const path = `operations[${index}]`;
      if (!isRecord(op)) { errors.push(`${path} must be an object`); return; }
      const validator = OPERATION_VALIDATORS[op.op];
      if (!validator) { errors.push(`${path}.op is not a known operation`); return; }
      validator(op, path, errors);
    });
  }
  if (document.environment !== undefined) {
    if (!isRecord(document.environment)) errors.push('environment must be an object');
    else {
      if (document.environment.skybox !== undefined && document.environment.skybox !== null) {
        errors.push(...skyboxConfigErrors(document.environment.skybox, { path: 'environment.skybox' }));
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
  if (errors.length) throw new BuildValidationError(errors);
  return true;
}

const roundNumber = (value) => Object.is(value, -0) ? 0 : Math.round(value * 100000) / 100000;

function stableValue(value) {
  if (typeof value === 'number') return roundNumber(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

// A compact deterministic fingerprint of the saved editor draft. Builds use
// it only to tell whether the currently loaded draft is the one that was last
// applied to the playable game; the game itself does not need to interpret it.
export function buildDraftSignature(document) {
  const text = JSON.stringify(stableValue(document));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function buildEnvironment(environment) {
  const output = {};
  if (environment?.skybox) output.skybox = stableValue(normalizeSkyboxConfig(environment.skybox));
  if (environment?.lighting) output.lighting = stableValue(normalizeLighting(environment.lighting));
  if (Number.isFinite(environment?.surfaceGloss)) output.surfaceGloss = roundNumber(Math.min(3, Math.max(0, environment.surfaceGloss)));
  return output;
}

export function serializeBuildDocument(document) {
  validateBuildDocument(document);
  const canonical = {
    version: BUILD_SCHEMA_VERSION,
    scene: document.scene,
    generatedAt: document.generatedAt,
    project: stableValue(document.project),
    environment: buildEnvironment(document.environment),
    operations: document.operations.map((operation) => stableValue(
      operation.op === 'place-light'
        ? { ...operation, light: normalizeLocalLight(operation.light) }
        : operation,
    )),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function parseBuildDocument(text) {
  let document;
  try { document = JSON.parse(text); }
  catch (error) { throw new BuildValidationError([`JSON parse failed: ${error.message}`]); }
  validateBuildDocument(document);
  return document;
}
