import {
  blankCustomAssetsDocument,
  customAssetsDocumentErrors,
} from '/js/custom-assets.js';

const clone = (value) => value == null ? value : structuredClone(value);

async function responseJson(response) {
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Custom assets request failed (${response.status})`);
  return payload;
}

const DEFAULT_TEXTURE_BYTES = 3 * 1024 * 1024;

function assertTextureDataUrl(name, dataUrl, maxBytes = DEFAULT_TEXTURE_BYTES) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error(`${name} is not an image`);
  // Base64 costs roughly four characters per three source bytes.
  if (dataUrl.length > Math.ceil(maxBytes * 4 / 3) + 1024) {
    throw new Error(`${name} is too large — maximum ${(maxBytes / 1024 / 1024).toFixed(0)} MB`);
  }
}

function nextId(prefix, existing) {
  let index = 1;
  for (const id of existing) {
    const match = id.match(new RegExp(`^${prefix}:(\\d+)$`));
    if (match) index = Math.max(index, Number(match[1]) + 1);
  }
  return `${prefix}:${String(index).padStart(4, '0')}`;
}

/**
 * Client-side owner of data/editor/custom-assets.json: modeled objects, their
 * uploaded textures, and world texture overrides. All edits are in-memory
 * until save() PUTs the whole document through the dev server.
 */
export class CustomAssetStore {
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.document = blankCustomAssetsDocument();
    this.loaded = false;
    this.dirty = false;
  }

  async load() {
    const payload = await responseJson(await fetch('/__hesi_editor_assets', { cache: 'no-store' }));
    const errors = customAssetsDocumentErrors(payload.document);
    if (errors.length) throw new Error(`Saved custom assets are invalid: ${errors[0]}`);
    this.document = payload.document;
    this.loaded = true;
    this.dirty = false;
    return this.document;
  }

  async save() {
    const errors = customAssetsDocumentErrors(this.document);
    if (errors.length) throw new Error(`Custom assets are invalid: ${errors[0]}`);
    const result = await responseJson(await fetch('/__hesi_editor_assets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: this.document }),
    }));
    this.dirty = false;
    this.onStatus(`Saved custom assets · ${result.path} · ${(result.bytes / 1024).toFixed(0)} KiB`);
    return result;
  }

  assets() { return Object.values(this.document.assets); }
  getAsset(id) { return this.document.assets[id] || null; }
  getTexture(id) { return this.document.textures[id] || null; }
  textures() { return Object.entries(this.document.textures).map(([id, texture]) => ({ id, ...texture })); }
  texturesById() { return this.document.textures; }
  worldTexture(slot) { return this.document.worldTextures?.[slot] || null; }

  newAssetId() { return nextId('custom', Object.keys(this.document.assets)); }

  upsertAsset(definition) {
    const id = definition.id || this.newAssetId();
    this.document.assets[id] = clone({ ...definition, id, updatedAt: new Date().toISOString() });
    this.dirty = true;
    return this.document.assets[id];
  }

  deleteAsset(id) {
    if (!this.document.assets[id]) return false;
    delete this.document.assets[id];
    this.dirty = true;
    return true;
  }

  /** Registers an uploaded image file, returning its texture id. */
  async addTextureFile(file, { maxBytes = DEFAULT_TEXTURE_BYTES } = {}) {
    if (!file || !String(file.type || '').startsWith('image/')) throw new Error(`${file?.name || 'Selected file'} is not an image`);
    if (Number(file.size) > maxBytes) throw new Error(`${file.name} is too large — maximum ${(maxBytes / 1024 / 1024).toFixed(0)} MB`);
    const dataUrl = await new Promise((resolvePromise, rejectPromise) => {
      const reader = new FileReader();
      reader.onload = () => resolvePromise(reader.result);
      reader.onerror = () => rejectPromise(new Error(`Cannot read ${file.name}`));
      reader.readAsDataURL(file);
    });
    return this.addTextureFromDataUrl(file.name, dataUrl, { maxBytes });
  }

  /** Registers an image data URL (e.g. an edited canvas), returning its texture id. */
  addTextureFromDataUrl(name, dataUrl, { maxBytes = DEFAULT_TEXTURE_BYTES } = {}) {
    assertTextureDataUrl(name, dataUrl, maxBytes);
    const id = nextId('tex', Object.keys(this.document.textures));
    this.document.textures[id] = { name: String(name || id), dataUrl };
    this.dirty = true;
    return id;
  }

  /** Replaces the image and/or name of a stored texture in place. */
  updateTexture(id, { dataUrl, name } = {}) {
    const record = this.document.textures[id];
    if (!record) return false;
    if (dataUrl !== undefined) {
      assertTextureDataUrl(record.name || id, dataUrl);
      record.dataUrl = dataUrl;
      // The embedded edit supersedes any externalized file; the dev server
      // writes a fresh content-hashed file (and url) on the next save.
      delete record.url;
    }
    if (name !== undefined) record.name = String(name);
    this.dirty = true;
    return true;
  }

  deleteTexture(id) {
    if (!this.document.textures[id]) return false;
    delete this.document.textures[id];
    for (const asset of Object.values(this.document.assets)) {
      for (const part of asset.parts || []) {
        for (const style of Object.values(part.faces || {})) {
          if (style.texture === id) delete style.texture;
        }
      }
    }
    for (const [slot, textureId] of Object.entries(this.document.worldTextures || {})) {
      if (textureId === id) delete this.document.worldTextures[slot];
    }
    this.dirty = true;
    return true;
  }

  setWorldTexture(slot, textureId, { repeat = null } = {}) {
    if (!this.document.worldTextures) this.document.worldTextures = {};
    if (textureId) {
      this.document.worldTextures[slot] = textureId;
      if (repeat && this.document.textures[textureId]) this.document.textures[textureId].repeat = repeat;
    } else {
      delete this.document.worldTextures[slot];
    }
    this.dirty = true;
  }

}
