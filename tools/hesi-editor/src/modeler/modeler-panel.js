import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  MESH_MAX_FACES, PART_KINDS, WORLD_OBJECTS, WORLD_OBJECT_GROUPS, WORLD_SURFACES,
  isDefaultWorldSurfaceStyle, worldObjectModelKey, worldObjectSurfaces, worldObjectsUsingSurface,
  applyPartFaceProjections, applyVertexOffsets,
  buildPartObject, captureUnionFaceProjection, captureViewFaceProjection, clonePartFaceToOpposite,
  convertPartToMesh, mergePartFaces, meshFacePlanarRegions, meshInsertVertexAtPoint,
  meshRemoveVertex, meshTopologyIssues, oppositePartFace, partFaceCoverProjection, partFaceNames,
  buildCustomAssetGroup, partGeometry, splitPartFaceByPlanarRegions, textureSourceUrl, translatePartFace,
  weldedVertices,
} from '/js/custom-assets.js';
import { assetPartResolver, bakeAssetPartComponents, refreshCustomAsset } from '../world/custom-asset-integration.js';
import { SurfaceStyleEditor } from '../world/surface-style-editor.js';
import { buildWorldObjectPreview, previewFocusBounds, worldObjectModelParts } from '../world/surface-preview-geometry.js';

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
  constructor({ host, store, assetRegistry, onStatus = () => {}, onAssetsChanged = () => {}, onTexturesChanged = () => {}, onWorldTexturesChanged = () => {}, isAssetInUse = () => false, onOpenChange = () => {}, getMaterials = () => null, onOpenSurfaces = null, onWorldModelsChanged = () => {}, getMap = () => null }) {
    Object.assign(this, { store, assetRegistry, onStatus, onAssetsChanged, onTexturesChanged, onWorldTexturesChanged, isAssetInUse, onOpenChange, getMaterials, onOpenSurfaces, onWorldModelsChanged, getMap });
    this.openState = false;
    this.library = 'custom';
    this.worldObject = null;
    this.worldSlot = null;
    // Set while a world archetype is being modelled, so Save Object can put the
    // finished model straight back onto every copy in the map.
    this.modelTargetObject = null;
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
    this.outlinesEnabled = false;
    this.carRef = null;
    this.carRefVisible = false;
    this.history = [];
    this.historyIndex = -1;
    this._rightDownAt = null;
    this._faceDrag = null;
    this.textureEditor = null;

    this._buildDom(host);
    this._buildScene();
    this._bindEvents();
    this._syncLibraryChrome();
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
    this.worldSaveButton = button('Save world paint', 'tool-button accent', 'Write the world surface overrides to disk — the editor and the playable game both pick them up');
    this.worldSaveButton.dataset.testid = 'modeler-save-world-paint';
    this.worldSaveButton.hidden = true;
    this.dirtyChip = element('span', 'modeler-dirty', '');
    header.append(this.nameInput, this.layerSelect, this.saveButton, this.saveCopyButton, this.deleteButton, this.worldSaveButton, this.dirtyChip, element('span', 'toolbar-spacer'), this.closeButton);

    const body = element('div', 'modeler-body');

    // Left: object library + part list + add-part tools
    const left = element('aside', 'modeler-panel modeler-left');
    this.leftPanel = left;
    // Two libraries share this list: the objects you modelled, and the
    // archetypes the map generator already placed everywhere (buildings,
    // lamps, containers). The second kind is repainted per material, which
    // updates every copy in the world at once.
    this.librarySwitch = element('div', 'segmented modeler-library-switch');
    this.librarySwitch.setAttribute('role', 'radiogroup');
    this.librarySwitch.setAttribute('aria-label', 'Object library');
    this.libraryButtons = {};
    for (const [key, label, title] of [
      ['custom', 'Your objects', 'Objects you modelled and saved into the catalog'],
      ['world', 'World objects', 'Objects the map generator repeats everywhere — buildings, lamps, pillars, containers, signs. Repaint one, they all change.'],
    ]) {
      const node = element('button', 'seg-button', label);
      node.type = 'button';
      node.setAttribute('role', 'radio');
      node.title = title;
      node.dataset.testid = `modeler-library-${key}`;
      this.libraryButtons[key] = node;
      this.librarySwitch.append(node);
    }
    left.append(this.librarySwitch);
    this.newObjectButton = button('+ New Object', 'tool-button primary', 'Start a fresh object');
    left.append(this.newObjectButton);
    this.assetList = element('div', 'modeler-asset-list');
    this.assetList.dataset.testid = 'modeler-asset-list';
    left.append(this.assetList);
    this.worldObjectList = element('div', 'modeler-asset-list modeler-world-list');
    this.worldObjectList.dataset.testid = 'modeler-world-object-list';
    this.worldObjectList.hidden = true;
    left.append(this.worldObjectList);
    this.partsHeading = element('h3', '', 'Parts');
    left.append(this.partsHeading);
    this.partList = element('div', 'modeler-part-list');
    left.append(this.partList);
    const addRow = element('div', 'modeler-add-parts');
    this.addPartsRow = addRow;
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
    this.catalogRow = catalogRow;
    catalogRow.append(element('small', '', 'Add existing asset as part (assembly)'));
    this.catalogSelect = document.createElement('select');
    this.catalogSelect.setAttribute('aria-label', 'Catalog asset to add');
    this.addCatalogButton = button('Add', 'tool-button small');
    catalogRow.append(this.catalogSelect, this.addCatalogButton);
    left.append(catalogRow);
    const scaleRow = element('div', 'modeler-object-scale');
    this.scaleRow = scaleRow;
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
    this.modeBar = modeBar;
    this.modeButtons = {};
    for (const [mode, label, title] of [
      ['part', 'Parts', 'Select and transform whole parts (move W · rotate E · scale R)'],
      ['face', 'Faces', 'Click a face: pull the whole face with the gizmo, or attach an image texture to it'],
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
    this.outlineButton = button('▦ Outlines', 'tool-button small', 'Show the wireframe outlines of the object being edited (O) — the selected part shows its full triangle wireframe, even through the surface');
    this.outlineButton.setAttribute('aria-pressed', 'false');
    this.modeHint = element('span', 'modeler-mode-hint', '');
    modeBar.append(
      this.addVerticesButton,
      element('span', 'modeler-modebar-sep'),
      this.undoButton, this.redoButton,
      element('span', 'modeler-modebar-sep'),
      this.snapButton, this.snapStepSelect, this.carRefButton, this.outlineButton,
      this.modeHint,
    );
    this.viewportHost = element('div', 'modeler-viewport');
    this.viewportHost.dataset.testid = 'modeler-viewport';
    center.append(modeBar, this.viewportHost);

    // Right: inspector for part / face / textures — or, in world-object mode,
    // the surface paint controls of the selected archetype.
    const right = element('aside', 'modeler-panel modeler-right');
    this.rightPanel = right;
    this.inspector = element('div', 'modeler-inspector');
    right.append(this.inspector);
    this.worldTextureSection = element('section', 'modeler-world-section');
    this.worldTextureSection.dataset.testid = 'world-texture-section';
    this.worldTextureSection.hidden = true;
    // Object header + its surface list + the paint controls of the selected
    // surface — the world-object counterpart of part list + face panel.
    this.worldObjectHeader = element('div', 'modeler-world-object-header');
    this.worldSurfaceList = element('div', 'modeler-world-surface-list');
    this.worldSurfaceList.dataset.testid = 'modeler-world-surface-list';
    this.worldStyleHost = element('div', 'modeler-world-style');
    this.worldTextureSection.append(this.worldObjectHeader, this.worldSurfaceList, this.worldStyleHost);
    right.append(this.worldTextureSection);
    this.textureLibraryHeading = element('h3', '', 'Texture library');
    right.append(this.textureLibraryHeading);
    this.textureList = element('div', 'modeler-texture-list');
    right.append(this.textureList);
    this.uploadTextureButton = button('Upload image…', 'tool-button', 'Add an image to the texture library');
    right.append(this.uploadTextureButton);

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
    // World-object mode swaps the modelled object for a live-material preview
    // of the selected archetype; both never show at once.
    this.worldPreviewGroup = new THREE.Group();
    this.worldPreviewGroup.name = 'World archetype preview';
    this.scene.add(this.worldPreviewGroup);

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
    for (const [key, node] of Object.entries(this.libraryButtons)) node.addEventListener('click', () => this._setLibrary(key));
    this.worldSaveButton.addEventListener('click', () => this._saveStoreOnly());
    this.worldStyleEditor = new SurfaceStyleEditor({
      host: this.worldStyleHost,
      store: this.store,
      getMaterial: (slot) => this.getMaterials()?.[slot] || null,
      onStatus: (message) => this.onStatus(message),
      pickTexture: (title, useTexture) => this._chooseTexture(title, useTexture),
      onEditImage: (textureId) => this._openTextureEditor(textureId),
      onChange: () => {
        this.dirtyChip.textContent = 'Unsaved changes';
        this.onWorldTexturesChanged();
        this._renderWorldObjectList();
        this._renderWorldSurfaceRows();
      },
    });
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
    this.outlineButton.addEventListener('click', () => this._setOutlines(!this.outlinesEnabled));
    this.scaleHalfButton.addEventListener('click', () => this._scaleObject(0.5));
    this.scaleDoubleButton.addEventListener('click', () => this._scaleObject(2));
    this.scaleApplyButton.addEventListener('click', () => this._scaleObject(Number(this.scaleFactorInput.value)));
    this.uploadTextureButton.addEventListener('click', () => this._pickImage((textureId) => {
      this._markDirty({ history: false });
      this._renderTextures();
      this.onTexturesChanged();
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
      if (this.library === 'world') { this._pickWorldSurface(event); return; }
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
      if (this.library === 'world') return;
      this._rightClick(event);
    };
    this.renderer.domElement.addEventListener('contextmenu', this._onContextMenu);

    this._onKeyDown = (event) => {
      if (!this.openState || this.library === 'world') return;
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
      if (event.code === 'KeyO') { event.preventDefault(); this._setOutlines(!this.outlinesEnabled); return; }
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

  /** Opens directly at the generated-map texture controls. */
  openWorldTextures(slot = undefined) {
    this.open();
    this._setLibrary('world');
    if (slot) this._selectWorldSlot(slot);
  }

  close() {
    this.openState = false;
    this.overlay.hidden = true;
    cancelAnimationFrame(this.frameId);
    this._detachGizmo();
    this.onOpenChange(false);
  }

  _loadDefinition(assetId) {
    this.modelTargetObject = null;
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
    if (this.library === 'world') {
      // The world library owns the viewport and the right panel; leave the
      // modelled object untouched underneath so switching back is instant.
      this._renderWorldObjectList();
      this._renderWorldObjectPanel();
      this.dirtyChip.textContent = this.store.dirty ? 'Unsaved changes' : '';
      return;
    }
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
    this._auditTopology();
  }

  /**
   * Watchdog: after every edit, verify each mesh part still holds its
   * structural invariants. The first violation is reported in the status bar
   * and the broken state (plus the previous history entry, i.e. the state the
   * offending operation started from) is dumped to the dev server so the bug
   * can be reproduced from real data instead of the visual aftermath.
   */
  _auditTopology() {
    if (!this.definition) return;
    const issues = [];
    this.definition.parts.forEach((part, index) => {
      for (const issue of meshTopologyIssues(part)) issues.push(`part ${index} (${part.name || part.kind}): ${issue}`);
    });
    const signature = issues.join('\n');
    if (signature === this._lastTopologyReport) return;
    this._lastTopologyReport = signature;
    if (!issues.length) return;
    console.error('[modeler] mesh topology broken:', issues);
    this.onStatus(`⚠ MESH TOPOLOGY BROKEN (${issues.length} issue${issues.length === 1 ? '' : 's'}) — diagnostic saved, Ctrl+Z to undo`);
    const previous = this.history[this.historyIndex - 1]?.definition ?? null;
    fetch('/__hesi_editor_diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        when: new Date().toISOString(),
        issues,
        definition: this.definition,
        previous,
      }),
    }).catch(() => {});
  }

  // ---------------------------------------------------------- undo / redo --
  _snapshot() {
    return { definition: clone(this.definition), selectedPart: this.selectedPart };
  }

  _resetHistory() {
    this.history = this.definition ? [this._snapshot()] : [];
    this.historyIndex = this.history.length - 1;
    // A freshly opened asset may already carry broken topology (saved while a
    // bug was live): report it immediately, not at the first edit.
    this._lastTopologyReport = undefined;
    this._auditTopology();
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
      // Documents saved before fixed cover projections existed are upgraded in
      // memory before the first possible vertex drag.
      for (const faceName of partFaceNames(part)) {
        const style = part.faces?.[faceName];
        if (style?.fit !== 'cover' || style.projection) continue;
        const projection = partFaceCoverProjection(part, faceName);
        if (projection) part.faces[faceName] = { ...style, projection };
      }
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
    this._refreshOutlines();
  }

  _rebuildPartGeometry(index) {
    const part = this.definition.parts[index];
    const node = this.partNodes[index];
    if (!part || !node?.isMesh || part.kind === 'asset') return;
    const geometry = partGeometry(part);
    if (!geometry) return;
    applyVertexOffsets(geometry, part.vertexOffsets);
    applyPartFaceProjections(geometry, part);
    node.geometry.dispose();
    node.geometry = geometry;
    this._refreshOutlines(); // edge lines track the reshaped geometry live
  }

  // -------------------------------------------------------------- outlines --
  _setOutlines(enabled) {
    this.outlinesEnabled = enabled;
    this.outlineButton.setAttribute('aria-pressed', String(enabled));
    this._refreshOutlines();
    this.onStatus(enabled
      ? 'Outlines on · every part shows its edges, the selected part its full wireframe (O toggles)'
      : 'Outlines off');
  }

  _clearOutlines() {
    const stale = [];
    this.assetGroup.traverse((child) => { if (child.userData.modelerOutline) stale.push(child); });
    for (const outline of stale) {
      outline.removeFromParent();
      outline.geometry.dispose();
      outline.material.dispose();
    }
  }

  /**
   * Wireframe outlines of the object being edited: every part gets its edge
   * silhouette, and the selected part its full triangle wireframe drawn on
   * top of everything, so face pulls and vertex edits stay readable. Lines
   * are children of their meshes (they follow every transform) and never
   * intercept viewport picking.
   */
  _refreshOutlines() {
    this._clearOutlines();
    if (!this.outlinesEnabled) return;
    this.partNodes.forEach((node, index) => {
      if (!node) return;
      const selected = index === this.selectedPart;
      const meshes = [];
      node.traverse((child) => { if (child.isMesh) meshes.push(child); });
      for (const mesh of meshes) {
        const outline = new THREE.LineSegments(
          selected ? new THREE.WireframeGeometry(mesh.geometry) : new THREE.EdgesGeometry(mesh.geometry, 1),
          new THREE.LineBasicMaterial({
            color: selected ? 0xffb020 : 0x57e3ff,
            transparent: true,
            opacity: selected ? 0.9 : 0.4,
            depthTest: !selected,
          }),
        );
        outline.userData.modelerOutline = true;
        outline.raycast = () => {};
        if (selected) outline.renderOrder = 8;
        mesh.add(outline);
      }
    });
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
          `Editable mesh · ${part.vertices?.length || 0} vertices · ${part.triangles?.length || 0} triangles. In Vertices mode: right-click the surface or an edge to add an opposing vertex pair, right-click a vertex handle to remove it.`));
      }
      this._renderFacePanel(part);
    } else {
      this.inspector.append(element('p', 'modeler-help', `Assembled from catalog asset ${part.assetRef}. Move, rotate, and scale it like any part.`));
    }
  }

  _renderFacePanel(part) {
    const faces = partFaceNames(part);
    if (!faces.length) return;
    if (!this.checkedFaces) this.checkedFaces = new Set();
    for (const name of [...this.checkedFaces]) {
      if (!faces.includes(name)) this.checkedFaces.delete(name);
    }
    this.inspector.append(element('h3', '', 'Faces & textures'));
    this.inspector.append(element('p', 'modeler-help', 'Pick a face here (or click it in Faces mode), then attach an image: top, bottom, every side — like wrapping a photo around a bin. Tick several faces to spread one image across them, or merge them into one surface. For a photo taken from a real viewpoint (a car front, a shop sign), orbit until you look at the faces the same way and use 📷: the image lands exactly as you see it. Faces you folded with vertex edits show a "flat surfaces" tag: ✂ Split lists each surface here on its own.'));
    // Vertex edits fold a face into several flat surfaces without creating
    // new entries here; count those surfaces so they become visible (and
    // splittable into real faces) instead of hiding inside the parent face.
    const regionProbe = part.kind === 'mesh' ? part : convertPartToMesh(part);
    for (const faceName of faces) {
      const regionCount = regionProbe ? (meshFacePlanarRegions(regionProbe, faceName)?.length || 0) : 0;
      const style = part.faces?.[faceName] || {};
      const row = element('div', `modeler-face-row${this.selectedFace === faceName ? ' selected' : ''}`);
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'modeler-face-check';
      check.checked = this.checkedFaces.has(faceName);
      check.title = 'Tick faces to texture together (one image spread across all of them)';
      check.setAttribute('aria-label', `Select face ${faceName} for group texturing`);
      check.addEventListener('change', () => {
        if (check.checked) this.checkedFaces.add(faceName); else this.checkedFaces.delete(faceName);
        this._renderInspector();
      });
      row.append(check);
      const pick = element('button', 'modeler-face-pick', faceName);
      pick.type = 'button';
      pick.addEventListener('click', () => {
        this.selectedFace = this.selectedFace === faceName ? null : faceName;
        this._renderInspector();
        if (this.mode === 'face') this._attachGizmoToSelection();
      });
      row.append(pick);
      if (regionCount > 1) {
        const tag = element('small', 'modeler-face-regions', `${regionCount} flat surfaces`);
        tag.title = 'Your vertex edits folded this face over several flat surfaces — ✂ Split turns each one into its own face in this list';
        row.append(tag);
      }
      const textureRecord = style.texture ? this.store.getTexture(style.texture) : null;
      if (textureRecord) {
        const thumb = element('img', 'modeler-face-thumb');
        thumb.src = textureSourceUrl(textureRecord);
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
        for (const name of faces) {
          const copiedStyle = clone(style);
          delete copiedStyle.projection;
          if (copiedStyle.fit === 'cover') {
            const projection = partFaceCoverProjection(part, name);
            if (projection) copiedStyle.projection = projection;
          }
          part.faces[name] = copiedStyle;
        }
        this._markDirty();
        this._rebuildObject();
        this._renderInspector();
      });
      row.append(allFaces);
      if (regionCount > 1 && faces.length + regionCount - 1 <= MESH_MAX_FACES) {
        const split = button('✂ Split', 'tool-button small accent', `Split this face into its ${regionCount} flat surfaces — each becomes its own face in this list, ready to tick and texture`);
        split.addEventListener('click', () => this._splitFace(faceName));
        row.append(split);
      }
      const oppositeName = oppositePartFace(part, faceName);
      if (oppositeName) {
        const cloneOpposite = button('⇄ Opposite', 'tool-button small', `Clone this face onto the "${oppositeName}" face — texture, colour, and every pulled/added vertex, mirrored across`);
        cloneOpposite.addEventListener('click', () => {
          if (!clonePartFaceToOpposite(part, faceName)) {
            this.onStatus(`Could not clone "${faceName}" onto "${oppositeName}" — the two faces no longer line up`);
            return;
          }
          this.selectedFace = faceName;
          this._markDirty();
          this._rebuildObject();
          this._renderInspector();
          this.onStatus(`Cloned "${faceName}" onto "${oppositeName}" · shape and texture mirrored · Ctrl+Z undoes`);
        });
        row.append(cloneOpposite);
      }
      this.inspector.append(row);
      if (textureRecord) {
        const options = element('div', 'modeler-face-options');
        const fitLabel = element('label');
        fitLabel.append(element('span', '', 'Image fit'));
        const fit = document.createElement('select');
        fit.setAttribute('aria-label', `${faceName} image fit`);
        fit.add(new Option('Stretch', 'stretch'));
        fit.add(new Option('Fit & crop', 'cover'));
        fit.value = style.fit === 'cover' ? 'cover' : 'stretch';
        fit.addEventListener('change', () => {
          const nextStyle = { ...style, fit: fit.value };
          delete nextStyle.projection;
          if (fit.value === 'cover') {
            const projection = partFaceCoverProjection(part, faceName);
            if (projection) nextStyle.projection = projection;
          }
          part.faces[faceName] = nextStyle;
          this._markDirty();
          this._rebuildObject();
          this._renderInspector();
        });
        fitLabel.append(fit);
        const flipX = button('Flip H', `tool-button small${style.flipX ? ' active' : ''}`, 'Flip this face texture horizontally');
        flipX.setAttribute('aria-pressed', String(Boolean(style.flipX)));
        flipX.addEventListener('click', () => {
          part.faces[faceName] = { ...style, flipX: !style.flipX };
          this._markDirty();
          this._rebuildObject();
          this._renderInspector();
        });
        const flipY = button('Flip V', `tool-button small${style.flipY ? ' active' : ''}`, 'Flip this face texture vertically');
        flipY.setAttribute('aria-pressed', String(Boolean(style.flipY)));
        flipY.addEventListener('click', () => {
          part.faces[faceName] = { ...style, flipY: !style.flipY };
          this._markDirty();
          this._rebuildObject();
          this._renderInspector();
        });
        const fromView = button('📷 From view', 'tool-button small', 'Re-project this image from the current camera angle — orbit until you look at the face the way the picture was taken, then click: the image lands exactly as you see it, like a decal');
        fromView.addEventListener('click', () => this._projectFacesFromView(part, [faceName]));
        options.append(fitLabel, flipX, flipY, fromView);
        this.inspector.append(options);
      }
    }
    if (this.checkedFaces.size >= 2) {
      const group = element('div', 'modeler-face-group');
      const names = faces.filter((name) => this.checkedFaces.has(name));
      const apply = button(`Image across ${names.length} faces…`, 'tool-button accent small',
        'Attach one image spread continuously over every ticked face — the picture spans them as a single sheet');
      apply.addEventListener('click', () => this._assignTextureAcrossFaces(part, names));
      const applyView = button('📷 Image from this view…', 'tool-button accent small',
        'Attach one image projected from the current camera angle: orbit until you see the faces the way the picture was taken, and from here the result matches the picture exactly');
      applyView.addEventListener('click', () => this._assignTextureFromView(part, names));
      const merge = button('⧉ Merge into one', 'tool-button small',
        'Concatenate the ticked faces into a single face — one entry in this list, one surface, so a single image covers all of it');
      merge.addEventListener('click', () => this._mergeCheckedFaces(names));
      const clear = button('Untick all', 'tool-button small', 'Clear the face selection');
      clear.addEventListener('click', () => { this.checkedFaces.clear(); this._renderInspector(); });
      group.append(apply, applyView, merge, clear);
      this.inspector.append(group);
    }
  }

  /**
   * ✂ Split: every flat surface of a folded face becomes its own named face
   * in the panel. Primitives convert to an editable mesh first, so surfaces
   * carved by vertex drags on a subdivided box are reachable too.
   */
  _splitFace(faceName) {
    const part = this._ensureMeshPart(this.selectedPart);
    if (!part) { this.onStatus('Assembled asset parts have no editable faces'); return; }
    const result = splitPartFaceByPlanarRegions(part, faceName);
    if (!result.ok) { this.onStatus(`Cannot split "${faceName}" · ${result.reason}`); return; }
    this.selectedFace = faceName;
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    this.onStatus(`Split "${faceName}" into ${result.faces.length} flat faces: ${result.faces.join(', ')} · tick them to texture together · Ctrl+Z undoes`);
  }

  /**
   * Concatenates the ticked faces into one surface. The merged face stores a
   * union-fitted cover projection, so pressing Image… on it spreads a single
   * picture continuously over the whole combined area.
   */
  _mergeCheckedFaces(faceNames) {
    const part = this._ensureMeshPart(this.selectedPart);
    if (!part) { this.onStatus('Assembled asset parts have no editable faces'); return; }
    const result = mergePartFaces(part, faceNames);
    if (!result.ok) { this.onStatus(`Cannot merge · ${result.reason}`); return; }
    this.checkedFaces.clear();
    this.selectedFace = result.faceName;
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    this.onStatus(`Merged ${result.mergedCount} faces into "${result.faceName}" · press Image… on it to spread one picture over the whole surface · Ctrl+Z undoes`);
  }

  /**
   * View-decal projection over the given faces of the selected part, taken
   * from the modeler camera's current orientation. Null when the faces are
   * edge-on or the part cannot be projected.
   */
  _viewProjectionFor(faceNames) {
    const part = this.definition?.parts[this.selectedPart];
    const node = this.partNodes[this.selectedPart];
    if (!part || !node) return null;
    this.camera.updateMatrixWorld();
    const camera = this.camera.matrixWorld.elements;
    node.updateWorldMatrix(true, false);
    return captureViewFaceProjection(part, faceNames, {
      right: [camera[0], camera[1], camera[2]],
      up: [camera[4], camera[5], camera[6]],
      matrixWorld: [...node.matrixWorld.elements],
    });
  }

  /** 📷 Re-projects the faces' current styles from the camera's viewpoint. */
  _projectFacesFromView(part, faceNames) {
    const projection = this._viewProjectionFor(faceNames);
    if (!projection) { this.onStatus('Could not project from this view — orbit so the faces are in front of the camera and try again'); return; }
    part.faces = part.faces || {};
    for (const name of faceNames) {
      part.faces[name] = { ...(part.faces[name] || {}), fit: 'cover', projection: clone(projection) };
    }
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    this.onStatus(`Projected the image from this view onto ${faceNames.join(', ')} · orbit to check the sides · Ctrl+Z undoes`);
  }

  /** 📷 One image attached to every ticked face, projected from the camera. */
  _assignTextureFromView(part, faceNames) {
    this._chooseTexture(`Image from this view across ${faceNames.length} face${faceNames.length === 1 ? '' : 's'}`, (textureId) => {
      const projection = this._viewProjectionFor(faceNames);
      if (!projection) { this.onStatus('Could not project from this view — orbit so the faces are in front of the camera and try again'); return; }
      part.faces = part.faces || {};
      for (const name of faceNames) {
        part.faces[name] = { ...(part.faces[name] || {}), texture: textureId, fit: 'cover', projection: clone(projection) };
      }
      this._markDirty();
      this._rebuildObject();
      this._renderInspector();
      this._renderTextures();
      this.onTexturesChanged();
      this.onStatus(`Image projected from this view across ${faceNames.join(', ')} — seen from here it matches the picture exactly`);
    });
  }

  /**
   * One image spread over several faces as a single sheet: every face gets the
   * same texture with the same union-fitted projection plane, so the picture
   * continues seamlessly across the shared edges.
   */
  _assignTextureAcrossFaces(part, faceNames) {
    this._chooseTexture(`Texture across ${faceNames.length} faces`, (textureId) => {
      const projection = captureUnionFaceProjection(part, faceNames);
      if (!projection) { this.onStatus('Could not fit one image plane across those faces'); return; }
      part.faces = part.faces || {};
      for (const name of faceNames) {
        part.faces[name] = { ...(part.faces[name] || {}), texture: textureId, fit: 'cover', projection: clone(projection) };
      }
      this._markDirty();
      this._rebuildObject();
      this._renderInspector();
      this._renderTextures();
      this.onTexturesChanged();
      this.onStatus(`Image spread across ${faceNames.join(', ')} · one sheet, shared edges line up`);
    });
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
      thumb.src = textureSourceUrl(texture);
      thumb.alt = texture.name || texture.id;
      card.append(thumb, element('small', '', texture.name || texture.id));
      card.title = `${texture.name || texture.id} · ${texture.id}`;
      const actions = element('div', 'modeler-texture-actions');
      const edit = button('✎ Edit', 'tool-button small', 'Edit this image: crop it, or erase pixels to transparency');
      edit.addEventListener('click', () => this._openTextureEditor(texture.id));
      const remove = button('✕', 'tool-button small danger', 'Delete this image from the texture library');
      remove.addEventListener('click', () => this._deleteTexture(texture.id));
      actions.append(edit, remove);
      card.append(actions);
      this.textureList.append(card);
    }
  }

  _deleteTexture(textureId) {
    const record = this.store.getTexture(textureId);
    if (!record) return;
    let usage = 0;
    for (const asset of this.store.assets()) {
      for (const part of asset.parts || []) {
        for (const style of Object.values(part.faces || {})) if (style.texture === textureId) usage += 1;
      }
    }
    for (const slot of Object.keys(WORLD_SURFACES)) if (this.store.worldTexture(slot) === textureId) usage += 1;
    const name = record.name || textureId;
    const message = usage
      ? `Delete texture "${name}"? It is used on ${usage} face/world surface${usage === 1 ? '' : 's'} — they go back to their plain colour.`
      : `Delete texture "${name}" from the library?`;
    if (!window.confirm(message)) return;
    this.store.deleteTexture(textureId);
    // The open (possibly unsaved) definition is a clone — strip it too.
    let touchedDefinition = false;
    for (const part of this.definition?.parts || []) {
      for (const style of Object.values(part.faces || {})) {
        if (style.texture === textureId) { delete style.texture; touchedDefinition = true; }
      }
    }
    this._markDirty({ history: touchedDefinition });
    this._rebuildObject();
    this._renderTextures();
    this._renderWorldTextures();
    this._renderInspector();
    this.onTexturesChanged();
    this.onWorldTexturesChanged();
    this.onStatus(`Deleted texture "${name}" · Save Object/textures to persist`);
  }

  /**
   * Canvas-based texture editor: crop to a dragged rectangle, or erase pixels
   * to transparency with a round brush. Saves back into the library (faces
   * using the texture update immediately) or as a new copy.
   */
  _openTextureEditor(textureId) {
    const record = this.store.getTexture(textureId);
    if (!record) return;
    this.textureEditor?.remove();
    const dialog = element('div', 'modeler-texture-editor');
    dialog.dataset.testid = 'modeler-texture-editor';
    this.textureEditor = dialog;
    dialog.append(element('b', '', `Edit image · ${record.name || textureId}`));

    const toolbar = element('div', 'modeler-texture-toolbar');
    const cropButton = button('Crop', 'tool-button small', 'Drag a rectangle over the image, then Apply crop');
    const eraseButton = button('Erase', 'tool-button small', 'Paint over the image to make those pixels transparent');
    const brushLabel = element('label', 'modeler-texture-brush');
    brushLabel.append(element('span', '', 'Brush'));
    const brushInput = document.createElement('input');
    brushInput.type = 'range';
    brushInput.min = '2';
    brushInput.max = '64';
    brushInput.value = '12';
    brushInput.setAttribute('aria-label', 'Eraser brush size in pixels');
    brushLabel.append(brushInput);
    const applyCropButton = button('Apply crop', 'tool-button small accent', 'Crop the image to the selected rectangle');
    applyCropButton.disabled = true;
    const undoButton = button('⟲ Undo', 'tool-button small', 'Undo the last image edit');
    undoButton.disabled = true;
    const resetButton = button('Reset', 'tool-button small', 'Back to the image as stored in the library');
    toolbar.append(cropButton, eraseButton, brushLabel, applyCropButton, undoButton, resetButton);
    dialog.append(toolbar);

    const stage = element('div', 'modeler-texture-stage');
    const canvas = document.createElement('canvas');
    const selection = element('div', 'modeler-texture-selection');
    selection.hidden = true;
    stage.append(canvas, selection);
    dialog.append(stage);
    const hint = element('p', 'modeler-help', '');
    const sizeInfo = element('small', 'modeler-texture-size', '');
    dialog.append(hint, sizeInfo);

    const actions = element('div', 'modeler-chooser-actions');
    const saveEditButton = button('Save', 'tool-button accent', 'Replace the library image — every face using it updates');
    const saveCopyButton = button('Save as copy', 'tool-button', 'Keep the original and add the edited image as a new texture');
    const cancelButton = button('Cancel', 'tool-button', 'Close without changing the library');
    actions.append(saveEditButton, saveCopyButton, cancelButton);
    dialog.append(actions);

    const context = canvas.getContext('2d', { willReadFrequently: true });
    const undoStack = [];
    let mode = 'crop';
    let cropRect = null; // in image pixels
    let stroke = null;

    const fitCanvas = () => {
      // Blow small PSX textures up to a workable size; big images rely on the
      // stage's max-width. Pointer mapping goes through getBoundingClientRect,
      // so any display scale stays accurate.
      const largest = Math.max(canvas.width, canvas.height, 1);
      const scale = Math.max(1, Math.min(8, Math.floor(320 / largest) || 1));
      canvas.style.width = `${canvas.width * scale}px`;
      canvas.style.height = 'auto';
    };
    const setInfo = () => {
      sizeInfo.textContent = `${canvas.width} × ${canvas.height} px`;
      fitCanvas();
    };
    const clearCrop = () => {
      cropRect = null;
      selection.hidden = true;
      applyCropButton.disabled = true;
    };
    const setMode = (next) => {
      mode = next;
      cropButton.setAttribute('aria-pressed', String(mode === 'crop'));
      eraseButton.setAttribute('aria-pressed', String(mode === 'erase'));
      hint.textContent = mode === 'crop'
        ? 'Drag a rectangle over the image, then press Apply crop.'
        : 'Paint over the image: painted pixels turn transparent (the checkerboard shows through).';
      if (mode !== 'crop') clearCrop();
    };
    cropButton.addEventListener('click', () => setMode('crop'));
    eraseButton.addEventListener('click', () => setMode('erase'));

    const pushUndo = () => {
      undoStack.push(context.getImageData(0, 0, canvas.width, canvas.height));
      if (undoStack.length > 20) undoStack.shift();
      undoButton.disabled = false;
    };
    undoButton.addEventListener('click', () => {
      const snapshot = undoStack.pop();
      if (snapshot) {
        canvas.width = snapshot.width;
        canvas.height = snapshot.height;
        context.putImageData(snapshot, 0, 0);
        clearCrop();
        setInfo();
      }
      undoButton.disabled = !undoStack.length;
    });

    const toImagePoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [
        (event.clientX - rect.left) * (canvas.width / rect.width),
        (event.clientY - rect.top) * (canvas.height / rect.height),
      ];
    };
    const eraseAt = ([x, y]) => {
      const radius = Math.max(1, Number(brushInput.value) / 2 || 6);
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    };
    const updateCrop = (start, point) => {
      const x1 = Math.max(0, Math.min(start[0], point[0]));
      const y1 = Math.max(0, Math.min(start[1], point[1]));
      const x2 = Math.min(canvas.width, Math.max(start[0], point[0]));
      const y2 = Math.min(canvas.height, Math.max(start[1], point[1]));
      cropRect = { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
      const scaleX = (canvas.clientWidth || canvas.width) / canvas.width;
      const scaleY = (canvas.clientHeight || canvas.height) / canvas.height;
      selection.hidden = false;
      selection.style.left = `${canvas.offsetLeft + cropRect.x * scaleX}px`;
      selection.style.top = `${canvas.offsetTop + cropRect.y * scaleY}px`;
      selection.style.width = `${cropRect.w * scaleX}px`;
      selection.style.height = `${cropRect.h * scaleY}px`;
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const point = toImagePoint(event);
      if (mode === 'crop') {
        clearCrop();
        stroke = { type: 'crop', start: point };
      } else {
        pushUndo();
        stroke = { type: 'erase' };
        eraseAt(point);
      }
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!stroke) return;
      const point = toImagePoint(event);
      if (stroke.type === 'erase') eraseAt(point);
      else updateCrop(stroke.start, point);
    });
    canvas.addEventListener('pointerup', () => {
      if (stroke?.type === 'crop') applyCropButton.disabled = !cropRect || cropRect.w < 1 || cropRect.h < 1;
      stroke = null;
    });
    canvas.addEventListener('pointercancel', () => { stroke = null; });

    applyCropButton.addEventListener('click', () => {
      if (!cropRect || cropRect.w < 1 || cropRect.h < 1) return;
      pushUndo();
      const cut = context.getImageData(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      canvas.width = cropRect.w;
      canvas.height = cropRect.h;
      context.putImageData(cut, 0, 0);
      clearCrop();
      setInfo();
    });

    const image = new Image();
    const drawOriginal = () => {
      canvas.width = image.naturalWidth || image.width || 1;
      canvas.height = image.naturalHeight || image.height || 1;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      clearCrop();
      setInfo();
    };
    resetButton.addEventListener('click', () => { pushUndo(); drawOriginal(); });
    image.onload = drawOriginal;
    image.onerror = () => {
      this.onStatus('Could not load this texture for editing');
      dialog.remove();
      this.textureEditor = null;
    };
    image.src = textureSourceUrl(record);

    const closeDialog = () => {
      dialog.remove();
      this.textureEditor = null;
    };
    const exportDataUrl = () => {
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length > 4 * 1024 * 1024) {
        this.onStatus('Edited image is too large — crop it smaller (keep textures under ~3 MB)');
        return null;
      }
      return dataUrl;
    };
    const afterLibraryChange = (statusText) => {
      closeDialog();
      this._markDirty({ history: false });
      this._renderTextures();
      this._renderWorldTextures();
      this._rebuildObject();
      this._renderInspector();
      this.onTexturesChanged();
      this.onWorldTexturesChanged();
      this.onStatus(statusText);
    };
    saveEditButton.addEventListener('click', () => {
      const dataUrl = exportDataUrl();
      if (!dataUrl) return;
      try {
        this.store.updateTexture(textureId, { dataUrl });
        afterLibraryChange(`Updated texture "${record.name || textureId}" · Save Object/textures to persist`);
      } catch (error) {
        this.onStatus(`Save failed · ${error.message}`);
      }
    });
    saveCopyButton.addEventListener('click', () => {
      const dataUrl = exportDataUrl();
      if (!dataUrl) return;
      try {
        const id = this.store.addTextureFromDataUrl(`${record.name || textureId} copy`, dataUrl);
        afterLibraryChange(`Saved edited copy as ${id}`);
      } catch (error) {
        this.onStatus(`Save failed · ${error.message}`);
      }
    });
    cancelButton.addEventListener('click', closeDialog);

    setMode('crop');
    this.overlay.append(dialog);
  }

  // ------------------------------------------------------- world objects --
  /**
   * Switches the left library between the objects you modelled and the
   * archetypes the map generator already repeats across the world.
   */
  _syncLibraryChrome() {
    const world = this.library === 'world';
    for (const [name, node] of Object.entries(this.libraryButtons)) node.setAttribute('aria-checked', String(name === this.library));
    this.assetList.hidden = world;
    this.worldObjectList.hidden = !world;
    this.newObjectButton.hidden = world;
    for (const node of [this.partsHeading, this.partList, this.addPartsRow, this.catalogRow, this.scaleRow]) node.hidden = world;
    this.nameInput.hidden = world;
    this.layerSelect.hidden = world;
    for (const node of [this.saveButton, this.saveCopyButton, this.deleteButton]) node.hidden = world;
    this.worldSaveButton.hidden = !world;
    this.worldTextureSection.hidden = !world;
    this.inspector.hidden = world;
    this.textureLibraryHeading.hidden = world;
    this.textureList.hidden = world;
    this.uploadTextureButton.hidden = world;
    this.addVerticesButton.hidden = world || this.mode !== 'vertex';
    // World-object mode has nothing to model: the viewport is a live preview.
    this.modeBar.hidden = world;
  }

  _setLibrary(key) {
    this.library = key === 'world' ? 'world' : 'custom';
    const world = this.library === 'world';
    this._syncLibraryChrome();
    if (world) {
      this._renderWorldObjectList();
      this._selectWorldObject(this.worldObject || Object.keys(WORLD_OBJECTS)[0], this.worldSlot);
      this.onStatus('World objects · pick a type, give it a texture — every copy of it in the map changes with it');
    } else {
      this.assetGroup.visible = true;
      this.worldPreviewGroup.clear();
      this._renderAll();
      this.onStatus('Your objects · build and texture your own models');
    }
  }

  _renderWorldObjectList() {
    this.worldObjectList.innerHTML = '';
    for (const entry of WORLD_OBJECT_GROUPS) {
      this.worldObjectList.append(element('h4', 'modeler-world-group', entry.group));
      for (const objectId of entry.objects) {
        const meta = WORLD_OBJECTS[objectId];
        const surfaces = worldObjectSurfaces(objectId);
        const painted = surfaces.filter((slot) => !isDefaultWorldSurfaceStyle(this.store.worldSurface(slot)));
        const row = element('button', `modeler-asset-row${objectId === this.worldObject ? ' selected' : ''}`);
        row.type = 'button';
        row.dataset.testid = `modeler-world-object-${objectId}`;
        row.title = meta.description;
        row.append(
          element('b', '', meta.label),
          element('small', '', painted.length
            ? `${painted.length}/${surfaces.length} surface${surfaces.length === 1 ? '' : 's'} painted`
            : `${surfaces.length} surface${surfaces.length === 1 ? '' : 's'} · ${meta.description}`),
        );
        if (painted.length) row.classList.add('is-custom');
        row.addEventListener('click', () => this._selectWorldObject(objectId));
        this.worldObjectList.append(row);
      }
    }
    const openSurfaces = button('Open full Surfaces editor →', 'tool-button small', 'The dedicated section for repeated surfaces: asphalt, tunnels, terrain, and every tiling control');
    openSurfaces.addEventListener('click', () => {
      if (!this.onOpenSurfaces) { this.onStatus('The Surfaces editor is unavailable in this scene'); return; }
      this.close();
      this.onOpenSurfaces(this.worldSlot);
    });
    this.worldObjectList.append(openSurfaces);
  }

  _selectWorldObject(objectId, slot = null) {
    if (!WORLD_OBJECTS[objectId]) return;
    const surfaces = worldObjectSurfaces(objectId);
    const sameObject = this.worldObject === objectId;
    this.worldObject = objectId;
    this.worldSlot = surfaces.includes(slot) ? slot : surfaces[0];
    this._renderWorldObjectList();
    this._renderWorldObjectPanel();
    // Switching surface inside the same object must not yank the camera away
    // from wherever the user orbited to inspect it.
    if (!sameObject) this._buildWorldPreview();
  }

  _selectWorldSlot(slot) {
    if (!WORLD_SURFACES[slot]) return;
    // A bare slot (from the Surfaces editor, or a restored session) resolves to
    // whichever object owns it.
    const owner = this.worldObject && worldObjectSurfaces(this.worldObject).includes(slot)
      ? this.worldObject
      : worldObjectsUsingSurface(slot)[0];
    if (!owner) return;
    this._selectWorldObject(owner, slot);
  }

  /**
   * The right panel of world-object mode: the object, every surface it is made
   * of, and the paint controls of the selected one — the same shape as the part
   * list and face panel of a modelled object.
   */
  _renderWorldObjectPanel() {
    this.worldObjectHeader.innerHTML = '';
    const objectId = this.worldObject;
    const meta = WORLD_OBJECTS[objectId];
    if (!meta) { this.worldSurfaceList.innerHTML = ''; return; }
    const surfaces = worldObjectSurfaces(objectId);

    const head = element('div', 'surface-head');
    head.append(element('b', '', meta.label));
    this.worldObjectHeader.append(head);
    this.worldObjectHeader.append(element('p', 'modeler-help',
      `${meta.description}. Made of ${surfaces.length} surface${surfaces.length === 1 ? '' : 's'} — pick one below, or click it in the preview. One material, one archetype: every ${meta.label.toLowerCase()} in the world changes with it.`));

    // ------------------------------------------------------------- the model --
    // Instanced archetypes draw from ONE shared geometry and the buildings keep
    // a per-copy box record, so both can be stood in for by a saved model and
    // every copy changes. What has neither (route signs, matrix boards, tunnel
    // strips) is merged into chunk quads with no trace of the individual
    // copies: say so instead of offering a round trip that cannot land.
    this.worldObjectHeader.append(element('h4', 'surface-group-title', 'Model'));
    const modelKey = worldObjectModelKey(this.worldObject);
    const replacement = modelKey ? this.store.worldModel(modelKey) : null;
    const replacementAsset = replacement ? this.store.getAsset(replacement) : null;
    if (modelKey) {
      const count = this._archetypeCount(meta);
      this.worldObjectHeader.append(element('p', 'modeler-help', replacementAsset
        ? `Every one of these draws your object "${replacementAsset.label}" instead of the generated shape${count ? ` · ${count} in the map` : ''}.`
        : `Model this object and save it, and all ${count ? `${count} ` : ''}copies in the map take the new shape — in the editor and in the game.`));
    } else {
      this.worldObjectHeader.append(element('p', 'modeler-help',
        'The map bakes these into merged chunk geometry with no record of each copy, so their SHAPE cannot be replaced — painting the surfaces below is what changes all of them. Modelling it still gives you your own object to place by hand.'));
    }

    const editRow = element('div', 'surface-button-row');
    const hasGeometry = Boolean(meta.assetId && this.assetRegistry?.get?.(meta.assetId));
    if (hasGeometry) {
      const exact = button('✎ Edit exact shape…', 'tool-button small accent',
        "Open the world's real geometry as your own object — exact silhouette, moved/rotated/scaled and combinable with new parts");
      exact.dataset.testid = 'modeler-world-edit-as-model';
      exact.addEventListener('click', () => this._editWorldObjectAsModel({ exact: true }));
      editRow.append(exact);
    }
    const editable = button('⬚ Edit as editable parts…', `tool-button small${hasGeometry ? '' : ' accent'}`,
      'Open this object as primitive parts — reshape them, texture each face, drag vertices, exactly like a custom object');
    editable.dataset.testid = hasGeometry ? 'modeler-world-edit-as-parts' : 'modeler-world-edit-as-model';
    editable.addEventListener('click', () => this._editWorldObjectAsModel({ exact: false }));
    editRow.append(editable);
    if (modelKey) {
      const pick = button('Use a saved object…', 'tool-button small',
        'Point this archetype at an object you already modelled');
      pick.dataset.testid = 'modeler-world-pick-model';
      pick.addEventListener('click', () => this._chooseWorldModel(objectId));
      editRow.append(pick);
      if (replacementAsset) {
        const reset = button('Back to generated shape', 'tool-button small danger',
          'Drop the replacement model; every copy goes back to the shape the generator makes');
        reset.dataset.testid = 'modeler-world-reset-model';
        reset.addEventListener('click', () => this._setWorldModel(objectId, null));
        editRow.append(reset);
      }
    }
    this.worldObjectHeader.append(editRow);

    this.worldObjectHeader.append(element('h4', 'surface-group-title', 'Surfaces of this object'));
    this._renderWorldSurfaceRows();
    this.worldStyleEditor.setSlot(this.worldSlot);
  }

  /**
   * Just the surface rows (selection, thumbnail, painted state). Kept separate
   * from the panel render because it runs on every slider tick: rebuilding the
   * paint controls there would destroy the control being dragged.
   */
  _renderWorldSurfaceRows() {
    this.worldSurfaceList.innerHTML = '';
    if (!WORLD_OBJECTS[this.worldObject]) return;
    for (const slot of worldObjectSurfaces(this.worldObject)) {
      const surfaceMeta = WORLD_SURFACES[slot];
      const style = this.store.worldSurface(slot);
      const row = element('div', `modeler-face-row${slot === this.worldSlot ? ' selected' : ''}`);
      row.dataset.testid = `modeler-world-surface-${slot}`;
      const pick = element('button', 'modeler-face-pick', surfaceMeta?.label || slot);
      pick.type = 'button';
      pick.addEventListener('click', () => this._selectWorldObject(this.worldObject, slot));
      row.append(pick);
      const record = style.texture ? this.store.getTexture(style.texture) : null;
      if (record) {
        const thumb = element('img', 'modeler-face-thumb');
        thumb.src = textureSourceUrl(record);
        thumb.alt = record.name || style.texture;
        row.append(thumb);
      } else {
        row.append(element('small', 'modeler-face-none', isDefaultWorldSurfaceStyle(style) ? 'generated' : 'tinted'));
      }
      // Materials the generator shares between archetypes: say so before the
      // user discovers it by repainting half the city.
      const shared = worldObjectsUsingSurface(slot).filter((objectId) => objectId !== this.worldObject);
      if (shared.length) {
        const tag = element('small', 'modeler-face-regions', `shared ×${shared.length + 1}`);
        tag.title = `The map uses this same material for: ${[this.worldObject, ...shared].map((objectId) => WORLD_OBJECTS[objectId].label).join(', ')} — painting it changes all of them.`;
        row.append(tag);
      }
      this.worldSurfaceList.append(row);
    }
  }

  /**
   * Hands the archetype to the normal modeler as an editable object: the real
   * catalog geometry when the world has a reusable asset for it, otherwise the
   * object's composite volumes as primitive parts. The result is YOUR object —
   * saved to the catalog and placeable — while surface paint stays the way to
   * change every copy already standing in the map.
   */
  /**
   * How many copies of an archetype the live map holds — instanced buckets by
   * their instance count, buildings from the per-copy box record, which is
   * there whether or not a replacement is currently standing in for them.
   */
  _archetypeCount(meta) {
    const map = this.getMap();
    if (meta.buildingType) {
      return (map?.buildingBoxes || []).filter((box) => box.material === meta.buildingType).length;
    }
    if (!meta.instanceType) return 0;
    let total = 0;
    for (const chunk of [...(map?._chunks?.values?.() || [])]) {
      for (const object of chunk.group?.children || []) {
        if (object.isInstancedMesh && String(object.name).replace(/^chunk\s+\S+\s+/, '') === meta.instanceType) total += object.count;
      }
    }
    return total;
  }

  /** Points an archetype at a saved object (or back to the generated shape). */
  _setWorldModel(objectId, assetId) {
    // The object is passed in, not read off `this`: the chooser resolves long
    // after it opened, and the selection may have moved on since.
    const key = worldObjectModelKey(objectId);
    const meta = WORLD_OBJECTS[objectId];
    if (!key || !meta) return;
    this.store.setWorldModel(key, assetId);
    this.dirtyChip.textContent = 'Unsaved changes';
    this.onWorldModelsChanged();
    this._renderWorldObjectPanel();
    this._buildWorldPreview();
    const asset = assetId ? this.store.getAsset(assetId) : null;
    this.onStatus(asset
      ? `Every ${meta.label.toLowerCase()} in the map now draws "${asset.label}" · Save world paint to keep it`
      : `${meta.label} back to its generated shape`);
  }

  _chooseWorldModel(objectId) {
    const meta = WORLD_OBJECTS[objectId];
    const assets = this.store.assets();
    if (!assets.length) { this.onStatus('No saved objects yet — model one first'); return; }
    const chooser = element('div', 'modeler-chooser');
    chooser.dataset.testid = 'modeler-model-chooser';
    chooser.append(element('b', '', `Object to draw instead of every ${meta.label.toLowerCase()}`));
    const grid = element('div', 'modeler-chooser-grid');
    for (const asset of assets.sort((a, b) => (a.label || '').localeCompare(b.label || ''))) {
      const pick = element('button', 'modeler-chooser-item');
      pick.type = 'button';
      pick.append(element('small', '', asset.label || asset.id));
      pick.addEventListener('click', () => { chooser.remove(); this._setWorldModel(objectId, asset.id); });
      grid.append(pick);
    }
    chooser.append(grid);
    const actions = element('div', 'modeler-chooser-actions');
    const cancel = button('Cancel', 'tool-button');
    cancel.addEventListener('click', () => chooser.remove());
    actions.append(cancel);
    chooser.append(actions);
    this.overlay.append(chooser);
  }

  _editWorldObjectAsModel({ exact = true } = {}) {
    const meta = WORLD_OBJECTS[this.worldObject];
    if (!meta) return;
    // Remember what is being modelled: Save Object puts the result straight
    // back onto every copy of the archetype it came from.
    const modelKey = worldObjectModelKey(this.worldObject);
    this.modelTargetObject = modelKey ? this.worldObject : null;
    // Re-opening an archetype that already draws one of your objects reopens
    // THAT object, so a second round of edits lands on it instead of leaving a
    // trail of near-identical copies in the catalog.
    const current = modelKey ? this.store.worldModel(modelKey) : null;
    if (current && this.store.getAsset(current)) {
      const target = this.modelTargetObject;
      this._setLibrary('custom');
      this.open(current);
      this.modelTargetObject = target; // _loadDefinition clears it
      this.onStatus(`Editing "${this.definition.label}" · Save Object and every ${meta.label.toLowerCase()} in the map follows`);
      return;
    }
    if (exact && meta.assetId && this.assetRegistry?.get?.(meta.assetId)) {
      this._setLibrary('custom');
      const target = this.modelTargetObject;
      this.editCopyOfAsset(meta.assetId);
      this.modelTargetObject = target; // editCopyOfAsset may reload the definition
      this.onStatus(modelKey
        ? `${meta.label} opened with its exact world geometry · Save Object and every copy in the map takes the new shape`
        : `${meta.label} opened with its exact world geometry · Save Object adds it to your catalog (its generated copies keep their shape)`);
      return;
    }
    const parts = worldObjectModelParts(this.worldObject, this.getMaterials(), { store: this.store });
    if (!parts.length) { this.onStatus(`${meta.label} has no geometry to model in this scene`); return; }
    this._setLibrary('custom');
    this.definition = {
      id: this.store.newAssetId(),
      label: `${meta.label} custom`,
      description: `Based on the generated ${meta.label.toLowerCase()}`,
      layer: 'Props',
      createdAt: new Date().toISOString(),
      parts,
    };
    this.editingExisting = false;
    this.selectedPart = 0;
    this.selectedFace = null;
    this.selectedVertex = -1;
    this._resetHistory();
    this._renderAll();
    this._markDirty({ history: false });
    this.onStatus(modelKey
      ? `${meta.label} opened as ${parts.length} editable part${parts.length === 1 ? '' : 's'} · reshape it, then Save Object and every copy in the map follows`
      : `${meta.label} opened as ${parts.length} editable part${parts.length === 1 ? '' : 's'} · reshape and texture it like any object, then Save Object`);
  }

  /**
   * Shows the selected archetype in the modeler viewport, every part carrying
   * the LIVE map material of its surface — so a texture change is visible here
   * exactly as it lands out in the map, and clicking a part picks its surface.
   */
  _buildWorldPreview() {
    this.worldPreviewGroup.clear();
    this.assetGroup.visible = false;
    this._detachGizmo();
    const meta = WORLD_OBJECTS[this.worldObject];
    const modelKey = worldObjectModelKey(this.worldObject);
    const replacementId = modelKey ? this.store.worldModel(modelKey) : null;
    const replacement = replacementId ? this.store.getAsset(replacementId) : null;
    // A replaced archetype must preview as what the map now draws, not as the
    // generated shape it no longer has.
    const meshes = replacement
      ? (() => {
        const group = buildCustomAssetGroup(replacement, this.store.texturesById(), { resolveAssetPart: assetPartResolver(this.assetRegistry) });
        group.updateMatrixWorld(true);
        const built = [];
        group.traverse((child) => { if (child.isMesh) built.push(child); });
        for (const child of built) child.removeFromParent();
        return built;
      })()
      : buildWorldObjectPreview(this.worldObject, {
        materials: this.getMaterials(),
        assetRegistry: this.assetRegistry,
      });
    if (!meshes.length) {
      this.onStatus(`${WORLD_OBJECTS[this.worldObject]?.label || 'This object'} · no live map material in this scene — the paint controls still work and apply on reload`);
      return;
    }
    for (const mesh of meshes) this.worldPreviewGroup.add(mesh);
    const bounds = previewFocusBounds(this.worldPreviewGroup);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(1.2, size.length() * 0.75);
    this.orbit.target.copy(center);
    this.camera.position.set(center.x + radius * 1.1, center.y + radius * 0.75, center.z + radius * 1.4);
    this.camera.near = Math.max(0.02, radius / 500);
    this.camera.far = radius * 80;
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  /** Click in the world preview: select the surface of the part that was hit. */
  _pickWorldSurface(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.worldPreviewGroup.children, true)[0];
    const slot = hit?.object?.userData?.surfaceSlot;
    if (!slot || slot === this.worldSlot) return;
    this._selectWorldObject(this.worldObject, slot);
    this.onStatus(`${WORLD_SURFACES[slot]?.label || slot} selected · paint it on the right`);
  }

  /** Kept for callers that refresh after a texture-library change. */
  _renderWorldTextures() {
    if (this.library !== 'world') return;
    this._renderWorldObjectList();
    this._renderWorldObjectPanel();
  }

  _syncModeButtons() {
    for (const [mode, node] of Object.entries(this.modeButtons)) node.setAttribute('aria-pressed', String(mode === this.mode));
    this.addVerticesButton.hidden = this.mode !== 'vertex';
    this.modeHint.textContent = {
      part: 'Click a part to select · W/E/R move/rotate/scale · G snap · Del removes · Ctrl+Z/Y undo/redo',
      face: 'Click a face, then drag the gizmo to pull the whole face — or attach an image from the panel on the right',
      vertex: 'Drag a vertex via the gizmo · right-click surface/edge adds an opposing vertex pair · right-click a handle removes it · G snaps',
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
    this._refreshOutlines(); // the selection highlight moves with it
  }

  _detachGizmo() {
    this.gizmo.detach();
    if (this.gizmoProxy) { this.gizmoProxy.removeFromParent(); this.gizmoProxy = null; }
    this._faceDrag = null;
  }

  _attachGizmoToSelection() {
    this._detachGizmo();
    if (this.mode === 'part') {
      const node = this.partNodes[this.selectedPart];
      if (node) { this.gizmo.setMode('translate'); this.gizmo.attach(node); }
      return;
    }
    if (this.mode === 'face') {
      const anchor = this._faceGizmoAnchor();
      if (!anchor) return;
      this.gizmoProxy = new THREE.Object3D();
      this.gizmoProxy.position.copy(anchor);
      this.scene.add(this.gizmoProxy);
      this._faceDrag = { startWorld: anchor.clone(), basePart: clone(this.definition.parts[this.selectedPart]) };
      this.gizmo.setMode('translate');
      this.gizmo.attach(this.gizmoProxy);
      return;
    }
    if (this.mode === 'vertex' && this.selectedVertex >= 0) {
      const handle = this.vertexHandles.find((item) => item.userData.weldIndex === this.selectedVertex);
      if (handle) { this.gizmo.setMode('translate'); this.gizmo.attach(handle); }
    }
  }

  /** World-space centroid of the selected face, the pull gizmo's anchor. */
  _faceGizmoAnchor() {
    const part = this.definition?.parts[this.selectedPart];
    const node = this.partNodes[this.selectedPart];
    if (!part || part.kind === 'asset' || !node?.isMesh || !this.selectedFace) return null;
    const materialIndex = partFaceNames(part).indexOf(this.selectedFace);
    if (materialIndex < 0) return null;
    const geometry = node.geometry;
    const position = geometry?.getAttribute?.('position');
    if (!position) return null;
    const index = geometry.index;
    const cornerCount = index ? index.count : position.count;
    const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: cornerCount, materialIndex: 0 }];
    const sum = new THREE.Vector3();
    let count = 0;
    for (const group of groups) {
      if ((group.materialIndex || 0) !== materialIndex) continue;
      for (let corner = group.start; corner < group.start + group.count; corner += 1) {
        const vertex = index ? index.getX(corner) : corner;
        sum.x += position.getX(vertex);
        sum.y += position.getY(vertex);
        sum.z += position.getZ(vertex);
        count += 1;
      }
    }
    if (!count) return null;
    sum.multiplyScalar(1 / count);
    node.updateWorldMatrix(true, false);
    return sum.applyMatrix4(node.matrixWorld);
  }

  _onGizmoChange() {
    const part = this.definition?.parts[this.selectedPart];
    if (!part) return;
    if (this.mode === 'face') {
      // Pull the whole face: apply the total drag delta to a clone of the
      // part as it was when the gizmo attached (no incremental drift).
      const node = this.partNodes[this.selectedPart];
      const drag = this._faceDrag;
      if (!node?.isMesh || !drag || !this.gizmoProxy || !this.selectedFace) return;
      node.updateWorldMatrix(true, false);
      const inverse = node.matrixWorld.clone().invert();
      const localNow = this.gizmoProxy.position.clone().applyMatrix4(inverse);
      const localStart = drag.startWorld.clone().applyMatrix4(inverse);
      const delta = [localNow.x - localStart.x, localNow.y - localStart.y, localNow.z - localStart.z];
      const moved = clone(drag.basePart);
      if (!translatePartFace(moved, this.selectedFace, delta)) return;
      if (part.kind === 'mesh') part.vertices = moved.vertices;
      else if (moved.vertexOffsets) part.vertexOffsets = moved.vertexOffsets;
      else delete part.vertexOffsets;
      this._rebuildPartGeometry(this.selectedPart);
      return;
    }
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
    if (this.mode === 'face' && this._faceDrag) {
      const face = this.selectedFace;
      this._attachGizmoToSelection(); // re-anchor at the face's new centroid
      if (face) this.onStatus(`Pulled the whole "${face}" face · Ctrl+Z undoes`);
    }
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
      this._attachGizmoToSelection();
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
    const added = meshInsertVertexAtPoint(part, [local.x, local.y, local.z], {
      faceIndex: partHit.face?.materialIndex,
    });
    if (!added) {
      this.onStatus('Could not add a vertex there (mesh vertex limit reached?)');
      return;
    }
    this.selectedVertex = added.vertexIndex;
    this._markDirty();
    this._rebuildObject();
    this._renderInspector();
    const paired = Number.isInteger(added.oppositeVertexIndex);
    this.onStatus(paired
      ? `Opposing vertex pair added${added.connected ? ' and joined across the shared face' : ''} · drag either handle to shape it`
      : (added.split === 'corner'
        ? 'Snapped to the existing vertex · drag the gizmo to move it'
        : (added.split === 'edge'
          ? 'Vertex added on the edge · drag the gizmo to move it · right-click it to remove'
          : 'Vertex added · drag the gizmo to move it · right-click it to remove')));
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
    this._chooseTexture(`Texture for face "${faceName}"`, (textureId) => {
      part.faces = part.faces || {};
      const nextStyle = { ...(part.faces[faceName] || {}), texture: textureId };
      // Mesh UVs are inherited fragments after folds and splits — attaching
      // an image means pasting it flat onto the face, so mesh faces default
      // to a fitted cover projection. An explicit Stretch choice made in the
      // fit dropdown is respected.
      if (part.kind === 'mesh' && nextStyle.fit === undefined) nextStyle.fit = 'cover';
      if (nextStyle.fit === 'cover') {
        const projection = partFaceCoverProjection(part, faceName);
        if (projection) nextStyle.projection = projection;
      }
      part.faces[faceName] = nextStyle;
      this.selectedFace = faceName;
      this._markDirty();
      this._rebuildObject();
      this._renderInspector();
      this._renderTextures();
      this.onTexturesChanged();
    });
  }

  /** Texture picker overlay: reuse an uploaded image or add a new one. */
  _chooseTexture(title, useTexture) {
    const textures = this.store.textures();
    if (!textures.length) { this._pickImage(useTexture); return; }
    const chooser = element('div', 'modeler-chooser');
    chooser.append(element('b', '', title));
    const grid = element('div', 'modeler-chooser-grid');
    for (const texture of textures) {
      const pick = element('button', 'modeler-chooser-item');
      pick.type = 'button';
      const img = element('img');
      img.src = textureSourceUrl(texture);
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
        this.onTexturesChanged();
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
      // An object modelled FROM a replaceable archetype goes straight back onto
      // it: that is the round trip — reshape it, save, every copy follows.
      const targetKey = worldObjectModelKey(this.modelTargetObject || '');
      const target = targetKey ? WORLD_OBJECTS[this.modelTargetObject] : null;
      if (target) this.store.setWorldModel(targetKey, saved.id);
      await this.store.save();
      refreshCustomAsset(this.assetRegistry, this.store.document, saved.id);
      this.definition = clone(saved);
      this.editingExisting = true;
      if (asCopy) this._resetHistory(); // old entries carry the previous asset id
      this.onAssetsChanged();
      this._renderAssetList();
      if (target) this.onWorldModelsChanged();
      this.dirtyChip.textContent = '';
      this.onStatus(target
        ? `Saved "${saved.label}" · every ${target.label.toLowerCase()} in the map now draws it — switch to World objects to see them`
        : `Saved "${saved.label}" · it is now in the Assets menu, ready to place in the world`);
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
