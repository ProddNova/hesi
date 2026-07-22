// Surfaces editor + Modeler world-object library probe.
// Usage: node .devtests/surfaces-probe.mjs   (editor server on :8081)
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); };

await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 120000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.waitForTimeout(1500);

// ------------------------------------------------------- Surfaces overlay --
await page.click('[data-action="open-world-textures"]');
await page.waitForSelector('[data-testid="surfaces-overlay"]', { state: 'visible', timeout: 15000 });
await page.waitForTimeout(900);
check('surfaces overlay opens', true);
check('road card present', await page.locator('[data-testid="surface-card-road"]').count() > 0);
check('3d preview canvas', await page.locator('[data-testid="surfaces-3d"] canvas').count() > 0);
await page.screenshot({ path: path.join(OUT, 'surfaces-repeated.png') });

// Tiling control drives the live material.
const tileBefore = await page.evaluate(() => {
  const material = window.hesiEditor?.adapter?.map?.materials?.road;
  return material?.map ? material.map.repeat.toArray() : null;
});
await page.fill('[data-testid="surface-tile-meters"]', '4');
await page.dispatchEvent('[data-testid="surface-tile-meters"]', 'input');
await page.waitForTimeout(500);
const tileAfter = await page.evaluate(() => {
  const material = window.hesiEditor?.adapter?.map?.materials?.road;
  return material?.map ? material.map.repeat.toArray() : null;
});
check('metres-per-tile retiles the live road material', Boolean(tileBefore) && JSON.stringify(tileBefore) !== JSON.stringify(tileAfter), `${JSON.stringify(tileBefore)} -> ${JSON.stringify(tileAfter)}`);

// Rectangular tiles: unlink the two dimensions and stretch one of them.
await page.click('[data-testid="surface-tile-link"]');
await page.waitForTimeout(300);
await page.fill('[data-testid="surface-tile-meters-z"]', '24');
await page.dispatchEvent('[data-testid="surface-tile-meters-z"]', 'input');
await page.waitForTimeout(400);
const rect = await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.road?.map?.repeat?.toArray());
check('tiles can be stretched into rectangles', Boolean(rect) && Math.abs(rect[0] - rect[1]) > 1e-6, JSON.stringify(rect));
await page.screenshot({ path: path.join(OUT, 'surfaces-tile-shape.png') });
await page.click('[data-testid="surface-reset"]');
await page.waitForTimeout(400);

// Repeated objects tab: pick a building and tint it, then undo the override.
await page.click('[data-testid="surfaces-filter-object"]');
await page.waitForTimeout(300);
check('building card present', await page.locator('[data-testid="surface-card-facadeOffice"]').count() > 0);
check('building roof card present too', await page.locator('[data-testid="surface-card-building"]').count() > 0);
await page.click('[data-testid="surface-card-facadeOffice"]');
await page.waitForTimeout(700);
const tintBefore = await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.facadeOffice?.color?.getHexString());
await page.evaluate(() => {
  const input = document.querySelector('[data-testid="surface-tint"]');
  input.value = '#ff3366';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
const tintAfter = await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.facadeOffice?.color?.getHexString());
check('tint repaints every office building at once', tintBefore !== tintAfter && tintAfter === 'ff3366', `${tintBefore} -> ${tintAfter}`);

// Image fit modes, the same three the custom-object face editor offers.
const fitOptions = await page.locator('[data-testid="surface-fit"] option').allTextContents();
check('quad surfaces offer tile / stretch / fit & crop', fitOptions.join(',') === 'Tile,Stretch,Fit & crop', fitOptions.join(','));
await page.selectOption('[data-testid="surface-fit"]', 'cover');
await page.waitForTimeout(500);
check('fit & crop exposes the surface shape control', await page.locator('[data-testid="surface-aspect"]').count() > 0);
await page.screenshot({ path: path.join(OUT, 'surfaces-fit-crop.png') });
await page.selectOption('[data-testid="surface-fit"]', 'tile');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'surfaces-objects.png') });
await page.click('[data-testid="surface-reset"]');
await page.waitForTimeout(500);
const tintRestored = await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.facadeOffice?.color?.getHexString());
check('reset restores the generated colour', tintRestored === tintBefore, `${tintAfter} -> ${tintRestored} (was ${tintBefore})`);

await page.click('[data-testid="surfaces-close"]');
await page.waitForTimeout(400);

// -------------------------------------------- Modeler world-object library --
await page.click('[data-action="open-modeler"]');
await page.waitForSelector('[data-testid="modeler-overlay"]', { state: 'visible', timeout: 15000 });
await page.waitForTimeout(800);
const listBox = await page.locator('[data-testid="modeler-asset-list"]').boundingBox();
check('your-objects list is tall enough to browse', (listBox?.height || 0) > 240, `height ${Math.round(listBox?.height || 0)}px`);
await page.screenshot({ path: path.join(OUT, 'modeler-your-objects.png') });

await page.click('[data-testid="modeler-library-world"]');
await page.waitForTimeout(900);
check('world object list appears', await page.locator('[data-testid="modeler-world-object-list"]').isVisible());
check('container archetype listed', await page.locator('[data-testid="modeler-world-object-shippingContainer"]').count() > 0);
await page.click('[data-testid="modeler-world-object-shippingContainer"]');
await page.waitForTimeout(800);
check('paint controls shown for the archetype', await page.locator('[data-testid="world-texture-section"] [data-testid="surface-preview"]').isVisible());

// A multi-surface object must expose every surface it is made of.
await page.click('[data-testid="modeler-world-object-highwayLamp"]');
await page.waitForTimeout(900);
const lampSurfaces = await page.locator('[data-testid="modeler-world-surface-list"] > div').count();
check('a lamp exposes both of its surfaces', lampSurfaces === 2, `${lampSurfaces} rows`);
check('mast surface row present', await page.locator('[data-testid="modeler-world-surface-concrete"]').count() > 0);
check('lamp head surface row present', await page.locator('[data-testid="modeler-world-surface-lampSodium"]').count() > 0);

// Painting the second surface must reach the live material, not just the first.
await page.click('[data-testid="modeler-world-surface-lampSodium"] .modeler-face-pick');
await page.waitForTimeout(500);
const headBefore = await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.lampSodium?.color?.getHexString());
await page.evaluate(() => {
  const input = document.querySelector('[data-testid="world-texture-section"] [data-testid="surface-tint"]');
  input.value = '#22ddff';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
const headAfter = await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.lampSodium?.color?.getHexString());
check('the second surface of an object is editable', headAfter === '22ddff' && headBefore !== headAfter, `${headBefore} -> ${headAfter}`);
const buildingsUnchanged = await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.concrete?.color?.getHexString());
check('the object\'s other surface is untouched', buildingsUnchanged !== '22ddff', `concrete ${buildingsUnchanged}`);
await page.screenshot({ path: path.join(OUT, 'modeler-world-objects.png') });
await page.click('[data-testid="world-texture-section"] [data-testid="surface-reset"]');
await page.waitForTimeout(500);
check('reset restores the lamp head', await page.evaluate(() => window.hesiEditor?.adapter?.map?.materials?.lampSodium?.color?.getHexString()) === headBefore);

// Editing as parts must land in the custom library with real primitive parts:
// a lamp is a mast plus a head, both reshapeable and texturable.
await page.click('[data-testid="modeler-world-edit-as-parts"]');
await page.waitForTimeout(1000);
check('edit-as-parts switches to the custom library', await page.locator('[data-testid="modeler-asset-list"]').isVisible());
const partCount = await page.locator('.modeler-part-row').count();
check('edit-as-parts produces one editable part per surface', partCount === 2, `${partCount} parts`);
const faceRows = await page.locator('.modeler-face-row').count();
check('those parts expose faces to texture', faceRows >= 6, `${faceRows} face rows`);
await page.screenshot({ path: path.join(OUT, 'modeler-edit-as-model.png') });
check('switching back restores the modeler', await page.locator('[data-testid="modeler-asset-list"]').isVisible());

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} · ${entry.name}${entry.detail ? ` · ${entry.detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
console.log('CONSOLE ERRORS:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
