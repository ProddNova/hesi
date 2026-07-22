import { normalizeSkyboxConfig, SKYBOX_DEFAULTS } from '../../../../js/skybox-config.js';

const clone = (value) => value == null ? value : structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class SkyboxController {
  constructor({
    viewport,
    projectState,
    history,
    store,
    onChange = () => {},
    onTexturesChanged = () => {},
    onStatus = () => {},
  }) {
    Object.assign(this, { viewport, projectState, history, store, onChange, onTexturesChanged, onStatus });
    this.unsubscribe = projectState.subscribe((change) => {
      if (change.type === 'skybox' || change.type === 'document-replace') this.refresh();
    });
    this.refresh();
  }

  state() {
    const stored = this.projectState.getSkybox();
    const config = normalizeSkyboxConfig(stored || { enabled: false });
    return {
      configured: Boolean(stored),
      config,
      texture: config.texture ? this.store.getTexture(config.texture) : null,
    };
  }

  refresh() {
    const state = this.state();
    this.viewport.setSkybox(state.config, this.store.texturesById());
    this.onChange(state);
    return state;
  }

  replace(next, label = 'Edit skybox') {
    const before = this.projectState.getSkybox();
    const after = next == null ? null : normalizeSkyboxConfig(next);
    if (same(before, after)) return false;
    this.history.execute({
      label,
      redo: () => this.projectState.replaceSkybox(after),
      undo: () => this.projectState.replaceSkybox(before),
    });
    return true;
  }

  update(patch, label = 'Edit skybox') {
    const current = normalizeSkyboxConfig(this.projectState.getSkybox() || SKYBOX_DEFAULTS);
    return this.replace({ ...current, ...clone(patch) }, label);
  }

  setTexture(texture) {
    if (texture && !this.store.getTexture(texture)) throw new Error(`Skybox image is unavailable: ${texture}`);
    return this.update({ texture: texture || null, enabled: Boolean(texture) }, texture ? 'Choose skybox image' : 'Clear skybox image');
  }

  async upload(file) {
    const texture = await this.store.addTextureFile(file, { maxBytes: 24 * 1024 * 1024 });
    this.onTexturesChanged();
    this.update({ texture, enabled: true }, `Upload skybox ${file.name}`);
    this.onStatus(`Skybox image loaded · ${file.name} · use a 2:1 panorama for a seamless 360° result`);
    return texture;
  }

  resetPlacement() {
    const current = normalizeSkyboxConfig(this.projectState.getSkybox() || SKYBOX_DEFAULTS);
    return this.replace({
      ...SKYBOX_DEFAULTS,
      texture: current.texture,
      enabled: current.enabled,
      rotation: [...SKYBOX_DEFAULTS.rotation],
      offset: [...SKYBOX_DEFAULTS.offset],
    }, 'Reset skybox placement');
  }

  remove() { return this.replace(null, 'Remove skybox'); }

  dispose() { this.unsubscribe?.(); }
}

