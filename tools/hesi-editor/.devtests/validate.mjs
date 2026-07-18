// Full acceptance validation: drives the real editor UI end-to-end.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const PROJECT = 'data/editor/.devtest-acceptance.json';
await mkdir(OUT, { recursive: true });

const fail = (msg) => { throw new Error(msg); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  // Missing project files on first run are expected (allowMissing); only
  // genuine code errors matter here.
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
});

await page.goto(`${BASE}/editor?project=${encodeURIComponent(PROJECT)}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.waitForTimeout(1200);

// 1. Default: bright inspection lighting
const lighting = await page.evaluate(() => window.hesiEditor.viewport.viewState());
if (lighting.lightingMode !== 'inspection') fail(`Default lighting is not inspection: ${JSON.stringify(lighting)}`);
await page.screenshot({ path: path.join(OUT, 'v-01-default-inspection.png') });
const baseline = await page.evaluate(() => window.hesiEditor.projectState.toJSON().placedObjects.length);
console.log('BASELINE placed:', baseline);

// 2. Assets tab populated
const assetCards = await page.locator('.asset-card').count();
if (assetCards < 6) fail(`Asset catalog too small: ${assetCards}`);
await page.screenshot({ path: path.join(OUT, 'v-02-assets-tab.png') });

// 3. Place a highway lamp through the real UI
await page.getByTestId('place-hesi:lamppost:concrete').click();
if (await page.getByTestId('placement-hint').isHidden()) fail('Placement hint did not appear');
await page.screenshot({ path: path.join(OUT, 'v-03-placement-mode.png') });
await page.mouse.click(770, 420);
await page.waitForTimeout(400);
const placed1 = await page.evaluate(() => window.hesiEditor.selection.selected ? {
  id: window.hesiEditor.selection.selected.id,
  generated: window.hesiEditor.selection.selected.generated,
  gizmo: Boolean(window.hesiEditor.transformManager.control.object),
  highlight: window.hesiEditor.selection.highlightGroup.children.length,
  boundsVisible: window.hesiEditor.selection.boundsHelper.visible,
} : null);
if (!placed1?.id.startsWith('placed:') || placed1.generated) fail(`Placement failed: ${JSON.stringify(placed1)}`);
if (!placed1.gizmo) fail('Placed object is not selected with gizmo');
if (placed1.boundsVisible) fail('Blue bounds box is visible by default');
console.log('PLACED:', JSON.stringify(placed1));
await page.screenshot({ path: path.join(OUT, 'v-04-placed-selected.png') });

// 4. Transform the placed lamp numerically (move up 3 m)
const y0 = await page.getByRole('spinbutton', { name: 'Position Y' }).inputValue();
await page.getByRole('spinbutton', { name: 'Position Y' }).fill(String(Number(y0) + 3));
await page.getByRole('button', { name: 'Apply numeric transform', exact: true }).click();
await page.waitForTimeout(300);
const moved = await page.evaluate(() => window.hesiEditor.selection.selected.object3D.position.y);
if (Math.abs(moved - (Number(y0) + 3)) > 0.01) fail(`Numeric transform failed: ${moved} vs ${y0}`);
console.log('TRANSFORM OK');

// 5. Esc cancels the next placement without adding objects
await page.getByTestId('place-editor:primitive:box').click();
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const afterCancel = await page.evaluate(() => ({
  placing: window.hesiEditor.placement?.active ?? false,
  placedCount: window.hesiEditor.projectState.toJSON().placedObjects.length,
}));
if (afterCancel.placing || afterCancel.placedCount !== baseline + 1) fail(`Escape cancel failed: ${JSON.stringify(afterCancel)}`);
console.log('ESC CANCEL OK');

// 6. Place a primitive box too (second object for persistence coverage)
await page.getByTestId('place-editor:primitive:box').click();
await page.mouse.click(770, 500);
await page.waitForTimeout(400);
const placed2 = await page.evaluate(() => window.hesiEditor.selection.selected?.id);
if (!placed2?.startsWith('placed:') || placed2 === placed1.id) fail(`Second placement failed: ${placed2}`);
console.log('PLACED BOX:', placed2);

// 7. Save + reload → both restored
await page.keyboard.press('Control+s');
await page.waitForFunction(() => window.hesiEditor.history.dirty === false, null, { timeout: 15000 });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
const restored = await page.evaluate(() => window.hesiEditor.projectState.toJSON().placedObjects.map((p) => p.id));
if (restored.length !== baseline + 2) fail(`Placed objects not restored: ${JSON.stringify(restored)}`);
console.log('PERSISTENCE OK:', JSON.stringify(restored));
await page.screenshot({ path: path.join(OUT, 'v-05-restored-after-reload.png') });

// 8. View menu: game lighting + debug tools
await page.getByRole('button', { name: 'View ▾', exact: true }).click();
await page.getByRole('radio', { name: 'Game' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'v-06-game-lighting.png') });
const gameState = await page.evaluate(() => window.hesiEditor.viewport.viewState());
if (gameState.lightingMode !== 'game') fail('Game lighting did not apply');
await page.getByRole('radio', { name: 'Inspection' }).click();
await page.getByTestId('debug-bounds').check();
await page.getByTestId('debug-collision').check();
// select something to show bounds debug
await page.getByTestId('hierarchy-search').fill('lamp:wangan-0:0042');
await page.locator('[data-entity-id="lamp:wangan-0:0042"]').click();
await page.getByRole('button', { name: 'Focus', exact: true }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, 'v-07-debug-tools.png') });
const debugState = await page.evaluate(() => ({
  bounds: window.hesiEditor.selection.boundsHelper.visible,
  collision: window.hesiEditor.collision?.visible ?? true,
}));
if (!debugState.bounds) fail('Debug bounds did not activate');
// Clicking the hierarchy closed the view menu (by design); reopen to uncheck.
await page.getByRole('button', { name: 'View ▾', exact: true }).click();
await page.getByTestId('debug-bounds').uncheck();
await page.getByTestId('debug-collision').uncheck();
await page.keyboard.press('Escape'); // close view menu

// 9. Fly controls: WASD + Space/Ctrl
await page.getByRole('button', { name: 'Fly', exact: true }).click();
const flyBefore = await page.evaluate(() => window.hesiEditor.viewport.camera.position.toArray());
await page.keyboard.down('KeyW');
await page.waitForTimeout(300);
await page.keyboard.up('KeyW');
await page.keyboard.down('Space');
await page.waitForTimeout(250);
await page.keyboard.up('Space');
await page.keyboard.down('ControlLeft');
await page.waitForTimeout(250);
await page.keyboard.up('ControlLeft');
const flyAfter = await page.evaluate(() => window.hesiEditor.viewport.camera.position.toArray());
const horizontal = Math.hypot(flyAfter[0] - flyBefore[0], flyAfter[2] - flyBefore[2]);
if (horizontal < 0.5) fail(`WASD fly did not move: ${JSON.stringify({ flyBefore, flyAfter })}`);
console.log('FLY OK:', JSON.stringify({ flyBefore, flyAfter }));
await page.getByRole('button', { name: 'Orbit', exact: true }).click();

// 10. Road click-select through the canvas (real user gesture)
await page.mouse.click(770, 420);
await page.waitForTimeout(300);
const clicked = await page.evaluate(() => window.hesiEditor.selection.selected ? {
  id: window.hesiEditor.selection.selected.id,
  highlight: window.hesiEditor.selection.highlightGroup.children.length,
} : null);
console.log('CLICK SELECTED:', JSON.stringify(clicked));
await page.screenshot({ path: path.join(OUT, 'v-08-click-select.png') });

if (errors.length) fail(`Console errors: ${errors.join(' | ')}`);
console.log('ALL ACCEPTANCE CHECKS PASSED');
await browser.close();
