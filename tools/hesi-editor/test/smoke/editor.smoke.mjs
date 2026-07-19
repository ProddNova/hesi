import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'hesi-editor', 'test', 'smoke', 'artifacts');
const PORT = 9600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT_PATH = 'data/editor/.test-smoke-project.json';
const BUILD_PATH = path.join(ROOT, 'data', 'editor', 'hesi-world-build.json');
const BUILD_BACKUP_PATH = `${BUILD_PATH}.bak`;
const ROAD_SOURCE_PATH = path.join(ROOT, 'data', 'editor', 'road-route-overrides.json');
const ROAD_SOURCE_BACKUP_PATH = `${ROAD_SOURCE_PATH}.bak`;
const ROUTE_JSON_PATH = path.join(ROOT, 'data', 'routes-smoothed.json');
const ROUTE_JSON_BACKUP_PATH = `${ROUTE_JSON_PATH}.bak`;
const ROUTE_MODULE_PATH = path.join(ROOT, 'data', 'routes-smoothed.js');
const ROUTE_MODULE_BACKUP_PATH = `${ROUTE_MODULE_PATH}.bak`;
await mkdir(OUT, { recursive: true });

const snapshotFile = async (file) => {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const restoreFile = async (file, snapshot) => {
  if (snapshot == null) await rm(file, { force: true });
  else await writeFile(file, snapshot);
};
const buildSnapshot = await snapshotFile(BUILD_PATH);
const buildBackupSnapshot = await snapshotFile(BUILD_BACKUP_PATH);
const roadSourceSnapshot = await snapshotFile(ROAD_SOURCE_PATH);
const roadSourceBackupSnapshot = await snapshotFile(ROAD_SOURCE_BACKUP_PATH);
const routeJsonSnapshot = await snapshotFile(ROUTE_JSON_PATH);
const routeJsonBackupSnapshot = await snapshotFile(ROUTE_JSON_BACKUP_PATH);
const routeModuleSnapshot = await snapshotFile(ROUTE_MODULE_PATH);
const routeModuleBackupSnapshot = await snapshotFile(ROUTE_MODULE_BACKUP_PATH);

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
  const saveLabels = await page.evaluate(() => ({
    draft: document.querySelector('[data-action="save-project"]')?.textContent,
    apply: document.querySelector('[data-action="rebuild-world"]')?.textContent,
  }));
  if (saveLabels.draft !== 'Save Draft' || saveLabels.apply !== 'Apply to Game') {
    throw new Error(`Draft/game actions are not explicit: ${JSON.stringify(saveLabels)}`);
  }

  // Playwright auto-scrolls toolbar buttons into view; on viewports narrower
  // than the toolbar that shifts the whole #app container sideways, and any
  // canvas screen-space math afterwards would click outside the real canvas.
  // The editor chrome is never meant to scroll, so zero stray offsets before
  // every coordinate-dependent interaction.
  const resetViewportScroll = () => page.evaluate(() => {
    for (const container of [document.getElementById('app'), document.documentElement, document.body]) {
      if (container) { container.scrollLeft = 0; container.scrollTop = 0; }
    }
  });

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

  // A rendered road surface is a merged chunk mesh, but clicking it must
  // resolve to the nearest semantic route and activate orange curve editing.
  await resetViewportScroll();
  const roadPickPoint = await page.evaluate(() => {
    const app = window.hesiEditor;
    const selection = app.selection;
    const rect = app.viewport.canvas.getBoundingClientRect();
    for (let y = 60; y < rect.height - 40; y += 45) {
      for (let x = 30; x < rect.width - 30; x += 45) {
        selection.pointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
        selection.raycaster.setFromCamera(selection.pointer, app.viewport.camera);
        const hits = selection.raycaster.intersectObject(app.adapter.group, true);
        const firstSelectable = hits
          .map((hit) => ({ hit, entity: app.adapter.resolveSelection?.(hit.object, hit.instanceId) }))
          .find(({ entity }) => selection.canSelect(entity));
        if (firstSelectable?.entity?.type === 'road-surface') {
          return { x: rect.left + x, y: rect.top + y, rawId: firstSelectable.entity.id };
        }
      }
    }
    return null;
  });
  if (!roadPickPoint) throw new Error('Could not find a visible road-surface pixel for click-to-route smoke coverage');
  await page.mouse.click(roadPickPoint.x, roadPickPoint.y);
  await page.waitForFunction(() => window.hesiEditor.selection.selected?.type === 'road-route' && Boolean(window.hesiEditor.roadEdit?.line));
  const clickedRoad = await page.evaluate(() => ({
    id: window.hesiEditor.selection.selected.id,
    type: window.hesiEditor.selection.selected.type,
    active: window.hesiEditor.roadEdit.active,
  }));
  if (!clickedRoad.active || clickedRoad.type !== 'road-route') {
    throw new Error(`Road surface click did not activate route editing: ${JSON.stringify({ roadPickPoint, clickedRoad })}`);
  }

  const alignedRoadControls = await page.evaluate(() => {
    const controller = window.hesiEditor.roadEdit;
    const handle = controller.handles[0];
    const sourcePoint = controller.route.points[handle?.userData?.pointIndex];
    return {
      handleCount: controller.handles.length,
      previewVertices: controller.previewMesh?.geometry?.getAttribute('position')?.count || 0,
      previewColor: controller.previewMesh?.material?.color?.getHexString?.() || '',
      markingCount: controller.previewMarkings?.children?.length || 0,
      draftEdgeCount: controller.previewMarkings?.children?.filter((child) => child.name.startsWith('draft ')).length || 0,
      yOffset: controller.yOffset,
      alignmentError: handle && sourcePoint
        ? Math.abs(handle.position.y - (sourcePoint[1] + controller.yOffset + 0.28))
        : Infinity,
    };
  });
  if (!alignedRoadControls.handleCount || alignedRoadControls.previewVertices < 4
    || alignedRoadControls.previewColor !== '171a23' || alignedRoadControls.markingCount < 4
    || alignedRoadControls.draftEdgeCount !== 2
    || alignedRoadControls.alignmentError > 0.001) {
    throw new Error(`Road controls/realistic asphalt preview are incomplete: ${JSON.stringify(alignedRoadControls)}`);
  }

  // Runtime-generated Tatsumi connectors must expose the same editing UX as
  // production routes. Exercise real right-click events: point removes,
  // orange road surface adds, and both rebuild the analytic collision curve.
  // Simulate a stale production module containing the same id. The runtime
  // route's explicit synthetic marker must still win, otherwise Save Draft
  // sends the route as production data and the server rejects it.
  await page.evaluate(() => {
    const controller = window.hesiEditor.roadEdit;
    const runtimeRoute = window.hesiEditor.adapter.map.routes.get('tatsumi_pa_exit');
    controller.routeData.routes.push({
      id: runtimeRoute.id,
      name: runtimeRoute.name,
      points: runtimeRoute.points.map((point) => point.toArray()),
    });
  });
  await page.getByTestId('hierarchy-search').fill('Tatsumi PA exit');
  await page.locator('[data-entity-id="road:tatsumi-pa-exit"]').click();
  await page.waitForFunction(() => window.hesiEditor.roadEdit?.route?.id === 'tatsumi_pa_exit'
    && window.hesiEditor.roadEdit?.synthetic === true);
  await page.evaluate(() => {
    const routes = window.hesiEditor.roadEdit.routeData.routes;
    const staleIndex = routes.findIndex((route) => route.id === 'tatsumi_pa_exit');
    if (staleIndex >= 0) routes.splice(staleIndex, 1);
  });
  await resetViewportScroll();
  const syntheticBaseline = await page.evaluate(() => {
    const app = window.hesiEditor;
    const controller = app.roadEdit;
    const camera = app.viewport.camera;
    const rect = app.viewport.canvas.getBoundingClientRect();
    camera.updateMatrixWorld(true);
    controller.group.updateMatrixWorld(true);
    const Vector3 = camera.position.constructor;
    const visibleInterior = controller.handles
      .filter((handle) => handle.userData.pointIndex > 0
        && handle.userData.pointIndex < controller.route.points.length - 1)
      .map((handle) => {
        const projected = handle.getWorldPosition(new Vector3()).project(camera);
        return {
          index: handle.userData.pointIndex,
          x: rect.left + (projected.x + 1) * rect.width * 0.5,
          y: rect.top + (1 - projected.y) * rect.height * 0.5,
          depth: projected.z,
        };
      })
      .filter((point) => point.depth > -1 && point.depth < 1
        && point.x > rect.left + 4 && point.x < rect.right - 4
        && point.y > rect.top + 4 && point.y < rect.bottom - 4)
      .sort((a, b) => Math.hypot(a.x - (rect.left + rect.width / 2), a.y - (rect.top + rect.height / 2))
        - Math.hypot(b.x - (rect.left + rect.width / 2), b.y - (rect.top + rect.height / 2)))[0];
    return {
      pointCount: controller.route.points.length,
      runtimePointCount: controller.runtimeRoute.points.length,
      previewVertices: controller.previewMesh.geometry.getAttribute('position').count,
      synthetic: controller.synthetic,
      yOffset: controller.yOffset,
      handleTarget: visibleInterior || null,
    };
  });
  if (!syntheticBaseline.synthetic || syntheticBaseline.yOffset !== 0 || !syntheticBaseline.handleTarget) {
    throw new Error(`Tatsumi PA exit did not enter editable synthetic-route mode: ${JSON.stringify(syntheticBaseline)}`);
  }
  const roadPointBeforeInterruptedDrag = await page.evaluate((index) => {
    const point = window.hesiEditor.roadEdit.route.points[index];
    return [point[0], point[2]];
  }, syntheticBaseline.handleTarget.index);
  await page.mouse.move(syntheticBaseline.handleTarget.x, syntheticBaseline.handleTarget.y);
  await page.mouse.down();
  await page.waitForFunction(() => Boolean(window.hesiEditor.roadEdit.drag));
  await page.mouse.move(syntheticBaseline.handleTarget.x + 18, syntheticBaseline.handleTarget.y + 10);
  await page.waitForFunction(() => window.hesiEditor.roadEdit.drag?.moved === true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  const roadDragRecovery = await page.evaluate((index) => {
    const app = window.hesiEditor;
    const point = app.roadEdit.route.points[index];
    return {
      point: [point[0], point[2]],
      dragging: Boolean(app.roadEdit.drag),
      navigationBlocked: app.viewport.isNavigationBlocked(),
      orbitEnabled: app.viewport.orbit.enabled,
      dirty: app.roadEdit.hasDirty(),
    };
  }, syntheticBaseline.handleTarget.index);
  if (roadDragRecovery.dragging || roadDragRecovery.navigationBlocked || !roadDragRecovery.orbitEnabled
    || roadDragRecovery.dirty
    || roadDragRecovery.point.some((value, index) => Math.abs(value - roadPointBeforeInterruptedDrag[index]) > 0.001)) {
    throw new Error(`Interrupted road drag left the editor blocked or mutated the route: ${JSON.stringify(roadDragRecovery)}`);
  }
  await page.mouse.click(syntheticBaseline.handleTarget.x, syntheticBaseline.handleTarget.y, { button: 'right' });
  await page.waitForFunction((count) => window.hesiEditor.roadEdit.route.points.length === count - 1,
    syntheticBaseline.pointCount);
  const deletedSynthetic = await page.evaluate(() => ({
    source: window.hesiEditor.roadEdit.route.points.length,
    runtime: window.hesiEditor.roadEdit.runtimeRoute.points.length,
  }));
  if (deletedSynthetic.source !== syntheticBaseline.pointCount - 1
    || deletedSynthetic.runtime !== deletedSynthetic.source) {
    throw new Error(`Right-click point deletion did not update live collision: ${JSON.stringify({ syntheticBaseline, deletedSynthetic })}`);
  }
  const syntheticDraftNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.keyboard.press('Control+S');
  await syntheticDraftNavigation;
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real'
    && window.hesiEditor.roadEdit?.route?.id === 'tatsumi_pa_exit'
    && window.hesiEditor.roadEdit?.synthetic === true, null, { timeout: 60000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
  const savedSynthetic = await page.evaluate(async () => {
    const response = await fetch('/__hesi_editor_routes', { cache: 'no-store' });
    const payload = await response.json();
    const saved = payload.document?.syntheticRoutes?.tatsumi_pa_exit;
    return {
      ok: response.ok && payload.ok,
      pointCount: saved?.points?.length || 0,
      dirty: window.hesiEditor.roadEdit.hasDirty(),
    };
  });
  if (!savedSynthetic.ok || savedSynthetic.pointCount !== syntheticBaseline.pointCount - 1
    || savedSynthetic.dirty) {
    throw new Error(`Synthetic route Save Draft payload is invalid: ${JSON.stringify(savedSynthetic)}`);
  }

  await resetViewportScroll();
  const addTarget = await page.evaluate(() => {
    const app = window.hesiEditor;
    const controller = app.roadEdit;
    const camera = app.viewport.camera;
    const rect = app.viewport.canvas.getBoundingClientRect();
    const Vector3 = camera.position.constructor;
    camera.updateMatrixWorld(true);
    controller.group.updateMatrixWorld(true);
    const project = (point) => {
      const projected = point.clone().project(camera);
      return {
        x: rect.left + (projected.x + 1) * rect.width * 0.5,
        y: rect.top + (1 - projected.y) * rect.height * 0.5,
        depth: projected.z,
      };
    };
    const handleScreens = controller.handles.map((handle) => project(handle.getWorldPosition(new Vector3())));
    const position = controller.previewMesh.geometry.getAttribute('position');
    const candidates = [];
    // Use either ribbon edge rather than its centreline: this remains on the
    // clickable orange surface while staying clear of dense point handles.
    for (let index = 0; index < position.count; index += 6) {
      const screen = project(new Vector3().fromBufferAttribute(position, index));
      if (screen.depth <= -1 || screen.depth >= 1
        || screen.x <= rect.left + 4 || screen.x >= rect.right - 4
        || screen.y <= rect.top + 4 || screen.y >= rect.bottom - 4) continue;
      screen.handleClearance = Math.min(...handleScreens.map((handle) => Math.hypot(screen.x - handle.x, screen.y - handle.y)));
      candidates.push(screen);
    }
    return candidates.sort((a, b) => b.handleClearance - a.handleClearance)[0] || null;
  });
  if (!addTarget || addTarget.handleClearance < 5) throw new Error(`Could not find a clear orange road-preview target: ${JSON.stringify(addTarget)}`);
  await page.mouse.click(addTarget.x, addTarget.y, { button: 'right' });
  await page.waitForFunction((count) => window.hesiEditor.roadEdit.route.points.length === count + 1,
    savedSynthetic.pointCount);
  const addedSynthetic = await page.evaluate(() => ({
    source: window.hesiEditor.roadEdit.route.points.length,
    runtime: window.hesiEditor.roadEdit.runtimeRoute.points.length,
    dirty: window.hesiEditor.roadEdit.hasDirty(),
    previewVertices: window.hesiEditor.roadEdit.previewMesh.geometry.getAttribute('position').count,
  }));
  if (addedSynthetic.runtime !== addedSynthetic.source || !addedSynthetic.dirty || addedSynthetic.previewVertices < 4) {
    throw new Error(`Right-click insertion did not update the live surface/collision preview: ${JSON.stringify(addedSynthetic)}`);
  }
  await page.screenshot({ path: path.join(OUT, 'checkpoint-road-tatsumi-editing.png'), fullPage: true });
  await page.keyboard.press('Control+Z');
  await page.waitForFunction((count) => window.hesiEditor.roadEdit.route.points.length === count,
    savedSynthetic.pointCount);
  await page.evaluate(() => window.hesiEditor.roadEdit.clearDirty());

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

  // Exercise the real TransformManager against a generated lamp. Dispatching
  // the same TransformControls lifecycle as a gizmo drag lets us assert the
  // local opposite face stays fixed on two axes, plus browser-level undo/redo
  // and inspector coherence, without depending on OS mouse acceleration.
  await page.getByRole('button', { name: 'Scale', exact: true }).click();
  const scaleRealLampAxis = (axis, component, factor) => page.evaluate(({ axis, component, factor }) => {
    const manager = window.hesiEditor.transformManager;
    const entity = window.hesiEditor.selection.selected;
    const object = entity.object3D;
    const bounds = manager._makeScaleAnchor(entity);
    const Vector3 = object.position.constructor;
    const localAnchor = new Vector3().fromArray(bounds.localMin);
    const beforeAnchor = object.localToWorld(localAnchor.clone()).toArray();
    const beforeTransform = {
      position: object.position.toArray(),
      scale: object.scale.toArray(),
    };
    manager.control.axis = axis;
    manager.control.dispatchEvent({ type: 'mouseDown' });
    object.scale.setComponent(component, object.scale.getComponent(component) * factor);
    manager.control.dispatchEvent({ type: 'objectChange' });
    const afterAnchor = object.localToWorld(localAnchor.clone()).toArray();
    const afterTransform = {
      position: object.position.toArray(),
      scale: object.scale.toArray(),
    };
    manager.control.dispatchEvent({ type: 'mouseUp' });
    return {
      anchorDrift: Math.hypot(...afterAnchor.map((value, index) => value - beforeAnchor[index])),
      beforeTransform,
      afterTransform,
    };
  }, { axis, component, factor });
  const xScale = await scaleRealLampAxis('X', 0, 1.4);
  const yScale = await scaleRealLampAxis('Y', 1, 1.25);
  if (xScale.anchorDrift > 0.02 || yScale.anchorDrift > 0.02) {
    throw new Error(`One-sided scale anchor drifted: ${JSON.stringify({ xScale, yScale })}`);
  }
  if (Math.abs(xScale.afterTransform.scale[0] - xScale.beforeTransform.scale[0]) < 0.01
    || Math.abs(yScale.afterTransform.scale[1] - yScale.beforeTransform.scale[1]) < 0.01) {
    throw new Error(`Scale handles did not extend the grabbed sides: ${JSON.stringify({ xScale, yScale })}`);
  }
  const scaleInspector = await page.evaluate(() => ({
    x: Number(document.querySelector('[aria-label="Scale X"]')?.value),
    y: Number(document.querySelector('[aria-label="Scale Y"]')?.value),
    object: window.hesiEditor.selection.selected.object3D.scale.toArray(),
  }));
  if (Math.abs(scaleInspector.x - scaleInspector.object[0]) > 0.001 || Math.abs(scaleInspector.y - scaleInspector.object[1]) > 0.001) {
    throw new Error(`Numeric scale inspector is stale: ${JSON.stringify(scaleInspector)}`);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const afterScaleUndo = await page.evaluate(() => window.hesiEditor.selection.selected.object3D.scale.toArray());
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const afterScaleRedo = await page.evaluate(() => window.hesiEditor.selection.selected.object3D.scale.toArray());
  if (Math.abs(afterScaleUndo[1] - yScale.beforeTransform.scale[1]) > 0.001
    || Math.abs(afterScaleRedo[1] - yScale.afterTransform.scale[1]) > 0.001) {
    throw new Error(`Scale undo/redo is incoherent: ${JSON.stringify({ afterScaleUndo, afterScaleRedo, yScale })}`);
  }
  // Leave the smoke project clean before its existing numeric-translate path.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  // Regression: a save that starts while TransformControls still owns the
  // pointer must close and commit that drag. Previously the live object moved,
  // but navigation, selection and persisted project state could stay stuck.
  const interruptedDrag = await page.evaluate(() => {
    const app = window.hesiEditor;
    const manager = app.transformManager;
    const entity = app.selection.selected;
    const beforeX = entity.object3D.position.x;
    const beforeHistoryIndex = app.history.state().index;
    manager.control.axis = 'X';
    manager.control.dragging = true;
    manager.control.dispatchEvent({ type: 'mouseDown' });
    entity.object3D.position.x += 1;
    manager.control.dispatchEvent({ type: 'objectChange' });
    return {
      beforeX,
      beforeHistoryIndex,
      pickingBlocked: app.selection._pickBlocked,
      navigationBlocked: app.viewport.isNavigationBlocked(),
      orbitEnabled: app.viewport.orbit.enabled,
    };
  });
  if (!interruptedDrag.pickingBlocked || !interruptedDrag.navigationBlocked || interruptedDrag.orbitEnabled) {
    throw new Error(`Active gizmo drag did not own interaction state: ${JSON.stringify(interruptedDrag)}`);
  }
  await page.locator('[data-action="save-project"]').click();
  await page.waitForFunction(() => window.hesiEditor.history.dirty === false);
  const recoveredDrag = await page.evaluate(() => {
    const app = window.hesiEditor;
    const entity = app.selection.selected;
    return {
      x: entity.object3D.position.x,
      historyIndex: app.history.state().index,
      override: app.projectState.getOverride(entity.id),
      savedOverride: app.persistence.lastSavedDocument?.entityOverrides?.[entity.id],
      dragStart: app.transformManager.dragStart,
      controlDragging: app.transformManager.control.dragging,
      pickingBlocked: app.selection._pickBlocked,
      navigationBlocked: app.viewport.isNavigationBlocked(),
      orbitEnabled: app.viewport.orbit.enabled,
    };
  });
  if (Math.abs(recoveredDrag.x - (interruptedDrag.beforeX + 1)) > 0.001
    || recoveredDrag.historyIndex !== interruptedDrag.beforeHistoryIndex + 1
    || !recoveredDrag.override?.transform || !recoveredDrag.savedOverride?.transform
    || recoveredDrag.dragStart || recoveredDrag.controlDragging || recoveredDrag.pickingBlocked
    || recoveredDrag.navigationBlocked || !recoveredDrag.orbitEnabled) {
    throw new Error(`Interrupted gizmo drag was not committed and released before save: ${JSON.stringify(recoveredDrag)}`);
  }
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
  // The bottom-panel tab, not an asset card's per-asset "Edit" button (saved
  // custom assets add one each and would make a role/name lookup ambiguous).
  await page.locator('.tab-button[data-tab="edit"]').click();
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
  const buildBeforeDraft = await snapshotFile(BUILD_PATH);
  await page.getByRole('button', { name: 'Fly', exact: true }).click();
  const beforeFlySave = await page.evaluate(() => window.hesiEditor.viewport.camera.position.toArray());
  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => window.hesiEditor.history.dirty === false);
  const afterFlySave = await page.evaluate(() => ({
    position: window.hesiEditor.viewport.camera.position.toArray(),
    heldKeys: window.hesiEditor.viewport.fly.keys.size,
  }));
  if (afterFlySave.heldKeys !== 0 || beforeFlySave.some((value, index) => Math.abs(value - afterFlySave.position[index]) > 0.01)) {
    throw new Error(`Ctrl+S moved the camera or left fly input active: ${JSON.stringify({ beforeFlySave, afterFlySave })}`);
  }
  await page.getByRole('button', { name: 'Orbit', exact: true }).click();
  const buildAfterDraft = await snapshotFile(BUILD_PATH);
  if (buildBeforeDraft == null ? buildAfterDraft != null : !buildBeforeDraft.equals(buildAfterDraft)) {
    throw new Error('Save Draft changed the playable game build file');
  }
  const draftBadges = await page.evaluate(() => ({
    draft: document.querySelector('[data-testid="dirty-state"]')?.textContent,
    game: document.querySelector('[data-testid="publish-state"]')?.textContent,
  }));
  if (draftBadges.draft !== 'Draft: Saved' || draftBadges.game !== 'Game: Update pending') {
    throw new Error(`Draft/game badges are incoherent after Save Draft: ${JSON.stringify(draftBadges)}`);
  }
  // App-driven reloads must not trip the fly-mode beforeunload guard.
  await page.getByRole('button', { name: 'Fly', exact: true }).click();
  const appliedNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-action="rebuild-world"]').click();
  await appliedNavigation;
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real' && window.hesiEditor.registry.has('placed:0001'), null, { timeout: 60000 });
  const buildAfterApply = await snapshotFile(BUILD_PATH);
  if (buildAfterApply == null || (buildBeforeDraft != null && buildBeforeDraft.equals(buildAfterApply))) {
    throw new Error('Apply to Game did not update the playable game build file');
  }
  const persisted = await page.evaluate(() => ({
    checkpoint: window.hesiEditor.checkpoint,
    path: window.hesiEditor.persistence.currentPath,
    placed: window.hesiEditor.projectState.toJSON().placedObjects.length,
    lampX: window.hesiEditor.registry.getById('lamp:wangan-0:0042').object3D.position.x,
    draftState: document.querySelector('[data-testid="dirty-state"]')?.textContent,
    gameState: document.querySelector('[data-testid="publish-state"]')?.textContent,
  }));
  if (persisted.checkpoint !== 4 || persisted.path !== PROJECT_PATH || persisted.placed !== 1
    || Math.abs(persisted.lampX - (Number(originalX) + 6)) > 0.01
    || persisted.draftState !== 'Draft: Saved' || persisted.gameState !== 'Game: Current') {
    throw new Error(`Disk project did not survive browser reload: ${JSON.stringify(persisted)}`);
  }
  await page.getByTestId('hierarchy-search').fill('placed:0001');
  await page.locator('[data-entity-id="placed:0001"]').click();
  await page.getByRole('button', { name: 'Project', exact: true }).last().click();
  await page.screenshot({ path: path.join(OUT, 'checkpoint-4-project-persistence.png'), fullPage: true });

  const demo = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await demo.goto(`${BASE}/editor?world=demo`, { waitUntil: 'domcontentloaded' });
  await demo.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'demo', null, { timeout: 20000 });
  const demoState = await demo.evaluate(() => ({
    strategy: window.hesiEditor.adapter.strategy,
    real: window.hesiEditor.adapter.isRealWorld,
    project: window.hesiEditor.persistence.currentPath,
  }));
  if (demoState.strategy !== 'demo' || demoState.real || demoState.project !== 'data/editor/demo-highway-project.json') {
    throw new Error(`Explicit demo mode failed: ${JSON.stringify(demoState)}`);
  }
  await demo.close();

  // Garage floor picking and the two new texture-editing surfaces: the Map
  // Inspector exposes face slots, while the Modeler exposes crop + both flips.
  const garage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const garageErrors = [];
  garage.on('pageerror', (error) => garageErrors.push(String(error)));
  garage.on('console', (message) => { if (message.type() === 'error') garageErrors.push(message.text()); });
  await garage.goto(`${BASE}/editor?scene=garage&project=${encodeURIComponent('data/editor/garage-project.json')}`, { waitUntil: 'domcontentloaded' });
  await garage.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'garage', null, { timeout: 30000 });
  await garage.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
  const floorState = await garage.evaluate(() => {
    const floor = window.hesiEditor.registry.list().find((entity) => entity.type === 'garage-floor');
    if (!floor) return null;
    window.hesiEditor.selection.select(floor.id, { source: 'smoke' });
    return { id: floor.id, selected: window.hesiEditor.selection.selected?.id, editable: floor.editable };
  });
  if (!floorState || floorState.selected !== floorState.id || !floorState.editable) {
    throw new Error(`Garage floor is not selectable/editable: ${JSON.stringify(floorState)}`);
  }
  await garage.waitForSelector('.face-texture-card');
  const faceTextureSelect = garage.locator('.face-texture-card select').first();
  const libraryTexture = await faceTextureSelect.locator('option').nth(1).getAttribute('value');
  if (!libraryTexture) throw new Error('The shared texture library is empty in the Map Inspector');
  await faceTextureSelect.selectOption(libraryTexture);
  await garage.waitForFunction((textureId) => {
    const floor = window.hesiEditor.registry.list().find((entity) => entity.type === 'garage-floor');
    return floor?.metadata?.faceTextures?.['0:0']?.texture === textureId && Boolean(floor.object3D.material?.map);
  }, libraryTexture);
  await garage.locator('.face-texture-controls select').first().selectOption('cover');
  await garage.getByRole('button', { name: 'Flip H', exact: true }).first().click();
  await garage.waitForFunction(() => {
    const style = window.hesiEditor.registry.list().find((entity) => entity.type === 'garage-floor')?.metadata?.faceTextures?.['0:0'];
    return style?.fit === 'cover' && style?.flipX === true;
  });
  await garage.locator('[data-action="open-modeler"]').click();
  await garage.waitForSelector('[data-testid="modeler-overlay"]:not([hidden])');
  await garage.locator('.modeler-face-row button').filter({ hasText: 'Image' }).first().click();
  await garage.waitForSelector('.modeler-chooser-item');
  await garage.locator('.modeler-chooser-item').first().click();
  await garage.waitForSelector('.modeler-face-options');
  const textureControls = await garage.locator('.modeler-face-options').first().evaluate((node) => ({
    fits: [...node.querySelectorAll('option')].map((option) => option.textContent),
    buttons: [...node.querySelectorAll('button')].map((button) => button.textContent),
  }));
  if (!textureControls.fits.includes('Stretch') || !textureControls.fits.includes('Fit & crop')
    || !textureControls.buttons.includes('Flip H') || !textureControls.buttons.includes('Flip V')) {
    throw new Error(`Modeler texture controls are incomplete: ${JSON.stringify(textureControls)}`);
  }
  if (garageErrors.length) throw new Error(`Garage browser console errors: ${garageErrors.join(' | ')}`);
  await garage.close();

  const disposed = await page.evaluate(() => {
    window.hesiEditor.dispose();
    return { entities: window.hesiEditor.registry.list().length, canvasPresent: Boolean(document.querySelector('[data-testid="editor-canvas"]')) };
  });
  if (disposed.entities !== 0 || disposed.canvasPresent) throw new Error('Editor disposal left live registry or canvas state');
  if (errors.length) throw new Error(`Browser console errors: ${errors.join(' | ')}`);
  console.log(`PASS real map default (${state.entities} semantic entities), aligned road controls, Tatsumi route right-click/live collision, fly/orbit, transform overrides, undo/redo, declarative duplication, garage floor/face textures/modeler crop+flip, explicit demo, disposal`);
  console.log(`ROAD SCREENSHOT ${path.join(OUT, 'checkpoint-road-tatsumi-editing.png')}`);
  console.log(`SCREENSHOT ${path.join(OUT, 'checkpoint-3-real-lamp-editing.png')}`);
} finally {
  await browser?.close();
  child.kill();
  await rm(path.join(ROOT, PROJECT_PATH), { force: true });
  await rm(path.join(ROOT, `${PROJECT_PATH}.bak`), { force: true });
  await rm(path.join(ROOT, PROJECT_PATH.replace(/\.json$/i, '.autosave.json')), { force: true });
  await restoreFile(BUILD_PATH, buildSnapshot);
  await restoreFile(BUILD_BACKUP_PATH, buildBackupSnapshot);
  await restoreFile(ROAD_SOURCE_PATH, roadSourceSnapshot);
  await restoreFile(ROAD_SOURCE_BACKUP_PATH, roadSourceBackupSnapshot);
  await restoreFile(ROUTE_JSON_PATH, routeJsonSnapshot);
  await restoreFile(ROUTE_JSON_BACKUP_PATH, routeJsonBackupSnapshot);
  await restoreFile(ROUTE_MODULE_PATH, routeModuleSnapshot);
  await restoreFile(ROUTE_MODULE_BACKUP_PATH, routeModuleBackupSnapshot);
}
