// Baseline usability walkthrough — drives the real editor UI, captures evidence.
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
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.waitForTimeout(1500);

// 1. Default view — what the user sees first (darkness check)
await page.screenshot({ path: path.join(OUT, 'base-1-default-view.png') });

// 2. Entire world view
await page.getByRole('button', { name: 'Entire world', exact: true }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, 'base-2-entire-world.png') });

// 3. Back to Tatsumi PA preset, select a lamp via hierarchy
await page.selectOption('.preset-select', 'tatsumi-pa');
await page.waitForTimeout(1000);
await page.getByTestId('hierarchy-search').fill('lamp:wangan-0:0042');
await page.locator('[data-entity-id="lamp:wangan-0:0042"]').click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, 'base-3-lamp-selected-bluebox.png') });

// 4. What does a click in the viewport center select? (simulated user click)
await page.mouse.click(800, 475);
await page.waitForTimeout(400);
const clicked = await page.evaluate(() => window.hesiEditor.selection.selected ? {
  id: window.hesiEditor.selection.selected.id,
  name: window.hesiEditor.selection.selected.name,
  type: window.hesiEditor.selection.selected.type,
} : null);
console.log('CLICK-SELECT:', JSON.stringify(clicked));
await page.screenshot({ path: path.join(OUT, 'base-4-click-select.png') });

// 5. Edit tab state
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, 'base-5-edit-tab.png') });

// 6. Report: entities, layers, asset registry content
const report = await page.evaluate(() => ({
  entities: window.hesiEditor.registry.list().length,
  assets: [...window.hesiEditor.assetRegistry.assets.keys()],
  selectionHelper: window.hesiEditor.selection.highlight.type,
  lightCount: (() => { let n = 0; window.hesiEditor.viewport.scene.traverse((o) => { if (o.isLight) n++; }); return n; })(),
  exposure: window.hesiEditor.viewport.renderer.toneMappingExposure,
  fog: window.hesiEditor.viewport.scene.fog?.density,
}));
console.log('REPORT:', JSON.stringify(report, null, 2));
console.log('ERRORS:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
