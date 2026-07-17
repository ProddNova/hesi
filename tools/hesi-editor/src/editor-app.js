import { createEntityRegistry } from './entity-registry.js';
import { createViewport } from './viewport.js';
import { loadWorld } from './world-adapter.js';
import { createEditorShell } from './ui/editor-shell.js';
import { SelectionManager } from './interaction/selection-manager.js';
import { CommandHistory } from './interaction/command-history.js';
import { TransformManager } from './interaction/transform-manager.js';
import { EditActions } from './interaction/edit-actions.js';
import { WorldProjectState } from './overrides/world-project-state.js';
import { AssetRegistry } from './world/asset-registry.js';
import { ProjectPersistence } from './overrides/project-persistence.js';

export async function createEditorApp(root) {
  if (!root) throw new Error('Editor root element is missing');

  const shell = createEditorShell(root);
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
  let disposed = false;
  let gridVisible = true;
  let axesVisible = false;
  const projectState = new WorldProjectState();
  const history = new CommandHistory({ onChange: (state) => shell.setHistory(state) });
  const runProjectTask = (task) => Promise.resolve().then(task).catch((error) => {
    shell.setStatus(`Project operation failed · ${error.message}`);
    shell.showError(error, 'Project operation failed');
    return null;
  });

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
  shell.onToolbar('reset-camera', () => applyPreset('initial-spawn'));
  shell.onToolbar('focus-world', () => applyPreset('entire-world'));
  shell.onToolbar('focus-selected', () => selection?.focusSelected());
  shell.onToolbar('undo', () => history.undo());
  shell.onToolbar('redo', () => history.redo());
  shell.onToolbar('save-project', () => persistence && runProjectTask(() => persistence.save()));
  shell.onToolbar('show-project', () => shell.showTab('project'));
  shell.onToolbar('transform-translate', () => transformManager?.setMode('translate'));
  shell.onToolbar('transform-rotate', () => transformManager?.setMode('rotate'));
  shell.onToolbar('transform-scale', () => transformManager?.setMode('scale'));
  shell.onToolbar('transform-space', () => transformManager?.setSpace(transformManager.space === 'world' ? 'local' : 'world'));
  shell.onToolbar('nav-orbit', () => viewport.setNavigationMode('orbit'));
  shell.onToolbar('nav-fly', () => viewport.setNavigationMode('fly'));
  for (const speed of ['slow', 'normal', 'fast']) {
    shell.onToolbar(`speed-${speed}`, () => viewport.setFlySpeedPreset(speed));
  }
  shell.onToolbar('toggle-grid', () => {
    gridVisible = !gridVisible;
    viewport.setGridVisible(gridVisible);
    shell.setToggle('toggle-grid', gridVisible);
  });
  shell.onToolbar('toggle-axes', () => {
    axesVisible = !axesVisible;
    viewport.setAxesVisible(axesVisible);
    shell.setToggle('toggle-axes', axesVisible);
  });
  shell.onPreset(applyPreset);
  shell.onEntitySelect((id) => selection?.select(id, { source: 'hierarchy' }));
  shell.onInspectLocked((enabled) => selection?.setInspectLocked(enabled));
  shell.onAction((action, detail) => {
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
    persistence = new ProjectPersistence({
      projectState, registry, assetRegistry, adapter, selection, transformManager, history,
      onStatus: (message) => shell.setStatus(message),
      onProjectChange: (state) => shell.setProject(state),
      onRecovery: (message) => shell.showProjectNotice(message),
    });
    shell.setTransformState(transformManager.state());
    shell.setLoading(true, 'Loading saved editor project');
    const initialProjectPath = mode === 'demo' && !params.has('project')
      ? 'data/editor/hesi-world-project.json'
      : persistence.initialPath();
    await persistence.load(initialProjectPath, { allowMissing: true });
    persistence.startAutosave();
    shell.showWorldWarning(adapter.warning);
    applyPreset(adapter.presets.has('tatsumi-pa') ? 'tatsumi-pa' : 'initial-spawn');
    shell.setLoading(false);
    shell.setStatus(adapter.isRealWorld
      ? `Real HESI map ready · ${adapter.metadata.routeCount} routes · ${adapter.metadata.chunkCount} chunks`
      : adapter.warning);
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
    get adapter() { return adapter; },
    applyPreset,
    showError(message) { shell.showError(message instanceof Error ? message : new Error(String(message))); },
    dispose,
  };
}
