/**
 * Developer network map (js/dev-map.js)
 * =====================================
 *
 * A full-screen, interactive top-down map of the whole runtime highway network,
 * opened with the `M` key. This is a development / debugging tool — separate
 * from the in-fiction phone minimap — for inspecting routes and teleporting the
 * car (or the noclip drone) anywhere on the network.
 *
 * The module is deliberately self-contained: it never imports game internals.
 * Everything it needs is supplied through callbacks passed to the constructor,
 * so it can be unit-driven in isolation and rebased independently of the rest of
 * the engine. See DEV_MAP.md for the full contract and architecture notes.
 */

const MIN_SCALE = 0.02;   // px per world metre (zoomed all the way out)
const MAX_SCALE = 10;     // px per world metre (zoomed all the way in)
const DRAG_THRESHOLD = 4; // px of pointer travel before a press becomes a pan
const HIT_THRESHOLD = 9;  // px radius for route hover hit-testing
const PIN_HIT_THRESHOLD = 12; // fixed screen-space radius for prototype markers
const HOVER_HYSTERESIS = 3; // px band that keeps the current route hovered
const HOVER_THROTTLE_MS = 16; // minimum gap between hover recomputes

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

export class DeveloperMap {
  constructor(callbacks = {}) {
    this.cb = callbacks;

    // View transform: `cam` is the world XZ point at the centre of the canvas,
    // `scale` is pixels-per-metre.
    this.view = { camX: 0, camZ: 0, scale: 0.4, followPlayer: true, showLabels: false };

    this.open_ = false;
    this.network = null;         // cached, prepared network (polylines + bounds)
    this.hovered = null;         // current hover hit-test result
    this._staticDirty = true;    // static layer needs a redraw (pan/zoom/resize)
    this._firstOpen = true;
    this._dpr = 1;
    this._raf = 0;
    this._lastHoverAt = 0;
    this._pointer = null;        // active canvas pointer (drag/click tracking)
    this._touchPoints = new Map(); // active touch pointers for mobile pinch zoom
    this._pinch = null;
    this._teleportInfo = null;   // last teleport, shown in the info panel

    this._buildDom();
    this._bindEvents();
  }

  // --- Lifecycle ------------------------------------------------------------

  isOpen() { return this.open_; }

  toggle() { return this.open_ ? this.close() : this.open(); }

  open() {
    if (this.open_) return;
    this.open_ = true;
    this._prepareNetwork();
    this.root.hidden = false;
    document.body.classList.add('dev-map-open');
    this._syncCanvasSize();

    // With follow on (the default) the render loop keeps the live marker
    // centred — this is what centres the noclip drone when the map opens. The
    // first open picks a readable local zoom; with follow off we frame the
    // whole network so the operator can get their bearings. Either way the
    // Fit / Centre / Follow buttons override on demand.
    if (this._firstOpen) {
      this._firstOpen = false;
      if (this.view.followPlayer) { this.view.scale = this._defaultScale(); this.centerOnPosition(); }
      else this.fitNetwork();
    } else if (this.view.followPlayer) {
      this.centerOnPosition();
    }

    this._staticDirty = true;
    this._escHandler = (event) => {
      if (event.key === 'Escape' || event.code === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      }
    };
    // Capture phase so the map's Escape wins over any game-level Escape logic.
    window.addEventListener('keydown', this._escHandler, true);
    window.addEventListener('resize', this._resizeHandler);

    this.cb.onOpen?.();
    this._loop();
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    this.root.hidden = true;
    document.body.classList.remove('dev-map-open');
    this.hovered = null;
    this._pointer = null;
    this._touchPoints.clear();
    this._pinch = null;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._escHandler) window.removeEventListener('keydown', this._escHandler, true);
    window.removeEventListener('resize', this._resizeHandler);
    this._escHandler = null;
    this.cb.onClose?.();
  }

  dispose() {
    this.close();
    this.root?.remove();
  }

  // --- DOM ------------------------------------------------------------------

  _buildDom() {
    const root = document.createElement('section');
    root.className = 'dev-map';
    root.hidden = true;
    root.setAttribute('aria-label', 'Developer network map');
    root.innerHTML = `
      <canvas class="dev-map-canvas"></canvas>
      <div class="dev-map-toolbar">
        <span class="dev-map-brand">DEV MAP</span>
        <button type="button" data-act="fit">Fit network</button>
        <button type="button" data-act="center">Centre position</button>
        <button type="button" data-act="follow" aria-pressed="true">Follow: ON</button>
        <button type="button" data-act="labels" aria-pressed="false">Labels: OFF</button>
        <button type="button" data-act="close" class="dev-map-close">✕ Close</button>
      </div>
      <div class="dev-map-info">
        <dl>
          <dt>Position</dt><dd data-info="pos">—</dd>
          <dt>Zoom</dt><dd data-info="zoom">—</dd>
          <dt>Noclip</dt><dd data-info="noclip">—</dd>
          <dt>On route</dt><dd data-info="route">—</dd>
          <dt>Prototypes</dt><dd data-info="prototypes">—</dd>
          <dt>Teleport</dt><dd data-info="teleport">—</dd>
        </dl>
        <p class="dev-map-help">M / Esc / Close · drag or touch to pan · wheel or pinch to zoom · tap/click to teleport</p>
      </div>`;
    (document.getElementById('game-shell') || document.body).appendChild(root);

    this.root = root;
    this.canvas = root.querySelector('.dev-map-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.staticCanvas = document.createElement('canvas');
    this.staticCtx = this.staticCanvas.getContext('2d');
    this.info = {
      pos: root.querySelector('[data-info="pos"]'),
      zoom: root.querySelector('[data-info="zoom"]'),
      noclip: root.querySelector('[data-info="noclip"]'),
      route: root.querySelector('[data-info="route"]'),
      prototypes: root.querySelector('[data-info="prototypes"]'),
      teleport: root.querySelector('[data-info="teleport"]'),
    };
    this.followBtn = root.querySelector('[data-act="follow"]');
    this.labelsBtn = root.querySelector('[data-act="labels"]');
  }

  _bindEvents() {
    this._resizeHandler = () => { this._syncCanvasSize(); this._staticDirty = true; };

    this.root.querySelector('.dev-map-toolbar').addEventListener('click', (event) => {
      const act = event.target.closest('button')?.dataset.act;
      if (!act) return;
      if (act === 'fit') { this.view.followPlayer = false; this._syncFollowButton(); this.fitNetwork(); }
      else if (act === 'center') this.centerOnPosition();
      else if (act === 'follow') this.setFollow(!this.view.followPlayer);
      else if (act === 'labels') this.setLabels(!this.view.showLabels);
      else if (act === 'close') this.close();
    });

    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this._onPointerCancel(e));
    canvas.addEventListener('pointerleave', () => { if (!this._pointer) this.hovered = null; });
    canvas.addEventListener('dblclick', (e) => { e.preventDefault(); this.centerOnPosition(); });
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // --- Network preparation (static, cached) ---------------------------------

  _prepareNetwork() {
    const raw = this.cb.getNetwork?.();
    if (!raw || !Array.isArray(raw.routes)) { this.network = null; return; }
    // Rebuild only if we have not cached this exact network object yet.
    if (this.network && this.network.source === raw) return;

    const routes = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const route of raw.routes) {
      const pts = route.points || [];
      if (pts.length < 2) continue;
      // Cumulative chord length is used only for the tooltip fallback; the true
      // chainage comes from the uniform arc-length parameterisation below.
      let length = 0;
      const cum = [0];
      for (let i = 1; i < pts.length; i += 1) {
        length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        cum.push(length);
        minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
        minZ = Math.min(minZ, pts[i].z); maxZ = Math.max(maxZ, pts[i].z);
      }
      minX = Math.min(minX, pts[0].x); maxX = Math.max(maxX, pts[0].x);
      minZ = Math.min(minZ, pts[0].z); maxZ = Math.max(maxZ, pts[0].z);
      // getMinimapData() samples curves at uniform arc-length: for an open route
      // of N points there are N-1 segments spanning route.length; a closed route
      // has N points and N segments (the last wraps to the first).
      const segCount = route.closed ? pts.length : pts.length - 1;
      const minor = route.kind === 'ramp' || route.kind === 'service';
      routes.push({
        id: route.id,
        name: route.name || route.label || route.id,
        code: route.code || null,
        kind: route.kind || 'route',
        group: route.group || null,
        groupName: route.groupName || null,
        lanes: route.lanes ?? null,
        direction: route.direction ?? 1,
        oneWay: route.oneWay,
        bidirectional: route.bidirectional,
        closed: !!route.closed,
        color: route.color || '#d6d6d6',
        points: pts,
        cum,
        chordLength: length,
        routeLength: route.length || length,
        segCount,
        minor,
        lineWidth: minor ? 1.6 : (route.width >= 3 ? 3 : 2.3),
      });
    }

    const bounds = raw.bounds && Number.isFinite(raw.bounds.minX)
      ? raw.bounds
      : { minX, maxX, minZ, maxZ };

    this.network = {
      source: raw,
      routes,
      bounds,
      junctions: raw.junctions || [],
      serviceAreas: raw.serviceAreas || [],
      garage: raw.garage || null,
      prototypePins: raw.prototypePins || [],
      // Draw minor roads first so mainlines sit on top.
      drawOrder: [...routes].sort((a, b) => (a.minor === b.minor ? 0 : a.minor ? -1 : 1)),
    };
  }

  // --- Transforms -----------------------------------------------------------

  get cssWidth() { return this.canvas.clientWidth || window.innerWidth; }
  get cssHeight() { return this.canvas.clientHeight || window.innerHeight; }

  worldToScreen(wx, wz) {
    return {
      x: (wx - this.view.camX) * this.view.scale + this.cssWidth / 2,
      y: (wz - this.view.camZ) * this.view.scale + this.cssHeight / 2,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.cssWidth / 2) / this.view.scale + this.view.camX,
      z: (sy - this.cssHeight / 2) / this.view.scale + this.view.camZ,
    };
  }

  _syncCanvasSize() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    this._dpr = dpr;
    const w = Math.round(this.cssWidth * dpr);
    const h = Math.round(this.cssHeight * dpr);
    for (const canvas of [this.canvas, this.staticCanvas]) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
  }

  // --- View controls --------------------------------------------------------

  fitNetwork() {
    if (!this.network) return;
    const b = this.network.bounds;
    const width = Math.max(1, b.maxX - b.minX);
    const height = Math.max(1, b.maxZ - b.minZ);
    const scale = clamp(Math.min(this.cssWidth / width, this.cssHeight / height) * 0.92, MIN_SCALE, MAX_SCALE);
    this.view.scale = scale;
    this.view.camX = (b.minX + b.maxX) / 2;
    this.view.camZ = (b.minZ + b.maxZ) / 2;
    this._staticDirty = true;
  }

  centerOnPosition() {
    const p = this.cb.getCurrentPosition?.();
    if (!p) return;
    this.view.camX = p.x;
    this.view.camZ = p.z;
    this._staticDirty = true;
  }

  /** A readable default zoom that shows ~4 km of network around the marker. */
  _defaultScale() {
    return clamp(Math.min(this.cssWidth, this.cssHeight) / 4000, MIN_SCALE, MAX_SCALE);
  }

  setFollow(on) {
    this.view.followPlayer = !!on;
    this._syncFollowButton();
    if (on) this.centerOnPosition();
  }

  setLabels(on) {
    this.view.showLabels = !!on;
    this.labelsBtn.textContent = `Labels: ${on ? 'ON' : 'OFF'}`;
    this.labelsBtn.setAttribute('aria-pressed', String(!!on));
    this._staticDirty = true;
  }

  _syncFollowButton() {
    this.followBtn.textContent = `Follow: ${this.view.followPlayer ? 'ON' : 'OFF'}`;
    this.followBtn.setAttribute('aria-pressed', String(this.view.followPlayer));
  }

  /** Zoom by `factor` while keeping the world point under (sx, sy) fixed. */
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.view.scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    // Solve for the cam that keeps `before` under the same pixel.
    this.view.camX = before.x - (sx - this.cssWidth / 2) / this.view.scale;
    this.view.camZ = before.z - (sy - this.cssHeight / 2) / this.view.scale;
    this._staticDirty = true;
  }

  // --- Pointer interaction --------------------------------------------------

  _localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  _onPointerDown(event) {
    if (event.button !== 0) return;
    const p = this._localPoint(event);
    if (event.pointerType === 'touch') {
      this._touchPoints.set(event.pointerId, p);
      if (this._touchPoints.size >= 2) {
        const [a, b] = [...this._touchPoints.values()];
        this._pinch = {
          distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
          centerX: (a.x + b.x) * 0.5,
          centerY: (a.y + b.y) * 0.5,
        };
        this._pointer = null;
        if (this.view.followPlayer) this.setFollow(false);
      }
    }
    if (!this._pinch) {
      this._pointer = { id: event.pointerId, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, dragging: false };
    }
    try { this.canvas.setPointerCapture(event.pointerId); } catch (_) { /* pointer already gone */ }
  }

  _onPointerMove(event) {
    const p = this._localPoint(event);
    if (event.pointerType === 'touch' && this._touchPoints.has(event.pointerId)) {
      this._touchPoints.set(event.pointerId, p);
      if (this._pinch && this._touchPoints.size >= 2) {
        const [a, b] = [...this._touchPoints.values()];
        const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const centerX = (a.x + b.x) * 0.5;
        const centerY = (a.y + b.y) * 0.5;
        const anchor = this.screenToWorld(this._pinch.centerX, this._pinch.centerY);
        this.view.scale = clamp(this.view.scale * distance / this._pinch.distance, MIN_SCALE, MAX_SCALE);
        this.view.camX = anchor.x - (centerX - this.cssWidth / 2) / this.view.scale;
        this.view.camZ = anchor.z - (centerY - this.cssHeight / 2) / this.view.scale;
        this._pinch = { distance, centerX, centerY };
        this._staticDirty = true;
        this.hovered = null;
        return;
      }
    }
    if (this._pointer && this._pointer.id === event.pointerId) {
      const dx = p.x - this._pointer.startX;
      const dy = p.y - this._pointer.startY;
      if (!this._pointer.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        this._pointer.dragging = true;
        if (this.view.followPlayer) this.setFollow(false); // a manual pan disables follow
      }
      if (this._pointer.dragging) {
        this.view.camX -= (p.x - this._pointer.lastX) / this.view.scale;
        this.view.camZ -= (p.y - this._pointer.lastY) / this.view.scale;
        this._pointer.lastX = p.x;
        this._pointer.lastY = p.y;
        this._staticDirty = true;
        this.hovered = null;
        return;
      }
    }
    // Plain hover (or a not-yet-dragging press): throttled hit-test.
    const now = performance.now();
    if (now - this._lastHoverAt < HOVER_THROTTLE_MS) return;
    this._lastHoverAt = now;
    this.hovered = this._hitTest(p.x, p.y);
  }

  _onPointerUp(event) {
    const wasPinching = !!this._pinch || this._touchPoints.size > 1;
    if (event.pointerType === 'touch') this._touchPoints.delete(event.pointerId);
    if (this._touchPoints.size < 2) this._pinch = null;
    const pointer = this._pointer;
    this._pointer = null;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch (_) { /* noop */ }
    if (wasPinching || !pointer || pointer.dragging) return; // a drag/pinch never teleports
    const p = this._localPoint(event);
    const hit = this._hitTest(p.x, p.y);
    if (hit) { this.hovered = hit; this._teleport(hit); }
  }

  _onPointerCancel(event) {
    if (event.pointerType === 'touch') this._touchPoints.delete(event.pointerId);
    if (this._touchPoints.size < 2) this._pinch = null;
    this._pointer = null;
  }

  _onWheel(event) {
    event.preventDefault();
    const p = this._localPoint(event);
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.zoomAt(p.x, p.y, factor);
    this.hovered = this._hitTest(p.x, p.y);
  }

  // --- Hit testing ----------------------------------------------------------

  /** First-class, read-only prototype marker hit-test. */
  _hitTestPrototype(sx, sy) {
    if (!this.network?.prototypePins?.length) return null;
    let best = null;
    for (const pin of this.network.prototypePins) {
      const screen = this.worldToScreen(pin.x, pin.z);
      const dist = Math.hypot(sx - screen.x, sy - screen.y);
      if (dist > PIN_HIT_THRESHOLD || (best && dist >= best.dist)) continue;
      const routeId = pin.teleportRouteId || pin.hostRouteId;
      const route = this.network.routes.find((candidate) => candidate.id === routeId);
      if (!route) continue;
      best = {
        kind: 'prototype',
        pin,
        route,
        dist,
        worldX: pin.x,
        worldZ: pin.z,
        elevation: pin.y,
        chainage: pin.distance,
      };
    }
    return best;
  }

  /**
   * Find the nearest visible route segment to a screen point. Works purely in
   * screen space against cached polylines so it is stable at any zoom. When
   * several routes overlap in plan view the one whose elevation is closest to
   * the current camera/vehicle height wins (deterministic multi-level pick).
   */
  _hitTest(sx, sy) {
    if (!this.network) return null;
    const prototype = this._hitTestPrototype(sx, sy);
    if (prototype) return prototype;
    const currentY = this.cb.getCurrentPosition?.()?.y ?? 0;
    let best = null;
    const candidates = [];

    for (const route of this.network.routes) {
      const pts = route.points;
      const n = route.closed ? pts.length : pts.length - 1;
      let localBest = null;
      for (let i = 0; i < n; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const sa = this.worldToScreen(a.x, a.z);
        const sb = this.worldToScreen(b.x, b.z);
        const seg = this._closestOnSegment(sx, sy, sa.x, sa.y, sb.x, sb.y);
        if (!localBest || seg.dist < localBest.dist) {
          localBest = { dist: seg.dist, i, t: seg.t };
        }
      }
      if (!localBest) continue;
      const reach = HIT_THRESHOLD + route.lineWidth;
      if (localBest.dist > reach) continue;
      const a = pts[localBest.i];
      const b = pts[(localBest.i + 1) % pts.length];
      const t = localBest.t;
      const worldX = a.x + (b.x - a.x) * t;
      const worldZ = a.z + (b.z - a.z) * t;
      const elevation = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * t;
      // Uniform arc-length chainage: segment i spans [i, i+1] of segCount.
      const chainage = route.routeLength * (localBest.i + t) / route.segCount;
      candidates.push({
        route, dist: localBest.dist, worldX, worldZ, elevation, chainage,
        elevDelta: Math.abs(elevation - currentY),
      });
    }

    if (!candidates.length) return null;
    candidates.sort((p, q) => p.dist - q.dist);
    const minDist = candidates[0].dist;
    // Among routes that overlap (within the hysteresis band of the closest),
    // prefer the deck whose elevation matches the current height.
    const overlapping = candidates.filter((c) => c.dist <= minDist + HOVER_HYSTERESIS);
    overlapping.sort((p, q) => p.elevDelta - q.elevDelta || p.dist - q.dist);
    best = overlapping[0];

    // Hysteresis: keep the previously hovered route if it is still a near-tie,
    // which stops the tooltip flickering between overlapping decks.
    if (this.hovered) {
      const stay = candidates.find((c) => c.route.id === this.hovered.route.id);
      if (stay && stay.dist <= minDist + HOVER_HYSTERESIS && stay.elevDelta <= best.elevDelta + 0.5) {
        best = stay;
      }
    }
    return best;
  }

  _closestOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = clamp(t, 0, 1);
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    return { dist: Math.hypot(px - cx, py - cy), t };
  }

  // --- Teleport -------------------------------------------------------------

  _teleport(hit) {
    const route = hit.route;
    if (!route) return;
    const prototype = hit.kind === 'prototype' ? hit.pin : null;
    const payload = {
      routeId: route.id,
      routeName: route.name,
      distance: hit.chainage,
      lane: 0,
      direction: route.direction || 1,
      worldX: hit.worldX,
      worldZ: hit.worldZ,
      elevation: hit.elevation,
      prototypeId: prototype?.id || null,
    };
    let result = null;
    try { result = this.cb.teleportToRoutePoint?.(payload) || null; } catch (err) { console.error('Dev-map teleport', err); }
    const target = result || payload;
    const x = target.x ?? payload.worldX;
    const y = target.y ?? payload.elevation;
    const z = target.z ?? payload.worldZ;
    this._teleportInfo = {
      routeName: route.name,
      code: route.code,
      text: `${prototype ? `${prototype.pinId} ${prototype.id} → ` : ''}`
        + `${route.name}${route.code ? ` (${route.code})` : ''} @ ${(payload.distance / 1000).toFixed(2)} km · `
        + `${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}`,
    };
    // Keep the map open so several spots can be inspected in a row.
  }

  // --- Render loop ----------------------------------------------------------

  _loop() {
    if (!this.open_) return;
    if (this.view.followPlayer) this.centerOnPosition();
    if (this._staticDirty) this._drawStatic();
    this._drawDynamic();
    this._updateInfo();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _drawStatic() {
    this._staticDirty = false;
    const ctx = this.staticCtx;
    const dpr = this._dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070b13';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    if (!this.network) return;

    this._drawGrid(ctx);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const route of this.network.drawOrder) {
      this._strokeRoute(ctx, route, route.color, route.lineWidth, route.minor ? 0.8 : 1);
    }

    // Junctions, service areas, garage — context markers, kept subtle.
    for (const junction of this.network.junctions) {
      const s = this.worldToScreen(junction.x, junction.z);
      ctx.fillStyle = 'rgba(255,210,120,0.55)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    this._drawPrototypePins(ctx);
    for (const area of this.network.serviceAreas) {
      const s = this.worldToScreen(area.x, area.z);
      ctx.fillStyle = 'rgba(120,220,180,0.85)';
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
    if (this.network.garage) {
      const g = this.network.garage;
      const s = this.worldToScreen(g.x, g.z);
      ctx.fillStyle = '#ffd34f';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 6);
      ctx.lineTo(s.x + 5, s.y + 4);
      ctx.lineTo(s.x - 5, s.y + 4);
      ctx.closePath();
      ctx.fill();
    }

    if (this.view.showLabels) this._drawLabels(ctx);
  }

  _drawGrid(ctx) {
    // World grid spacing that reads sensibly at the current zoom.
    const targetPx = 120;
    let spacing = 100;
    while (spacing * this.view.scale < targetPx) spacing *= 2;
    while (spacing * this.view.scale > targetPx * 2.4) spacing /= 2;
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.cssWidth, this.cssHeight);
    ctx.strokeStyle = 'rgba(90,120,160,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(tl.x / spacing) * spacing; x <= br.x; x += spacing) {
      const s = this.worldToScreen(x, 0);
      ctx.moveTo(s.x, 0); ctx.lineTo(s.x, this.cssHeight);
    }
    for (let z = Math.floor(tl.z / spacing) * spacing; z <= br.z; z += spacing) {
      const s = this.worldToScreen(0, z);
      ctx.moveTo(0, s.y); ctx.lineTo(this.cssWidth, s.y);
    }
    ctx.stroke();
  }

  _drawPrototypePins(ctx) {
    ctx.save();
    ctx.font = '700 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const pin of this.network.prototypePins) {
      const active = pin.category === 'progressive-prototype';
      const markerColor = active ? '#ff4fd8' : '#d6a84f';
      const labelColor = active ? '#ff7be5' : '#f2ca78';
      const s = this.worldToScreen(pin.x, pin.z);
      if (s.x < -18 || s.x > this.cssWidth + 18 || s.y < -18 || s.y > this.cssHeight + 18) continue;
      ctx.fillStyle = 'rgba(5,8,15,0.86)';
      ctx.fillRect(s.x - 10, s.y - 24, 20, 12);
      ctx.fillStyle = labelColor;
      ctx.fillText(pin.pinId, s.x, s.y - 13);
      ctx.shadowColor = markerColor;
      ctx.shadowBlur = active ? 8 : 3;
      ctx.fillStyle = active ? markerColor : 'rgba(5,8,15,0.94)';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 8);
      ctx.lineTo(s.x + 7, s.y);
      ctx.lineTo(s.x, s.y + 8);
      ctx.lineTo(s.x - 7, s.y);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = active ? '#ffffff' : markerColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  _strokeRoute(ctx, route, color, width, alpha) {
    const pts = route.points;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    const first = this.worldToScreen(pts[0].x, pts[0].z);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i += 1) {
      const s = this.worldToScreen(pts[i].x, pts[i].z);
      ctx.lineTo(s.x, s.y);
    }
    if (route.closed) ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _drawLabels(ctx) {
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const route of this.network.routes) {
      if (route.minor && this.view.scale < 0.9) continue;
      const pts = route.points;
      const mid = pts[Math.floor(pts.length / 2)];
      const s = this.worldToScreen(mid.x, mid.z);
      if (s.x < 0 || s.x > this.cssWidth || s.y < 0 || s.y > this.cssHeight) continue;
      const label = route.code || route.name;
      const w = label.length * 6 + 8;
      const box = { x: s.x - w / 2, y: s.y - 8, w, h: 16 };
      if (placed.some((b) => Math.abs(b.x - box.x) < (b.w + box.w) / 2 && Math.abs(b.y - box.y) < 16)) continue;
      placed.push(box);
      ctx.fillStyle = 'rgba(6,10,18,0.72)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = route.color;
      ctx.fillText(label, s.x, s.y);
    }
  }

  _drawDynamic() {
    const ctx = this.ctx;
    const dpr = this._dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Hovered route highlight, or a distinct prototype-marker halo.
    if (this.hovered?.kind === 'prototype') {
      const s = this.worldToScreen(this.hovered.pin.x, this.hovered.pin.z);
      ctx.shadowColor = '#ff4fd8';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 12);
      ctx.lineTo(s.x + 11, s.y);
      ctx.lineTo(s.x, s.y + 12);
      ctx.lineTo(s.x - 11, s.y);
      ctx.closePath();
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (this.hovered) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      this._strokeRoute(ctx, this.hovered.route, '#ffffff', this.hovered.route.lineWidth + 4, 0.9);
      this._strokeRoute(ctx, this.hovered.route, this.hovered.route.color, this.hovered.route.lineWidth + 1.5, 1);
    }

    this._drawMarker(ctx);
    if (this.hovered) this._drawTooltip(ctx);
  }

  _drawMarker(ctx) {
    const p = this.cb.getCurrentPosition?.();
    if (!p) return;
    const s = this.worldToScreen(p.x, p.z);
    const heading = this.cb.getCurrentHeading?.() ?? 0;
    const noclip = this.cb.isNoclipActive?.();
    const color = noclip ? '#5ad1ff' : '#ff5a7a';

    // Heading arrow. World forward is (sin h, cos h); screen maps +Z to +Y, so
    // the same vector points the arrow the right way on the canvas.
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const len = 20;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + fx * len, s.y + fz * len);
    ctx.stroke();
    // Arrow head.
    const ang = Math.atan2(fz, fx);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(s.x + fx * len, s.y + fz * len);
    ctx.lineTo(s.x + Math.cos(ang - 2.6) * 8 + fx * len, s.y + Math.sin(ang - 2.6) * 8 + fz * len);
    ctx.lineTo(s.x + Math.cos(ang + 2.6) * 8 + fx * len, s.y + Math.sin(ang + 2.6) * 8 + fz * len);
    ctx.closePath();
    ctx.fill();
    // Marker dot with a halo so it stays visible over any road.
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2); ctx.stroke();
  }

  _drawTooltip(ctx) {
    const h = this.hovered;
    if (h.kind === 'prototype') {
      this._drawPrototypeTooltip(ctx, h);
      return;
    }
    const route = h.route;
    const lines = [];
    lines.push(route.name + (route.code ? `  [${route.code}]` : ''));
    lines.push(`id: ${route.id}`);
    if (route.groupName || route.group) lines.push(`group: ${route.groupName || route.group}`);
    lines.push(`kind: ${route.kind}${route.lanes != null ? ` · ${route.lanes} lane${route.lanes === 1 ? '' : 's'}` : ''}`);
    lines.push(`dir: ${route.bidirectional ? 'two-way' : (route.direction < 0 ? 'reverse' : 'forward')}`);
    lines.push(`chainage: ${(h.chainage / 1000).toFixed(2)} km / ${(route.routeLength / 1000).toFixed(2)} km`);
    lines.push(`elev: ${h.elevation.toFixed(1)} m`);
    lines.push(`world: ${h.worldX.toFixed(0)}, ${h.worldZ.toFixed(0)}`);

    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const pad = 8;
    const lineH = 15;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const boxH = lines.length * lineH + pad * 2;
    const s = this.worldToScreen(h.worldX, h.worldZ);
    let bx = s.x + 14;
    let by = s.y + 14;
    if (bx + w > this.cssWidth) bx = s.x - w - 14;
    if (by + boxH > this.cssHeight) by = this.cssHeight - boxH - 4;
    if (by < 4) by = 4;

    ctx.fillStyle = 'rgba(6,10,18,0.92)';
    ctx.strokeStyle = route.color;
    ctx.lineWidth = 1.5;
    ctx.fillRect(bx, by, w, boxH);
    ctx.strokeRect(bx, by, w, boxH);
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillStyle = i === 0 ? route.color : '#dbe6f5';
      ctx.fillText(lines[i], bx + pad, by + pad + i * lineH);
    }
  }

  _drawPrototypeTooltip(ctx, hit) {
    const pin = hit.pin;
    const active = pin.category === 'progressive-prototype';
    const title = active ? 'ACTIVE PROGRESSIVE PROTOTYPE' : 'DEFERRED / MANUAL REVIEW';
    const lines = [
      `${pin.pinId}  ${title}`,
      `junction: ${pin.id}`,
      `host: ${pin.hostRouteId} · ${pin.hostLaneCount} lanes`,
      `branch: ${pin.branchRouteId} · ${pin.branchLaneCount} lanes`,
      `${pin.type} · ${pin.side}`,
      `status: ${pin.status}`,
      `class: ${pin.classification}`,
      ...(active && pin.phases ? [
        `phases: ${pin.phases.approachStart.toFixed(0)} / ${pin.phases.openingStart.toFixed(0)} / ${pin.phases.parallelStart.toFixed(0)}`,
        `        ${pin.phases.absorptionStart.toFixed(0)} / ${pin.phases.transitionEnd.toFixed(0)} m`,
      ] : []),
      ...(!active && pin.classificationReason ? [`reason: ${pin.classificationReason}`] : []),
      `click: teleport to ${pin.teleportRouteId || pin.hostRouteId}`,
      `world: ${pin.x.toFixed(0)}, ${pin.y.toFixed(0)}, ${pin.z.toFixed(0)}`,
    ];
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const pad = 8;
    const lineH = 15;
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + pad * 2;
    const height = lines.length * lineH + pad * 2;
    const screen = this.worldToScreen(pin.x, pin.z);
    let x = screen.x + 16;
    let y = screen.y + 16;
    if (x + width > this.cssWidth) x = screen.x - width - 16;
    if (y + height > this.cssHeight) y = this.cssHeight - height - 4;
    if (y < 4) y = 4;
    ctx.fillStyle = active ? 'rgba(15,6,18,0.94)' : 'rgba(18,14,6,0.95)';
    ctx.strokeStyle = active ? '#ff4fd8' : '#d6a84f';
    ctx.lineWidth = 1.5;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    for (let index = 0; index < lines.length; index += 1) {
      ctx.fillStyle = index === 0 ? (active ? '#ff7be5' : '#f2ca78') : '#f5e7f4';
      ctx.fillText(lines[index], x + pad, y + pad + index * lineH);
    }
  }

  _updateInfo() {
    const p = this.cb.getCurrentPosition?.();
    const noclip = this.cb.isNoclipActive?.();
    if (p) this.info.pos.textContent = `${p.x.toFixed(1)}, ${(p.y ?? 0).toFixed(1)}, ${p.z.toFixed(1)}`;
    this.info.zoom.textContent = `${this.view.scale.toFixed(2)} px/m`;
    this.info.noclip.textContent = noclip ? 'ENABLED (drone)' : 'disabled';
    this.info.noclip.classList.toggle('is-on', !!noclip);
    const pins = this.network?.prototypePins || [];
    const hoveredPin = this.hovered?.kind === 'prototype' ? this.hovered.pin : null;
    const activePinCount = pins.filter((pin) => pin.category === 'progressive-prototype').length;
    const deferredPinCount = pins.length - activePinCount;
    this.info.prototypes.textContent = hoveredPin
      ? `${hoveredPin.pinId} ${hoveredPin.id} · ${hoveredPin.type}/${hoveredPin.side} · `
        + `${hoveredPin.hostRouteId} ${hoveredPin.hostLaneCount}L + `
        + `${hoveredPin.branchRouteId} ${hoveredPin.branchLaneCount}L · ${hoveredPin.status}`
      : (pins.length
        ? `${activePinCount} active · ${deferredPinCount} deferred (${pins.map((pin) => pin.pinId).join(', ')})`
        : 'none');
    this.info.teleport.textContent = this._teleportInfo ? this._teleportInfo.text : '—';
    // The current-route lookup is a network search; refresh it a few times a
    // second rather than every frame.
    const now = performance.now();
    if (now - (this._lastRouteAt || 0) > 200) {
      this._lastRouteAt = now;
      const route = this.cb.getCurrentRoute?.();
      this.info.route.textContent = route ? String(route) : '—';
    }
  }
}

export default DeveloperMap;
