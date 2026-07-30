/**
 * The HUD editor's authoring layer: the widget table, the drag arithmetic, the
 * presets, and the operations that change a theme.
 *
 * Two of these tests are the ones that matter:
 *
 *  - **Every widget selector must exist in the markup it selects.** The editor
 *    previews the game's own index.html, so a HUD element the game renames would
 *    otherwise become a widget that can never be selected — a dead handle, found
 *    by a person wondering why clicking does nothing. Here it is a failing
 *    assertion naming the selector.
 *  - **The drag arithmetic is pure**, so how a corner handle feels is checked
 *    without a browser: which way it grows, what a scale multiplies, that a box
 *    resize writes pixels, and that the terminal's inverted margin still shrinks
 *    when you pull its corner inward.
 *
 * Run: node --test tools/hesi-editor/test/unit/hud-editor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  HUD_DEVICE_IDS,
  defaultHudTheme,
  hudFieldScope,
  hudThemeField,
  hudThemeSignature,
  normalizeHudTheme,
} from '../../../../js/hud-theme.js';
import {
  HUD_SCREENS,
  HUD_THEME_PRESETS,
  HUD_WIDGETS,
  HUD_WIDGETS_BY_ID,
  copyHudProfile,
  dragWidget,
  fieldValue,
  formatHudValue,
  handleDirection,
  hudThemeFromPreset,
  resetHudSection,
  resetHudWidget,
  resizeWidget,
  setHudField,
  setHudFields,
  widgetFieldKeys,
  widgetsForScreen,
} from '../../src/hud/hud-vocabulary.js';

const html = await readFile(new URL('../../../../index.html', import.meta.url), 'utf8');
// Widgets marked `injected` live in markup the game renders at runtime, so the
// preview supplies a sample of it; that sample is where their selectors must hit.
const preview = await readFile(new URL('../../src/hud/hud-preview.js', import.meta.url), 'utf8');
const byId = (id) => HUD_WIDGETS_BY_ID.get(id);

// ---------------------------------------------------------------------------
// The widget table against the game's markup
// ---------------------------------------------------------------------------

test('every widget selector exists in the markup it is meant to select', () => {
  for (const entry of HUD_WIDGETS) {
    const source = entry.injected ? preview : html;
    const where = entry.injected ? 'the preview sample' : 'index.html';
    // Enough to catch a rename without pulling in a DOM: every id/class token of
    // the selector has to appear in that markup.
    for (const token of entry.selector.split(/[\s>]+/)) {
      const name = token.replace(/^[.#]/, '');
      const needle = token.startsWith('#') ? `id="${name}"` : name;
      assert.ok(source.includes(needle), `${entry.id}: ${where} has nothing matching "${token}"`);
    }
  }
});

test('every widget is on a known screen, and every screen has widgets', () => {
  const screens = new Set(HUD_SCREENS.map((screen) => screen.id));
  for (const entry of HUD_WIDGETS) assert.ok(screens.has(entry.screen), `${entry.id} is on unknown screen ${entry.screen}`);
  for (const screen of screens) assert.ok(widgetsForScreen(screen).length > 0, `screen ${screen} has no widgets`);
  assert.equal(new Set(HUD_WIDGETS.map((entry) => entry.id)).size, HUD_WIDGETS.length, 'widget ids must be unique');
});

test('every field a widget names exists in the model', () => {
  for (const entry of HUD_WIDGETS) {
    for (const key of widgetFieldKeys(entry)) {
      assert.ok(hudThemeField(key), `${entry.id} references unknown field ${key}`);
    }
  }
});

test('a widget that can be moved names two device-scoped nudge fields', () => {
  for (const entry of HUD_WIDGETS) {
    if (!entry.move) continue;
    for (const key of [entry.move.x, entry.move.y]) {
      const found = hudThemeField(key);
      assert.equal(found.field.type, 'range', `${entry.id} moves through ${key}, which is not a range`);
      assert.equal(found.field.unit, 'px', `${entry.id} moves through ${key}, which is not in pixels`);
      assert.notEqual(hudFieldScope(found.section, found.field), 'shared', `${key} must be per profile`);
      assert.ok(found.field.min < 0, `${key} must be able to go negative to move both ways`);
    }
  }
});

test('a resize contract matches the kind of field it writes', () => {
  for (const entry of HUD_WIDGETS) {
    const resize = entry.resize;
    if (!resize) continue;
    assert.ok(['scale', 'box', 'font', 'inset'].includes(resize.kind), `${entry.id} has resize kind ${resize.kind}`);
    if (resize.kind === 'box') {
      assert.ok(resize.width || resize.height, `${entry.id} resizes a box with no dimension`);
      for (const key of [resize.width, resize.height].filter(Boolean)) {
        assert.equal(hudThemeField(key).field.unit, 'px', `${entry.id} box-resizes ${key}, which is not in pixels`);
      }
    } else {
      assert.ok(hudThemeField(resize.field), `${entry.id} resizes unknown field ${resize.field}`);
    }
  }
});

test('a visibility toggle really is a toggle', () => {
  for (const entry of HUD_WIDGETS) {
    if (!entry.visibility) continue;
    assert.equal(hudThemeField(entry.visibility).field.type, 'toggle', `${entry.id} toggles ${entry.visibility}`);
  }
});

test('the origins are the ones the stylesheet gives those elements', async () => {
  // `origin` documents where CSS grows each element from. It no longer decides
  // the sign of a drag (see handleDirection), but the marquee reads it and a
  // value that contradicts styles.css would be a lie about the layout.
  const css = await readFile(new URL('../../../../styles.css', import.meta.url), 'utf8');
  for (const [id, expected] of [['score', 'left top'], ['bank', 'right top'], ['gps', 'left bottom'], ['cluster', 'right bottom']]) {
    assert.equal(byId(id).origin, expected);
    assert.ok(css.includes(`transform-origin:${expected}`), `styles.css no longer sets transform-origin:${expected}`);
  }
});

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

test('dragging writes the nudge fields, from where the drag started', () => {
  const entry = byId('score');
  const moved = dragWidget(defaultHudTheme(), entry, { dx: 40, dy: -18, device: 'desktop' });
  assert.equal(fieldValue(moved, 'tlX', 'desktop'), 40);
  assert.equal(fieldValue(moved, 'tlY', 'desktop'), -18);
  // A second drag continues from the value the pointer started on, not from the
  // one the previous frame produced: that is what stops a drag from accelerating.
  const again = dragWidget(moved, entry, { dx: 10, dy: 0, device: 'desktop', start: { x: 40, y: -18 } });
  assert.equal(fieldValue(again, 'tlX', 'desktop'), 50);
});

test('a drag in one profile leaves the other alone', () => {
  const moved = dragWidget(defaultHudTheme(), byId('cluster'), { dx: 30, dy: 0, device: 'mobile' });
  assert.equal(fieldValue(moved, 'brX', 'mobile'), 30);
  assert.equal(fieldValue(moved, 'brX', 'desktop'), 0);
});

test('a drag past the field range stops at the range', () => {
  const moved = dragWidget(defaultHudTheme(), byId('score'), { dx: 99999, dy: -99999, device: 'desktop' });
  assert.equal(fieldValue(moved, 'tlX', 'desktop'), hudThemeField('tlX').field.max);
  assert.equal(fieldValue(moved, 'tlY', 'desktop'), hudThemeField('tlY').field.min);
});

test('a widget with nothing to move is not moved', () => {
  const theme = defaultHudTheme();
  assert.equal(hudThemeSignature(dragWidget(theme, byId('phone'), { dx: 50, dy: 50 })), hudThemeSignature(theme));
});

// ---------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------

test('a handle grows the widget in the direction it is dragged', () => {
  // Anchored top-left: pulling the bottom-right corner away grows it.
  assert.deepEqual(handleDirection(byId('score'), 'bottom-right'), { x: 1, y: 1 });
  assert.deepEqual(handleDirection(byId('score'), 'top-left'), { x: -1, y: -1 });
  // And it is the handle that decides, not the anchor: the same corner of an
  // element anchored bottom-right reads the same way.
  assert.deepEqual(handleDirection(byId('cluster'), 'bottom-right'), { x: 1, y: 1 });
  assert.deepEqual(handleDirection(byId('cluster'), 'top-left'), { x: -1, y: -1 });
  assert.deepEqual(handleDirection(byId('bank'), 'bottom-left'), { x: -1, y: 1 });
});

test('a scale handle is proportional to the element it grabs', () => {
  const entry = byId('score');
  const size = { width: 200, height: 200 };
  const grown = resizeWidget(defaultHudTheme(), entry, { handle: 'bottom-right', dx: 100, dy: 100, size, device: 'desktop' });
  // +200 outward over a 200px element is +100%, so scale 1 becomes 2.
  assert.equal(fieldValue(grown, 'tlScale', 'desktop'), 2);
  const shrunk = resizeWidget(defaultHudTheme(), entry, { handle: 'bottom-right', dx: -50, dy: -50, size, device: 'desktop' });
  assert.equal(fieldValue(shrunk, 'tlScale', 'desktop'), 0.5);
  // Pulling the opposite corner the opposite way is the same gesture.
  const mirrored = resizeWidget(defaultHudTheme(), entry, { handle: 'top-left', dx: -100, dy: -100, size, device: 'desktop' });
  assert.equal(fieldValue(mirrored, 'tlScale', 'desktop'), 2);
  // Shift damps the same gesture for fine work.
  const fine = resizeWidget(defaultHudTheme(), entry, { handle: 'bottom-right', dx: 100, dy: 100, size, device: 'desktop', fine: true });
  assert.equal(fieldValue(fine, 'tlScale', 'desktop'), 1.25);
});

test('a box resize writes pixels on each axis independently', () => {
  const entry = byId('phone');
  const before = { width: fieldValue(null, 'phoneWidth', 'desktop'), height: fieldValue(null, 'phoneHeight', 'desktop') };
  // Anchored bottom-right, so the top-left handle grows it.
  const grown = resizeWidget(defaultHudTheme(), entry, { handle: 'top-left', dx: -40, dy: -80, size: { width: 336, height: 612 }, device: 'desktop' });
  assert.equal(fieldValue(grown, 'phoneWidth', 'desktop'), before.width + 40);
  assert.equal(fieldValue(grown, 'phoneHeight', 'desktop'), before.height + 80);
});

test('a one-dimensional box resize leaves the other axis alone', () => {
  const grown = resizeWidget(defaultHudTheme(), byId('pc-header'), { handle: 'bottom-right', dx: 200, dy: 30, size: { width: 1200, height: 84 }, device: 'desktop' });
  assert.equal(fieldValue(grown, 'pcHeader', 'desktop'), 114);
});

test('a font resize scales the type size', () => {
  const grown = resizeWidget(defaultHudTheme(), byId('load-title'), { handle: 'bottom-right', dx: 46, dy: 46, size: { width: 92, height: 92 }, device: 'desktop' });
  assert.equal(fieldValue(grown, 'loadTitleSize'), 92);
});

test('the terminal margin is inverted: pulling its corner in shrinks the window', () => {
  const inward = resizeWidget(defaultHudTheme(), byId('pc'), { handle: 'bottom-right', dx: -60, dy: -60, size: { width: 1200, height: 680 }, device: 'desktop' });
  assert.ok(fieldValue(inward, 'pcInset', 'desktop') > 2.5, 'inset should grow when the corner is pulled inward');
  const outward = resizeWidget(defaultHudTheme(), byId('pc'), { handle: 'bottom-right', dx: 60, dy: 60, size: { width: 1200, height: 680 }, device: 'desktop' });
  assert.ok(fieldValue(outward, 'pcInset', 'desktop') < 2.5);
});

test('a widget with no resize contract is not resized', () => {
  const theme = defaultHudTheme();
  const same = resizeWidget(theme, byId('phone-lcd'), { handle: 'bottom-right', dx: 80, dy: 80, size: { width: 300, height: 400 } });
  assert.equal(hudThemeSignature(same), hudThemeSignature(theme));
});

// ---------------------------------------------------------------------------
// Field writes, resets, profiles
// ---------------------------------------------------------------------------

test('setHudField normalizes into the scope that owns the field', () => {
  const shared = setHudField(defaultHudTheme(), 'colorGreen', '#ABC', 'mobile');
  assert.equal(shared.shared.colorGreen, '#aabbcc');
  const device = setHudField(defaultHudTheme(), 'scoreSize', 9999, 'mobile');
  assert.equal(device.mobile.scoreSize, hudThemeField('scoreSize').field.max);
  assert.equal(device.desktop.scoreSize, 46);
  assert.deepEqual(setHudField(defaultHudTheme(), 'nope', 1), defaultHudTheme());
});

test('setHudFields writes several at once, which is what one drag is', () => {
  const moved = setHudFields(defaultHudTheme(), { tlX: 12, tlY: -6 }, 'desktop');
  assert.equal(moved.desktop.tlX, 12);
  assert.equal(moved.desktop.tlY, -6);
});

test('resetting a widget restores only its own fields, in its own profile', () => {
  let theme = setHudFields(defaultHudTheme(), { tlX: 40, scoreSize: 90 }, 'desktop');
  theme = setHudFields(theme, { tlX: 22 }, 'mobile');
  theme = setHudField(theme, 'colorGreen', '#111111');
  const reset = resetHudWidget(theme, byId('score'), 'desktop');
  assert.equal(reset.desktop.tlX, 0);
  assert.equal(reset.desktop.scoreSize, 46);
  assert.equal(reset.mobile.tlX, 22, 'the other profile is not touched');
  assert.equal(reset.shared.colorGreen, '#111111', 'a shared colour is not this widget’s to reset');
});

test('resetting a widget also restores the shared fields it owns', () => {
  const theme = setHudField(defaultHudTheme(), 'scoreLabel', 'CHANGED');
  const reset = resetHudWidget(theme, byId('score'), 'desktop');
  assert.equal(reset.shared.scoreLabel, 'UNBANKED · 未精算');
});

test('resetting a section leaves the others alone', () => {
  let theme = setHudField(defaultHudTheme(), 'scoreSize', 99, 'desktop');
  theme = setHudField(theme, 'colorGreen', '#111111');
  const reset = resetHudSection(theme, 'hud', 'desktop');
  assert.equal(reset.desktop.scoreSize, 46);
  assert.equal(reset.shared.colorGreen, '#111111');
  const both = resetHudSection(setHudField(theme, 'scoreSize', 99, 'mobile'), 'hud');
  assert.equal(both.mobile.scoreSize, 30);
});

test('copying a profile makes the target equal the source', () => {
  const theme = setHudField(defaultHudTheme(), 'scoreSize', 64, 'desktop');
  const copied = copyHudProfile(theme, 'desktop', 'mobile');
  assert.equal(copied.mobile.scoreSize, 64);
  assert.equal(copied.mobile.showMinimap, true, 'the point of the button is that the target becomes the source');
  assert.deepEqual(copyHudProfile(theme, 'desktop', 'desktop'), normalizeHudTheme(theme), 'copying onto itself is a no-op');
  assert.deepEqual(copyHudProfile(theme, 'watch', 'mobile'), normalizeHudTheme(theme));
});

// ---------------------------------------------------------------------------
// Presets and presentation
// ---------------------------------------------------------------------------

test('presets are patches on top of the shipped theme', () => {
  assert.deepEqual(hudThemeFromPreset('default'), defaultHudTheme());
  const clean = hudThemeFromPreset('clean');
  assert.equal(clean.desktop.showCluster, false);
  assert.equal(clean.shared.colorGreen, '#5cff8a', 'a HUD preset must not silently recolour the palette');
  assert.equal(hudThemeFromPreset('nope'), null);
  for (const [name, preset] of Object.entries(HUD_THEME_PRESETS)) {
    assert.ok(preset.label, `${name} needs a label`);
    for (const scope of Object.keys(preset.patch)) {
      assert.ok(['shared', ...HUD_DEVICE_IDS].includes(scope), `${name} patches unknown scope ${scope}`);
      for (const key of Object.keys(preset.patch[scope])) {
        const entry = hudThemeField(key);
        assert.ok(entry, `${name} patches unknown field ${key}`);
        const shared = hudFieldScope(entry.section, entry.field) === 'shared';
        assert.equal(shared, scope === 'shared', `${name} patches ${key} in the wrong scope`);
      }
    }
  }
});

test('a preset survives normalization unchanged, so it is applicable as written', () => {
  for (const name of Object.keys(HUD_THEME_PRESETS)) {
    const theme = hudThemeFromPreset(name);
    assert.equal(hudThemeSignature(theme), hudThemeSignature(normalizeHudTheme(theme)), `${name} carries out-of-range values`);
  }
});

test('formatting reads like a value a person would recognise', () => {
  assert.equal(formatHudValue(hudThemeField('scoreSize').field, 46), '46px');
  assert.equal(formatHudValue(hudThemeField('hudOpacity').field, 0.85), '85%');
  assert.equal(formatHudValue(hudThemeField('hudGlow').field, 0), 'SPENTO');
  assert.equal(formatHudValue(hudThemeField('showLives').field, false), 'OFF');
  assert.equal(formatHudValue(hudThemeField('colorGreen').field, '#5cff8a'), '#5CFF8A');
  assert.equal(formatHudValue(hudThemeField('fontTerm').field, 'mono'), 'Monospaziata');
  assert.equal(formatHudValue(hudThemeField('scoreRole').field, 'cyan'), 'Ciano');
});

test('fieldValue reads the profile it is asked for', () => {
  assert.equal(fieldValue(null, 'scoreSize', 'desktop'), 46);
  assert.equal(fieldValue(null, 'scoreSize', 'mobile'), 30);
  assert.equal(fieldValue(null, 'nope'), undefined);
});
