import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  PART_KINDS, WORLD_TEXTURE_SLOTS, applyVertexOffsets, buildPartObject, convertPartToMesh,
  meshInsertVertexAtPoint, meshRemoveVertex, partFaceNames, partGeometry, weldedVertices,
} from '/js/custom-assets.js';
import { assetPartResolver, bakeAssetPartComponents, refreshCustomAsset } from '../world/custom-asset-integration.js';

const clone = (value) => value == null ? value : structuredClone(value);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className = 'tool-button', title = '') {
  const node = element('button', className, label);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

const PRIMITIVE_BUTTONS = ['box', 'cylinder', 'pyramid', 'cone', 'wedge', 'plane', 'sphere'];
const SUBDIVIDABLE_KINDS = ['box', 'cylinder', 'pyramid', 'cone', 'plane'];
const SNAP_STEPS = [0.05, 0.1, 0.25, 0.5, 1];
const HISTORY_LIMIT = 60;

function blankDefinition(id) {
  return {
    id,
    label: 'New object',
    description: 'Custom modeled object',
    layer: 'Props',
    createdAt: new Date().toISOString(),
    parts: [{ kind: 'box', name: 'Box', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#9aa7b5', faces: {} }],
  };
}

/**
 * The Modeler: an always-reachable overlay section of the world editor where
 * PSX-style low-poly objects are created from simple primitive parts, faces
 * are textured by attaching images, vertices are pushed around, existing
 * catalog assets are assembled into single objects, and world textures (the
 * repeated road asphalt among them) are replaced. Saved objects land in the
 * shared asset catalog so they can be placed into the map like any world
 * asset — and the playable game rebuilds them from the same saved document.
 */
export class ModelerPanel {
  constructor({ host, store, assetRegistry, onStatus = () => {}, onAssetsChanged = () => {}, onWorldTexturesChanged = () => {}, isAssetInUse = () => false, onOpenChange = () => {} }) {
    Object.assign(this, { store, assetRegistry, onStatus, onAssetsChanged, onWorldTexturesChanged, isAssetInUse, onOpenChange });
    this.openState = false;
    this.definition = null;
    this.editingExisting = false;
    this.mode = 'part';
    this.selectedPart = -1;
    this.selectedFace = null;
    this.selectedVertex = -1;
    this.partNodes = [];
    this.vertexHandles = [];
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.frameId = 0;
    this.disposed = false;
    this.snapEnabled = false;
    this.snapStep = 0.25;
    this.carRef = null;
    this.carRefVisible = false;
    this.history = [];
    this.historyIndex = -1;
    this._rightDownAt = null;

    this._buildDom(host);
    this._buildScene();
    this._bindEvents();
  }

  // ------------------------------------------------------------------ DOM --
  _buildDom(host) {
    this.overlay = element('div', 'modeler-overlay');
    this.overlay.hidden = true;
    this.overlay.dataset.testid = 'modeler-overlay';

    const header = element('header', 'modeler-header');
    header.append(element('strong', '', 'Object Modeler'));
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className = 'modeler-name';
    this.nameInput.placeholder = 'Object name';
    this.nameInput.setAttribute('aria-label', 'Object name');
    this.layerSelect = document.createElement('select');
    this.layerSelect.className = 'modeler-layer';
    this.layerSelect.setAttribute('aria-label', 'Asset layer');
    for (const layer of ['Props', 'Signs', 'Barriers', 'Guardrails', 'Lamps', 'Pillars', 'Garage']) {
      this.layerSelect.add(new Option(layer, layer));
    }
    this.saveButton = button('Save Object', 'tool-button accent', 'Save this object into the asset catalog (and the game document)');
    this.saveCopyButton = button('Save As Copy', 'tool-button', 'Save as a brand-new asset id');
    this.deleteButton = button('Delete Object', 'tool-button danger', 'Remove this custom asset');
    this.closeButton = button('Close ✕', 'tool-button', 'Back to the map editor');
    this.dirtyChip = element('span', 'modeler-dirty', '');
    header.append(this.nameInput, this.layerSelect, this.saveButton, this.saveCopyButton, this.deleteButton, this.dirtyChip, element('span', 'toolbar-spacer'), this.closeButton);

    const body = element('div', 'modeler-body');

    // Left: object library + part list + add-part tools
    const left = element('aside', 'modeler-panel modeler-left');
    left.append(element('h3', '', 'Your objects'));
    this.newObjectButton = button('+ New Object', 'tool-button primary', 'Start a fresh object');
    left.append(this.newObjectButton);
    this.assetList = element('div', 'modeler-asset-list');
    left.append(this.assetList);
    left.append(element('h3', '', 'Parts'));
    this.partList = element('div', 'modeler-part-list');
    left.append(this.partList);
    const addRow = element('div', 'modeler-add-parts');
    addRow.append(element('small', '', 'Add part'));
    this.addButtons = {};
    for (const kind of PRIMITIVE_BUTTONS) {
      const add = button(PART_KINDS[kind].label, 'tool-button small');
      add.dataset.kind = kind;
      this.addButtons[kind] = add;
      addRow.append(add);
    }
    left.append(addRow);
    const catalogRow = element('div', 'modeler-add-catalog');
    catalogRow.append(element('small', '', 'Add existing asset as part (assembly)'));
    this.catalogSelect = document.createElement('select');
    this.catalogSelect.setAttribute('aria-label', 'Catalog asset to add');
    this.addCatalogButton = button('Add', 'tool-button small');
    catalogRow.append(this.catalogSelect, this.addCatalogButton);
    left.append(catalogRow);
    const scaleRow = element('div', 'modeler-object-scale');
    scaleRow.append(element('small', '', 'Object scale (all parts at once)'));
    this.scaleHalfButton = button('×½', 'tool-button small', 'Shrink the whole object to half size');
    this.scaleDoubleButton = button('×2', 'tool-button small', 'Double the whole object size');
    this.scaleFactorInput = document.createElement('input');
    this.scaleFactorInput.type = 'number';
    this.scaleFactorInput.step = '0.1';
    this.scaleFactorInput.min = '0.01';
    this.scaleFactorInput.value = '1.5';
    this.scaleFactorInput.setAttribute('aria-label', 'Custom object scale factor');
    this.scaleApplyButton = button('Apply ×', 'tool-button small', 'Scale the whole object by the custom factor');
    scaleRow.append(this.scaleHalfButton, this.scaleDoubleButton, this.scaleFactorInput, this.scaleApplyButton);
    left.append(scaleRow);

    // Center: viewport + mode switch
    const center = element('section', 'modeler-viewport-wrap');
    const modeBar = element('div', 'modeler-modebar');
    this.modeButtons = {};
    for (const [mode, label, title] of [
      ['part', 'Parts', 'Select and transform whole parts (move W · rotate E · scale R)'],
      ['face', 'Faces', 'Click a face, then attach an image texture to it'],
      ['vertex', 'Vertices', 'Drag vertex handles for that hand-made PSX shape'],
    ]) {
      const node = button(label, 'tool-button');
      node.dataset.mode = mode;
      node.title = title;
      this.modeButtons[mode] = node;
      modeBar.append(node);
    }
    this.addVerticesButton = button('+ Vertices', 'tool-button small', 'Subdivide the selected part for more editable vertices (resets its vertex edits)');
    this.addVerticesButton.hidden = true;
    this.undoButton = button('⟲', 'tool-button small', 'Undo (Ctrl+Z)');
    this.redoButton = button('⟳', 'tool-button small', 'Redo (Ctrl+Y)');
    this.snapButton = button('Snap', 'tool-button small', 'Snap to grid while dragging (G): parts and vertices land on clean steps');
    this.snapButton.setAttribute('aria-pressed', 'false');
    this.snapStepSelect = document.createElement('select');
    this.snapStepSelect.className = 'modeler-snap-step';
    this.snapStepSelect.setAttribute('aria-label', 'Snap step in meters');
    for (const step of SNAP_STEPS) this.snapStepSelect.add(new Option(`${step} m`, String(step)));
    this.snapStepSelect.value = String(this.snapStep);
    this.carRefButton = button('🚗 Car', 'tool-button small', 'Show the player car next to the object for a sense of scale (4.25 × 1.7 × 1.3 m)');
    this.carRefButton.setAttribute('aria-pressed', 'false');
    this.modeHint = element('span', 'modeler-mode-hint', '');
    modeBar.append(
      this.addVerticesButton,
      element('span', 'modeler-modebar-sep'),
      this.undoButton, this.redoButton,
      element('span', 'modeler-modebar-sep'),
      this.snapButton, this.snapStepSelect, this.carRefButton,
      this.modeHint,
    );
    this.viewportHost = element('div', 'modeler-viewport');
    this.viewportHost.dataset.testid = 'modeler-viewport';
    center.append(modeBar, this.viewportHost);

    // Right: inspector for part / face / textures / world textures
    const right = element('aside', 'modeler-panel modeler-right');
    this.inspector = element('div', 'modeler-inspector');
    right.append(this.inspector);
    right.append(element('h3', '', 'Texture library'));
    this.textureList = element('div', 'modeler-texture-list');
    right.append(this.textureList);
    this.uploadTextureButton = button('Upload image…', 'tool-button', 'Add an image to the texture library');
    right.append(this.uploadTextureButton);
    right.append(element('h3', '', 'World textures'));
    right.append(element('p', 'modeler-help', 'Replace the repeated textures of the generated map — the road asphalt image tiles along every segment.'));
    this.worldTextureList = element('div', 'modeler-world-textures');
    right.append(this.worldTextureList);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.hidden = true;

    body.append(left, center, right);
    this.overlay.append(header, body, this.fileInput);
    host.append(this.overlay);
  }

  // ---------------------------------------------------------------- scene --
  _buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x11161d);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
    this.camera.position.set(4, 3, 5);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.viewportHost.append(this.renderer.domElement);

    const grid = new THREE.GridHelper(20, 20, 0x5a6472, 0x2c333d);
    grid.position.y = -0.001;
    this.scene.add(grid);
    this.scene.add(new THREE.AmbientLight(0xcfdcea, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, 10, 4);
    this.scene.add(key);
    const fill = new THREE.HemisphereLight(0xd7e5f7, 0x3d4450, 0.8);
    this.scene.add(fill);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.1;
    this.orbit.target.set(0, 0.6, 0);
    this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.85);
    this.scene.add(this.gizmo);
    this.gizmo.addEventListener('dragging-changed', (event) => { this.orbit.enabled = !event.value; });
    this.gizmo.addEventListener('objectChange', () => this._onGizmoChange());
    this.gizmo.addEventListener('mouseUp', () => this._onGizmoDrop());

    this.assetGroup = new THREE.Group();
    this.assetGroup.name = 'Modeler object';
    this.scene.add(this.assetGroup);
    this.handleGroup = new THREE.Group();
    this.scene.add(this.handleGroup);

    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(this.viewportHost);
  }

  _resize() {
    const width = Math.max(1, this.viewportHost.clientWidth);
    const height = Math.max(1, this.viewportHost.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  _renderLoop = (now) => {
    if (this.disposed || !this.openState) return;
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this._renderLoop);
  };

  // --------------------------------------------------------------- events --
  _bindEvents() {
    this.closeButton.addEventListener('click', () => this.close());
    this.newObjectButton.addEventListener('click', () => this._loadDefinition(null));
    this.nameInput.addEventListener('input', () => { if (this.definition) { this.definition.label = this.nameInput.value; this._markDirty({ history: false }); } });
    this.nameInput.addEventListener('change', () => { if (this.definition) this._recordHistory(); });
    this.layerSelect.addEventListener('change', () => { if (this.definition) { this.definition.layer = this.layerSelect.value; this._markDirty(); } });
    this.saveButton.addEventListener('click', () => this._save(false));
    this.saveCopyButton.addEventListener('click', () => this._save(true));
    this.deleteButton.addEventListener('click', () => this._deleteAsset());
    for (const [kind, node] of Object.entries(this.addButtons)) node.addEventListener('click', () => this._addPart(kind));
    this.addCatalogButton.addEventListener('click', () => this._addCatalogPart());
    for (const [mode, node] of Object.entries(this.modeButtons)) node.addEventListener('click', () => this._setMode(mode));
    this.addVerticesButton.addEventListener('click', () => this._addVertices());
    this.undoButton.addEventListener('click', () => this._undo());
    this.redoButton.addEventListener('click', () => this._redo());
    this.snapButton.addEventListener('click', () => this._setSnap(!this.snapEnabled));
    this.snapStepSelect.addEventListener('change', () => {
      this.snapStep = Number(this.snapStepSelect.value) || 0.25;
      if (this.snapEnabled) this._applySnap();
    });
    this.carRefButton.addEventListener('click', () => this._toggleCarReference());
    this.scaleHalfButton.addEventListener('click', () => this._scaleObject(0.5));
    this.scaleDoubleButton.addEventListener('click', () => this._scaleObject(2));
    this.scaleApplyButton.addEventListener('click', () => this._scaleObject(Number(this.scaleFactorInput.value)));
    this.uploadTextureButton.addEventListener('click', () => this._pickImage((textureId) => {
      this._markDirty({ history: false });
      this._renderTextures();
      this.onStatus(`Added texture ${textureId} to the library`);
    }));

    this._onPointerDown = (event) => {
      if (event.button === 2) {
        // Remember where the right button went down: a right-DRAG is an
        // orbit pan and must not edit vertices when contextmenu fires.
        this._rightDownAt = { x: event.clientX, y: event.clientY };
        return;
      }
      if (event.button !== 0 || this.gizmo.dragging) return;
      this._pick(event);
    };
    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);

    this._onContextMenu = (event) => {
      // Never show the browser context menu over the modeler viewport —
      // right click is a modeling action here.
      event.preventDefault();
      event.stopPropagation();
      const downAt = this._rightDownAt;
      this._rightDownAt = null;
      if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return; // was a pan
      this._rightClick(event);
    };
    this.renderer.domElement.addEventListener('contextmenu', this._onContextMenu);

    this._onKeyDown = (event) => {
      if (!this.openState) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyZ') {
        event.preventDefault();
        if (event.shiftKey) this._redo(); else this._undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyY') { event.preventDefault(); this._redo(); return; }
      if (event.ctrlKey || event.metaKey) return;
      if (event.code === 'Escape') { event.preventDefault(); this._detachGizmo(); return; }
      if (event.code === 'Delete') { event.preventDefault(); this._deleteSelectedPart(); return; }
      if (event.code === 'KeyG') { event.preventDefault(); this._setSnap(!this.snapEnabled); return; }
      const modes = { KeyW: 'translate', KeyE: 'rotate', KeyR: 'scale' };
      if (modes[event.code] && this.mode === 'part') { event.preventDefault(); this.gizmo.setMode(modes[event.code]); }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  // ----------------------------------------------------------- open/close --
  get isOpen() { return this.openState; }

  open(assetId = undefined) {
    this.openState = true;
    this.overlay.hidden = false;
    if (assetId !== undefined || !this.definition) this._loadDefinition(assetId ?? null);
    else this._renderAll();
    this._resize();
    cancelAnimationFrame(this.frameId);
    this.frameId = requestAnimationFrame(this._renderLoop);
    this.onOpenChange(true);
    this.onStatus('Modeler open · build parts, texture faces, then Save Object to add it to the asset catalog');
  }

  close() {
    this.openState = false;
    this.overlay.hidden = true;
    cancelAnimationFrame(this.frameId);
    this._detachGizmo();
    this.onOpenChange(false);
  }

  _loadDefinition(assetId) {
    const existing = assetId ? this.store.getAsset(assetId) : null;
    this.definition = existing ? clone(existing) : blankDefinition(this.store.newAssetId());
    this.editingExisting = Boolean(existing);
    this.selectedPart = this.definition.parts.length ? 0 : -1;
    this.selectedFace = null;
    this.selectedVertex = -1;
    this._detachGizmo();
    this._resetHistory();
    this._renderAll();
  }

  /** Loads a world/catalog asset as the starting point of a new object. */
  editCopyOfAsset(sourceAssetId) {
    const asset = this.assetRegistry.get(sourceAssetId);
    if (!asset) { this.onStatus(`Asset unavailable: ${sourceAssetId}`); return; }
    if (asset.kind === 'custom') { this.open(sourceAssetId); return; }
    this.definition = {
      id: this.store.newAssetId(),
      label: `${asset.label || sourceAssetId} custom`,
      description: `Based on ${asset.label || sourceAssetId}`,
      layer: asset.layer || 'Props',
      createdAt: new Date().toISOString(),
      parts: [{
        kind: 'asset',
        name: asset.label || sourceAssetId,
        assetRef: sourceAssetId,
        components: bakeAssetPartComponents(this.assetRegistry, sourceAssetId),
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      }],
    };
    this.editingExisting = false;
    this.selectedPart = 0;
    this.selectedFace = null;
    this.selectedVertex = -1;
    this.open();
    this._resetHistory();
    this._renderAll();
    this._markDirty({ history: false });
  }

  /** Opens the modeler pre-loaded with an assembled definition (from map selection). */
  openAssembled(definition) {
    this.definition = clone(definition);
    this.editingExisting = false;
    this.selectedPart = 0;
    this.selectedFace = null;
    this.selectedVertex = -1;
    this.open();
    this._resetHistory();
    this._renderAll();
    this._markDirty({ history: false });
  }

  // ------------------------------------------------------------ rendering --
  _renderAll() {
    this.nameInput.value = this.definition?.label || '';
    this.layerSelect.value = this.definition?.layer || 'Props';
    this._rebuildObject();
    this._renderAssetList();
    this._renderPartList();
    this._renderCatalogSelect();
    this._renderInspector();
    this._renderTextures();
    this._renderWorldTextures();
    this._syncModeButtons();
    this.dirtyChip.textContent = this.store.dirty ? 'Unsaved changes' : '';
  }

  _markDirty({ history = true } = {}) {
    this.store.dirty = true;
    this.dirtyChip.textContent = 'Unsaved changes';
    if (history) this._recordHistory();
  }

  // ---------------------------------------------------------- undo / redo --
  _snapshot() {
    return { definition: clone(this.definition), selectedPart: this.selectedPart };
  }

  _resetHistory() {
    this.history = this.definition ? [this._snapshot()] : [];
    this.historyIndex = this.history.length - 1;
  }

  _recordHistory() {
    if (!this.definition) return;
    const entry = this._snapshot();
    const current = this.history[this.historyIndex];
    if (current && JSON.stringify(current.definition) === JSON.stringify(entry.definition)) return;
    this.history.length = this.historyIndex + 1;
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  _undo() {
    if (this.historyIndex <= 0) { this.onStatus('Nothing to undo'); return; }
    this.historyIndex -= 1;
    this._restoreHistoryEntry();
    this.onStatus(`Undo · ${this.historyIndex} step${this.historyIndex === 1 ? '' : 's'} left`);
  }

  _redo() {
    if (this.historyIndex >= this.history.length - 1) { this.onStatus('Nothing to redo'); return; }
    this.historyIndex += 1;
    this._restoreHistoryEntry();
    this.onStatus('Redo');
  }

  _restoreHistoryEntry() {
    const entry = this.history[this.historyIndex];
    if (!entry) return;
    this.definition = clone(entry.definition);
    this.selectedPart = Math.min(entry.selectedPart, this.definition.parts.length - 1);
    this.selectedFace = null;
    this.selectedVertex = -1;
    this.store.dirty = true;
    this._renderAll();
    this.dirtyChip.textContent = 'Unsaved changes';
  }

  _rebuildObject() {
    this._detachGizmo();
    this.assetGroup.clear();
    this.partNodes = [];
    if (!this.definition) return;
    const resolver = assetPartResolver(this.assetRegistry);
    this.definition.parts.forEach((part, index) => {
      const node = buildPartObject(part, this.store.texturesById(), { resolveAssetPart: resolver });
      if (node) {
        node.userData.partIndex = index;
        node.traverse((child) => { child.userData.partIndex = index; });
        this.assetGroup.add(node);
      }
      this.partNodes[index] = node;
    });
    this._rebuildVertexHandles();
    this._attachGizmoToSelection();
    if (this.carRefVisible) this._positionCarReference();
  }

  _rebuildPartGeometry(index) {
    const part = this.definition.parts[index];
    const node = this.partNodes[index];
    if (!part || !node?.isMesh || part.kind === 'asset') return;
    const geometry = partGeometry(part);
    if (!geometry) return;
    applyVertexOffsets(geometry, part.vertexOffsets);
    node.geometry.dispose();
    node.geometry = geometry;
  }

  _rebuildVertexHandles() {
    this.handleGroup.clear();
    this.vertexHandles = [];
    if (this.mode !== 'vertex') return;
    const part = this.definition?.parts[this.selectedPart];
    const node = this.partNodes[this.selectedPart];
    if (!part || part.kind === 'asset' || !node?.isMesh) return;
    // Mesh parts manage vertices directly (handle index == part.vertices
    // index); primitives keep the welded-corner + offset system.
    let welded;
    let offsets;
    if (part.kind === 'mesh') {
      welded = part.vertices;
      offsets = new Map();
    } else {
      const base = partGeometry(part);
      ({ welded } = weldedVertices(base));
      base.dispose();
      offsets = new Map((part.vertexOffsets || []).map((entry) => [entry.i, entry.o]));
    }
    const handleGeometry = new THREE.SphereGeometry(0.045, 8, 6);
    node.updateWorldMatrix(true, false);
    welded.forEach((position, weldIndex) => {
      const offset = offsets.get(weldIndex) || [0, 0, 0];
      const material = new THREE.MeshBasicMaterial({ color: weldIndex === this.selectedVertex ? 0xffb020 : 0x57e3ff, depthTest: false });
      const handle = new THREE.Mesh(handleGeometry, material);
      handle.renderOrder = 10;
      handle.position.set(position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]).applyMatrix4(node.matrixWorld);
      handle.userData.weldIndex = weldIndex;
      handle.userData.basePosition = position;
      this.handleGroup.add(handle);
      this.vertexHandles.push(handle);
    });
  }

  _renderAssetList() {
    this.assetList.innerHTML = '';
    const assets = this.store.assets().sort((a, b) => (a.label || '').localeCompare(b.label || ''));
    if (!assets.length) this.assetList.append(element('p', 'modeler-help', 'No custom objects yet. Build parts and Save Object.'));
    for (const asset of assets) {
      const row = element('button', `modeler-asset-row${this.definition?.id === asset.id ? ' selected' : ''}`);
      row.type = 'button';
      row.append(element('b', '', asset.label || asset.id), element('small', '', `${asset.parts.length} part${asset.parts.length === 1 ? '' : 's'} · ${asset.id}`));
      row.addEventListener('click', () => this._loadDefinition(asset.id));
      this.assetList.append(row);
    }
  }

  _renderPartList() {
    this.partList.innerHTML = '';
    if (!this.definition) return;
    this.definition.parts.forEach((part, index) => {
      const row = element('div', `modeler-part-row${index === this.selectedPart ? ' selected' : ''}`);
      const pick = element('button', 'modeler-part-pick', part.name || PART_KINDS[part.kind]?.label || part.kind);
      pick.type = 'button';
      pick.addEventListener('click', () => this._selectPart(index));
      const duplicate = button('⧉', 'tool-button small', 'Duplicate part');
      duplicate.addEventListener('click', () => {
        const copy = clone(part);
        copy.position = [...(copy.position || [0, 0, 0])];
        copy.position[0] += 0.5;
        this.definition.parts.splice(index + 1, 0, copy);
        this._selectPart(index + 1);
        this._markDirty();
        this._renderAll();
      });
      const remove = button('✕', 'tool-button small danger', 'Remove part');
      remove.addEventListener('click', () => {
        this.definition.parts.splice(index, 1);
        this.selectedPart = Math.min(this.selectedPart, this.definition.parts.length - 1);
        this._markDirty();
        this._renderAll();
      });
      row.append(pick, duplicate, remove);
      this.partList.append(row);
    });
  }

  _renderCatalogSelect() {
    const previous = this.catalogSelect.value;
    this.catalogSelect.innerHTML = '';
    for (const entry of this.assetRegistry.catalog()) {
      if (entry.id === this.definition?.id) continue; // no self-nesting
      this.catalogSelect.add(new Option(`${entry.label} (${entry.kind})`, entry.id));
    }
    if (previous) this.catalogSelect.value = previous;
  }

  _renderInspector() {
    this.inspector.innerHTML = '';
    const part = this.definition?.parts[this.selectedPart];
    if (!part) {
      this.inspector.append(element('p', 'modeler-help', 'Select a part in the list or click it in the viewport.'));
      return;
    }
    this.inspector.append(element('h3', '', `Part · ${PART_KINDS[part.kind]?.label || part.kind}`));

    const nameRow = element('label', 'modeler-field');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = part.name || '';
    nameInput.addEventListener('change', () => { part.name = nameInput.value; this._markDirty(); this._renderPartList(); });
    nameRow.append(element('span', '', 'Part name'), nameInput);
    this.inspector.append(nameRow);

    const addVector = (label, key, step = 0.1, transform = null) => {
      const row = element('div', 'modeler-vector');
      row.append(element('span', '', label));
      const values = part[key] || (key === 'scale' ? [1, 1, 1] : [0, 0, 0]);
      ['X', 'Y', 'Z'].forEach((axis, axisIndex) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = String(step);
        input.value = String(Number(((transform ? transform.out(values[axisIndex]) : values[axisIndex])).toFixed(4)));
        input.setAttribute('aria-label', `${label} ${axis}`);
        input.addEventListener('change', () => {
          const next = [...(part[key] || values)];
          const raw = Number(input.value);
          next[axisIndex] = transform ? transform.in(raw) : raw;
          part[key] = next;
          this._markDirty();
          this._applyPartTransform(this.selectedPart);
        });
        row.append(input);
      });
      this.inspector.append(row);
    };
    addVector('Position', 'position', 0.1);
    addVector('Rotation °', 'rotation', 5, { out: (radians) => radians * 180 / Math.PI, in: (degrees) => degrees * Math.PI / 180 });
    addVector('Scale (size m)', 'scale', 0.1);

    if (part.kind !== 'asset') {
      const colorRow = element('label', 'modeler-field');
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = part.color || '#9aa7b5';
      colorInput.addEventListener('input', () => { part.color = colorInput.value; this._markDirty({ history: false }); this._rebuildObject(); });
      colorInput.addEventListener('change', () => this._recordHistory());
      colorRow.append(element('span', '', 'Base colour'), colorInput);
      this.inspector.append(colorRow);
      if (['cylinder', 'cone', 'sphere'].includes(part.kind)) {
        const segmentsRow = element('label', 'modeler-field');
        const segmentsInput = document.createElement('input');
        segmentsInput.type = 'number';
        segmentsInput.min = '3';
        segmentsInput.max = '32';
        segmentsInput.value = String(part.segments || 8);
        segmentsInput.addEventListener('change', () => {
          part.segments = Math.min(32, Math.max(3, Math.round(Number(segmentsInput.value) || 8)));
          delete part.vertexOffsets; // topology changed
          this._markDirty();
          this._rebuildObject();
        });
        segmentsRow.append(element('span', '', 'Segments (low = PSX)'), segmentsInput);
        this.inspector.append(segmentsRow);
      }
      if (SUBDIVIDABLE_KINDS.includes(part.kind)) {
        const subdivisionsRow = element('label', 'modeler-field');
        const subdivisionsInput = document.createElement('input');
        subdivisionsInput.type = 'number';
        subdivisionsInput.min = '1';
        subdivisionsInput.max = '8';
        subdivisionsInput.value = String(part.subdivisions || 1);
        subdivisionsInput.title = 'Subdivide the part into more editable vertices (1 = plain primitive). Changing it resets vertex edits.';
        subdivisionsInput.addEventListener('change', () => {
          const next = Math.min(8, Math.max(1, Math.round(Number(subdivisionsInput.value) || 1)));
          if (next === (part.subdivisions || 1)) return;
          if (next === 1) delete part.subdivisions; else part.subdivisions = next;
          delete part.vertexOffsets; // topology changed
          this._markDirty();
          this._rebuildObject();
          this._renderInspector();
        });
        subdivisionsRow.append(element('span', '', 'Vertex detail'), subdivisionsInput);
        this.inspector.append(subdivisionsRow);
      }
      if (part.vertexOffsets?.length) {
        const reset = button('Reset vertex edits', 'tool-button small', 'Remove all vertex offsets of this part');
        reset.addEventListener('click', () => { delete part.vertexOffsets; this._markDirty(); this._rebuildObject(); this._renderInspector(); });
        this.inspector.append(reset);
      }
      if (part.kind === 'mesh') {
        this.inspector.append(element('p', 'modeler-help',
          `Editable mesh · ${part.vertices?.length || 0} vertices · ${part.triangles?.length || 0} triangles. In Vertices mode: right-click the surface or an edge to add a vertex, right-click a vertex handle to remove it.`));
      }
      this._renderFacePanel(part);
    } else {
      this.inspector.append(element('p', 'modeler-help', `Assembled from catalog asset ${part.assetRef}. Move, rotate, and scale it like any part.`));
    }
  }

  _renderFacePanel(part) {
    const faces = partFaceNames(part);
    if (!faces.length) return;
    this.inspector.append(element('h3', '', 'Faces & textures'));
    this.inspector.append(element('p', 'modeler-help', 'Pick a face here (or click it in Faces mode), then attach an image: top, bottom, every side — like wrapping a photo around a bin.'));
    for (const faceName of faces) {
      const style = part.faces?.[faceName] || {};
      const row = element('div', `modeler-face-row${this.selectedFace === faceName ? ' selected' : ''}`);
      const pick = element('button', 'modeler-face-pick', faceName);
      pick.type = 'button';
      pick.addEventListener('click', () => { this.selectedFace = this.selectedFace === faceName ? null : faceName; this._renderInspector(); });
      row.append(pick);
      const textureRecord = style.texture ? this.store.getTexture(style.texture) : null;
      if (textureRecord) {
        const thumb = element('img', 'modeler-face-thumb');
        thumb.src = textureRecord.dataUrl;
        thumb.alt = textureRecord.name || style.texture;
        thumb.title = textureRecord.name || style.texture;
        row.append(thumb);
      } else {
        row.append(element('small', 'modeler-face-none', style.color ? `colour ${style.color}` : 'no texture'));
      }
      const attach = button('Image…', 'tool-button small', `Attach an uploaded or new image to the ${faceName} face`);
      attach.addEventListener('click', () => this._assignTextureToFace(part, faceName));
      row.append(attach);
      if (style.texture || style.color) {
        const clear = button('Clear', 'tool-button small', 'Remove the texture/colour of this face');
        clear.addEventListener('click', () => {
          delete part.faces[faceName];
          this._markDirty();
          this._rebuildObject();
          this._renderInspector();
        });
        row.append(clear);
      }
      const allFaces = button('All faces', 'tool-button small', 'Copy this face style to every face of the part');
      allFaces.addEventListener('click', () => {
        part.faces = part.faces || {};
        for (const name of faces) part.faces[name] = clone(style);
        this._markDirty();
        this._rebuildObject();
        this._renderInspector();
      });
      row.append(allFaces);
      this.inspector.append(row);
    }
  }

  _renderTextures() {
    this.textureList.innerHTML = '';
    const textures = this.store.textures();
    if (!textures.length) {
      this.textureList.append(element('p', 'modeler-help', 'Uploaded images appear here and can be attached to faces or world surfaces.'));
      return;
    }
    for (const texture of textures) {
      const card = element('div', 'modeler-texture-card');
      const thumb = element('img');
      thumb.src = texture.dataUrl;
      thumb.alt = texture.name || texture.id;
      card.append(thumb, element('small', '', texture.name || texture.id));
      card.title = `${texture.name || texture.id} · ${texture.id}`;
      this.textureList.append(card);
    }
  }

  _renderWorldTextures() {
    this.worldTextureList.innerHTML = '';
    for (const [slot, meta] of Object.entries(WORLD_TEXTURE_SLOTS)) {
      const row = element('div', 'modeler-world-row');
      const info = element('div', 'modeler-world-info');
      info.append(element('b', '', meta.label), element('small', '', meta.description));
      row.append(info);
      const current = this.store.worldTexture(slot);
      const currentRecord = current ? this.store.getTexture(current) : null;
      if (currentRecord) {
        const thumb = element('img', 'modeler-face-thumb');
        thumb.src = currentRecord.dataUrl;
        thumb.alt = currentRecord.name || current;
        row.append(thumb);
      }
      const upload = button(currentRecord ? 'Replace…' : 'Set image…', 'tool-button small', `Upload the repeated image for ${meta.label}`);
      upload.addEventListener('click', () => this._pickImage((textureId) => {
        this.store.setWorldTexture(slot, textureId);
        this._markDirty({ history: false });
        this._renderWorldTextures();
        this.onWorldTexturesChanged();
        this.onStatus(`${meta.label} texture set · Save Object/textures to persist, the playable game updates on reload`);
      }));
      row.append(upload);
      if (currentRecord) {
        const clear = button('Clear', 'tool-button small danger', 'Back to the original generated colour');
        clear.addEventListener('click', () => {
          this.store.setWorldTexture(slot, null);
          this._markDirty({ history: false });
          this._renderWorldTextures();
          this.onWorldTexturesChanged();
        });
        row.append(clear);
      }
      this.worldTextureList.append(row);
    }
    const save = button('Save textures', 'tool-button accent', 'Persist texture overrides to disk (applies to editor and game)');
    save.addEventListener('click', () => this._saveStoreOnly());
    this.worldTextureList.append(save);
  }

  _syncModeButtons() {
    for (const [mode, node] of Object.entries(this.modeButtons)) node.setAttribute('aria-pressed', String(mode === this.mode));
    this.addVerticesButton.hidden = this.mode !== 'vertex';
    this.modeHint.textContent = {
      part: 'Click a part to select · W/E/R move/rotate/scale · G snap · Del removes · Ctrl+Z/Y undo/redo',
      face: 'Click a face of the object, then attach an image from the panel on the right',
      vertex: 'Drag a vertex via the gizmo · right-click surface/edge adds a vertex · right-click a handle removes it · G snaps',
    }[this.mode] || '';
  }

  // ---------------------------------------------------------- snap to grid --
  _setSnap(enabled) {
    this.snapEnabled = enabled;
    this.snapButton.setAttribute('aria-pressed', String(enabled));
    this._applySnap();
    this.onStatus(enabled ? `Snap to grid on · ${this.snapStep} m steps, 15° rotations` : 'Snap to grid off');
  }

  _applySnap() {
    this.gizmo.setTranslationSnap(this.snapEnabled ? this.snapStep : null);
    this.gizmo.setRotationSnap(this.snapEnabled ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(this.snapEnabled ? 0.1 : null);
  }

  // ------------------------------------------------------- car scale ref --
  _toggleCarReference() {
    this.carRefVisible = !this.carRefVisible;
    this.carRefButton.setAttribute('aria-pressed', String(this.carRefVisible));
    if (this.carRefVisible) {
      if (!this.carRef) this.carRef = this._buildCarReference();
      this.scene.add(this.carRef);
      this._positionCarReference();
      this.onStatus('Player car shown for scale · 4.25 m long, 1.7 m wide, 1.3 m tall');
    } else {
      this.carRef?.removeFromParent();
      this.onStatus('Player car reference hidden');
    }
  }

  _positionCarReference() {
    if (!this.carRef) return;
    const bounds = new THREE.Box3().setFromObject(this.assetGroup);
    const edge = bounds.isEmpty() ? 0 : Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x));
    this.carRef.position.set(-(edge + 1.9), 0, 0);
  }

  /** Same silhouette and default dimensions as the game's player car (js/game.js createCarMesh). */
  _buildCarReference() {
    const group = new THREE.Group();
    group.name = 'Player car (scale reference)';
    const L = 4.25, W = 1.7, H = 1.3;
    const body = new THREE.MeshLambertMaterial({ color: 0x8f2d38, flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: 0x0b1018, flatShading: true });
    const rubber = new THREE.MeshLambertMaterial({ color: 0x08090b, flatShading: true });
    const add = (geometry, material, x, y, z) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      group.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(W, 0.42, L), body, 0, 0.48, 0);
    add(new THREE.BoxGeometry(W * 0.93, 0.18, L * 0.3), body, 0, 0.74, L * -0.32);
    add(new THREE.BoxGeometry(W * 0.76, H * 0.45, L * 0.4), dark, 0, 1.0, L * 0.04);
    add(new THREE.BoxGeometry(W * 0.7, 0.11, L * 0.32), body, 0, 1.3, L * 0.05);
    const wheelGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.17, 8);
    for (const x of [-W * 0.52, W * 0.52]) {
      for (const z of [-L * 0.31, L * 0.31]) add(wheelGeometry, rubber, x, 0.33, z).rotation.z = Math.PI / 2;
    }
    const head = new THREE.MeshBasicMaterial({ color: 0xffe4b0 });
    const tail = new THREE.MeshBasicMaterial({ color: 0xff1833 });
    for (const x of [-W * 0.31, W * 0.31]) add(new THREE.BoxGeometry(0.28, 0.13, 0.04), head, x, 0.63, -L * 0.505);
    for (const x of [-W * 0.32, W * 0.32]) add(new THREE.BoxGeometry(0.3, 0.13, 0.04), tail, x, 0.63, L * 0.505);
    return group;
  }

  // -------------------------------------------------------- whole object --
  _scaleObject(factor) {
    if (!this.definition?.parts.length) { this.onStatus('Nothing to scale yet — add a part first'); return; }
    if (!Number.isFinite(factor) || factor <= 0) { this.onStatus('Enter a scale factor above 0'); return; }
    if (Math.abs(factor - 1) < 1e-9) return;
    for (const part of this.definition.parts) {
      part.position = (part.position || [0, 0, 0]).map((value) => value * factor);
      part.scale = (part.scale || [1, 1, 1]).map((value) => value * factor);
    }
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    this.onStatus(`Scaled the whole object ×${factor}`);
  }

  _addVertices() {
    const part = this.definition?.parts[this.selectedPart];
    if (!part) { this.onStatus('Select a part first'); return; }
    if (!SUBDIVIDABLE_KINDS.includes(part.kind)) {
      this.onStatus(part.kind === 'sphere'
        ? 'Spheres gain vertices through the Segments field in the inspector'
        : (part.kind === 'mesh'
          ? 'Right-click the surface or an edge to add a vertex exactly there'
          : `${PART_KINDS[part.kind]?.label || part.kind} parts cannot be subdivided`));
      return;
    }
    const current = Number.isInteger(part.subdivisions) ? part.subdivisions : 1;
    if (current >= 8) { this.onStatus('Maximum vertex detail reached (8×8 per face)'); return; }
    const hadOffsets = Boolean(part.vertexOffsets?.length);
    part.subdivisions = current + 1;
    delete part.vertexOffsets; // topology changed: welded indices no longer line up
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    this.onStatus(`Vertex detail ${part.subdivisions}×${part.subdivisions}${hadOffsets ? ' · previous vertex edits were reset (topology changed)' : ''}`);
  }

  // ------------------------------------------------------------- behaviour --
  _setMode(mode) {
    this.mode = mode;
    this.selectedVertex = -1;
    this._syncModeButtons();
    this._rebuildVertexHandles();
    this._attachGizmoToSelection();
  }

  _selectPart(index) {
    this.selectedPart = index;
    this.selectedFace = null;
    this.selectedVertex = -1;
    this._renderPartList();
    this._renderInspector();
    this._rebuildVertexHandles();
    this._attachGizmoToSelection();
  }

  _detachGizmo() {
    this.gizmo.detach();
    if (this.gizmoProxy) { this.gizmoProxy.removeFromParent(); this.gizmoProxy = null; }
  }

  _attachGizmoToSelection() {
    this._detachGizmo();
    if (this.mode === 'part') {
      const node = this.partNodes[this.selectedPart];
      if (node) { this.gizmo.setMode('translate'); this.gizmo.attach(node); }
      return;
    }
    if (this.mode === 'vertex' && this.selectedVertex >= 0) {
      const handle = this.vertexHandles.find((item) => item.userData.weldIndex === this.selectedVertex);
      if (handle) { this.gizmo.setMode('translate'); this.gizmo.attach(handle); }
    }
  }

  _onGizmoChange() {
    const part = this.definition?.parts[this.selectedPart];
    if (!part) return;
    if (this.mode === 'part') {
      const node = this.partNodes[this.selectedPart];
      if (!node) return;
      part.position = node.position.toArray();
      part.rotation = node.rotation.toArray().slice(0, 3);
      part.scale = node.scale.toArray();
      return;
    }
    if (this.mode === 'vertex') {
      const handle = this.gizmo.object;
      const node = this.partNodes[this.selectedPart];
      if (!handle?.userData?.basePosition || !node?.isMesh) return;
      const local = node.worldToLocal(handle.position.clone());
      const weldIndex = handle.userData.weldIndex;
      if (part.kind === 'mesh') {
        // Manual vertices: the drag writes the position itself.
        part.vertices[weldIndex] = [local.x, local.y, local.z];
        this._rebuildPartGeometry(this.selectedPart);
        return;
      }
      const base = handle.userData.basePosition;
      const offset = [local.x - base[0], local.y - base[1], local.z - base[2]];
      part.vertexOffsets = (part.vertexOffsets || []).filter((entry) => entry.i !== weldIndex);
      if (offset.some((value) => Math.abs(value) > 1e-5)) part.vertexOffsets.push({ i: weldIndex, o: offset });
      if (!part.vertexOffsets.length) delete part.vertexOffsets;
      this._rebuildPartGeometry(this.selectedPart);
    }
  }

  _onGizmoDrop() {
    if (!this.definition) return;
    this._markDirty();
    if (this.mode === 'part') this._renderInspector();
  }

  _applyPartTransform(index) {
    const part = this.definition.parts[index];
    const node = this.partNodes[index];
    if (!part || !node) { this._rebuildObject(); return; }
    node.position.fromArray(part.position || [0, 0, 0]);
    node.rotation.set(...(part.rotation || [0, 0, 0]));
    node.scale.fromArray(part.scale || [1, 1, 1]);
    this._rebuildVertexHandles();
  }

  /**
   * Shared viewport raycast for left- and right-click interactions:
   * `handleHit` is the nearest vertex handle (vertex mode only), `partHit`
   * the nearest object surface belonging to a part.
   */
  _raycast(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const handleHit = this.mode === 'vertex'
      ? this.raycaster.intersectObjects(this.vertexHandles, false)[0] || null
      : null;
    const partHit = this.raycaster.intersectObject(this.assetGroup, true)
      .find((candidate) => Number.isInteger(candidate.object.userData.partIndex)) || null;
    return { handleHit, partHit };
  }

  _pick(event) {
    if (!this.definition) return;
    const { handleHit, partHit } = this._raycast(event);
    if (handleHit) {
      this.selectedVertex = handleHit.object.userData.weldIndex;
      this._rebuildVertexHandles();
      this._attachGizmoToSelection();
      return;
    }
    if (!partHit) return;
    const partIndex = partHit.object.userData.partIndex;
    if (this.mode === 'face') {
      if (partIndex !== this.selectedPart) this._selectPart(partIndex);
      const part = this.definition.parts[partIndex];
      const faces = partFaceNames(part);
      const materialIndex = partHit.face?.materialIndex ?? 0;
      this.selectedFace = faces[materialIndex] || faces[0] || null;
      this._renderInspector();
      return;
    }
    if (partIndex !== this.selectedPart) this._selectPart(partIndex);
  }

  // ------------------------------------------- right-click vertex editing --
  /**
   * Vertex-mode right click: a vertex handle removes that vertex; an empty
   * spot on a part surface or edge adds one there. The part converts from a
   * primitive into a kind:'mesh' part on the first topology edit.
   */
  _rightClick(event) {
    if (!this.definition) return;
    if (this.mode !== 'vertex') {
      this.onStatus('Right-click manages vertices in Vertices mode — switch modes first');
      return;
    }
    const { handleHit, partHit } = this._raycast(event);
    if (handleHit) {
      this._removeVertexAt(handleHit.object.userData.weldIndex);
      return;
    }
    if (!partHit) {
      this.onStatus('Right-click a surface or edge to add a vertex · right-click a vertex handle to remove it');
      return;
    }
    this._addVertexAtHit(partHit);
  }

  /** Converts the part at `index` into an editable mesh in place (idempotent). */
  _ensureMeshPart(index) {
    const part = this.definition?.parts[index];
    if (!part || part.kind === 'asset') return null;
    if (part.kind === 'mesh') return part;
    const converted = convertPartToMesh(part);
    if (converted) this.definition.parts[index] = converted;
    return converted;
  }

  _addVertexAtHit(partHit) {
    const partIndex = partHit.object.userData.partIndex;
    if (partIndex !== this.selectedPart) this._selectPart(partIndex);
    const part = this._ensureMeshPart(partIndex);
    if (!part) {
      this.onStatus('Assembled asset parts have no editable vertices');
      return;
    }
    const node = this.partNodes[partIndex];
    if (!node) return;
    const local = node.worldToLocal(partHit.point.clone());
    const added = meshInsertVertexAtPoint(part, [local.x, local.y, local.z]);
    if (!added) {
      this.onStatus('Could not add a vertex there (mesh vertex limit reached?)');
      return;
    }
    this.selectedVertex = added.vertexIndex;
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    this.onStatus(added.split === 'edge'
      ? 'Vertex added on the edge · drag the gizmo to move it · right-click it to remove'
      : 'Vertex added · drag the gizmo to move it · right-click it to remove');
  }

  _removeVertexAt(weldIndex) {
    const part = this._ensureMeshPart(this.selectedPart);
    if (!part) {
      this.onStatus('Assembled asset parts have no editable vertices');
      return;
    }
    if (!meshRemoveVertex(part, weldIndex)) {
      this.onStatus('Cannot remove this vertex — a mesh keeps at least 3 vertices and one face');
      return;
    }
    this.selectedVertex = -1;
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    this.onStatus('Vertex removed · faces using it were dropped');
  }

  _addPart(kind) {
    if (!this.definition) this._loadDefinition(null);
    const part = {
      kind,
      name: PART_KINDS[kind].label,
      position: [0, kind === 'plane' ? 0.5 : 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: '#9aa7b5',
      faces: {},
    };
    this.definition.parts.push(part);
    this._rebuildObject();
    this._selectPart(this.definition.parts.length - 1);
    this._markDirty();
    this._renderPartList();
  }

  _addCatalogPart() {
    const assetRef = this.catalogSelect.value;
    if (!assetRef || !this.definition) return;
    const asset = this.assetRegistry.get(assetRef);
    if (!asset) return;
    const part = {
      kind: 'asset',
      name: asset.label || assetRef,
      assetRef,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    if (asset.kind !== 'custom') part.components = bakeAssetPartComponents(this.assetRegistry, assetRef);
    this.definition.parts.push(part);
    this._rebuildObject();
    this._selectPart(this.definition.parts.length - 1);
    this._markDirty();
    this._renderPartList();
    this.onStatus(`Added ${asset.label || assetRef} as an assembled part`);
  }

  _deleteSelectedPart() {
    if (!this.definition || this.selectedPart < 0) return;
    this.definition.parts.splice(this.selectedPart, 1);
    this.selectedPart = Math.min(this.selectedPart, this.definition.parts.length - 1);
    this._markDirty();
    this._renderAll();
  }

  _assignTextureToFace(part, faceName) {
    const textures = this.store.textures();
    const useTexture = (textureId) => {
      part.faces = part.faces || {};
      part.faces[faceName] = { ...(part.faces[faceName] || {}), texture: textureId };
      this.selectedFace = faceName;
      this._markDirty();
      this._rebuildObject();
      this._renderInspector();
      this._renderTextures();
    };
    if (!textures.length) { this._pickImage(useTexture); return; }
    // Tiny chooser: reuse an uploaded image or add a new one.
    const chooser = element('div', 'modeler-chooser');
    chooser.append(element('b', '', `Texture for face "${faceName}"`));
    const grid = element('div', 'modeler-chooser-grid');
    for (const texture of textures) {
      const pick = element('button', 'modeler-chooser-item');
      pick.type = 'button';
      const img = element('img');
      img.src = texture.dataUrl;
      img.alt = texture.name || texture.id;
      pick.append(img, element('small', '', texture.name || texture.id));
      pick.addEventListener('click', () => { chooser.remove(); useTexture(texture.id); });
      grid.append(pick);
    }
    chooser.append(grid);
    const actions = element('div', 'modeler-chooser-actions');
    const upload = button('Upload new image…', 'tool-button');
    upload.addEventListener('click', () => { chooser.remove(); this._pickImage(useTexture); });
    const cancel = button('Cancel', 'tool-button');
    cancel.addEventListener('click', () => chooser.remove());
    actions.append(upload, cancel);
    chooser.append(actions);
    this.overlay.append(chooser);
  }

  _pickImage(onReady) {
    this.fileInput.onchange = async () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (!file) return;
      try {
        const textureId = await this.store.addTextureFile(file);
        this._renderTextures();
        onReady(textureId);
      } catch (error) {
        this.onStatus(`Texture upload failed · ${error.message}`);
      }
    };
    this.fileInput.click();
  }

  async _save(asCopy) {
    if (!this.definition) return;
    if (!this.definition.parts.length) { this.onStatus('Add at least one part before saving'); return; }
    if (asCopy) this.definition.id = this.store.newAssetId();
    this.definition.label = this.nameInput.value.trim() || this.definition.label || 'Custom object';
    try {
      const saved = this.store.upsertAsset(this.definition);
      await this.store.save();
      refreshCustomAsset(this.assetRegistry, this.store.document, saved.id);
      this.definition = clone(saved);
      this.editingExisting = true;
      if (asCopy) this._resetHistory(); // old entries carry the previous asset id
      this.onAssetsChanged();
      this._renderAssetList();
      this.dirtyChip.textContent = '';
      this.onStatus(`Saved "${saved.label}" · it is now in the Assets menu, ready to place in the world`);
    } catch (error) {
      this.onStatus(`Save failed · ${error.message}`);
    }
  }

  async _saveStoreOnly() {
    try {
      await this.store.save();
      this.dirtyChip.textContent = '';
      this.onStatus('Saved textures and objects to disk');
    } catch (error) {
      this.onStatus(`Save failed · ${error.message}`);
    }
  }

  async _deleteAsset() {
    if (!this.definition || !this.editingExisting) { this.onStatus('This object is not saved yet'); return; }
    const id = this.definition.id;
    if (this.isAssetInUse(id)) { this.onStatus('This object is placed in the map — delete those placed objects first'); return; }
    if (!window.confirm(`Delete "${this.definition.label}" permanently?`)) return;
    try {
      this.store.deleteAsset(id);
      await this.store.save();
      this.assetRegistry.removeCustomAsset(id);
      this.onAssetsChanged();
      this._loadDefinition(null);
      this.onStatus(`Deleted custom object ${id}`);
    } catch (error) {
      this.onStatus(`Delete failed · ${error.message}`);
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('keydown', this._onKeyDown);
    this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.renderer.domElement.removeEventListener('contextmenu', this._onContextMenu);
    this.resizeObserver.disconnect();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
    this.overlay.remove();
  }
}
