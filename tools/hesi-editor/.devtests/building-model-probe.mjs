// Building model replacement round trip: open an office building as editable
// parts, Save Object, and every office block in the map must take the new
// shape — surviving a reload, and undone by "Back to generated shape".
// Restores data/editor/custom-assets.json afterwards.
// Usage: node .devtests/building-model-probe.mjs   (editor server on :8081)
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const ASSETS = fileURLToPath(new URL('../../../data/editor/custom-assets.json', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
await mkdir(OUT, { recursive: true });

const snapshot = await readFile(ASSETS, 'utf8');
// The probe measures the swap against the GENERATED buildings, so it has to
// start from a document that replaces none of them — otherwise a model the
// user already saved for a building type reads as "the swap did nothing".
// The snapshot above is written back untouched at the end either way.
{
  const document = JSON.parse(snapshot);
  const cleared = Object.fromEntries(
    Object.entries(document.worldModels || {}).filter(([key]) => !key.startsWith('facade:')),
  );
  if (Object.keys(cleared).length !== Object.keys(document.worldModels || {}).length) {
    await writeFile(ASSETS, JSON.stringify({ ...document, worldModels: cleared }, null, 2));
    console.log('starting from generated buildings (saved building models parked for the run)');
  }
}
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

  // The fingerprint of the swap: how many office facade triangles still draw
  // (a hidden building keeps its vertices but collapses its indices), and how
  // many instances the replacement mesh puts in their place.
  const shapeOf = (material) => page.evaluate((facade) => {
    const map = window.hesiEditor?.adapter?.map;
    let drawn = 0;
    let replaced = 0;
    for (const chunk of [...(map?._chunks?.values?.() || [])]) {
      for (const object of chunk.group?.children || []) {
        const suffix = String(object.name).replace(/^chunk\s+\S+\s+/, '');
        if (suffix === facade && object.geometry?.index) {
          const index = object.geometry.index.array;
          for (let i = 0; i < index.length; i += 3) {
            if (index[i] !== index[i + 1] || index[i] !== index[i + 2]) drawn += 1;
          }
        }
        if (suffix === `facade:${facade}` && object.isInstancedMesh) replaced += object.count;
      }
    }
    return { drawn, replaced, boxes: (map?.buildingBoxes || []).filter((box) => box.material === facade).length };
  }, material);

  const before = await shapeOf('facadeOffice');
  check('the map keeps a per-copy record of every office building',
    before.boxes > 0 && before.drawn > 0 && before.replaced === 0,
    `${before.boxes} boxes, ${before.drawn} facade triangles drawn`);

  // The other building types must be independent of it: one archetype at a
  // time is the whole point of the world-object list.
  const otherTypes = ['facadeDark', 'facadeHotel', 'facadeIndustrial'];
  const othersBefore = {};
  for (const type of otherTypes) othersBefore[type] = await shapeOf(type);
  check('each building type is its own population',
    otherTypes.every((type) => othersBefore[type].boxes > 0),
    otherTypes.map((type) => `${type} ${othersBefore[type].boxes}`).join(', '));

  await page.click('[data-action="open-modeler"]');
  await page.waitForSelector('[data-testid="modeler-overlay"]', { state: 'visible', timeout: 15000 });
  await page.click('[data-testid="modeler-library-world"]');
  await page.waitForTimeout(800);
  await page.click('[data-testid="modeler-world-object-officeBlock"]');
  await page.waitForTimeout(800);
  check('the office building offers the model round trip',
    /copies in the map take the new shape/i.test(await page.textContent('[data-testid="world-texture-section"]') || ''));
  await page.screenshot({ path: path.join(OUT, 'building-before.png') });

  // Open it as parts and change the shape enough to be unmistakable.
  await page.click('[data-testid="modeler-world-edit-as-model"]');
  await page.waitForTimeout(900);
  await page.click('.modeler-add-parts button[data-kind="cylinder"]');
  await page.waitForTimeout(500);
  const partCount = await page.locator('.modeler-part-row').count();
  check('the archetype opened as editable parts', partCount >= 3, `${partCount} parts`);

  await page.click('.modeler-header button:has-text("Save Object")');
  await page.waitForTimeout(3000);
  const after = await shapeOf('facadeOffice');
  check('Save Object reshapes every office building in the map',
    after.replaced === before.boxes && after.drawn < before.drawn,
    `${after.replaced}/${before.boxes} replaced, facade triangles ${before.drawn} -> ${after.drawn}`);
  const status = await page.textContent('.status-message').catch(() => '');
  check('the status says the world followed',
    /every office block in the map now draws it/i.test(status || ''), (status || '').slice(0, 90));

  const othersAfter = {};
  for (const type of otherTypes) othersAfter[type] = await shapeOf(type);
  check('the other building types are left exactly as generated',
    otherTypes.every((type) => othersAfter[type].drawn === othersBefore[type].drawn && othersAfter[type].replaced === 0),
    otherTypes.map((type) => `${type} ${othersBefore[type].drawn}->${othersAfter[type].drawn}`).join(', '));

  await page.click('[data-testid="modeler-library-world"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'building-after.png') });
  check('the world-objects view reports the replacement',
    /draws your object/i.test(await page.textContent('[data-testid="world-texture-section"]') || ''));

  // Re-opening must edit THAT object, not mint yet another copy of it.
  await page.click('[data-testid="modeler-world-edit-as-model"]');
  await page.waitForTimeout(900);
  const reopened = await page.evaluate(() => {
    const panel = window.hesiEditor?.modeler;
    return { editing: panel?.definition?.id || null, replacement: panel?.store?.worldModel('facade:facadeOffice') || null };
  });
  check('re-opening edits the saved object instead of duplicating it',
    Boolean(reopened.editing) && reopened.editing === reopened.replacement,
    `editing ${reopened.editing}, map draws ${reopened.replacement}`);
  await page.click('[data-testid="modeler-library-world"]');
  await page.waitForTimeout(600);

  // And it must survive a full reload, from the saved document alone.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 120000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
  await page.waitForTimeout(2500);
  const reloaded = await shapeOf('facadeOffice');
  check('the replacement survives a reload',
    reloaded.replaced === after.replaced && reloaded.drawn === after.drawn,
    `${reloaded.replaced} replaced, ${reloaded.drawn} facade triangles`);

  // Back to the generated shape.
  await page.click('[data-action="open-modeler"]');
  await page.waitForSelector('[data-testid="modeler-overlay"]', { state: 'visible', timeout: 15000 });
  await page.click('[data-testid="modeler-library-world"]');
  await page.waitForTimeout(800);
  await page.click('[data-testid="modeler-world-object-officeBlock"]');
  await page.waitForTimeout(700);
  await page.click('[data-testid="modeler-world-reset-model"]');
  await page.waitForTimeout(1200);
  const restored = await shapeOf('facadeOffice');
  check('reset puts every generated building back',
    restored.drawn === before.drawn && restored.replaced === 0,
    `${restored.drawn} facade triangles, ${restored.replaced} replaced`);
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
