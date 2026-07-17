import { createEntityRegistry } from './entity-registry.js';
import { createViewport } from './viewport.js';
import { loadWorld } from './world-adapter.js';
import { createEditorShell } from './ui/editor-shell.js';

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
  let disposed = false;
  let gridVisible = true;
  let axesVisible = false;

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

  const unsubscribeRegistry = registry.subscribe(() => shell.renderRegistry(registry));
  shell.renderRegistry(registry);
  shell.onToolbar('reset-camera', () => applyPreset('initial-spawn'));
  shell.onToolbar('focus-world', () => applyPreset('entire-world'));
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

  const onKeyDown = (event) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
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
    shell.setAdapter(adapter);
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
    registry.clear();
    viewport.setWorldGroup(null);
    adapter?.dispose();
    viewport.dispose();
    shell.dispose();
  };
  window.addEventListener('beforeunload', dispose, { once: true });

  return {
    checkpoint: 1,
    registry,
    viewport,
    shell,
    get adapter() { return adapter; },
    applyPreset,
    showError(message) { shell.showError(message instanceof Error ? message : new Error(String(message))); },
    dispose,
  };
}
