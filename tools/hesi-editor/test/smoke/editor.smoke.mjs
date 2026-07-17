import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'hesi-editor', 'test', 'smoke', 'artifacts');
const PORT = 9600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
await mkdir(OUT, { recursive: true });

const child = spawn(process.execPath, ['tools/hesi-editor/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, HESI_EDITOR_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Editor server did not start')), 10000);
  child.stdout.on('data', (data) => {
    if (String(data).includes('[hesi-editor] editor')) { clearTimeout(timer); resolve(); }
  });
  child.stderr.on('data', (data) => process.stderr.write(data));
  child.on('exit', (code) => reject(new Error(`Editor server exited early (${code})`)));
});

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 60000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });

  const state = await page.evaluate(() => ({
    checkpoint: window.hesiEditor.checkpoint,
    strategy: window.hesiEditor.adapter.strategy,
    real: window.hesiEditor.adapter.isRealWorld,
    routes: window.hesiEditor.adapter.metadata.routeCount,
    chunks: window.hesiEditor.adapter.metadata.chunkCount,
    children: window.hesiEditor.adapter.group.children.length,
    warning: document.querySelector('[data-testid="world-warning"]')?.hidden,
    game: Boolean(window.shutoko),
    entities: window.hesiEditor.registry.list().length,
    layers: window.hesiEditor.registry.layers(),
  }));
  if (state.checkpoint !== 2 || state.strategy !== 'real' || !state.real) throw new Error(`Real adapter did not load: ${JSON.stringify(state)}`);
  if (state.routes < 60 || state.chunks < 1 || state.children < 1) throw new Error(`Real world inventory is incomplete: ${JSON.stringify(state)}`);
  if (state.entities < 10000 || state.layers.some((layer) => layer.count < 1)) throw new Error(`Semantic registry is incomplete: ${JSON.stringify(state)}`);
  if (!state.warning) throw new Error('Demo/fallback warning is visible in real mode');
  if (state.game) throw new Error('Production gameplay booted inside the editor');

  await page.getByRole('button', { name: 'Fly', exact: true }).click();
  const before = await page.evaluate(() => window.hesiEditor.viewport.camera.position.toArray());
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(350);
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => window.hesiEditor.viewport.camera.position.toArray());
  if (before.every((value, index) => Math.abs(value - after[index]) < 0.01)) throw new Error('Fly camera did not move');
  await page.getByRole('button', { name: 'Fast', exact: true }).click();
  await page.getByRole('button', { name: 'Orbit', exact: true }).click();
  await page.selectOption('.preset-select', 'tatsumi-pa');
  await page.waitForTimeout(800);
  await page.getByTestId('hierarchy-search').fill('lamp:wangan-0:0042');
  await page.locator('[data-entity-id="lamp:wangan-0:0042"]').click();
  if (await page.getByTestId('selected-entity-id').textContent() !== 'lamp:wangan-0:0042') throw new Error('Hierarchy and inspector selection are not synchronized');
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await page.locator('[data-layer="Lamps"]').uncheck();
  if (await page.getByTestId('selected-entity-id').count()) throw new Error('Hidden selected entity remained selected');
  await page.locator('[data-layer="Lamps"]').check();
  await page.locator('[data-entity-id="lamp:wangan-0:0042"]').click();
  await page.screenshot({ path: path.join(OUT, 'checkpoint-2-real-lamp-selection.png'), fullPage: true });

  const demo = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await demo.goto(`${BASE}/editor?world=demo`, { waitUntil: 'domcontentloaded' });
  await demo.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'demo', null, { timeout: 20000 });
  const demoState = await demo.evaluate(() => ({ strategy: window.hesiEditor.adapter.strategy, real: window.hesiEditor.adapter.isRealWorld }));
  if (demoState.strategy !== 'demo' || demoState.real) throw new Error(`Explicit demo mode failed: ${JSON.stringify(demoState)}`);
  await demo.close();

  const disposed = await page.evaluate(() => {
    window.hesiEditor.dispose();
    return { entities: window.hesiEditor.registry.list().length, canvasPresent: Boolean(document.querySelector('[data-testid="editor-canvas"]')) };
  });
  if (disposed.entities !== 0 || disposed.canvasPresent) throw new Error('Editor disposal left live registry or canvas state');
  if (errors.length) throw new Error(`Browser console errors: ${errors.join(' | ')}`);
  console.log(`PASS real map default (${state.entities} semantic entities), fly/orbit navigation, selection/filtering, explicit demo, disposal`);
  console.log(`SCREENSHOT ${path.join(OUT, 'checkpoint-2-real-lamp-selection.png')}`);
} finally {
  await browser?.close();
  child.kill();
}
