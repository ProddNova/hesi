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
    button('Focus selected', 'focus-selected', { title: 'Frame the selected semantic entity (F)' }),
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
  const hierarchyTools = element('div', 'hierarchy-tools');
  const hierarchySearch = document.createElement('input');
  hierarchySearch.type = 'search';
  hierarchySearch.placeholder = 'Filter ID, name, or type';
  hierarchySearch.setAttribute('aria-label', 'Filter hierarchy');
  hierarchySearch.dataset.testid = 'hierarchy-search';
  const inspectLockedLabel = element('label', 'inspect-locked');
  const inspectLocked = document.createElement('input');
  inspectLocked.type = 'checkbox';
  inspectLockedLabel.append(inspectLocked, element('span', '', 'Inspect locked'));
  hierarchyTools.append(hierarchySearch, inspectLockedLabel);
  const layerContent = element('div', 'layer-content');
  const entityTree = element('div', 'entity-tree');
  hierarchyContent.append(hierarchyTools, layerContent, entityTree);
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
  const inspectorTitle = element('h2', '', 'World Inspector');
  const inspectorCaption = element('small', '', 'Live metadata');
  rightHeader.append(inspectorTitle, inspectorCaption);
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
  let registryRef = null;
  let selectedEntity = null;
  let entitySelectHandler = () => {};
  let inspectLockedHandler = () => {};
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

  const transformText = (values, digits = 3) => values?.map((value) => number(value, digits)).join(', ') || 'Unavailable';
  const renderInspector = () => {
    inspectorContent.innerHTML = '';
    if (selectedEntity) {
      const entity = selectedEntity;
      const metadata = entity.metadata || {};
      const render = metadata.render || {};
      const object = entity.object3D;
      object?.updateWorldMatrix?.(true, false);
      const worldPosition = object?.getWorldPosition ? object.getWorldPosition(object.position.clone()) : null;
      const bounds = entity.getWorldBounds?.();
      const dimensions = bounds && !bounds.isEmpty() ? bounds.getSize(bounds.min.clone()) : null;
      const gps = worldPosition && adapter?.metadata?.worldToGps ? adapter.metadata.worldToGps(worldPosition) : null;
      inspectorTitle.textContent = 'Entity Inspector';
      inspectorCaption.textContent = entity.editable ? 'Editable' : 'Read-only';
      const identity = element('section', 'inspector-section');
      identity.append(element('h3', '', 'Identity'));
      property(identity, 'ID', entity.id, 'selected-entity-id');
      property(identity, 'Name', entity.name);
      property(identity, 'Type', entity.type);
      property(identity, 'Layer', entity.layer);
      property(identity, 'Source', entity.source);
      property(identity, 'Kind', entity.generated ? (metadata.sourceKind || 'Generated') : 'Editor-created INSTANCE');
      property(identity, 'Editable', entity.editable ? 'Yes' : 'No');
      property(identity, 'Asset/template', entity.assetId || 'Unavailable');
      property(identity, 'Parent', entity.parentId || 'None');

      const transform = element('section', 'inspector-section');
      transform.append(element('h3', '', 'Transform and bounds'));
      property(transform, 'Local position', object ? transformText(object.position.toArray()) : 'Unavailable: semantic metadata entity');
      property(transform, 'World position', worldPosition ? transformText(worldPosition.toArray()) : 'Unavailable');
      property(transform, 'Rotation', object ? `${transformText(object.rotation.toArray().slice(0, 3).map((value) => value * 180 / Math.PI), 2)}°` : 'Unavailable');
      property(transform, 'Scale', object ? transformText(object.scale.toArray()) : 'Unavailable');
      property(transform, 'Bounds', dimensions ? `${number(dimensions.x)} × ${number(dimensions.y)} × ${number(dimensions.z)} m` : 'Unavailable');
      property(transform, 'Override', metadata.hasOverride ? 'Yes' : 'No');

      const world = element('section', 'inspector-section');
      world.append(element('h3', '', 'World information'));
      property(world, 'Route', metadata.routeId || 'Unavailable');
      property(world, 'Along route', Number.isFinite(metadata.routeDistance) ? `${metadata.routeDistance.toFixed(1)} m` : 'Unavailable');
      property(world, 'Service area', metadata.serviceAreaId || 'Unavailable');
      property(world, 'Chunk', metadata.chunk || 'Unavailable');
      property(world, 'Map origin', adapter?.metadata?.mapOrigin ? `${adapter.metadata.mapOrigin.lat.toFixed(6)}, ${adapter.metadata.mapOrigin.lon.toFixed(6)}` : 'Unavailable');
      property(world, 'GPS', gps ? `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}` : 'GPS unavailable for this semantic entity');

      const rendering = element('section', 'inspector-section');
      rendering.append(element('h3', '', 'Rendering'));
      property(rendering, 'Meshes', String(render.meshCount ?? 0));
      property(rendering, 'Triangles', Number.isFinite(render.triangleCount) ? render.triangleCount.toLocaleString() : 'Unavailable');
      property(rendering, 'Materials', render.materialNames?.join(', ') || 'Unavailable');
      property(rendering, 'Textures', render.textureReferences?.join(', ') || 'None exposed');
      property(rendering, 'Render order', String(render.renderOrder ?? 'Unavailable'));
      property(rendering, 'Shadows', render.castShadow || render.receiveShadow ? `cast ${Boolean(render.castShadow)} / receive ${Boolean(render.receiveShadow)}` : 'Disabled');
      property(rendering, 'LOD', render.lod || 'Unavailable');

      const physics = element('section', 'inspector-section');
      physics.append(element('h3', '', 'Physics and collision'));
      property(physics, 'Available', metadata.collisionAvailable ? 'Yes' : 'No authored collision for this entity');
      property(physics, 'Source', metadata.collisionSource || 'Unavailable');
      property(physics, 'Type', metadata.collisionType || 'Unavailable');
      property(physics, 'Enabled', metadata.collisionAvailable ? 'Runtime analytic system' : 'Unavailable');
      property(physics, 'Mismatch', metadata.collisionAvailable && entity.editable ? 'Transform overrides do not rewrite analytic runtime collision' : 'None detected / unavailable');

      const optimization = element('section', 'inspector-section');
      optimization.append(element('h3', '', 'Optimization'));
      property(optimization, 'Classification', metadata.static === false ? 'Dynamic' : 'Static');
      property(optimization, 'Instanced', metadata.instanced ? 'Yes' : 'No');
      property(optimization, 'Repeated count', String(render.repeatedAssetCount ?? metadata.instanceCount ?? 'Unavailable'));
      property(optimization, 'Reusable asset', entity.assetId ? 'Eligible' : 'Unavailable');
      property(optimization, 'Draw calls', String(render.drawCallContribution ?? 'Unavailable'));
      property(optimization, 'Geometry', render.geometryShared ? 'Shared' : 'Unique or unavailable');
      property(optimization, 'Material', render.materialShared ? 'Shared' : 'Unique or unavailable');
      inspectorContent.append(identity, transform, world, rendering, physics, optimization);
      return;
    }
    inspectorTitle.textContent = 'World Inspector';
    inspectorCaption.textContent = 'Live metadata';
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
  hierarchySearch.addEventListener('input', () => { if (registryRef) renderRegistryImpl(registryRef); });
  inspectLocked.addEventListener('change', () => inspectLockedHandler(inspectLocked.checked));

  const entityRow = (item) => {
    const row = element('button', `entity-row${selectedEntity?.id === item.id ? ' selected' : ''}`);
    row.type = 'button';
    row.textContent = item.name;
    row.title = `${item.id} / ${item.type} / ${item.editable ? 'editable' : 'read-only'}`;
    row.dataset.entityId = item.id;
    row.append(element('small', '', item.id));
    row.addEventListener('click', () => entitySelectHandler(item.id));
    return row;
  };

  const renderRegistryImpl = (registry) => {
    registryRef = registry;
    const entities = registry.list();
    entityCount.textContent = `${entities.length.toLocaleString()} entities`;
    statusEntities.textContent = `Entities ${entities.length.toLocaleString()}`;
    layerContent.innerHTML = '';
    for (const layer of registry.layers()) {
      const row = element('div', `layer-row${layer.count ? '' : ' unavailable'}`);
      const label = element('label', 'layer-visibility');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = layer.visible;
      checkbox.disabled = layer.count === 0;
      checkbox.dataset.layer = layer.name;
      checkbox.addEventListener('change', () => registry.setLayerVisibility(layer.name, checkbox.checked));
      label.append(checkbox, element('span', '', layer.name));
      const lock = element('button', `layer-lock${layer.locked ? ' locked' : ''}`, layer.locked ? 'LOCKED' : 'OPEN');
      lock.type = 'button';
      lock.disabled = layer.count === 0;
      lock.dataset.lockLayer = layer.name;
      lock.title = `${layer.locked ? 'Unlock' : 'Lock'} ${layer.name} selection`;
      lock.addEventListener('click', () => registry.toggleLayerLocked(layer.name));
      row.append(label, lock, element('small', '', String(layer.count)));
      layerContent.append(row);
    }

    entityTree.innerHTML = '';
    const query = hierarchySearch.value.trim();
    if (query) {
      const results = registry.search(query);
      const caption = element('div', 'search-caption', `${results.length.toLocaleString()} result${results.length === 1 ? '' : 's'}`);
      entityTree.append(caption);
      const list = element('div', 'entity-list');
      results.slice(0, 600).forEach((item) => list.append(entityRow(item)));
      if (results.length > 600) list.append(element('div', 'entity-limit', `Showing 600 of ${results.length.toLocaleString()}; refine the filter.`));
      entityTree.append(list);
      return;
    }
    for (const layer of registry.layers().filter((entry) => entry.count > 0)) {
      const details = document.createElement('details');
      details.className = 'entity-layer-group';
      details.dataset.entityLayer = layer.name;
      details.open = selectedEntity?.layer === layer.name || layer.name === 'Roads';
      const summary = document.createElement('summary');
      summary.append(element('span', '', layer.name), element('small', '', layer.count.toLocaleString()));
      details.append(summary);
      const populate = () => {
        if (details.dataset.populated) return;
        details.dataset.populated = 'true';
        const items = registry.listByLayer(layer.name);
        const chosen = items.slice(0, 300);
        if (selectedEntity?.layer === layer.name && !chosen.some((item) => item.id === selectedEntity.id)) chosen.unshift(selectedEntity);
        const list = element('div', 'entity-list');
        chosen.forEach((item) => list.append(entityRow(item)));
        if (items.length > 300) list.append(element('div', 'entity-limit', `Showing 300 of ${items.length.toLocaleString()}; use filter for the rest.`));
        details.append(list);
      };
      details.addEventListener('toggle', () => { if (details.open) populate(); });
      if (details.open) populate();
      entityTree.append(details);
    }
  };

  return {
    root: shell,
    viewportHost,
    onToolbar(action, handler) {
      toolbar.querySelector(`[data-action="${action}"]`)?.addEventListener('click', handler);
    },
    onPreset(handler) { presetSelect.addEventListener('preset-selected', (event) => handler(event.detail)); },
    onEntitySelect(handler) { entitySelectHandler = handler; },
    onInspectLocked(handler) { inspectLockedHandler = handler; },
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
    setSelection(entity) {
      selectedEntity = entity || null;
      renderInspector();
      if (registryRef) renderRegistryImpl(registryRef);
      const selectedRow = entity ? entityTree.querySelector(`[data-entity-id="${CSS.escape(entity.id)}"]`) : null;
      selectedRow?.scrollIntoView?.({ block: 'nearest' });
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
      renderRegistryImpl(registry);
    },
    dispose() { root.innerHTML = ''; },
  };
}
