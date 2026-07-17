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
    if (String(data).includes('[hesi-editor] editor')) {
      clearTimeout(timer);
      resolve();
    }
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
  await page.goto(`${BASE}/editor`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.group?.children?.length > 0, null, { timeout: 20000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });

  const state = await page.evaluate(() => ({
    checkpoint: window.hesiEditor.checkpoint,
    entities: window.hesiEditor.registry.list().length,
    canvasWidth: window.hesiEditor.viewport.canvas.width,
    canvasHeight: window.hesiEditor.viewport.canvas.height,
    adapter: window.hesiEditor.adapter.strategy,
    layers: window.hesiEditor.registry.layers(),
  }));
  if (state.checkpoint !== 1) throw new Error(`Unexpected checkpoint: ${state.checkpoint}`);
  if (state.entities < 8) throw new Error(`Expected representative entities, got ${state.entities}`);
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) throw new Error('Viewport canvas did not initialize');
  if (state.adapter !== 'representative') throw new Error(`Unexpected adapter: ${state.adapter}`);
  if (!state.layers.every((layer) => layer.count > 0)) throw new Error('One or more required layers did not load');
  await page.locator('[data-layer="Buildings"]').uncheck();
  const hidden = await page.evaluate(() => window.hesiEditor.registry.listByLayer('Buildings')[0].object3D.visible === false);
  if (!hidden) throw new Error('Layer visibility did not update the scene');
  await page.locator('[data-layer="Buildings"]').check();
  await page.waitForFunction(() => document.querySelector('.status-bar')?.textContent.includes('FPS ') && !document.querySelector('.status-bar')?.textContent.includes('FPS --'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'checkpoint-1.png'), fullPage: true });
  await page.evaluate(() => window.hesiEditor.showError('Visible error state smoke check'));
  await page.waitForSelector('[data-testid="error-overlay"]', { state: 'visible' });
  await page.screenshot({ path: path.join(OUT, 'checkpoint-1-error-state.png'), fullPage: true });
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await page.waitForSelector('[data-testid="error-overlay"]', { state: 'hidden' });
  const disposed = await page.evaluate(() => {
    window.hesiEditor.dispose();
    return {
      entities: window.hesiEditor.registry.list().length,
      canvasPresent: Boolean(document.querySelector('[data-testid="editor-canvas"]')),
    };
  });
  if (disposed.entities !== 0 || disposed.canvasPresent) throw new Error('Editor disposal left live registry or canvas state');
  if (errors.length) throw new Error(`Browser console errors: ${errors.join(' | ')}`);
  console.log(`PASS editor page, viewport, adapter, registry, layers (${state.entities} entities)`);
  console.log(`SCREENSHOT ${path.join(OUT, 'checkpoint-1.png')}`);
  console.log(`SCREENSHOT ${path.join(OUT, 'checkpoint-1-error-state.png')}`);
} finally {
  await browser?.close();
  child.kill();
}
