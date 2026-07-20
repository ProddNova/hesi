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

const LOG_COLUMNS = [
  'time_s', 'mode', 'fps', 'frame_ms_avg', 'frame_ms_p95', 'frame_ms_max',
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
    this.root = null;
    this.badge = null;
    this.fallback = null;
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
    this._ensureDom();
    this._updateBadge(now);
    this.toast('STATS REC started // P stops & copies the log', 'amber');
  }

  /** Call once per rendered frame (after renderer.render). Cheap when idle. */
  frame() {
    const now = performance.now();
    if (this.lastFrameAt) {
      const delta = now - this.lastFrameAt;
      this.frameTimes[this.frameIndex] = delta;
      this.frameIndex = (this.frameIndex + 1) % RING;
      this.frameCount += 1;
      if (this.recording) this.recording.frames.push(delta);
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
    if (this.recording) lines.push(`REC ● ${this._elapsed(now)} · ${this.recording.rows.length} rows`);
    this.root.textContent = lines.join('\n');
  }

  _flushRow(now) {
    const rec = this.recording;
    const sample = this._sample(now, rec.frames);
    rec.frames = [];
    rec.lastFlush = now;
    const { snapshot: snap, frame } = sample;
    rec.rows.push([
      ((now - rec.startedAt) / 1000).toFixed(2),
      snap.mode ?? '',
      frame.fps.toFixed(1),
      frame.avg.toFixed(2),
      frame.p95.toFixed(2),
      frame.max.toFixed(2),
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
