/**
 * The HUD editor, driven the way a person drives it, in a real browser.
 *
 * The unit tests prove the arithmetic and the tables; this proves the thing that
 * only exists on screen: that clicking a piece of the HUD selects it, that
 * dragging it moves it, that pulling a corner resizes it, that the phone preview
 * really is running the phone layout, and that what comes out of Save is a
 * document the *game* then renders — so the last act of the probe is to boot the
 * game and measure it.
 *
 * It runs against the editor's own dev server (the same one `npm run editor`
 * starts), on a test port, and restores data/editor/custom-assets.json
 * afterwards: the probe saves for real, because a save that is not exercised is
 * the half that breaks.
 *
 * Run: node .devtests/hud-tool-probe.mjs
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, '.devtests', 'shots');
const PORT = 9900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ASSETS = path.join(ROOT, 'data', 'editor', 'custom-assets.json');
const ASSETS_BACKUP = `${ASSETS}.bak`;
await mkdir(OUT, { recursive: true });

const snapshot = async (file) => {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const restore = async (file, bytes) => { if (bytes == null) await rm(file, { force: true }); else await writeFile(file, bytes); };
const assetsSnapshot = await snapshot(ASSETS);
const assetsBackupSnapshot = await snapshot(ASSETS_BACKUP);

const failures = [];
const errors = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${actual}`);
};
const near = (label, actual, expected, tolerance) => {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures.push(`${label}: expected ${expected} ±${tolerance}, got ${actual}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${actual} (±${tolerance} of ${expected})`);
};
const step = (label) => console.log(`--- ${label}`);

const server = spawn(process.execPath, ['tools/hesi-editor/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, HESI_EDITOR_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Editor server did not start')), 15000);
  server.stdout.on('data', (data) => { if (String(data).includes('[hesi-editor]')) { clearTimeout(timer); resolve(); } });
  server.stderr.on('data', (data) => process.stderr.write(data));
  server.on('exit', (code) => reject(new Error(`Editor server exited early (${code})`)));
});

/**
 * The game loads three.js from a CDN through its import map; the editor loads it
 * from its own node_modules. Serve the game's copy from disk so the probe does not
 * depend on the network to boot a game.
 */
async function threeFromDisk(context) {
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const request = new URL(route.request().url());
    const addon = request.pathname.match(/examples\/jsm\/(.+)$/);
    const file = addon ? `node_modules/three/examples/jsm/${addon[1]}` : 'node_modules/three/build/three.module.js';
    try {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(path.join(ROOT, file)) });
    } catch { await route.continue(); }
  });
}

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  // -------------------------------------------------------------------------
  // 1 · open the editor and the HUD panel
  // -------------------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(`[editor] ${String(error)}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`[editor console] ${message.text()}`); });
  await page.goto(`${BASE}/editor?project=${encodeURIComponent('data/editor/.test-hud-probe.json')}`, { waitUntil: 'domcontentloaded' });
  // The editor loads the real world before it publishes its global; on a cold
  // container that is minutes, not seconds.
  await page.waitForFunction(() => !!window.hesiEditor, null, { timeout: 240000 });
  step('editor up');
  await page.locator('[data-action="open-hud"]').click();
  await page.waitForSelector('[data-testid="hud-overlay"]', { state: 'visible', timeout: 60000 });
  // Both previews have to have built their document before anything is grabbable.
  await page.waitForFunction(() => {
    const panel = window.hesiEditor?.hud;
    return panel?.previews?.size === 2 && [...panel.previews.values()].every((preview) => preview.ready);
  }, null, { timeout: 60000 });
  step('HUD panel open');

  const built = await page.evaluate(() => {
    const panel = window.hesiEditor.hud;
    const pc = panel.previews.get('desktop');
    const phone = panel.previews.get('mobile');
    return {
      widgets: document.querySelectorAll('[data-testid="hud-overlay-desktop"] [data-hud-widget]').length,
      screens: document.querySelectorAll('[data-testid^="hud-screen-"]').length,
      // The preview is the game's own markup: these come from index.html.
      score: pc.doc.querySelector('#hud-score')?.textContent,
      pcProfile: pc.doc.documentElement.dataset.hudProfile,
      phoneProfile: phone.doc.documentElement.dataset.hudProfile,
      // …and the game's own stylesheet, in a real 393px viewport.
      pcMinimap: pc.frame.contentWindow.getComputedStyle(pc.doc.querySelector('#minimap-wrap')).display,
      phoneMinimap: phone.frame.contentWindow.getComputedStyle(phone.doc.querySelector('#minimap-wrap')).display,
      pcCluster: pc.frame.contentWindow.getComputedStyle(pc.doc.querySelector('.cluster')).transform,
      phoneCluster: phone.frame.contentWindow.getComputedStyle(phone.doc.querySelector('.cluster')).transform,
      phoneTouch: phone.frame.contentWindow.getComputedStyle(phone.doc.querySelector('#touch-controls')).display,
      dialPainted: pc.doc.querySelector('#gauge-speed')?.width > 0,
    };
  });
  check('widget boxes on the driving screen', built.widgets >= 8, true);
  check('screen tabs', built.screens, 5);
  check('preview uses the game markup', built.score, "128'450");
  check('PC preview profile', built.pcProfile, 'desktop');
  check('phone preview profile', built.phoneProfile, 'mobile');
  check('PC preview shows the minimap', built.pcMinimap, 'block');
  check('phone preview hides the minimap', built.phoneMinimap, 'none');
  check('PC preview cluster untouched', built.pcCluster, 'matrix(1, 0, 0, 1, 0, 0)');
  // 393px wide: the compact rules are genuinely in force in that frame, which is
  // the reason the preview is an iframe and not a scaled div.
  check('phone preview runs the compact layout', built.phoneCluster, 'matrix(0.62, 0, 0, 0.62, 0, 0)');
  check('phone preview shows the touch controls', built.phoneTouch, 'block');
  check('dials are painted in the preview', built.dialPainted, true);
  await page.screenshot({ path: path.join(OUT, 'hud-tool-01-open.png') });

  /** Drags inside a preview overlay, in overlay pixels. */
  async function dragBy(device, from, delta, { steps = 6 } = {}) {
    const box = await page.locator(`[data-testid="hud-overlay-${device}"]`).boundingBox();
    await page.mouse.move(box.x + from.x, box.y + from.y);
    await page.mouse.down();
    for (let index = 1; index <= steps; index += 1) {
      await page.mouse.move(box.x + from.x + (delta.x * index) / steps, box.y + from.y + (delta.y * index) / steps);
    }
    await page.mouse.up();
    await page.waitForTimeout(60);
  }

  /** The centre of a widget's marquee, in overlay pixels. */
  const widgetCentre = (device, id) => page.evaluate(({ device, id }) => {
    const node = document.querySelector(`[data-testid="hud-overlay-${device}"] [data-hud-widget="${id}"]`);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const parent = node.parentElement.getBoundingClientRect();
    return { x: box.left - parent.left + box.width / 2, y: box.top - parent.top + box.height / 2 };
  }, { device, id });

  // -------------------------------------------------------------------------
  // 2 · drag the score block on the PC preview
  // -------------------------------------------------------------------------
  const scoreCentre = await widgetCentre('desktop', 'score');
  check('the score block has a marquee', !!scoreCentre, true);
  const pcScale = await page.evaluate(() => window.hesiEditor.hud.previews.get('desktop').scale);
  await dragBy('desktop', scoreCentre, { x: 60, y: 40 });
  const afterDrag = await page.evaluate(() => {
    const panel = window.hesiEditor.hud;
    const pc = panel.previews.get('desktop');
    return {
      selected: panel.selected,
      device: panel.device,
      x: panel.theme.desktop.tlX,
      y: panel.theme.desktop.tlY,
      mobileX: panel.theme.mobile.tlX,
      applied: pc.doc.documentElement.style.getPropertyValue('--hud-tl-x').trim(),
      transform: pc.frame.contentWindow.getComputedStyle(pc.doc.querySelector('.hud-tl')).transform,
      dirty: panel.dirty,
    };
  });
  check('clicking selected the score block', afterDrag.selected, 'score');
  check('dragging in the PC frame edits the PC profile', afterDrag.device, 'desktop');
  // The drag is converted into preview pixels, so the field moves by the distance
  // travelled *in the frame*, not on the editor's screen.
  near('drag wrote tlX', afterDrag.x, 60 / pcScale, 4);
  near('drag wrote tlY', afterDrag.y, 40 / pcScale, 4);
  check('the phone profile was not touched', afterDrag.mobileX, 0);
  check('the preview took the property', afterDrag.applied, `${afterDrag.x}px`);
  check('the HUD element actually moved', afterDrag.transform.includes(`${afterDrag.y}`), true);
  check('the panel is dirty', afterDrag.dirty, true);

  // -------------------------------------------------------------------------
  // 3 · resize the cluster with a corner handle, on the phone preview
  // -------------------------------------------------------------------------
  await page.evaluate(() => window.hesiEditor.hud.select('cluster', 'mobile'));
  await page.waitForSelector('[data-testid="hud-handle-cluster-top-left"]');
  const handle = await page.locator('[data-testid="hud-handle-cluster-top-left"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  for (let index = 1; index <= 6; index += 1) await page.mouse.move(handle.x - (30 * index) / 6, handle.y - (30 * index) / 6);
  await page.mouse.up();
  await page.waitForTimeout(60);
  const afterResize = await page.evaluate(() => {
    const panel = window.hesiEditor.hud;
    const phone = panel.previews.get('mobile');
    return {
      scale: panel.theme.mobile.clusterScale,
      desktopScale: panel.theme.desktop.clusterScale,
      transform: phone.frame.contentWindow.getComputedStyle(phone.doc.querySelector('.cluster')).transform,
    };
  });
  check('pulling the corner outward grew the cluster', afterResize.scale > 1, true);
  check('the PC profile kept its own scale', afterResize.desktopScale, 1);
  // .62 (the compact rule) × the multiplier the handle wrote.
  near('the phone cluster is scaled by the product', Number(afterResize.transform.match(/matrix\(([\d.]+)/)[1]), 0.62 * afterResize.scale, 0.01);

  // -------------------------------------------------------------------------
  // 4 · keyboard nudge, visibility, per-widget reset, undo
  // -------------------------------------------------------------------------
  await page.evaluate(() => window.hesiEditor.hud.select('bank', 'desktop'));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('KeyV');
  const afterKeys = await page.evaluate(() => {
    const panel = window.hesiEditor.hud;
    const pc = panel.previews.get('desktop');
    return {
      x: panel.theme.desktop.trX,
      y: panel.theme.desktop.trY,
      shown: panel.theme.desktop.showBank,
      display: pc.frame.contentWindow.getComputedStyle(pc.doc.querySelector('.bank')).display,
    };
  });
  check('two right arrows nudged 4px', afterKeys.x, 4);
  check('one up arrow nudged -2px', afterKeys.y, -2);
  check('V hid the bank', afterKeys.shown, false);
  check('the preview hid it too', afterKeys.display, 'none');
  await page.keyboard.press('KeyR');
  const afterReset = await page.evaluate(() => {
    const panel = window.hesiEditor.hud;
    return { x: panel.theme.desktop.trX, shown: panel.theme.desktop.showBank, scoreStillMoved: panel.theme.desktop.tlX };
  });
  check('R reset the bank', `${afterReset.x} ${afterReset.shown}`, '0 true');
  check('R left the score block alone', afterReset.scoreStillMoved > 0, true);
  await page.keyboard.press('Control+z');
  const afterUndo = await page.evaluate(() => window.hesiEditor.hud.theme.desktop.trX);
  check('Ctrl+Z put the bank nudge back', afterUndo, 4);

  // -------------------------------------------------------------------------
  // 5 · the other screens, and an inspector control
  // -------------------------------------------------------------------------
  await page.locator('[data-testid="hud-screen-loading"]').click();
  await page.waitForTimeout(150);
  const loading = await page.evaluate(() => {
    const panel = window.hesiEditor.hud;
    const pc = panel.previews.get('desktop');
    return {
      screen: panel.screen,
      visible: pc.frame.contentWindow.getComputedStyle(pc.doc.querySelector('#loading')).display,
      hudHidden: pc.frame.contentWindow.getComputedStyle(pc.doc.querySelector('#hud')).display,
      widgets: document.querySelectorAll('[data-testid="hud-overlay-desktop"] [data-hud-widget]').length,
    };
  });
  check('the loading screen is previewed with its own display', `${loading.screen} ${loading.visible}`, 'loading flex');
  check('the driving HUD is out of the way', loading.hudHidden, 'none');
  check('the loading screen has its own widgets', loading.widgets >= 3, true);
  await page.locator('[data-testid="hud-input-loadTitle"]').fill('PROBE NIGHTS');
  await page.locator('[data-testid="hud-input-loadTitleSize"]').fill('92');
  await page.locator('[data-testid="hud-input-loadTitleSize"]').dispatchEvent('input');
  await page.waitForTimeout(80);
  const titled = await page.evaluate(() => {
    const pc = window.hesiEditor.hud.previews.get('desktop');
    const node = pc.doc.querySelector('#loading b');
    return { text: node.textContent, size: pc.frame.contentWindow.getComputedStyle(node).fontSize };
  });
  check('a text field reaches the preview', titled.text, 'PROBE NIGHTS');
  check('a size field reaches the preview', titled.size, '92px');
  await page.screenshot({ path: path.join(OUT, 'hud-tool-02-loading.png') });

  await page.locator('[data-testid="hud-screen-phone"]').click();
  await page.waitForTimeout(150);
  const phoneShell = await widgetCentre('mobile', 'phone');
  check('the phone shell is selectable on the phone screen', !!phoneShell, true);
  await page.locator('[data-testid="hud-screen-hud"]').click();
  await page.waitForTimeout(120);

  // -------------------------------------------------------------------------
  // 6 · save, and then let the GAME render what was saved
  // -------------------------------------------------------------------------
  const authored = await page.evaluate(() => {
    const panel = window.hesiEditor.hud;
    // One shared value too, so the probe checks both scopes survive the trip.
    panel._commit({ ...panel.theme, shared: { ...panel.theme.shared, colorGreen: '#ff4fd8' } }, 'probe palette');
    return { tlX: panel.theme.desktop.tlX, tlY: panel.theme.desktop.tlY, clusterScale: panel.theme.mobile.clusterScale };
  });
  await page.locator('[data-testid="hud-save"]').click();
  await page.waitForFunction(() => !window.hesiEditor.hud.dirty, null, { timeout: 30000 });
  const saved = JSON.parse(await readFile(ASSETS, 'utf8'));
  check('the document carries runtimeTuning.hud', !!saved.runtimeTuning?.hud, true);
  check('the saved PC nudge', saved.runtimeTuning.hud.desktop.tlX, authored.tlX);
  check('the saved shared palette', saved.runtimeTuning.hud.shared.colorGreen, '#ff4fd8');
  await page.screenshot({ path: path.join(OUT, 'hud-tool-03-saved.png') });

  // The game is the point of all of it: boot it and measure the HUD.
  const gameContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await threeFromDisk(gameContext);
  const gamePage = await gameContext.newPage();
  // newGame() asks for confirmation when it is reached through the boot button;
  // called directly it does not, but a stray dialog must never hang the probe.
  gamePage.on('dialog', (dialog) => dialog.accept());
  gamePage.on('pageerror', (error) => errors.push(`[game] ${String(error)}`));
  // Foreground it: a background tab has its animation frames throttled, and
  // Playwright's actionability check waits for two stable frames that never come.
  await gamePage.bringToFront();
  // `load` is not the readiness signal here — the module graph keeps fetching for
  // a while — and with several heavy pages in one browser it can miss 30s.
  await gamePage.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await gamePage.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 120000 });
  step('game booted');
  await gamePage.evaluate(() => window.shutoko.newGame());
  await gamePage.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 120000 });
  await gamePage.evaluate(() => window.shutoko.exitGarage());
  await gamePage.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 60000 });
  await gamePage.waitForTimeout(400);
  const inGame = await gamePage.evaluate(() => ({
    tlTransform: getComputedStyle(document.querySelector('.hud-tl')).transform,
    green: getComputedStyle(document.documentElement).getPropertyValue('--green').trim(),
    bankColor: getComputedStyle(document.querySelector('.bank b')).color,
    profile: document.documentElement.dataset.hudProfile,
    editorPanel: !!document.getElementById('hud-editor'),
  }));
  check('the game applied the published nudge', inGame.tlTransform, `matrix(1, 0, 0, 1, ${authored.tlX}, ${authored.tlY})`);
  check('the game applied the published palette', inGame.green, '#ff4fd8');
  check('and everything downstream of it followed', inGame.bankColor, 'rgb(255, 79, 216)');
  check('the game picked its own profile', inGame.profile, 'desktop');
  check('the playable build has no editor panel', inGame.editorPanel, false);
  await gamePage.screenshot({ path: path.join(OUT, 'hud-tool-04-game.png') });

  // A phone-shaped client takes the phone profile, including the cluster scale
  // the handle wrote in the editor. The desktop game is closed first: three heavy
  // pages in one browser is more than this container's compositor enjoys.
  await gameContext.close();
  const phoneContext = await browser.newContext({ ...devices['Pixel 5'] });
  await threeFromDisk(phoneContext);
  const phoneGame = await phoneContext.newPage();
  phoneGame.on('dialog', (dialog) => dialog.accept());
  phoneGame.on('pageerror', (error) => errors.push(`[phone game] ${String(error)}`));
  await phoneGame.bringToFront();
  await phoneGame.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await phoneGame.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 120000 });
  await phoneGame.evaluate(() => window.shutoko.newGame());
  await phoneGame.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 120000 });
  await phoneGame.evaluate(() => window.shutoko.exitGarage());
  await phoneGame.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 60000 });
  await phoneGame.waitForTimeout(400);
  const onPhone = await phoneGame.evaluate(() => ({
    profile: document.documentElement.dataset.hudProfile,
    cluster: getComputedStyle(document.querySelector('.cluster')).transform,
    tl: getComputedStyle(document.querySelector('.hud-tl')).transform,
  }));
  check('the phone takes the phone profile', onPhone.profile, 'mobile');
  // Portrait scales to .5, times the multiplier authored in the editor.
  near('the phone cluster carries the authored multiplier', Number(onPhone.cluster.match(/matrix\(([\d.]+)/)[1]), 0.5 * authored.clusterScale, 0.01);
  check('the PC nudge did not leak onto the phone', onPhone.tl, 'matrix(1, 0, 0, 1, 0, 0)');
  await phoneGame.screenshot({ path: path.join(OUT, 'hud-tool-05-game-phone.png') });
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await restore(ASSETS, assetsSnapshot);
  await restore(ASSETS_BACKUP, assetsBackupSnapshot);
  await rm(path.join(ROOT, 'data', 'editor', '.test-hud-probe.json'), { force: true });
  await rm(path.join(ROOT, 'data', 'editor', '.test-hud-probe.json.bak'), { force: true });
}

console.log(`\npage errors: ${errors.length}`);
for (const error of errors) console.log(`  ${error}`);
console.log(`\n${failures.length ? `FAILURES (${failures.length}):` : 'all checks passed'}`);
for (const failure of failures) console.log(`  ${failure}`);
process.exit(failures.length || errors.length ? 1 : 0);
