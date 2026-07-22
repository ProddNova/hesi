// Archetype model replacement round trip: model a world object, Save Object,
// and every instanced copy in the map must take the new shape — then go back.
// Restores data/editor/custom-assets.json afterwards.
// Usage: node .devtests/archetype-model-probe.mjs   (editor server on :8081)
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const ASSETS = fileURLToPath(new URL('../../../data/editor/custom-assets.json', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
await mkdir(OUT, { recursive: true });

const snapshot = await readFile(ASSETS, 'utf8');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); };
const errors = [];
let browser;

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 120000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
  await page.waitForTimeout(1500);

  // Counts the vertices the container bucket draws: the fingerprint of its shape.
  const shapeOf = (instanceType) => page.evaluate((type) => {
    const map = window.hesiEditor?.adapter?.map;
    for (const chunk of [...(map?._chunks?.values?.() || [])]) {
      for (const object of chunk.group?.children || []) {
        if (object.isInstancedMesh && String(object.name).replace(/^chunk\s+\S+\s+/, '') === type) {
          return { vertices: object.geometry.getAttribute('position').count, count: object.count };
        }
      }
    }
    return null;
  }, instanceType);

  await page.click('[data-action="open-modeler"]');
  await page.waitForSelector('[data-testid="modeler-overlay"]', { state: 'visible', timeout: 15000 });
  await page.click('[data-testid="modeler-library-world"]');
  await page.waitForTimeout(800);
  await page.click('[data-testid="modeler-world-object-shippingContainer"]');
  await page.waitForTimeout(800);

  const before = await shapeOf('box:container');
  check('the container bucket is instanced', Boolean(before?.count), `${before?.count} copies, ${before?.vertices} verts`);
  await page.screenshot({ path: path.join(OUT, 'archetype-before.png') });

  // Model it: open as editable parts, then add a second part so the shape
  // genuinely differs from the generated single box.
  await page.click('[data-testid="modeler-world-edit-as-model"]');
  await page.waitForTimeout(900);
  check('modelling a world object opens the custom library', await page.locator('[data-testid="modeler-asset-list"]').isVisible());
  await page.click('.modeler-add-parts button[data-kind="cylinder"]');
  await page.waitForTimeout(500);
  const partCount = await page.locator('.modeler-part-row').count();
  check('a part was added to the archetype model', partCount >= 2, `${partCount} parts`);

  await page.click('.modeler-header button:has-text("Save As Copy")');
  await page.waitForTimeout(2500);
  const after = await shapeOf('box:container');
  check('Save Object reshapes every copy in the map',
    Boolean(after) && after.vertices !== before.vertices && after.count === before.count,
    `${before.vertices} -> ${after?.vertices} verts across ${after?.count} copies`);
  const status = await page.textContent('.status-message').catch(() => '');
  check('the status says the world followed', /every shipping container/i.test(status || ''), (status || '').slice(0, 90));

  // The world-objects view must show the replacement, not the old shape.
  await page.click('[data-testid="modeler-library-world"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'archetype-after.png') });
  check('the world-objects view reports the replacement',
    /draws your object/i.test(await page.textContent('[data-testid="world-texture-section"]') || ''));

  // And it must survive a full reload, from the saved document alone.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 120000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
  await page.waitForTimeout(2000);
  const reloaded = await shapeOf('box:container');
  check('the replacement survives a reload', reloaded?.vertices === after?.vertices, `${reloaded?.vertices} verts`);

  // Back to the generated shape.
  await page.click('[data-action="open-modeler"]');
  await page.waitForSelector('[data-testid="modeler-overlay"]', { state: 'visible', timeout: 15000 });
  await page.click('[data-testid="modeler-library-world"]');
  await page.waitForTimeout(800);
  await page.click('[data-testid="modeler-world-object-shippingContainer"]');
  await page.waitForTimeout(700);
  await page.click('[data-testid="modeler-world-reset-model"]');
  await page.waitForTimeout(800);
  const restored = await shapeOf('box:container');
  check('reset puts the generated shape back', restored?.vertices === before.vertices, `${restored?.vertices} verts`);
} finally {
  await browser?.close();
  // The probe writes to the real document (Save Object persists); put it back.
  await writeFile(ASSETS, snapshot);
}

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} · ${entry.name}${entry.detail ? ` · ${entry.detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
console.log('CONSOLE ERRORS:', errors.length ? errors.join(' | ') : 'none');
console.log('custom-assets.json restored from snapshot');
process.exit(failed.length ? 1 : 0);
