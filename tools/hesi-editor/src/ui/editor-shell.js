function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, action, { pressed, title = '' } = {}) {
  const node = element('button', 'tool-button', label);
  node.type = 'button';
  node.dataset.action = action;
  if (pressed !== undefined) node.setAttribute('aria-pressed', String(pressed));
  if (title) node.title = title;
  return node;
}

function property(section, label, value, testid = '') {
  const row = element('div', 'property-row');
  const output = element('code', '', value ?? 'Unavailable');
  if (testid) output.dataset.testid = testid;
  row.append(element('span', '', label), output);
  section.append(row);
}

const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'Unavailable';

export function createEditorShell(root) {
  root.innerHTML = '';
  const shell = element('div', 'editor-shell');
  const toolbar = element('header', 'toolbar');
  const brand = element('div', 'brand');
  brand.append(element('strong', '', 'HESI // WORLD EDITOR'), element('span', '', 'Real-map MVP'));
  toolbar.append(
    brand,
    element('span', 'toolbar-divider'),
    button('Start view', 'reset-camera', { title: 'Return to the initial real-world preset' }),
    button('Entire world', 'focus-world', { title: 'Frame the complete generated world' }),
    element('span', 'toolbar-divider'),
    button('Orbit', 'nav-orbit', { pressed: true, title: 'Orbit around a target' }),
    button('Fly', 'nav-fly', { pressed: false, title: 'No-clip free-flight camera' }),
    element('span', 'toolbar-divider'),
    button('Slow', 'speed-slow', { pressed: false }),
    button('Normal', 'speed-normal', { pressed: true }),
    button('Fast', 'speed-fast', { pressed: false }),
    element('span', 'toolbar-divider'),
    button('Grid', 'toggle-grid', { pressed: true }),
    button('Axes', 'toggle-axes', { pressed: false }),
  );
  const presetSelect = document.createElement('select');
  presetSelect.className = 'preset-select';
  presetSelect.title = 'Camera navigation presets';
  presetSelect.setAttribute('aria-label', 'Camera preset');
  toolbar.append(element('span', 'toolbar-spacer'), presetSelect);
  const adapterChip = element('span', 'adapter-chip', 'WORLD: LOADING');
  adapterChip.dataset.testid = 'world-mode';
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
  const viewportLabel = element('div', 'viewport-label', 'ORBIT · 45 M/S');
  viewportLabel.dataset.testid = 'navigation-state';
  const worldWarning = element('div', 'world-warning');
  worldWarning.hidden = true;
  worldWarning.dataset.testid = 'world-warning';
  viewportWrap.append(viewportHost, viewportLabel, worldWarning);

  const right = element('aside', 'panel panel-right');
  const rightHeader = element('div', 'panel-header');
  rightHeader.append(element('h2', '', 'World Inspector'), element('small', '', 'Live metadata'));
  const inspectorContent = element('div', 'panel-content');
  right.append(rightHeader, inspectorContent);

  const bottom = element('section', 'panel panel-bottom');
  const bottomHeader = element('div', 'panel-header');
  const tabs = element('div', 'tabs');
  const worldTab = element('button', 'tab-button active', 'World');
  const controlsTab = element('button', 'tab-button', 'Controls');
  worldTab.type = controlsTab.type = 'button';
  worldTab.dataset.tab = 'world';
  controlsTab.dataset.tab = 'controls';
  tabs.append(worldTab, controlsTab);
  const bottomCaption = element('small', '', 'Loading metadata');
  bottomHeader.append(tabs, bottomCaption);
  const bottomContent = element('div', 'panel-content');
  bottom.append(bottomHeader, bottomContent);

  const loadingOverlay = element('div', 'loading-overlay');
  loadingOverlay.dataset.testid = 'loading-overlay';
  const loadingCard = element('div', 'loading-card');
  const loadingCopy = element('div');
  loadingCopy.append(element('strong', '', 'Loading real HESI world'), element('p', '', 'Preparing viewport'));
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
  const statusCoordinates = element('span', '', 'XYZ --');
  const statusEntities = element('span', '', 'Entities 0');
  const statusFps = element('span', '', 'FPS --');
  const statusGeometry = element('span', '', 'Draws -- / Tris --');
  status.append(statusMessage, statusCoordinates, statusEntities, statusFps, statusGeometry);
  shell.append(toolbar, workspace, status);
  root.append(shell);

  let adapter = null;
  let currentTab = 'world';
  const renderBottom = () => {
    worldTab.classList.toggle('active', currentTab === 'world');
    controlsTab.classList.toggle('active', currentTab === 'controls');
    bottomContent.innerHTML = '';
    if (currentTab === 'controls') {
      const reference = element('div', 'control-reference');
      [
        ['Fly look', 'Click viewport · mouse · Esc releases pointer'],
        ['Move', 'W A S D · Q down · E up'],
        ['Speed', 'Mouse wheel · Slow / Normal / Fast · Shift boosts'],
        ['Orbit', 'Left drag rotate · right drag pan · wheel zoom'],
        ['Presets', 'Tatsumi PA · Initial spawn · Map center · Entire world'],
        ['Global', 'Home frames entire world · F will focus selection'],
      ].forEach(([key, value]) => {
        const card = element('div', 'asset-card');
        card.append(element('b', '', key), element('small', '', value));
        reference.append(card);
      });
      bottomContent.append(reference);
      return;
    }
    const metadata = adapter?.metadata;
    const grid = element('div', 'world-facts');
    const facts = metadata ? [
      ['Map scale', metadata.mapScale],
      ['Coordinate system', metadata.coordinateSystem],
      ['Routes', String(metadata.routeCount)],
      ['World span', `${number(metadata.worldSize?.x / 1000, 2)} × ${number(metadata.worldSize?.z / 1000, 2)} km`],
      ['Bounds area', `${number(metadata.approximateAreaKm2, 1)} km²`],
      ['Chunks', String(metadata.chunkCount ?? 'Unavailable')],
    ] : [['World', 'Loading']];
    facts.forEach(([title, copy]) => {
      const card = element('div', 'asset-card');
      card.append(element('b', '', title), element('small', '', copy));
      grid.append(card);
    });
    bottomContent.append(grid);
  };
  renderBottom();
  tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) { currentTab = tab; renderBottom(); }
  });

  const renderInspector = () => {
    inspectorContent.innerHTML = '';
    const metadata = adapter?.metadata;
    const identity = element('section', 'inspector-section');
    identity.append(element('h3', '', 'World source'));
    property(identity, 'Mode', adapter?.strategy || 'Pending', 'inspector-world-strategy');
    property(identity, 'Label', adapter?.label || 'Pending');
    property(identity, 'Generator', adapter?.isRealWorld ? 'js/map.js · HighwayMap' : 'Editor demo adapter');
    const dimensions = element('section', 'inspector-section');
    dimensions.append(element('h3', '', 'Bounds and origin'));
    property(dimensions, 'Center', metadata?.worldCenter ? `${number(metadata.worldCenter.x)}, ${number(metadata.worldCenter.y)}, ${number(metadata.worldCenter.z)}` : null);
    property(dimensions, 'Size', metadata?.worldSize ? `${number(metadata.worldSize.x)}, ${number(metadata.worldSize.y)}, ${number(metadata.worldSize.z)} m` : null);
    property(dimensions, 'Origin', metadata?.mapOrigin ? `${metadata.mapOrigin.lat.toFixed(6)}, ${metadata.mapOrigin.lon.toFixed(6)}` : 'Unavailable');
    property(dimensions, 'GPS conversion', metadata?.conversion || 'GPS unavailable: inverse OSM transformation not implemented');
    const inventory = element('section', 'inspector-section');
    inventory.append(element('h3', '', 'Generated inventory'));
    property(inventory, 'Routes', metadata ? String(metadata.routeCount) : null, 'route-count');
    property(inventory, 'Service areas', metadata ? String(metadata.serviceAreaCount ?? 'Unavailable') : null);
    property(inventory, 'Junctions', metadata ? String(metadata.junctionCount ?? 'Unavailable') : null);
    property(inventory, 'Chunks', metadata ? String(metadata.chunkCount ?? 'Unavailable') : null);
    inspectorContent.append(identity, dimensions, inventory);
  };
  renderInspector();

  presetSelect.addEventListener('change', () => {
    if (presetSelect.value) presetSelect.dispatchEvent(new CustomEvent('preset-selected', { detail: presetSelect.value }));
  });

  return {
    root: shell,
    viewportHost,
    onToolbar(action, handler) {
      toolbar.querySelector(`[data-action="${action}"]`)?.addEventListener('click', handler);
    },
    onPreset(handler) { presetSelect.addEventListener('preset-selected', (event) => handler(event.detail)); },
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
    showWorldWarning(message) {
      worldWarning.textContent = message || '';
      worldWarning.hidden = !message;
    },
    setStatus(message) { statusMessage.textContent = message; },
    setAdapter(nextAdapter) {
      adapter = nextAdapter;
      adapterChip.textContent = `WORLD: ${adapter.label.toUpperCase()}`;
      adapterChip.classList.toggle('warning', !adapter.isRealWorld);
      adapterChip.title = adapter.warning || adapter.label;
      bottomCaption.textContent = adapter.isRealWorld ? 'Production generator metadata' : 'Non-production world';
      presetSelect.innerHTML = '';
      const unavailable = !adapter.presets.has('tatsumi-pa');
      if (unavailable) {
        const option = new Option('Tatsumi PA unavailable', '', false, false);
        option.disabled = true;
        presetSelect.add(option);
      }
      for (const preset of adapter.presets.values()) presetSelect.add(new Option(preset.label, preset.id));
      renderInspector();
      renderBottom();
    },
    setNavigation({ mode, speed, speedPreset, pointerLocked }) {
      viewportLabel.textContent = `${mode.toUpperCase()} · ${Math.round(speed)} M/S${pointerLocked ? ' · POINTER LOCKED' : ''}`;
      this.setToggle('nav-orbit', mode === 'orbit');
      this.setToggle('nav-fly', mode === 'fly');
      for (const preset of ['slow', 'normal', 'fast']) this.setToggle(`speed-${preset}`, speedPreset === preset);
    },
    setCamera(position) {
      statusCoordinates.textContent = `XYZ ${position.x.toFixed(1)} / ${position.y.toFixed(1)} / ${position.z.toFixed(1)}`;
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
        row.title = `${item.id} / ${item.type}`;
        row.dataset.entityId = item.id;
        list.append(row);
      }
      hierarchyContent.append(list);
    },
    dispose() { root.innerHTML = ''; },
  };
}
