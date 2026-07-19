import * as THREE from 'three';
import { applyEntityTransform, setEntityVisible, snapshotTransform, sourceTransformFor } from '../interaction/entity-transform.js';
import {
  DEFAULT_PROJECT_PATH,
  blankProjectDocument,
  canonicalizeProjectDocument,
  serializeProjectDocument,
  validateProjectDocument,
} from './override-schema.js';
import { buildSceneDocument } from './map-builder.js';
import { applyObjectFaceStyles, clearObjectFaceStyles } from '../../../../js/custom-assets.js';

const RECENTS_KEY = 'hesi-editor:recent-projects';
const CURRENT_KEY = 'hesi-editor:current-project';
const FALLBACK_SCENE = Object.freeze({ id: 'highway', projectPath: DEFAULT_PROJECT_PATH, buildPath: 'data/editor/hesi-world-build.json', projectName: 'HESI Main World' });
const clone = (value) => value == null ? value : structuredClone(value);
// The highway scene keeps the historical un-suffixed keys so existing local
// editor state survives the multi-scene upgrade.
const sceneKey = (base, sceneId) => sceneId === 'highway' ? base : `${base}:${sceneId}`;

function normalizeProjectPath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path.startsWith('data/editor/') || !path.toLowerCase().endsWith('.json') || path.includes('..')) {
    throw new Error('Project path must be a .json file under data/editor/');
  }
  return path;
}

function autosavePath(path) {
  return path.replace(/\.json$/i, '.autosave.json');
}

function toPersistedTransform(transform) {
  if (!transform) return null;
  let rotation = transform.rotation;
  if (!rotation && transform.quaternion) {
    const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(transform.quaternion), 'XYZ');
    rotation = euler.toArray().slice(0, 3);
  }
  return {
    position: transform.position.map(Number),
    rotation: rotation.map(Number),
    scale: transform.scale.map(Number),
  };
}

function toInternalTransform(transform) {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...transform.rotation, 'XYZ'));
  return { position: [...transform.position], quaternion: quaternion.toArray(), scale: [...transform.scale] };
}

async function responseJson(response) {
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Project request failed (${response.status})`);
  return payload;
}

export class ProjectPersistence {
  constructor({ projectState, registry, assetRegistry, adapter, selection, transformManager, history, customAssetStore = null, scene = FALLBACK_SCENE, onStatus = () => {}, onProjectChange = () => {}, onRecovery = () => {} }) {
    Object.assign(this, { projectState, registry, assetRegistry, adapter, selection, transformManager, history, customAssetStore, scene, onStatus, onProjectChange, onRecovery });
    this.currentPath = scene.projectPath || DEFAULT_PROJECT_PATH;
    this.lastSavedDocument = blankProjectDocument(scene.projectName);
    this.lastSavedModifiedMs = 0;
    this.autosaveTimer = null;
  }

  entityIds() { return new Set(this.registry.list().filter((entity) => entity.generated).map((entity) => entity.id)); }

  validationOptions() {
    return {
      entityIds: this.entityIds(),
      assetIds: this.assetRegistry.ids(),
      textureIds: new Set(Object.keys(this.customAssetStore?.texturesById?.() || {})),
    };
  }

  recentProjects() {
    try { return JSON.parse(localStorage.getItem(sceneKey(RECENTS_KEY, this.scene.id)) || '[]').filter((item) => typeof item === 'string').slice(0, 8); }
    catch { return []; }
  }

  remember(path) {
    const recent = [path, ...this.recentProjects().filter((item) => item !== path)].slice(0, 8);
    try {
      localStorage.setItem(sceneKey(RECENTS_KEY, this.scene.id), JSON.stringify(recent));
      localStorage.setItem(sceneKey(CURRENT_KEY, this.scene.id), path);
    } catch { /* UI convenience state is allowed to fail without affecting disk persistence. */ }
    return recent;
  }

  initialPath() {
    const query = new URLSearchParams(window.location.search).get('project');
    if (query) return normalizeProjectPath(query);
    try { return normalizeProjectPath(localStorage.getItem(sceneKey(CURRENT_KEY, this.scene.id)) || this.currentPath); }
    catch { return this.currentPath; }
  }

  toPersistedDocument() {
    const raw = this.projectState.toJSON();
    const placedIds = new Set(raw.placedObjects.map((item) => item.id));
    const entityOverrides = {};
    for (const [id, override] of Object.entries(raw.entityOverrides || {})) {
      if (placedIds.has(id)) continue;
      const clean = {};
      if (override.transform) clean.transform = toPersistedTransform(override.transform);
      for (const key of ['visible', 'disabled', 'locked', 'name']) if (override[key] !== undefined) clean[key] = override[key];
      if (override.faceTextures && Object.keys(override.faceTextures).length) clean.faceTextures = clone(override.faceTextures);
      if (Object.keys(clean).length) entityOverrides[id] = clean;
    }
    const placedObjects = raw.placedObjects.map((placed) => ({
      id: placed.id,
      name: placed.name,
      assetId: placed.assetId,
      layer: placed.layer,
      sourceEntityId: placed.sourceEntityId,
      transform: toPersistedTransform(placed.transform),
      visible: placed.visible !== false,
      locked: Boolean(placed.locked),
      ...(placed.faceTextures && Object.keys(placed.faceTextures).length ? { faceTextures: clone(placed.faceTextures) } : {}),
    }));
    const document = {
      version: 1,
      project: { name: raw.project?.name || 'HESI Main World' },
      entityOverrides,
      placedObjects,
      groups: clone(raw.groups || []),
      editorState: clone(raw.editorState || {}),
    };
    validateProjectDocument(document, this.validationOptions());
    return canonicalizeProjectDocument(document);
  }

  async read(path) {
    const normalized = normalizeProjectPath(path);
    const response = await fetch(`/__hesi_editor_project?path=${encodeURIComponent(normalized)}`, { cache: 'no-store' });
    if (response.status === 404 || response.status === 204) return null;
    return responseJson(response);
  }

  async write(path, document) {
    const normalized = normalizeProjectPath(path);
    validateProjectDocument(document, this.validationOptions());
    return responseJson(await fetch('/__hesi_editor_project', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: normalized, document }),
    }));
  }

  applyDocument(document, { resetHistory = false } = {}) {
    validateProjectDocument(document, this.validationOptions());
    this.selection.clear('project-apply');
    this.transformManager.setSelection(null);
    const current = this.projectState.toJSON();
    const resetIds = new Set([
      ...Object.keys(current.entityOverrides || {}),
      ...this.registry.list().filter((entity) => entity.generated && entity.metadata.hasOverride).map((entity) => entity.id),
    ]);
    this.registry.batch(() => {
      for (const entity of this.registry.list().filter((item) => !item.generated)) {
        this.registry.unregister(entity.id);
        entity.object3D?.removeFromParent();
      }
      for (const id of resetIds) {
        const entity = this.registry.getById(id);
        if (!entity?.generated) continue;
        clearObjectFaceStyles(entity.object3D);
        if (entity.object3D) applyEntityTransform(entity, sourceTransformFor(entity), { visible: true });
        entity.metadata.disabled = false;
        entity.metadata.locked = false;
        entity.metadata.hasOverride = false;
        entity.metadata.faceTextures = {};
        if (entity.metadata.editorSourceName) entity.name = entity.metadata.editorSourceName;
        this.registry.update(entity.id, { name: entity.name, metadata: entity.metadata });
      }
      for (const [id, override] of Object.entries(document.entityOverrides)) {
        const entity = this.registry.getById(id);
        if (!entity) continue;
        if (entity.object3D && override.transform) applyEntityTransform(entity, toInternalTransform(override.transform), { visible: override.visible !== false && !override.disabled });
        else if (entity.object3D) setEntityVisible(entity, override.visible !== false && !override.disabled);
        entity.metadata.disabled = override.visible === false || Boolean(override.disabled);
        entity.metadata.locked = Boolean(override.locked);
        entity.metadata.hasOverride = true;
        entity.metadata.faceTextures = clone(override.faceTextures || {});
        if (override.name) entity.name = override.name;
        if (entity.object3D) applyObjectFaceStyles(entity.object3D, override.faceTextures || {}, this.customAssetStore?.texturesById?.() || {});
        this.registry.update(id, { name: entity.name, metadata: entity.metadata });
      }
      for (const placed of document.placedObjects) {
        const sourceId = this.assetRegistry.sourceEntityId(placed.assetId);
        const source = sourceId ? this.registry.getById(sourceId) : placed.assetId;
        if (!source) throw new Error(`Reusable asset source is unavailable: ${placed.assetId}`);
        const entity = this.assetRegistry.createPlacedEntity(source, { id: placed.id, name: placed.name || placed.id });
        const transform = toInternalTransform(placed.transform);
        applyEntityTransform(entity, transform, { visible: placed.visible !== false });
        entity.object3D.visible = placed.visible !== false;
        entity.metadata.disabled = placed.visible === false;
        entity.metadata.locked = Boolean(placed.locked);
        entity.metadata.initialTransform = clone(transform);
        entity.metadata.initialName = entity.name;
        entity.metadata.faceTextures = clone(placed.faceTextures || {});
        applyObjectFaceStyles(entity.object3D, placed.faceTextures || {}, this.customAssetStore?.texturesById?.() || {});
        this.registry.register(entity);
        this.adapter.registerEditorEntity(entity);
      }
    });
    this.projectState.replaceDocument(canonicalizeProjectDocument(document));
    if (resetHistory) this.history.clear();
    this.onProjectChange(this.state());
  }

  async load(path = this.initialPath(), { allowMissing = false, recover = true } = {}) {
    const normalized = normalizeProjectPath(path);
    const result = await this.read(normalized);
    if (!result) {
      if (!allowMissing) throw new Error(`Project file not found: ${normalized}`);
      this.currentPath = normalized;
      this.lastSavedDocument = blankProjectDocument(this.scene.projectName);
      this.applyDocument(this.lastSavedDocument, { resetHistory: true });
      this.history.markSaved();
      this.remember(normalized);
      this.onProjectChange(this.state());
      return null;
    }
    validateProjectDocument(result.document, this.validationOptions());
    this.currentPath = normalized;
    this.lastSavedDocument = clone(result.document);
    this.lastSavedModifiedMs = result.modifiedMs || 0;
    this.applyDocument(result.document, { resetHistory: true });
    this.history.markSaved();
    this.remember(normalized);
    let recovered = false;
    if (recover) {
      const recovery = await this.read(autosavePath(normalized)).catch(() => null);
      if (recovery && recovery.modifiedMs > this.lastSavedModifiedMs && serializeProjectDocument(recovery.document) !== serializeProjectDocument(result.document)) {
        const saved = clone(result.document);
        const autosaved = clone(recovery.document);
        this.applyDocument(autosaved, { resetHistory: true });
        this.history.execute({
          label: 'Recovered autosave',
          redo: () => this.applyDocument(autosaved),
          undo: () => this.applyDocument(saved),
        }, { alreadyApplied: true });
        this.onRecovery(`Recovered newer autosave for ${normalized}. Save to confirm or Reset Unsaved Changes to discard it.`);
        recovered = true;
      }
    }
    this.onStatus(`${recovered ? 'Recovered' : 'Loaded'} project · ${normalized}`);
    this.onProjectChange(this.state());
    return result.document;
  }

  buildDocument(document = null) {
    return buildSceneDocument({
      sceneId: this.scene.id,
      adapter: this.adapter,
      registry: this.registry,
      assetRegistry: this.assetRegistry,
      projectDocument: document || this.toPersistedDocument(),
      projectPath: this.currentPath,
    });
  }

  /** True when the playable game's generated operations match this draft. */
  async gameBuildMatches(document = null) {
    const expected = this.buildDocument(document);
    const response = await fetch(`/${this.scene.buildPath}`, { cache: 'no-store' });
    if (response.status === 404) return expected.operations.length === 0;
    if (!response.ok) return false;
    const current = await response.json().catch(() => null);
    const sameBuild = Boolean(current)
      && current.version === expected.version
      && current.scene === expected.scene
      && current.project?.path === expected.project?.path;
    if (!sameBuild) return false;
    if (current.project?.draftSignature && expected.project?.draftSignature) {
      return current.project.draftSignature === expected.project.draftSignature;
    }
    // Compatibility with builds written before draft signatures existed.
    return JSON.stringify(current.operations) === JSON.stringify(expected.operations);
  }

  async writeBuild(document = null) {
    const build = this.buildDocument(document);
    const result = await responseJson(await fetch('/__hesi_editor_build', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: this.scene.id, build }),
    }));
    return { ...result, operationCount: build.operations.length };
  }

  async save({ path = this.currentPath, name = null, markSaved = true, build = true } = {}) {
    const normalized = normalizeProjectPath(path);
    if (name?.trim()) this.projectState.updateProject({ name: name.trim() });
    // Face texture IDs live in custom-assets.json. Persist that dependency
    // before validating/writing any project, commit, or Apply-to-Game output.
    if (this.customAssetStore?.dirty) await this.customAssetStore.save();
    const document = this.toPersistedDocument();
    const result = await this.write(normalized, document);
    if (markSaved) {
      this.currentPath = normalized;
      this.lastSavedDocument = clone(document);
      this.lastSavedModifiedMs = Date.now();
      this.projectState.replaceDocument(document);
      this.history.markSaved();
      this.remember(normalized);
      await fetch(`/__hesi_editor_project?path=${encodeURIComponent(autosavePath(normalized))}`, { method: 'DELETE' }).catch(() => {});
      let buildNote = '';
      if (build) {
        // A failed build must never roll back the project save: report it and
        // leave the previous build file untouched.
        try {
          const built = await this.writeBuild(document);
          result.build = built;
          buildNote = ` · built map ${built.path} (${built.operationCount} op${built.operationCount === 1 ? '' : 's'})`;
        } catch (error) {
          buildNote = ` · map build FAILED: ${error.message}`;
        }
      }
      this.onStatus(`Saved project · ${normalized}${buildNote}`);
      this.onProjectChange(this.state());
    }
    return result;
  }

  async commit(message) {
    const trimmed = String(message || '').trim();
    if (!trimmed) throw new Error('Commit message is required');
    await this.save({ build: false });
    const document = this.toPersistedDocument();
    const payload = {
      scene: this.scene.id,
      message: trimmed,
      projectPath: this.currentPath,
      document,
      build: this.buildDocument(document),
    };
    const result = await responseJson(await fetch('/__hesi_editor_commits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }));
    this.onStatus(`Committed draft version · "${trimmed}" · ${result.commit.id} · playable game unchanged`);
    this.onProjectChange(this.state());
    return result.commit;
  }

  async listCommits() {
    const result = await responseJson(await fetch(`/__hesi_editor_commits?scene=${encodeURIComponent(this.scene.id)}`, { cache: 'no-store' }));
    return result.commits || [];
  }

  async restoreCommit(id) {
    const payload = await responseJson(await fetch(`/__hesi_editor_commits/one?scene=${encodeURIComponent(this.scene.id)}&id=${encodeURIComponent(id)}`, { cache: 'no-store' }));
    const before = this.toPersistedDocument();
    const restored = canonicalizeProjectDocument(payload.document);
    this.applyDocument(restored);
    this.history.execute({
      label: `Restore commit "${payload.meta?.message || id}"`,
      redo: () => this.applyDocument(restored),
      undo: () => this.applyDocument(before),
    }, { alreadyApplied: true });
    await this.save({ build: false });
    this.onStatus(`Restored draft · "${payload.meta?.message || id}" · use Apply to Game when ready`);
    return payload.meta || { id };
  }

  async deleteCommit(id) {
    await responseJson(await fetch(`/__hesi_editor_commits/one?scene=${encodeURIComponent(this.scene.id)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' }));
    this.onStatus(`Deleted commit · ${id}`);
    return true;
  }

  async autosave() {
    if (!this.history.dirty) return false;
    const document = this.toPersistedDocument();
    await this.write(autosavePath(this.currentPath), document);
    this.onStatus(`Autosaved recovery copy · ${autosavePath(this.currentPath)}`);
    return true;
  }

  startAutosave(intervalMs = 30000) {
    clearInterval(this.autosaveTimer);
    this.autosaveTimer = setInterval(() => this.autosave().catch((error) => this.onStatus(`Autosave failed · ${error.message}`)), intervalMs);
  }

  async resetUnsaved() {
    this.applyDocument(this.lastSavedDocument, { resetHistory: true });
    this.history.markSaved();
    await fetch(`/__hesi_editor_project?path=${encodeURIComponent(autosavePath(this.currentPath))}`, { method: 'DELETE' }).catch(() => {});
    this.onStatus(`Reset unsaved changes · ${this.currentPath}`);
  }

  resetAll() {
    const before = this.toPersistedDocument();
    const after = blankProjectDocument(before.project.name);
    this.history.execute({
      label: 'Reset all overrides',
      redo: () => this.applyDocument(after),
      undo: () => this.applyDocument(before),
    });
    this.onStatus('Reset all overrides and placed objects');
  }

  exportOverrides() {
    const projectDocument = this.toPersistedDocument();
    const blob = new Blob([serializeProjectDocument(projectDocument)], { type: 'application/json' });
    const link = window.document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${projectDocument.project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'hesi-world'}-overrides.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    this.onStatus(`Exported overrides · ${link.download}`);
  }

  state() {
    return {
      name: this.projectState.document.project.name,
      path: this.currentPath,
      recent: this.recentProjects(),
      autosavePath: autosavePath(this.currentPath),
    };
  }

  dispose() { clearInterval(this.autosaveTimer); }
}

export { autosavePath, normalizeProjectPath, toInternalTransform, toPersistedTransform };
