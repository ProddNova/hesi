/**
 * The three things the road editor was reported broken for, checked in a real
 * browser against the real world:
 *
 *   1. Moving a point applies immediately — the route's asphalt, markings and
 *      barriers are regenerated in place, no Save Draft and no reload.
 *   2. A whole road can be deleted (points alone can never go below two), the
 *      deletion is reversible, and it is what Save Draft writes out.
 *   3. The saved draft actually reaches HighwayMap: the editor and the map must
 *      share ONE route document, not two module records of the same file.
 *
 * Screenshots land in tools/hesi-editor/.devtests/shots/road-live-edit/.
 *
 * Run: node tools/hesi-editor/.devtests/road-live-edit-probe.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SHOTS = path.join(ROOT, 'tools', 'hesi-editor', '.devtests', 'shots', 'road-live-edit');
const PORT = 9300 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT_PATH = 'data/editor/.test-road-live-edit.json';
const ROAD_SOURCE = path.join(ROOT, 'data', 'editor', 'road-route-overrides.json');
const ROUTE_ID = 'ramp_2';

await mkdir(SHOTS, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`);
};

const snapshot = await readFile(ROAD_SOURCE).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
// Run against an empty draft: the developer's own saved roads are honoured
// verbatim now, and a road they hid would make this probe measure nothing.
await writeFile(ROAD_SOURCE, `${JSON.stringify({
  version: 1, source: 'data/routes-smoothed.json', routes: {}, syntheticRoutes: {}, removedRoutes: [],
}, null, 2)}\n`);

const child = spawn(process.execPath, ['tools/hesi-editor/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, HESI_EDITOR_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Editor server did not start')), 15000);
  child.stdout.on('data', (data) => {
    if (String(data).includes('[hesi-editor] editor')) { clearTimeout(timer); resolve(); }
  });
  child.on('exit', (code) => reject(new Error(`Editor server exited early (${code})`)));
});

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${BASE}/editor?project=${encodeURIComponent(PROJECT_PATH)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 120000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });

  // --- 3. one shared route document -------------------------------------
  const shared = await page.evaluate(async () => {
    const map = window.hesiEditor.adapter.map;
    const controller = window.hesiEditor.roadEdit;
    const editorData = await controller._loadRouteData();
    const module = await import('/js/map.js?v=20260722b');
    return {
      exposed: typeof module.getRouteNetworkData === 'function',
      same: module.getRouteNetworkData?.() === editorData,
      hasLiveApi: typeof map.refreshEditorRouteGeometry === 'function'
        && typeof map.applyEditorDataRouteEdit === 'function'
        && typeof map.setEditorRouteRemoved === 'function',
    };
  });
  check('js/map.js exposes its route document', shared.exposed);
  check('the editor edits the very document HighwayMap built from', shared.same);
  check('the live road-geometry API is present', shared.hasLiveApi);

  // --- select the road ---------------------------------------------------
  await page.getByTestId('hierarchy-search').fill('Ramp 2');
  await page.locator(`[data-entity-id="road:${ROUTE_ID.replace(/_/g, '-')}"]`).first().click();
  await page.waitForFunction((id) => window.hesiEditor.roadEdit?.route?.id === id, ROUTE_ID, { timeout: 20000 });
  // --- 1. moving a point rebuilds the real road, live --------------------
  const baseline = await page.evaluate((id) => {
    const map = window.hesiEditor.adapter.map;
    const controller = window.hesiEditor.roadEdit;
    const index = Math.floor(controller.route.points.length / 2);
    controller._setActiveHandle(index);
    controller._refreshHandles({ force: true });
    controller.focusActivePoint();
    return {
      index,
      point: [...controller.route.points[index]],
      runtimePoints: map.routes.get(id).points.length,
      hasLiveGroup: map._editorRouteGeometry.has(id),
      erased: Boolean(map._routeEmissionRanges.get(id)?.erased),
    };
  }, ROUTE_ID);
  check('the road starts with its baked geometry intact', !baseline.hasLiveGroup && !baseline.erased);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, '1-before-move.png') });

  await page.evaluate(({ index, point }) => {
    const controller = window.hesiEditor.roadEdit;
    controller._setActiveHandle(index);
    controller.setActivePointPosition(point[0] + 45, point[1], point[2] + 45);
  }, baseline);
  await page.waitForFunction((id) => window.hesiEditor.adapter.map._editorRouteGeometry.has(id), ROUTE_ID, { timeout: 30000 });

  const afterMove = await page.evaluate(({ id, index }) => {
    const map = window.hesiEditor.adapter.map;
    const controller = window.hesiEditor.roadEdit;
    const group = map._editorRouteGeometry.get(id);
    let meshes = 0;
    let vertices = 0;
    group?.traverse((object) => {
      if (!object.isMesh) return;
      meshes += 1;
      vertices += object.geometry?.attributes?.position?.count || 0;
    });
    const edited = controller.route.points[index];
    const runtime = map.routes.get(id);
    // The edited handle has to be somewhere on the rebuilt runtime curve.
    let nearest = Infinity;
    for (const live of runtime.points) {
      nearest = Math.min(nearest, Math.hypot(
        live.x - edited[0], live.y - (edited[1] + map.roadNetworkYOffset), live.z - edited[2],
      ));
    }
    const probe = runtime.curve.getPointAt(0.5);
    return {
      meshes,
      vertices,
      erased: Boolean(map._routeEmissionRanges.get(id)?.erased),
      nearest,
      dirty: controller.hasDirty(),
      liveGeometry: controller.liveGeometryRoutes.has(id),
      // Recorded so the delete/undo round trip below can be compared against
      // the state the road was actually in, not against a pristine world.
      roadInfoRouteId: map.getRoadInfo(probe.clone())?.routeId || null,
      gridEntries: [...map._grid.values()].flat().filter((entry) => entry.route === runtime).length,
    };
  }, { id: ROUTE_ID, index: baseline.index });
  check('the moved point produced live road geometry', afterMove.meshes > 0 && afterMove.vertices > 0,
    `${afterMove.meshes} meshes, ${afterMove.vertices} vertices`);
  check('the stale baked asphalt for that road was erased', afterMove.erased);
  check('the edit reached the runtime curve', afterMove.nearest < 1, `${afterMove.nearest.toFixed(2)} m from the nearest live vertex`);
  check('the road is marked dirty for Save Draft', afterMove.dirty);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, '2-after-move.png') });

  // --- 1b. the edited road stays clickable -------------------------------
  // Reported: "dopo che seleziono una volta e modifico la strada poi non me la
  // fa più selezionare". The rebuilt meshes are created after the editor's pick
  // index was built, so without their route marker nothing resolves them.
  const reselect = await page.evaluate((id) => {
    const app = window.hesiEditor;
    const map = app.adapter.map;
    const camera = app.viewport.camera;
    const rect = app.viewport.canvas.getBoundingClientRect();
    const group = map._editorRouteGeometry.get(id);
    camera.updateMatrixWorld(true);
    group.updateMatrixWorld(true);
    const Raycaster = app.selection.raycaster.constructor;
    const Vector2 = app.selection.pointer.constructor;
    // Cast at the centre of the viewport and report what the rebuilt road
    // resolves to, the same path SelectionManager.pick takes.
    const results = [];
    for (let sx = -0.5; sx <= 0.5; sx += 0.1) {
      for (let sy = -0.5; sy <= 0.5; sy += 0.1) {
        const caster = new Raycaster();
        caster.setFromCamera(new Vector2(sx, sy), camera);
        for (const hit of caster.intersectObject(group, true)) {
          results.push({
            resolvedByIndex: Boolean(app.adapter.resolveSelection?.(hit.object, hit.instanceId)),
            marker: hit.object.userData?.editorRoadPreview || null,
            client: {
              x: rect.left + (sx + 1) * rect.width * 0.5,
              y: rect.top + (1 - sy) * rect.height * 0.5,
            },
          });
        }
      }
    }
    return { hits: results.length, sample: results[0] || null };
  }, ROUTE_ID);
  check('the rebuilt road is hit by the selection raycast', reselect.hits > 0, `${reselect.hits} hits`);
  check('the rebuilt road carries its route marker', reselect.sample?.marker === ROUTE_ID,
    JSON.stringify(reselect.sample));

  // Deselect, then click the rebuilt asphalt: it has to select the road again.
  await page.evaluate(() => window.hesiEditor.selection.clear('probe'));
  await page.waitForFunction(() => window.hesiEditor.roadEdit?.active === false, null, { timeout: 10000 });
  await page.mouse.click(Math.round(reselect.sample.client.x), Math.round(reselect.sample.client.y));
  await page.waitForTimeout(400);
  const reselected = await page.evaluate(() => ({
    selected: window.hesiEditor.selection.selected?.metadata?.routeId || null,
    type: window.hesiEditor.selection.selected?.type || null,
    editing: window.hesiEditor.roadEdit?.active === true,
  }));
  check('clicking the edited road selects it again', reselected.selected === ROUTE_ID && reselected.editing,
    JSON.stringify(reselected));

  // --- 2. deleting the whole road ----------------------------------------
  const removeButton = page.getByTestId('road-remove');
  check('the Road panel offers Delete road', await removeButton.count() > 0,
    await removeButton.count() ? await removeButton.textContent() : 'button missing');
  await removeButton.click();
  await page.waitForFunction((id) => window.hesiEditor.adapter.map.routes.get(id)?.removed === true, ROUTE_ID, { timeout: 20000 });
  const afterRemove = await page.evaluate((id) => {
    const map = window.hesiEditor.adapter.map;
    const route = map.routes.get(id);
    const probe = route.curve.getPointAt(0.5);
    return {
      removed: route.removed,
      liveGroup: map._editorRouteGeometry.has(id),
      roadInfoRouteId: map.getRoadInfo(probe.clone())?.routeId || null,
      gridEntries: [...map._grid.values()].flat().filter((entry) => entry.route === route).length,
      traffic: map.getTrafficLanes().some((lane) => lane.routeId === id),
      label: document.querySelector('[data-testid="road-remove"]')?.textContent,
    };
  }, ROUTE_ID);
  check('the road is deleted', afterRemove.removed && !afterRemove.liveGroup);
  check('the deleted road left the spatial index and the traffic network',
    afterRemove.gridEntries === 0 && afterRemove.roadInfoRouteId !== ROUTE_ID && !afterRemove.traffic,
    JSON.stringify(afterRemove));
  check('the button becomes Restore road', afterRemove.label === 'Restore road', afterRemove.label || '');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, '3-after-delete.png') });

  // --- Save Draft persists both the shape and the deletion ---------------
  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => window.hesiEditor.roadEdit.hasDirty() === false, null, { timeout: 60000 });
  const saved = await page.evaluate(async (id) => {
    const payload = await (await fetch('/__hesi_editor_routes', { cache: 'no-store' })).json();
    return {
      ok: payload.ok,
      removed: payload.document?.removedRoutes || [],
      points: payload.document?.routes?.[id]?.points?.length || 0,
    };
  }, ROUTE_ID);
  check('Save Draft wrote the deletion', saved.ok && saved.removed.includes(ROUTE_ID), JSON.stringify(saved.removed));
  check('Save Draft kept the edited centreline beside it', saved.points > 2, `${saved.points} points`);

  // --- undo brings the road back -----------------------------------------
  await page.evaluate(() => window.hesiEditor.history.undo());
  await page.waitForFunction((id) => window.hesiEditor.adapter.map.routes.get(id)?.removed !== true, ROUTE_ID, { timeout: 20000 });
  const afterUndo = await page.evaluate((id) => {
    const map = window.hesiEditor.adapter.map;
    const route = map.routes.get(id);
    const probe = route.curve.getPointAt(0.5);
    return {
      removed: route.removed,
      roadInfoRouteId: map.getRoadInfo(probe.clone())?.routeId || null,
      gridEntries: [...map._grid.values()].flat().filter((entry) => entry.route === route).length,
      traffic: map.getTrafficLanes().some((lane) => lane.routeId === id),
    };
  }, ROUTE_ID);
  check('undo restores the deleted road exactly as it was',
    !afterUndo.removed
      && afterUndo.gridEntries === afterMove.gridEntries
      && afterUndo.roadInfoRouteId === afterMove.roadInfoRouteId
      && afterUndo.traffic,
    JSON.stringify(afterUndo));
  await page.screenshot({ path: path.join(SHOTS, '4-after-undo.png') });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  child.kill();
  await rm(path.join(ROOT, PROJECT_PATH), { force: true });
  await rm(path.join(ROOT, `${PROJECT_PATH}.bak`), { force: true });
  if (snapshot == null) await rm(ROAD_SOURCE, { force: true });
  else await writeFile(ROAD_SOURCE, snapshot);
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'road live editing works end to end'}`);
console.log(`shots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
