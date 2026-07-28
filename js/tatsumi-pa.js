import * as THREE from 'three';
import { BARRIER_MATERIALS, BARRIER_STYLES } from './road-barrier-styles.js?v=8aa9ed7e911a';
import { createHologramMarker, animateHologramMarker, hologramBaseLift } from './hologram-marker.js?v=8aa9ed7e911a';

// Tatsumi No.1 PA — the walkable zone behind the lay-by gate.
//
// A separate scene like the garage: the player drives into the square-ended
// bay on ramp_8, takes the gate, and arrives on foot in the PA lot with their
// own car parked in front of them. Deliberately EMPTY for now — asphalt, the
// perimeter wall and the way back out. The dressing belongs in the world
// editor (scene `tatsumi_pa`), which edits this exact generator.
//
// Editor contract, same as GarageSystem: children are addressed by build-order
// index, so anything added later must be APPENDED, never inserted, or every
// saved edit past the insertion point moves to the wrong object.

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Lot footprint in metres. The real strip is a ~190 m wedge; this is the
// walkable pocket behind the gate, not the whole deck.
export const PA_LOT = Object.freeze({ width: 46, depth: 30 });

export class TatsumiPaSystem {
  constructor(scene, camera, canvas, callbacks = {}) {
    this.scene = scene; this.camera = camera; this.canvas = canvas; this.cb = callbacks;
    this.playerHeight = 1.72 * 1.2;
    this.enabled = false; this.position = V(0, this.playerHeight, 6); this.yaw = 0; this.pitch = 0;
    this.velocity = V(); this.interactCooldown = 0;
    this.colliders = []; this.staticColliders = [];
    this.mouse = { x: 0, y: 0 }; this._pointerHandler = (e) => this.onMouse(e);
    this.build(); this.bind();
  }

  mat(color, emissive = 0, intensity = 0) {
    return new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: intensity, flatShading: true });
  }
  mesh(geo, mat, pos, rot = V()) {
    const o = new THREE.Mesh(geo, mat); o.position.copy(pos); o.rotation.set(rot.x, rot.y, rot.z); this.root.add(o); return o;
  }

  /**
   * The road's tall screen wall (js/road-barrier-styles.js `shutokoTall`) swept
   * around the lot instead of along a carriageway, so the PA is enclosed by the
   * same barrier the player has been driving past all night — same profile,
   * same colour, same height.
   *
   * `corner` is the closed loop of wall base points, wound clockwise seen from
   * above so the profile's `inset` runs INTO the lot. Each corner uses the
   * mitre of its two edge normals, so the wall turns without a notch. One mesh
   * per side (not one for the loop) keeps the collider boxes thin slabs rather
   * than one box covering the whole lot.
   */
  buildPerimeterWall(loop, material) {
    const style = BARRIER_STYLES.shutokoTall;
    const profile = style.sheets[0].points;
    const count = loop.length;
    // Inward mitre normal at every corner.
    const normals = loop.map((point, i) => {
      const previous = loop[(i - 1 + count) % count];
      const next = loop[(i + 1) % count];
      const inward = (a, b) => {
        const dx = b.x - a.x; const dz = b.z - a.z;
        const length = Math.hypot(dx, dz) || 1;
        return V(-dz / length, 0, dx / length);
      };
      const mitre = inward(previous, point).add(inward(point, next));
      const length = Math.hypot(mitre.x, mitre.z) || 1;
      // Renormalise to the mitre length so the wall keeps its thickness round
      // a corner instead of pinching.
      const scale = 2 / (length * length);
      return V(mitre.x * scale, 0, mitre.z * scale);
    });
    const walls = [];
    for (let i = 0; i < count; i += 1) {
      const a = loop[i]; const b = loop[(i + 1) % count];
      const na = normals[i]; const nb = normals[(i + 1) % count];
      const positions = []; const uvs = []; const indices = [];
      const runLength = Math.hypot(b.x - a.x, b.z - a.z);
      const at = (base, normal, inset, height) => V(
        base.x + normal.x * inset, base.y + height, base.z + normal.z * inset,
      );
      for (let p = 0; p < profile.length - 1; p += 1) {
        const [inset0, height0, v0] = profile[p];
        const [inset1, height1, v1] = profile[p + 1];
        const quad = [
          at(a, na, inset0, height0), at(b, nb, inset0, height0),
          at(b, nb, inset1, height1), at(a, na, inset1, height1),
        ];
        const start = positions.length / 3;
        for (const point of quad) positions.push(point.x, point.y, point.z);
        uvs.push(0, v0, runLength / 4, v0, runLength / 4, v1, 0, v1);
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const wall = new THREE.Mesh(geometry, material);
      wall.name = `PA wall ${i}`;
      this.root.add(wall);
      this.staticColliders.push(wall);
      walls.push(wall);
    }
    return walls;
  }

  build() {
    this.scene.background = new THREE.Color(0x05070b);
    this.scene.fog = new THREE.Fog(0x070a10, 34, 120);
    this.root = new THREE.Group();
    this.root.name = 'Tatsumi PA';
    this.scene.add(this.root);
    const halfWidth = PA_LOT.width / 2;
    const halfDepth = PA_LOT.depth / 2;

    // 0 — deck. The lot is the PA's own paved slab, not a room floor. It is a
    // touch lighter than road asphalt on purpose: the road carries a texture
    // and baked lamp pools, this slab has neither and goes to black under the
    // night mix if it is given the road's own value.
    this.deck = this.mesh(
      new THREE.PlaneGeometry(PA_LOT.width, PA_LOT.depth, 12, 8),
      this.mat(0x353b43), V(0, 0, 0), V(-Math.PI / 2, 0, 0),
    );

    // 1-4 — the road's tall screen wall, all the way round. Wound clockwise
    // from above so the profile leans into the lot.
    const wallMaterial = this.mat(BARRIER_MATERIALS.barrierScreen.color, BARRIER_MATERIALS.barrierScreen.emissive, 1);
    wallMaterial.side = THREE.DoubleSide;
    this.walls = this.buildPerimeterWall([
      V(-halfWidth, 0, -halfDepth), V(halfWidth, 0, -halfDepth),
      V(halfWidth, 0, halfDepth), V(-halfWidth, 0, halfDepth),
    ], wallMaterial);

    // 5-8 — sodium masts. Their lights are tagged so the game's scene-light
    // census treats them like the garage fixtures.
    this.lamps = [];
    for (const [x, z] of [[-15, -9], [15, -9], [-15, 9], [15, 9]]) {
      const lamp = new THREE.Group();
      lamp.name = 'PA lamp post';
      lamp.position.set(x, 0, z);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 8.4, 6), this.mat(0x2a2f36));
      mast.position.y = 4.2; lamp.add(mast);
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.6), this.mat(0xff8a2e, 0xff8a2e, 3));
      head.position.set(0, 8.3, 0); lamp.add(head);
      // Four masts have to light a 46x30 m lot on their own — there is no baked
      // pool decal here like the road has, so the range carries most of it.
      const light = new THREE.PointLight(0xff9c48, 16, 36, 1.5);
      light.position.set(0, 8, 0); light.userData.gameSceneLight = true; lamp.add(light);
      this.root.add(lamp);
      this.lamps.push(lamp);
    }

    // 9 — the stall the player's car is parked in.
    this.stall = this.mesh(
      new THREE.PlaneGeometry(5.6, 2.8),
      new THREE.MeshBasicMaterial({ color: 0xd8d6bf, transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
      V(0, 0.02, -3), V(-Math.PI / 2, 0, 0),
    );

    // 10-11 — the way back to the expressway: the same lit portal that stands
    // in the lay-by wall outside, seen from this side.
    this.exitPortal = this.mesh(
      new THREE.BoxGeometry(6.6, 3.3, 0.16), this.mat(0xff8b1f, 0xff8b1f, 2.6), V(0, 1.65, halfDepth - 0.5),
    );
    this.exitSign = this.addSign('EXIT / 首都高速', V(0, 4.2, halfDepth - 0.55), 0, 0xe9b947);

    // Children past this point are APPENDED after every editor-addressable
    // child, so saved childIndex operations keep resolving (cf. GarageSystem).
    this.carDisplay = new THREE.Group();
    this.carDisplay.name = 'Parked car';
    this.carDisplay.position.set(0, 0.05, -3);
    this.carDisplay.rotation.y = -Math.PI / 2;
    this.root.add(this.carDisplay);

    this.beacons = [];
    this.exitMarkers = this.makeBeacon(0x2233dd, 0x2f52ff);
    this.exitMarkers.userData.editorAnchorFollower = 'pa-exit';
    this.root.add(this.exitMarkers);
    this.beacons.push(this.exitMarkers);

    this.refreshColliders();
  }

  /** Holographic disc waypoint, identical in look to the garage beacons. */
  makeBeacon(color, emissive, scale = 1) {
    return createHologramMarker(color, emissive, scale);
  }
  animateBeacon(group, t) {
    animateHologramMarker(group, t);
  }

  // The plane is added whatever happens: a headless build (probes) must produce
  // the same child list as the browser, or every saved childIndex shifts.
  addSign(text, pos, ry = 0, color = 0xffffff) {
    if (typeof document === 'undefined') {
      return this.mesh(new THREE.PlaneGeometry(5.5, 1.03), this.mat(0x15191f), pos, V(0, ry, 0));
    }
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    const c = canvas.getContext('2d');
    c.fillStyle = '#15191f'; c.fillRect(0, 0, 512, 96);
    c.strokeStyle = `#${color.toString(16).padStart(6, '0')}`; c.lineWidth = 5; c.strokeRect(3, 3, 506, 90);
    c.fillStyle = `#${color.toString(16).padStart(6, '0')}`; c.font = 'bold 38px monospace'; c.textAlign = 'center';
    c.fillText(text, 256, 62);
    // Filtered with mipmaps — see the matching sign in garage.js: a 512 px
    // canvas on a 5.5 m plane is magnified, and nearest turns it into blocks.
    const tex = new THREE.CanvasTexture(canvas); tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.anisotropy = 8;
    return this.mesh(new THREE.PlaneGeometry(5.5, 1.03), new THREE.MeshBasicMaterial({ map: tex }), pos, V(0, ry, 0));
  }

  /**
   * Walk colliders from whatever is actually in the lot right now: the wall
   * segments (wherever the editor build moved them), every editor-placed
   * object and the parked car. Anything outside the player's body band is
   * skipped, so the deck and the hung signs do not block movement.
   */
  refreshColliders() {
    this.root.updateMatrixWorld(true);
    const boxes = [];
    const consider = (o) => {
      if (!o || o.visible === false) return;
      const box = new THREE.Box3().setFromObject(o);
      if (box.isEmpty() || box.min.y > 1.72 || box.max.y < .1) return;
      boxes.push(box);
    };
    for (const m of this.staticColliders) consider(m);
    const placed = this.root.children.find((c) => c.name === 'Editor placed objects');
    if (placed && placed.visible !== false) for (const child of placed.children) consider(child);
    if (this.carDisplay?.children.length && this.carDisplay.visible !== false) consider(this.carDisplay);
    this.colliders = boxes;
    this.refreshExitMarkers();
  }
  refreshExitMarkers() {
    const portal = this.exitPortal?.position || V(0, 0, PA_LOT.depth / 2 - 0.5);
    this.exitPoint = V(portal.x, 0, portal.z - 1.6);
    if (this.exitMarkers && !this.exitMarkers.userData.editorBuildTransformApplied) {
      // The disc's base stands hologramBaseLift() above its anchor, so a
      // code-placed marker drops by that much to touch the asphalt.
      this.exitMarkers.position.set(this.exitPoint.x, -hologramBaseLift(), this.exitPoint.z);
    }
  }
  onBuildApplied() { this.refreshColliders(); }

  // Circle-vs-AABB pushout in the XZ plane; two passes settle corner contacts.
  resolveCollisions(next) {
    const r = .35;
    for (let pass = 0; pass < 2; pass += 1) for (const box of this.colliders) {
      if (next.x < box.min.x - r || next.x > box.max.x + r || next.z < box.min.z - r || next.z > box.max.z + r) continue;
      const cx = Math.max(box.min.x, Math.min(box.max.x, next.x));
      const cz = Math.max(box.min.z, Math.min(box.max.z, next.z));
      const dx = next.x - cx; const dz = next.z - cz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); next.x = cx + dx / d * r; next.z = cz + dz / d * r; } else {
        const pushL = next.x - (box.min.x - r); const pushR = (box.max.x + r) - next.x;
        const pushB = next.z - (box.min.z - r); const pushF = (box.max.z + r) - next.z;
        const m = Math.min(pushL, pushR, pushB, pushF);
        if (m === pushL) next.x = box.min.x - r; else if (m === pushR) next.x = box.max.x + r;
        else if (m === pushB) next.z = box.min.z - r; else next.z = box.max.z + r;
      }
    }
  }

  bind() {
    // Headless builds (probes, node-side checks) have no DOM to bind to; the
    // geometry above is the part they care about.
    if (typeof document === 'undefined' || !this.canvas?.addEventListener) return;
    this.canvas.addEventListener('click', () => { if (this.enabled && !this.cb.isOverlayOpen?.()) this.canvas.requestPointerLock?.(); });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === this.canvas) document.addEventListener('mousemove', this._pointerHandler);
      else document.removeEventListener('mousemove', this._pointerHandler);
    });
  }
  onMouse(e) {
    if (!this.enabled) return;
    this.yaw -= e.movementX * .0023;
    this.pitch = Math.max(-1.35, Math.min(1.25, this.pitch - e.movementY * .0021));
  }

  /** Spawn beside the parked car, looking at it. */
  enter() {
    this.enabled = true; this.root.visible = true;
    const car = this.carDisplay?.position || V(0, 0, -3);
    this.position.set(car.x, this.playerHeight, car.z + 4.2);
    this.yaw = 0; this.pitch = -.05; this.velocity.set(0, 0, 0);
    this.camera.fov = 78; this.camera.updateProjectionMatrix();
    this.refreshColliders(); this.updateCamera();
  }
  leave() { this.enabled = false; document.exitPointerLock?.(); }

  update(dt, input = {}) {
    if (!this.enabled) return;
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);
    if (!this.cb.isOverlayOpen?.()) {
      const forward = V(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = V(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const wish = V();
      if (input.forward) wish.add(forward);
      if (input.backward) wish.sub(forward);
      if (input.right) wish.add(right);
      if (input.left) wish.sub(right);
      if (wish.lengthSq()) wish.normalize();
      const speed = input.sprint ? 5.3 : 3.2;
      this.velocity.lerp(wish.multiplyScalar(speed), 1 - Math.exp(-dt * 12));
      const next = this.position.clone().addScaledVector(this.velocity, dt);
      // Outer safety clamp only — real containment comes from the wall boxes,
      // which follow wherever the editor build moved them.
      const limitX = PA_LOT.width / 2 - 0.4;
      const limitZ = PA_LOT.depth / 2 - 0.4;
      next.x = Math.max(-limitX, Math.min(limitX, next.x));
      next.z = Math.max(-limitZ, Math.min(limitZ, next.z));
      if (this.colliders.length) this.resolveCollisions(next);
      this.position.copy(next);
    }
    this.updateCamera();
    const target = this.findInteraction();
    this.cb.prompt?.(target?.text || '', !!target);
    if (input.interactPressed && this.interactCooldown <= 0 && target) { this.interactCooldown = .35; this.interact(target); }
    const t = performance.now() * .001;
    for (const b of this.beacons) this.animateBeacon(b, t);
  }

  updateCamera() {
    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    const cosPitch = Math.cos(this.pitch);
    const forward = V(-Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch);
    this.camera.lookAt(this.position.clone().add(forward));
  }
  distance2D(p) { return Math.hypot(this.position.x - p.x, this.position.z - p.z); }
  lookScore(p) {
    const f = V(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const to = V(p.x - this.position.x, 0, p.z - this.position.z).normalize();
    return f.dot(to);
  }
  markerPoint(marker, fallback) {
    if (!marker) return fallback;
    marker.updateWorldMatrix?.(true, false);
    return marker.getWorldPosition(new THREE.Vector3());
  }
  findInteraction() {
    const candidates = [];
    // The prism IS the anchor: moving it in the world editor moves both the
    // prompt and the trigger.
    const exit = this.markerPoint(this.exitMarkers, this.exitPoint || V(0, 0, PA_LOT.depth / 2 - 2.1));
    if (this.distance2D(exit) < 2.6) candidates.push({ type: 'exit', pos: exit, text: '<kbd>E</kbd> BACK TO YOUR CAR' });
    return candidates.filter((c) => this.lookScore(c.pos) > -.1).sort((a, b) => this.distance2D(a.pos) - this.distance2D(b.pos))[0] || null;
  }
  interact(target) {
    this.cb.uiClick?.();
    if (target.type === 'exit') this.cb.exitPa?.();
  }
  dispose() { document.removeEventListener('mousemove', this._pointerHandler); this.scene.remove(this.root); }
}

export default TatsumiPaSystem;
