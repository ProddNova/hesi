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
// One config is three master dials — colour tint, warmth (temperature) and
// intensity — applied on top of each light's shipped colour/intensity, so a
// default config is exactly the shipped night look and every apply is
// reversible (the shipped values are captured once in `userData.baseLighting`).

export const DEFAULT_LIGHTING = Object.freeze({ intensity: 1, temperature: 0, tint: '#ffffff' });

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(+value) ? +value : 0));

const HEX = /^#?[0-9a-f]{6}$/i;
export function normalizeLighting(config) {
  const source = config && typeof config === 'object' ? config : {};
  let tint = typeof source.tint === 'string' && HEX.test(source.tint.trim()) ? source.tint.trim() : DEFAULT_LIGHTING.tint;
  if (tint[0] !== '#') tint = `#${tint}`;
  return {
    intensity: clamp(source.intensity ?? DEFAULT_LIGHTING.intensity, 0, 3),
    temperature: clamp(source.temperature ?? DEFAULT_LIGHTING.temperature, -1, 1),
    tint: tint.toLowerCase(),
  };
}

/** True when the config leaves every light exactly as shipped. */
export function isDefaultLighting(config) {
  const c = normalizeLighting(config);
  return c.intensity === 1 && c.temperature === 0 && c.tint === '#ffffff';
}

// Warm/cool multiplier per channel. -1 = warm sodium, +1 = cool moonlight.
function temperatureRGB(t) {
  const k = clamp(t, -1, 1);
  if (k < 0) return [1, 1 + 0.14 * k, 1 + 0.36 * k];   // warm: pull green a little, blue more
  return [1 - 0.30 * k, 1 - 0.10 * k, 1];              // cool: pull red, a little green
}

function hexRGB(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function tintColour(colour, baseHex, mr, mg, mb) {
  const [r, g, b] = hexRGB(`#${baseHex.toString(16).padStart(6, '0')}`);
  colour.setRGB(Math.min(1, r * mr), Math.min(1, g * mg), Math.min(1, b * mb));
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
  let touched = 0;
  scene.traverse((object) => {
    if (!object.isLight || !object.userData?.gameSceneLight) return;
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
