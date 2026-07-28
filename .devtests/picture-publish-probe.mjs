/**
 * Test-game picture publishing probe.
 *
 * The workflow this checks is the whole point of `runtimeTuning.picture`: open
 * the game from the editor server with ?editorTest, move a dial on the dev
 * panel (0) or the filter panel (9), and have that value land in
 * data/editor/custom-assets.json — the file that is committed and deployed, so
 * every visitor to the site gets the look that was just tuned.
 *
 * It drives the REAL editor server (tools/hesi-editor/server.mjs), so it also
 * covers the server's own validation of the new section. The document is
 * snapshotted before the run and restored afterwards, including on failure —
 * this writes to a file that is under version control.
 *
 * Run: node .devtests/picture-publish-probe.mjs
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(ROOT, 'data', 'editor', 'custom-assets.json');
const PORT = 8123;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

const original = await readFile(ASSETS, 'utf8');
let server = null;
let browser = null;

try {
  server = spawn(process.execPath, [join(ROOT, 'tools', 'hesi-editor', 'server.mjs')], {
    cwd: ROOT, env: { ...process.env, HESI_EDITOR_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => process.stderr.write(`[editor] ${chunk}`));
  // Wait for the port rather than for a log line: the banner text is not a
  // contract, the listening socket is.
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/__hesi_editor_assets`, { method: 'HEAD' });
      if (response.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('editor server did not start');
    await new Promise((done) => setTimeout(done, 300));
  }

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('dialog', (dialog) => dialog.accept());

  // The editor server serves three from node_modules via the import map, so no
  // CDN routing is needed here.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?editorTest`);
  await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 90000 });
  await page.waitForFunction(() => window.shutoko.editorCarAssets, null, { timeout: 30000 });
  check('the test game loads the editor document', true);

  // Move one dial on each panel, then wait past the publish debounce.
  await page.evaluate(() => {
    window.shutoko.setFilterParam('pixelLines', 208, true);
    window.shutoko.setVisualParam('shake', 75, true);
  });
  await page.waitForTimeout(2500);

  const saved = JSON.parse(await readFile(ASSETS, 'utf8'));
  check('a filter dial reaches the deployed document',
    saved.runtimeTuning?.picture?.filter?.pixelLines === 208,
    `pixelLines ${saved.runtimeTuning?.picture?.filter?.pixelLines}`);
  check('a dev-panel dial reaches the deployed document',
    saved.runtimeTuning?.picture?.cameraShake === 0.75,
    `cameraShake ${saved.runtimeTuning?.picture?.cameraShake}`);
  // Publishing must not disturb the rest of the document — this file also
  // carries every custom asset, texture reference and car model.
  const before = JSON.parse(original);
  check('publishing leaves the rest of the document alone',
    JSON.stringify(saved.assets) === JSON.stringify(before.assets)
      && JSON.stringify(saved.textures) === JSON.stringify(before.textures)
      && JSON.stringify(saved.carModels) === JSON.stringify(before.carModels)
      && JSON.stringify(saved.runtimeTuning.camera) === JSON.stringify(before.runtimeTuning.camera),
    `${Object.keys(saved.assets).length} assets · ${Object.keys(saved.textures).length} textures`);

  // The publisher records the signature it wrote, so the value it just saved is
  // not re-adopted (and re-announced) on the next boot.
  const revision = await page.evaluate(() => window.shutoko.state.pictureRevision);
  const expected = await page.evaluate(() => window.shutoko.currentPicture());
  check('the publisher records the revision it wrote', typeof revision === 'string' && revision.startsWith('fnv1a32:'),
    `${revision} · lines ${expected.filter.pixelLines}`);

  // A second browser is the visitor: it must boot straight into the published
  // values without ever having touched a panel.
  const visitor = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  const visitorPage = await visitor.newPage();
  visitorPage.on('dialog', (dialog) => dialog.accept());
  await visitorPage.goto(`http://127.0.0.1:${PORT}/index.html`);
  await visitorPage.waitForFunction(() => window.shutoko?.editorCarAssets, null, { timeout: 90000 });
  await visitorPage.waitForTimeout(600);
  const visitorPicture = await visitorPage.evaluate(() => ({
    lines: window.shutoko.admin.ps2Filter.pixelLines,
    shake: window.shutoko.admin.cameraShake,
    uniform: window.shutoko.vhs?.uniforms.uPixelLines.value ?? null,
  }));
  check('a plain visitor boots into the published picture',
    visitorPicture.lines === 208 && visitorPicture.shake === 0.75 && visitorPicture.uniform === 208,
    JSON.stringify(visitorPicture));

  check('no console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  server?.kill();
  // Always put the committed document back, whatever happened above.
  await writeFile(ASSETS, original);
}

const failed = results.filter((entry) => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · custom-assets.json restored`);
process.exit(failed.length ? 1 : 0);
