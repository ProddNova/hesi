/**
 * Runtime camera and picture tuning shared by the playable game and the editor
 * playground.
 *
 * Values live in custom-assets.json under `runtimeTuning.camera` and
 * `runtimeTuning.picture`, beside the car Modeler document. Keeping the schema
 * here means the live playground and normal gameplay can never silently use
 * different ranges or defaults.
 */
import { PS2_FILTER_DEFAULTS, normalizePS2Filter } from './ps2-filter.js?v=8aa9ed7e911a';
export const DEFAULT_CAMERA_TUNING = Object.freeze({
  chase: Object.freeze({
    forward: -5.8,
    height: 2.5,
    tunnelHeight: 1.8,
    lookAhead: 3.5,
    speedLookAhead: 0.014,
    lookHeight: 0.62,
    fov: 60,
    fovGain: 5,
    smoothing: 8.5,
    positionLag: 2.6,
    lookLag: 3,
  }),
  hood: Object.freeze({
    forward: 1.65,
    height: 1.02,
    lookAhead: 12,
    speedLookAhead: 0,
    lookHeight: 0.9,
    fov: 60,
    fovGain: 17,
    smoothing: 18,
    positionLag: 0.7,
    lookLag: 1.2,
  }),
  cockpit: Object.freeze({
    forward: 0.55,
    height: 1.12,
    lookAhead: 11,
    speedLookAhead: 0,
    lookHeight: 0.9,
    fov: 60,
    fovGain: 17,
    smoothing: 18,
    positionLag: 0.7,
    lookLag: 1.2,
  }),
});

const common = [
  { key: 'forward', label: 'Offset avanti / dietro', unit: 'm', min: -12, max: 5, step: 0.05 },
  { key: 'height', label: 'Altezza camera', unit: 'm', min: 0.2, max: 8, step: 0.05 },
  { key: 'lookAhead', label: 'Punto di mira avanti', unit: 'm', min: 0, max: 30, step: 0.1 },
  { key: 'speedLookAhead', label: 'Mira extra per km/h', unit: 'm', min: 0, max: 0.05, step: 0.001 },
  { key: 'lookHeight', label: 'Altezza punto di mira', unit: 'm', min: -1, max: 4, step: 0.05 },
  { key: 'fov', label: 'FOV base', unit: '°', min: 35, max: 100, step: 1 },
  { key: 'fovGain', label: 'FOV extra a velocità', unit: '°', min: 0, max: 35, step: 0.5 },
  { key: 'smoothing', label: 'Reattività camera', unit: '', min: 1, max: 30, step: 0.5 },
  { key: 'positionLag', label: 'Ritardo massimo posizione', unit: 'm', min: 0, max: 6, step: 0.1 },
  { key: 'lookLag', label: 'Ritardo massimo mira', unit: 'm', min: 0, max: 8, step: 0.1 },
];

export const CAMERA_TUNING_FIELDS = Object.freeze({
  chase: Object.freeze([
    ...common,
    { key: 'tunnelHeight', label: 'Altezza nei tunnel', unit: 'm', min: 0.2, max: 5, step: 0.05 },
  ].map(Object.freeze)),
  hood: Object.freeze(common.map((field) => Object.freeze({ ...field }))),
  cockpit: Object.freeze(common.map((field) => Object.freeze({ ...field }))),
});

export function normalizeCameraTuning(value = null) {
  const result = {};
  for (const view of Object.keys(DEFAULT_CAMERA_TUNING)) {
    const source = value?.[view] || {};
    result[view] = {};
    for (const field of CAMERA_TUNING_FIELDS[view]) {
      const fallback = DEFAULT_CAMERA_TUNING[view][field.key];
      const number = Number(source[field.key]);
      result[view][field.key] = Number.isFinite(number)
        ? Math.max(field.min, Math.min(field.max, number))
        : fallback;
    }
  }
  return result;
}

export function cameraTuningFromDocument(document) {
  return normalizeCameraTuning(document?.runtimeTuning?.camera);
}

export function setDocumentCameraTuning(document, tuning) {
  if (!document.runtimeTuning || typeof document.runtimeTuning !== 'object') document.runtimeTuning = {};
  document.runtimeTuning.camera = normalizeCameraTuning(tuning);
  return document.runtimeTuning.camera;
}

// ---------------------------------------------------------------------------
// Picture: the dev panel's image dials (0) plus the PS2 filter (9).
//
// These used to live only in the player's local save, which meant the authored
// look could not be shipped — every visitor got the code defaults and the
// author's own tuning stopped at their browser. They now travel in the same
// document as the camera tuning, written from the test game and deployed with
// the site, so the look on hesi.onrender.com is the one that was tuned.
// ---------------------------------------------------------------------------

/**
 * The image dials, with the ranges the dev panel and setVisualParam() clamp to.
 * `vhsAmount` is the tape look's strength, NOT its on/off switch — that stays a
 * per-player setting (`settings.vhs`), because it is in the phone's settings
 * screen and is the player's to choose.
 */
export const PICTURE_FIELDS = Object.freeze([
  { key: 'vhsAmount', min: 0, max: 4 },
  { key: 'motionBlur', min: 0, max: 4 },
  { key: 'headlightBrightness', min: 0, max: 2.5 },
  { key: 'cameraShake', min: 0, max: 3 },
  { key: 'cameraShakePace', min: 0, max: 3 },
].map(Object.freeze));

/**
 * The shipped picture. Kept in step with `runtimeTuning.picture` in
 * data/editor/custom-assets.json — this is what a player gets when that section
 * is missing (offline, a fresh checkout, a failed fetch).
 */
export const DEFAULT_PICTURE = Object.freeze({
  vhsAmount: 0,
  motionBlur: 4,
  headlightBrightness: 1,
  cameraShake: 1.4,
  cameraShakePace: 1.2,
  filter: PS2_FILTER_DEFAULTS,
});

export function normalizePicture(value = null) {
  const result = {};
  for (const field of PICTURE_FIELDS) {
    const number = Number(value?.[field.key]);
    result[field.key] = Number.isFinite(number)
      ? Math.max(field.min, Math.min(field.max, number))
      : DEFAULT_PICTURE[field.key];
  }
  result.filter = normalizePS2Filter(value?.filter ?? DEFAULT_PICTURE.filter);
  return result;
}

/**
 * A stable id for one published picture. The game stores the id it last adopted
 * and only takes the document's values when that id changes — otherwise every
 * reload would wipe whatever the player just tuned on the live panels, which is
 * the opposite of what a dev panel is for. Publishing new values changes the id
 * and every client picks them up exactly once.
 *
 * FNV-1a over a key-ordered serialization, matching the editor's own
 * `fnv1a32:` draft signatures.
 */
export function pictureSignature(picture) {
  const settings = normalizePicture(picture);
  const parts = [];
  for (const field of PICTURE_FIELDS) parts.push(`${field.key}=${settings[field.key]}`);
  for (const key of Object.keys(settings.filter).sort()) parts.push(`filter.${key}=${settings.filter[key]}`);
  const text = parts.join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export function pictureFromDocument(document) {
  // Undefined, not a default, when the section is absent: the caller has to be
  // able to tell "nothing was published" from "the defaults were published".
  const picture = document?.runtimeTuning?.picture;
  return picture ? normalizePicture(picture) : null;
}

export function setDocumentPicture(document, picture) {
  if (!document.runtimeTuning || typeof document.runtimeTuning !== 'object') document.runtimeTuning = {};
  document.runtimeTuning.picture = normalizePicture(picture);
  return document.runtimeTuning.picture;
}
