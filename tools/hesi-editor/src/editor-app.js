import { createEntityRegistry } from './entity-registry.js';
import { createViewport } from './viewport.js';
import { loadWorld } from './world-adapter.js';
import { createEditorShell } from './ui/editor-shell.js';

export async function createEditorApp(root) {
  if (!root) throw new Error('Editor root element is missing');

  const shell = createEditorShell(root);
  const registry = createEntityRegistry();
  const viewport = createViewport(shell.viewportHost, { onStats: (stats) => shell.setStats(stats) });
  let adapter = null;
  let disposed = false;
  let gridVisible = true;
  let axesVisible = false;

  const unsubscribeRegistry = registry.subscribe(() => shell.renderRegistry(registry));
  shell.renderRegistry(registry);
  shell.onToolbar('reset-camera', () => viewport.resetCamera());
  shell.onToolbar('focus-world', () => viewport.focusOn(adapter?.focusTarget || adapter?.group));
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

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('world') === 'full' ? 'full' : 'representative';
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
    viewport.setWorldGroup(adapter.group);
    for (const entity of adapter.entities) registry.register(entity);
    shell.setAdapter(adapter);
    shell.setLoading(false);
    viewport.focusOn(adapter.focusTarget || adapter.group);
    shell.setStatus(adapter.warning || `${adapter.label} loaded read-only`);
  } catch (error) {
    shell.setLoading(false);
    shell.setStatus('World loading failed');
    shell.showError(error, 'World adapter failed');
    throw error;
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
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
    get adapter() { return adapter; },
    showError(message) { shell.showError(message instanceof Error ? message : new Error(String(message))); },
    dispose,
  };
}
