// Low-overhead performance HUD and structured diagnostic recorder.
//
// I toggles the HUD. P starts/stops a recording. O adds a manual marker while
// recording. Stopping downloads the complete JSON report and copies a compact,
// AI-readable summary to the clipboard.

const SCHEMA = 'hesi.diagnostic-recording';
const SCHEMA_VERSION = 3;
const RING = 240;
const PANEL_REFRESH_MS = 250;
const SCENE_SCAN_MS = 1000;
const SAMPLE_MS = 250;
const PANEL_SPIKE_MS = 40;
const RECORDED_SPIKE_MS = 33.34;
const MAX_TIMELINE_ROWS = 86400; // six hours at 4 Hz
const MAX_SPIKES = 12000; // reservoir sampled after this limit
const MAX_EVENTS = 12000;
const MAX_LONG_TASKS = 6000;
const MAX_RESOURCES = 4000;
const HISTOGRAM_MAX_MS = 2000;
const PROFILE_KEYS = ['phys', 'traffic', 'map', 'render', 'persist', 'other'];

export const SAMPLE_COLUMNS = Object.freeze([
  'time_s', 'interval_ms', 'frame_count',
  'mode', 'route_id', 'route_name', 'area',
  'fps', 'frame_ms_avg', 'frame_ms_p50', 'frame_ms_p95', 'frame_ms_p99', 'frame_ms_max',
  'frames_gt_25ms', 'frames_gt_33ms', 'frames_gt_50ms', 'frames_gt_100ms',
  'cpu_ms_avg', 'cpu_ms_max', 'raf_gap_ms_avg',
  'phys_ms_avg', 'traffic_ms_avg', 'map_ms_avg', 'render_ms_avg', 'save_ms_avg', 'other_ms_avg',
  'worst_phys_ms', 'worst_traffic_ms', 'worst_map_ms', 'worst_render_ms', 'worst_save_ms', 'worst_other_ms',
  'draw_calls', 'triangles', 'lines', 'points',
  'geometries', 'textures', 'programs', 'd_geometries', 'd_textures', 'd_programs',
  'scene_objects', 'scene_meshes', 'scene_visible_meshes', 'scene_instances', 'scene_lights', 'scene_materials',
  'chunks_visible', 'chunks_total',
  'traffic_active', 'traffic_visible', 'traffic_cars', 'traffic_vans', 'traffic_trucks',
  'traffic_density', 'traffic_lane_change', 'traffic_speed_factor', 'time_scale',
  'heap_used_mb', 'heap_total_mb', 'heap_limit_mb',
  'long_task_count', 'long_task_ms',
  'pos_x', 'pos_y', 'pos_z', 'heading_rad', 'speed_kmh', 'rpm', 'gear',
  'forward_speed_ms', 'lateral_speed_ms', 'yaw_rate_rads',
  'longitudinal_accel_ms2', 'lateral_accel_ms2', 'steering_angle_rad',
  'front_slip_deg', 'rear_slip_deg', 'front_saturation', 'rear_saturation',
  'front_wheel_lock', 'rear_wheel_lock', 'wheel_spin', 'body_roll_rad', 'body_pitch_rad',
  'engine_torque_nm', 'drive_force_n', 'distance_travelled_m',
  'throttle', 'brake', 'steer', 'handbrake', 'slip', 'surface_grip',
  'lateral_offset', 'road_half_width', 'on_road', 'tunnel',
  'score', 'combo', 'lives', 'fuel_l', 'fuel_pct', 'camera', 'ui_overlay',
]);

export const SPIKE_COLUMNS = Object.freeze([
  'time_s', 'frame_ms', 'cpu_ms', 'raf_gap_ms',
  'phys_ms', 'traffic_ms', 'map_ms', 'render_ms', 'save_ms', 'other_ms',
  'mode', 'route_id', 'pos_x', 'pos_y', 'pos_z', 'speed_kmh',
  'draw_calls', 'triangles', 'geometries', 'textures', 'programs', 'heap_used_mb',
]);

const SAMPLE_INDEX = Object.freeze(Object.fromEntries(SAMPLE_COLUMNS.map((name, index) => [name, index])));
const mb = (bytes) => Math.round(bytes / 1048576 * 10) / 10;
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 2) => {
  const number = finite(value);
  if (number == null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
};
const fmt = (value, digits = 1) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
  : '—';
const safeString = (value, limit = 1000) => String(value ?? '').slice(0, limit);

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function createWindow() {
  return {
    frames: [],
    profileSums: Object.fromEntries(PROFILE_KEYS.map((key) => [key, 0])),
    cpuSum: 0,
    cpuMax: 0,
    gapSum: 0,
    profileCount: 0,
    worst: null,
    longTaskCount: 0,
    longTaskMs: 0,
  };
}

function createAggregate() {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: 0,
    over25: 0,
    over33: 0,
    over50: 0,
    over100: 0,
    over250: 0,
    excess16: 0,
    histogram: new Uint32Array(HISTOGRAM_MAX_MS + 1),
    profileCount: 0,
    cpuSum: 0,
    cpuMax: 0,
    gapSum: 0,
    profileSums: Object.fromEntries(PROFILE_KEYS.map((key) => [key, 0])),
  };
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? value.slice(0, 4000) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth > 4) return '[max-depth]';
  if (value instanceof Error) {
    return { name: value.name, message: safeString(value.message, 2000), stack: safeString(value.stack, 8000) };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
      return { x: round(value.x, 3), y: round(value.y, 3), z: round(value.z, 3) };
    }
    if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitize(item, depth + 1, seen));
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      const clean = sanitize(item, depth + 1, seen);
      if (clean !== undefined) output[key] = clean;
    }
    return output;
  }
  return safeString(value);
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = String(getKey(item) ?? 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export class DebugStats {
  constructor({
    renderer = null,
    getSnapshot = () => ({}),
    getMetadata = () => ({}),
    toast = () => {},
  } = {}) {
    this.renderer = renderer;
    this.getSnapshot = getSnapshot;
    this.getMetadata = getMetadata;
    this.toast = toast;
    this.visible = false;
    this.recording = null;
    this.lastReport = null;
    this.lastJson = '';
    this.lastLog = '';
    this.lastFilename = '';
    this.frameTimes = new Float32Array(RING);
    this.frameIndex = 0;
    this.frameCount = 0;
    this.lastFrameAt = 0;
    this.lastPanelRefresh = 0;
    this.lastSceneScan = 0;
    this.sceneCounts = {
      objects: 0, meshes: 0, visibleMeshes: 0, instances: 0, lights: 0, materials: 0,
    };
    this.lastSpike = null;
    this.root = null;
    this.badge = null;
    this.fallback = null;
    this._longTaskObserver = null;
    this._resourceObserver = null;
    this._consoleOriginals = null;
    this._consoleWrappers = null;
    this._onWindowError = (event) => this._captureWindowError(event);
    this._onUnhandledRejection = (event) => this.event('unhandled_rejection', {
      reason: sanitize(event?.reason),
    });
    this._onVisibilityChange = () => this.event('visibility_change', {
      state: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    });
    this._onOnline = () => this.event('network_state', { online: true });
    this._onOffline = () => this.event('network_state', { online: false });
    this._onContextLost = (event) => this.event('webgl_context_lost', {
      status_message: event?.statusMessage || null,
    });
    this._onContextRestored = () => this.event('webgl_context_restored');
  }

  isVisible() { return this.visible; }
  isRecording() { return !!this.recording; }

  toggle(force = null) {
    this.visible = force ?? !this.visible;
    this._ensureDom();
    this.root.style.display = this.visible ? 'block' : 'none';
    if (this.visible) this._refreshPanel(performance.now(), true);
  }

  toggleRecording() {
    if (this.recording) {
      this._stopRecording();
      return;
    }
    this._startRecording();
  }

  mark(label = 'manual') {
    if (!this.recording) {
      this.toast('DIAG REC is not running // P starts it', 'amber');
      return false;
    }
    this.event('manual_marker', { label: safeString(label, 120) });
    this.toast(`DIAG MARK // ${safeString(label, 60)}`, 'amber');
    return true;
  }

  /**
   * Records a sparse, structured game event. Values are sanitized so callers
   * may safely pass errors, vectors, or ordinary event payloads.
   */
  event(type, data = {}) {
    const rec = this.recording;
    if (!rec) return false;
    if (rec.events.length >= MAX_EVENTS) {
      rec.dropped.events += 1;
      return false;
    }
    rec.events.push({
      time_s: round((performance.now() - rec.startedAt) / 1000, 3),
      type: safeString(type || 'event', 100),
      context: this._eventContext(rec.lastContext),
      data: sanitize(data),
    });
    return true;
  }

  /**
   * Call once after every rendered frame. The idle path is one clock read and
   * one ring-buffer write. Recording adds only numeric aggregation; game-state
   * snapshots and scene scans stay on the 250/1000 ms sampling cadence.
   */
  frame(profile = null) {
    const now = performance.now();
    if (this.lastFrameAt) {
      const delta = now - this.lastFrameAt;
      this.frameTimes[this.frameIndex] = delta;
      this.frameIndex = (this.frameIndex + 1) % RING;
      this.frameCount += 1;
      // Avoid allocating a normalized profile on the normal idle path. We only
      // need it for an active recording or for the sparse spike HUD update.
      const needsProfile = !!profile && (this.recording || delta > PANEL_SPIKE_MS);
      const normalized = needsProfile ? this._normalizeProfile(profile, delta) : null;
      if (normalized && delta > PANEL_SPIKE_MS) this.lastSpike = this._copyProfile(normalized, delta, now);
      if (this.recording) this._recordFrame(delta, normalized, now);
    }
    this.lastFrameAt = now;
    if (this.recording && now - this.recording.lastFlush >= SAMPLE_MS) {
      this._flushSample(now);
      this._updateBadge(now);
    }
    if (this.visible && now - this.lastPanelRefresh >= PANEL_REFRESH_MS) this._refreshPanel(now);
  }

  downloadLastReport() {
    if (!this.lastJson) return false;
    return this._downloadJson(this.lastJson, this.lastFilename || this._filename());
  }

  copyLastSummary() {
    if (!this.lastLog) return Promise.resolve(false);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(this.lastLog).then(() => true, () => false);
    }
    this._showFallback();
    return Promise.resolve(false);
  }

  dispose() {
    this._stopObservers();
    this.recording = null;
    this.root?.remove();
    this.badge?.remove();
    this.fallback?.remove();
    this.root = this.badge = this.fallback = null;
  }

  // ---------------------------------------------------------------- recording

  _startRecording() {
    const now = performance.now();
    const snapshot = this._safeSnapshot();
    const memory = this._rendererMemory();
    const heap = this._heap();
    this.recording = {
      id: this._sessionId(),
      startedAt: now,
      startedIso: new Date().toISOString(),
      lastFlush: now,
      lastContext: this._makeContext(snapshot, { memory, heap, render: this._rendererCounters() }),
      initialSnapshot: this._snapshotForMetadata(snapshot),
      gameMetadata: sanitize(this._safeMetadata()),
      window: createWindow(),
      aggregate: createAggregate(),
      modes: new Map(),
      routes: new Map(),
      timeline: [],
      spikes: [],
      spikeSeen: 0,
      events: [],
      longTasks: [],
      resources: [],
      memoryAtFlush: memory,
      resourceGrowth: { geometries: 0, textures: 0, programs: 0 },
      resourceDrops: { geometries: 0, textures: 0, programs: 0 },
      heapStartMb: heap?.used ?? null,
      heapPeakMb: heap?.used ?? null,
      maxSpeedKmh: 0,
      speedSum: 0,
      speedSamples: 0,
      dropped: { timeline: 0, spikes: 0, events: 0, longTasks: 0, resources: 0 },
    };
    this._startObservers();
    this.event('recording_started', { sample_period_ms: SAMPLE_MS, spike_threshold_ms: RECORDED_SPIKE_MS });
    this._ensureDom();
    this._updateBadge(now);
    this.toast('DIAG REC started // P exports · O marks a moment', 'amber');
  }

  _stopRecording() {
    const rec = this.recording;
    if (!rec) return;
    const now = performance.now();
    if (rec.window.frames.length || !rec.timeline.length) this._flushSample(now);
    this.event('recording_stopped');
    this._stopObservers();
    rec.endedAt = now;
    rec.endedIso = new Date().toISOString();
    const report = this._buildReport(rec);
    // Tuple-encoded timelines are intentionally compact; indentation can more
    // than double a long-session report without adding machine readability.
    const json = JSON.stringify(report);
    const filename = this._filename(rec.startedIso);
    this.lastReport = report;
    this.lastJson = json;
    this.lastFilename = filename;
    this.lastLog = this._buildClipboardSummary(report, filename);
    const rows = rec.timeline.length;
    this.recording = null;
    this._updateBadge(now);
    const downloaded = this._downloadJson(json, filename);
    this._copySummary(rows, downloaded);
  }

  _recordFrame(delta, profile, now) {
    const rec = this.recording;
    const window = rec.window;
    window.frames.push(delta);
    if (profile) {
      window.profileCount += 1;
      window.cpuSum += profile.total;
      window.cpuMax = Math.max(window.cpuMax, profile.total);
      window.gapSum += Math.max(0, delta - profile.total);
      for (const key of PROFILE_KEYS) window.profileSums[key] += profile[key];
      if (!window.worst || delta > window.worst.delta) window.worst = this._copyProfile(profile, delta, now);
    }
    this._addAggregate(rec.aggregate, delta, profile);
    this._addAggregate(this._group(rec.modes, rec.lastContext?.mode), delta, profile);
    this._addAggregate(this._group(rec.routes, rec.lastContext?.routeId), delta, profile);
    if (delta >= RECORDED_SPIKE_MS) this._recordSpike(delta, profile, now);
  }

  _recordSpike(delta, profile, now) {
    const rec = this.recording;
    const context = rec.lastContext || {};
    const row = [
      round((now - rec.startedAt) / 1000, 3),
      round(delta), round(profile?.total ?? 0), round(Math.max(0, delta - (profile?.total ?? 0))),
      ...PROFILE_KEYS.map((key) => round(profile?.[key] ?? 0)),
      context.mode ?? null, context.routeId ?? null,
      round(context.x, 2), round(context.y, 2), round(context.z, 2), round(context.speedKmh, 1),
      context.drawCalls ?? null, context.triangles ?? null,
      context.geometries ?? null, context.textures ?? null, context.programs ?? null,
      context.heapUsedMb ?? null,
    ];
    rec.spikeSeen += 1;
    if (rec.spikes.length < MAX_SPIKES) {
      rec.spikes.push(row);
      return;
    }
    // Reservoir sampling keeps spike coverage representative during very long
    // or persistently slow sessions instead of retaining only the beginning.
    const slot = Math.floor(Math.random() * rec.spikeSeen);
    if (slot < MAX_SPIKES) rec.spikes[slot] = row;
    rec.dropped.spikes += 1;
  }

  _flushSample(now) {
    const rec = this.recording;
    if (!rec) return;
    const window = rec.window;
    const elapsed = Math.max(0, now - rec.lastFlush);
    const sample = this._sample(now, window.frames);
    const snap = sample.snapshot;
    const frame = sample.frame;
    const profileDivisor = Math.max(1, window.profileCount);
    const previousMemory = rec.memoryAtFlush;
    const memoryDelta = {
      geometries: sample.memory.geometries - previousMemory.geometries,
      textures: sample.memory.textures - previousMemory.textures,
      programs: sample.memory.programs - previousMemory.programs,
    };
    for (const key of Object.keys(memoryDelta)) {
      rec.resourceGrowth[key] += Math.max(0, memoryDelta[key]);
      rec.resourceDrops[key] += Math.max(0, -memoryDelta[key]);
    }
    rec.memoryAtFlush = { ...sample.memory };
    const worst = window.worst;
    const row = [
      round((now - rec.startedAt) / 1000, 3), round(elapsed), window.frames.length,
      snap.mode ?? null, snap.route ?? null, snap.routeName ?? null, snap.area ?? null,
      round(frame.fps, 1), round(frame.avg), round(frame.p50), round(frame.p95), round(frame.p99), round(frame.max),
      frame.over25, frame.over33, frame.over50, frame.over100,
      round(window.cpuSum / profileDivisor), round(window.cpuMax), round(window.gapSum / profileDivisor),
      ...PROFILE_KEYS.map((key) => round(window.profileSums[key] / profileDivisor)),
      ...PROFILE_KEYS.map((key) => round(worst?.[key] ?? 0)),
      sample.render.calls, sample.render.triangles, sample.render.lines, sample.render.points,
      sample.memory.geometries, sample.memory.textures, sample.memory.programs,
      memoryDelta.geometries, memoryDelta.textures, memoryDelta.programs,
      sample.scene.objects, sample.scene.meshes, sample.scene.visibleMeshes, sample.scene.instances,
      sample.scene.lights, sample.scene.materials,
      snap.chunksVisible ?? null, snap.chunksTotal ?? null,
      snap.traffic ?? null, snap.trafficVisible ?? null, snap.trafficCars ?? null,
      snap.trafficVans ?? null, snap.trafficTrucks ?? null,
      round(snap.trafficDensity, 3), round(snap.trafficLaneChange, 3), round(snap.trafficSpeed, 3), round(snap.timeScale, 3),
      sample.heap?.used ?? null, sample.heap?.total ?? null, sample.heap?.limit ?? null,
      window.longTaskCount, round(window.longTaskMs),
      round(snap.x, 2), round(snap.y, 2), round(snap.z, 2), round(snap.heading, 4),
      round(snap.speedKmh, 1), round(snap.rpm, 0), snap.gear ?? null,
      round(snap.forwardSpeed, 3), round(snap.lateralSpeed, 3), round(snap.yawRate, 4),
      round(snap.longitudinalAcceleration, 3), round(snap.lateralAcceleration, 3), round(snap.steeringAngle, 4),
      round(snap.frontSlipDegrees, 3), round(snap.rearSlipDegrees, 3),
      round(snap.frontSaturation, 3), round(snap.rearSaturation, 3),
      round(snap.frontWheelLock, 3), round(snap.rearWheelLock, 3), round(snap.wheelSpin, 3),
      round(snap.bodyRoll, 4), round(snap.bodyPitch, 4),
      round(snap.engineTorque, 2), round(snap.driveForce, 1), round(snap.distanceTravelled, 1),
      round(snap.throttle, 3), round(snap.brake, 3), round(snap.steer, 3),
      snap.handbrake == null ? null : Number(!!snap.handbrake), round(snap.slip, 4), round(snap.surfaceGrip, 3),
      round(snap.lateralOffset, 2), round(snap.roadHalfWidth, 2),
      snap.onRoad == null ? null : Number(!!snap.onRoad), snap.tunnel == null ? null : Number(!!snap.tunnel),
      round(snap.score, 0), round(snap.combo, 2), snap.lives ?? null,
      round(snap.fuel, 2), round(snap.fuelPct, 2), snap.camera ?? null, snap.uiOverlay ?? null,
    ];
    if (rec.timeline.length < MAX_TIMELINE_ROWS) rec.timeline.push(row);
    else rec.dropped.timeline += 1;
    if (sample.heap?.used != null) {
      rec.heapPeakMb = Math.max(rec.heapPeakMb ?? sample.heap.used, sample.heap.used);
    }
    if (Number.isFinite(snap.speedKmh) && snap.mode === 'driving') {
      rec.maxSpeedKmh = Math.max(rec.maxSpeedKmh, snap.speedKmh);
      rec.speedSum += snap.speedKmh;
      rec.speedSamples += 1;
    }
    const nextContext = this._makeContext(snap, sample);
    this._detectTransitions(rec.lastContext, nextContext, now);
    rec.lastContext = nextContext;
    rec.lastFlush = now;
    rec.window = createWindow();
  }

  // ---------------------------------------------------------------- sampling

  _normalizeProfile(profile, delta) {
    if (!profile) return null;
    const output = {};
    for (const key of PROFILE_KEYS) output[key] = Math.max(0, finite(profile[key], 0));
    output.total = Math.max(0, finite(profile.total, PROFILE_KEYS.reduce((sum, key) => sum + output[key], 0)));
    output.gap = Math.max(0, delta - output.total);
    return output;
  }

  _copyProfile(profile, delta, now) {
    return {
      delta,
      at: now,
      ...Object.fromEntries(PROFILE_KEYS.map((key) => [key, profile?.[key] ?? 0])),
      total: profile?.total ?? 0,
      gap: profile?.gap ?? Math.max(0, delta - (profile?.total ?? 0)),
    };
  }

  _frameStats(deltas) {
    if (!deltas.length) {
      return {
        fps: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0,
        over25: 0, over33: 0, over50: 0, over100: 0,
      };
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const avg = sum / sorted.length;
    return {
      fps: avg > 0 ? 1000 / avg : 0,
      avg,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      over25: sorted.filter((value) => value > 25).length,
      over33: sorted.filter((value) => value > 33.34).length,
      over50: sorted.filter((value) => value > 50).length,
      over100: sorted.filter((value) => value > 100).length,
    };
  }

  _recentDeltas() {
    const count = Math.min(this.frameCount, RING);
    const deltas = [];
    for (let i = 0; i < count; i += 1) {
      deltas.push(this.frameTimes[(this.frameIndex - 1 - i + RING * 2) % RING]);
    }
    return deltas;
  }

  _scanScene(scene, now) {
    if (now - this.lastSceneScan < SCENE_SCAN_MS) return this.sceneCounts;
    this.lastSceneScan = now;
    const counts = {
      objects: 0, meshes: 0, visibleMeshes: 0, instances: 0, lights: 0, materials: 0,
    };
    const materials = new Set();
    if (scene?.traverse) {
      scene.traverse((object) => {
        counts.objects += 1;
        if (object.isLight) counts.lights += 1;
        if (object.isMesh || object.isInstancedMesh) {
          counts.meshes += 1;
          if (object.isInstancedMesh) counts.instances += object.count || 0;
          for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
            if (material) materials.add(material);
          }
        }
      });
      scene.traverseVisible?.((object) => {
        if (object.isMesh || object.isInstancedMesh) counts.visibleMeshes += 1;
      });
    }
    counts.materials = materials.size;
    this.sceneCounts = counts;
    return counts;
  }

  _sample(now, deltas) {
    const snapshot = this._safeSnapshot();
    return {
      snapshot,
      frame: this._frameStats(deltas),
      scene: this._scanScene(snapshot.scene, now),
      render: this._rendererCounters(),
      memory: this._rendererMemory(),
      heap: this._heap(),
    };
  }

  _safeSnapshot() {
    try {
      return this.getSnapshot?.() || {};
    } catch (error) {
      this.event('snapshot_error', { error });
      return {};
    }
  }

  _safeMetadata() {
    try {
      return this.getMetadata?.() || {};
    } catch (error) {
      this.event('metadata_error', { error });
      return {};
    }
  }

  _rendererCounters() {
    const render = this.renderer?.info?.render;
    return {
      calls: render?.calls ?? 0,
      triangles: render?.triangles ?? 0,
      lines: render?.lines ?? 0,
      points: render?.points ?? 0,
    };
  }

  _rendererMemory() {
    const info = this.renderer?.info;
    return {
      geometries: info?.memory?.geometries ?? 0,
      textures: info?.memory?.textures ?? 0,
      programs: info?.programs?.length ?? 0,
    };
  }

  _heap() {
    const heap = typeof performance !== 'undefined' ? performance.memory : null;
    return heap ? {
      used: mb(heap.usedJSHeapSize),
      total: mb(heap.totalJSHeapSize),
      limit: mb(heap.jsHeapSizeLimit),
    } : null;
  }

  _makeContext(snapshot, sample = {}) {
    return {
      mode: snapshot.mode ?? null,
      routeId: snapshot.route ?? null,
      quality: snapshot.quality ?? null,
      resolution: snapshot.resolution ?? null,
      x: finite(snapshot.x),
      y: finite(snapshot.y),
      z: finite(snapshot.z),
      speedKmh: finite(snapshot.speedKmh, 0),
      drawCalls: sample.render?.calls ?? null,
      triangles: sample.render?.triangles ?? null,
      geometries: sample.memory?.geometries ?? null,
      textures: sample.memory?.textures ?? null,
      programs: sample.memory?.programs ?? null,
      heapUsedMb: sample.heap?.used ?? null,
    };
  }

  _eventContext(context = {}) {
    return {
      mode: context?.mode ?? null,
      route_id: context?.routeId ?? null,
      pos_x: round(context?.x, 2),
      pos_y: round(context?.y, 2),
      pos_z: round(context?.z, 2),
      speed_kmh: round(context?.speedKmh, 1),
    };
  }

  _detectTransitions(previous, next, now) {
    if (!previous || !next) return;
    const rec = this.recording;
    const push = (type, data) => {
      if (rec.events.length >= MAX_EVENTS) {
        rec.dropped.events += 1;
        return;
      }
      rec.events.push({
        time_s: round((now - rec.startedAt) / 1000, 3),
        type,
        context: this._eventContext(next),
        data,
      });
    };
    if (previous.mode !== next.mode) push('mode_change', { from: previous.mode, to: next.mode });
    if (previous.routeId !== next.routeId) push('route_change', { from: previous.routeId, to: next.routeId });
    if (previous.quality !== next.quality || previous.resolution !== next.resolution) {
      push('render_configuration_change', {
        quality_from: previous.quality,
        quality_to: next.quality,
        resolution_from: previous.resolution,
        resolution_to: next.resolution,
      });
    }
  }

  // -------------------------------------------------------------- aggregation

  _group(map, value) {
    const key = String(value ?? 'unknown');
    if (!map.has(key)) map.set(key, createAggregate());
    return map.get(key);
  }

  _addAggregate(aggregate, delta, profile) {
    aggregate.count += 1;
    aggregate.sum += delta;
    aggregate.min = Math.min(aggregate.min, delta);
    aggregate.max = Math.max(aggregate.max, delta);
    if (delta > 25) aggregate.over25 += 1;
    if (delta > 33.34) aggregate.over33 += 1;
    if (delta > 50) aggregate.over50 += 1;
    if (delta > 100) aggregate.over100 += 1;
    if (delta > 250) aggregate.over250 += 1;
    aggregate.excess16 += Math.max(0, delta - 16.67);
    aggregate.histogram[Math.min(HISTOGRAM_MAX_MS, Math.max(0, Math.round(delta)))] += 1;
    if (!profile) return;
    aggregate.profileCount += 1;
    aggregate.cpuSum += profile.total;
    aggregate.cpuMax = Math.max(aggregate.cpuMax, profile.total);
    aggregate.gapSum += Math.max(0, delta - profile.total);
    for (const key of PROFILE_KEYS) aggregate.profileSums[key] += profile[key];
  }

  _histogramPercentile(aggregate, fraction) {
    if (!aggregate.count) return 0;
    const target = Math.max(1, Math.ceil(aggregate.count * fraction));
    let seen = 0;
    for (let i = 0; i < aggregate.histogram.length; i += 1) {
      seen += aggregate.histogram[i];
      if (seen >= target) return i;
    }
    return HISTOGRAM_MAX_MS;
  }

  _exportAggregate(aggregate) {
    const frames = aggregate.count;
    const profiled = Math.max(1, aggregate.profileCount);
    const average = frames ? aggregate.sum / frames : 0;
    return {
      frames,
      fps_average: round(average ? 1000 / average : 0, 1),
      frame_ms: {
        average: round(average),
        p50: this._histogramPercentile(aggregate, 0.5),
        p95: this._histogramPercentile(aggregate, 0.95),
        p99: this._histogramPercentile(aggregate, 0.99),
        p99_9: this._histogramPercentile(aggregate, 0.999),
        max: round(aggregate.max),
        min: frames ? round(aggregate.min) : 0,
      },
      slow_frames: {
        over_25ms: aggregate.over25,
        over_33ms: aggregate.over33,
        over_50ms: aggregate.over50,
        over_100ms: aggregate.over100,
        over_250ms: aggregate.over250,
        percent_over_33ms: round(frames ? aggregate.over33 / frames * 100 : 0, 3),
        excess_time_over_16_67ms: round(aggregate.excess16),
      },
      cpu_ms: {
        average: round(aggregate.cpuSum / profiled),
        max: round(aggregate.cpuMax),
        raf_gap_average: round(aggregate.gapSum / profiled),
        subsystems_average: Object.fromEntries(PROFILE_KEYS.map((key) => [
          key === 'persist' ? 'save' : key,
          round(aggregate.profileSums[key] / profiled),
        ])),
      },
    };
  }

  _buildSummary(rec) {
    const framePacing = this._exportAggregate(rec.aggregate);
    const samples = rec.timeline;
    const heapEnd = samples.length ? samples[samples.length - 1][SAMPLE_INDEX.heap_used_mb] : rec.heapStartMb;
    const eventCounts = countBy(rec.events, (event) => event.type);
    const modes = [...rec.modes.entries()]
      .map(([name, aggregate]) => ({ name, ...this._exportAggregate(aggregate) }))
      .sort((a, b) => b.frames - a.frames);
    const routes = [...rec.routes.entries()]
      .map(([id, aggregate]) => ({ id, ...this._exportAggregate(aggregate) }))
      .sort((a, b) => (b.frame_ms.p95 - a.frame_ms.p95) || (b.frames - a.frames));
    const worstWindows = [...samples]
      .sort((a, b) => (b[SAMPLE_INDEX.frame_ms_max] || 0) - (a[SAMPLE_INDEX.frame_ms_max] || 0))
      .slice(0, 15)
      .map((row) => ({
        time_s: row[SAMPLE_INDEX.time_s],
        route_id: row[SAMPLE_INDEX.route_id],
        pos_x: row[SAMPLE_INDEX.pos_x],
        pos_z: row[SAMPLE_INDEX.pos_z],
        speed_kmh: row[SAMPLE_INDEX.speed_kmh],
        frame_ms_max: row[SAMPLE_INDEX.frame_ms_max],
        cpu_ms_max: row[SAMPLE_INDEX.cpu_ms_max],
        worst_phys_ms: row[SAMPLE_INDEX.worst_phys_ms],
        worst_traffic_ms: row[SAMPLE_INDEX.worst_traffic_ms],
        worst_map_ms: row[SAMPLE_INDEX.worst_map_ms],
        worst_render_ms: row[SAMPLE_INDEX.worst_render_ms],
        worst_save_ms: row[SAMPLE_INDEX.worst_save_ms],
        worst_other_ms: row[SAMPLE_INDEX.worst_other_ms],
        d_geometries: row[SAMPLE_INDEX.d_geometries],
        d_textures: row[SAMPLE_INDEX.d_textures],
        d_programs: row[SAMPLE_INDEX.d_programs],
      }));
    const summary = {
      duration_s: round((rec.endedAt - rec.startedAt) / 1000, 3),
      samples: samples.length,
      frame_pacing: framePacing,
      gameplay: {
        max_speed_kmh: round(rec.maxSpeedKmh, 1),
        average_driving_speed_kmh: round(rec.speedSamples ? rec.speedSum / rec.speedSamples : 0, 1),
      },
      memory: {
        heap_start_mb: rec.heapStartMb,
        heap_end_mb: heapEnd,
        heap_peak_mb: rec.heapPeakMb,
        heap_growth_mb: heapEnd == null || rec.heapStartMb == null ? null : round(heapEnd - rec.heapStartMb, 1),
        renderer_resource_additions: rec.resourceGrowth,
        renderer_resource_removals: rec.resourceDrops,
      },
      browser_long_tasks: {
        count: rec.longTasks.length,
        total_ms: round(rec.longTasks.reduce((sum, task) => sum + task.duration_ms, 0)),
        max_ms: round(Math.max(0, ...rec.longTasks.map((task) => task.duration_ms))),
      },
      events: eventCounts,
      modes,
      routes,
      worst_windows: worstWindows,
      dropped_records: rec.dropped,
    };
    summary.findings = this._buildFindings(summary);
    return summary;
  }

  _buildFindings(summary) {
    const findings = [];
    const pacing = summary.frame_pacing;
    const subsystem = pacing.cpu_ms.subsystems_average;
    const ranked = Object.entries(subsystem).sort((a, b) => (b[1] || 0) - (a[1] || 0));
    if (pacing.frame_ms.p95 > 25) {
      findings.push({
        severity: pacing.frame_ms.p95 > 40 ? 'high' : 'medium',
        signal: 'unstable_frame_pacing',
        evidence: `p95 ${pacing.frame_ms.p95} ms; p99 ${pacing.frame_ms.p99} ms; ${pacing.slow_frames.over_50ms} frames over 50 ms`,
      });
    }
    if (ranked[0]?.[1] > 3) {
      findings.push({
        severity: ranked[0][1] > 10 ? 'high' : 'info',
        signal: `largest_profiled_subsystem:${ranked[0][0]}`,
        evidence: `${ranked[0][0]} averages ${ranked[0][1]} ms per profiled frame`,
      });
    }
    if (pacing.cpu_ms.raf_gap_average > Math.max(8, pacing.cpu_ms.average)) {
      findings.push({
        severity: 'info',
        signal: 'large_raf_gap',
        evidence: `rAF/vsync/GPU/OS gap averages ${pacing.cpu_ms.raf_gap_average} ms vs ${pacing.cpu_ms.average} ms profiled CPU`,
      });
    }
    const additions = summary.memory.renderer_resource_additions;
    if (additions.geometries || additions.textures || additions.programs) {
      findings.push({
        severity: additions.programs ? 'high' : 'medium',
        signal: 'runtime_gpu_resource_churn',
        evidence: `+${additions.geometries} geometries, +${additions.textures} textures, +${additions.programs} shader programs`,
      });
    }
    if ((summary.memory.heap_growth_mb ?? 0) > 30) {
      findings.push({
        severity: 'medium',
        signal: 'js_heap_growth',
        evidence: `heap grew ${summary.memory.heap_growth_mb} MB and peaked at ${summary.memory.heap_peak_mb} MB`,
      });
    }
    if (summary.browser_long_tasks.count) {
      findings.push({
        severity: summary.browser_long_tasks.max_ms > 100 ? 'high' : 'medium',
        signal: 'browser_long_tasks',
        evidence: `${summary.browser_long_tasks.count} Long Tasks, ${summary.browser_long_tasks.total_ms} ms total, ${summary.browser_long_tasks.max_ms} ms max`,
      });
    }
    if (!findings.length) {
      findings.push({
        severity: 'info',
        signal: 'no_strong_automatic_signal',
        evidence: 'Inspect worst_windows, spikes, routes, and marked events for workload-specific issues.',
      });
    }
    return findings;
  }

  // ------------------------------------------------------------------- report

  _buildReport(rec) {
    const summary = this._buildSummary(rec);
    return {
      schema: SCHEMA,
      schema_version: SCHEMA_VERSION,
      session: {
        id: rec.id,
        started_at: rec.startedIso,
        ended_at: rec.endedIso,
        duration_s: summary.duration_s,
      },
      environment: this._environmentMetadata(),
      game: rec.gameMetadata,
      initial_state: rec.initialSnapshot,
      summary,
      encoding: {
        sample_period_ms: SAMPLE_MS,
        recorded_spike_threshold_ms: RECORDED_SPIKE_MS,
        timeline: 'Each row is a tuple whose values match timeline_columns by index.',
        spikes: 'Each row is a tuple whose values match spike_columns by index. After the cap, rows are reservoir sampled across the session.',
        interpretation_notes: [
          'frame_ms measures end-to-end requestAnimationFrame completion spacing.',
          'cpu_ms and subsystem values measure synchronous game-loop CPU time.',
          'raf_gap_ms is frame_ms minus profiled CPU and can include vsync waiting, GPU/driver blocking, browser scheduling, background throttling, or OS contention.',
          'scene_visible_meshes means visible in the scene graph; draw_calls is the authoritative rendered-work counter.',
          'Renderer resource deltas during driving often indicate lazy GPU uploads or shader compilation.',
        ],
      },
      timeline_columns: SAMPLE_COLUMNS,
      timeline: rec.timeline,
      spike_columns: SPIKE_COLUMNS,
      spikes: rec.spikes.sort((a, b) => a[0] - b[0]),
      long_tasks: rec.longTasks,
      resources_loaded_during_recording: rec.resources,
      events: rec.events,
    };
  }

  _snapshotForMetadata(snapshot) {
    const {
      scene, x, y, z, heading, speedKmh, rpm, gear, throttle, brake, steer,
      handbrake, slip, score, combo, fuel, fuelPct, ...rest
    } = snapshot || {};
    return sanitize(rest);
  }

  _environmentMetadata() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    const canvas = this.renderer?.domElement;
    const gl = this.renderer?.getContext?.();
    let navigation = null;
    try {
      const entry = performance.getEntriesByType?.('navigation')?.[0];
      if (entry) navigation = {
        type: entry.type,
        dom_content_loaded_ms: round(entry.domContentLoadedEventEnd),
        load_ms: round(entry.loadEventEnd),
        transfer_kb: round((entry.transferSize || 0) / 1024, 1),
        decoded_body_kb: round((entry.decodedBodySize || 0) / 1024, 1),
      };
    } catch { /* optional browser API */ }
    return {
      user_agent: nav.userAgent || 'unknown',
      platform: nav.userAgentData?.platform || nav.platform || 'unknown',
      language: nav.language || null,
      hardware_concurrency: nav.hardwareConcurrency ?? null,
      device_memory_gb: nav.deviceMemory ?? null,
      max_touch_points: nav.maxTouchPoints ?? 0,
      connection: connection ? {
        effective_type: connection.effectiveType ?? null,
        downlink_mbps: connection.downlink ?? null,
        rtt_ms: connection.rtt ?? null,
        save_data: connection.saveData ?? null,
      } : null,
      page: {
        path: typeof location !== 'undefined' ? `${location.pathname}${location.search}` : null,
        build: this._buildId(),
        document_last_modified: typeof document !== 'undefined' ? document.lastModified : null,
        visibility_at_export: typeof document !== 'undefined' ? document.visibilityState : null,
        navigation,
        resource_entries: performance.getEntriesByType?.('resource')?.length ?? null,
      },
      display: {
        viewport_css: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : null,
        screen_css: typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : null,
        device_pixel_ratio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
        canvas_internal: canvas ? `${canvas.width}x${canvas.height}` : null,
        color_depth: typeof screen !== 'undefined' ? screen.colorDepth : null,
      },
      webgl: {
        gpu: this._gpuName(),
        version: this._glParameter(gl, gl?.VERSION),
        shading_language: this._glParameter(gl, gl?.SHADING_LANGUAGE_VERSION),
        vendor: this._glParameter(gl, gl?.VENDOR),
        is_webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
        antialias: gl?.getContextAttributes?.()?.antialias ?? null,
        power_preference: gl?.getContextAttributes?.()?.powerPreference ?? null,
        precision: this.renderer?.capabilities?.precision ?? null,
        max_texture_size: this.renderer?.capabilities?.maxTextureSize ?? null,
        max_cube_map_size: this.renderer?.capabilities?.maxCubemapSize ?? null,
        max_textures: this.renderer?.capabilities?.maxTextures ?? null,
        max_vertex_textures: this.renderer?.capabilities?.maxVertexTextures ?? null,
        max_anisotropy: this.renderer?.capabilities?.getMaxAnisotropy?.() ?? null,
      },
    };
  }

  _glParameter(gl, key) {
    try {
      return gl && key != null ? gl.getParameter(key) : null;
    } catch {
      return null;
    }
  }

  _gpuName() {
    try {
      const gl = this.renderer?.getContext?.();
      if (!gl) return 'unknown';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch {
      return 'unknown';
    }
  }

  _buildId() {
    try {
      const script = [...document.scripts].find((item) => /\/js\/game\.js(?:\?|$)/.test(item.src));
      return script?.src ? new URL(script.src).searchParams.get('v') || 'unversioned' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  _buildClipboardSummary(report, filename) {
    const summary = report.summary;
    const pacing = summary.frame_pacing;
    const cpu = pacing.cpu_ms.subsystems_average;
    const findings = summary.findings.map((finding) => (
      `- [${finding.severity.toUpperCase()}] ${finding.signal}: ${finding.evidence}`
    ));
    const eventList = Object.entries(summary.events).map(([name, count]) => `${name}=${count}`).join(', ') || 'none';
    return [
      '# Shutoko Nights diagnostic recording',
      '',
      `Full structured report: ${filename} (attach this JSON for detailed analysis)`,
      `Session: ${report.session.id}`,
      `Duration: ${summary.duration_s}s · ${pacing.frames} frames · ${summary.samples} timeline samples`,
      `Device: ${report.environment.webgl.gpu} · ${report.environment.display.canvas_internal} · DPR ${report.environment.display.device_pixel_ratio}`,
      `Frame pacing: ${pacing.fps_average} FPS avg · ${pacing.frame_ms.p50}/${pacing.frame_ms.p95}/${pacing.frame_ms.p99}/${pacing.frame_ms.max} ms p50/p95/p99/max`,
      `Slow frames: >33ms ${pacing.slow_frames.over_33ms} (${pacing.slow_frames.percent_over_33ms}%) · >50ms ${pacing.slow_frames.over_50ms} · >100ms ${pacing.slow_frames.over_100ms}`,
      `CPU avg: total ${pacing.cpu_ms.average} ms · physics ${cpu.phys} · traffic ${cpu.traffic} · map ${cpu.map} · render ${cpu.render} · save ${cpu.save} · other ${cpu.other} · rAF gap ${pacing.cpu_ms.raf_gap_average}`,
      `Memory: heap ${summary.memory.heap_start_mb ?? 'n/a'} → ${summary.memory.heap_end_mb ?? 'n/a'} MB (peak ${summary.memory.heap_peak_mb ?? 'n/a'}) · GPU additions ${JSON.stringify(summary.memory.renderer_resource_additions)}`,
      `Long Tasks: ${summary.browser_long_tasks.count} (${summary.browser_long_tasks.total_ms} ms total; ${summary.browser_long_tasks.max_ms} ms max)`,
      `Gameplay: max ${summary.gameplay.max_speed_kmh} km/h · events ${eventList}`,
      '',
      'Automatic signals:',
      ...findings,
      '',
      'The JSON contains environment/configuration metadata, 4 Hz gameplay/performance timeline, frame-time distribution, subsystem timings, spike locations, Long Tasks, errors, transitions, and manual markers.',
    ].join('\n');
  }

  // --------------------------------------------------------------- observers

  _startObservers() {
    if (typeof window !== 'undefined') {
      window.addEventListener('error', this._onWindowError);
      window.addEventListener('unhandledrejection', this._onUnhandledRejection);
      window.addEventListener('online', this._onOnline);
      window.addEventListener('offline', this._onOffline);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibilityChange);
    const canvas = this.renderer?.domElement;
    canvas?.addEventListener?.('webglcontextlost', this._onContextLost);
    canvas?.addEventListener?.('webglcontextrestored', this._onContextRestored);
    this._startConsoleCapture();
    try {
      if (typeof PerformanceObserver !== 'undefined'
        && (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
        this._longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) this._recordLongTask(entry);
        });
        this._longTaskObserver.observe({ type: 'longtask', buffered: false });
      }
    } catch {
      this._longTaskObserver = null;
    }
    try {
      if (typeof PerformanceObserver !== 'undefined'
        && (PerformanceObserver.supportedEntryTypes || []).includes('resource')) {
        this._resourceObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) this._recordResource(entry);
        });
        this._resourceObserver.observe({ type: 'resource', buffered: false });
      }
    } catch {
      this._resourceObserver = null;
    }
  }

  _stopObservers() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', this._onWindowError);
      window.removeEventListener('unhandledrejection', this._onUnhandledRejection);
      window.removeEventListener('online', this._onOnline);
      window.removeEventListener('offline', this._onOffline);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibilityChange);
    const canvas = this.renderer?.domElement;
    canvas?.removeEventListener?.('webglcontextlost', this._onContextLost);
    canvas?.removeEventListener?.('webglcontextrestored', this._onContextRestored);
    this._longTaskObserver?.disconnect?.();
    this._longTaskObserver = null;
    this._resourceObserver?.disconnect?.();
    this._resourceObserver = null;
    this._stopConsoleCapture();
  }

  _recordLongTask(entry) {
    const rec = this.recording;
    if (!rec) return;
    rec.window.longTaskCount += 1;
    rec.window.longTaskMs += entry.duration || 0;
    if (rec.longTasks.length >= MAX_LONG_TASKS) {
      rec.dropped.longTasks += 1;
      return;
    }
    rec.longTasks.push({
      time_s: round((entry.startTime - rec.startedAt) / 1000, 3),
      duration_ms: round(entry.duration),
      name: entry.name || 'self',
      attribution: (entry.attribution || []).slice(0, 8).map((item) => ({
        name: item.name || null,
        container_type: item.containerType || null,
        container_name: item.containerName || null,
        container_src: safeString(item.containerSrc, 1000) || null,
      })),
    });
  }

  _recordResource(entry) {
    const rec = this.recording;
    if (!rec || entry.startTime < rec.startedAt) return;
    if (rec.resources.length >= MAX_RESOURCES) {
      rec.dropped.resources += 1;
      return;
    }
    let name = entry.name || null;
    try {
      const url = new URL(name, location.href);
      name = url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
    } catch { /* keep the browser-provided value */ }
    rec.resources.push({
      time_s: round((entry.startTime - rec.startedAt) / 1000, 3),
      duration_ms: round(entry.duration),
      name: safeString(name, 2000),
      initiator: entry.initiatorType || null,
      transfer_kb: round((entry.transferSize || 0) / 1024, 2),
      encoded_kb: round((entry.encodedBodySize || 0) / 1024, 2),
      decoded_kb: round((entry.decodedBodySize || 0) / 1024, 2),
      protocol: entry.nextHopProtocol || null,
      blocking: entry.renderBlockingStatus || null,
    });
  }

  _startConsoleCapture() {
    if (typeof console === 'undefined' || this._consoleOriginals) return;
    this._consoleOriginals = {};
    this._consoleWrappers = {};
    for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      const wrapper = (...args) => {
        original.apply(console, args);
        if (this.recording) this.event(`console_${level}`, { arguments: sanitize(args) });
      };
      this._consoleOriginals[level] = original;
      this._consoleWrappers[level] = wrapper;
      console[level] = wrapper;
    }
  }

  _stopConsoleCapture() {
    if (typeof console === 'undefined' || !this._consoleOriginals) return;
    for (const [level, original] of Object.entries(this._consoleOriginals)) {
      if (console[level] === this._consoleWrappers[level]) console[level] = original;
    }
    this._consoleOriginals = null;
    this._consoleWrappers = null;
  }

  _captureWindowError(event) {
    const target = event?.target;
    const resource = target && target !== window ? (target.currentSrc || target.src || target.href) : null;
    this.event(resource ? 'resource_error' : 'window_error', {
      message: event?.message || (resource ? 'Resource failed to load' : 'Unknown window error'),
      filename: event?.filename || resource || null,
      line: event?.lineno ?? null,
      column: event?.colno ?? null,
      error: sanitize(event?.error),
    });
  }

  // ---------------------------------------------------------------------- HUD

  _refreshPanel(now, force = false) {
    if (!force && !this.visible) return;
    this.lastPanelRefresh = now;
    const sample = this._sample(now, this._recentDeltas());
    const { snapshot: snap, frame } = sample;
    const lines = [
      'DEBUG STATS [I] · DIAG REC [P] · MARK [O]',
      `FPS ${frame.fps.toFixed(1)} · frame ${frame.avg.toFixed(1)} ms (p95 ${frame.p95.toFixed(1)} · p99 ${frame.p99.toFixed(1)} · max ${frame.max.toFixed(0)})`,
      sample.heap
        ? `HEAP ${fmt(sample.heap.used)} / ${fmt(sample.heap.total)} MB (limit ${fmt(sample.heap.limit)})`
        : 'HEAP not exposed by this browser',
      `RENDER ${sample.render.calls.toLocaleString('en-US')} calls · ${sample.render.triangles.toLocaleString('en-US')} tris`,
      `GPU MEM ${sample.memory.geometries} geometries · ${sample.memory.textures} textures · ${sample.memory.programs} programs`,
      `SCENE ${sample.scene.objects} objects · ${sample.scene.meshes} meshes (${sample.scene.visibleMeshes} visible tree) · ${sample.scene.instances} instances · ${sample.scene.lights} lights`,
      `WORLD chunks ${snap.chunksVisible ?? '—'} / ${snap.chunksTotal ?? '—'} · traffic ${snap.traffic ?? '—'} (${snap.trafficVisible ?? '—'} visible)`,
      `MODE ${snap.mode ?? '—'} · quality ${snap.quality ?? '—'} · ${snap.resolution ?? '—'} @${(snap.dpr ?? 1).toFixed(2)}x`,
      `POS ${Math.round(snap.x ?? 0)}, ${Math.round(snap.z ?? 0)} · ${Math.round(snap.speedKmh ?? 0)} km/h · route ${snap.route ?? '—'}`,
    ];
    if (this.lastSpike) {
      const spike = this.lastSpike;
      lines.push(
        `SPIKE ${spike.delta.toFixed(0)} ms @${((now - spike.at) / 1000).toFixed(0)}s ago · `
        + `phys ${spike.phys.toFixed(1)} · traffic ${spike.traffic.toFixed(1)} · map ${spike.map.toFixed(1)} · `
        + `render ${spike.render.toFixed(1)} · save ${spike.persist.toFixed(1)} · other ${spike.other.toFixed(1)} · gap ${spike.gap.toFixed(1)}`,
      );
    }
    if (this.recording) {
      lines.push(`REC ● ${this._elapsed(now)} · ${this.recording.timeline.length} samples · ${this.recording.spikeSeen} spikes · ${this.recording.events.length} events`);
    }
    this.root.textContent = lines.join('\n');
  }

  _elapsed(now) {
    const seconds = Math.floor((now - this.recording.startedAt) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  _updateBadge(now) {
    this._ensureDom();
    if (!this.recording) {
      this.badge.style.display = 'none';
      return;
    }
    this.badge.style.display = 'block';
    this.badge.textContent = `● DIAG ${this._elapsed(now)} · ${this.recording.timeline.length} samples · O mark · P export`;
  }

  // ------------------------------------------------------------------- export

  _copySummary(rows, downloaded) {
    const done = () => this.toast(
      `DIAG REC stopped // ${rows} samples · ${downloaded ? 'JSON downloaded · ' : ''}summary copied`,
      'amber',
    );
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(this.lastLog).then(done, () => this._showFallback());
    } else {
      this._showFallback();
    }
  }

  _downloadJson(json, filename) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || !URL?.createObjectURL) return false;
    try {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return true;
    } catch {
      return false;
    }
  }

  _filename(startedIso = new Date().toISOString()) {
    return `hesi-diagnostic-${startedIso.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}.json`;
  }

  _sessionId() {
    try {
      return crypto.randomUUID();
    } catch {
      return `hesi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  _showFallback() {
    this._ensureDom();
    if (!this.fallback) {
      this.fallback = document.createElement('div');
      this.fallback.id = 'debug-stats-fallback';
      this.fallback.innerHTML = `
        <div class="ds-card">
          <b>DIAGNOSTIC REPORT</b>
          <p>Automatic clipboard copy failed. Copy the summary or download the complete JSON.</p>
          <textarea readonly spellcheck="false"></textarea>
          <div class="ds-actions">
            <button type="button" data-ds="download">DOWNLOAD JSON</button>
            <button type="button" data-ds="copy">COPY SUMMARY</button>
            <button type="button" data-ds="close">CLOSE</button>
          </div>
        </div>`;
      document.body.appendChild(this.fallback);
      this.fallback.querySelector('[data-ds="close"]').addEventListener('click', () => {
        this.fallback.style.display = 'none';
      });
      this.fallback.querySelector('[data-ds="download"]').addEventListener('click', () => {
        this.downloadLastReport();
      });
      this.fallback.querySelector('[data-ds="copy"]').addEventListener('click', () => {
        const area = this.fallback.querySelector('textarea');
        area.focus();
        area.select();
        try {
          document.execCommand('copy');
          this.toast('Diagnostic summary copied', 'amber');
        } catch { /* selection stays active for Ctrl+C */ }
      });
    }
    this.fallback.querySelector('textarea').value = this.lastLog;
    this.fallback.style.display = 'grid';
    document.exitPointerLock?.();
  }

  _ensureDom() {
    if (this.root) return;
    this.root = document.createElement('pre');
    this.root.id = 'debug-stats-panel';
    this.root.style.display = 'none';
    document.body.appendChild(this.root);
    this.badge = document.createElement('div');
    this.badge.id = 'debug-stats-rec';
    this.badge.style.display = 'none';
    document.body.appendChild(this.badge);
  }
}

export default DebugStats;
