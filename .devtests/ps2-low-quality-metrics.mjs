/**
 * Low-quality renderer metrics for the mobile comparison: loads the game,
 * switches quality to Low (hides pool/streak effect layers, 0.55 render
 * scale) and records renderer.info at the chase fixture.
 *
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/ps2-low-quality-metrics.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const file = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
page.on('dialog', (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => { window.shutoko.changeSetting('quality', 'low'); window.shutoko.exitGarage(); });
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.waitForTimeout(1200);
const info = await page.evaluate(() => {
  const g = window.shutoko;
  return {
    drawCalls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    textures: g.renderer.info.memory.textures,
    bufferWidth: g.renderer.domElement.width,
    bufferHeight: g.renderer.domElement.height,
  };
});
console.log('LOW QUALITY', JSON.stringify(info));
await browser.close();
server.close();
