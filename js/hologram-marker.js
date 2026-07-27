import * as THREE from 'three';

/**
 * The one interaction-point marker used everywhere: garage, Tatsumi PA lot and
 * the PA road gate.
 *
 * It replaces the spinning crystal prism with a projected disc — a squat
 * curtain of light standing on the floor with NO thickness and no end caps
 * (just the cylinder wall), brightest at its base and fading upward, drawn
 * closed by a hairline ring at the top. That reads as something
 * projected onto the ground at the exact spot the player has to stand on,
 * which a floating gem never did: the gem said "look here", the disc says
 * "stand here".
 *
 * Every layer is additive with depthWrite off, so the disc glows over the
 * asphalt instead of painting a solid shape on it, and the vertical gradient
 * is baked into vertex colours rather than a texture (one extra attribute, no
 * upload, and it survives the retro material pass untouched).
 *
 * STRUCTURE IS LOAD-BEARING. The group is `group > core > [halo, body, edges]`
 * — three meshes, in that order, in a group whose transform is the anchor the
 * world editor moves. GarageSystem and TatsumiPaSystem address their children
 * by build-order index, so the layer count and order must not change.
 */

// Unit disc: radius 1, height 1, centred on its own origin, and OPEN — no end
// caps and no wall thickness, just the curtain of light itself. A capped
// cylinder rendered as a solid slug of colour; open, you see the far wall
// through the near one and it reads as a projection.
const DISC_SEGMENTS = 36;
let discGeometry = null;
let rimGeometry = null;

// Bottom-to-top brightness of the projected column. The base sits at full
// strength (it is the part touching the ground, where the projection would be
// densest) and the top is dimmed so the disc reads as a fading beam.
const GRADIENT_BASE = 1;
const GRADIENT_TOP = 0.42;

function unitDisc() {
  if (discGeometry) return discGeometry;
  const geometry = new THREE.CylinderGeometry(1, 1, 1, DISC_SEGMENTS, 1, true);
  const position = geometry.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    // y runs -0.5..+0.5 over the unit cylinder.
    const t = THREE.MathUtils.clamp(position.getY(i) + 0.5, 0, 1);
    const k = GRADIENT_BASE + (GRADIENT_TOP - GRADIENT_BASE) * t;
    colours[i * 3] = k; colours[i * 3 + 1] = k; colours[i * 3 + 2] = k;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  discGeometry = geometry;
  return geometry;
}

function unitRim() {
  if (rimGeometry) return rimGeometry;
  // A hairline circle, not a lid: the annulus is thin enough to read as a drawn
  // outline at any distance, so the top of the column closes without the marker
  // gaining a solid surface.
  const geometry = new THREE.RingGeometry(0.94, 1.0, DISC_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  rimGeometry = geometry;
  return geometry;
}

// Default disc footprint in metres: wider than it is tall, so it reads as a
// pool of light on the floor rather than as a pillar.
export const HOLOGRAM_RADIUS = 0.5;
export const HOLOGRAM_HEIGHT = 0.62;

// Where the disc sits inside the marker group — and this is compatibility, not
// taste. The group's origin is the anchor the world editor moves, and the
// markers it has already moved were dragged while the visual was the old
// crystal prism: a gem centred 1.35 m up, half-height 0.44. The user pulled
// each one DOWN until that gem's lowest point touched the floor (the garage
// anchors sit at y ≈ −0.87/−0.65/−0.72 for exactly that reason). So the disc's
// base takes over the prism's lowest point, and every saved placement keeps
// standing exactly where it was put instead of sinking a metre into the floor.
const LEGACY_PRISM_Y = 1.35, LEGACY_PRISM_HALF_HEIGHT = 0.44;
/** Height of the disc's base above the marker group's origin. */
export function hologramBaseLift(scale = 1) {
  return Math.max(0, LEGACY_PRISM_Y - LEGACY_PRISM_HALF_HEIGHT * scale);
}

/**
 * @param {number} color    outer halo tint (the marker's identity colour)
 * @param {number} emissive core/rim tint — the bright one
 * @param {number} scale    uniform multiplier on the default footprint
 */
export function createHologramMarker(color, emissive, scale = 1) {
  const group = new THREE.Group();
  const disc = unitDisc();
  const body = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({
    color: emissive, vertexColors: true, transparent: true, opacity: .42,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }));
  // The one hard edge in the marker: a hairline circle closing the top of the
  // curtain. Without it the open cylinder has no silhouette and dissolves into
  // the road at distance.
  const edges = new THREE.Mesh(unitRim(), new THREE.MeshBasicMaterial({
    color: emissive, transparent: true, opacity: .9,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }));
  edges.position.y = .5;
  const halo = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({
    color, vertexColors: true, transparent: true, opacity: .18,
    blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false, toneMapped: false,
  }));
  halo.scale.set(1.2, 1.06, 1.2);
  const core = new THREE.Group();
  core.add(halo, body, edges);
  const radius = HOLOGRAM_RADIUS * scale, height = HOLOGRAM_HEIGHT * scale;
  const baseY = hologramBaseLift(scale) + height / 2;
  core.scale.set(radius, height, radius);
  core.position.y = baseY;
  core.userData.baseY = baseY;
  core.userData.baseRadius = radius;
  core.userData.baseHeight = height;
  group.add(core);
  group.userData = { core, body, edges, halo };
  return group;
}

/** Per-frame life: a slow hover, a projector flicker and a breathing rim. */
export function animateHologramMarker(group, t) {
  const { core, body, edges, halo } = group.userData || {}; if (!core) return;
  const radius = core.userData.baseRadius ?? HOLOGRAM_RADIUS;
  const height = core.userData.baseHeight ?? HOLOGRAM_HEIGHT;
  // Rise only, never sink: the base is on the floor, so a symmetric bob would
  // push the bottom of the disc through it.
  core.position.y = core.userData.baseY + (.5 + .5 * Math.sin(t * 1.7)) * .05 * (radius / HOLOGRAM_RADIUS);
  // Breathing: the column widens and shortens a hair, like a projection that
  // cannot quite hold focus. Small enough that it never reads as a bounce.
  const breathe = Math.sin(t * 2.1);
  core.scale.set(radius * (1 + breathe * .022), height * (1 - breathe * .018), radius * (1 + breathe * .022));
  // Fast flicker over a slow drift, so it looks unstable rather than pulsed.
  const shimmer = .85 + Math.sin(t * 20) * .09 + Math.sin(t * 6.1) * .06;
  if (body) body.material.opacity = .42 * shimmer;
  if (edges) edges.material.opacity = .9 * shimmer;
  if (halo) halo.material.opacity = .18 * (.7 + .3 * shimmer);
}
