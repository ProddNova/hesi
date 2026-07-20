// On-screen performance statistics overlay + stats log recorder.
//
//   I — show/hide the overlay: FPS, frame times, JS heap, renderer counters
//       (draw calls / triangles / geometries / textures / programs), scene
//       object counts, streamed chunks, traffic, mode/quality/resolution,
//       position and speed.
//   P — start/stop recording those statistics as a tab-separated log
//       (2 rows/second). Stopping copies the log to the clipboard; when the
//       clipboard is unavailable a fallback dialog offers manual copy.
//
// Owns no game state: everything arrives through constructor callbacks,
// mirroring the DeveloperMap integration contract (js/dev-map.js). All DOM
// is created lazily on first use and styled by styles/debug-stats.css.

const RING = 240; // frame-duration ring buffer (~4 s at 60 fps)
const PANEL_REFRESH_MS = 250;
const SCENE_SCAN_MS = 1000;
const ROW_FLUSH_MS = 500;
const SPIKE_MS = 40; // frames longer than this are remembered as "last spike"

// The max_* columns are the subsystem breakdown (from the game's frame
// profiler) of the WORST frame inside that row's window, so every long frame
// in a recording names its cause. d_* are renderer resource-count deltas over
// the window: nonzero values mean geometry/texture uploads or shader
// compiles happened mid-drive (the classic first-visibility stutter).
const LOG_COLUMNS = [
  'time_s', 'mode', 'fps', 'frame_ms_avg', 'frame_ms_p95', 'frame_ms_max',
  'max_phys_ms', 'max_traffic_ms', 'max_map_ms', 'max_render_ms', 'max_save_ms', 'max_other_ms',
  'd_geometries', 'd_textures', 'd_programs',
  'draw_calls', 'triangles', 'geometries', 'textures', 'programs',
  'scene_objects', 'scene_meshes', 'visible_meshes', 'instanced_count',
  'chunks_visible', 'chunks_total', 'traffic',
  'heap_used_mb', 'heap_total_mb', 'speed_kmh', 'pos_x', 'pos_z', 'route',
];

const mb = (bytes) => Math.round(bytes / 1048576);
const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';

export class DebugStats {
  constructor({ renderer = null, getSnapshot = () => ({}), toast = () => {} } = {}) {
    this.renderer = renderer;
    this.getSnapshot = getSnapshot;
    this.toast = toast;
    this.visible = false;
    this.recording = null; // { startedAt, lastFlush, frames: number[], rows: string[] }
    this.lastLog = '';
    this.frameTimes = new Float32Array(RING);
    this.frameIndex = 0;
    this.frameCount = 0;
    this.lastFrameAt = 0;
    this.lastPanelRefresh = 0;
    this.lastSceneScan = 0;
    this.sceneCounts = { objects: 0, meshes: 0, visibleMeshes: 0, instances: 0 };
    this.windowWorst = null; // worst frame (+ its subsystem profile) since the last row flush
    this.lastSpike = null;   // most recent frame above SPIKE_MS, for the panel
    this._memAtFlush = null; // renderer resource counts at the previous flush
    this.root = null;
    this.badge = null;
    this.fallback = null;
  }

  _copyProfile(profile, delta, now) {
    return {
      delta,
      at: now,
      phys: profile.phys ?? 0,
      traffic: profile.traffic ?? 0,
      map: profile.map ?? 0,
      render: profile.render ?? 0,
      persist: profile.persist ?? 0,
      other: profile.other ?? 0,
      total: profile.total ?? 0,
    };
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
    if (this.recording) { this._stopRecording(); return; }
    const now = performance.now();
    this.recording = { startedAt: now, lastFlush: now, frames: [], rows: [] };
    this.windowWorst = null;
    const info = this.renderer?.info;
    this._memAtFlush = {
      geometries: info?.memory?.geometries ?? 0,
      textures: info?.memory?.textures ?? 0,
      programs: info?.programs?.length ?? 0,
    };
    this._ensureDom();
    this._updateBadge(now);
    this.toast('STATS REC started // P stops & copies the log', 'amber');
  }

  /**
   * Call once per rendered frame (after renderer.render). Cheap when idle.
   * `profile` (optional) is the game's per-frame subsystem timing object
   * ({ phys, traffic, map, render, persist, other, total } in ms); it is
   * copied only for the worst frame of each window and for spikes.
   */
  frame(profile = null) {
    const now = performance.now();
    if (this.lastFrameAt) {
      const delta = now - this.lastFrameAt;
      this.frameTimes[this.frameIndex] = delta;
      this.frameIndex = (this.frameIndex + 1) % RING;
      this.frameCount += 1;
      if (this.recording) this.recording.frames.push(delta);
      if (profile) {
        if (!this.windowWorst || delta > this.windowWorst.delta) {
          this.windowWorst = this._copyProfile(profile, delta, now);
        }
        if (delta > SPIKE_MS) this.lastSpike = this._copyProfile(profile, delta, now);
      }
    }
    this.lastFrameAt = now;
    if (this.recording && now - this.recording.lastFlush >= ROW_FLUSH_MS) {
      this._flushRow(now);
      this._updateBadge(now);
    }
    if (this.visible && now - this.lastPanelRefresh >= PANEL_REFRESH_MS) this._refreshPanel(now);
  }

  dispose() {
    this.root?.remove();
    this.badge?.remove();
    this.fallback?.remove();
    this.root = this.badge = this.fallback = null;
  }

  // ------------------------------------------------------------- internals

  _frameStats(deltas) {
    if (!deltas.length) return { fps: 0, avg: 0, p95: 0, max: 0 };
    const sorted = [...deltas].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const avg = sum / sorted.length;
    return {
      fps: avg > 0 ? 1000 / avg : 0,
      avg,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted[sorted.length - 1],
    };
  }

  _recentDeltas() {
    const count = Math.min(this.frameCount, RING);
    const deltas = [];
    for (let i = 0; i < count; i += 1) deltas.push(this.frameTimes[(this.frameIndex - 1 - i + RING * 2) % RING]);
    return deltas;
  }

  _scanScene(scene, now) {
    if (now - this.lastSceneScan < SCENE_SCAN_MS) return this.sceneCounts;
    this.lastSceneScan = now;
    const counts = { objects: 0, meshes: 0, visibleMeshes: 0, instances: 0 };
    if (scene?.traverse) {
      scene.traverse((object) => {
        counts.objects += 1;
        if (object.isMesh || object.isInstancedMesh) {
          counts.meshes += 1;
          if (object.isInstancedMesh) counts.instances += object.count || 0;
        }
      });
      scene.traverseVisible?.((object) => {
        if (object.isMesh || object.isInstancedMesh) counts.visibleMeshes += 1;
      });
    }
    this.sceneCounts = counts;
    return counts;
  }

  _sample(now, deltas) {
    const snapshot = this.getSnapshot() || {};
    const frame = this._frameStats(deltas);
    const info = this.renderer?.info;
    const heap = typeof performance !== 'undefined' ? performance.memory : null;
    return {
      snapshot,
      frame,
      scene: this._scanScene(snapshot.scene, now),
      render: { calls: info?.render?.calls ?? 0, triangles: info?.render?.triangles ?? 0 },
      memory: {
        geometries: info?.memory?.geometries ?? 0,
        textures: info?.memory?.textures ?? 0,
        programs: info?.programs?.length ?? 0,
      },
      heap: heap ? { used: mb(heap.usedJSHeapSize), total: mb(heap.totalJSHeapSize), limit: mb(heap.jsHeapSizeLimit) } : null,
    };
  }

  _refreshPanel(now, force = false) {
    if (!force && !this.visible) return;
    this.lastPanelRefresh = now;
    const s = this._sample(now, this._recentDeltas());
    const { snapshot: snap, frame } = s;
    const lines = [
      'DEBUG STATS [I] · LOG REC [P]',
      `FPS ${frame.fps.toFixed(1)} · frame ${frame.avg.toFixed(1)} ms (p95 ${frame.p95.toFixed(1)} · max ${frame.max.toFixed(0)})`,
      s.heap
        ? `HEAP ${fmt(s.heap.used)} / ${fmt(s.heap.total)} MB (limit ${fmt(s.heap.limit)})`
        : 'HEAP not exposed by this browser',
      `RENDER ${fmt(s.render.calls)} calls · ${fmt(s.render.triangles)} tris`,
      `GPU MEM ${fmt(s.memory.geometries)} geometries · ${fmt(s.memory.textures)} textures · ${fmt(s.memory.programs)} programs`,
      `SCENE ${fmt(s.scene.objects)} objects · ${fmt(s.scene.meshes)} meshes (${fmt(s.scene.visibleMeshes)} in visible tree) · ${fmt(s.scene.instances)} instanced`,
      `WORLD chunks ${fmt(snap.chunksVisible)} / ${fmt(snap.chunksTotal)} · traffic ${fmt(snap.traffic)}`,
      `MODE ${snap.mode ?? '—'} · quality ${snap.quality ?? '—'} · ${snap.resolution ?? '—'} @${(snap.dpr ?? 1).toFixed(2)}x`,
      `POS ${Math.round(snap.x ?? 0)}, ${Math.round(snap.z ?? 0)} · ${Math.round(snap.speedKmh ?? 0)} km/h · route ${snap.route ?? '—'}`,
    ];
    if (this.lastSpike) {
      const spike = this.lastSpike;
      lines.push(
        `SPIKE ${spike.delta.toFixed(0)} ms @${((now - spike.at) / 1000).toFixed(0)}s ago · `
        + `phys ${spike.phys.toFixed(1)} · traffic ${spike.traffic.toFixed(1)} · map ${spike.map.toFixed(1)} · `
        + `render ${spike.render.toFixed(1)} · save ${spike.persist.toFixed(1)} · other ${spike.other.toFixed(1)}`,
      );
    }
    if (this.recording) lines.push(`REC ● ${this._elapsed(now)} · ${this.recording.rows.length} rows`);
    this.root.textContent = lines.join('\n');
  }

  _flushRow(now) {
    const rec = this.recording;
    const sample = this._sample(now, rec.frames);
    rec.frames = [];
    rec.lastFlush = now;
    const { snapshot: snap, frame } = sample;
    const worst = this.windowWorst;
    this.windowWorst = null;
    const previousMem = this._memAtFlush;
    this._memAtFlush = { ...sample.memory };
    const memDelta = previousMem
      ? {
        geometries: sample.memory.geometries - previousMem.geometries,
        textures: sample.memory.textures - previousMem.textures,
        programs: sample.memory.programs - previousMem.programs,
      }
      : { geometries: 0, textures: 0, programs: 0 };
    rec.rows.push([
      ((now - rec.startedAt) / 1000).toFixed(2),
      snap.mode ?? '',
      frame.fps.toFixed(1),
      frame.avg.toFixed(2),
      frame.p95.toFixed(2),
      frame.max.toFixed(2),
      (worst?.phys ?? 0).toFixed(2),
      (worst?.traffic ?? 0).toFixed(2),
      (worst?.map ?? 0).toFixed(2),
      (worst?.render ?? 0).toFixed(2),
      (worst?.persist ?? 0).toFixed(2),
      (worst?.other ?? 0).toFixed(2),
      memDelta.geometries,
      memDelta.textures,
      memDelta.programs,
      sample.render.calls,
      sample.render.triangles,
      sample.memory.geometries,
      sample.memory.textures,
      sample.memory.programs,
      sample.scene.objects,
      sample.scene.meshes,
      sample.scene.visibleMeshes,
      sample.scene.instances,
      snap.chunksVisible ?? '',
      snap.chunksTotal ?? '',
      snap.traffic ?? '',
      sample.heap?.used ?? '',
      sample.heap?.total ?? '',
      Math.round(snap.speedKmh ?? 0),
      Math.round(snap.x ?? 0),
      Math.round(snap.z ?? 0),
      snap.route ?? '',
    ].join('\t'));
  }

  _stopRecording() {
    const now = performance.now();
    if (this.recording.frames.length) this._flushRow(now); // partial tail row
    const snap = this.getSnapshot() || {};
    const header = [
      '# Shutoko Nights stats log',
      `# date: ${new Date().toISOString()}`,
      `# duration_s: ${((now - this.recording.startedAt) / 1000).toFixed(2)}`,
      `# ua: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
      `# gpu: ${this._gpuName()}`,
      `# quality: ${snap.quality ?? '—'} · resolution: ${snap.resolution ?? '—'} @${(snap.dpr ?? 1).toFixed(2)}x`,
      `# gpu_prewarm: ${snap.prewarm ?? 'unknown'}`,
      LOG_COLUMNS.join('\t'),
    ];
    this.lastLog = header.concat(this.recording.rows).join('\n');
    const rows = this.recording.rows.length;
    this.recording = null;
    this._updateBadge(now);
    this._copyLog(rows);
  }

  _copyLog(rows) {
    const done = () => this.toast(`STATS REC stopped // ${rows} rows copied to clipboard`, 'amber');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(this.lastLog).then(done, () => this._showFallback());
    } else {
      this._showFallback();
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

  _elapsed(now) {
    const seconds = Math.floor((now - this.recording.startedAt) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  _updateBadge(now) {
    this._ensureDom();
    if (!this.recording) { this.badge.style.display = 'none'; return; }
    this.badge.style.display = 'block';
    this.badge.textContent = `● REC ${this._elapsed(now)} · ${this.recording.rows.length} rows · P to stop`;
  }

  _showFallback() {
    this._ensureDom();
    if (!this.fallback) {
      this.fallback = document.createElement('div');
      this.fallback.id = 'debug-stats-fallback';
      this.fallback.innerHTML = `
        <div class="ds-card">
          <b>STATS LOG</b>
          <p>Automatic clipboard copy failed. Copy manually:</p>
          <textarea readonly spellcheck="false"></textarea>
          <div class="ds-actions">
            <button type="button" data-ds="copy">COPY</button>
            <button type="button" data-ds="close">CLOSE</button>
          </div>
        </div>`;
      document.body.appendChild(this.fallback);
      this.fallback.querySelector('[data-ds="close"]').addEventListener('click', () => { this.fallback.style.display = 'none'; });
      this.fallback.querySelector('[data-ds="copy"]').addEventListener('click', () => {
        const area = this.fallback.querySelector('textarea');
        area.focus();
        area.select();
        try { document.execCommand('copy'); this.toast('Stats log copied', 'amber'); } catch { /* selection stays for Ctrl+C */ }
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
