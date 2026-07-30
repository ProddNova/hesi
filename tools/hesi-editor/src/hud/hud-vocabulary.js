/**
 * What the HUD editor knows that the game does not.
 *
 * js/hud-theme.js is the runtime model — fields, ranges, defaults, and how a
 * theme becomes CSS custom properties. Everything here is authoring: how a value
 * reads on screen, the presets, the operations that change a theme, and — the
 * part that makes this an editor rather than a slider board — the WIDGET table
 * that maps a thing you can see and grab to the fields dragging it should write.
 *
 * Keeping it out of js/*.js is the point: the playable build ships the model and
 * the published values, never the editor.
 *
 * ## Widgets
 *
 * A widget is one grabbable piece of interface: the score block, the dial
 * cluster, the phone shell, the loading bar. It declares
 *
 *  - `screen`   which preview it lives on (`hud`, `phone`, `pc`, `loading`, `boot`)
 *  - `selector` how to find it inside that preview
 *  - `move`     the two nudge fields a drag writes, if it can be moved
 *  - `resize`   how a corner handle resizes it, one of:
 *      · `{ kind: 'scale', field }`  a multiplier — the four HUD corners, the
 *        boot logo: their authored size is responsive and must stay so
 *      · `{ kind: 'box', width, height }`  real pixel dimensions — the phone
 *        shell, the loading bar: they are boxes and behave like boxes
 *      · `{ kind: 'font', field }`  a type size — the prompt, the near-miss
 *        splash, the loading title: what "bigger" means for a line of text
 *  - `fields`   what the inspector lists when it is selected
 *  - `visibility` the toggle the V key and the eye button flip
 *  - `measure`  a child to take the marquee from, when the element that MOVES is
 *               not the box you see. The dial cluster is the case: `.hud-br` is
 *               the positioned container, but the dials inside it are scaled by
 *               a transform, so the container's layout box is half again wider
 *               than the picture — and on a phone that put its resize handles
 *               outside the frame, where nothing can grab them.
 *
 * `origin` mirrors the CSS `transform-origin` the stylesheet gives that element,
 * so a handle drag grows the element in the direction the pointer is going
 * instead of away from it.
 */
import {
  HUD_DEVICE_IDS,
  HUD_THEME_SECTIONS,
  hudFieldScope,
  hudThemeField,
  hudThemeValue,
  normalizeHudTheme,
  normalizeHudValue,
  HUD_COLOR_ROLES,
  HUD_FONT_STACKS,
// Relative rather than `/js/...` so this module also resolves under `node --test`:
// four levels up from src/hud/ is the repository root in both the dev server and
// the filesystem. The panel and the preview stay browser-only and keep the
// absolute form the rest of the editor uses.
} from '../../../../js/hud-theme.js';

export const HUD_SCREENS = Object.freeze([
  Object.freeze({ id: 'hud', label: 'Guida', hint: 'Il HUD durante la guida' }),
  Object.freeze({ id: 'phone', label: 'Telefono', hint: 'Il keitai in gioco (F)' }),
  Object.freeze({ id: 'pc', label: 'Terminale', hint: 'WANGAN MARKET nel garage' }),
  Object.freeze({ id: 'loading', label: 'Caricamento', hint: 'La schermata di caricamento' }),
  Object.freeze({ id: 'boot', label: 'Avvio', hint: 'Il menu iniziale' }),
]);

const widget = (id, label, screen, selector, extra) => Object.freeze({ id, label, screen, selector, ...extra });

export const HUD_WIDGETS = Object.freeze([
  // --- driving HUD -------------------------------------------------------
  widget('score', 'Punteggio', 'hud', '.hud-tl', {
    origin: 'left top',
    move: { x: 'tlX', y: 'tlY' },
    resize: { kind: 'scale', field: 'tlScale' },
    visibility: 'showScore',
    fields: ['showScore', 'showScoreLabel', 'showCombo', 'showComboBar', 'showLives',
      'scoreSize', 'scoreLabelSize', 'comboSize', 'comboBarWidth', 'lifeSize',
      'scoreRole', 'scoreLabelRole', 'comboRole', 'scoreLabel', 'livesLabel'],
  }),
  widget('bank', 'Banca', 'hud', '.hud-tr', {
    origin: 'right top',
    move: { x: 'trX', y: 'trY' },
    resize: { kind: 'scale', field: 'trScale' },
    visibility: 'showBank',
    fields: ['showBank', 'bankSize', 'bankLabelSize', 'bankRole', 'bankLabel'],
  }),
  widget('gps', 'GPS e zona', 'hud', '.hud-bl', {
    origin: 'left bottom',
    move: { x: 'blX', y: 'blY' },
    resize: { kind: 'scale', field: 'blScale' },
    visibility: 'showMinimap',
    fields: ['showMinimap', 'showArea', 'minimapWidth', 'minimapHeight', 'areaSize', 'areaLabelSize',
      'areaRole', 'areaLabelRole', 'mapBg', 'mapRoute', 'mapRouteAlt', 'mapService', 'mapGarage', 'mapPlayer'],
  }),
  widget('cluster', 'Quadranti', 'hud', '.hud-br', {
    measure: '.cluster',
    origin: 'right bottom',
    move: { x: 'brX', y: 'brY' },
    resize: { kind: 'scale', field: 'clusterScale' },
    visibility: 'showCluster',
    fields: ['showCluster', 'showTach', 'showGear', 'showFuel', 'clusterScale', 'dialTachSize', 'dialSpeedSize',
      'speedSize', 'rpmSize', 'gearSize', 'fuelWidth', 'speedRole', 'gearRole',
      'dialFace', 'dialNeedle', 'dialTick', 'dialLabel', 'dialGlow'],
  }),
  widget('toasts', 'Avvisi', 'hud', '#toast-stack', {
    origin: 'right top',
    move: { x: 'toastX', y: 'toastY' },
    resize: { kind: 'scale', field: 'toastScale' },
    visibility: 'showToasts',
    fields: ['showToasts', 'toastScale', 'toastSize', 'toastRole'],
  }),
  widget('prompt', 'Richiesta azione', 'hud', '#interaction-prompt', {
    origin: 'center bottom',
    move: { x: 'promptX', y: 'promptY' },
    resize: { kind: 'font', field: 'promptSize' },
    visibility: 'showPrompt',
    fields: ['showPrompt', 'promptSize', 'promptRole'],
  }),
  widget('splash', 'Near miss', 'hud', '#near-miss', {
    origin: 'center top',
    move: { x: 'splashX', y: 'splashY' },
    resize: { kind: 'font', field: 'splashSize' },
    visibility: 'showSplash',
    fields: ['showSplash', 'splashSize', 'splashRole'],
  }),
  widget('fps', 'Contatore FPS', 'hud', '.mobile-fps', {
    origin: 'left top',
    move: { x: 'fpsX', y: 'fpsY' },
    resize: { kind: 'font', field: 'fpsSize' },
    visibility: 'showFps',
    fields: ['showFps', 'fpsSize'],
  }),

  // --- in-game phone -----------------------------------------------------
  widget('phone', 'Guscio telefono', 'phone', '.phone', {
    origin: 'right bottom',
    resize: { kind: 'box', width: 'phoneWidth', height: 'phoneHeight' },
    fields: ['phoneWidth', 'phoneHeight', 'phoneScale', 'phoneRadius', 'showPhoneFooter'],
  }),
  widget('phone-lcd', 'Schermo LCD', 'phone', '.phone-lcd', {
    origin: 'center center',
    fields: ['phoneLcd1', 'phoneLcd2', 'phoneLcd3', 'phoneInk', 'phoneInk2', 'phoneInk3', 'phoneScan',
      'phoneHeaderSize', 'phoneTitleSize', 'phoneLabelSize', 'phoneCardSize'],
  }),
  widget('phone-apps', 'Griglia app', 'phone', '.app-grid', {
    origin: 'center center',
    resize: { kind: 'box', width: 'phoneAppIcon', height: 'phoneAppIcon' },
    fields: ['phoneAppCols', 'phoneAppIcon'],
  }),

  // --- PC terminal -------------------------------------------------------
  widget('pc', 'Finestra terminale', 'pc', '.pc', {
    origin: 'center center',
    resize: { kind: 'inset', field: 'pcInset' },
    fields: ['pcInset', 'pcAccentRole', 'pcScan', 'pcGridAlpha', 'pcGridSize', 'pcCardMin'],
  }),
  widget('pc-header', 'Intestazione', 'pc', '.pc>header', {
    origin: 'left top',
    resize: { kind: 'box', height: 'pcHeader' },
    fields: ['pcHeader', 'pcBrandSize', 'pcNavSize', 'pcBalanceSize', 'pcAccentRole'],
  }),
  // The market page is rendered by js/ui.js at runtime, so index.html has no
  // markup for it and the preview supplies a sample instead. `injected` says
  // which side of that line a widget is on; the tests check it against the right
  // source rather than accepting a selector nothing can match.
  widget('pc-title', 'Titolo di sezione', 'pc', '.market-title h2', {
    injected: true,
    origin: 'left bottom',
    resize: { kind: 'font', field: 'pcTitleSize' },
    fields: ['pcTitleSize'],
  }),

  // --- loading screen ----------------------------------------------------
  widget('load-title', 'Titolo', 'loading', '#loading b', {
    origin: 'center center',
    resize: { kind: 'font', field: 'loadTitleSize' },
    fields: ['loadTitle', 'loadTitleSize', 'loadTitleRole', 'loadJitter'],
  }),
  widget('load-ring', 'Anello', 'loading', '.load-ring', {
    origin: 'center center',
    resize: { kind: 'box', width: 'loadRingSize', height: 'loadRingSize' },
    visibility: 'showLoadRing',
    fields: ['showLoadRing', 'loadRingSize', 'loadRingRole', 'loadRingSpeed'],
  }),
  widget('load-bar', 'Barra', 'loading', '.loading .load-bar', {
    origin: 'center center',
    resize: { kind: 'box', width: 'loadBarWidth', height: 'loadBarHeight' },
    visibility: 'showLoadBar',
    fields: ['showLoadBar', 'loadBarWidth', 'loadBarHeight', 'loadBarRole'],
  }),
  widget('load-subtitle', 'Sottotitolo', 'loading', '#loading span', {
    origin: 'center center',
    resize: { kind: 'font', field: 'loadSubtitleSize' },
    fields: ['loadSubtitle', 'loadSubtitleSize', 'loadSubtitleColor', 'loadBg'],
  }),

  // --- boot menu ---------------------------------------------------------
  widget('boot-logo', 'Logo', 'boot', '.boot-logo', {
    origin: 'left top',
    resize: { kind: 'scale', field: 'bootLogoScale' },
    fields: ['bootLogoScale', 'bootLogoRole', 'bootLogoAccentRole'],
  }),
  widget('boot-menu', 'Voci di menu', 'boot', '.boot-menu', {
    origin: 'left top',
    resize: { kind: 'scale', field: 'bootMenuScale' },
    fields: ['bootMenuScale'],
  }),
  widget('boot-kanji', 'Kanji', 'boot', '.boot-kanji', {
    origin: 'right top',
    resize: { kind: 'scale', field: 'bootKanjiScale' },
    visibility: 'showBootKanji',
    fields: ['showBootKanji', 'bootKanjiScale'],
  }),
  widget('boot-ticker', 'Striscia', 'boot', '.boot-ticker', {
    origin: 'center bottom',
    visibility: 'showBootTicker',
    fields: ['showBootTicker', 'bootTicker'],
  }),
  widget('boot-decor', 'Sfondo', 'boot', '.boot-city', {
    origin: 'center bottom',
    visibility: 'showBootCity',
    fields: ['showBootGrid', 'showBootCity', 'showBootTop'],
  }),
]);

export const HUD_WIDGETS_BY_ID = new Map(HUD_WIDGETS.map((entry) => [entry.id, entry]));

/** The widgets on one preview screen, in table order. */
export function widgetsForScreen(screen) {
  return HUD_WIDGETS.filter((entry) => entry.screen === screen);
}

/** Every field a widget can write, deduplicated: move + resize + inspector. */
export function widgetFieldKeys(entry) {
  const keys = new Set(entry.fields || []);
  if (entry.move) { keys.add(entry.move.x); keys.add(entry.move.y); }
  if (entry.resize?.field) keys.add(entry.resize.field);
  if (entry.resize?.width) keys.add(entry.resize.width);
  if (entry.resize?.height) keys.add(entry.resize.height);
  if (entry.visibility) keys.add(entry.visibility);
  return [...keys];
}

// ---------------------------------------------------------------------------
// Editing operations. All of them return a NEW normalized theme rather than
// mutating: the panel keeps an undo stack of whole themes, which for a record
// this small is both simpler and impossible to get half-applied.
// ---------------------------------------------------------------------------

/** Writes one field, in the scope that owns it. Unknown keys are ignored. */
export function setHudField(theme, key, value, device = 'desktop') {
  const settings = normalizeHudTheme(theme);
  const entry = hudThemeField(key);
  if (!entry) return settings;
  const shared = hudFieldScope(entry.section, entry.field) === 'shared';
  const scope = shared ? 'shared' : (HUD_DEVICE_IDS.includes(device) ? device : 'desktop');
  settings[scope][key] = normalizeHudValue(entry.section, entry.field, value, shared ? 'desktop' : scope);
  return settings;
}

/** Writes several fields at once — one drag can move two of them. */
export function setHudFields(theme, patch, device = 'desktop') {
  let settings = theme;
  for (const [key, value] of Object.entries(patch)) settings = setHudField(settings, key, value, device);
  return normalizeHudTheme(settings);
}

/** One field's current value for the profile being edited. */
export function fieldValue(theme, key, device = 'desktop') {
  const entry = hudThemeField(key);
  if (!entry) return undefined;
  return hudThemeValue(normalizeHudTheme(theme), entry.section, entry.field, device);
}

/** Puts one section back to the shipped values, in one scope or in both. */
export function resetHudSection(theme, sectionId, device = null) {
  const settings = normalizeHudTheme(theme);
  const section = HUD_THEME_SECTIONS.find((entry) => entry.id === sectionId);
  if (!section) return settings;
  for (const field of section.fields) {
    const shared = hudFieldScope(section, field) === 'shared';
    const scopes = shared ? ['shared'] : (device ? [device] : HUD_DEVICE_IDS);
    for (const scope of scopes) settings[scope][field.key] = shared ? field.value : field[scope];
  }
  return normalizeHudTheme(settings);
}

/** Puts one widget's own fields back, which is the undo a designer asks for. */
export function resetHudWidget(theme, entry, device = 'desktop') {
  const settings = normalizeHudTheme(theme);
  for (const key of widgetFieldKeys(entry)) {
    const found = hudThemeField(key);
    if (!found) continue;
    const shared = hudFieldScope(found.section, found.field) === 'shared';
    if (shared) settings.shared[key] = found.field.value;
    else settings[device][key] = found.field[device];
  }
  return normalizeHudTheme(settings);
}

/**
 * Copies one device profile onto the other — "make the phone look like the PC"
 * without re-dragging everything. Fields whose defaults differ on purpose (the
 * minimap, the FPS readout) are copied too: the point of the button is that the
 * target becomes the source.
 */
export function copyHudProfile(theme, from, to) {
  const settings = normalizeHudTheme(theme);
  if (!HUD_DEVICE_IDS.includes(from) || !HUD_DEVICE_IDS.includes(to) || from === to) return settings;
  settings[to] = { ...settings[from] };
  return normalizeHudTheme(settings);
}

// ---------------------------------------------------------------------------
// Direct manipulation: the arithmetic that turns a pointer delta into fields.
// Pure functions, so the feel of a drag is unit-testable without a browser.
// ---------------------------------------------------------------------------

/** A drag by (dx, dy) preview pixels applied to a widget's nudge fields. */
export function dragWidget(theme, entry, { dx, dy, device = 'desktop', start = null }) {
  if (!entry?.move) return normalizeHudTheme(theme);
  const from = start || {
    x: fieldValue(theme, entry.move.x, device) || 0,
    y: fieldValue(theme, entry.move.y, device) || 0,
  };
  return setHudFields(theme, { [entry.move.x]: from.x + dx, [entry.move.y]: from.y + dy }, device);
}

/**
 * Which pointer direction grows the widget, per axis: pull a handle outward and
 * the thing gets bigger.
 *
 * It depends on the handle and not on where the element is anchored, which is
 * worth stating because the first version keyed it off `origin` and got the
 * phone shell backwards — anchored bottom-right, so pulling its top-left corner
 * further left made it *narrower*. Where an element grows *from* is the
 * stylesheet's business (that is what transform-origin is for); which way the
 * pointer has to travel to make it grow is only ever "away from its middle".
 */
export function handleDirection(entry, handle) {
  const [vertical, horizontal] = String(handle).split('-');
  return {
    x: horizontal === 'right' ? 1 : -1,
    y: vertical === 'bottom' ? 1 : -1,
  };
}

/**
 * A handle drag applied to a widget's resize contract.
 *
 * `size` is the element's own rectangle in preview pixels, which is what makes a
 * scale handle proportional: dragging 40px on a 400px-wide block is +10%,
 * whatever the block happens to be.
 */
export function resizeWidget(theme, entry, { handle, dx, dy, size, device = 'desktop', start = null, fine = false }) {
  const resize = entry?.resize;
  if (!resize) return normalizeHudTheme(theme);
  const direction = handleDirection(entry, handle);
  const damp = fine ? 0.25 : 1;
  const outward = (dx * direction.x + dy * direction.y) * damp;

  if (resize.kind === 'box') {
    const patch = {};
    if (resize.width) {
      const from = start?.[resize.width] ?? fieldValue(theme, resize.width, device);
      patch[resize.width] = from + dx * direction.x * damp;
    }
    if (resize.height) {
      const from = start?.[resize.height] ?? fieldValue(theme, resize.height, device);
      patch[resize.height] = from + dy * direction.y * damp;
    }
    return setHudFields(theme, patch, device);
  }

  const span = Math.max(24, ((size?.width || 0) + (size?.height || 0)) / 2);
  const factor = 1 + outward / span;

  if (resize.kind === 'font') {
    const from = start?.[resize.field] ?? fieldValue(theme, resize.field, device);
    return setHudField(theme, resize.field, from * factor, device);
  }
  if (resize.kind === 'inset') {
    // The terminal's margin is inverted: dragging its corner inward makes the
    // window smaller, which means a bigger inset.
    const from = start?.[resize.field] ?? fieldValue(theme, resize.field, device);
    return setHudField(theme, resize.field, from - outward / 12, device);
  }
  const from = start?.[resize.field] ?? fieldValue(theme, resize.field, device);
  return setHudField(theme, resize.field, from * factor, device);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** The value shown beside a control: `46px`, `120%`, `SPENTO`, a role name. */
export function formatHudValue(field, value) {
  switch (field.type) {
    case 'range': {
      const amount = Number.isFinite(+value) ? +value : 0;
      if (field.zero && amount <= 0) return field.zero;
      if (field.percent) return `${Math.round(amount * 100)}%`;
      const decimals = (field.step || 1) < 1 ? 2 : 0;
      return `${Number.parseFloat(amount.toFixed(decimals))}${field.unit ?? ''}`;
    }
    case 'color': return String(value).toUpperCase();
    case 'role': return HUD_COLOR_ROLES.find((entry) => entry.id === value)?.label || String(value);
    case 'font': return HUD_FONT_STACKS.find((entry) => entry.id === value)?.label || String(value);
    case 'toggle': return value ? 'ON' : 'OFF';
    default: return String(value ?? '');
  }
}

/**
 * Presets. `default` is the shipped look and doubles as the panel's reset, so
 * "put it back" and "what this build ships" can never be two different things.
 * The others are patches: only the keys they name move, in the scopes they name.
 */
export const HUD_THEME_PRESETS = Object.freeze({
  default: Object.freeze({ label: 'Originale', patch: Object.freeze({}) }),
  big: Object.freeze({
    label: 'Grande',
    patch: Object.freeze({
      desktop: Object.freeze({ fontScale: 1.35, hudGlow: 1.35, clusterScale: 1.2 }),
      mobile: Object.freeze({ fontScale: 1.3, hudGlow: 1.3, clusterScale: 1.25 }),
    }),
  }),
  minimal: Object.freeze({
    label: 'Minimale',
    patch: Object.freeze({
      shared: Object.freeze({ glowAlpha: 0.2, showBootKanji: false, showBootGrid: false, loadJitter: false }),
      desktop: Object.freeze({
        hudGlow: 0.15, hudShadow: 0.4, showScoreLabel: false, showLives: false, showComboBar: false,
        showMinimap: false, showTach: false, showFuel: false, fontScale: 0.85, hudOpacity: 0.85,
      }),
      mobile: Object.freeze({
        hudGlow: 0.15, hudShadow: 0.4, showScoreLabel: false, showLives: false, showComboBar: false,
        showTach: false, showFuel: false, fontScale: 0.9, hudOpacity: 0.85,
      }),
    }),
  }),
  amber: Object.freeze({
    label: 'Ambra',
    patch: Object.freeze({
      shared: Object.freeze({
        colorGreen: '#ffb02e', colorAmber: '#ffd58a', colorCyan: '#ff8a2e', colorPaper: '#f6e6c8',
        loadTitleRole: 'amber', loadRingRole: 'amber', bootLogoAccentRole: 'cyan',
      }),
      desktop: Object.freeze({ scoreLabelRole: 'amber', bankRole: 'amber', areaLabelRole: 'amber', speedRole: 'amber', dialTick: '#ffd58a', dialLabel: '#ffe6bd', dialGlow: '#ffb02e', mapRoute: '#ffb02e' }),
      mobile: Object.freeze({ scoreLabelRole: 'amber', bankRole: 'amber', areaLabelRole: 'amber', speedRole: 'amber', dialTick: '#ffd58a', dialLabel: '#ffe6bd', dialGlow: '#ffb02e', mapRoute: '#ffb02e' }),
    }),
  }),
  clean: Object.freeze({
    label: 'Senza HUD',
    patch: Object.freeze({
      desktop: Object.freeze({
        showScore: false, showScoreLabel: false, showCombo: false, showComboBar: false, showLives: false,
        showBank: false, showMinimap: false, showArea: false, showCluster: false, showFps: false, showSplash: false,
      }),
      mobile: Object.freeze({
        showScore: false, showScoreLabel: false, showCombo: false, showComboBar: false, showLives: false,
        showBank: false, showMinimap: false, showArea: false, showCluster: false, showFps: false, showSplash: false,
      }),
    }),
  }),
});

/** Applies a preset patch on top of the shipped defaults. */
export function hudThemeFromPreset(name) {
  const preset = HUD_THEME_PRESETS[name];
  if (!preset) return null;
  const theme = normalizeHudTheme(null);
  for (const scope of ['shared', ...HUD_DEVICE_IDS]) Object.assign(theme[scope], preset.patch[scope] || {});
  return normalizeHudTheme(theme);
}
