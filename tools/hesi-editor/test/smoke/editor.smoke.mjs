import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'hesi-editor', 'test', 'smoke', 'artifacts');
const PORT = 9600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT_PATH = 'data/editor/.test-smoke-project.json';
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
  await page.goto(`${BASE}/editor?project=${encodeURIComponent(PROJECT_PATH)}`, { waitUntil: 'domcontentloaded' });
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
  if (state.checkpoint !== 4 || state.strategy !== 'real' || !state.real) throw new Error(`Real adapter did not load: ${JSON.stringify(state)}`);
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
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.locator('[data-layer="Lamps"]').uncheck();
  if (await page.getByTestId('selected-entity-id').count()) throw new Error('Hidden selected entity remained selected');
  await page.locator('[data-layer="Lamps"]').check();
  await page.getByRole('button', { name: 'Hierarchy', exact: true }).click();
  await page.locator('[data-entity-id="lamp:wangan-0:0042"]').click();
  const originalX = await page.getByRole('spinbutton', { name: 'Position X' }).inputValue();
  await page.getByRole('spinbutton', { name: 'Position X' }).fill(String(Number(originalX) + 6));
  await page.getByRole('button', { name: 'Apply numeric transform', exact: true }).click();
  await page.waitForTimeout(300);
  const transformed = await page.evaluate(() => ({
    position: window.hesiEditor.selection.selected.object3D.position.toArray(),
    override: window.hesiEditor.projectState.getOverride('lamp:wangan-0:0042'),
    history: window.hesiEditor.history.state(),
    gizmoAttached: Boolean(window.hesiEditor.transformManager.control.object),
  }));
  if (Math.abs(transformed.position[0] - (Number(originalX) + 6)) > 0.01 || !transformed.override?.transform) throw new Error(`Numeric transform was not stored: ${JSON.stringify(transformed)}`);
  if (!transformed.history.canUndo || !transformed.gizmoAttached) throw new Error(`Transform controls/history are not live: ${JSON.stringify(transformed)}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  if (!await page.evaluate(() => window.hesiEditor.selection.selected.metadata.disabled)) throw new Error('Generated lamp was not disabled non-destructively');
  await page.getByRole('button', { name: 'Re-enable', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  const duplicated = await page.evaluate(() => {
    const placed = window.hesiEditor.selection.selected;
    const source = window.hesiEditor.registry.getById('lamp:wangan-0:0042');
    const json = JSON.stringify(window.hesiEditor.projectState.toJSON());
    return {
      id: placed.id,
      assetId: placed.assetId,
      placedCount: window.hesiEditor.projectState.toJSON().placedObjects.length,
      sharedGeometry: placed.object3D.children[0].geometry === source.metadata.instanceComponents[0].mesh.geometry,
      declarative: !/geometry|vertices|attributes/.test(json),
    };
  });
  if (!duplicated.id.startsWith('placed:') || duplicated.placedCount !== 1 || !duplicated.sharedGeometry || !duplicated.declarative) throw new Error(`Duplicate is not a declarative shared asset reference: ${JSON.stringify(duplicated)}`);
  await page.keyboard.press('Control+Z');
  if (await page.evaluate(() => window.hesiEditor.projectState.toJSON().placedObjects.length) !== 0) throw new Error('Undo did not remove duplicated placed object');
  await page.keyboard.press('Control+Shift+Z');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.screenshot({ path: path.join(OUT, 'checkpoint-3-real-lamp-editing.png'), fullPage: true });
  await page.locator('[data-action="save-project"]').click();
  await page.waitForFunction(() => window.hesiEditor.history.dirty === false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real' && window.hesiEditor.registry.has('placed:0001'), null, { timeout: 60000 });
  const persisted = await page.evaluate(() => ({
    checkpoint: window.hesiEditor.checkpoint,
    path: window.hesiEditor.persistence.currentPath,
    placed: window.hesiEditor.projectState.toJSON().placedObjects.length,
    lampX: window.hesiEditor.registry.getById('lamp:wangan-0:0042').object3D.position.x,
  }));
  if (persisted.checkpoint !== 4 || persisted.path !== PROJECT_PATH || persisted.placed !== 1 || Math.abs(persisted.lampX - (Number(originalX) + 6)) > 0.01) {
    throw new Error(`Disk project did not survive browser reload: ${JSON.stringify(persisted)}`);
  }
  await page.getByTestId('hierarchy-search').fill('placed:0001');
  await page.locator('[data-entity-id="placed:0001"]').click();
  await page.getByRole('button', { name: 'Project', exact: true }).last().click();
  await page.screenshot({ path: path.join(OUT, 'checkpoint-4-project-persistence.png'), fullPage: true });

  const demo = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await demo.goto(`${BASE}/editor?world=demo&project=${encodeURIComponent('data/editor/hesi-world-project.json')}`, { waitUntil: 'domcontentloaded' });
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
  console.log(`PASS real map default (${state.entities} semantic entities), fly/orbit, transform overrides, undo/redo, declarative duplication, explicit demo, disposal`);
  console.log(`SCREENSHOT ${path.join(OUT, 'checkpoint-3-real-lamp-editing.png')}`);
} finally {
  await browser?.close();
  child.kill();
  await rm(path.join(ROOT, PROJECT_PATH), { force: true });
  await rm(path.join(ROOT, `${PROJECT_PATH}.bak`), { force: true });
  await rm(path.join(ROOT, PROJECT_PATH.replace(/\.json$/i, '.autosave.json')), { force: true });
}
