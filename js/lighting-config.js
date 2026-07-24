import * as THREE from 'three';

// Shared in-game lighting model for the HESI Lights editor app.
//
// The game's scene lights (road: hemisphere + ambient + moon; garage:
// hemisphere + workshop point lights) are tagged `userData.gameSceneLight` so
// this module can find and re-tint them without touching the editor's own
// inspection rig. The editor drives applySceneLighting live for preview and
// saves one config per scene into the build document's `environment.lighting`;
// js/editor-map-patch.js re-applies it to the real game at boot.
//
// Each scene owns three master dials — colour tint, warmth (temperature) and
// intensity — applied on top of each light's shipped colour/intensity. The
// highway scene also owns the generated street-lamp colour. A default config
// is exactly the shipped night look and every apply is reversible.

export const DEFAULT_LIGHTING = Object.freeze({
  intensity: 1,
  temperature: 0,
  tint: '#ffffff',
  streetLampColor: '#ff8a2e',
  streetLampIntensity: 1,
  streetLampTemperature: 0,
});
export const LOCAL_LIGHT_ASSET_ID = 'editor:light:soft-spot';
export const DEFAULT_LOCAL_LIGHT = Object.freeze({
  color: '#ffd3a1',
  temperature: -0.28,
  intensity: 650,
  range: 14,
  radius: 6.5,
  softness: 0.78,
  decay: 1.8,
  irregularity: 0.78,
  seed: 1,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(+value) ? +value : 0));

const HEX = /^#?[0-9a-f]{6}$/i;
const normalizedHex = (value, fallback) => {
  let hex = typeof value === 'string' && HEX.test(value.trim()) ? value.trim() : fallback;
  if (hex[0] !== '#') hex = `#${hex}`;
  return hex.toLowerCase();
};

export function normalizeLighting(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    intensity: clamp(source.intensity ?? DEFAULT_LIGHTING.intensity, 0, 3),
    temperature: clamp(source.temperature ?? DEFAULT_LIGHTING.temperature, -1, 1),
    tint: normalizedHex(source.tint, DEFAULT_LIGHTING.tint),
    streetLampColor: normalizedHex(source.streetLampColor, DEFAULT_LIGHTING.streetLampColor),
    streetLampIntensity: clamp(source.streetLampIntensity ?? DEFAULT_LIGHTING.streetLampIntensity, 0, 3),
    streetLampTemperature: clamp(source.streetLampTemperature ?? DEFAULT_LIGHTING.streetLampTemperature, -1, 1),
  };
}

export function normalizeLocalLight(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    color: normalizedHex(source.color, DEFAULT_LOCAL_LIGHT.color),
    temperature: clamp(source.temperature ?? DEFAULT_LOCAL_LIGHT.temperature, -1, 1),
    intensity: clamp(source.intensity ?? DEFAULT_LOCAL_LIGHT.intensity, 0, 3000),
    range: clamp(source.range ?? DEFAULT_LOCAL_LIGHT.range, 0.5, 60),
    radius: clamp(source.radius ?? DEFAULT_LOCAL_LIGHT.radius, 0.25, 30),
    softness: clamp(source.softness ?? DEFAULT_LOCAL_LIGHT.softness, 0, 1),
    decay: clamp(source.decay ?? DEFAULT_LOCAL_LIGHT.decay, 0, 3),
    // A small amount of asymmetry is intentional even at the minimum: these
    // authored lights should never collapse back to a perfect CGI circle.
    irregularity: clamp(source.irregularity ?? DEFAULT_LOCAL_LIGHT.irregularity, 0.15, 1),
    seed: Math.max(0, Math.min(2147483647, Math.round(Number.isFinite(+source.seed) ? +source.seed : DEFAULT_LOCAL_LIGHT.seed))),
  };
}

export function localLightConfigErrors(config, { path = 'light' } = {}) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [`${path} must be an object`];
  if (typeof config.color !== 'string' || !HEX.test(config.color.trim())) errors.push(`${path}.color must be a #rrggbb colour`);
  const ranges = {
    temperature: [-1, 1],
    intensity: [0, 3000],
    range: [0.5, 60],
    radius: [0.25, 30],
    softness: [0, 1],
    decay: [0, 3],
    irregularity: [0.15, 1],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max) {
      errors.push(`${path}.${key} must be a finite number from ${min} to ${max}`);
    }
  }
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 2147483647) {
    errors.push(`${path}.seed must be an integer from 0 to 2147483647`);
  }
  return errors;
}

/** True when the config leaves every light exactly as shipped. */
export function isDefaultLighting(config) {
  const c = normalizeLighting(config);
  return c.intensity === DEFAULT_LIGHTING.intensity
    && c.temperature === DEFAULT_LIGHTING.temperature
    && c.tint === DEFAULT_LIGHTING.tint
    && c.streetLampColor === DEFAULT_LIGHTING.streetLampColor
    && c.streetLampIntensity === DEFAULT_LIGHTING.streetLampIntensity
    && c.streetLampTemperature === DEFAULT_LIGHTING.streetLampTemperature;
}

// Warm/cool multiplier per channel. -1 = warm sodium, +1 = cool moonlight.
function temperatureRGB(t) {
  const k = clamp(t, -1, 1);
  if (k < 0) return [1, 1 + 0.14 * k, 1 + 0.36 * k];   // warm: pull green a little, blue more
  return [1 - 0.30 * k, 1 - 0.10 * k, 1];              // cool: pull red, a little green
}

function hexRGB(hex) {
  const colour = new THREE.Color(hex);
  return [colour.r, colour.g, colour.b];
}

function tintColour(colour, baseHex, mr, mg, mb) {
  const [r, g, b] = new THREE.Color(baseHex).toArray();
  colour.setRGB(Math.min(1, r * mr), Math.min(1, g * mg), Math.min(1, b * mb));
}

function localLightColour(config) {
  const c = normalizeLocalLight(config);
  const colour = new THREE.Color(c.color);
  const [tr, tg, tb] = temperatureRGB(c.temperature);
  colour.setRGB(
    Math.min(1, colour.r * tr),
    Math.min(1, colour.g * tg),
    Math.min(1, colour.b * tb),
  );
  return colour;
}

const cookieCache = new Map();
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const noiseHash = (x, y, seed) => {
  let value = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519) ^ Math.imul(seed + 1013904223, 3266489917);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
};
const valueNoise = (x, y, seed) => {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = smoothstep(0, 1, x - x0), ty = smoothstep(0, 1, y - y0);
  const a = noiseHash(x0, y0, seed), b = noiseHash(x0 + 1, y0, seed);
  const c = noiseHash(x0, y0 + 1, seed), d = noiseHash(x0 + 1, y0 + 1, seed);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
};
const cloudNoise = (x, y, seed) => {
  let sum = 0, amplitude = 0.57, scale = 1.7, total = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    sum += valueNoise(x * scale + 13.1 * octave, y * scale - 7.3 * octave, seed + octave * 97) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    scale *= 2.03;
  }
  return sum / total;
};

// Procedural gobo/cookie used by every authored spot light. It combines a
// feathered edge with low-frequency cloud noise and an asymmetric outline, so
// a light landing square-on a floor still has an organic, broken-up pool
// instead of the unmistakable perfect circle of a plain SpotLight.
function softLightCookie(config) {
  const c = normalizeLocalLight(config);
  const quantized = Math.round(c.irregularity * 20) / 20;
  const key = `${c.seed}:${quantized}`;
  if (cookieCache.has(key)) return cookieCache.get(key);
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = ((y + 0.5) / size) * 2 - 1;
      const radius = Math.hypot(nx, ny);
      const theta = Math.atan2(ny, nx);
      const outlineNoise = cloudNoise(Math.cos(theta) * 1.8, Math.sin(theta) * 1.8, c.seed + 401) - 0.5;
      const lobes = Math.sin(theta * 3 + c.seed * 0.17) * 0.035 + Math.sin(theta * 7 - c.seed * 0.11) * 0.018;
      const boundary = 0.78 + quantized * (outlineNoise * 0.36 + lobes);
      const feather = THREE.MathUtils.lerp(0.24, 0.42, quantized);
      const edge = 1 - smoothstep(boundary - feather, boundary + 0.08, radius);
      const cloud = cloudNoise(nx * 1.35, ny * 1.35, c.seed + 17);
      const broadCloud = cloudNoise(nx * 0.72 + 3.1, ny * 0.72 - 2.7, c.seed + 233);
      const mottling = THREE.MathUtils.lerp(1, (0.36 + cloud * 0.72) * (0.78 + broadCloud * 0.34), quantized);
      const centreLift = 0.84 + 0.16 * (1 - Math.min(1, radius));
      const value = clamp(edge * mottling * centreLift, 0, 1);
      const index = (y * size + x) * 4;
      const channel = Math.round(value * 255);
      data[index] = channel;
      data[index + 1] = channel;
      data[index + 2] = channel;
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = `HESI cloudy light cookie ${key}`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  cookieCache.set(key, texture);
  return texture;
}

function coneHelperGeometry() {
  const points = [];
  const segments = 32;
  for (let index = 0; index < segments; index += 1) {
    const a = index / segments * Math.PI * 2;
    const b = (index + 1) / segments * Math.PI * 2;
    points.push(
      Math.cos(a), -1, Math.sin(a), Math.cos(b), -1, Math.sin(b),
    );
    if (index % 8 === 0) points.push(0, 0, 0, Math.cos(a), -1, Math.sin(a));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

export function applyLocalLightConfig(root, config) {
  if (!root) return null;
  const c = normalizeLocalLight(config);
  const light = root.userData?.localLightObject || root.children?.find((child) => child.isSpotLight);
  if (!light) return null;
  const colour = localLightColour(c);
  light.color.copy(colour);
  light.intensity = c.intensity;
  light.distance = c.range;
  light.decay = c.decay;
  light.angle = Math.min(Math.PI / 2 - 0.01, Math.max(0.02, Math.atan2(c.radius, c.range)));
  light.penumbra = c.softness;
  light.map = softLightCookie(c);
  light.userData.gameSceneLight = true;
  // Master world-lighting dials always start from the authored local values.
  light.userData.baseLighting = { color: colour.getHex(), ground: null, intensity: c.intensity };
  const target = root.userData.localLightTarget;
  if (target) target.position.set(0, -Math.max(1, c.range), 0);
  const cone = root.userData.localLightCone;
  if (cone) {
    cone.scale.set(c.radius, c.range, c.radius);
    cone.material.color.copy(colour);
    cone.material.opacity = THREE.MathUtils.lerp(0.2, 0.09, c.softness);
  }
  const handle = root.userData.localLightHandle;
  if (handle?.material) {
    handle.material.color.copy(colour);
    handle.material.emissive.copy(colour);
  }
  root.userData.localLightConfig = c;
  return c;
}

export function createSoftSpotLight(config = DEFAULT_LOCAL_LIGHT, { editor = false } = {}) {
  const root = new THREE.Group();
  root.name = 'Soft cloudy light';
  root.userData.localLight = true;
  const light = new THREE.SpotLight();
  light.name = 'Soft cloudy spot';
  const target = new THREE.Object3D();
  target.name = 'Soft light target';
  light.target = target;
  root.add(light, target);
  root.userData.localLightObject = light;
  root.userData.localLightTarget = target;

  if (editor) {
    const handleMaterial = new THREE.MeshStandardMaterial({
      color: 0xffd3a1,
      emissive: 0xffd3a1,
      emissiveIntensity: 1.8,
      roughness: 0.3,
      metalness: 0.12,
      depthTest: false,
    });
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 12), handleMaterial);
    handle.name = 'Local light handle';
    handle.renderOrder = 9000;
    root.add(handle);
    root.userData.localLightHandle = handle;

    const coneMaterial = new THREE.LineBasicMaterial({ color: 0xffd3a1, transparent: true, opacity: 0.12, depthWrite: false });
    const cone = new THREE.LineSegments(coneHelperGeometry(), coneMaterial);
    cone.name = 'Local light range preview';
    cone.userData.editorHelper = true;
    cone.renderOrder = 8999;
    root.add(cone);
    root.userData.localLightCone = cone;
  }
  applyLocalLightConfig(root, config);
  return root;
}

export function localLightConfigFromObject(root) {
  return normalizeLocalLight(root?.userData?.localLightConfig || DEFAULT_LOCAL_LIGHT);
}

/**
 * Re-tint every `gameSceneLight` in a scene from its shipped values. Idempotent
 * and reversible: the shipped colour/intensity are captured once, so a default
 * config restores the original look exactly.
 */
export function applySceneLighting(scene, config) {
  if (!scene) return 0;
  const c = normalizeLighting(config);
  const [tr, tg, tb] = temperatureRGB(c.temperature);
  const [nr, ng, nb] = hexRGB(c.tint);
  const mr = tr * nr, mg = tg * ng, mb = tb * nb;
  const [lampTr, lampTg, lampTb] = temperatureRGB(c.streetLampTemperature);
  const streetLampHasCustomColour = c.streetLampColor !== DEFAULT_LIGHTING.streetLampColor;
  const streetLampIsDefault = c.streetLampColor === DEFAULT_LIGHTING.streetLampColor
    && c.streetLampIntensity === DEFAULT_LIGHTING.streetLampIntensity
    && c.streetLampTemperature === DEFAULT_LIGHTING.streetLampTemperature;
  const visitedStreetLampMaterials = new Set();
  let touched = 0;
  scene.traverse((object) => {
    if (object.isLight && object.userData?.gameSceneLight) {
      let base = object.userData.baseLighting;
      if (!base) {
        base = {
          color: object.color.getHex(),
          ground: object.groundColor ? object.groundColor.getHex() : null,
          intensity: object.intensity,
        };
        object.userData.baseLighting = base;
      }
      tintColour(object.color, base.color, mr, mg, mb);
      if (object.groundColor && base.ground != null) tintColour(object.groundColor, base.ground, mr, mg, mb);
      object.intensity = base.intensity * c.intensity;
      touched += 1;
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const role = material?.userData?.streetLampLight;
      if (!role) continue;
      if (material.userData.baseStreetLampColor == null) {
        material.userData.baseStreetLampColor = material.color.getHex();
        material.userData.baseStreetLampOpacity = material.opacity;
      }
      if (!visitedStreetLampMaterials.has(material)) {
        if (streetLampIsDefault) {
          material.color.set(material.userData.baseStreetLampColor);
          material.opacity = material.userData.baseStreetLampOpacity;
        } else {
          material.color.set(streetLampHasCustomColour ? c.streetLampColor : material.userData.baseStreetLampColor);
          material.color.setRGB(
            material.color.r * lampTr,
            material.color.g * lampTg,
            material.color.b * lampTb,
          );
          if (role === 'head') material.color.multiplyScalar(c.streetLampIntensity);
          material.opacity = role === 'pool' || role === 'streak'
            ? material.userData.baseStreetLampOpacity * c.streetLampIntensity
            : material.userData.baseStreetLampOpacity;
        }
        material.needsUpdate = true;
        visitedStreetLampMaterials.add(material);
        touched += 1;
      }

      // Main-road pools carry per-lamp brightness jitter in instanceColor.
      // Preserve the authored values for an exact reset; with a custom hue,
      // turn those colours into neutral brightness multipliers so the material
      // colour becomes the one authoritative lamp hue.
      if (!object.isInstancedMesh || !object.instanceColor || role !== 'pool') continue;
      const attribute = object.instanceColor;
      if (!object.userData.baseStreetLampInstanceColors) {
        object.userData.baseStreetLampInstanceColors = Float32Array.from(attribute.array);
      }
      const baseColours = object.userData.baseStreetLampInstanceColors;
      if (!streetLampHasCustomColour) {
        attribute.array.set(baseColours);
      } else {
        for (let index = 0; index < attribute.count; index += 1) {
          const offset = index * attribute.itemSize;
          const brightness = Math.max(baseColours[offset], baseColours[offset + 1], baseColours[offset + 2]);
          attribute.setXYZ(index, brightness, brightness, brightness);
        }
      }
      attribute.needsUpdate = true;
    }
  });
  return touched;
}

/**
 * A tagged rig matching the game's road night lighting, for the editor
 * viewport's "Game" lighting mode so the Lights app previews live. Values track
 * js/game.js setupLights; keep them in step if that changes.
 */
export function buildRoadLightRig() {
  const rig = new THREE.Group();
  rig.name = 'HESI game lighting';
  rig.userData.editorHelper = true;
  const tag = (light) => { light.userData.gameSceneLight = true; return light; };
  rig.add(tag(new THREE.HemisphereLight(0x564a40, 0x1e1510, 1.58)));
  rig.add(tag(new THREE.AmbientLight(0x64524a, 0.66)));
  const moon = tag(new THREE.DirectionalLight(0x9aa6c4, 0.72));
  moon.position.set(-200, 300, -100);
  rig.add(moon);
  return rig;
}
