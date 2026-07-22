import * as THREE from 'three';
import { PART_KINDS, WORLD_OBJECTS, WORLD_SURFACES } from '/js/custom-assets.js';

/**
 * Representative geometry for a world surface that has no reusable catalog
 * asset behind it (merged chunk buckets: facades, roofs, tunnel walls, ...).
 *
 * The generated map gives every non-road quad plain 0..1 UVs (see _pushQuad in
 * js/map.js), which is exactly what these primitives carry — so a texture
 * previewed here tiles the way it will out in the world. Road surfaces are the
 * exception: they are UV-anchored to world coordinates at one tile per 12 m,
 * reproduced below.
 */
export function surfacePreviewGeometry(kind) {
  switch (kind) {
    case 'road': {
      const geometry = new THREE.PlaneGeometry(48, 48, 1, 1);
      geometry.rotateX(-Math.PI / 2);
      const uv = geometry.getAttribute('uv');
      const position = geometry.getAttribute('position');
      for (let i = 0; i < uv.count; i += 1) uv.setXY(i, position.getX(i) / 12, position.getZ(i) / 12);
      uv.needsUpdate = true;
      return geometry;
    }
    case 'wall': return new THREE.BoxGeometry(6, 1.2, 0.4);
    case 'pillar': return new THREE.BoxGeometry(1.6, 8, 1.6);
    case 'building': return new THREE.BoxGeometry(9, 16, 9);
    case 'container': return new THREE.BoxGeometry(6, 2.6, 2.4);
    case 'panel': default: return new THREE.BoxGeometry(4, 2, 0.25);
  }
}

/**
 * Builds a world object's preview: the catalog's real geometry when it exists
 * (a lamp, a barrier segment, a konbini), otherwise the composite boxes the
 * object declares. Either way every mesh carries the LIVE map material of its
 * surface, so the preview is the thing being edited — and `userData.surfaceSlot`
 * lets a click in the viewport select the surface it landed on.
 *
 * Returns the meshes to add; the caller owns the parent group.
 */
export function buildWorldObjectPreview(objectId, { materials = null, assetRegistry = null } = {}) {
  const entry = WORLD_OBJECTS[objectId];
  if (!entry) return [];
  const meshes = [];
  const asset = entry.assetId ? assetRegistry?.get?.(entry.assetId) : null;
  if (asset?.components?.length) {
    // Which slot a catalog mesh belongs to is decided by the material it
    // actually carries, not by its position in the component list — a lamp
    // ships its mast, its head, and two additive glow decals.
    const slotByMaterial = new Map();
    for (const [slot, material] of Object.entries(materials || {})) {
      if (!slotByMaterial.has(material)) slotByMaterial.set(material, slot);
    }
    const objectSlots = new Set(entry.parts.map((part) => part.slot));
    const baseInverse = asset.baseWorldMatrix.clone().invert();
    for (const component of asset.components) {
      const mesh = new THREE.Mesh(component.geometry, component.material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.multiplyMatrices(baseInverse, component.sourceWorldMatrix);
      const slot = slotByMaterial.get(component.material);
      mesh.userData.surfaceSlot = objectSlots.has(slot) ? slot : null;
      // Glow decals belong in the picture but never in the framing: a lamp's
      // light streak is 40 m wide and would shrink the lamp to a speck.
      mesh.userData.previewDecoration = !mesh.userData.surfaceSlot;
      meshes.push(mesh);
    }
    return meshes;
  }
  for (const part of entry.parts) {
    const material = materials?.[part.slot];
    if (!material) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...part.size), material);
    mesh.position.set(...part.position);
    mesh.userData.surfaceSlot = part.slot;
    meshes.push(mesh);
  }
  return meshes;
}

/**
 * Bounds to frame a preview on: the object itself, with additive glow decals
 * left out. Falls back to the whole group when everything is decoration.
 */
export function previewFocusBounds(group) {
  const solid = new THREE.Box3();
  let found = false;
  group.traverse((child) => {
    if (!child.isMesh || child.userData.previewDecoration) return;
    solid.expandByObject(child);
    found = true;
  });
  return found ? solid : new THREE.Box3().setFromObject(group);
}

/**
 * The image a surface is currently wearing, as a texture-library id.
 *
 * A surface either carries the user's own override image — already a library
 * entry — or the generator's own texture, which is a 256×256 canvas built at
 * runtime (the lit window grids of the facades, the chevron board) and belongs
 * to no library at all. Those are baked into the library on demand, once,
 * keyed by name, so an object opened in the modeler looks like the thing it
 * came from instead of a white box — and the picture is then editable like any
 * other uploaded image.
 */
function surfaceTextureId(slot, label, material, store) {
  if (!store) return null;
  const override = store.worldSurface(slot).texture;
  if (override && store.getTexture(override)) return override;
  const image = material?.userData?.hesiGeneratedLook?.map?.image || material?.map?.image;
  if (!image?.width) return null;
  const name = `Generated · ${label}`;
  const existing = store.textures().find((texture) => texture.name === name);
  if (existing) return existing.id;
  try {
    const canvas = image instanceof HTMLCanvasElement ? image : (() => {
      const copy = document.createElement('canvas');
      copy.width = image.naturalWidth || image.width;
      copy.height = image.naturalHeight || image.height;
      copy.getContext('2d').drawImage(image, 0, 0);
      return copy;
    })();
    return store.addTextureFromDataUrl(name, canvas.toDataURL('image/png'));
  } catch {
    return null; // cross-origin image, or a canvas the browser refuses to read
  }
}

/**
 * Editable parts for "Edit as model": the object's composite boxes converted
 * into modeler primitives, wearing the same textures and colours the surfaces
 * wear in the world. Used where the catalog has no real geometry to hand over.
 */
export function worldObjectModelParts(objectId, materials = null, { store = null } = {}) {
  const entry = WORLD_OBJECTS[objectId];
  if (!entry) return [];
  return entry.parts.map((part, index) => {
    const material = materials?.[part.slot];
    const surface = WORLD_SURFACES[part.slot];
    const generated = material?.userData?.hesiGeneratedLook?.color;
    const color = generated || (material?.color?.getHexString ? `#${material.color.getHexString()}` : '#9aa7b5');
    const texture = surfaceTextureId(part.slot, surface?.label || part.slot, material, store);
    const faces = {};
    if (texture) {
      // Every side of the volume wears it, the way the generator wraps a
      // building box; a white base keeps the picture from being tinted dark.
      for (const face of PART_KINDS.box.faces) faces[face] = { texture };
    }
    return {
      kind: 'box',
      name: `${surface?.label || part.slot}${entry.parts.filter((other) => other.slot === part.slot).length > 1 ? ` ${index + 1}` : ''}`,
      position: [...part.position],
      rotation: [0, 0, 0],
      scale: [...part.size],
      color: texture ? '#ffffff' : color,
      faces,
    };
  });
}
