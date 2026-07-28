/**
 * "Filtro" — the PS2 picture simulation (dev panel, key 9).
 *
 * This module owns nothing but the SETTINGS: defaults, ranges, clamping and
 * presets. The pixels are produced by the present pass in js/vhs-effect.js,
 * which already owns the offscreen buffer and the fullscreen quad — adding a
 * second pass would mean a second full-resolution buffer for effects that all
 * fit in the same handful of instructions.
 *
 * The three groups are the three things that actually separate a PS2 frame from
 * a modern one, in the order the hardware produced them:
 *
 *  1. **Pixelation.** A PS2 rendered around 512×448 and let the TV stretch it.
 *     The dial is a virtual line count rather than a block size in device
 *     pixels, so the look is identical on a 1080p laptop and a 4K monitor and
 *     does not change when the adaptive resolution governor moves the internal
 *     framebuffer.
 *  2. **Colour quantization and dithering.** The console's framebuffer was 16
 *     bit (5 bits per channel = 32 levels), and the GPU dithered on the way in
 *     to hide the banding that produced. Both halves are here: quantization
 *     without dither gives hard bands, dither without quantization does
 *     nothing, which is why the panel keeps them next to each other.
 *  3. **Film grain.** Not a console artifact at all — it is the capture chain
 *     (the composite cable, the tape, the camera pointed at the TV) that
 *     everyone actually remembers. Kept separate from the VHS pass's own grain
 *     so it survives with the tape look switched off.
 *
 * Everything is defined so that a disabled filter, or a filter with every dial
 * at its neutral value, produces the same bytes the game produced before this
 * existed. The probe checks exactly that.
 */

/**
 * Dither patterns. `bayer8`/`bayer4` are the ordered matrices the hardware
 * used — a fixed, non-moving grid — and `noise` is the white-noise alternative
 * that hides banding without the visible cross-hatch, at the cost of crawling
 * when the camera moves.
 */
export const PS2_DITHER_PATTERNS = [
  { id: 'bayer8', label: 'Ordinato 8×8 (console)' },
  { id: 'bayer4', label: 'Ordinato 4×4 (grosso)' },
  { id: 'noise', label: 'Rumore (senza trama)' },
];

const PATTERN_IDS = PS2_DITHER_PATTERNS.map((pattern) => pattern.id);

/** Numeric code handed to the shader; keep in sync with FRAGMENT_SHADER. */
export function ditherPatternCode(pattern) {
  const index = PATTERN_IDS.indexOf(pattern);
  return index < 0 ? 0 : index;
}

/**
 * The shipped look, authored on the panel and switched ON by default.
 *
 * These are not the textbook console numbers and that is deliberate: 448 lines
 * with 32 colour levels and heavy dither is what the hardware did, but over a
 * road rushing at the camera the dither crawls and the banding reads as a
 * compression artifact rather than as a console. What survived that test is
 * the *resolution* — 368 lines — plus a slow monochrome grain sitting in the
 * shadows, with colour quantization left off. `PS2_FILTER_PRESETS.ps1` still
 * carries the strict period-accurate combination for anyone who wants it.
 *
 * `data/editor/custom-assets.json` carries the same values under
 * `runtimeTuning.picture` so they can be re-authored from the test game and
 * deployed without a code change; these are the fallback when that section is
 * missing, and they must be kept in step with it.
 */
export const PS2_FILTER_DEFAULTS = Object.freeze({
  enabled: true,
  pixelLines: 368,
  colorLevels: 0,
  dither: 0,
  ditherScale: 4,
  ditherPattern: 'bayer4',
  grain: 0.2,
  grainScale: 2.5,
  grainSpeed: 18,
  grainShadows: 1,
  grainColor: 0,
});

/**
 * Panel metadata. One entry per dial: the debug panel builds its sliders from
 * this and the game clamps through it, so a range only has to be written once.
 * `zero` is the label shown at the neutral end (the dial is off, not at 0%).
 */
export const PS2_FILTER_FIELDS = Object.freeze([
  {
    key: 'pixelLines', group: 'pixel', label: 'RISOLUZIONE VERTICALE',
    min: 0, max: 1080, step: 8, unit: ' righe', zero: 'NATIVA',
  },
  {
    key: 'colorLevels', group: 'color', label: 'LIVELLI COLORE',
    min: 0, max: 64, step: 1, unit: '/canale', zero: 'PIENI (24 bit)',
    // 0 and 1 both mean "do not quantize"; the shader tests >= 2.
    neutralBelow: 2,
  },
  {
    key: 'dither', group: 'color', label: 'DITHER',
    min: 0, max: 2, step: 0.05, percent: true, zero: 'OFF',
  },
  {
    key: 'ditherScale', group: 'color', label: 'SCALA DITHER',
    min: 1, max: 4, step: 1, unit: '× pixel',
  },
  {
    key: 'grain', group: 'grain', label: 'INTENSITÀ GRANA',
    min: 0, max: 2, step: 0.05, percent: true, zero: 'OFF',
  },
  {
    key: 'grainScale', group: 'grain', label: 'DIMENSIONE GRANA',
    min: 0.5, max: 8, step: 0.5, unit: '× pixel',
  },
  {
    key: 'grainSpeed', group: 'grain', label: 'VELOCITÀ GRANA',
    min: 0, max: 60, step: 1, unit: ' Hz', zero: 'FISSA',
  },
  {
    key: 'grainShadows', group: 'grain', label: 'GRANA NELLE OMBRE',
    min: 0, max: 1, step: 0.05, percent: true, zero: 'UNIFORME',
  },
  {
    key: 'grainColor', group: 'grain', label: 'GRANA A COLORI',
    min: 0, max: 1, step: 0.05, percent: true, zero: 'MONOCROMA',
  },
]);

const FIELD_BY_KEY = new Map(PS2_FILTER_FIELDS.map((field) => [field.key, field]));

/**
 * Presets. `clean` is the identity — every dial neutral — and doubles as the
 * panel's reset. `ps2` restores the shipped look above (so it is the "put it
 * back" button, not a separate idea); `ps1` is the period-accurate console
 * treatment — low framebuffer, 4-bit colour, heavy ordered dither — and
 * `arcade` keeps the colour crunch without softening the picture.
 */
export const PS2_FILTER_PRESETS = Object.freeze({
  clean: { pixelLines: 0, colorLevels: 0, dither: 0, ditherScale: 1, grain: 0, grainScale: 2, grainSpeed: 12, grainShadows: 0.65, grainColor: 0.2, ditherPattern: 'bayer8' },
  ps2: { ...PS2_FILTER_DEFAULTS },
  ps1: { pixelLines: 240, colorLevels: 16, dither: 1.2, ditherScale: 2, ditherPattern: 'bayer4', grain: 0.5, grainScale: 3, grainSpeed: 16, grainShadows: 0.7, grainColor: 0.15 },
  arcade: { pixelLines: 0, colorLevels: 24, dither: 0.9, ditherScale: 1, ditherPattern: 'noise', grain: 0.25, grainScale: 1.5, grainSpeed: 24, grainShadows: 0.5, grainColor: 0.35 },
});

const number = (value, fallback) => (Number.isFinite(+value) ? +value : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Clamps one dial to its declared range. Unknown keys pass through unchanged. */
export function clampFilterValue(key, value) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return value;
  const fallback = PS2_FILTER_DEFAULTS[key];
  return clamp(number(value, fallback), field.min, field.max);
}

/**
 * Turns anything (a save file written by an older build, a partial patch, a
 * `null`) into a complete, in-range settings object. Never throws — this runs
 * on load, before the player can see an error.
 */
export function normalizePS2Filter(value) {
  const input = value && typeof value === 'object' ? value : {};
  const settings = { enabled: Boolean(input.enabled) };
  for (const field of PS2_FILTER_FIELDS) settings[field.key] = clampFilterValue(field.key, input[field.key]);
  settings.ditherPattern = PATTERN_IDS.includes(input.ditherPattern) ? input.ditherPattern : PS2_FILTER_DEFAULTS.ditherPattern;
  return settings;
}

/**
 * True when the filter would visibly change the picture. The present pass uses
 * this to decide whether it needs its offscreen buffer at all, so a filter that
 * is switched on but sits at every neutral value still costs nothing.
 *
 * Dither is deliberately NOT in this list: it only exists to break up the steps
 * introduced by quantization, so on its own it has no output to modify.
 */
export function filterAffectsImage(settings) {
  if (!settings?.enabled) return false;
  return settings.pixelLines > 0 || settings.colorLevels >= 2 || settings.grain > 0;
}

/** The value shown next to a slider, e.g. `448 righe`, `OFF`, `120%`. */
export function formatFilterValue(key, value) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return String(value);
  const amount = number(value, PS2_FILTER_DEFAULTS[key]);
  if (field.zero && amount <= (field.neutralBelow ?? 0)) return field.zero;
  if (field.percent) return `${Math.round(amount * 100)}%`;
  const decimals = field.step < 1 ? 1 : 0;
  return `${amount.toFixed(decimals)}${field.unit || ''}`;
}
