/**
 * Runtime camera tuning shared by the playable game and the editor playground.
 *
 * Values live in custom-assets.json under `runtimeTuning.camera`, beside the
 * car Modeler document. Keeping the schema here means the live playground and
 * normal gameplay can never silently use different ranges or defaults.
 */
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
