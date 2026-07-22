import { sceneList } from '../scenes/scene-registry.js';
import { GRID_SNAP_STEPS } from '../interaction/grid-snap.js';
import { objectFaceSlots, textureSourceUrl } from '/js/custom-assets.js';

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

function inspectorSection(title, open = false) {
  const details = element('details', 'inspector-section');
  if (open) details.open = true;
  details.append(element('summary', '', title));
  const body = element('div', 'inspector-section-body');
  details.append(body);
  return { details, body };
}

const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'Unavailable';

export function createEditorShell(root) {
  root.innerHTML = '';
  const shell = element('div', 'editor-shell');

  // Header: two rows. The app bar owns identity, scene, save state, and the
  // two save actions; the tool ribbon below owns everyday editing tools in
  // labelled groups. This replaces the old single overflowing toolbar row.
  const header = element('header', 'editor-header');
  const appbar = element('div', 'appbar');
  const toolbar = element('div', 'toolbar');
  header.append(appbar, toolbar);

  const brand = element('div', 'brand');
  brand.append(element('strong', '', 'HESI World Editor'));
  const brandScene = element('small', 'brand-scene', '');
  brand.append(brandScene);

  // Scene switcher: the editor edits one scene at a time (highway map or the
  // garage interior); switching reloads the page with the scene's own project.
  const sceneSwitch = element('div', 'segmented scene-switch');
  sceneSwitch.setAttribute('role', 'radiogroup');
  sceneSwitch.setAttribute('aria-label', 'Editable scene');
  const sceneButtons = new Map();
  for (const entry of sceneList()) {
    const seg = element('button', 'seg-button', entry.label);
    seg.type = 'button';
    seg.setAttribute('role', 'radio');
    seg.setAttribute('aria-checked', 'false');
    seg.title = `${entry.description} · project ${entry.projectPath}`;
    seg.dataset.testid = `scene-${entry.id}`;
    sceneButtons.set(entry.id, seg);
    sceneSwitch.append(seg);
  }

  const adapterChip = element('span', 'adapter-chip', 'World: loading');
  adapterChip.dataset.testid = 'world-mode';
  const dirtyChip = element('span', 'dirty-chip', 'Draft: Saved');
  dirtyChip.dataset.testid = 'dirty-state';
  const publishChip = element('span', 'publish-chip', 'Game: Current');
  publishChip.dataset.testid = 'publish-state';

  appbar.append(
    brand,
    sceneSwitch,
    element('span', 'toolbar-spacer'),
    adapterChip,
    dirtyChip,
    publishChip,
    element('span', 'toolbar-divider'),
    button('Save Draft', 'save-project', { title: 'Save locally and update the editor map with your road edits; the playable game stays unchanged (Ctrl+S)' }),
    button('Apply to Game', 'rebuild-world', { title: 'Save the draft, publish road curves and game files to the playable game, then reload' }),
  );
  appbar.querySelector('[data-action="save-project"]').classList.add('accent');
  appbar.querySelector('[data-action="rebuild-world"]').classList.add('primary');

  const toolGroup = (label, ...nodes) => {
    const group = element('div', 'tool-group');
    if (label) {
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      group.title = '';
    }
    group.append(...nodes);
    return group;
  };

  const gridSnapStepSelect = document.createElement('select');
  gridSnapStepSelect.className = 'grid-snap-step';
  gridSnapStepSelect.title = 'Grid step in meters';
  gridSnapStepSelect.setAttribute('aria-label', 'Grid snap step in meters');
  gridSnapStepSelect.dataset.testid = 'grid-snap-step';
  for (const step of GRID_SNAP_STEPS) gridSnapStepSelect.add(new Option(`${step} m`, String(step)));

  const presetSelect = document.createElement('select');
  presetSelect.className = 'preset-select';
  presetSelect.title = 'Camera location presets';
  presetSelect.setAttribute('aria-label', 'Camera preset');

  const speedGroup = element('span', 'nav-speeds');
  speedGroup.hidden = true;
  speedGroup.append(
    button('Slow', 'speed-slow', { pressed: false, title: 'Fly speed: slow' }),
    button('Normal', 'speed-normal', { pressed: true, title: 'Fly speed: normal' }),
    button('Fast', 'speed-fast', { pressed: false, title: 'Fly speed: fast' }),
  );

  const viewButton = element('button', 'tool-button', 'View ▾');
  viewButton.type = 'button';
  viewButton.dataset.action = 'view-menu';
  viewButton.title = 'Lighting, helpers, and debug tools';
  viewButton.setAttribute('aria-expanded', 'false');

  toolbar.append(
    toolGroup('Create',
      button('+ Add Object', 'add-object', { title: 'Place a new asset into the world' }),
      button('Modeler', 'open-modeler', { title: 'Open the Object Modeler: create and texture PSX-style objects' }),
      button('Textures', 'open-world-textures', { title: 'Change road, parking-area, guardrail, barrier, and structure textures' }),
    ),
    element('span', 'toolbar-divider'),
    toolGroup('Transform',
      button('Move', 'transform-translate', { pressed: true, title: 'Move selected object (W)' }),
      button('Rotate', 'transform-rotate', { pressed: false, title: 'Rotate selected object (E)' }),
      button('Scale', 'transform-scale', { pressed: false, title: 'Scale selected object (R)' }),
      button('World', 'transform-space', { pressed: true, title: 'Toggle world/local gizmo space (X)' }),
      button('Snap', 'grid-snap', { pressed: false, title: 'Snap to grid (G): gizmo moves, placed assets, and road points land on clean steps · 15° rotations' }),
      gridSnapStepSelect,
    ),
    element('span', 'toolbar-divider'),
    toolGroup('History',
      button('Undo', 'undo', { title: 'Undo the previous editor command (Ctrl+Z)' }),
      button('Redo', 'redo', { title: 'Redo the next editor command (Ctrl+Shift+Z)' }),
    ),
    element('span', 'toolbar-divider'),
    toolGroup('Camera',
      presetSelect,
      button('Orbit', 'nav-orbit', { pressed: true, title: 'Orbit around a target' }),
      button('Fly', 'nav-fly', { pressed: false, title: 'No-clip free-flight camera' }),
      speedGroup,
      button('Focus', 'focus-selected', { title: 'Frame the selected object (F)' }),
    ),
    element('span', 'toolbar-spacer'),
    viewButton,
  );
  toolbar.querySelector('[data-action="add-object"]').classList.add('primary');

  const viewState = { lightingMode: 'inspection', exposure: 1.45, fogFull: false, grid: true, axes: false, debugBounds: false, debugPivot: false, debugCollision: false };
  const viewMenu = element('div', 'view-menu');
  viewMenu.hidden = true;
  const viewRow = (label, control) => {
    const row = element('label', 'view-row');
    row.append(element('span', '', label), control);
    viewMenu.append(row);
    return control;
  };
  const lightingWrap = element('div', 'segmented');
  const lightingInspection = element('button', 'seg-button', 'Inspection');
  const lightingGame = element('button', 'seg-button', 'Game');
  for (const seg of [lightingInspection, lightingGame]) {
    seg.type = 'button';
    seg.setAttribute('role', 'radio');
    lightingWrap.append(seg);
  }
  lightingInspection.title = 'Bright neutral editor lighting (L)';
  lightingGame.title = 'Original night game lighting (L)';
  viewMenu.append(element('div', 'view-caption', 'Lighting'));
  viewMenu.append(lightingWrap);
  const exposure = document.createElement('input');
  exposure.type = 'range';
  exposure.min = '0.5';
  exposure.max = '2.2';
  exposure.step = '0.05';
  exposure.dataset.testid = 'exposure-slider';
  viewRow('Exposure', exposure);
  const fogFull = document.createElement('input');
  fogFull.type = 'checkbox';
  fogFull.dataset.testid = 'fog-toggle';
  viewRow('Full night fog', fogFull);
  viewMenu.append(element('div', 'view-caption', 'Helpers'));
  const gridToggle = document.createElement('input');
  gridToggle.type = 'checkbox';
  gridToggle.dataset.testid = 'grid-toggle';
  viewRow('Grid', gridToggle);
  const axesToggle = document.createElement('input');
  axesToggle.type = 'checkbox';
  viewRow('Origin axes', axesToggle);
  viewMenu.append(element('div', 'view-caption', 'Debug tools'));
  const debugBounds = document.createElement('input');
  debugBounds.type = 'checkbox';
  debugBounds.dataset.testid = 'debug-bounds';
  viewRow('Selection bounds box', debugBounds);
  const debugPivot = document.createElement('input');
  debugPivot.type = 'checkbox';
  debugPivot.dataset.testid = 'debug-pivot';
  viewRow('Selection pivot', debugPivot);
  const debugCollision = document.createElement('input');
  debugCollision.type = 'checkbox';
  debugCollision.dataset.testid = 'debug-collision';
  viewRow('Collision walls', debugCollision);
  header.append(viewMenu);

  const syncViewMenu = () => {
    lightingInspection.setAttribute('aria-checked', String(viewState.lightingMode === 'inspection'));
    lightingGame.setAttribute('aria-checked', String(viewState.lightingMode === 'game'));
    exposure.value = String(viewState.exposure);
    fogFull.checked = viewState.fogFull;
    gridToggle.checked = viewState.grid;
    axesToggle.checked = viewState.axes;
    debugBounds.checked = viewState.debugBounds;
    debugPivot.checked = viewState.debugPivot;
    debugCollision.checked = viewState.debugCollision;
  };

  const workspace = element('main', 'editor-workspace');

  // Resizable tool panels: drag the splitters, double-click to reset.
  const LAYOUT_STORAGE_KEY = 'hesi-editor.panel-layout.v1';
  const layoutDefaults = { left: 260, right: 320, bottom: 220 };
  const layoutLimits = { left: [180, 520], right: [230, 620], bottom: [130, 520] };
  const panelLayout = { ...layoutDefaults };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}');
    for (const key of Object.keys(layoutDefaults)) {
      if (Number.isFinite(stored?.[key])) panelLayout[key] = stored[key];
    }
  } catch { /* corrupted stored layout falls back to defaults */ }
  const clampPanel = (key, value) => {
    const [min, max] = layoutLimits[key];
    const available = key === 'bottom'
      ? window.innerHeight - 240
      : window.innerWidth - (key === 'left' ? panelLayout.right : panelLayout.left) - 340;
    return Math.round(Math.min(Math.max(value, min), Math.max(min, Math.min(max, available))));
  };
  const applyPanelLayout = () => {
    for (const key of Object.keys(layoutDefaults)) panelLayout[key] = clampPanel(key, panelLayout[key]);
    workspace.style.setProperty('--left-width', `${panelLayout.left}px`);
    workspace.style.setProperty('--right-width', `${panelLayout.right}px`);
    workspace.style.setProperty('--bottom-height', `${panelLayout.bottom}px`);
  };
  const savePanelLayout = () => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(panelLayout)); } catch { /* storage unavailable */ }
  };
  const createSplitter = (key, className, horizontal) => {
    const node = element('div', `splitter ${className} ${horizontal ? 'splitter-h' : 'splitter-v'}`);
    node.setAttribute('role', 'separator');
    node.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
    node.title = 'Drag to resize · double-click to reset';
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      node.setPointerCapture(event.pointerId);
      node.classList.add('dragging');
      const start = horizontal ? event.clientY : event.clientX;
      const initial = panelLayout[key];
      const direction = key === 'left' ? 1 : -1;
      const onMove = (moveEvent) => {
        const delta = (horizontal ? moveEvent.clientY : moveEvent.clientX) - start;
        panelLayout[key] = clampPanel(key, initial + direction * delta);
        applyPanelLayout();
      };
      const finish = (endEvent) => {
        node.classList.remove('dragging');
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', finish);
        node.removeEventListener('pointercancel', finish);
        if (node.hasPointerCapture(endEvent.pointerId)) node.releasePointerCapture(endEvent.pointerId);
        savePanelLayout();
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', finish);
      node.addEventListener('pointercancel', finish);
    });
    node.addEventListener('dblclick', () => {
      panelLayout[key] = layoutDefaults[key];
      applyPanelLayout();
      savePanelLayout();
    });
    return node;
  };
  const splitterLeft = createSplitter('left', 'splitter-left', false);
  const splitterRight = createSplitter('right', 'splitter-right', false);
  const splitterBottom = createSplitter('bottom', 'splitter-bottom', true);
  const onWorkspaceResize = () => applyPanelLayout();
  window.addEventListener('resize', onWorkspaceResize);
  applyPanelLayout();

  const left = element('aside', 'panel panel-left');
  const leftHeader = element('div', 'panel-header');
  leftHeader.append(element('h2', '', 'Scene'));
  const entityCount = element('small', '', '0 entities');
  leftHeader.append(entityCount);
  const sceneTabs = element('div', 'scene-tabs');
  const hierarchyTab = element('button', 'scene-tab active', 'Hierarchy');
  const layersTab = element('button', 'scene-tab', 'Layers');
  hierarchyTab.type = layersTab.type = 'button';
  sceneTabs.append(hierarchyTab, layersTab);
  const hierarchyPane = element('div', 'panel-content hierarchy-pane');
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
  const entityTree = element('div', 'entity-tree');
  hierarchyPane.append(hierarchyTools, entityTree);
  const layersPane = element('div', 'panel-content layers-pane');
  layersPane.hidden = true;
  const layerContent = element('div', 'layer-content');
  layersPane.append(layerContent);
  sceneTabs.addEventListener('click', (event) => {
    const showLayers = event.target === layersTab;
    hierarchyTab.classList.toggle('active', !showLayers);
    layersTab.classList.toggle('active', showLayers);
    hierarchyPane.hidden = showLayers;
    layersPane.hidden = !showLayers;
  });
  left.append(leftHeader, sceneTabs, hierarchyPane, layersPane);

  const viewportWrap = element('section', 'viewport-wrap');
  const viewportHost = element('div', 'viewport-host');
  viewportHost.dataset.testid = 'viewport';
  const viewportLabel = element('div', 'viewport-label', 'Orbit · 45 m/s');
  viewportLabel.dataset.testid = 'navigation-state';
  const worldWarning = element('div', 'world-warning');
  worldWarning.hidden = true;
  worldWarning.dataset.testid = 'world-warning';
  const projectNotice = element('div', 'project-notice');
  projectNotice.hidden = true;
  projectNotice.dataset.testid = 'project-notice';
  const placementHint = element('div', 'placement-hint');
  placementHint.hidden = true;
  placementHint.dataset.testid = 'placement-hint';
  // First-person crosshair: shown in fly mode so the view centre is readable,
  // solid while the pointer is locked (mouse-look active).
  const crosshair = element('div', 'viewport-crosshair');
  crosshair.hidden = true;
  crosshair.dataset.testid = 'fly-crosshair';
  crosshair.setAttribute('aria-hidden', 'true');
  crosshair.append(element('span', 'crosshair-dot'));
  viewportWrap.append(viewportHost, viewportLabel, worldWarning, projectNotice, placementHint, crosshair);

  const right = element('aside', 'panel panel-right');
  const rightHeader = element('div', 'panel-header');
  const inspectorTitle = element('h2', '', 'Inspector');
  const inspectorCaption = element('small', '', 'Nothing selected');
  rightHeader.append(inspectorTitle, inspectorCaption);
  // Dedicated road editing panel: visible while a road route is selected.
  // It surfaces what used to live only in transient status-bar hints.
  const roadPanel = element('div', 'road-panel');
  roadPanel.hidden = true;
  roadPanel.dataset.testid = 'road-panel';
  const inspectorContent = element('div', 'panel-content');
  right.append(rightHeader, roadPanel, inspectorContent);

  const bottom = element('section', 'panel panel-bottom');
  const bottomHeader = element('div', 'panel-header');
  const tabs = element('div', 'tabs');
  const assetsTab = element('button', 'tab-button active', 'Assets');
  const editTab = element('button', 'tab-button', 'Edit');
  const projectTab = element('button', 'tab-button', 'Project');
  const worldTab = element('button', 'tab-button', 'World');
  const helpTab = element('button', 'tab-button', 'Help');
  assetsTab.type = editTab.type = projectTab.type = worldTab.type = helpTab.type = 'button';
  assetsTab.dataset.tab = 'assets';
  editTab.dataset.tab = 'edit';
  projectTab.dataset.tab = 'project';
  worldTab.dataset.tab = 'world';
  helpTab.dataset.tab = 'help';
  tabs.append(assetsTab, editTab, projectTab, worldTab, helpTab);
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

  workspace.append(left, splitterLeft, viewportWrap, splitterRight, right, splitterBottom, bottom);
  const status = element('footer', 'status-bar');
  const statusMessage = element('span', 'status-message', 'Starting editor');
  const statusCoordinates = element('span', '', 'XYZ --');
  const statusEntities = element('span', '', 'Entities 0');
  const statusFps = element('span', '', 'FPS --');
  const statusGeometry = element('span', '', 'Draws -- / Tris --');
  status.append(statusMessage, statusCoordinates, statusEntities, statusFps, statusGeometry);
  shell.append(header, workspace, status);
  root.append(shell);

  let adapter = null;
  let registryRef = null;
  let selectedEntity = null;
  let selectedIds = null;
  let assetEntries = [];
  let textureEntries = [];
  let entitySelectHandler = () => {};
  let inspectLockedHandler = () => {};
  let actionHandler = () => {};
  let transformState = { mode: 'translate', space: 'world', axes: { x: true, y: true, z: true }, translateSnap: null, rotateSnapDegrees: null, scaleSnap: null, attached: false };
  let historyState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, dirty: false };
  let roadDraftDirty = false;
  let gamePending = false;
  let projectInfo = { name: 'HESI Main World', path: 'data/editor/hesi-world-project.json', recent: [], autosavePath: '' };
  let currentTab = 'assets';
  let currentScene = null;
  let commitList = [];
  let commitsLoaded = false;
  const syncSaveState = () => {
    const draftDirty = historyState.dirty || roadDraftDirty;
    dirtyChip.textContent = draftDirty ? 'Draft: Unsaved' : 'Draft: Saved';
    dirtyChip.classList.toggle('dirty', draftDirty);
    publishChip.textContent = gamePending ? 'Game: Update pending' : 'Game: Current';
    publishChip.classList.toggle('pending', gamePending);
  };
  const triggerAction = (action, detail = null) => actionHandler(action, detail);
  const editButton = (label, action, title = '') => {
    const node = button(label, action, { title });
    node.addEventListener('click', () => triggerAction(action));
    return node;
  };

  for (const [sceneId, seg] of sceneButtons) seg.addEventListener('click', () => triggerAction('scene-switch', sceneId));

  const formatCommitDate = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? (iso || '') : date.toLocaleString();
  };
  const renderCommitsPanel = () => {
    const panel = element('div', 'commits-panel');
    const head = element('div', 'commits-head');
    head.append(
      element('h3', '', 'Map versions'),
      element('small', '', commitsLoaded ? `${commitList.length} commit${commitList.length === 1 ? '' : 's'} · data/editor/commits/${currentScene?.id || ''}` : 'Loading commits'),
    );
    const refresh = button('Refresh', 'project-refresh-commits', { title: 'Reload the commit list from disk' });
    refresh.addEventListener('click', () => triggerAction('project-refresh-commits'));
    head.append(refresh);
    panel.append(head);
    const create = element('div', 'commit-create');
    const message = document.createElement('input');
    message.type = 'text';
    message.placeholder = 'Describe this version, e.g. "extra lamps at Tatsumi PA"';
    message.maxLength = 400;
    message.dataset.testid = 'commit-message';
    message.setAttribute('aria-label', 'Commit message');
    const commitButton = button('Commit draft version', 'project-commit', { title: 'Save and snapshot this draft without changing the playable game' });
    commitButton.classList.add('accent');
    const submit = () => {
      if (!message.value.trim()) { message.focus(); return; }
      triggerAction('project-commit', { message: message.value });
      message.value = '';
    };
    commitButton.addEventListener('click', submit);
    message.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    create.append(message, commitButton);
    panel.append(create);
    const list = element('div', 'commit-list');
    list.dataset.testid = 'commit-list';
    if (commitsLoaded && !commitList.length) {
      list.append(element('p', 'commits-empty', 'No commits yet. A commit is a full snapshot of the current map version; use them to keep and restore every saved state.'));
    }
    for (const commit of commitList) {
      const row = element('div', 'commit-row');
      const info = element('div', 'commit-info');
      info.append(element('b', '', commit.message || commit.id));
      const overrides = commit.overrideCount ?? 0;
      const placed = commit.placedObjectCount ?? 0;
      info.append(element('small', '', `${formatCommitDate(commit.createdAt)} · ${overrides} override${overrides === 1 ? '' : 's'} · ${placed} placed object${placed === 1 ? '' : 's'} · ${commit.id}`));
      const rowActions = element('div', 'commit-actions');
      const restore = button('Restore Draft', 'project-restore-commit', { title: 'Load and save this draft without changing the playable game' });
      restore.addEventListener('click', () => {
        if (window.confirm(`Restore "${commit.message}"?\n\nThe current editor draft will be replaced and saved. The playable game stays unchanged until Apply to Game.`)) {
          triggerAction('project-restore-commit', commit.id);
        }
      });
      const remove = button('Delete', 'project-delete-commit', { title: 'Delete this snapshot from disk' });
      remove.classList.add('danger');
      remove.addEventListener('click', () => {
        if (window.confirm(`Delete commit "${commit.message}"?\n\nThe snapshot file is removed permanently.`)) {
          triggerAction('project-delete-commit', commit.id);
        }
      });
      rowActions.append(restore, remove);
      row.append(info, rowActions);
      list.append(row);
    }
    panel.append(list);
    return panel;
  };

  gridSnapStepSelect.addEventListener('change', () => triggerAction('grid-snap-step', Number(gridSnapStepSelect.value)));
  lightingInspection.addEventListener('click', () => triggerAction('lighting-mode', 'inspection'));
  lightingGame.addEventListener('click', () => triggerAction('lighting-mode', 'game'));
  exposure.addEventListener('input', () => triggerAction('exposure', Number(exposure.value)));
  fogFull.addEventListener('change', () => triggerAction('fog-full', fogFull.checked));
  gridToggle.addEventListener('change', () => triggerAction('toggle-grid', gridToggle.checked));
  axesToggle.addEventListener('change', () => triggerAction('toggle-axes', axesToggle.checked));
  debugBounds.addEventListener('change', () => triggerAction('debug-bounds', debugBounds.checked));
  debugPivot.addEventListener('change', () => triggerAction('debug-pivot', debugPivot.checked));
  debugCollision.addEventListener('change', () => triggerAction('debug-collision', debugCollision.checked));
  const closeViewMenu = () => { viewMenu.hidden = true; viewButton.setAttribute('aria-expanded', 'false'); };
  viewButton.addEventListener('click', () => {
    viewMenu.hidden = !viewMenu.hidden;
    viewButton.setAttribute('aria-expanded', String(!viewMenu.hidden));
  });
  window.addEventListener('pointerdown', (event) => {
    if (!viewMenu.hidden && !viewMenu.contains(event.target) && event.target !== viewButton) closeViewMenu();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !viewMenu.hidden) closeViewMenu();
  });

  const renderAssets = () => {
    const panel = element('div', 'assets-panel');
    panel.append(element('p', 'assets-hint', 'Pick an asset, then click a surface in the world to place it. Escape cancels placement. Use the Modeler to create and texture brand-new objects.'));
    const grid = element('div', 'asset-grid');
    const createCard = element('div', 'asset-card');
    createCard.append(element('b', '', '+ New object'), element('small', '', 'Model a new PSX-style object with textured faces in the Modeler'));
    const createFooter = element('div', 'asset-card-footer');
    createFooter.append(element('span', 'asset-kind custom', 'Modeler'));
    const create = button('Open Modeler', 'open-modeler-card', { title: 'Create a new custom object' });
    create.dataset.testid = 'assets-open-modeler';
    create.addEventListener('click', () => triggerAction('modeler-new'));
    createFooter.append(create);
    createCard.append(createFooter);
    grid.append(createCard);
    for (const entry of assetEntries) {
      const card = element('div', 'asset-card');
      card.append(element('b', '', entry.label), element('small', '', entry.description));
      const footer = element('div', 'asset-card-footer');
      const kindLabel = entry.kind === 'primitive' ? 'Primitive' : entry.kind === 'custom' ? 'Custom object' : 'World asset';
      footer.append(element('span', `asset-kind ${entry.kind}`, kindLabel));
      const place = button('Place', 'place-asset', { title: `Place a new ${entry.label}` });
      place.dataset.testid = `place-${entry.id}`;
      place.addEventListener('click', () => triggerAction('place-asset', entry.id));
      footer.append(place);
      const edit = button(entry.kind === 'custom' ? 'Edit' : 'Customize', 'edit-asset', {
        title: entry.kind === 'custom'
          ? `Edit ${entry.label} in the Modeler`
          : `Open a customizable copy of ${entry.label} in the Modeler`,
      });
      edit.classList.add('asset-edit');
      edit.dataset.testid = `edit-${entry.id}`;
      edit.addEventListener('click', () => triggerAction(entry.kind === 'custom' ? 'modeler-edit-asset' : 'modeler-copy-asset', entry.id));
      footer.append(edit);
      card.append(footer);
      grid.append(card);
    }
    if (!assetEntries.length) grid.append(element('p', 'assets-empty', 'Assets are available once the world has loaded.'));
    panel.append(grid);
    return panel;
  };

  const renderBottom = () => {
    assetsTab.classList.toggle('active', currentTab === 'assets');
    editTab.classList.toggle('active', currentTab === 'edit');
    projectTab.classList.toggle('active', currentTab === 'project');
    worldTab.classList.toggle('active', currentTab === 'world');
    helpTab.classList.toggle('active', currentTab === 'help');
    bottomContent.innerHTML = '';
    if (currentTab === 'assets') {
      bottomContent.append(renderAssets());
      return;
    }
    if (currentTab === 'project') {
      const panel = element('div', 'project-panel');
      const fields = element('div', 'project-fields');
      const nameLabel = element('label', 'project-field');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = projectInfo.name;
      nameInput.setAttribute('aria-label', 'Project name');
      nameLabel.append(element('span', '', 'Project name'), nameInput);
      const pathLabel = element('label', 'project-field');
      const pathInput = document.createElement('input');
      pathInput.type = 'text';
      pathInput.value = projectInfo.path;
      pathInput.setAttribute('aria-label', 'Project path');
      pathLabel.append(element('span', '', 'Project path (under data/editor)'), pathInput);
      const recentLabel = element('label', 'project-field');
      const recent = document.createElement('select');
      recent.setAttribute('aria-label', 'Recent projects');
      recent.add(new Option('Recent projects', ''));
      projectInfo.recent.forEach((path) => recent.add(new Option(path, path)));
      recent.addEventListener('change', () => { if (recent.value) pathInput.value = recent.value; });
      recentLabel.append(element('span', '', 'Recent'), recent);
      fields.append(nameLabel, pathLabel, recentLabel);
      const actions = element('div', 'project-actions');
      const details = () => ({ name: nameInput.value, path: pathInput.value });
      const projectButton = (label, action, title = '') => {
        const node = button(label, action, { title });
        node.addEventListener('click', () => triggerAction(action, details()));
        return node;
      };
      actions.append(
        projectButton('Save Draft', 'project-save', 'Save the draft with the name above (Ctrl+S)'),
        projectButton('Save Draft As', 'project-save-as', 'Save the draft to the path above'),
        projectButton('Load', 'project-load', 'Load the draft at the path above'),
        projectButton('Export Overrides', 'project-export', 'Download the override document as JSON'),
      );
      const dangerActions = element('div', 'project-actions project-danger');
      const resetUnsaved = projectButton('Reset Unsaved Changes', 'project-reset-unsaved', 'Discard everything since the last save');
      const resetAll = projectButton('Reset All Overrides', 'project-reset-all', 'Remove every override and placed object from the draft');
      resetUnsaved.classList.add('danger');
      resetAll.classList.add('danger');
      dangerActions.append(resetUnsaved, resetAll);
      actions.append(dangerActions);
      const facts = element('div', 'project-summary');
      facts.append(
        element('b', '', historyState.dirty || roadDraftDirty ? 'Unsaved draft changes' : 'Draft saved to disk'),
        element('span', '', `Current: ${projectInfo.path}`),
        element('span', '', `Game output: ${currentScene?.buildPath || 'n/a'} (${gamePending ? 'update pending' : 'current'})`),
        element('span', '', 'Only Apply to Game updates production routes and game output.'),
        element('span', '', `Recovery: ${projectInfo.autosavePath || 'not configured'}`),
      );
      panel.append(fields, actions, facts, renderCommitsPanel());
      bottomContent.append(panel);
      return;
    }
    if (currentTab === 'edit') {
      const panel = element('div', 'edit-panel');
      const hasSelection = Boolean(selectedEntity);
      const group = (title) => {
        const fieldset = element('fieldset', 'edit-group');
        fieldset.append(element('legend', '', title));
        return fieldset;
      };
      // Selection-dependent actions are disabled without a selection instead
      // of failing silently when clicked.
      const selectionButton = (label, action, title = '') => {
        const node = editButton(label, action, title);
        node.disabled = !hasSelection;
        return node;
      };
      const selectionGroup = group('Selection');
      const generated = selectedEntity?.generated;
      const disabled = selectedEntity?.metadata?.disabled;
      const hidden = !selectedEntity?.object3D?.visible;
      selectionGroup.append(
        selectionButton(generated ? (disabled ? 'Re-enable' : 'Disable') : (hidden ? 'Show' : 'Hide'), 'toggle-visibility',
          generated ? 'Disable/restore this generated object (non-destructive)' : 'Hide/show this placed object'),
        selectionButton(selectedEntity?.metadata?.locked ? 'Unlock' : 'Lock', 'toggle-lock', 'Prevent or allow selection and edits'),
        selectionButton('Duplicate', 'duplicate', 'Duplicate this asset as a new placed object (Ctrl+D)'),
        selectionButton('Delete', 'delete', generated ? 'Disable this generated object (Del)' : 'Remove this placed object (Del)'),
        selectionButton('Assemble into object', 'assemble-selection', 'Combine the selected objects (e.g. a sign and its pole) into one single custom object in the Modeler'),
        selectionButton('Reset overrides', 'reset-overrides', 'Restore the generated state of the selected object'),
      );
      const renameRow = element('div', 'rename-row');
      const renameInput = document.createElement('input');
      renameInput.type = 'text';
      renameInput.value = selectedEntity?.name || '';
      renameInput.placeholder = 'Selected object name';
      renameInput.setAttribute('aria-label', 'Selected object name');
      renameInput.disabled = !hasSelection;
      const rename = button('Rename', 'rename');
      rename.disabled = !hasSelection;
      rename.addEventListener('click', () => triggerAction('rename', renameInput.value));
      renameRow.append(renameInput, rename);
      selectionGroup.append(renameRow);
      const viewGroup = group('View');
      viewGroup.append(
        selectionButton('Isolate', 'isolate', 'Hide everything except the selected object'),
        editButton('Exit isolate', 'exit-isolate', 'Leave isolation and show the rest of the world again'),
        editButton('Reveal all', 'reveal-all', 'Show all layers and re-enable hidden objects'),
        selectionButton('Copy ID', 'copy-id', 'Copy the selected object ID to the clipboard'),
      );
      const transformGroup = group('Transform');
      transformGroup.append(
        selectionButton('Copy transform', 'copy-transform', 'Copy position, rotation, and scale'),
        selectionButton('Paste transform', 'paste-transform', 'Apply the copied transform to the selection'),
      );
      const settings = element('div', 'edit-settings');
      const makeNumber = (label, value, action) => {
        const row = element('label', 'edit-setting');
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = 'any';
        input.value = value ?? '';
        input.placeholder = 'Off';
        input.addEventListener('change', () => triggerAction(action, input.value === '' ? null : Number(input.value)));
        row.append(element('span', '', label), input);
        return row;
      };
      settings.append(
        makeNumber('Move snap (m)', transformState.translateSnap, 'snap-translate'),
        makeNumber('Rotate snap (°)', transformState.rotateSnapDegrees, 'snap-rotate'),
        makeNumber('Scale snap', transformState.scaleSnap, 'snap-scale'),
      );
      const axesRow = element('div', 'axis-settings');
      axesRow.append(element('span', '', 'Gizmo axes:'));
      ['x', 'y', 'z'].forEach((axis) => {
        const label = element('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = transformState.axes[axis];
        input.addEventListener('change', () => triggerAction('axis-toggle', { axis, enabled: input.checked }));
        label.append(input, document.createTextNode(axis.toUpperCase()));
        axesRow.append(label);
      });
      settings.append(axesRow);
      transformGroup.append(settings);
      const summary = element('div', 'edit-summary', selectedEntity
        ? `${selectedEntity.id} · ${selectedEntity.editable ? 'editable' : 'read-only'} · ${selectedEntity.assetId || 'no reusable asset'}`
        : 'Nothing selected. Click an object in the viewport or in the Scene hierarchy.');
      panel.append(selectionGroup, viewGroup, transformGroup, summary);
      bottomContent.append(panel);
      return;
    }
    if (currentTab === 'help') {
      const reference = element('div', 'help-panel');
      const helpSections = [
        ['Roads', [
          ['Click a road', 'Selects the route and enters road editing: draft asphalt, markings, and orange point handles appear. The Road panel on the right shows route facts and point tools.'],
          ['Drag orange point', 'Reshapes the road; the realistic preview follows live'],
          ['Right-click road / double-click', 'Adds a point at that position'],
          ['Right-click point · Del', 'Removes the point'],
          ['Road panel', 'Walk the route with Prev/Next, edit exact X/Z coordinates, frame or delete the selected point'],
        ]],
        ['Selection & editing', [
          ['Click', 'Select an object · click again cycles overlapping hits · Esc clears'],
          ['Shift+click', 'Adds/removes objects from the selection'],
          ['W · E · R', 'Move · Rotate · Scale gizmo'],
          ['X', 'Toggle world/local gizmo space'],
          ['G', 'Grid snap: gizmo moves, placed assets, and road points land on the chosen step · 15° rotations'],
          ['Del', 'Delete placed object / disable generated object'],
          ['Ctrl+D', 'Duplicate the selection'],
          ['Ctrl+Z · Ctrl+Shift+Z', 'Undo · Redo'],
        ]],
        ['Camera & view', [
          ['Orbit', 'Drag rotates · wheel zooms · presets in the Camera group'],
          ['Fly', 'Click the viewport, then WASD · E/Space up · Q/CapsLock down · wheel changes speed · Shift boosts'],
          ['F · Home', 'Frame selection · frame entire world'],
          ['L', 'Toggle inspection/game lighting · more in the View menu (exposure, fog, grid, debug tools)'],
        ]],
        ['Objects & Modeler', [
          ['+ Add Object', 'Pick an asset in the Assets tab, then click a surface to place it · Esc cancels'],
          ['Modeler', 'Build PSX-style objects from simple parts, texture faces with images, and replace world textures (road asphalt included)'],
          ['Assemble', 'Shift+click several map objects (sign + pole, ...) → Edit tab → Assemble into object → one placeable asset'],
        ]],
        ['Saving & versions', [
          ['Save Draft (Ctrl+S)', 'Saves locally and rebuilds the editor map with your road edits · the playable game stays unchanged'],
          ['Apply to Game', 'The one production update: publishes road curves and game files, then reloads'],
          ['Commits', 'Project tab → snapshot the map as a named version · Restore brings any version back'],
          ['Scenes', 'Highway (real map) or Garage (interior) · each keeps its own project file'],
        ]],
      ];
      for (const [title, rows] of helpSections) {
        const section = element('section', 'help-section');
        section.append(element('h3', '', title));
        for (const [keys, description] of rows) {
          const row = element('div', 'help-row');
          row.append(element('kbd', '', keys), element('span', '', description));
          section.append(row);
        }
        reference.append(section);
      }
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
    if (!tab) return;
    currentTab = tab;
    renderBottom();
    if (tab === 'project') triggerAction('project-refresh-commits');
  });

  const transformText = (values, digits = 3) => values?.map((value) => number(value, digits)).join(', ') || 'Unavailable';

  const renderFaceTextures = (entity) => {
    const section = inspectorSection('Face textures', true);
    const object = entity.object3D;
    if (!object) {
      section.body.append(element('p', 'face-texture-help', 'This selection has no rendered geometry to texture.'));
      return section.details;
    }
    if (entity.metadata?.instanced && entity.generated) {
      section.body.append(element('p', 'face-texture-help', 'This item shares one instanced draw with many copies. Duplicate/place it as an independent object to texture its faces separately.'));
      return section.details;
    }
    const slots = objectFaceSlots(object);
    if (!slots.length) {
      section.body.append(element('p', 'face-texture-help', 'No mesh face slots are exposed by this object.'));
      return section.details;
    }
    section.body.append(element('p', 'face-texture-help', 'Choose an image for each face. Fit & crop keeps image proportions and clips excess to the face silhouette.'));
    for (const slot of slots.slice(0, 64)) {
      const style = entity.metadata?.faceTextures?.[slot.key] || {};
      const texture = textureEntries.find((entry) => entry.id === style.texture);
      const card = element('div', 'face-texture-card');
      const heading = element('div', 'face-texture-heading');
      heading.append(element('b', '', slot.faceName), element('small', '', `${slot.meshLabel} · ${slot.materialName}`));
      if (texture) {
        const thumb = element('img', 'face-texture-thumb');
        thumb.src = textureSourceUrl(texture);
        thumb.alt = texture.name || texture.id;
        heading.prepend(thumb);
      }
      card.append(heading);
      const assign = element('div', 'face-texture-assign');
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${slot.faceName} texture image`);
      select.add(new Option('No image', ''));
      for (const entry of textureEntries) select.add(new Option(entry.name || entry.id, entry.id));
      select.value = style.texture || '';
      select.addEventListener('change', () => triggerAction('face-texture-set', { slotKey: slot.key, texture: select.value || null }));
      const upload = button('Upload…', '', { title: `Upload an image for ${slot.faceName}` });
      upload.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', () => {
          if (input.files?.[0]) triggerAction('face-texture-upload', { slotKey: slot.key, file: input.files[0] });
        }, { once: true });
        input.click();
      });
      assign.append(select, upload);
      card.append(assign);
      if (style.texture) {
        const controls = element('div', 'face-texture-controls');
        const fit = document.createElement('select');
        fit.setAttribute('aria-label', `${slot.faceName} image fit`);
        fit.add(new Option('Stretch', 'stretch'));
        fit.add(new Option('Fit & crop', 'cover'));
        fit.value = style.fit === 'cover' ? 'cover' : 'stretch';
        fit.addEventListener('change', () => triggerAction('face-texture-style', { slotKey: slot.key, patch: { fit: fit.value } }));
        const flipX = button('Flip H', '', { pressed: Boolean(style.flipX), title: 'Flip horizontally' });
        flipX.addEventListener('click', () => triggerAction('face-texture-style', { slotKey: slot.key, patch: { flipX: !style.flipX } }));
        const flipY = button('Flip V', '', { pressed: Boolean(style.flipY), title: 'Flip vertically' });
        flipY.addEventListener('click', () => triggerAction('face-texture-style', { slotKey: slot.key, patch: { flipY: !style.flipY } }));
        const clear = button('Clear', '', { title: 'Remove this face texture' });
        clear.addEventListener('click', () => triggerAction('face-texture-set', { slotKey: slot.key, texture: null }));
        controls.append(fit, flipX, flipY, clear);
        card.append(controls);
      }
      section.body.append(card);
    }
    if (slots.length > 64) section.body.append(element('p', 'face-texture-help', `Showing the first 64 of ${slots.length} face slots.`));
    return section.details;
  };

  let roadState = null;
  const formatMeters = (value) => (!Number.isFinite(value) ? 'Unavailable'
    : (value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${value.toFixed(0)} m`));
  const renderRoadPanel = () => {
    roadPanel.innerHTML = '';
    if (!roadState) { roadPanel.hidden = true; return; }
    roadPanel.hidden = false;
    const head = element('div', 'road-head');
    head.append(element('b', '', 'Road editing'));
    if (roadState.synthetic) head.append(element('span', 'road-badge', 'runtime route'));
    if (roadState.closed) head.append(element('span', 'road-badge', 'loop'));
    const name = element('div', 'road-name', roadState.name || roadState.routeId);
    name.title = roadState.routeId;
    const facts = element('div', 'road-facts');
    const fact = (label, value) => {
      const cell = element('div', 'road-fact');
      cell.append(element('small', '', label), element('b', '', value));
      facts.append(cell);
    };
    fact('Points', String(roadState.pointCount));
    fact('Length', formatMeters(roadState.length));
    fact('Width', Number.isFinite(roadState.roadWidth) ? `${roadState.roadWidth.toFixed(1)} m` : 'Unavailable');
    fact('Lanes', Number.isFinite(roadState.lanes) ? String(roadState.lanes) : 'Unavailable');
    roadPanel.append(head, name, facts);

    const point = element('div', 'road-point');
    const pointHead = element('div', 'road-point-head');
    const hasPoint = Number.isInteger(roadState.activeIndex) && Array.isArray(roadState.activePoint);
    pointHead.append(element('b', '', hasPoint ? `Point ${roadState.activeIndex + 1} of ${roadState.pointCount}` : 'No point selected'));
    const nav = element('div', 'road-point-nav');
    const prev = button('‹ Prev', 'road-point-step', { title: 'Select the previous road point and frame it' });
    prev.addEventListener('click', () => triggerAction('road-point-step', -1));
    const next = button('Next ›', 'road-point-step', { title: 'Select the next road point and frame it' });
    next.addEventListener('click', () => triggerAction('road-point-step', 1));
    nav.append(prev, next);
    pointHead.append(nav);
    point.append(pointHead);
    if (hasPoint) {
      const coords = element('div', 'road-point-coords');
      const inputs = {};
      for (const [axis, value] of [['x', roadState.activePoint[0]], ['z', roadState.activePoint[1]]]) {
        const label = element('label', 'road-coord');
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.value = String(Number(value.toFixed(2)));
        input.setAttribute('aria-label', `Road point ${axis.toUpperCase()} (meters)`);
        input.dataset.testid = `road-point-${axis}`;
        inputs[axis] = input;
        label.append(element('span', '', axis.toUpperCase()), input);
        coords.append(label);
      }
      const applyPoint = () => triggerAction('road-point-apply', { x: Number(inputs.x.value), z: Number(inputs.z.value) });
      const apply = button('Apply', 'road-point-apply', { title: 'Move the selected point to these exact coordinates' });
      apply.addEventListener('click', applyPoint);
      for (const input of Object.values(inputs)) {
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') applyPoint(); });
      }
      coords.append(apply);
      point.append(coords);
      const pointActions = element('div', 'road-point-actions');
      const focusPoint = button('Frame point', 'road-point-focus', { title: 'Move the camera to the selected point' });
      focusPoint.addEventListener('click', () => triggerAction('road-point-focus'));
      const removePoint = button('Delete point', 'road-point-delete', { title: 'Remove the selected road point (Del)' });
      removePoint.classList.add('danger');
      removePoint.addEventListener('click', () => triggerAction('road-point-delete'));
      pointActions.append(focusPoint, removePoint);
      point.append(pointActions);
    } else {
      point.append(element('p', 'road-hint-line', 'Click an orange handle on the road to select a point, or walk the route with Prev / Next.'));
    }
    roadPanel.append(point);

    const hints = element('ul', 'road-hints');
    for (const hint of [
      'Drag an orange point to reshape the road — the asphalt preview follows live.',
      'Right-click (or double-click) the road to add a point there.',
      'Right-click a point, or press Del, to remove it.',
    ]) hints.append(element('li', '', hint));
    roadPanel.append(hints);

    const dirtyLine = element('div', `road-dirty${roadState.dirtyCount ? ' pending' : ''}`);
    dirtyLine.dataset.testid = 'road-dirty';
    dirtyLine.textContent = roadState.dirtyCount
      ? `${roadState.dirtyCount} road${roadState.dirtyCount === 1 ? '' : 's'} changed · Save Draft (Ctrl+S) applies to the editor only`
      : 'No unsaved road changes';
    roadPanel.append(dirtyLine);
  };

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
      inspectorTitle.textContent = 'Inspector';
      inspectorCaption.textContent = entity.editable ? `${entity.name} · editable` : `${entity.name} · read-only`;
      const identity = inspectorSection('Summary', true);
      if (selectedIds?.size > 1) property(identity.body, 'Multi-selection', `${selectedIds.size} objects · delete/duplicate/visibility/lock apply to all`);
      property(identity.body, 'Name', entity.name);
      property(identity.body, 'ID', entity.id, 'selected-entity-id');
      property(identity.body, 'Type', entity.type);
      property(identity.body, 'Layer', entity.layer);
      property(identity.body, 'Source', entity.source);
      property(identity.body, 'Kind', entity.generated ? (metadata.sourceKind || 'Generated') : 'Placed object');
      property(identity.body, 'Editable', entity.editable ? 'Yes' : 'No');
      property(identity.body, 'Asset', entity.assetId || 'Unavailable');

      const transform = inspectorSection('Transform', true);
      property(transform.body, 'Local position', object ? transformText(object.position.toArray()) : 'Unavailable: semantic metadata entity');
      property(transform.body, 'Rotation', object ? `${transformText(object.rotation.toArray().slice(0, 3).map((value) => value * 180 / Math.PI), 2)}°` : 'Unavailable');
      property(transform.body, 'Scale', object ? transformText(object.scale.toArray()) : 'Unavailable');
      property(transform.body, 'Bounds', dimensions ? `${number(dimensions.x)} × ${number(dimensions.y)} × ${number(dimensions.z)} m` : 'Unavailable');
      property(transform.body, 'Override', metadata.hasOverride ? 'Yes' : 'No');
      if (object && entity.editable) {
        const numeric = element('div', 'numeric-transform');
        const fields = {};
        const addVector = (key, label, values, step) => {
          const row = element('div', 'numeric-vector');
          row.append(element('span', '', label));
          fields[key] = [];
          ['X', 'Y', 'Z'].forEach((axis, index) => {
            const input = document.createElement('input');
            input.type = 'number';
            input.step = step;
            input.value = String(Number(values[index].toFixed(4)));
            input.setAttribute('aria-label', `${label} ${axis}`);
            fields[key].push(input);
            row.append(input);
          });
          numeric.append(row);
        };
        addVector('position', 'Position', object.position.toArray(), '0.1');
        addVector('rotationDegrees', 'Rotation °', object.rotation.toArray().slice(0, 3).map((value) => value * 180 / Math.PI), '1');
        addVector('scale', 'Scale', object.scale.toArray(), '0.05');
        const apply = button('Apply numeric transform', 'numeric-transform');
        apply.addEventListener('click', () => triggerAction('numeric-transform', Object.fromEntries(
          Object.entries(fields).map(([key, inputs]) => [key, inputs.map((input) => Number(input.value))]),
        )));
        numeric.append(apply);
        transform.body.append(numeric);
      }

      const world = inspectorSection('World');
      property(world.body, 'Route', metadata.routeId || 'Unavailable');
      property(world.body, 'Along route', Number.isFinite(metadata.routeDistance) ? `${metadata.routeDistance.toFixed(1)} m` : 'Unavailable');
      property(world.body, 'Service area', metadata.serviceAreaId || 'Unavailable');
      property(world.body, 'Chunk', metadata.chunk || 'Unavailable');
      property(world.body, 'Map origin', adapter?.metadata?.mapOrigin ? `${adapter.metadata.mapOrigin.lat.toFixed(6)}, ${adapter.metadata.mapOrigin.lon.toFixed(6)}` : 'Unavailable');
      property(world.body, 'GPS', gps ? `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}` : 'GPS unavailable for this entity');

      const rendering = inspectorSection('Rendering');
      property(rendering.body, 'Meshes', String(render.meshCount ?? 0));
      property(rendering.body, 'Triangles', Number.isFinite(render.triangleCount) ? render.triangleCount.toLocaleString() : 'Unavailable');
      property(rendering.body, 'Materials', render.materialNames?.join(', ') || 'Unavailable');
      property(rendering.body, 'Textures', render.textureReferences?.join(', ') || 'None exposed');
      property(rendering.body, 'Render order', String(render.renderOrder ?? 'Unavailable'));
      property(rendering.body, 'Shadows', render.castShadow || render.receiveShadow ? `cast ${Boolean(render.castShadow)} / receive ${Boolean(render.receiveShadow)}` : 'Disabled');
      property(rendering.body, 'LOD', render.lod || 'Unavailable');

      const physics = inspectorSection('Physics & collision');
      property(physics.body, 'Available', metadata.collisionAvailable ? 'Yes' : 'No authored collision for this entity');
      property(physics.body, 'Source', metadata.collisionSource || 'Unavailable');
      property(physics.body, 'Type', metadata.collisionType || 'Unavailable');
      property(physics.body, 'Note', metadata.collisionAvailable && entity.editable ? 'Transform overrides do not rewrite analytic runtime collision' : 'None detected / unavailable');

      const optimization = inspectorSection('Optimization');
      property(optimization.body, 'Classification', metadata.static === false ? 'Dynamic' : 'Static');
      property(optimization.body, 'Instanced', metadata.instanced ? 'Yes' : 'No');
      property(optimization.body, 'Repeated count', String(render.repeatedAssetCount ?? metadata.instanceCount ?? 'Unavailable'));
      property(optimization.body, 'Reusable asset', entity.assetId ? 'Eligible' : 'Unavailable');
      property(optimization.body, 'Draw calls', String(render.drawCallContribution ?? 'Unavailable'));
      property(optimization.body, 'Geometry', render.geometryShared ? 'Shared' : 'Unique or unavailable');
      property(optimization.body, 'Material', render.materialShared ? 'Shared' : 'Unique or unavailable');
      const faceTextures = renderFaceTextures(entity);
      inspectorContent.append(identity.details, transform.details, faceTextures, world.details, rendering.details, physics.details, optimization.details);
      return;
    }
    inspectorTitle.textContent = 'Inspector';
    inspectorCaption.textContent = 'Nothing selected';
    const empty = element('div', 'inspector-empty');
    empty.append(
      element('p', '', 'Nothing selected.'),
      element('p', '', 'Click an object in the viewport, or pick one from the Scene hierarchy on the left.'),
      element('p', '', 'Use + Add Object to place new assets into the world.'),
    );
    inspectorContent.append(empty);
    const metadata = adapter?.metadata;
    const identity = inspectorSection('World source');
    property(identity.body, 'Mode', adapter?.strategy || 'Pending', 'inspector-world-strategy');
    property(identity.body, 'Label', adapter?.label || 'Pending');
    property(identity.body, 'Generator', adapter?.isRealWorld ? 'js/map.js · HighwayMap' : 'Editor demo adapter');
    const inventory = inspectorSection('Generated inventory');
    property(inventory.body, 'Routes', metadata ? String(metadata.routeCount) : null, 'route-count');
    property(inventory.body, 'Service areas', metadata ? String(metadata.serviceAreaCount ?? 'Unavailable') : null);
    property(inventory.body, 'Junctions', metadata ? String(metadata.junctionCount ?? 'Unavailable') : null);
    property(inventory.body, 'Chunks', metadata ? String(metadata.chunkCount ?? 'Unavailable') : null);
    inspectorContent.append(identity.details, inventory.details);
  };
  renderInspector();

  presetSelect.addEventListener('change', () => {
    if (presetSelect.value) presetSelect.dispatchEvent(new CustomEvent('preset-selected', { detail: presetSelect.value }));
  });
  hierarchySearch.addEventListener('input', () => { if (registryRef) renderRegistryImpl(registryRef); });
  inspectLocked.addEventListener('change', () => inspectLockedHandler(inspectLocked.checked));

  const entityRow = (item) => {
    const row = element('button', `entity-row${(selectedIds ? selectedIds.has(item.id) : selectedEntity?.id === item.id) ? ' selected' : ''}`);
    row.type = 'button';
    row.textContent = item.name;
    row.title = `${item.id} / ${item.type} / ${item.editable ? 'editable' : 'read-only'}`;
    row.dataset.entityId = item.id;
    row.append(element('small', '', item.id));
    row.addEventListener('click', (event) => entitySelectHandler(item.id, { additive: event.shiftKey }));
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
      const lock = element('button', `layer-lock${layer.locked ? ' locked' : ''}`, layer.locked ? 'Locked' : 'Open');
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
      details.open = selectedEntity?.layer === layer.name;
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
      header.querySelector(`[data-action="${action}"]`)?.addEventListener('click', handler);
    },
    onPreset(handler) { presetSelect.addEventListener('preset-selected', (event) => handler(event.detail)); },
    onEntitySelect(handler) { entitySelectHandler = handler; },
    onInspectLocked(handler) { inspectLockedHandler = handler; },
    onAction(handler) { actionHandler = handler; },
    setToggle(action, pressed) {
      header.querySelector(`[data-action="${action}"]`)?.setAttribute('aria-pressed', String(Boolean(pressed)));
    },
    setHistory(state) {
      historyState = { ...historyState, ...state };
      const undo = header.querySelector('[data-action="undo"]');
      const redo = header.querySelector('[data-action="redo"]');
      undo.disabled = !historyState.canUndo;
      redo.disabled = !historyState.canRedo;
      undo.textContent = 'Undo';
      redo.textContent = 'Redo';
      undo.title = historyState.undoLabel ? `Undo: ${historyState.undoLabel}` : 'Nothing to undo';
      redo.title = historyState.redoLabel ? `Redo: ${historyState.redoLabel}` : 'Nothing to redo';
      syncSaveState();
      if (currentTab === 'project') renderBottom();
    },
    setTransformState(state) {
      transformState = { ...transformState, ...state, axes: { ...transformState.axes, ...(state.axes || {}) } };
      for (const mode of ['translate', 'rotate', 'scale']) this.setToggle(`transform-${mode}`, transformState.mode === mode);
      this.setToggle('transform-space', transformState.space === 'world');
      const space = header.querySelector('[data-action="transform-space"]');
      if (space) space.textContent = transformState.space === 'world' ? 'World' : 'Local';
      if (currentTab === 'edit') renderBottom();
    },
    setDirty(dirty) {
      historyState.dirty = Boolean(dirty);
      syncSaveState();
    },
    setGridSnap({ enabled, step } = {}) {
      this.setToggle('grid-snap', enabled);
      if (Number(step) > 0) gridSnapStepSelect.value = String(step);
    },
    setPublishState(state = {}) {
      if ('roadDirty' in state) roadDraftDirty = Boolean(state.roadDirty);
      if ('gamePending' in state) gamePending = Boolean(state.gamePending);
      syncSaveState();
      if (currentTab === 'project') renderBottom();
    },
    setProject(info) {
      projectInfo = { ...projectInfo, ...info };
      bottomCaption.textContent = `Project · ${projectInfo.path}`;
      if (currentTab === 'project') renderBottom();
    },
    showTab(tab) {
      if (!['assets', 'edit', 'project', 'world', 'help'].includes(tab)) return false;
      currentTab = tab;
      renderBottom();
      return true;
    },
    setAssets(entries) {
      assetEntries = Array.isArray(entries) ? entries : [];
      if (currentTab === 'assets') renderBottom();
    },
    setPlacement(active, label = '') {
      placementHint.hidden = !active;
      placementHint.textContent = active ? `Placing ${label} — click a surface to place · Esc to cancel` : '';
    },
    setViewState(next) {
      Object.assign(viewState, next);
      syncViewMenu();
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
    showProjectNotice(message) {
      projectNotice.textContent = message || '';
      projectNotice.hidden = !message;
    },
    setStatus(message) { statusMessage.textContent = message; },
    setAdapter(nextAdapter) {
      adapter = nextAdapter;
      adapterChip.textContent = `World: ${adapter.label}`;
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
    setSelection(entity, { ids = null } = {}) {
      selectedEntity = entity || null;
      selectedIds = Array.isArray(ids) && ids.length ? new Set(ids) : (entity ? new Set([entity.id]) : null);
      renderInspector();
      if (registryRef) renderRegistryImpl(registryRef);
      const selectedRow = entity ? entityTree.querySelector(`[data-entity-id="${CSS.escape(entity.id)}"]`) : null;
      selectedRow?.scrollIntoView?.({ block: 'nearest' });
      if (currentTab === 'edit') renderBottom();
    },
    setTextures(entries) {
      textureEntries = Array.isArray(entries) ? entries : [];
      renderInspector();
    },
    setRoadEdit(state) {
      roadState = state?.active ? state : null;
      renderRoadPanel();
    },
    refreshInspector() { renderInspector(); },
    setNavigation({ mode, speed, speedPreset, pointerLocked }) {
      const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
      viewportLabel.textContent = `${modeLabel} · ${Math.round(speed)} m/s${pointerLocked ? ' · pointer locked' : ''}`;
      speedGroup.hidden = mode !== 'fly';
      crosshair.hidden = mode !== 'fly';
      crosshair.classList.toggle('locked', Boolean(pointerLocked));
      this.setToggle('nav-orbit', mode === 'orbit');
      this.setToggle('nav-fly', mode === 'fly');
      for (const preset of ['slow', 'normal', 'fast']) this.setToggle(`speed-${preset}`, speedPreset === preset);
    },
    setScene(scene) {
      currentScene = scene || null;
      brandScene.textContent = scene?.label ? `Scene · ${scene.label}` : '';
      for (const [sceneId, seg] of sceneButtons) seg.setAttribute('aria-checked', String(sceneId === scene?.id));
      if (currentTab === 'project') renderBottom();
    },
    setCommits(list) {
      commitList = Array.isArray(list) ? list : [];
      commitsLoaded = true;
      if (currentTab === 'project') renderBottom();
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
    dispose() {
      window.removeEventListener('resize', onWorkspaceResize);
      root.innerHTML = '';
    },
  };
}
