import * as THREE from 'three';
import { textureSourceUrl } from './custom-assets.js';
import { normalizeSkyboxConfig } from './skybox-config.js';

const clampTextureSize = (texture, maximum) => {
  const image = texture.image;
  const width = image?.naturalWidth || image?.videoWidth || image?.width || 0;
  const height = image?.naturalHeight || image?.videoHeight || image?.height || 0;
  if (!maximum || !width || !height || Math.max(width, height) <= maximum || typeof document === 'undefined') return;
  const scale = maximum / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  texture.image = canvas;
};

/**
 * One camera-centred inverted sphere. It is a visual environment only: it is
 * not registered as world geometry, never participates in collision/raycast
 * data, and follows whichever camera renders the scene, so it cannot be
 * reached regardless of how far the player drives.
 */
export class SkyboxRenderer {
  constructor(scene, { maxTextureSize = 4096, onError = () => {} } = {}) {
    this.scene = scene;
    this.maxTextureSize = maxTextureSize;
    this.onError = onError;
    this.mesh = null;
    this.texture = null;
    this.source = null;
    this.pendingSource = null;
    this.config = normalizeSkyboxConfig({ enabled: false });
    this.loadToken = 0;
  }

  _ensureMesh() {
    if (this.mesh) return this.mesh;
    const geometry = new THREE.SphereGeometry(1, 64, 32);
    // Reverse the geometry so ordinary front-face rendering is visible from
    // inside and the panorama reads in the expected direction.
    geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: false,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'HESI infinite skybox';
    mesh.renderOrder = -100000;
    mesh.frustumCulled = false;
    mesh.userData.editorHelper = true;
    mesh.userData.skybox = true;
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      mesh.position.setFromMatrixPosition(camera.matrixWorld);
      mesh.scale.setScalar(Math.max(10, camera.far * 0.92));
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
    };
    mesh.visible = false;
    this.scene.add(mesh);
    this.mesh = mesh;
    return mesh;
  }

  _applyAppearance() {
    if (!this.mesh) return;
    const { rotation, intensity } = this.config;
    this.mesh.rotation.set(rotation[0], rotation[1], rotation[2], 'YXZ');
    this.mesh.material.color.setRGB(intensity, intensity, intensity);
    if (this.texture) {
      const repeat = 1 / this.config.zoom;
      const repeatX = (this.config.flipX ? -1 : 1) * repeat;
      this.texture.repeat.set(repeatX, repeat);
      this.texture.offset.set(
        (1 - repeat) * 0.5 + this.config.offset[0] + (this.config.flipX ? repeat : 0),
        (1 - repeat) * 0.5 + this.config.offset[1],
      );
      this.texture.needsUpdate = true;
    }
    this.mesh.visible = Boolean(this.config.enabled && this.texture);
  }

  set(config, texturesById = {}) {
    this.config = normalizeSkyboxConfig(config);
    const mesh = this._ensureMesh();
    const record = this.config.texture ? texturesById?.[this.config.texture] : null;
    const source = textureSourceUrl(record);
    if (!this.config.enabled || !source) {
      this.loadToken += 1;
      mesh.visible = false;
      if (this.config.enabled && this.config.texture && !source) this.onError(`Skybox image is unavailable: ${this.config.texture}`);
      return false;
    }
    if (source === this.source && this.texture) {
      this._applyAppearance();
      return true;
    }
    if (source === this.pendingSource) return true;
    if (typeof document === 'undefined') return false;
    const token = ++this.loadToken;
    this.pendingSource = source;
    const pending = new THREE.TextureLoader().load(source, (loaded) => {
      if (token !== this.loadToken) { loaded.dispose(); return; }
      this.pendingSource = null;
      const previous = this.texture;
      clampTextureSize(loaded, this.maxTextureSize);
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.wrapS = THREE.RepeatWrapping;
      loaded.wrapT = THREE.ClampToEdgeWrapping;
      loaded.magFilter = THREE.LinearFilter;
      loaded.minFilter = THREE.LinearMipmapLinearFilter;
      loaded.generateMipmaps = true;
      loaded.needsUpdate = true;
      this.texture = loaded;
      this.source = source;
      mesh.material.map = loaded;
      mesh.material.needsUpdate = true;
      if (previous && previous !== loaded) previous.dispose();
      this._applyAppearance();
    }, undefined, () => {
      if (token !== this.loadToken) return;
      this.pendingSource = null;
      mesh.visible = false;
      this.onError(`Could not load skybox image: ${record?.name || this.config.texture}`);
    });
    // TextureLoader returns immediately; keep the old panorama visible until
    // the replacement has decoded, avoiding a black flash while editing.
    if (!this.texture) mesh.visible = false;
    pending.name = `Skybox · ${record?.name || this.config.texture}`;
    return true;
  }

  clear() {
    this.loadToken += 1;
    this.source = null;
    this.pendingSource = null;
    this.texture?.dispose();
    this.texture = null;
    if (this.mesh) {
      this.mesh.material.map = null;
      this.mesh.material.needsUpdate = true;
      this.mesh.visible = false;
    }
  }

  dispose() {
    this.clear();
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
  }
}
