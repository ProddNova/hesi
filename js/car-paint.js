import * as THREE from 'three';
import { textureFromSource, textureSourceUrl } from './custom-assets.js?v=86ad4259812b';

/**
 * Body paint applied to a finished car visual.
 *
 * A car body is never one material in one mesh: the PSX pack maps several OBJ
 * groups onto one shared `psxBody` material, and a Modeler replacement splits
 * the very same body across as many mesh parts as the document vertex limit
 * needs (each carrying its own `psxBody` face). Painting the body therefore has
 * to be a pass over the built object rather than a value handed to one
 * constructor — otherwise half a car changes colour and the other half does
 * not, which is exactly what the per-part "Base colour" picker produced.
 *
 * The same argument applies twice over to an image. Attaching one per face
 * hands every part its own UV rectangle, so a picture "spread over the car"
 * arrives as a different crop on every panel — the bug this module's wrap path
 * exists to remove. `applyCarPaint` instead projects ONE set of coordinates
 * from the whole body's bounding box and gives every body material the same
 * texture through it, so the image lands on the car rather than on the parts.
 */

// Matches the shared PSX body material ('psxBody') and the material the custom
// asset builder names after a face ('custom:mesh:psxBody').
const BODY_MATERIAL_NAME = /(^|:)(psxbody|body|carrozzeria)$/i;

// The projected coordinates go into their own attribute rather than over the
// mesh's `uv`: the stock UVs still drive anything else the material samples,
// and removing the wrap restores the original mapping with no geometry rebuild.
const WRAP_UV_ATTRIBUTE = 'uv1';
const WRAP_UV_CHANNEL = 1;

// A glossy material without something to reflect still reads as matte. This
// compact night/garage environment keeps reflections broad and readable in
// every scene without adding lights or a per-frame reflection probe.
let fallbackPaintEnvironment = null;

function paintEnvironmentFallback() {
  if (fallbackPaintEnvironment || typeof document === 'undefined') return fallbackPaintEnvironment;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const sky = context.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, '#05090f');
  sky.addColorStop(0.36, '#13263b');
  sky.addColorStop(0.54, '#372116');
  sky.addColorStop(0.62, '#120b08');
  sky.addColorStop(1, '#020304');
  context.fillStyle = sky;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Long soft sources make the body curvature legible, like garage strip
  // lights and the rows of sodium lamps on the highway.
  const strips = [
    [8, 45, 5, 47, 'rgba(255,185,100,.88)'],
    [38, 31, 3, 62, 'rgba(180,220,255,.72)'],
    [74, 49, 8, 38, 'rgba(255,137,54,.95)'],
    [118, 25, 4, 67, 'rgba(235,247,255,.92)'],
    [157, 43, 7, 46, 'rgba(255,164,72,.9)'],
    [203, 29, 3, 64, 'rgba(180,220,255,.8)'],
    [235, 48, 9, 39, 'rgba(255,132,46,.92)'],
  ];
  context.save();
  context.globalCompositeOperation = 'screen';
  context.shadowBlur = 8;
  for (const [x, y, width, height, color] of strips) {
    context.fillStyle = color;
    context.shadowColor = color;
    context.fillRect(x, y, width, height);
  }
  context.restore();

  const horizon = context.createLinearGradient(0, 59, 0, 77);
  horizon.addColorStop(0, 'rgba(255,184,96,0)');
  horizon.addColorStop(0.5, 'rgba(255,184,96,.62)');
  horizon.addColorStop(1, 'rgba(255,184,96,0)');
  context.fillStyle = horizon;
  context.fillRect(0, 59, canvas.width, 18);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'HESI car-paint reflection fallback';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  fallbackPaintEnvironment = texture;
  return texture;
}

export function isCarBodyMaterial(material, mesh = null) {
  if (!material) return false;
  if (mesh?.userData?.hesiTrafficPartRole === 'body') return true;
  return BODY_MATERIAL_NAME.test(String(material.name || ''));
}

/**
 * Connects every physical body coat under `root` to an optional panorama.
 * Passing null restores the built-in night/garage reflection environment.
 */
export function applyCarPaintEnvironment(root, environment = null, intensity = 1) {
  if (!root) return 0;
  const texture = environment?.isTexture ? environment : paintEnvironmentFallback();
  const level = THREE.MathUtils.clamp(Number(intensity) || 0, 0, 4);
  // Do not let a deliberately dim visual skybox erase all paint reflections:
  // camera exposure and reflection exposure are different photographic jobs.
  const panoramaResponse = environment ? Math.max(0.55, Math.sqrt(level)) : 1;
  let touched = 0;
  const visited = new Set();
  root.traverse((child) => {
    if (!child.isMesh && !child.isInstancedMesh) return;
    for (const material of (Array.isArray(child.material) ? child.material : [child.material])) {
      if (!material?.userData?.hesiCarPaint || visited.has(material)) continue;
      visited.add(material);
      const nextIntensity = (material.userData.hesiCarPaintReflectionStrength || 1) * panoramaResponse;
      const changed = material.envMap !== texture;
      material.envMap = texture;
      material.envMapIntensity = nextIntensity;
      if (changed) material.needsUpdate = true;
      touched += 1;
    }
  });
  return touched;
}

function installRoadLightResponse(material) {
  const state = {
    position0: new THREE.Vector3(),
    position1: new THREE.Vector3(),
    color0: new THREE.Color(0x000000),
    color1: new THREE.Color(0x000000),
    range0: { value: 0 },
    range1: { value: 0 },
  };
  material.userData.hesiCarPaintLightUniforms = state;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hesiPaintLightPosition0 = { value: state.position0 };
    shader.uniforms.hesiPaintLightPosition1 = { value: state.position1 };
    shader.uniforms.hesiPaintLightColor0 = { value: state.color0 };
    shader.uniforms.hesiPaintLightColor1 = { value: state.color1 };
    shader.uniforms.hesiPaintLightRange0 = state.range0;
    shader.uniforms.hesiPaintLightRange1 = state.range1;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>
        uniform vec3 hesiPaintLightPosition0;
        uniform vec3 hesiPaintLightPosition1;
        uniform vec3 hesiPaintLightColor0;
        uniform vec3 hesiPaintLightColor1;
        uniform float hesiPaintLightRange0;
        uniform float hesiPaintLightRange1;`)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
        vec3 hesiPaintVector0 = (viewMatrix * vec4(hesiPaintLightPosition0, 1.0)).xyz - geometryPosition;
        float hesiPaintDistance0 = length(hesiPaintVector0);
        float hesiPaintFalloff0 = pow(saturate(1.0 - hesiPaintDistance0 / max(hesiPaintLightRange0, 0.001)), 2.0);
        directLight.direction = normalize(hesiPaintVector0);
        directLight.color = hesiPaintLightColor0 * hesiPaintFalloff0;
        directLight.visible = hesiPaintFalloff0 > 0.0;
        RE_Direct(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);

        vec3 hesiPaintVector1 = (viewMatrix * vec4(hesiPaintLightPosition1, 1.0)).xyz - geometryPosition;
        float hesiPaintDistance1 = length(hesiPaintVector1);
        float hesiPaintFalloff1 = pow(saturate(1.0 - hesiPaintDistance1 / max(hesiPaintLightRange1, 0.001)), 2.0);
        directLight.direction = normalize(hesiPaintVector1);
        directLight.color = hesiPaintLightColor1 * hesiPaintFalloff1;
        directLight.visible = hesiPaintFalloff1 > 0.0;
        RE_Direct(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);`);
  };
  material.customProgramCacheKey = () => 'hesiCarPaintRoadLightsV1';
}

/**
 * Updates the two cheap analytic road-light highlights embedded only in the
 * player-car paint shader. World materials receive no extra lighting loop.
 */
export function updateCarPaintLights(root, lights = []) {
  if (!root) return 0;
  let touched = 0;
  const materials = root.userData?.hesiCarPaintMaterials || [];
  for (const material of materials) {
    const state = material.userData.hesiCarPaintLightUniforms;
    for (let index = 0; index < 2; index += 1) {
      const light = lights[index] || null;
      const position = index ? state.position1 : state.position0;
      const color = index ? state.color1 : state.color0;
      const range = index ? state.range1 : state.range0;
      if (light?.position) {
        position.copy(light.position);
        color.copy(light.color?.isColor ? light.color : new THREE.Color(light.color || 0xffffff))
          .multiplyScalar(Number(light.strength) || 1);
        range.value = Math.max(0, Number(light.range) || 0);
      } else {
        position.set(0, 0, 0);
        color.set(0x000000);
        range.value = 0;
      }
    }
    touched += 1;
  }
  return touched;
}

/**
 * Builds real automotive paint: a coloured dielectric base, optional metallic
 * flake, and a smooth clear coat. With a wrap image the base colour is lifted
 * toward white first because three.js multiplies `map` by `color`; `wrapTint`
 * deliberately adds the selected paint colour back.
 */
function paintMaterial(paint, source = null, wrap = null) {
  const base = new THREE.Color(paint.color);
  const metallic = THREE.MathUtils.clamp(Number(paint.metallic) || 0, 0, 1);
  const gloss = THREE.MathUtils.clamp(Number(paint.gloss) || 0, 0, 1);
  const tint = THREE.MathUtils.clamp(Number(paint.wrapTint) || 0, 0, 1);
  const diffuse = wrap ? new THREE.Color(0xffffff).lerp(base, tint) : base;
  const shared = {
    name: source?.name || 'psxBody',
    flatShading: true,
    fog: source?.fog !== false,
    side: source?.side ?? THREE.FrontSide,
    transparent: !!source?.transparent,
    opacity: source?.opacity ?? 1,
    ...(wrap ? { map: wrap } : {}),
  };
  if (metallic <= 0.001 && gloss <= 0.001) {
    return new THREE.MeshLambertMaterial({ ...shared, color: diffuse });
  }
  const finish = Math.max(gloss, metallic * 0.85);
  const reflectionStrength = THREE.MathUtils.lerp(0.4, 1.05, finish);
  const material = new THREE.MeshPhysicalMaterial({
    ...shared,
    flatShading: false,
    color: diffuse,
    // A car body is not bare metal: even full metallic paint keeps a coloured
    // binder and a dielectric clear coat over the flakes.
    metalness: metallic * 0.28,
    roughness: THREE.MathUtils.lerp(0.4, 0.1, finish),
    clearcoat: THREE.MathUtils.lerp(0.42, 1, Math.max(gloss, metallic * 0.45)),
    clearcoatRoughness: THREE.MathUtils.lerp(0.24, 0.05, gloss),
    specularIntensity: THREE.MathUtils.lerp(0.82, 1, finish),
    specularColor: new THREE.Color(0xffffff),
    envMap: paintEnvironmentFallback(),
    envMapIntensity: reflectionStrength,
  });
  material.userData.hesiCarPaint = true;
  material.userData.hesiCarPaintReflectionStrength = reflectionStrength;
  installRoadLightResponse(material);
  return material;
}

/**
 * Tags a material this module wrapped, so a later repaint can tell its own
 * work from a livery someone attached face by face. Without it, removing the
 * body image would hit the "leave textured body faces alone" rule and the wrap
 * could never be taken off.
 */
function markWrapped(material, wrap) {
  if (wrap) material.userData.hesiCarWrap = true;
  return material;
}

/** Every mesh of `root` that carries at least one body material. */
function bodyMeshes(root) {
  const found = [];
  root.traverse((child) => {
    if (!child.isMesh && !child.isInstancedMesh) return;
    const list = Array.isArray(child.material) ? child.material : [child.material];
    if (list.some((material) => isCarBodyMaterial(material, child))) found.push(child);
  });
  return found;
}

/**
 * Box-projects one texture across the whole body.
 *
 * Every body vertex is taken into the car's own space — so parts sitting at
 * different offsets share one projection — and then mapped by whichever axis
 * its normal points down: flanks take length × height, roof and bonnet take
 * length × width, nose and tail take width × height. Each pair is normalised
 * over the WHOLE body's bounding box, not the panel's own, which is the entire
 * point: one copy of the image covers a whole flank across every mesh part it
 * is split into, instead of every part receiving its own crop the way a
 * per-face image does. `scale` then tiles that copy.
 *
 * Mirrored axes are flipped so the picture reads the right way round on both
 * sides of the car rather than appearing mirrored on one of them.
 */
function projectWrapUVs(root, meshes, scale) {
  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  const toBody = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const local = [];
  for (const mesh of meshes) {
    const position = mesh.geometry?.getAttribute?.('position');
    if (!position) continue;
    const matrix = new THREE.Matrix4().multiplyMatrices(toBody, mesh.matrixWorld);
    const points = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
      points[i * 3] = vertex.x; points[i * 3 + 1] = vertex.y; points[i * 3 + 2] = vertex.z;
      box.expandByPoint(vertex);
    }
    local.push({ mesh, points, normalMatrix: new THREE.Matrix3().setFromMatrix4(matrix) });
  }
  if (box.isEmpty()) return false;
  const size = new THREE.Vector3();
  box.getSize(size);
  const spanX = Math.max(size.x, 0.001);
  const spanY = Math.max(size.y, 0.001);
  const spanZ = Math.max(size.z, 0.001);
  const tile = Math.max(scale, 0.01);
  const normal = new THREE.Vector3();
  for (const entry of local) {
    const { mesh, points, normalMatrix } = entry;
    const normals = mesh.geometry.getAttribute('normal');
    const count = points.length / 3;
    const uv = new Float32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      const x = (points[i * 3] - box.min.x) / spanX;
      const y = (points[i * 3 + 1] - box.min.y) / spanY;
      const z = (points[i * 3 + 2] - box.min.z) / spanZ;
      // Without normals every vertex takes the plan view, which still spreads
      // one whole image over the car rather than one per part.
      if (normals) normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix);
      else normal.set(0, 1, 0);
      const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
      let u, v;
      if (ax >= ay && ax >= az) { u = normal.x >= 0 ? z : 1 - z; v = y; }
      else if (az >= ay) { u = normal.z >= 0 ? 1 - x : x; v = y; }
      else { u = x; v = normal.y >= 0 ? z : 1 - z; }
      uv[i * 2] = u * tile;
      uv[i * 2 + 1] = v * tile;
    }
    mesh.geometry.setAttribute(WRAP_UV_ATTRIBUTE, new THREE.BufferAttribute(uv, 2));
    mesh.geometry.userData.hesiCarWrapUV = true;
  }
  return true;
}

/** Drops a previous wrap's projected coordinates. */
function clearWrapUVs(root) {
  root.traverse((child) => {
    const geometry = child.geometry;
    if (geometry?.userData?.hesiCarWrapUV) {
      geometry.deleteAttribute(WRAP_UV_ATTRIBUTE);
      delete geometry.userData.hesiCarWrapUV;
    }
  });
}

// Body wraps get their own view of each image. `textureFromSource` hands back
// one shared, cached texture per (source, transform) — the same object faces
// and world surfaces are already sampling — and a wrap has to point it at a
// different UV channel, which would follow it everywhere else. A clone carries
// its own settings while sharing `source`, so the pixels are still uploaded to
// the GPU exactly once; caching the clones here keeps repeated paint edits from
// piling up texture objects.
const wrapTextures = new Map();

/**
 * Resolves `paint.texture` against the document's texture library into a GPU
 * texture, or null when there is no image (or the id points at a deleted one).
 */
function wrapTexture(paint, textures) {
  const source = paint?.texture ? textureSourceUrl(textures?.[paint.texture]) : null;
  if (!source) return null;
  const cached = wrapTextures.get(source);
  if (cached) return cached;
  // The projection already carries the fit and the repeat count, so the
  // texture must not apply a second one: it samples 1:1 what it is handed.
  const wrap = textureFromSource(source, { fit: 'stretch', repeat: [1, 1] }).clone();
  wrap.name = 'carBodyWrap';
  wrap.wrapS = THREE.RepeatWrapping;
  wrap.wrapT = THREE.RepeatWrapping;
  wrap.channel = WRAP_UV_CHANNEL;
  wrap.needsUpdate = true;
  wrapTextures.set(source, wrap);
  return wrap;
}

/**
 * Repaints every body material of a built car, optionally wrapping one image
 * from the document's texture library across the whole bodywork.
 *
 * Without an image, textured body faces are left alone — a livery someone
 * attached per face would only get tinted. With one, they are replaced too:
 * a body-wide wrap is exactly the instruction to stop honouring the patchwork
 * of per-face images. Materials shared between merged meshes are replaced once
 * so the draw-call merge survives.
 *
 * Returns the number of material slots repainted.
 */
export function applyCarPaint(root, paint, textures = null) {
  if (!root) return 0;
  clearWrapUVs(root);
  if (!paint || !paint.color) return 0;
  const meshes = bodyMeshes(root);
  if (!meshes.length) return 0;
  let wrap = wrapTexture(paint, textures);
  if (wrap && !projectWrapUVs(root, meshes, Number(paint.wrapScale) || 1)) wrap = null;

  const replaced = new Map();
  let painted = 0;
  for (const child of meshes) {
    const list = Array.isArray(child.material) ? child.material : [child.material];
    let changed = false;
    const next = list.map((material) => {
      if (!isCarBodyMaterial(material, child)) return material;
      // Keep a per-face livery only when no body-wide image was asked for — a
      // wrap this module applied earlier is ours to replace, image and all.
      if (!wrap && material.map && !material.userData.hesiCarWrap) return material;
      let coat = replaced.get(material);
      if (!coat) { coat = markWrapped(paintMaterial(paint, material, wrap), wrap); replaced.set(material, coat); }
      changed = true;
      painted += 1;
      return coat;
    });
    if (changed) child.material = Array.isArray(child.material) ? next : next[0];
  }
  if (!painted) { clearWrapUVs(root); return 0; }
  root.userData.hesiCarPaintMaterials = [...new Set(replaced.values())]
    .filter((material) => material.userData.hesiCarPaintLightUniforms);
  const owned = root.userData.ownedMaterials || (root.userData.ownedMaterials = []);
  for (const material of replaced.values()) owned.push(material);
  // The originals are per-car instances built moments ago by the PSX loader or
  // the custom asset builder, so nothing outside this object still uses them.
  // The wrap texture itself is cached and shared, so it is never disposed here.
  for (const material of replaced.keys()) material.dispose();
  applyCarPaintEnvironment(root);
  return painted;
}
