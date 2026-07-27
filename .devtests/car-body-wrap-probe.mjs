/**
 * Body-wrap probe for js/car-paint.js.
 *
 * The bug this feature exists to remove is "the image does not land on the
 * whole body": attaching a picture per face gives every mesh part its own
 * 0..1 UV rectangle, so a car whose body is split over several parts shows a
 * complete, differently-cropped copy on each of them. The checks below build
 * exactly that shape — one body cut into a front half and a rear half, plus a
 * part that already carries its own face image — and assert that one call
 * covers all of it with a single shared projection.
 *
 *   node .devtests/car-body-wrap-probe.mjs
 */
import * as THREE from 'three';
import { applyCarPaint, updateCarPaintLights } from '../js/car-paint.js';

const checks = [];
const check = (ok, label, detail = '') => {
  checks.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${label}${detail ? ` · ${detail}` : ''}`);
};

// A 1×1 transparent PNG is enough: nothing decodes images outside a browser,
// and the projection is pure geometry.
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const textures = { 'tex:0001': { id: 'tex:0001', name: 'wrap', dataUrl: IMAGE } };

/** A body panel spanning [x0,x1] along the car, with real side normals. */
function panel(name, x0, x1, materialName, map = null) {
  const geometry = new THREE.BoxGeometry(x1 - x0, 1.2, 1.6);
  geometry.translate((x0 + x1) / 2, 0.6, 0);
  const material = new THREE.MeshLambertMaterial({ name: materialName, color: 0x808080 });
  if (map) material.map = map;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

function buildCar() {
  const root = new THREE.Group();
  root.add(panel('body front', 0, 2, 'psxBody'));
  root.add(panel('body rear', 2, 4, 'custom:mesh:psxBody'));
  const glass = panel('glass', 1, 3, 'psxGlass');
  glass.position.y = 1.3;
  root.add(glass);
  return root;
}

const bodies = (root) => root.children.filter((child) => /body/.test(child.name));

/**
 * How much of the image lands on ONE flank of this part, measured along the
 * car.
 *
 * Only one side's faces are read. A box projection maps each face by its own
 * normal, so a part's nose and roof legitimately span the full range of a
 * different plane; and the two flanks deliberately run in opposite directions
 * (that is what stops the picture reading mirrored on one side of the car), so
 * merging them would also hide the very overlap being tested for.
 */
const flankSpan = (mesh, side = -1) => {
  const uv = mesh.geometry.getAttribute('uv1');
  const normals = mesh.geometry.getAttribute('normal');
  if (!uv) return null;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < uv.count; i += 1) {
    if (normals.getZ(i) * side < 0.9) continue;
    min = Math.min(min, uv.getX(i));
    max = Math.max(max, uv.getX(i));
  }
  return Number.isFinite(min) ? [min, max] : null;
};

// ---------------------------------------------------------------- plain paint
{
  const car = buildCar();
  const painted = applyCarPaint(car, { color: '#1b3fa8', metallic: 0.8, gloss: 0.5 }, textures);
  check(painted === 2, 'plain paint still reaches every body part', `${painted} slot(s)`);
  check(bodies(car).every((mesh) => mesh.material.isMeshPhysicalMaterial), 'metallic paint uses a physical clear-coat material');
  check(bodies(car).every((mesh) => mesh.material.metalness > 0 && mesh.material.roughness < 0.25 && mesh.material.clearcoat > 0.5),
    'metallic and gloss controls produce a reflective automotive finish');
  const fixture = { position: new THREE.Vector3(2, 9, 1), color: new THREE.Color(0xff8a2e), range: 52, strength: 5.2 };
  check(updateCarPaintLights(car, [fixture]) === 2, 'nearby road lights update every physical body coat');
  check(bodies(car).every((mesh) => mesh.material.userData.hesiCarPaintLightUniforms.range0.value === 52),
    'the road-light range reaches the player-only shader uniforms');
  check(bodies(car).every((mesh) => !mesh.material.map), 'plain paint attaches no image');
  check(bodies(car).every((mesh) => !mesh.geometry.getAttribute('uv1')), 'plain paint projects no wrap coordinates');
}

// ----------------------------------------------------------------- body image
{
  const car = buildCar();
  const painted = applyCarPaint(car, { color: '#ffffff', metallic: 0, gloss: 0, wrapScale: 1, texture: 'tex:0001' }, textures);
  const parts = bodies(car);
  check(painted === 2, 'the image reaches every body part in one call', `${painted} slot(s)`);
  check(parts.every((mesh) => !!mesh.material.map), 'every body material carries the image');
  check(new Set(parts.map((mesh) => mesh.material.map)).size === 1, 'all body parts share one texture upload');
  check(parts[0].material.map.channel === 1, 'the image samples the projected channel', `channel ${parts[0].material.map.channel}`);
  check(car.children.every((mesh) => /body/.test(mesh.name) || !mesh.material.map), 'glass is left alone');

  // The point of the whole exercise: the two halves receive DIFFERENT slices of
  // one 0..1 projection. Per-face texturing would give both the full range.
  const front = flankSpan(parts[0]);
  const rear = flankSpan(parts[1]);
  check(front && rear, 'both body parts got projected coordinates');
  const union = [Math.min(front[0], rear[0]), Math.max(front[1], rear[1])];
  check(Math.abs(union[0]) < 1e-6 && Math.abs(union[1] - 1) < 1e-6,
    'the flank carries exactly one copy across the whole body', `u ∈ [${union[0].toFixed(3)}, ${union[1].toFixed(3)}]`);
  check(front[1] - front[0] < 0.6 && rear[1] - rear[0] < 0.6,
    'no part gets a whole copy of its own — the half-painted-car bug',
    `front ${(front[1] - front[0]).toFixed(2)} · rear ${(rear[1] - rear[0]).toFixed(2)}`);
  check(Math.abs(front[1] - rear[0]) < 1e-6 || Math.abs(rear[1] - front[0]) < 1e-6,
    'the two halves meet at the seam instead of overlapping',
    `front [${front[0].toFixed(2)}, ${front[1].toFixed(2)}] · rear [${rear[0].toFixed(2)}, ${rear[1].toFixed(2)}]`);
  check(Math.abs((front[1] - front[0]) - (rear[1] - rear[0])) < 1e-6,
    'equal-sized halves get equal-sized slices');
  // Both flanks must show the same picture the same way up, just read from the
  // opposite end — a plain projection would mirror it on one side.
  const farSide = flankSpan(parts[0], 1);
  check(Math.abs((farSide[1] - farSide[0]) - (front[1] - front[0])) < 1e-6,
    'the other flank gets the same slice size, reversed',
    `[${farSide[0].toFixed(2)}, ${farSide[1].toFixed(2)}]`);
}

// ---------------------------------------------------------------- scale + off
{
  const car = buildCar();
  applyCarPaint(car, { color: '#ffffff', wrapScale: 3, texture: 'tex:0001' }, textures);
  const [, max] = flankSpan(bodies(car)[1]);
  check(Math.abs(max - 3) < 1e-6, 'Image scale tiles the wrap across the body', `${max.toFixed(2)} repeats`);

  applyCarPaint(car, { color: '#8c2731', metallic: 0.4, gloss: 0.2 }, textures);
  check(bodies(car).every((mesh) => !mesh.material.map), 'removing the image goes back to plain paint');
  check(bodies(car).every((mesh) => !mesh.geometry.getAttribute('uv1')), 'removing the image drops the projection');
}

// -------------------------------------------- a wrap overrides per-face images
{
  const car = new THREE.Group();
  car.add(panel('body front', 0, 2, 'psxBody'));
  car.add(panel('body rear', 2, 4, 'custom:mesh:psxBody', new THREE.Texture()));
  const painted = applyCarPaint(car, { color: '#ffffff', texture: 'tex:0001' }, textures);
  check(painted === 2, 'a body-wide image also replaces a leftover per-face image', `${painted} slot(s)`);
  check(new Set(bodies(car).map((mesh) => mesh.material.map)).size === 1, 'and the whole body ends up on one image');

  // Without a wrap that per-face image is still respected, as before.
  const stock = new THREE.Group();
  stock.add(panel('body front', 0, 2, 'psxBody'));
  stock.add(panel('body rear', 2, 4, 'custom:mesh:psxBody', new THREE.Texture()));
  check(applyCarPaint(stock, { color: '#1b3fa8' }, textures) === 1,
    'plain paint still leaves a per-face image alone');
}

// ------------------------------------------------- a deleted image is harmless
{
  const car = buildCar();
  const painted = applyCarPaint(car, { color: '#1b3fa8', texture: 'tex:9999' }, textures);
  check(painted === 2, 'an id pointing at a deleted image falls back to plain paint', `${painted} slot(s)`);
  check(bodies(car).every((mesh) => !mesh.material.map && !mesh.geometry.getAttribute('uv1')), 'and leaves no wrap behind');
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exitCode = passed === checks.length ? 0 : 1;
