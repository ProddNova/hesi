/**
 * The interface theme the GAME ships, and the one contract it cannot check at
 * runtime: every default in js/hud-theme.js must equal the fallback styles.css
 * already carries for that custom property.
 *
 * Why that matters more than it sounds. A theme is installed by writing custom
 * properties onto <html>, and the game writes ALL of them, always — the profile
 * in force is a complete description of the interface. So if a default here said
 * `46px` while the stylesheet said `font-size:var(--hud-score-size,40px)`, then
 * merely loading the game would resize the score, and the "untouched" look would
 * be a look nobody authored. A unit test can catch that; a person reading two
 * files cannot, because there are ~140 of them.
 *
 * The stylesheet is parsed rather than evaluated: `var(--x, FALLBACK)` is found
 * by walking to the matching parenthesis, so nested `var(--hud-score-color,
 * var(--paper))` and `rgba(...)` fallbacks come out whole.
 *
 * The editor is not tested here — it is a tool (tools/hesi-editor → HUD),
 * covered by tools/hesi-editor/test/unit/hud-editor.test.mjs and
 * .devtests/hud-tool-probe.mjs. What this file guards is only what a playable
 * build depends on.
 *
 * Run: node --test .devtests/hud-theme.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  HUD_COLOR_ROLES,
  HUD_DEVICE_IDS,
  HUD_FONT_STACKS,
  HUD_THEME_SECTIONS,
  applyHudTheme,
  defaultHudTheme,
  detectHudDevice,
  hudFieldScope,
  hudThemeDocumentErrors,
  hudThemeField,
  hudThemeFromDocument,
  hudThemeSignature,
  hudThemeTexts,
  hudThemeValue,
  hudThemeVariables,
  normalizeHudTheme,
  normalizeHudValue,
  rgbaFromHex,
  setDocumentHudTheme,
} from '../js/hud-theme.js';

const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
// The dials and the minimap sample the same properties, because a canvas cannot
// resolve a var() chain. They are part of the same contract, checked the same way.
const instruments = await readFile(new URL('../js/hud-instruments.js', import.meta.url), 'utf8');

/** Writes one field. The editor owns the real operation; this is the minimum. */
function withField(theme, key, value, device = 'desktop') {
  const entry = hudThemeField(key);
  const settings = normalizeHudTheme(theme);
  const shared = hudFieldScope(entry.section, entry.field) === 'shared';
  const scope = shared ? 'shared' : device;
  settings[scope][key] = normalizeHudValue(entry.section, entry.field, value, shared ? 'desktop' : device);
  return normalizeHudTheme(settings);
}

/**
 * Every fallback written for one custom property, e.g. `--hud-score-size` ->
 * ['46px', '30px'] (desktop rule plus the compact-HUD rule).
 */
function fallbacksFor(name) {
  const found = [];
  const needle = `var(${name}`;
  let index = css.indexOf(needle);
  while (index !== -1) {
    let depth = 0;
    let comma = -1;
    let cursor = index + 4; // past "var("
    for (; cursor < css.length; cursor += 1) {
      const char = css[cursor];
      if (char === '(') depth += 1;
      else if (char === ')') { if (depth === 0) break; depth -= 1; }
      else if (char === ',' && depth === 0 && comma === -1) comma = cursor;
    }
    // Only count `var(--name` and not `var(--name-something`.
    const head = css.slice(index + 4, comma === -1 ? cursor : comma).trim();
    if (head === name) found.push(comma === -1 ? null : css.slice(comma + 1, cursor).trim());
    index = css.indexOf(needle, index + 1);
  }
  return found;
}

/** `.9s` and `0.9s` are the same value; compare numbers as numbers. */
function sameCssValue(a, b) {
  if (a === b) return true;
  const parse = (value) => /^[-+]?(?:\d*\.)?\d+([a-z%]*)$/i.exec(String(value).trim());
  const left = parse(a);
  const right = parse(b);
  if (!left || !right || left[1] !== right[1]) return false;
  return Number.parseFloat(a) === Number.parseFloat(b);
}

const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));

/** The value :root declares for a property, e.g. `--green` -> `#5cff8a`. */
function rootValue(name) {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(rootBlock);
  return match ? match[1].trim() : null;
}

/** `['dialFace', '--hud-dial-face', '#0a0f15']` in the painters -> '#0a0f15'. */
function canvasFallbackFor(name) {
  const match = new RegExp(`\\['[a-zA-Z]+', '${name}', '([^']*)'\\]`).exec(instruments);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// The contract: defaults are the stylesheet's own values.
// ---------------------------------------------------------------------------

// --hud-font-scale is emitted for inspection only: the scale is applied to the
// sizes themselves on the way out (see hudThemeVariables), because doing it in
// CSS would mean a calc() around thirty declarations.
const NOT_IN_CSS = new Set(['--hud-font-scale']);

test('every emitted custom property is read by styles.css or by the painters', () => {
  const emitted = { ...hudThemeVariables(null, 'desktop'), ...hudThemeVariables(null, 'mobile') };
  for (const name of Object.keys(emitted)) {
    if (NOT_IN_CSS.has(name)) continue;
    assert.ok(
      fallbacksFor(name).length > 0 || rootValue(name) !== null || canvasFallbackFor(name) !== null,
      `${name} is written by a theme but nothing reads it`,
    );
  }
});

test('each styles.css fallback equals one profile default', () => {
  const desktop = hudThemeVariables(null, 'desktop');
  const mobile = hudThemeVariables(null, 'mobile');
  for (const name of new Set([...Object.keys(desktop), ...Object.keys(mobile)])) {
    const expected = [desktop[name], mobile[name]].filter((value) => value !== undefined);
    for (const fallback of fallbacksFor(name)) {
      // The palette tokens are declared in :root, so using them bare is correct
      // and a fallback would be a second place to keep the same colour.
      if (fallback === null) { assert.ok(rootValue(name), `var(${name}) has neither a fallback nor a :root default`); continue; }
      assert.ok(
        expected.some((value) => sameCssValue(value, fallback)),
        `styles.css falls back to "${fallback}" for ${name}, but the defaults are ${expected.join(' / ')}`,
      );
    }
  }
});

/**
 * Variables whose two profile defaults deliberately differ although styles.css
 * carries a single fallback, with the reason. Everything else with one fallback
 * must have one default: a property used as a *multiplier* (`calc(.62 * var())`)
 * that carried .62 as its phone default shipped a cluster at .62 × .62, which is
 * exactly the bug this test exists to prevent.
 */
const ONE_FALLBACK_TWO_DEFAULTS = new Map([
  ['--hud-pc-inset', 'the touch layout writes inset:0 literally, so 0 is the honest phone value'],
  ['--hud-pc-header', 'the desktop rule sets height and the touch rule min-height, with different fallbacks in each'],
]);

test('a property with one fallback has one default in both profiles', () => {
  const desktop = hudThemeVariables(null, 'desktop');
  const mobile = hudThemeVariables(null, 'mobile');
  for (const name of Object.keys(desktop)) {
    const fallbacks = new Set(fallbacksFor(name).filter((value) => value !== null));
    if (fallbacks.size !== 1 || ONE_FALLBACK_TWO_DEFAULTS.has(name)) continue;
    assert.ok(
      sameCssValue(desktop[name], mobile[name]),
      `styles.css has one fallback for ${name} but the profiles default to ${desktop[name]} / ${mobile[name]}`,
    );
  }
});

test('the canvas painters fall back to the same defaults', () => {
  const desktop = hudThemeVariables(null, 'desktop');
  const mobile = hudThemeVariables(null, 'mobile');
  let checked = 0;
  for (const name of Object.keys(desktop)) {
    const fallback = canvasFallbackFor(name);
    if (fallback === null) continue;
    checked += 1;
    assert.equal(fallback, desktop[name], `the painters fall back to ${fallback} for ${name}`);
    assert.equal(fallback, mobile[name], `the painters have one fallback but the profiles differ for ${name}`);
  }
  assert.ok(checked >= 11, `only ${checked} canvas colours found — did the painters stop sampling the theme?`);
});

test('palette defaults equal the :root declarations they replace', () => {
  const variables = hudThemeVariables(null, 'desktop');
  // rgba(92,255,138,.55) and rgba(92,255,138,0.55) are the same colour.
  const same = (a, b) => a === b || a.replace(/\s|0(?=\.)/g, '') === b.replace(/\s|0(?=\.)/g, '');
  for (const name of ['--paper', '--dim', '--green', '--amber', '--red', '--cyan', '--lav', '--panel', '--line', '--bg', '--green-soft']) {
    assert.ok(same(variables[name], rootValue(name)), `${name} default (${variables[name]}) and :root (${rootValue(name)}) disagree`);
  }
});

test('the two font stacks default to the families :root declares', () => {
  const variables = hudThemeVariables(null, 'desktop');
  assert.equal(variables['--term'], rootValue('--term'));
  assert.equal(variables['--disp'], rootValue('--disp'));
});

test('every bundled family a theme can select has an @font-face', () => {
  for (const entry of HUD_FONT_STACKS) {
    // Only the project's own faces ship as files; "Arial Narrow" and friends are
    // whatever the machine has, which is the point of offering them.
    for (const family of entry.stack.match(/"Shutoko[^"]*"/g) || []) {
      assert.ok(css.includes(`font-family:${family}`), `${entry.id} names ${family} but no @font-face declares it`);
    }
  }
});

// ---------------------------------------------------------------------------
// Normalization: nothing a published document, a hand edit or an older build can
// contain may produce an out-of-range theme or throw.
// ---------------------------------------------------------------------------

test('normalize survives junk and fills every field', () => {
  for (const junk of [null, undefined, 0, 'nope', [], { desktop: 7 }, { shared: null }]) {
    const theme = normalizeHudTheme(junk);
    assert.deepEqual(Object.keys(theme).sort(), ['desktop', 'mobile', 'shared'].sort());
    for (const section of HUD_THEME_SECTIONS) {
      for (const field of section.fields) {
        if (hudFieldScope(section, field) === 'shared') assert.notEqual(theme.shared[field.key], undefined, `shared.${field.key}`);
        else for (const device of HUD_DEVICE_IDS) assert.notEqual(theme[device][field.key], undefined, `${device}.${field.key}`);
      }
    }
  }
});

test('out-of-range numbers clamp and snap to their step', () => {
  const theme = normalizeHudTheme({ desktop: { scoreSize: 9999, hudOpacity: -4, clusterScale: 0.611 }, shared: { loadBarWidth: 1e9 } });
  assert.equal(theme.desktop.scoreSize, 140);
  assert.equal(theme.desktop.hudOpacity, 0.05);
  assert.equal(theme.desktop.clusterScale, 0.62);
  assert.equal(theme.shared.loadBarWidth, 900);
});

test('unknown keys, roles, fonts and colours fall back instead of leaking', () => {
  const theme = normalizeHudTheme({
    shared: { colorGreen: 'javascript:alert(1)', loadTitleRole: 'neon', nonsense: 5 },
    desktop: { fontTerm: 'comic', showLives: 'yes' },
  });
  assert.equal(theme.shared.colorGreen, '#5cff8a');
  assert.equal(theme.shared.loadTitleRole, 'amber');
  assert.equal(theme.shared.nonsense, undefined);
  assert.equal(theme.desktop.fontTerm, 'signal');
  assert.equal(theme.desktop.showLives, true);
});

test('short hex is expanded so the colour input and the emitted value agree', () => {
  assert.equal(normalizeHudTheme({ shared: { colorRed: '#F0A' } }).shared.colorRed, '#ff00aa');
});

test('text fields drop control characters and cannot grow unbounded', () => {
  const theme = normalizeHudTheme({ shared: { loadTitle: `A\nBC${'x'.repeat(400)}` } });
  assert.ok(theme.shared.loadTitle.startsWith('ABC'));
  assert.equal(theme.shared.loadTitle.length, 200);
});

test('markup in a text field stays a string — it is written with textContent', () => {
  const value = '<img src=x onerror=alert(1)>';
  assert.equal(normalizeHudTheme({ shared: { loadTitle: value } }).shared.loadTitle, value);
  const write = hudThemeTexts({ shared: { loadTitle: value } }).find((entry) => entry.selector === '#loading b');
  assert.equal(write.text, value);
});

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

test('the font scale multiplies sizes but not offsets or opacities', () => {
  const variables = hudThemeVariables(withField(defaultHudTheme(), 'fontScale', 2), 'desktop');
  assert.equal(variables['--hud-score-size'], '92px');     // 46 * 2, a scaled size
  assert.equal(variables['--hud-minimap-width'], '220px');  // a box, not type
  assert.equal(variables['--hud-opacity'], '1');
});

test('a role emits the palette property, so recolouring still propagates', () => {
  const theme = withField(defaultHudTheme(), 'scoreRole', 'cyan', 'mobile');
  assert.equal(hudThemeVariables(theme, 'mobile')['--hud-score-color'], 'var(--cyan)');
  assert.equal(hudThemeVariables(theme, 'desktop')['--hud-score-color'], 'var(--paper)');
  for (const role of HUD_COLOR_ROLES) {
    const applied = withField(defaultHudTheme(), 'scoreRole', role.id);
    assert.equal(hudThemeVariables(applied, 'desktop')['--hud-score-color'], role.css);
  }
});

test('toggles emit display keywords, never !important', () => {
  assert.equal(hudThemeVariables(withField(defaultHudTheme(), 'showLives', false), 'desktop')['--hud-show-lives'], 'none');
  assert.equal(hudThemeVariables(defaultHudTheme(), 'desktop')['--hud-show-lives'], 'flex');
  for (const value of Object.values(hudThemeVariables(defaultHudTheme(), 'mobile'))) {
    assert.ok(!/!important/.test(value), `emitted "${value}" would outrank the game's own .hidden rule`);
  }
});

test('the derived tokens follow the palette', () => {
  const theme = normalizeHudTheme({ shared: { colorGreen: '#00ff00', glowAlpha: 0.25 }, desktop: { pcGridAlpha: 0.2 } });
  const variables = hudThemeVariables(theme, 'desktop');
  assert.equal(variables['--green-soft'], 'rgba(0,255,0,0.25)');
  assert.equal(variables['--hud-pc-grid'], 'rgba(0,255,0,0.2)');
  assert.equal(rgbaFromHex('#5cff8a', 0.55), 'rgba(92,255,138,0.55)');
});

test('the two profiles emit their own numbers', () => {
  assert.equal(hudThemeVariables(null, 'desktop')['--hud-score-size'], '46px');
  assert.equal(hudThemeVariables(null, 'mobile')['--hud-score-size'], '30px');
  assert.equal(hudThemeVariables(null, 'desktop')['--hud-show-minimap'], 'block');
  assert.equal(hudThemeVariables(null, 'mobile')['--hud-show-minimap'], 'none');
  assert.equal(hudThemeVariables(null, 'desktop')['--hud-show-fps'], 'none');
  assert.equal(hudThemeVariables(null, 'mobile')['--hud-show-fps'], 'block');
  // An unknown profile is answered, not thrown at.
  assert.equal(hudThemeVariables(null, 'watch')['--hud-score-size'], '46px');
});

test('a written field lands in the scope that owns it', () => {
  const shared = withField(defaultHudTheme(), 'colorGreen', '#123456', 'mobile');
  assert.equal(shared.shared.colorGreen, '#123456', 'a shared field ignores the device argument');
  const device = withField(defaultHudTheme(), 'scoreSize', 60, 'mobile');
  assert.equal(device.mobile.scoreSize, 60);
  assert.equal(device.desktop.scoreSize, 46);
});

test('a signature is stable, order-independent and moves with any edit', () => {
  const base = hudThemeSignature(defaultHudTheme());
  assert.equal(base, hudThemeSignature(null));
  assert.equal(base, hudThemeSignature(normalizeHudTheme(defaultHudTheme())));
  assert.notEqual(base, hudThemeSignature(withField(defaultHudTheme(), 'scoreSize', 47)));
  assert.notEqual(base, hudThemeSignature(withField(defaultHudTheme(), 'loadTitle', 'X')));
  assert.match(base, /^fnv1a32:[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

test('a document round-trips and reports nothing published as null', () => {
  assert.equal(hudThemeFromDocument({}), null);
  assert.equal(hudThemeFromDocument({ runtimeTuning: {} }), null);
  const document = { version: 1, assets: {}, textures: {} };
  const theme = withField(defaultHudTheme(), 'scoreSize', 52);
  setDocumentHudTheme(document, theme);
  assert.equal(hudThemeFromDocument(document).desktop.scoreSize, 52);
  assert.equal(hudThemeSignature(hudThemeFromDocument(document)), hudThemeSignature(theme));
});

test('the document validator names what is wrong', () => {
  assert.deepEqual(hudThemeDocumentErrors({ shared: { colorGreen: '#ffffff' } }), []);
  assert.deepEqual(hudThemeDocumentErrors(defaultHudTheme()), []);
  assert.deepEqual(hudThemeDocumentErrors('nope'), ['runtimeTuning.hud must be an object']);
  assert.ok(hudThemeDocumentErrors({ desktop: { scoreSize: 4000 } })[0].includes('desktop.scoreSize'));
  assert.ok(hudThemeDocumentErrors({ shared: { loadTitleRole: 'neon' } })[0].includes('shared.loadTitleRole'));
  assert.ok(hudThemeDocumentErrors({ watch: {} })[0].includes('runtimeTuning.hud.watch'));
  assert.ok(hudThemeDocumentErrors({ shared: { scoreSize: 40 } })[0].includes('shared.scoreSize'), 'a device field in the shared block is a mistake, not a value');
});

// ---------------------------------------------------------------------------
// Applying, with a hand-built stand-in for the document
// ---------------------------------------------------------------------------

function fakeDocument() {
  const nodes = new Map();
  const make = () => ({ textContent: '' });
  for (const selector of ['#loading b', '#loading span', '.score-block small', '.bank small', '#lives span']) nodes.set(selector, [make()]);
  nodes.set('.boot-ticker-track span', [make(), make()]);
  const root = {
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
      removeProperty(name) { this.values.delete(name); },
    },
    dataset: {},
  };
  root.ownerDocument = {
    querySelector: (selector) => nodes.get(selector)?.[0] || null,
    querySelectorAll: (selector) => nodes.get(selector) || [],
  };
  return { root, nodes };
}

test('applying writes every property, the profile and the revision stamp', () => {
  const { root } = fakeDocument();
  const result = applyHudTheme(defaultHudTheme(), { root, device: 'mobile' });
  assert.equal(result.profile, 'mobile');
  assert.equal(root.dataset.hudProfile, 'mobile');
  assert.equal(root.dataset.hudRevision, hudThemeSignature(defaultHudTheme()));
  assert.equal(root.style.values.get('--hud-score-size'), '30px');
  assert.equal(root.style.values.size, Object.keys(result.variables).length);
});

test('the revision stamp changes with the theme, so the painters re-read it', () => {
  const { root } = fakeDocument();
  applyHudTheme(defaultHudTheme(), { root, device: 'desktop' });
  const before = root.dataset.hudRevision;
  applyHudTheme(withField(defaultHudTheme(), 'dialNeedle', '#00ff00'), { root, device: 'desktop' });
  assert.notEqual(root.dataset.hudRevision, before);
});

test('applying writes the text fields, including every copy of the ticker', () => {
  const { root, nodes } = fakeDocument();
  let theme = withField(defaultHudTheme(), 'loadTitle', 'TOKYO NIGHTS');
  theme = withField(theme, 'bootTicker', 'ONE MORE LAP · ');
  applyHudTheme(theme, { root, device: 'desktop' });
  assert.equal(nodes.get('#loading b')[0].textContent, 'TOKYO NIGHTS');
  for (const node of nodes.get('.boot-ticker-track span')) assert.equal(node.textContent, 'ONE MORE LAP · ');
});

test('applying without a document or a window is a no-op, not a crash', () => {
  assert.equal(applyHudTheme(defaultHudTheme(), { root: null, view: null }), null);
  assert.equal(detectHudDevice(null), 'desktop');
  assert.equal(detectHudDevice({ matchMedia: (query) => ({ matches: query.includes('coarse') }) }), 'mobile');
});

// ---------------------------------------------------------------------------
// Field metadata — the editor renders straight from these tables, so a field
// missing a label or a range would render as an unusable control.
// ---------------------------------------------------------------------------

test('every field carries what an editor needs to draw it', () => {
  const seen = new Set();
  for (const section of HUD_THEME_SECTIONS) {
    assert.ok(section.label && section.id, 'a section needs an id and a label');
    assert.ok(['shared', 'device'].includes(section.scope), `${section.id} has scope ${section.scope}`);
    for (const field of section.fields) {
      assert.ok(field.label, `${section.id}.${field.key} has no label`);
      assert.ok(!seen.has(field.key), `${field.key} is declared twice — keys are global`);
      seen.add(field.key);
      const shared = hudFieldScope(section, field) === 'shared';
      if (shared) assert.notEqual(field.value, undefined, `${field.key} has no shared default`);
      else for (const device of HUD_DEVICE_IDS) assert.notEqual(field[device], undefined, `${field.key} has no ${device} default`);
      if (field.type === 'range') {
        assert.ok(Number.isFinite(field.min) && Number.isFinite(field.max) && field.min < field.max, `${field.key} needs a range`);
        assert.ok(field.step > 0, `${field.key} needs a step`);
        const value = shared ? field.value : field.desktop;
        assert.ok(value >= field.min && value <= field.max, `${field.key} defaults outside its own range`);
      }
      if (field.type === 'toggle') assert.ok(field.on && field.off, `${field.key} needs on/off keywords`);
      if (field.type === 'text') assert.ok(field.target, `${field.key} needs a target selector`);
      assert.notEqual(hudThemeValue(defaultHudTheme(), section, field, 'desktop'), undefined);
    }
  }
});

test('the text targets exist in index.html', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const write of hudThemeTexts(null)) {
    // Enough of a check to catch a renamed id or class without parsing HTML: the
    // last token of the selector must appear in the markup.
    const token = write.selector.split(' ').at(-1).replace(/^[.#]/, '');
    assert.ok(html.includes(token), `${write.selector} targets nothing in index.html`);
  }
});

test('the playable build ships no interface editor', async () => {
  const game = await readFile(new URL('../js/game.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  // The editor lives in tools/hesi-editor. A playable build that grew a panel
  // again would show up here first.
  assert.ok(!game.includes('hud-editor'), 'js/game.js imports an editor module');
  assert.ok(!game.includes('HudEditor'), 'js/game.js builds an editor panel');
  assert.ok(!css.includes('hud-editor'), 'styles.css still styles an editor panel');
  assert.ok(!html.includes('hud-editor'), 'index.html still carries an editor panel');
  assert.ok(game.includes('applyHudTheme'), 'the game still has to apply a published theme');
});
