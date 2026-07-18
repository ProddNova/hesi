import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyCameraController } from './navigation/fly-camera-controller.js';

const DEFAULT_POSITION = new THREE.Vector3(105, 72, 118);
const DEFAULT_TARGET = new THREE.Vector3(0, 7, 0);

// Editor-only inspection lighting. The rig lives in the editor scene only; the
// production game never creates it. `game` mode reproduces the original dark
// night look exactly.
const LIGHTING_MODES = {
  inspection: { exposure: 1.45, fogDensity: 0.0001, rig: true, background: 0x0d141d },
  game: { exposure: 1.08, fogDensity: 0.00055, rig: false, background: 0x03060b },
};

export function createViewport(host, { onStats = () => {}, onNavigation = () => {}, onCamera = () => {} } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03060b);
  scene.fog = new THREE.FogExp2(0x050a12, 0.00055);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120000);
  camera.position.copy(DEFAULT_POSITION);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', 'HESI editor 3D viewport');
  renderer.domElement.dataset.testid = 'editor-canvas';
  host.append(renderer.domElement);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.copy(DEFAULT_TARGET);
  orbit.maxDistance = 100000;
  orbit.update();

  let navigationMode = 'orbit';
  const emitNavigation = (flyState = {}) => onNavigation({
    mode: navigationMode,
    speed: fly.speed,
    speedPreset: fly.speedPreset,
    pointerLocked: flyState.locked ?? document.pointerLockElement === renderer.domElement,
  });
  const fly = new FlyCameraController(camera, renderer.domElement, { onChange: emitNavigation });

  // The world spans tens of kilometres, so a grid anchored at the origin is
  // out of sight from most camera presets. Snap it to the camera in whole-cell
  // steps each frame so it reads as an infinite ground grid. The lines are
  // built from short chunks rather than single 4 km segments: some rasterizers
  // (notably software WebGL) drop long clipped line segments entirely.
  const GRID_HALF = 2000;
  const GRID_CELL = 50;
  const GRID_MAJOR_EVERY = 4;
  const buildGridGeometry = (major) => {
    const positions = [];
    for (let line = -GRID_HALF; line <= GRID_HALF; line += GRID_CELL) {
      const index = Math.abs(line / GRID_CELL);
      if ((index % GRID_MAJOR_EVERY === 0) !== major) continue;
      for (let chunk = -GRID_HALF; chunk < GRID_HALF; chunk += GRID_CELL) {
        positions.push(line, 0, chunk, line, 0, chunk + GRID_CELL);
        positions.push(chunk, 0, line, chunk + GRID_CELL, 0, line);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  };
  const gridMaterial = (color, opacity) => new THREE.LineBasicMaterial({
    color, transparent: true, opacity, toneMapped: false, depthWrite: false,
  });
  const gridMinor = new THREE.LineSegments(buildGridGeometry(false), gridMaterial(0x4c4c55, 0.5));
  const gridMajor = new THREE.LineSegments(buildGridGeometry(true), gridMaterial(0x7c7c88, 0.55));
  const grid = new THREE.Group();
  grid.add(gridMinor, gridMajor);
  grid.position.y = -0.02;
  grid.userData.editorHelper = true;
  gridMinor.userData.editorHelper = true;
  gridMajor.userData.editorHelper = true;
  scene.add(grid);
  const followCameraGrid = () => {
    grid.position.x = Math.round(camera.position.x / GRID_CELL) * GRID_CELL;
    grid.position.z = Math.round(camera.position.z / GRID_CELL) * GRID_CELL;
  };
  followCameraGrid();
  const axes = new THREE.AxesHelper(100);
  axes.visible = false;
  axes.userData.editorHelper = true;
  scene.add(axes);
  scene.add(new THREE.AmbientLight(0xb9d0e4, 0.34));

  // Neutral inspection rig: hemisphere fill plus a directional key light so
  // geometry is readable without touching the world's own night lighting.
  const inspectionRig = new THREE.Group();
  inspectionRig.name = 'Editor inspection lighting';
  inspectionRig.userData.editorHelper = true;
  const hemisphere = new THREE.HemisphereLight(0xd7e5f7, 0x474e5c, 1.55);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
  keyLight.position.set(420, 1000, 260);
  inspectionRig.add(hemisphere, keyLight);
  scene.add(inspectionRig);

  const view = {
    lightingMode: 'inspection',
    exposure: LIGHTING_MODES.inspection.exposure,
    fogFull: false,
  };
  const applyViewState = () => {
    const mode = LIGHTING_MODES[view.lightingMode] || LIGHTING_MODES.inspection;
    inspectionRig.visible = mode.rig;
    renderer.toneMappingExposure = view.exposure;
    scene.background.setHex(mode.background);
    scene.fog.color.setHex(mode.background);
    scene.fog.density = view.fogFull ? LIGHTING_MODES.game.fogDensity : mode.fogDensity;
  };
  applyViewState();

  let worldGroup = null;
  let worldUpdater = null;
  let frameId = 0;
  let disposed = false;
  let frameCount = 0;
  let statsStart = performance.now();
  let previousFrame = performance.now();

  const resize = () => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const render = (now) => {
    if (disposed) return;
    const delta = Math.min(0.05, Math.max(0, (now - previousFrame) / 1000));
    previousFrame = now;
    if (navigationMode === 'orbit') orbit.update();
    else fly.update(delta);
    followCameraGrid();
    worldUpdater?.(camera.position, now / 1000);
    onCamera(camera.position);
    renderer.render(scene, camera);
    frameCount += 1;
    const elapsed = now - statsStart;
    if (elapsed >= 500) {
      onStats({
        fps: Math.round(frameCount * 1000 / elapsed),
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      });
      frameCount = 0;
      statsStart = now;
    }
    frameId = requestAnimationFrame(render);
  };
  frameId = requestAnimationFrame(render);

  const focusOn = (target, { direction = new THREE.Vector3(1, 0.72, 1), distanceScale = 0.74 } = {}) => {
    if (!target) return false;
    const box = target.isBox3 ? target.clone() : new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) return false;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 4);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));
    camera.position.copy(sphere.center).addScaledVector(direction.clone().normalize(), distance * distanceScale);
    camera.near = Math.max(0.1, distance / 20000);
    camera.far = Math.max(2000, distance * 20);
    camera.updateProjectionMatrix();
    orbit.target.copy(sphere.center);
    camera.lookAt(sphere.center);
    orbit.update();
    return true;
  };

  const applyCameraPreset = (preset) => {
    if (!preset?.position || !preset?.target) return false;
    camera.position.copy(preset.position);
    orbit.target.copy(preset.target);
    camera.lookAt(preset.target);
    camera.near = preset.near || 0.1;
    camera.far = preset.far || 120000;
    camera.updateProjectionMatrix();
    orbit.update();
    return true;
  };

  const setNavigationMode = (mode) => {
    if (!['fly', 'orbit'].includes(mode) || mode === navigationMode) return mode === navigationMode;
    if (mode === 'orbit') {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      orbit.target.copy(camera.position).addScaledVector(forward, Math.max(15, fly.speed * 0.8));
      orbit.enabled = true;
      fly.setEnabled(false);
      orbit.update();
    } else {
      orbit.enabled = false;
      fly.setEnabled(true);
      renderer.domElement.focus();
    }
    navigationMode = mode;
    emitNavigation();
    return true;
  };
  emitNavigation();

  return {
    scene, camera, renderer, canvas: renderer.domElement, orbit, fly,
    get navigationMode() { return navigationMode; },
    setWorldGroup(group, updater = null) {
      if (worldGroup?.parent === scene) scene.remove(worldGroup);
      worldGroup = group;
      worldUpdater = updater;
      if (worldGroup) scene.add(worldGroup);
    },
    focusOn,
    focusWorld() { return focusOn(worldGroup); },
    applyCameraPreset,
    setNavigationMode,
    setFlySpeedPreset(preset) { return fly.setSpeedPreset(preset); },
    setNavigationBlocked(blocked) { fly.setBlocked(blocked); orbit.enabled = navigationMode === 'orbit' && !blocked; },
    resetCamera() {
      camera.position.copy(DEFAULT_POSITION);
      orbit.target.copy(DEFAULT_TARGET);
      camera.near = 0.1;
      camera.far = 120000;
      camera.lookAt(DEFAULT_TARGET);
      camera.updateProjectionMatrix();
      orbit.update();
    },
    setGridVisible(visible) { grid.visible = Boolean(visible); },
    setAxesVisible(visible) { axes.visible = Boolean(visible); },
    setLightingMode(mode) {
      if (!LIGHTING_MODES[mode]) return false;
      view.lightingMode = mode;
      view.exposure = LIGHTING_MODES[mode].exposure;
      view.fogFull = mode === 'game';
      applyViewState();
      return true;
    },
    setExposure(value) {
      const exposure = Number(value);
      if (!Number.isFinite(exposure)) return false;
      view.exposure = THREE.MathUtils.clamp(exposure, 0.3, 2.5);
      applyViewState();
      return true;
    },
    setFogFull(full) {
      view.fogFull = Boolean(full);
      applyViewState();
    },
    viewState() { return { ...view }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      fly.dispose();
      orbit.dispose();
      for (const lines of [gridMinor, gridMajor]) {
        lines.geometry.dispose();
        lines.material.dispose();
      }
      axes.geometry.dispose();
      axes.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
