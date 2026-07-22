import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  WORLD_OBJECTS, WORLD_OBJECT_GROUPS, WORLD_SURFACES, WORLD_SURFACE_GROUPS,
  isDefaultWorldSurfaceStyle, textureSourceUrl, worldObjectSurfaces, worldObjectsUsingSurface,
} from '/js/custom-assets.js';
import { SurfaceStyleEditor, generatedLook, paintSurfacePreview, surfaceImage } from '../world/surface-style-editor.js';
import { buildWorldObjectPreview, previewFocusBounds, surfacePreviewGeometry } from '../world/surface-preview-geometry.js';

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

const CARD_PREVIEW = 108;

/**
 * Surfaces: the world's repeated textures and repeated objects, in one place.
 *
 * The generated map draws each material once for the whole world, so a
 * material IS an archetype — repainting `facadeOffice` repaints every office
 * building, `road` every metre of asphalt, `container` every container. This
 * section exposes that directly: pick a surface, drop an image on it, then dial
 * the tiling, shift, rotation and tint until it sits right, with the live game
 * material previewed in 3D beside the controls.
 */
export class SurfacesPanel {
  constructor({ host, store, assetRegistry, getMaterials = () => null, onStatus = () => {}, onTexturesChanged = () => {}, onWorldTexturesChanged = () => {}, onOpenChange = () => {} }) {
    Object.assign(this, { store, assetRegistry, getMaterials, onStatus, onTexturesChanged, onWorldTexturesChanged, onOpenChange });
    this.openState = false;
    this.filter = 'surface';
    this.slot = 'road';
    this.objectId = null;
    this.cards = new Map();
    this.frameId = 0;
    this.disposed = false;
    this._buildDom(host);
    this._buildScene();
  }

  get isOpen() { return this.openState; }

  // ------------------------------------------------------------------ DOM --
  _buildDom(host) {
    this.overlay = element('div', 'surfaces-overlay');
    this.overlay.hidden = true;
    this.overlay.dataset.testid = 'surfaces-overlay';

    const header = element('header', 'modeler-header');
    header.append(element('strong', '', 'Surfaces'));
    this.filterSwitch = element('div', 'segmented');
    this.filterSwitch.setAttribute('role', 'radiogroup');
    this.filterSwitch.setAttribute('aria-label', 'Surface kind');
    this.filterButtons = new Map();
    for (const [kind, label, title] of [
      ['surface', 'Repeated surfaces', 'Asphalt, barriers, guardrails, tunnels, terrain — the tiled surfaces of the world'],
      ['object', 'Repeated objects', 'Buildings, containers, lamps, signs, PA props — every copy repaints at once'],
      ['all', 'All', 'Every repaintable material in the generated map'],
    ]) {
      const node = element('button', 'seg-button', label);
      node.type = 'button';
      node.setAttribute('role', 'radio');
      node.title = title;
      node.dataset.testid = `surfaces-filter-${kind}`;
      node.addEventListener('click', () => this._setFilter(kind));
      this.filterButtons.set(kind, node);
      this.filterSwitch.append(node);
    }
    header.append(this.filterSwitch);
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'surfaces-search';
    this.searchInput.placeholder = 'Find a surface…';
    this.searchInput.setAttribute('aria-label', 'Find a surface');
    this.searchInput.addEventListener('input', () => this._renderCards());
    header.append(this.searchInput);
    this.dirtyChip = element('span', 'modeler-dirty', '');
    this.saveButton = button('Save', 'tool-button accent', 'Write the surface overrides to disk — the editor and the playable game both pick them up');
    this.saveButton.dataset.testid = 'surfaces-save';
    this.saveButton.addEventListener('click', () => this._save());
    this.closeButton = button('Close ✕', 'tool-button', 'Back to the map editor');
    this.closeButton.dataset.testid = 'surfaces-close';
    this.closeButton.addEventListener('click', () => this.close());
    header.append(this.dirtyChip, element('span', 'toolbar-spacer'), this.saveButton, this.closeButton);

    const body = element('div', 'surfaces-body');
    const left = element('section', 'surfaces-catalog');
    this.cardHost = element('div', 'surfaces-card-host');
    this.cardHost.dataset.testid = 'surfaces-cards';
    left.append(this.cardHost);

    const right = element('aside', 'surfaces-inspector');
    this.previewHost = element('div', 'surfaces-3d');
    this.previewHost.dataset.testid = 'surfaces-3d';
    right.append(this.previewHost);
    const previewBar = element('div', 'surfaces-3d-bar');
    this.previewLabel = element('small', '', '');
    this.lightingButton = button('☀ Bright', 'tool-button small', 'Toggle between bright inspection light and the game night light');
    this.lightingButton.setAttribute('aria-pressed', 'true');
    this.lightingButton.addEventListener('click', () => this._setBrightPreview(!this.brightPreview));
    previewBar.append(this.previewLabel, element('span', 'toolbar-spacer'), this.lightingButton);
    right.append(previewBar);
    this.controlHost = element('div', 'surfaces-controls');
    this.controlHost.dataset.testid = 'surfaces-controls';
    right.append(this.controlHost);

    body.append(left, right);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.hidden = true;

    this.overlay.append(header, body, this.fileInput);
    host.append(this.overlay);

    this.styleEditor = new SurfaceStyleEditor({
      host: this.controlHost,
      store: this.store,
      getMaterial: (slot) => this.getMaterials()?.[slot] || null,
      onStatus: (message) => this.onStatus(message),
      pickTexture: (title, useTexture) => this._chooseTexture(title, useTexture),
      onChange: () => {
        this.onWorldTexturesChanged();
        this._markDirty();
        this._refreshCard(this.slot);
      },
    });
  }

  // ---------------------------------------------------------------- scene --
  _buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1319);
    this.camera = new THREE.PerspectiveCamera(45, 1.6, 0.05, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.previewHost.append(this.renderer.domElement);

    this.previewAmbient = new THREE.AmbientLight(0xcfdcea, 0.6);
    this.previewKey = new THREE.DirectionalLight(0xffffff, 1.5);
    this.previewKey.position.set(6, 12, 8);
    this.previewFill = new THREE.HemisphereLight(0xd7e5f7, 0x2a3038, 0.7);
    this.scene.add(this.previewAmbient, this.previewKey, this.previewFill);
    this.brightPreview = true;

    this.previewGroup = new THREE.Group();
    this.scene.add(this.previewGroup);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;

    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(this.previewHost);
  }

  _setBrightPreview(bright) {
    this.brightPreview = bright;
    this.lightingButton.textContent = bright ? '☀ Bright' : '🌙 Night';
    this.lightingButton.setAttribute('aria-pressed', String(bright));
    this.previewAmbient.intensity = bright ? 0.6 : 0.12;
    this.previewKey.intensity = bright ? 1.5 : 0.25;
    this.previewFill.intensity = bright ? 0.7 : 0.16;
    this.scene.background.set(bright ? 0x0e1319 : 0x04060a);
    this.onStatus(bright ? 'Preview lit for inspection' : 'Preview lit like the night game — emissive surfaces show their real glow');
  }

  _resize() {
    const width = Math.max(1, this.previewHost.clientWidth);
    const height = Math.max(1, this.previewHost.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  _renderLoop = () => {
    if (this.disposed || !this.openState) return;
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this._renderLoop);
  };

  /** Rebuilds the 3D preview around the selected surface's live material. */
  _rebuildPreview() {
    this.previewGroup.clear();
    const meta = WORLD_SURFACES[this.slot];
    if (!meta) return;
    const materials = this.getMaterials();
    const material = materials?.[this.slot] || null;
    let radius = 6;
    // An object surface previews on the whole object it belongs to (mast plus
    // head, body plus glass); a bare infrastructure surface previews alone.
    const objectMeshes = this.objectId
      ? buildWorldObjectPreview(this.objectId, { materials, assetRegistry: this.assetRegistry })
      : [];
    if (objectMeshes.length) {
      for (const mesh of objectMeshes) this.previewGroup.add(mesh);
    } else if (material) {
      const geometry = surfacePreviewGeometry(meta.preview);
      geometry.computeBoundingBox();
      const mesh = new THREE.Mesh(geometry, material);
      // Stand the volume on the ground plane rather than centring it in space.
      if (meta.preview !== 'road') mesh.position.y = -(geometry.boundingBox?.min?.y ?? 0);
      this.previewGroup.add(mesh);
    } else {
      this.previewLabel.textContent = 'No live map material — open the highway scene to preview in 3D';
      return;
    }
    const bounds = previewFocusBounds(this.previewGroup);
    if (!bounds.isEmpty()) {
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      radius = Math.max(1.2, size.length() * (!objectMeshes.length && meta.preview === 'road' ? 0.45 : 0.75));
      this.orbit.target.copy(center);
      this.camera.position.set(center.x + radius * 0.9, center.y + radius * 0.7, center.z + radius * 1.1);
      this.camera.near = Math.max(0.02, radius / 400);
      this.camera.far = radius * 60;
      this.camera.updateProjectionMatrix();
      this.orbit.update();
    }
    const objectLabel = objectMeshes.length ? WORLD_OBJECTS[this.objectId].label : '';
    this.previewLabel.textContent = objectMeshes.length
      ? `${objectLabel}${objectLabel === meta.label ? '' : ` · editing ${meta.label}`} · live materials`
      : `${meta.label} · ${meta.preview === 'road' ? '48 m of surface at true world tiling' : 'representative volume, live material'}`;
  }

  // ------------------------------------------------------------ rendering --
  _setFilter(kind) {
    this.filter = kind;
    for (const [key, node] of this.filterButtons) node.setAttribute('aria-checked', String(key === kind));
    this._renderCards();
  }

  _matches(text) {
    const query = this.searchInput.value.trim().toLowerCase();
    return !query || text.toLowerCase().includes(query);
  }

  /**
   * The repeated-object tabs group by OBJECT, not by material: a lamp is its
   * mast and its head, a parked car its body and its glass. Every surface of
   * the object gets its own card so all of them are reachable.
   */
  _visibleObjectGroups() {
    return WORLD_OBJECT_GROUPS
      .map((entry) => ({
        group: entry.group,
        objects: entry.objects
          .map((objectId) => ({
            objectId,
            meta: WORLD_OBJECTS[objectId],
            slots: worldObjectSurfaces(objectId),
          }))
          .filter(({ objectId, meta, slots }) => this._matches(
            `${meta.label} ${meta.description} ${objectId} ${slots.map((slot) => WORLD_SURFACES[slot].label).join(' ')}`,
          )),
      }))
      .filter((entry) => entry.objects.length);
  }

  _visibleGroups() {
    return WORLD_SURFACE_GROUPS
      .map((entry) => ({
        ...entry,
        slots: entry.slots.filter((slot) => {
          const meta = WORLD_SURFACES[slot];
          if (this.filter !== 'all' && meta.kind !== this.filter) return false;
          return this._matches(`${meta.label} ${meta.description} ${slot}`);
        }),
      }))
      .filter((entry) => entry.slots.length);
  }

  _renderCards() {
    this.cardHost.innerHTML = '';
    this.cards.clear();
    if (this.filter === 'object') {
      const groups = this._visibleObjectGroups();
      if (!groups.length) {
        this.cardHost.append(element('p', 'modeler-help', 'Nothing matches that search.'));
        return;
      }
      for (const entry of groups) {
        this.cardHost.append(element('h3', '', entry.group));
        // One block per object, blocks tiled across the width — an object with
        // a single surface must not claim a whole row of its own.
        const blocks = element('div', 'surfaces-object-list');
        for (const { objectId, meta, slots } of entry.objects) {
          const block = element('div', 'surfaces-object-block');
          block.dataset.testid = `surface-object-${objectId}`;
          const head = element('div', 'surfaces-object-head');
          head.append(element('b', '', meta.label));
          head.append(element('small', '', slots.length === 1
            ? meta.description
            : `${meta.description} · ${slots.length} surfaces`));
          block.append(head);
          const grid = element('div', 'surfaces-grid');
          for (const slot of slots) grid.append(this._buildCard(slot, objectId));
          block.append(grid);
          blocks.append(block);
        }
        this.cardHost.append(blocks);
      }
      return;
    }
    const groups = this._visibleGroups();
    if (!groups.length) {
      this.cardHost.append(element('p', 'modeler-help', 'Nothing matches that search.'));
      return;
    }
    for (const entry of groups) {
      this.cardHost.append(element('h3', '', entry.group));
      const grid = element('div', 'surfaces-grid');
      for (const slot of entry.slots) grid.append(this._buildCard(slot));
      this.cardHost.append(grid);
    }
  }

  _buildCard(slot, objectId = null) {
    const meta = WORLD_SURFACES[slot];
    const card = element('button', `surface-card${slot === this.slot ? ' selected' : ''}`);
    card.type = 'button';
    card.dataset.testid = `surface-card-${slot}`;
    const shared = worldObjectsUsingSurface(slot);
    card.title = shared.length > 1
      ? `${meta.description}. Shared with: ${shared.map((id) => WORLD_OBJECTS[id].label).join(', ')} — painting it changes all of them.`
      : meta.description;
    const canvas = document.createElement('canvas');
    canvas.width = CARD_PREVIEW;
    canvas.height = CARD_PREVIEW;
    canvas.className = 'surface-card-preview';
    card.append(canvas);
    const label = element('span', 'surface-card-label', meta.label);
    card.append(label);
    const chip = element('span', 'surface-card-chip', '');
    card.append(chip);
    card.addEventListener('click', () => this.select(slot, objectId));
    this.cards.set(slot, { card, canvas, chip });
    this._refreshCard(slot);
    return card;
  }

  _refreshCard(slot) {
    const entry = this.cards.get(slot);
    if (!entry) return;
    const style = this.store.worldSurface(slot);
    const record = style.texture ? this.store.getTexture(style.texture) : null;
    const image = record ? surfaceImage(record, () => this._refreshCard(slot)) : null;
    paintSurfacePreview(entry.canvas, style, image, { generated: generatedLook(this.getMaterials()?.[slot]) });
    const custom = !isDefaultWorldSurfaceStyle(style);
    entry.chip.textContent = custom ? 'Custom' : '';
    entry.chip.classList.toggle('is-custom', custom);
    entry.card.classList.toggle('selected', slot === this.slot);
  }

  _refreshAllCards() { for (const slot of this.cards.keys()) this._refreshCard(slot); }

  select(slot, objectId = null) {
    if (!WORLD_SURFACES[slot]) return;
    const previous = this.slot;
    this.slot = slot;
    // Preview the whole object the surface belongs to when there is one, so a
    // lamp head is shown on its mast rather than floating on its own.
    this.objectId = objectId || worldObjectsUsingSurface(slot)[0] || null;
    this._refreshCard(previous);
    this._refreshCard(slot);
    this.styleEditor.setSlot(slot);
    this._rebuildPreview();
  }

  _markDirty() {
    this.dirtyChip.textContent = this.store.dirty ? 'Unsaved changes' : '';
  }

  // ----------------------------------------------------------- open/close --
  open(slot = undefined) {
    this.openState = true;
    this.overlay.hidden = false;
    if (slot && WORLD_SURFACES[slot]) {
      this.filter = WORLD_SURFACES[slot].kind;
      this.slot = slot;
    }
    this._setFilter(this.filter);
    this.select(this.slot);
    this._markDirty();
    this._resize();
    cancelAnimationFrame(this.frameId);
    this.frameId = requestAnimationFrame(this._renderLoop);
    this.onOpenChange(true);
    this.onStatus('Surfaces · pick a material, drop an image on it, then dial the tiling — every copy in the world follows');
  }

  close() {
    this.openState = false;
    this.overlay.hidden = true;
    cancelAnimationFrame(this.frameId);
    this.onOpenChange(false);
  }

  /** Re-reads the store after an outside change (texture deleted, project reloaded). */
  refresh() {
    this._refreshAllCards();
    this.styleEditor.refresh();
    this._markDirty();
  }

  // ------------------------------------------------------------- textures --
  _chooseTexture(title, useTexture) {
    const textures = this.store.textures();
    if (!textures.length) { this._pickImage(useTexture); return; }
    const chooser = element('div', 'modeler-chooser');
    chooser.dataset.testid = 'surfaces-chooser';
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
        this.onTexturesChanged();
        onReady(textureId);
      } catch (error) {
        this.onStatus(`Texture upload failed · ${error.message}`);
      }
    };
    this.fileInput.click();
  }

  async _save() {
    try {
      await this.store.save();
      this._markDirty();
      this.onStatus('Surfaces saved · reload the game to see them there');
    } catch (error) {
      this.onStatus(`Save failed · ${error.message}`);
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.renderer?.dispose();
  }
}
