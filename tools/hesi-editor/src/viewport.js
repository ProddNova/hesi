import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEFAULT_POSITION = new THREE.Vector3(105, 72, 118);
const DEFAULT_TARGET = new THREE.Vector3(0, 7, 0);

export function createViewport(host, { onStats = () => {} } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03060b);
  scene.fog = new THREE.FogExp2(0x050a12, 0.0022);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100000);
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

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.copy(DEFAULT_TARGET);
  controls.maxDistance = 30000;
  controls.update();

  const grid = new THREE.GridHelper(240, 24, 0x3c6f79, 0x1c2a35);
  grid.position.y = -0.02;
  grid.material.transparent = true;
  grid.material.opacity = 0.48;
  scene.add(grid);
  const axes = new THREE.AxesHelper(18);
  axes.visible = false;
  scene.add(axes);
  scene.add(new THREE.AmbientLight(0xb9d0e4, 0.32));

  let worldGroup = null;
  let frameId = 0;
  let disposed = false;
  let frameCount = 0;
  let statsStart = performance.now();

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
    controls.update();
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

  const focusOn = (target) => {
    if (!target) return false;
    const box = target.isBox3 ? target.clone() : new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) return false;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 4);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const direction = new THREE.Vector3(1, 0.72, 1).normalize();
    camera.position.copy(sphere.center).addScaledVector(direction, distance * 0.74);
    camera.near = Math.max(0.1, distance / 10000);
    camera.far = Math.max(1000, distance * 20);
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.update();
    return true;
  };

  return {
    scene, camera, renderer, canvas: renderer.domElement,
    setWorldGroup(group) {
      if (worldGroup?.parent === scene) scene.remove(worldGroup);
      worldGroup = group;
      if (worldGroup) scene.add(worldGroup);
    },
    focusOn,
    focusWorld() { return focusOn(worldGroup); },
    resetCamera() {
      camera.position.copy(DEFAULT_POSITION);
      controls.target.copy(DEFAULT_TARGET);
      camera.near = 0.1;
      camera.far = 100000;
      camera.updateProjectionMatrix();
      controls.update();
    },
    setGridVisible(visible) { grid.visible = Boolean(visible); },
    setAxesVisible(visible) { axes.visible = Boolean(visible); },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      axes.geometry.dispose();
      axes.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
