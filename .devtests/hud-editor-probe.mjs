/**
 * EDITOR HUD // 8 in a real browser.
 *
 * The unit test (.devtests/hud-theme.test.mjs) proves the model and that every
 * default matches the fallback styles.css carries. What it cannot prove is the
 * half that only exists in a browser: that the panel builds, that dragging a
 * control moves the pixels, that the PC and phone profiles are actually two
 * different sets of numbers, and — the one that matters most — that a game
 * nobody has themed still computes the styles it computed before any of this
 * existed. So this probe asserts the untouched values first, then edits.
 *
 * Checks, in order:
 *   1. an untouched game computes the shipped HUD/loading/phone/terminal values
 *   2. the panel builds every control from the model, on 8 and from the debug menu
 *   3. a slider, a colour, a toggle and a text field all reach the pixels —
 *      including the two canvas instruments, checked by sampling what they drew
 *   4. the theme survives a full reload
 *   5. switching the panel to TELEFONO previews the phone profile's numbers,
 *      and closing the panel puts the PC profile back
 *   6. a phone-shaped context takes the phone profile with no editor involved
 *   7. RIPRISTINA TUTTO returns every computed value to line 1
 *
 * Screenshots to .devtests/shots/hud-editor-*.png.
 *
 * Run: node .devtests/hud-editor-probe.mjs
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const failures = [];
const errors = [];
const notes = [];
// Printed as they happen: a probe that boots a whole game twice is long enough
// that a run interrupted halfway still has to be readable.
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label} = ${actual}`;
  notes.push(line);
  console.log(line);
};
const step = (label) => console.log(`--- ${label}`);

async function threeFromDisk(context) {
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const request = new URL(route.request().url());
    const addon = request.pathname.match(/examples\/jsm\/(.+)$/);
    const file = addon ? `node_modules/three/examples/jsm/${addon[1]}` : 'node_modules/three/build/three.module.js';
    try {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, file)) });
    } catch { await route.continue(); }
  });
}

/** Boots the game and drives out of the garage, so the HUD is on screen. */
async function drive(page) {
  await page.goto(url);
  await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 120000 });
  step('booted');
  await page.click('#new-game-button');
  await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 120000 });
  step('in the garage');
  await page.evaluate(() => window.shutoko.exitGarage());
  await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 60000 });
  step('driving');
  await page.evaluate(() => {
    const game = window.shutoko;
    game.physics.setSpeed?.(52);
    game.run.score = 128450; game.run.combo = 2.5; game.run.comboTimer = 3; game.run.lives = 2;
  });
  await page.waitForTimeout(300);
}

/** Computed styles, in one round trip, for everything the probe asserts on. */
const readStyles = () => {
  const of = (selector, property) => {
    const node = document.querySelector(selector);
    return node ? getComputedStyle(node)[property] : null;
  };
  return {
    scoreSize: of('.score-block strong', 'fontSize'),
    scoreColor: of('.score-block strong', 'color'),
    scoreLabel: document.querySelector('.score-block small')?.textContent,
    bankSize: of('.bank b', 'fontSize'),
    bankColor: of('.bank b', 'color'),
    minimapDisplay: of('#minimap-wrap', 'display'),
    minimapWidth: of('#minimap-wrap', 'width'),
    livesDisplay: of('.lives', 'display'),
    clusterDisplay: of('.cluster', 'display'),
    clusterTransform: of('.cluster', 'transform'),
    tachSize: of('.dial-tach', 'width'),
    gearColor: of('.gear', 'color'),
    fpsDisplay: of('.mobile-fps', 'display'),
    hudOpacity: of('#hud', 'opacity'),
    tlTransform: of('.hud-tl', 'transform'),
    loadTitle: document.querySelector('#loading b')?.textContent,
    loadTitleSize: of('#loading b', 'fontSize'),
    loadTitleColor: of('#loading b', 'color'),
    loadRingSize: of('.load-ring', 'width'),
    loadBarWidth: of('.loading .load-bar', 'width'),
    loadBg: of('#loading', 'backgroundColor'),
    phoneWidth: of('.phone', 'width'),
    phoneRadius: of('.phone-bezel', 'borderTopLeftRadius'),
    phoneInk: of('.phone-lcd', 'color'),
    appCols: of('.app-grid', 'gridTemplateColumns'),
    pcHeader: of('.pc>header', 'height'),
    pcMain: of('.pc main', 'height'),
    bootLogo: of('.boot-logo', 'fontSize'),
    bootTicker: document.querySelector('.boot-ticker-track span')?.textContent,
    green: getComputedStyle(document.documentElement).getPropertyValue('--green').trim(),
    greenSoft: getComputedStyle(document.documentElement).getPropertyValue('--green-soft').trim(),
    profile: document.documentElement.dataset.hudProfile,
    term: getComputedStyle(document.documentElement).getPropertyValue('--term').trim().slice(0, 16),
  };
};

// ---------------------------------------------------------------------------
// 1 · desktop: the shipped values, then the editor
// ---------------------------------------------------------------------------
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await threeFromDisk(context);
const page = await context.newPage();
page.on('dialog', (dialog) => dialog.accept());
page.on('pageerror', (error) => errors.push(String(error)));
await drive(page);

const shipped = await page.evaluate(readStyles);
check('untouched score size', shipped.scoreSize, '46px');
check('untouched score colour', shipped.scoreColor, 'rgb(226, 232, 221)');
check('untouched bank size', shipped.bankSize, '26px');
check('untouched minimap', `${shipped.minimapDisplay} ${shipped.minimapWidth}`, 'block 220px');
check('untouched tachometer', shipped.tachSize, '118px');
check('untouched cluster scale', shipped.clusterTransform, 'matrix(1, 0, 0, 1, 0, 0)');
check('untouched HUD nudge', shipped.tlTransform, 'matrix(1, 0, 0, 1, 0, 0)');
check('untouched FPS readout (desktop)', shipped.fpsDisplay, 'none');
check('untouched loading title', `${shipped.loadTitle} ${shipped.loadTitleSize}`, 'SHUTOKO NIGHTS 46px');
check('untouched loading title colour', shipped.loadTitleColor, 'rgb(255, 176, 46)');
check('untouched loading ring', shipped.loadRingSize, '58px');
check('untouched loading bar', shipped.loadBarWidth, '250px');
check('untouched phone width', shipped.phoneWidth, '336px');
check('untouched phone radius', shipped.phoneRadius, '34px');
check('untouched phone ink', shipped.phoneInk, 'rgb(36, 26, 68)');
check('untouched terminal header', shipped.pcHeader, '84px');
check('untouched palette', shipped.green, '#5cff8a');
check('untouched glow token', shipped.greenSoft.replace(/\s/g, ''), 'rgba(92,255,138,0.55)');
check('active profile', shipped.profile, 'desktop');
await page.screenshot({ path: join(OUT, 'hud-editor-01-default.png') });

// The panel: opened with 8, built from the model.
await page.keyboard.press('Digit8');
await page.waitForTimeout(200);
const panel = await page.evaluate(() => ({
  open: !document.getElementById('hud-editor').classList.contains('hidden'),
  controls: document.querySelectorAll('#hud-editor [data-hud-field]').length,
  sections: document.querySelectorAll('#hud-editor [data-hud-section]').length,
  tabs: [...document.querySelectorAll('#hud-editor [data-hud-device]')].map((button) => button.dataset.hudDevice),
  editing: document.querySelector('#hud-editor [data-hud-device].active')?.dataset.hudDevice,
  frozen: window.shutoko.debug.menuOpen,
}));
check('panel opens on 8', panel.open, true);
check('panel sections', panel.sections, 8);
check('panel controls', panel.controls > 110, true);
check('panel device tabs', panel.tabs.join(','), 'desktop,mobile');
check('panel opens on the live profile', panel.editing, 'desktop');
check('panel freezes the drive', panel.frozen, true);
await page.screenshot({ path: join(OUT, 'hud-editor-02-panel.png') });

/** Drives one control the way a finger would: input (live), then change (commit). */
async function setControl(page, key, value) {
  await page.evaluate(({ key, value }) => {
    const row = document.querySelector(`#hud-editor [data-hud-field="${key}"]`);
    const input = row?.querySelector('input,select');
    if (!input) throw new Error(`no control for ${key}`);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { key, value });
  await page.waitForTimeout(60);
}

// 3 · every control type reaches the pixels
await setControl(page, 'scoreSize', 96);
await setControl(page, 'scoreRole', 'cyan');
await setControl(page, 'colorGreen', '#ff4fd8');
await setControl(page, 'showMinimap', false);
await setControl(page, 'loadTitle', 'PROBE NIGHTS');
await setControl(page, 'hudOpacity', 0.6);
await setControl(page, 'tlY', 40);
await setControl(page, 'clusterScale', 1.4);
await setControl(page, 'fontScale', 1.5);
await setControl(page, 'fontTerm', 'mono');
await setControl(page, 'phoneRadius', 4);
await setControl(page, 'pcHeader', 120);
await setControl(page, 'bootTicker', 'PROBE TICKER · ');

const edited = await page.evaluate(readStyles);
check('score size follows the slider and the text scale', edited.scoreSize, '144px'); // 96 * 1.5
check('score colour follows the role', edited.scoreColor, 'rgb(65, 216, 242)');
check('bank colour follows the palette', edited.bankColor, 'rgb(255, 79, 216)');
check('glow token follows the palette', edited.greenSoft.replace(/\s/g, ''), 'rgba(255,79,216,0.55)');
check('minimap toggle', edited.minimapDisplay, 'none');
check('loading title text', edited.loadTitle, 'PROBE NIGHTS');
check('HUD opacity', edited.hudOpacity, '0.6');
check('HUD nudge', edited.tlTransform, 'matrix(1, 0, 0, 1, 0, 40)');
check('cluster scale', edited.clusterTransform, 'matrix(1.4, 0, 0, 1.4, 0, 0)');
check('terminal font family', edited.term.includes('monospace') || edited.term.includes('ui-mono'), true);
check('phone radius', edited.phoneRadius, '4px');
check('terminal header', edited.pcHeader, '120px');
// The terminal is closed while driving, so its height is reported unresolved.
// That is still the assertion that matters here: the header's property is the
// one the body's height subtracts.
check('terminal body follows the header', edited.pcMain, 'calc(100% - 120px)');
check('boot ticker text', edited.bootTicker, 'PROBE TICKER · ');
// The two canvas instruments: their colours are sampled from the same custom
// properties, so the only honest check is the pixels they actually paint.
await setControl(page, 'mapBg', '#ff00ff');
await setControl(page, 'dialFace', '#123456');
await page.keyboard.press('Digit8');
// The HUD does not repaint while a dev panel owns the screen, so the canvases
// are sampled after the panel closes and a frame has gone by.
await page.waitForTimeout(400);
const painted = await page.evaluate(() => {
  const hex = (r, g, b) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  const map = document.getElementById('minimap');
  const corner = map.getContext('2d').getImageData(1, 1, 1, 1).data;
  const dial = document.getElementById('gauge-speed');
  const pixels = dial.getContext('2d').getImageData(0, 0, dial.width, dial.height).data;
  let dialFacePixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (hex(pixels[index], pixels[index + 1], pixels[index + 2]) === '#123456') dialFacePixels += 1;
  }
  return { mapCorner: hex(corner[0], corner[1], corner[2]), dialFacePixels };
});
check('minimap background is painted with the theme colour', painted.mapCorner, '#ff00ff');
check('dial face is painted with the theme colour', painted.dialFacePixels > 100, true);
await page.screenshot({ path: join(OUT, 'hud-editor-03-restyled.png') });

// 4 · the theme survives a reload (it is in the runtime save, not in the panel)
await page.reload();
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 120000 });
await page.waitForTimeout(400);
const reloaded = await page.evaluate(readStyles);
check('reload keeps the score size', reloaded.scoreSize, '144px');
check('reload keeps the palette', reloaded.green, '#ff4fd8');
check('reload keeps the loading title', reloaded.loadTitle, 'PROBE NIGHTS');
await page.screenshot({ path: join(OUT, 'hud-editor-04-reloaded-boot.png') });

// 5 · the phone profile, previewed from the PC and then edited
await page.click('#continue-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 120000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 60000 });
await page.keyboard.press('Digit8');
await page.waitForTimeout(150);
await page.click('#hud-editor [data-hud-device="mobile"]');
await page.waitForTimeout(150);
const preview = await page.evaluate(readStyles);
check('preview switches to the phone profile', preview.profile, 'mobile');
check('preview shows the phone score size', preview.scoreSize, '30px');
// The numbers are the phone's; the *rules* are still the desktop's. The cluster
// is the clearest witness: the compact rule multiplies by .62 and is not in
// force here, so a preview reads matrix(1) while a real phone reads matrix(.62).
check('preview keeps the desktop layout rules', preview.clusterTransform, 'matrix(1, 0, 0, 1, 0, 0)');
await setControl(page, 'scoreSize', 44);
await setControl(page, 'showLives', false);
const phoneEdited = await page.evaluate(readStyles);
check('phone profile edit applies while previewed', phoneEdited.scoreSize, '44px');
check('phone profile toggle applies while previewed', phoneEdited.livesDisplay, 'none');
await page.screenshot({ path: join(OUT, 'hud-editor-05-phone-profile.png') });
await page.keyboard.press('Digit8');
await page.waitForTimeout(200);
const backToDesktop = await page.evaluate(readStyles);
check('closing the panel restores the live profile', backToDesktop.profile, 'desktop');
check('closing the panel restores the PC numbers', backToDesktop.scoreSize, '144px');
check('the PC profile kept its own lives toggle', backToDesktop.livesDisplay, 'flex');

// 7 · reset
await page.keyboard.press('Digit8');
await page.waitForTimeout(150);
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('#hud-editor .hud-editor-actions button')];
  buttons.find((button) => button.textContent.includes('RIPRISTINA TUTTO'))?.click();
});
await page.waitForTimeout(200);
await page.keyboard.press('Digit8');
await page.waitForTimeout(200);
const reset = await page.evaluate(readStyles);
for (const [key, value] of Object.entries(shipped)) {
  if (key === 'profile') continue;
  check(`reset restores ${key}`, reset[key], value);
}
await page.screenshot({ path: join(OUT, 'hud-editor-06-reset.png') });
await context.close();

// ---------------------------------------------------------------------------
// 6 · a phone-shaped context takes the phone profile on its own
// ---------------------------------------------------------------------------
const phoneContext = await browser.newContext({ ...devices['Pixel 5'] });
await threeFromDisk(phoneContext);
const phonePage = await phoneContext.newPage();
// NEW GAME asks for confirmation; with no handler Playwright dismisses the
// dialog, which silently answers "no" and the game never leaves the boot menu.
phonePage.on('dialog', (dialog) => dialog.accept());
phonePage.on('pageerror', (error) => errors.push(`[phone] ${String(error)}`));
await drive(phonePage);
const onPhone = await phonePage.evaluate(readStyles);
check('phone context profile', onPhone.profile, 'mobile');
check('phone context score size', onPhone.scoreSize, '30px');
check('phone context hides the minimap', onPhone.minimapDisplay, 'none');
check('phone context shows the FPS readout', onPhone.fpsDisplay, 'block');
// Pixel 5 is portrait, and the portrait variant has always scaled the cluster
// to .5 (the landscape one to .54, the base touch rule to .62). The multiplier
// defaults to 1 in every one of them, which is the point of it being a
// multiplier: an absolute phone value would have had to pick one of the three.
check('phone context compact cluster', onPhone.clusterTransform, 'matrix(0.5, 0, 0, 0.5, 0, 0)');
await phonePage.screenshot({ path: join(OUT, 'hud-editor-07-phone-default.png') });
// The panel has to be usable on the device whose HUD it edits: no keyboard, so
// it is reached through the debug menu.
await phonePage.evaluate(() => window.shutoko.toggleDebugMenu(true));
await phonePage.click('#debug-open-hud');
await phonePage.waitForTimeout(200);
const phonePanel = await phonePage.evaluate(() => ({
  open: !document.getElementById('hud-editor').classList.contains('hidden'),
  editing: document.querySelector('#hud-editor [data-hud-device].active')?.dataset.hudDevice,
  fits: document.getElementById('hud-editor').getBoundingClientRect().width <= window.innerWidth,
}));
check('panel opens from the debug menu with no keyboard', phonePanel.open, true);
check('panel opens on the phone profile there', phonePanel.editing, 'mobile');
check('panel fits the phone screen', phonePanel.fits, true);
await phonePage.screenshot({ path: join(OUT, 'hud-editor-08-phone-panel.png') });
await setControl(phonePage, 'scoreSize', 52);
await setControl(phonePage, 'showFps', false);
const phoneAfter = await phonePage.evaluate(readStyles);
check('phone edit applies on the phone', phoneAfter.scoreSize, '52px');
check('phone FPS toggle applies on the phone', phoneAfter.fpsDisplay, 'none');
await phonePage.evaluate(() => window.shutoko.setHudEditorOpen(false));
await phonePage.evaluate(() => { window.shutoko.ui.openPhone(window.shutoko.getPhoneContext()); });
await phonePage.waitForTimeout(400);
await phonePage.screenshot({ path: join(OUT, 'hud-editor-09-phone-keitai.png') });
await phoneContext.close();

await browser.close();
server.close();

console.log(notes.join('\n'));
console.log(`\npage errors: ${errors.length}`);
for (const error of errors) console.log(`  ${error}`);
console.log(`\n${failures.length ? `FAILURES (${failures.length}):` : 'all checks passed'}`);
for (const failure of failures) console.log(`  ${failure}`);
process.exit(failures.length || errors.length ? 1 : 0);
