/**
 * Building model replacement, GAME side.
 *
 * The editor probe (tools/hesi-editor/.devtests/building-model-probe.mjs)
 * covers the round trip inside the editor. This one checks the other half of
 * the promise: that the playable game, booting from the saved document alone,
 * draws the replacement instead of the generated office blocks.
 *
 * Writes a temporary override into data/editor/custom-assets.json and restores
 * it afterwards.
 *
 * Run from repo root:  node .devtests/building-model-game-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(ROOT, 'data/editor/custom-assets.json');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : decodeURIComponent(path);
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const snapshot = await readFile(ASSETS, 'utf8');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const errors = [];
let browser;

try {
  // A three-part tower, unmistakably not the generated single box.
  const document = JSON.parse(snapshot);
  document.assets['custom:probe-tower'] = {
    id: 'custom:probe-tower',
    label: 'Probe tower',
    description: 'Building replacement probe',
    layer: 'Props',
    createdAt: new Date().toISOString(),
    parts: [
      { kind: 'box', name: 'Base', position: [0, 4, 0], rotation: [0, 0, 0], scale: [9, 8, 9], color: '#33405a', faces: {} },
      { kind: 'cylinder', name: 'Shaft', position: [0, 12, 0], rotation: [0, 0, 0], scale: [6, 8, 6], color: '#4a5a78', faces: {} },
      { kind: 'pyramid', name: 'Cap', position: [0, 18, 0], rotation: [0, 0, 0], scale: [5, 4, 5], color: '#6a7a98', faces: {} },
    ],
  };
  document.worldModels = { ...(document.worldModels || {}), 'facade:facadeOffice': 'custom:probe-tower' };
  await writeFile(ASSETS, JSON.stringify(document, null, 2));

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  // The page's import map points three AND three/addons/ at the CDN; serve the
  // whole tree from node_modules so the addons resolve to the same version
  // (a blanket redirect to three.module.js hands addon imports the core file).
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const file = route.request().url().split(/three@[^/]+\//)[1];
    if (!file) return route.abort();
    const body = await readFile(join(ROOT, 'node_modules/three', file));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
  // The editor documents are fetched and applied asynchronously after boot.
  await page.waitForTimeout(6000);

  const shape = await page.evaluate(() => {
    const map = window.shutoko.map;
    let drawn = 0;
    let replaced = 0;
    for (const chunk of [...(map?._chunks?.values?.() || [])]) {
      for (const object of chunk.group?.children || []) {
        const suffix = String(object.name).replace(/^chunk\s+\S+\s+/, '');
        if (suffix === 'facadeOffice' && object.geometry?.index) {
          const index = object.geometry.index.array;
          for (let i = 0; i < index.length; i += 3) {
            if (index[i] !== index[i + 1] || index[i] !== index[i + 2]) drawn += 1;
          }
        }
        if (suffix === 'facade:facadeOffice' && object.isInstancedMesh) replaced += object.count;
      }
    }
    return { drawn, replaced, boxes: (map?.buildingBoxes || []).filter((box) => box.material === 'facadeOffice').length };
  });

  check('the game keeps the per-copy building record', shape.boxes > 0, `${shape.boxes} office boxes`);
  check('the game draws the saved model on every office building',
    shape.replaced === shape.boxes && shape.drawn === 0,
    `${shape.replaced}/${shape.boxes} replaced, ${shape.drawn} generated facade triangles left`);
} finally {
  await browser?.close();
  server.close();
  await writeFile(ASSETS, snapshot);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('CONSOLE ERRORS:', errors.length ? errors.join(' | ') : 'none');
console.log('custom-assets.json restored from snapshot');
process.exit(failed.length ? 1 : 0);
