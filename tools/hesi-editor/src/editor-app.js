import { createEntityRegistry } from './entity-registry.js';
import { createViewport } from './viewport.js';
import { loadWorld } from './world-adapter.js';
import { createEditorShell } from './ui/editor-shell.js';
import { SelectionManager } from './interaction/selection-manager.js';
import { CommandHistory } from './interaction/command-history.js';
import { TransformManager } from './interaction/transform-manager.js';
import { EditActions } from './interaction/edit-actions.js';
import { PlacementController } from './interaction/placement-controller.js';
import { CollisionOverlay } from './debug/collision-overlay.js';
import { WorldProjectState } from './overrides/world-project-state.js';
import { AssetRegistry } from './world/asset-registry.js';
import { ProjectPersistence } from './overrides/project-persistence.js';
import { getScene, sceneFromSearch } from './scenes/scene-registry.js';

export async function createEditorApp(root) {
  if (!root) throw new Error('Editor root element is missing');

  const scene = sceneFromSearch(window.location.search);
  const shell = createEditorShell(root);
  shell.setScene(scene);
  const registry = createEntityRegistry();
  const viewport = createViewport(shell.viewportHost, {
    onStats: (stats) => shell.setStats(stats),
    onNavigation: (state) => shell.setNavigation(state),
    onCamera: (position) => shell.setCamera(position),
  });
  let adapter = null;
  let selection = null;
  let transformManager = null;
  let editActions = null;
  let assetRegistry = null;
  let persistence = null;
  let placement = null;
  let disposed = false;
  const collisionOverlay = new CollisionOverlay({ viewport });
  const viewFlags = { grid: true, axes: false, debugBounds: false, debugPivot: false, debugCollision: false };
  const projectState = new WorldProjectState();
  const history = new CommandHistory({ onChange: (state) => shell.setHistory(state) });
  const runProjectTask = (task) => Promise.resolve().then(task).catch((error) => {
    shell.setStatus(`Project operation failed · ${error.message}`);
    shell.showError(error, 'Project operation failed');
    return null;
  });
  const refreshCommits = async () => {
    if (!persistence) return;
    const commits = await persistence.listCommits();
    shell.setCommits(commits);
  };
  const switchScene = (sceneId) => {
    if (!getScene(sceneId) || sceneId === scene.id) return;
    if (history.dirty && !window.confirm('You have unsaved changes in this scene. Switch anyway and discard them?')) return;
    const url = new URL(window.location.href);
    url.searchParams.set('scene', sceneId);
    url.searchParams.delete('project');
    window.location.href = url.toString();
  };
  const syncViewState = () => shell.setViewState({ ...viewport.viewState(), ...viewFlags });
  syncViewState();

  const applyPreset = (id) => {
    const preset = adapter?.getPreset(id);
    if (!preset) {
      shell.setStatus(`Camera preset unavailable: ${id}`);
      return false;
    }
    adapter.setChunkMode(preset.chunkMode, preset.position);
    const applied = viewport.applyCameraPreset(preset);
    if (applied) shell.setStatus(`Camera: ${preset.label} · ${preset.source || 'world metadata'}`);
    return applied;
  };

  let unsubscribeRegistry = () => {};
  shell.renderRegistry(registry);
  shell.onToolbar('focus-selected', () => selection?.focusSelected());
  shell.onToolbar('undo', () => history.undo());
  shell.onToolbar('redo', () => history.redo());
  shell.onToolbar('save-project', () => persistence && runProjectTask(() => persistence.save()));
  shell.onToolbar('add-object', () => {
    shell.showTab('assets');
    shell.setStatus('Choose an asset below, then click a surface in the world to place it · Esc cancels');
  });
  shell.onToolbar('transform-translate', () => transformManager?.setMode('translate'));
  shell.onToolbar('transform-rotate', () => transformManager?.setMode('rotate'));
  shell.onToolbar('transform-scale', () => transformManager?.setMode('scale'));
  shell.onToolbar('transform-space', () => transformManager?.setSpace(transformManager.space === 'world' ? 'local' : 'world'));
  shell.onToolbar('nav-orbit', () => viewport.setNavigationMode('orbit'));
  shell.onToolbar('nav-fly', () => viewport.setNavigationMode('fly'));
  for (const speed of ['slow', 'normal', 'fast']) {
    shell.onToolbar(`speed-${speed}`, () => viewport.setFlySpeedPreset(speed));
  }
  shell.onPreset(applyPreset);
  shell.onEntitySelect((id) => selection?.select(id, { source: 'hierarchy' }));
  shell.onInspectLocked((enabled) => selection?.setInspectLocked(enabled));
  shell.onAction((action, detail) => {
    const viewActions = {
      'lighting-mode': () => {
        viewport.setLightingMode(detail);
        shell.setStatus(detail === 'game' ? 'Game lighting (night)' : 'Inspection lighting (editor only)');
        syncViewState();
      },
      exposure: () => { viewport.setExposure(detail); syncViewState(); },
      'fog-full': () => { viewport.setFogFull(detail); syncViewState(); },
      'toggle-grid': () => { viewFlags.grid = Boolean(detail); viewport.setGridVisible(viewFlags.grid); syncViewState(); },
      'toggle-axes': () => { viewFlags.axes = Boolean(detail); viewport.setAxesVisible(viewFlags.axes); syncViewState(); },
      'debug-bounds': () => { viewFlags.debugBounds = Boolean(detail); selection?.setDebugOptions({ bounds: viewFlags.debugBounds }); syncViewState(); },
      'debug-pivot': () => { viewFlags.debugPivot = Boolean(detail); selection?.setDebugOptions({ pivot: viewFlags.debugPivot }); syncViewState(); },
      'debug-collision': () => {
        const wanted = Boolean(detail);
        const applied = collisionOverlay.setVisible(wanted, adapter);
        viewFlags.debugCollision = applied && wanted;
        if (wanted && !applied) shell.setStatus('Collision walls are available only with the real world loaded');
        else shell.setStatus(wanted ? 'Collision walls overlay on (debug)' : 'Collision walls overlay off');
        syncViewState();
      },
      'place-asset': () => {
        if (!placement || !assetRegistry) return;
        const entry = assetRegistry.catalog().find((item) => item.id === detail);
        placement.begin(detail, entry?.label || detail);
      },
    };
    if (viewActions[action]) { viewActions[action](); return; }
    if (!editActions || !transformManager) return;
    const actions = {
      'toggle-visibility': () => editActions.toggleVisibility(),
      'toggle-lock': () => editActions.toggleLocked(),
      duplicate: () => editActions.duplicate(),
      delete: () => editActions.deleteSelected(),
      isolate: () => editActions.isolateSelected(),
      'exit-isolate': () => editActions.exitIsolation(),
      'reveal-all': () => editActions.revealAll(),
      'reset-overrides': () => editActions.resetSelected(),
      'copy-transform': () => editActions.copyTransform(),
      'paste-transform': () => editActions.pasteTransform(),
      'copy-id': () => editActions.copyId().catch((error) => shell.setStatus(`Copy failed: ${error.message}`)),
      rename: () => editActions.rename(detail),
      'numeric-transform': () => transformManager.applyComponents(detail),
      'snap-translate': () => transformManager.setSnaps({ translate: detail }),
      'snap-rotate': () => transformManager.setSnaps({ rotateDegrees: detail }),
      'snap-scale': () => transformManager.setSnaps({ scale: detail }),
      'axis-toggle': () => transformManager.setAxes({ ...transformManager.axes, [detail.axis]: detail.enabled }),
      'project-save': () => runProjectTask(() => persistence.save({ name: detail.name })),
      'project-save-as': () => runProjectTask(() => persistence.save({ path: detail.path, name: detail.name })),
      'project-load': () => runProjectTask(async () => { shell.showProjectNotice(''); await persistence.load(detail.path); }),
      'project-export': () => persistence.exportOverrides(),
      'project-reset-unsaved': () => runProjectTask(async () => { shell.showProjectNotice(''); await persistence.resetUnsaved(); }),
      'project-reset-all': () => persistence.resetAll(),
      'project-commit': () => runProjectTask(async () => {
        await persistence.commit(detail?.message);
        await refreshCommits();
      }),
      'project-restore-commit': () => runProjectTask(async () => {
        shell.showProjectNotice('');
        await persistence.restoreCommit(detail);
        await refreshCommits();
      }),
      'project-delete-commit': () => runProjectTask(async () => {
        await persistence.deleteCommit(detail);
        await refreshCommits();
      }),
      'project-refresh-commits': () => runProjectTask(refreshCommits),
      'scene-switch': () => switchScene(detail),
    };
    actions[action]?.();
  });

  const onKeyDown = (event) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
    const commandKey = event.ctrlKey || event.metaKey;
    if (commandKey && event.code === 'KeyZ') {
      event.preventDefault();
      if (event.shiftKey) history.redo(); else history.undo();
      return;
    }
    if (commandKey && event.code === 'KeyY') { event.preventDefault(); history.redo(); return; }
    if (commandKey && event.code === 'KeyS') { event.preventDefault(); if (persistence) runProjectTask(() => persistence.save()); return; }
    if (commandKey && event.code === 'KeyD') { event.preventDefault(); editActions?.duplicate(); return; }
    if (event.code === 'KeyL' && !commandKey) {
      event.preventDefault();
      const next = viewport.viewState().lightingMode === 'inspection' ? 'game' : 'inspection';
      viewport.setLightingMode(next);
      shell.setStatus(next === 'game' ? 'Game lighting (night)' : 'Inspection lighting (editor only)');
      syncViewState();
      return;
    }
    if (event.code === 'Delete') { event.preventDefault(); editActions?.deleteSelected(); return; }
    if (event.code === 'KeyX') {
      event.preventDefault();
      if (transformManager) transformManager.setSpace(transformManager.space === 'world' ? 'local' : 'world');
      return;
    }
    if (viewport.navigationMode === 'orbit' && !commandKey) {
      const modes = { KeyW: 'translate', KeyE: 'rotate', KeyR: 'scale' };
      if (modes[event.code]) { event.preventDefault(); transformManager?.setMode(modes[event.code]); return; }
    }
    if (event.code === 'Home') {
      event.preventDefault();
      applyPreset('entire-world');
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('world') === 'demo' ? 'demo' : 'real';
  try {
    adapter = await loadWorld({
      mode,
      scene: scene.id,
      onProgress(message) {
        shell.setLoading(true, message);
        shell.setStatus(message);
      },
    });
    if (disposed) {
      adapter.dispose();
      return null;
    }
    viewport.setWorldGroup(adapter.group, (position, time) => adapter.updateForCamera(position, time));
    for (const worldEntity of adapter.entities) registry.register(worldEntity);
    unsubscribeRegistry = registry.subscribe((change) => {
      if (change.type === 'layer-visibility' && selection?.selected?.layer === change.layer && !change.visible) selection.clear('hidden-layer');
      shell.renderRegistry(registry);
    });
    shell.renderRegistry(registry);
    shell.setAdapter(adapter);
    selection = new SelectionManager({
      viewport, registry, adapter,
      onChange: (entity) => {
        shell.setSelection(entity);
        transformManager?.setSelection(entity);
      },
      onStatus: (message) => shell.setStatus(message),
    });
    assetRegistry = new AssetRegistry({ editorGroup: adapter.editorObjectsGroup }).collect(adapter.entities);
    transformManager = new TransformManager({
      viewport, history, projectState, registry,
      onChange: (entity) => {
        selection?.refreshHighlight();
        shell.setTransformState(transformManager.state());
        if (entity) shell.refreshInspector();
      },
      onStatus: (message) => shell.setStatus(message),
    });
    editActions = new EditActions({
      registry, adapter, assetRegistry, projectState, history, selection, transformManager,
      onChange: (entity) => {
        selection?.refreshHighlight();
        shell.setSelection(selection?.selected || entity || null);
        shell.setTransformState(transformManager.state());
      },
      onStatus: (message) => shell.setStatus(message),
    });
    placement = new PlacementController({
      viewport, adapter, editActions, transformManager,
      onChange: (active, label) => shell.setPlacement(active, label),
      onStatus: (message) => shell.setStatus(message),
    });
    shell.setAssets(assetRegistry.catalog());
    syncViewState();
    persistence = new ProjectPersistence({
      projectState, registry, assetRegistry, adapter, selection, transformManager, history, scene,
      onStatus: (message) => shell.setStatus(message),
      onProjectChange: (state) => shell.setProject(state),
      onRecovery: (message) => shell.showProjectNotice(message),
    });
    shell.setTransformState(transformManager.state());
    shell.setLoading(true, 'Loading saved editor project');
    const initialProjectPath = mode === 'demo' && !params.has('project')
      ? scene.projectPath
      : persistence.initialPath();
    await persistence.load(initialProjectPath, { allowMissing: true });
    persistence.startAutosave();
    refreshCommits().catch((error) => shell.setStatus(`Commit list unavailable · ${error.message}`));
    shell.showWorldWarning(adapter.warning);
    applyPreset(adapter.presets.has('tatsumi-pa') ? 'tatsumi-pa' : 'initial-spawn');
    shell.setLoading(false);
    shell.setStatus(adapter.strategy === 'garage'
      ? `Garage interior ready · ${adapter.entities.length} editable parts`
      : (adapter.isRealWorld
        ? `Real HESI map ready · ${adapter.metadata.routeCount} routes · ${adapter.metadata.chunkCount} chunks`
        : adapter.warning));
  } catch (error) {
    shell.setLoading(false);
    shell.setStatus('World loading failed');
    shell.showError(error, 'World adapter failed');
    throw error;
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('keydown', onKeyDown);
    unsubscribeRegistry();
    placement?.dispose();
    collisionOverlay.dispose();
    editActions?.exitIsolation();
    persistence?.dispose();
    transformManager?.dispose();
    selection?.dispose();
    registry.clear();
    viewport.setWorldGroup(null);
    adapter?.dispose();
    viewport.dispose();
    shell.dispose();
  };
  window.addEventListener('beforeunload', dispose, { once: true });

  return {
    checkpoint: 4,
    registry,
    viewport,
    shell,
    history,
    projectState,
    get transformManager() { return transformManager; },
    get editActions() { return editActions; },
    get assetRegistry() { return assetRegistry; },
    get persistence() { return persistence; },
    get selection() { return selection; },
    get placement() { return placement; },
    get adapter() { return adapter; },
    applyPreset,
    showError(message) { shell.showError(message instanceof Error ? message : new Error(String(message))); },
    dispose,
  };
}
