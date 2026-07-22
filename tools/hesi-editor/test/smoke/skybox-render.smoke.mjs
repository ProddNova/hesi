import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'hesi-editor', 'test', 'smoke', 'artifacts');
const PORT = 9900 + (process.pid % 90);
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${BASE}/editor?world=demo&project=${encodeURIComponent('data/editor/.test-skybox-render.json')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.skyboxController && document.querySelector('[data-testid="loading-overlay"]')?.hidden === true, null, { timeout: 30000 });

  await page.evaluate(() => {
    const app = window.hesiEditor;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = app.customAssetStore.addTextureFromDataUrl('skybox-render-smoke.png', canvas.toDataURL('image/png'));
    app.skyboxController.setTexture(texture);
  });
  await page.waitForFunction(() => {
    const mesh = window.hesiEditor.viewport.scene.getObjectByName('HESI infinite skybox');
    return mesh?.visible && mesh.material?.map?.image?.width > 0;
  });

  const pixel = await page.evaluate(() => {
    const app = window.hesiEditor;
    app.viewport.setWorldGroup(null);
    app.viewport.setGridVisible(false);
    app.viewport.scene.background.set('#000000');
    app.viewport.renderer.render(app.viewport.scene, app.viewport.camera);
    const gl = app.viewport.renderer.getContext();
    const rgba = new Uint8Array(4);
    gl.readPixels(
      Math.floor(app.viewport.renderer.domElement.width / 2),
      Math.floor(app.viewport.renderer.domElement.height / 2),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba,
    );
    return [...rgba];
  });
  if (pixel[0] < 180 || pixel[1] > 110 || pixel[2] < 180) throw new Error(`Skybox did not render into the viewport: RGBA ${pixel.join(',')}`);
  const screenshot = path.join(OUT, 'checkpoint-skybox-render.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  if (errors.length) throw new Error(`Browser console errors: ${errors.join(' | ')}`);
  console.log(`PASS skybox rendered as an infinite camera-centred environment · RGBA ${pixel.join(',')}`);
  console.log(`SCREENSHOT ${screenshot}`);
} finally {
  await browser?.close();
  child.kill();
}
