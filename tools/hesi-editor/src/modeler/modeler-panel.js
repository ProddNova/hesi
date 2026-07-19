import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PART_KINDS, WORLD_TEXTURE_SLOTS, buildPartObject, partGeometry, applyVertexOffsets, weldedVertices } from '/js/custom-assets.js';
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
    this.modeHint = element('span', 'modeler-mode-hint', '');
    modeBar.append(this.modeHint);
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
    this.nameInput.addEventListener('input', () => { if (this.definition) { this.definition.label = this.nameInput.value; this._markDirty(); } });
    this.layerSelect.addEventListener('change', () => { if (this.definition) { this.definition.layer = this.layerSelect.value; this._markDirty(); } });
    this.saveButton.addEventListener('click', () => this._save(false));
    this.saveCopyButton.addEventListener('click', () => this._save(true));
    this.deleteButton.addEventListener('click', () => this._deleteAsset());
    for (const [kind, node] of Object.entries(this.addButtons)) node.addEventListener('click', () => this._addPart(kind));
    this.addCatalogButton.addEventListener('click', () => this._addCatalogPart());
    for (const [mode, node] of Object.entries(this.modeButtons)) node.addEventListener('click', () => this._setMode(mode));
    this.uploadTextureButton.addEventListener('click', () => this._pickImage((textureId) => {
      this._markDirty();
      this._renderTextures();
      this.onStatus(`Added texture ${textureId} to the library`);
    }));

    this._onPointerDown = (event) => {
      if (event.button !== 0 || this.gizmo.dragging) return;
      this._pick(event);
    };
    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);

    this._onKeyDown = (event) => {
      if (!this.openState) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
      if (event.code === 'Escape') { event.preventDefault(); this._detachGizmo(); return; }
      if (event.code === 'Delete') { event.preventDefault(); this._deleteSelectedPart(); return; }
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
    this._renderAll();
    this._markDirty();
  }

  /** Opens the modeler pre-loaded with an assembled definition (from map selection). */
  openAssembled(definition) {
    this.definition = clone(definition);
    this.editingExisting = false;
    this.selectedPart = 0;
    this.selectedFace = null;
    this.selectedVertex = -1;
    this.open();
    this._renderAll();
    this._markDirty();
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

  _markDirty() {
    this.store.dirty = true;
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
  }

  _rebuildPartGeometry(index) {
    const part = this.definition.parts[index];
    const node = this.partNodes[index];
    if (!part || !node?.isMesh || part.kind === 'asset') return;
    const geometry = partGeometry(part);
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
    const base = partGeometry(part);
    const { welded } = weldedVertices(base);
    base.dispose();
    const offsets = new Map((part.vertexOffsets || []).map((entry) => [entry.i, entry.o]));
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
      colorInput.addEventListener('input', () => { part.color = colorInput.value; this._markDirty(); this._rebuildObject(); });
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
      if (part.vertexOffsets?.length) {
        const reset = button('Reset vertex edits', 'tool-button small', 'Remove all vertex offsets of this part');
        reset.addEventListener('click', () => { delete part.vertexOffsets; this._markDirty(); this._rebuildObject(); this._renderInspector(); });
        this.inspector.append(reset);
      }
      this._renderFacePanel(part);
    } else {
      this.inspector.append(element('p', 'modeler-help', `Assembled from catalog asset ${part.assetRef}. Move, rotate, and scale it like any part.`));
    }
  }

  _renderFacePanel(part) {
    const faces = PART_KINDS[part.kind]?.faces || [];
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
        this._markDirty();
        this._renderWorldTextures();
        this.onWorldTexturesChanged();
        this.onStatus(`${meta.label} texture set · Save Object/textures to persist, the playable game updates on reload`);
      }));
      row.append(upload);
      if (currentRecord) {
        const clear = button('Clear', 'tool-button small danger', 'Back to the original generated colour');
        clear.addEventListener('click', () => {
          this.store.setWorldTexture(slot, null);
          this._markDirty();
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
    this.modeHint.textContent = {
      part: 'Click a part to select · W/E/R switch move/rotate/scale · Del removes the part',
      face: 'Click a face of the object, then attach an image from the panel on the right',
      vertex: 'Click a vertex handle, then drag the gizmo · low-poly PSX shaping',
    }[this.mode] || '';
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
      const base = handle.userData.basePosition;
      const offset = [local.x - base[0], local.y - base[1], local.z - base[2]];
      const weldIndex = handle.userData.weldIndex;
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

  _pick(event) {
    if (!this.definition) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.mode === 'vertex') {
      const handleHits = this.raycaster.intersectObjects(this.vertexHandles, false);
      if (handleHits.length) {
        this.selectedVertex = handleHits[0].object.userData.weldIndex;
        this._rebuildVertexHandles();
        this._attachGizmoToSelection();
        return;
      }
    }
    const hits = this.raycaster.intersectObject(this.assetGroup, true);
    const hit = hits.find((candidate) => Number.isInteger(candidate.object.userData.partIndex));
    if (!hit) return;
    const partIndex = hit.object.userData.partIndex;
    if (this.mode === 'face') {
      if (partIndex !== this.selectedPart) this._selectPart(partIndex);
      const part = this.definition.parts[partIndex];
      const faces = PART_KINDS[part.kind]?.faces || [];
      const materialIndex = hit.face?.materialIndex ?? 0;
      this.selectedFace = faces[materialIndex] || faces[0] || null;
      this._renderInspector();
      return;
    }
    if (partIndex !== this.selectedPart) this._selectPart(partIndex);
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
    this._markDirty();
    this._rebuildObject();
    this._selectPart(this.definition.parts.length - 1);
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
    this._markDirty();
    this._rebuildObject();
    this._selectPart(this.definition.parts.length - 1);
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
    this.resizeObserver.disconnect();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
    this.overlay.remove();
  }
}
