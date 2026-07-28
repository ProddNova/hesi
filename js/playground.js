import * as THREE from 'three';
import {
  CAMERA_TUNING_FIELDS,
  cameraTuningFromDocument,
  normalizeCameraTuning,
  setDocumentCameraTuning,
} from './playground-config.js?v=391fef1c80b8';
import {
  CAR_HEADLIGHT_FIELDS,
  CAR_HITBOX_SETTING_FIELDS,
  CAR_REAR_LIGHT_FIELDS,
  carHeadlightSettings,
  carHitboxSettings,
  carRearLightSettings,
} from './car-models.js?v=391fef1c80b8';

const clamp = THREE.MathUtils.clamp;

function boxMesh(size, color, position, { name = '', rotationY = 0, material = null } = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    material || new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.04 }),
  );
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.y = rotationY;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function labelTexture(text, accent = '#ffb02e') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.fillStyle = '#07090d';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = accent;
  context.lineWidth = 8;
  context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  context.fillStyle = '#f2f0e8';
  context.font = '700 42px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeRamp(width = 7, length = 15, height = 2.4) {
  const shape = new THREE.Shape();
  shape.moveTo(-length / 2, 0);
  shape.lineTo(length / 2, height);
  shape.lineTo(length / 2, 0);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-width / 2, 0, 0);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x606872, roughness: 0.9 }));
  mesh.receiveShadow = true;
  return mesh;
}

function disposeTree(root) {
  root?.traverse?.((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((material) => {
      material.map?.dispose?.();
      material.dispose?.();
    });
  });
}

/**
 * Isolated vehicle laboratory. It owns only test geometry and an analytic
 * road adapter; the real HighwayMap remains untouched while this scene runs.
 */
export class PlaygroundSystem {
  constructor(scene) {
    this.scene = scene;
    this.active = false;
    this.root = new THREE.Group();
    this.root.name = 'HESI vehicle playground';
    this.scene.add(this.root);
    this.colliders = [];
    this.ramps = [];
    this._build();
    this.roadAdapter = {
      onRoad: true,
      getRoadInfo: (position) => this.getRoadInfo(position),
      sweep: (from, to, radius) => this.sweep(from, to, radius),
    };
  }

  _build() {
    this.scene.background = new THREE.Color(0x171b20);
    this.scene.fog = new THREE.Fog(0x171b20, 170, 440);
    this.scene.userData.hesiLightingConfig = { exposure: 1.25 };
    const hemi = new THREE.HemisphereLight(0xd9e5f4, 0x252018, 2.5);
    const key = new THREE.DirectionalLight(0xffe7c4, 2.1);
    key.position.set(-45, 80, -30);
    this.root.add(hemi, key);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.96, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    ground.name = 'Playground infinite test pad';
    this.root.add(ground);

    const grid = new THREE.GridHelper(500, 250, 0x8191a4, 0x4b535d);
    grid.position.y = 0.015;
    grid.material.transparent = true;
    grid.material.opacity = 0.66;
    this.root.add(grid);

    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 190),
      new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.92 }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.set(0, 0.025, 18);
    this.root.add(asphalt);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xd8cda8 });
    for (const x of [-5.7, 0, 5.7]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(x === 0 ? 0.13 : 0.18, 190), lineMaterial);
      line.rotation.x = -Math.PI / 2;
      line.position.set(x, 0.035, 18);
      this.root.add(line);
    }

    this._addCollider([-8, 0.7, -28], [10, 1.4, 0.7], 0x9b9b96, 'Road wall');
    this._addCollider([7, 0.6, -12], [0.8, 1.2, 13], 0xd4a025, 'Jersey barrier');
    this._addCollider([-4.2, 0.75, 18], [1.9, 1.5, 4.5], 0x334b63, 'Stopped test car');
    this._addCollider([4.8, 0.55, 9], [0.55, 1.1, 0.55], 0xf09224, 'Slalom cone A');
    this._addCollider([-4.8, 0.55, 3], [0.55, 1.1, 0.55], 0xf09224, 'Slalom cone B');
    this._addCollider([4.8, 0.55, -3], [0.55, 1.1, 0.55], 0xf09224, 'Slalom cone C');

    const ramp = makeRamp(6.5, 15, 2.4);
    ramp.position.set(-3.25, 0, 45);
    ramp.name = 'Progressive test ramp';
    this.root.add(ramp);
    this.ramps.push({ x: 0, z: 45, width: 6.5, length: 15, height: 2.4 });

    for (let index = 0; index < 4; index += 1) {
      const height = 0.12 + index * 0.08;
      this._addCollider([0, height / 2, 63 + index * 3], [12, height, 0.8], 0x59616a, `Step ${index + 1}`, false);
    }

    const wall = boxMesh([14, 3.2, 0.5], 0x22272d, [0, 1.6, 86], { name: 'Brake test wall' });
    this.root.add(wall);
    this.colliders.push({ x: 0, z: 86, width: 14, length: 0.5, rotation: 0, solid: true });

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 2),
      new THREE.MeshBasicMaterial({ map: labelTexture('HESI // PLAYGROUND'), toneMapped: false }),
    );
    sign.position.set(0, 4.2, -33);
    this.root.add(sign);
  }

  _addCollider(position, size, color, name, solid = true) {
    const mesh = boxMesh(size, color, position, { name });
    this.root.add(mesh);
    if (solid) this.colliders.push({
      x: position[0],
      z: position[2],
      width: size[0],
      length: size[2],
      rotation: 0,
      solid: true,
    });
    return mesh;
  }

  get spawn() {
    return { position: new THREE.Vector3(0, 0.62, -72), heading: 0 };
  }

  getRoadInfo(position) {
    let height = 0;
    for (const ramp of this.ramps) {
      const localZ = position.z - ramp.z;
      if (Math.abs(position.x - ramp.x) <= ramp.width * 0.5
        && localZ >= -ramp.length * 0.5 && localZ <= ramp.length * 0.5) {
        height = Math.max(height, ((localZ + ramp.length * 0.5) / ramp.length) * ramp.height);
      }
    }
    return {
      onRoad: true,
      drivable: true,
      snapHeight: true,
      height,
      point: new THREE.Vector3(position.x, height, position.z),
      center: new THREE.Vector3(position.x, height, position.z),
      heading: 0,
      surfaceGrip: 1,
      routeId: 'playground',
      routeName: 'TEST PAD',
      district: 'VEHICLE LAB',
    };
  }

  sweep(from, to, radius = 0.7) {
    for (const collider of this.colliders) {
      if (!collider.solid) continue;
      const halfX = collider.width * 0.5 + radius;
      const halfZ = collider.length * 0.5 + radius;
      const dx = to.x - collider.x;
      const dz = to.z - collider.z;
      if (Math.abs(dx) > halfX || Math.abs(dz) > halfZ) continue;
      const penetrationX = halfX - Math.abs(dx);
      const penetrationZ = halfZ - Math.abs(dz);
      const normal = penetrationX < penetrationZ
        ? new THREE.Vector3(Math.sign(dx) || 1, 0, 0)
        : new THREE.Vector3(0, 0, Math.sign(dz) || 1);
      const corrected = to.clone();
      if (penetrationX < penetrationZ) corrected.x = collider.x + normal.x * halfX;
      else corrected.z = collider.z + normal.z * halfZ;
      return { hit: true, normal, position: corrected, correctedPosition: corrected, kind: 'wall', restitution: 0.12, friction: 0.45 };
    }
    return null;
  }

  dispose() {
    disposeTree(this.root);
    this.root.removeFromParent();
  }
}

const element = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const debounce = (fn, delay = 80) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

/**
 * Test-game badge plus the playground's live tuning panel.
 */
export class PlaygroundPanel {
  constructor(game) {
    this.game = game;
    this.document = null;
    this.camera = normalizeCameraTuning();
    this.dirty = false;
    this.view = game.cameraMode || 'chase';
    this.root = document.getElementById('editor-test-tools');
    this.panel = document.getElementById('playground-panel');
    this.status = this.panel?.querySelector('[data-playground-status]');
    this.enterButton = this.root?.querySelector('[data-test-action="playground"]');
    this.panelButton = this.root?.querySelector('[data-test-action="panel"]');
    this._bind();
  }

  _bind() {
    this.enterButton?.addEventListener('click', () => {
      if (this.game.playground?.active) this.game.exitPlayground();
      else this.game.enterPlayground();
    });
    this.panelButton?.addEventListener('click', () => this.toggle());
    this.root?.querySelector('[data-test-action="dismiss"]')?.addEventListener('click', () => this.root.classList.add('is-compact'));
    this.panel?.querySelector('[data-playground-action="close"]')?.addEventListener('click', () => this.toggle(false));
    this.panel?.querySelector('[data-playground-action="save"]')?.addEventListener('click', () => this.save());
    this.panel?.querySelector('[data-playground-action="reset-camera"]')?.addEventListener('click', () => {
      this.camera = normalizeCameraTuning();
      this.game.applyPlaygroundCamera(this.camera);
      this.markDirty();
      this.render();
    });
  }

  setDocument(document) {
    this.document = document;
    this.camera = cameraTuningFromDocument(document);
    this.game.applyPlaygroundCamera(this.camera);
    this.render();
  }

  setActive(active) {
    if (this.root) this.root.dataset.scene = active ? 'playground' : 'game';
    if (this.enterButton) this.enterButton.textContent = active ? 'ESCI DAL PLAYGROUND' : 'ENTRA NEL PLAYGROUND';
    if (this.panelButton) this.panelButton.hidden = !active;
    if (!active) this.toggle(false);
  }

  toggle(force) {
    if (!this.panel) return;
    const open = force ?? this.panel.hidden;
    if (open && !this.game.playground?.active) return;
    this.panel.hidden = !open;
    if (open) this.render();
  }

  markDirty(message = 'Modifiche live non ancora salvate') {
    this.dirty = true;
    if (this.status) this.status.textContent = message;
  }

  field(label, value, options, onInput) {
    const row = element('label', 'playground-field');
    const head = element('span');
    head.append(element('b', '', label), element('output', '', `${Number(value).toFixed(options.step < 0.01 ? 3 : 2)}${options.unit ? ` ${options.unit}` : ''}`));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const next = clamp(Number(input.value), options.min, options.max);
      head.querySelector('output').textContent = `${next.toFixed(options.step < 0.01 ? 3 : 2)}${options.unit ? ` ${options.unit}` : ''}`;
      onInput(next);
    });
    row.append(head, input);
    return row;
  }

  section(title, description = '') {
    const details = document.createElement('details');
    details.className = 'playground-section';
    details.open = title === 'Camera';
    const summary = element('summary');
    summary.append(element('b', '', title), element('small', '', description));
    const body = element('div', 'playground-section-body');
    details.append(summary, body);
    return { details, body };
  }

  render() {
    const content = this.panel?.querySelector('[data-playground-content]');
    if (!content || !this.document) return;
    content.innerHTML = '';
    const cameraSection = this.section('Camera', 'Le tre visuali usano esattamente questi valori anche nel gioco');
    const tabs = element('div', 'playground-view-tabs');
    for (const view of ['chase', 'hood', 'cockpit']) {
      const button = element('button', view === this.view ? 'active' : '', view.toUpperCase());
      button.type = 'button';
      button.addEventListener('click', () => {
        this.view = view;
        this.game.setPlaygroundCameraMode(view);
        this.render();
      });
      tabs.append(button);
    }
    cameraSection.body.append(tabs);
    for (const field of CAMERA_TUNING_FIELDS[this.view]) {
      cameraSection.body.append(this.field(field.label, this.camera[this.view][field.key], field, (value) => {
        this.camera[this.view][field.key] = value;
        this.game.applyPlaygroundCamera(this.camera);
        this.markDirty();
      }));
    }
    content.append(cameraSection.details);

    const target = this.game._playerCarModelTarget();
    const hitbox = carHitboxSettings(target, this.document, this.game.getEffectiveCar());
    const hitboxSection = this.section('Hitbox auto', 'Stessi campi e limiti del Car Modeler');
    for (const field of CAR_HITBOX_SETTING_FIELDS) {
      hitboxSection.body.append(this.field(field.label, hitbox[field.key], field, (value) => {
        this.patchCar('settings', field.key, value);
      }));
    }
    content.append(hitboxSection.details);

    const headlights = carHeadlightSettings(target, this.document);
    const lightSection = this.section('Fari anteriori', 'Lenti, fascio morbido, caduta e mira del Modeler');
    const enabled = element('label', 'playground-check');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = headlights.enabled;
    enabledInput.addEventListener('change', () => this.patchCar('headlights', 'enabled', enabledInput.checked));
    enabled.append(enabledInput, element('span', '', 'Fari abilitati'));
    const color = document.createElement('input');
    color.type = 'color';
    color.value = headlights.color;
    color.addEventListener('input', debounce(() => this.patchCar('headlights', 'color', color.value), 30));
    const colorRow = element('label', 'playground-color');
    colorRow.append(element('span', '', 'Colore luce'), color);
    lightSection.body.append(enabled, colorRow);
    for (const group of ['lens', 'beam', 'aim']) {
      lightSection.body.append(element('h4', '', group === 'lens' ? 'Lenti e posizione' : group === 'beam' ? 'Fascio' : 'Mira'));
      for (const field of CAR_HEADLIGHT_FIELDS.filter((candidate) => candidate.group === group)) {
        lightSection.body.append(this.field(field.label, headlights[field.key], field, (value) => {
          this.patchCar('headlights', field.key, field.integer ? Math.round(value) : value);
        }));
      }
    }
    content.append(lightSection.details);

    const rear = carRearLightSettings(target, this.document);
    const rearSection = this.section('Luci posteriori', 'Stessi parametri del Modeler');
    for (const field of CAR_REAR_LIGHT_FIELDS) {
      rearSection.body.append(this.field(field.label, rear[field.key], field, (value) => this.patchCar('rearLights', field.key, value)));
    }
    content.append(rearSection.details);

    const visual = this.section('Immagine e movimento', 'Controlli live già presenti nel menu debug');
    const visualFields = [
      ['Luminosità fari', 'headlightBrightness', 0, 2.5, 0.05, '×'],
      ['Effetto VHS', 'vhsAmount', 0, 4, 0.05, '×'],
      ['Blur velocità', 'motionBlur', 0, 4, 0.05, '×'],
      ['Shake camera', 'cameraShake', 0, 3, 0.05, '×'],
      ['Velocità shake', 'cameraShakePace', 0, 3, 0.05, '×'],
    ];
    for (const [label, key, min, max, step, unit] of visualFields) {
      visual.body.append(this.field(label, this.game.admin[key] ?? 1, { min, max, step, unit }, (value) => {
        this.game.applyPlaygroundVisual(key, value);
        this.markDirty();
      }));
    }
    content.append(visual.details);
  }

  patchCar(section, key, value) {
    const target = this.game._playerCarModelTarget();
    if (!this.document.carModels) this.document.carModels = {};
    const previous = this.document.carModels[target] || {};
    this.document.carModels[target] = {
      ...previous,
      [section]: { ...(previous[section] || {}), [key]: value },
    };
    this.game.applyPlaygroundCarDocument(this.document, section);
    this.markDirty();
  }

  async save() {
    if (!this.document) return;
    setDocumentCameraTuning(this.document, this.camera);
    if (this.status) this.status.textContent = 'Salvataggio nel gioco…';
    try {
      const response = await fetch('/__hesi_editor_assets', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document: this.document }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      this.dirty = false;
      this.game.persist();
      if (this.status) this.status.textContent = 'Applicato al gioco · custom-assets.json aggiornato';
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('hesi-car-models');
        channel.postMessage({ type: 'reload-car-models', at: Date.now() });
        channel.close();
      }
    } catch (error) {
      if (this.status) this.status.textContent = `Salvataggio non riuscito · ${error.message}`;
    }
  }
}
