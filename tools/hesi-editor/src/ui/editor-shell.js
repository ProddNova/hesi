function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, action, { pressed, disabled = false, title = '' } = {}) {
  const node = element('button', 'tool-button', label);
  node.type = 'button';
  node.dataset.action = action;
  node.disabled = disabled;
  if (pressed !== undefined) node.setAttribute('aria-pressed', String(pressed));
  if (title) node.title = title;
  return node;
}

export function createEditorShell(root) {
  root.innerHTML = '';
  const shell = element('div', 'editor-shell');
  const toolbar = element('header', 'toolbar');
  const brand = element('div', 'brand');
  brand.append(element('strong', '', 'HESI // EDITOR'), element('span', '', 'Foundation checkpoint 1'));
  toolbar.append(
    brand,
    element('span', 'toolbar-divider'),
    button('Reset view', 'reset-camera'),
    button('Focus world', 'focus-world'),
    element('span', 'toolbar-divider'),
    button('Grid', 'toggle-grid', { pressed: true }),
    button('Axes', 'toggle-axes', { pressed: false }),
    element('span', 'toolbar-divider'),
    button('Select', 'future-select', { disabled: true, title: 'Available in Checkpoint 2' }),
    button('Transform', 'future-transform', { disabled: true, title: 'Available in Checkpoint 2' }),
    button('Road tools', 'future-roads', { disabled: true, title: 'Not available in this checkpoint' }),
    element('span', 'toolbar-spacer'),
  );
  const adapterChip = element('span', 'adapter-chip', 'WORLD: LOADING');
  toolbar.append(adapterChip);

  const workspace = element('main', 'editor-workspace');
  const left = element('aside', 'panel panel-left');
  const leftHeader = element('div', 'panel-header');
  leftHeader.append(element('h2', '', 'Hierarchy / Layers'));
  const entityCount = element('small', '', '0 entities');
  leftHeader.append(entityCount);
  const hierarchyContent = element('div', 'panel-content');
  left.append(leftHeader, hierarchyContent);

  const viewportWrap = element('section', 'viewport-wrap');
  const viewportHost = element('div', 'viewport-host');
  viewportHost.dataset.testid = 'viewport';
  viewportWrap.append(viewportHost, element('div', 'viewport-label', 'Perspective / Read-only'));

  const right = element('aside', 'panel panel-right');
  const rightHeader = element('div', 'panel-header');
  rightHeader.append(element('h2', '', 'Inspector'), element('small', '', 'Read-only'));
  const inspectorContent = element('div', 'panel-content');
  right.append(rightHeader, inspectorContent);

  const bottom = element('section', 'panel panel-bottom');
  const bottomHeader = element('div', 'panel-header');
  const tabs = element('div', 'tabs');
  const assetsTab = element('button', 'tab-button active', 'Assets');
  const materialsTab = element('button', 'tab-button', 'Materials');
  assetsTab.type = materialsTab.type = 'button';
  assetsTab.dataset.tab = 'assets';
  materialsTab.dataset.tab = 'materials';
  tabs.append(assetsTab, materialsTab);
  bottomHeader.append(tabs, element('small', '', 'Extension surface'));
  const bottomContent = element('div', 'panel-content');
  bottom.append(bottomHeader, bottomContent);

  const loadingOverlay = element('div', 'loading-overlay');
  loadingOverlay.dataset.testid = 'loading-overlay';
  const loadingCard = element('div', 'loading-card');
  const loadingCopy = element('div');
  loadingCopy.append(element('strong', '', 'Loading editor world'), element('p', '', 'Preparing viewport'));
  loadingCard.append(element('span', 'spinner'), loadingCopy);
  loadingOverlay.append(loadingCard);

  const errorOverlay = element('div', 'error-overlay');
  errorOverlay.hidden = true;
  errorOverlay.dataset.testid = 'error-overlay';
  const errorCard = element('div', 'error-card');
  const errorTitle = element('h2', '', 'Editor error');
  const errorMessage = element('p', '', 'Unknown error');
  const errorDismiss = element('button', 'error-dismiss', 'Dismiss');
  errorDismiss.type = 'button';
  errorDismiss.addEventListener('click', () => { errorOverlay.hidden = true; });
  errorCard.append(errorTitle, errorMessage, errorDismiss);
  errorOverlay.append(errorCard);
  viewportWrap.append(loadingOverlay, errorOverlay);

  workspace.append(left, viewportWrap, right, bottom);
  const status = element('footer', 'status-bar');
  const statusMessage = element('span', 'status-message', 'Starting editor');
  const statusEntities = element('span', '', 'Entities 0');
  const statusFps = element('span', '', 'FPS --');
  const statusGeometry = element('span', '', 'Draws -- / Tris --');
  status.append(statusMessage, statusEntities, statusFps, statusGeometry);
  shell.append(toolbar, workspace, status);
  root.append(shell);

  const renderBottom = (tab) => {
    assetsTab.classList.toggle('active', tab === 'assets');
    materialsTab.classList.toggle('active', tab === 'materials');
    bottomContent.innerHTML = '';
    const grid = element('div', 'asset-grid');
    const cards = tab === 'assets'
      ? [['Scene primitives', 'Reserved for placement workflow'], ['HESI props', 'Catalog adapter planned'], ['Imported assets', 'Unavailable in Checkpoint 1']]
      : [['Road surfaces', 'Material catalog planned'], ['Architecture', 'Declarative overrides planned'], ['Lighting presets', 'Unavailable in Checkpoint 1']];
    for (const [title, copy] of cards) {
      const card = element('div', 'asset-card');
      card.append(element('b', '', title), element('small', '', copy));
      grid.append(card);
    }
    bottomContent.append(grid);
  };
  renderBottom('assets');
  tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) renderBottom(tab);
  });

  const renderInspector = ({ adapter = null } = {}) => {
    inspectorContent.innerHTML = '';
    inspectorContent.append(element('div', 'inspector-empty', 'No editable selection. Viewport selection and transform gizmos are intentionally deferred to Checkpoint 2.'));
    const section = element('section', 'inspector-section');
    section.append(element('h3', '', 'World adapter'));
    const rows = [
      ['Strategy', adapter?.strategy || 'Pending'],
      ['Source', adapter?.label || 'Pending'],
      ['Editing', 'Unavailable'],
    ];
    for (const [label, value] of rows) {
      const row = element('div', 'property-row');
      row.append(element('span', '', label), element('code', '', value));
      section.append(row);
    }
    const future = element('section', 'inspector-section');
    future.append(element('h3', '', 'Reserved extensions'));
    const list = element('ul', 'future-list');
    ['Selection service', 'Transform commands', 'Material overrides', 'Road adapter', 'AI command boundary'].forEach((item) => list.append(element('li', '', item)));
    future.append(list);
    inspectorContent.append(section, future);
  };
  renderInspector();

  return {
    root: shell,
    viewportHost,
    onToolbar(action, handler) {
      toolbar.querySelector(`[data-action="${action}"]`)?.addEventListener('click', handler);
    },
    setToggle(action, pressed) {
      toolbar.querySelector(`[data-action="${action}"]`)?.setAttribute('aria-pressed', String(Boolean(pressed)));
    },
    setLoading(show, message = 'Preparing viewport') {
      loadingOverlay.hidden = !show;
      loadingCopy.querySelector('p').textContent = message;
    },
    showError(error, title = 'Editor error') {
      errorTitle.textContent = title;
      errorMessage.textContent = error?.message || String(error);
      errorOverlay.hidden = false;
    },
    setStatus(message) { statusMessage.textContent = message; },
    setAdapter(adapter) {
      adapterChip.textContent = `WORLD: ${adapter.label.toUpperCase()}`;
      adapterChip.title = adapter.warning || adapter.label;
      renderInspector({ adapter });
    },
    setStats({ fps, calls, triangles }) {
      statusFps.textContent = `FPS ${fps}`;
      statusGeometry.textContent = `Draws ${calls} / Tris ${triangles.toLocaleString()}`;
    },
    renderRegistry(registry) {
      const entities = registry.list();
      entityCount.textContent = `${entities.length} entities`;
      statusEntities.textContent = `Entities ${entities.length}`;
      hierarchyContent.innerHTML = '';
      for (const layer of registry.layers()) {
        const label = element('label', `layer-row${layer.count ? '' : ' unavailable'}`);
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = layer.visible;
        checkbox.disabled = layer.count === 0;
        checkbox.dataset.layer = layer.name;
        checkbox.addEventListener('change', () => registry.setLayerVisibility(layer.name, checkbox.checked));
        label.append(checkbox, element('span', '', layer.name), element('small', '', String(layer.count)));
        hierarchyContent.append(label);
      }
      const list = element('div', 'entity-list');
      for (const item of entities) {
        const row = element('div', 'entity-row', item.name);
        row.title = `${item.id} / ${item.type} / ${item.editable ? 'editable' : 'read-only'}`;
        row.dataset.entityId = item.id;
        list.append(row);
      }
      hierarchyContent.append(list);
    },
    dispose() { root.innerHTML = ''; },
  };
}
