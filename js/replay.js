// ==========================================================================
// REPLAY // 3 — registratore e visualizzatore di replay.
//
// Disponibile solo nella build di test (?editorTest): il tasto 3 apre il
// pannello. La registrazione campiona a 20 Hz la posa del giocatore e di
// ogni veicolo del traffico; le clip si salvano in localStorage (o si
// esportano/importano come JSON) e il playback avviene nel mondo reale con
// la fisica in pausa: le auto registrate vengono riposizionate frame per
// frame, interpolate, e il traffico live viene sostituito da "ghost" del
// pool traffico con lo stesso modello. Durante la visione si possono
// attivare le hitbox (veicoli/strade/muri), cambiare camera (inseguimento,
// orbita, TV, volo libero), mettere in pausa, scrubare e andare frame per
// frame.
// ==========================================================================
import * as THREE from 'three';

const STORAGE_KEY = 'shutoko-nights.replays.v1';
const SAMPLE_HZ = 20;
const MAX_SECONDS = 300; // 5 minuti: oltre, la registrazione si ferma da sola
const MAX_FRAMES = SAMPLE_HZ * MAX_SECONDS;
const MAX_STORED = 8; // clip in localStorage (~quota 5 MB)
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const CAMERAS = ['chase', 'orbit', 'tv', 'fly'];

const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};
const fmtTime = (s) => {
  s = Math.max(0, Number(s) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;
};

export class ReplaySystem {
  constructor(game) {
    this.game = game;
    this.menuOpen = false;
    this.rec = null; // registrazione in corso
    this.lastClip = null; // ultima clip registrata, non ancora salvata
    this.clips = this._load();
    this.playback = null;
    this.options = { hitboxes: true, roads: false, walls: false, loop: false };
  }

  get recording() { return !!this.rec; }
  get playing() { return !!this.playback; }

  // ------------------------------------------------------------------ setup
  init() {
    const $ = (id) => document.getElementById(id);
    this.root = $('replay-menu');
    this.recToggle = $('replay-rec-toggle');
    this.recStatus = $('replay-rec-status');
    this.lastRow = $('replay-last-clip');
    this.lastInfo = $('replay-last-info');
    this.listEl = $('replay-list');
    if (!this.root) return;

    $('replay-close')?.addEventListener('click', () => this.toggleMenu(false));
    this.recToggle?.addEventListener('click', () => (this.rec ? this.stopRecording() : this.startRecording()));
    $('replay-last-play')?.addEventListener('click', () => this.lastClip && this.startPlayback(this.lastClip));
    $('replay-last-save')?.addEventListener('click', () => {
      if (!this.lastClip) return;
      this.saveClip(this.lastClip);
      this.lastClip = null;
      this._refreshMenu();
    });
    $('replay-last-export')?.addEventListener('click', () => this.lastClip && this.exportClip(this.lastClip));
    $('replay-import')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) this.importClip(file);
    });
    const optMap = { 'replay-opt-hitboxes': 'hitboxes', 'replay-opt-roads': 'roads', 'replay-opt-walls': 'walls', 'replay-opt-loop': 'loop' };
    for (const [id, key] of Object.entries(optMap)) {
      const input = $(id);
      if (!input) continue;
      input.checked = this.options[key];
      input.addEventListener('change', () => {
        this.options[key] = input.checked;
        if (this.playing && key !== 'loop') this._applyHitboxOptions();
      });
    }

    this._buildHud();
    this._buildBadge();

    // Scorciatoie di playback (attive solo mentre un replay è in visione).
    window.addEventListener('keydown', (e) => {
      const pb = this.playback;
      if (!pb || e.repeat) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
      if (typing) return;
      if (e.code === 'Space' && pb.cam !== 'fly') { e.preventDefault(); this.togglePause(); }
      else if (e.code === 'KeyC') { e.preventDefault(); this.cycleCamera(); }
      else if (e.code === 'ArrowLeft' && pb.cam !== 'fly') { e.preventDefault(); this.seek(-2); }
      else if (e.code === 'ArrowRight' && pb.cam !== 'fly') { e.preventDefault(); this.seek(2); }
      else if (e.code === 'Comma') { e.preventDefault(); this.stepFrame(-1); }
      else if (e.code === 'Period') { e.preventDefault(); this.stepFrame(1); }
    });
    // Mouse: orbita e volo libero usano il pointer lock come il drone noclip.
    document.addEventListener('mousemove', (e) => {
      const pb = this.playback;
      if (!pb || document.pointerLockElement !== this.game.canvas) return;
      if (pb.cam === 'orbit') {
        pb.orbit.yaw -= e.movementX * 0.004;
        pb.orbit.pitch = clampNum(pb.orbit.pitch + e.movementY * 0.003, -0.1, 1.35);
      } else if (pb.cam === 'fly') {
        pb.fly.yaw -= e.movementX * 0.0022;
        pb.fly.pitch = clampNum(pb.fly.pitch - e.movementY * 0.0022, -1.5, 1.5);
      }
    });
    this.game.canvas?.addEventListener('wheel', (e) => {
      const pb = this.playback;
      if (!pb || pb.cam !== 'orbit') return;
      e.preventDefault();
      pb.orbit.dist = clampNum(pb.orbit.dist + e.deltaY * 0.01, 3, 40);
    }, { passive: false });
    this.game.canvas?.addEventListener('click', () => {
      if (this._camWantsPointer() && !this.menuOpen && document.pointerLockElement !== this.game.canvas) this.game.requestDronePointerLock?.();
    });

    this._refreshMenu();
  }

  _buildHud() {
    const hud = document.createElement('div');
    hud.id = 'replay-hud';
    hud.className = 'replay-hud hidden';
    hud.innerHTML = `
      <button type="button" data-rh="step-back" title="Frame indietro (,)">|&lt;</button>
      <button type="button" data-rh="play" title="Play / pausa (spazio)">&gt;</button>
      <button type="button" data-rh="step-fwd" title="Frame avanti (.)">&gt;|</button>
      <input type="range" data-rh="seek" min="0" max="1000" value="0" aria-label="Timeline replay">
      <span data-rh="time">0:00.0 / 0:00.0</span>
      <span data-rh="speedo">0 KM/H</span>
      <button type="button" data-rh="speed" title="Velocità di riproduzione">1×</button>
      <button type="button" data-rh="cam" title="Cambia camera (C)">CAM CHASE</button>
      <button type="button" data-rh="hitbox" class="on" title="Hitbox veicoli">HITBOX</button>
      <button type="button" data-rh="exit" title="Chiudi il playback">EXIT</button>`;
    (document.getElementById('game-shell') || document.body).append(hud);
    this.hud = hud;
    const q = (name) => hud.querySelector(`[data-rh="${name}"]`);
    this.hudPlay = q('play');
    this.hudSeek = q('seek');
    this.hudTime = q('time');
    this.hudSpeedo = q('speedo');
    this.hudSpeed = q('speed');
    this.hudCam = q('cam');
    this.hudHitbox = q('hitbox');
    q('play')?.addEventListener('click', () => this.togglePause());
    q('step-back')?.addEventListener('click', () => this.stepFrame(-1));
    q('step-fwd')?.addEventListener('click', () => this.stepFrame(1));
    q('speed')?.addEventListener('click', () => {
      const pb = this.playback;
      if (!pb) return;
      pb.speed = SPEEDS[(SPEEDS.indexOf(pb.speed) + 1) % SPEEDS.length];
      this._syncHud();
    });
    q('cam')?.addEventListener('click', () => this.cycleCamera());
    q('hitbox')?.addEventListener('click', () => {
      this.options.hitboxes = !this.options.hitboxes;
      const input = document.getElementById('replay-opt-hitboxes');
      if (input) input.checked = this.options.hitboxes;
      if (this.playing) this._applyHitboxOptions();
      this._syncHud();
    });
    q('exit')?.addEventListener('click', () => this.stopPlayback());
    this.hudSeek?.addEventListener('pointerdown', () => { if (this.playback) this.playback.scrubbing = true; });
    this.hudSeek?.addEventListener('input', () => {
      const pb = this.playback;
      if (!pb) return;
      pb.time = (Number(this.hudSeek.value) / 1000) * pb.clip.duration;
    });
    const endScrub = () => { if (this.playback) this.playback.scrubbing = false; };
    this.hudSeek?.addEventListener('pointerup', endScrub);
    this.hudSeek?.addEventListener('change', endScrub);
  }

  _buildBadge() {
    const badge = document.createElement('div');
    badge.id = 'replay-rec-badge';
    badge.className = 'replay-rec-badge hidden';
    badge.innerHTML = '<i></i>REC <span>0:00.0</span>';
    (document.getElementById('game-shell') || document.body).append(badge);
    this.badge = badge;
    this.badgeTime = badge.querySelector('span');
  }

  // ------------------------------------------------------------------- menu
  toggleMenu(force) {
    const open = typeof force === 'boolean' ? force : !this.menuOpen;
    if (open && !this.game.editorTest) return;
    if (open === this.menuOpen) return;
    this.menuOpen = open;
    this.root?.classList.toggle('hidden', !open);
    this.root?.setAttribute('aria-hidden', String(!open));
    if (open) {
      this.game.toggleDebugMenu?.(false);
      this.game.setFilterMenuOpen?.(false);
      this._refreshMenu();
    } else if (this._camWantsPointer() && !this.game.isTouchDevice) {
      this.game.requestDronePointerLock?.();
    }
    this.game._syncOverlayState?.();
  }

  _refreshMenu() {
    if (!this.root) return;
    const rec = this.rec;
    if (this.recToggle) this.recToggle.textContent = rec ? 'STOP REC' : 'START REC';
    if (this.recStatus) {
      this.recStatus.textContent = rec
        ? `REC in corso… ${fmtTime((performance.now() - rec.startedAt) / 1000)} · ${rec.scene === 'playground' ? 'TEST PAD' : 'MAPPA'}`
        : this.playing
          ? 'In playback — la registrazione riprende dopo'
          : 'Pronto — registra mentre guidi';
    }
    const last = this.lastClip;
    if (this.lastRow) this.lastRow.hidden = !last;
    if (last && this.lastInfo) {
      this.lastInfo.textContent = `${last.name} · ${fmtTime(last.duration)} · ${last.scene === 'playground' ? 'TEST PAD' : 'MAPPA'} · ${last.frames.length} frame`;
    }
    if (!this.listEl) return;
    this.listEl.textContent = '';
    if (!this.clips.length) {
      const empty = document.createElement('p');
      empty.className = 'debug-range-note';
      empty.textContent = 'NESSUN REPLAY SALVATO — REGISTRA CON START REC E POI PREMI SALVA';
      this.listEl.append(empty);
      return;
    }
    for (const clip of this.clips) {
      const row = document.createElement('div');
      row.className = 'replay-row';
      const info = document.createElement('span');
      info.className = 'replay-row-info';
      const title = document.createElement('b');
      title.textContent = clip.name;
      const meta = document.createElement('small');
      const date = new Date(clip.createdAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      meta.textContent = `${fmtTime(clip.duration)} · ${clip.scene === 'playground' ? 'TEST PAD' : 'MAPPA'} · ${date}`;
      info.append(title, meta);
      const btns = document.createElement('div');
      btns.className = 'replay-row-btns';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', fn);
        btns.append(b);
      };
      mk('PLAY', () => this.startPlayback(clip));
      mk('JSON', () => this.exportClip(clip));
      mk('DEL', () => this.deleteClip(clip.id));
      row.append(info, btns);
      this.listEl.append(row);
    }
  }

  // -------------------------------------------------------------- registrazione
  startRecording() {
    const g = this.game;
    if (!g.editorTest) return;
    if (this.playback) { g.ui.toast('REPLAY // ESCI DAL PLAYBACK PER REGISTRARE', 'red'); return; }
    if (this.rec) return;
    if (g.mode !== 'driving') { g.ui.toast('REPLAY // REGISTRI SOLO ALLA GUIDA', 'red'); return; }
    this.rec = {
      startedAt: performance.now(),
      lastSample: 0,
      frames: [],
      carTypes: {},
      nextId: 1,
      scene: g.playground?.active ? 'playground' : 'map',
    };
    this.badge?.classList.remove('hidden');
    this._refreshMenu();
    g.ui.toast('REPLAY // REC — REGISTRAZIONE IN CORSO', 'red');
    g.debugStats?.event?.('replay_rec_started', { scene: this.rec.scene });
  }

  stopRecording(auto = false) {
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;
    this.badge?.classList.add('hidden');
    const clip = {
      version: 1,
      id: `r${Date.now().toString(36)}`,
      name: this._defaultName(rec.scene),
      createdAt: Date.now(),
      scene: rec.scene,
      hz: SAMPLE_HZ,
      duration: rec.frames.length ? rec.frames[rec.frames.length - 1].t : 0,
      frames: rec.frames,
      carTypes: rec.carTypes,
    };
    this.lastClip = clip.frames.length ? clip : null;
    this._refreshMenu();
    if (this.lastClip) {
      this.game.ui.toast(`REPLAY // ${fmtTime(clip.duration)} REGISTRATI — APRI 3 E SALVA`, auto ? 'amber' : 'green');
      this.game.debugStats?.event?.('replay_rec_stopped', { auto, seconds: clip.duration, frames: clip.frames.length });
    }
    return this.lastClip;
  }

  // Chiamato a ogni frame da animate() mentre si guida: campiona a 20 Hz.
  captureFrame() {
    const rec = this.rec;
    if (!rec) return;
    const now = performance.now();
    if (now - rec.lastSample < 1000 / SAMPLE_HZ - 1) return;
    rec.lastSample = now;
    const g = this.game;
    const s = g.getVehicleState();
    const p = s.position || s;
    const tel = g.getTelemetry();
    const frame = {
      t: r2((now - rec.startedAt) / 1000),
      p: [r2(p.x), r2(p.y), r2(p.z)],
      h: Math.round((s.heading ?? s.yaw ?? 0) * 1000) / 1000,
      v: Math.round(tel.speedKmh || 0),
      r: Math.round(tel.rpm || 0),
      g: tel.gear ?? 0,
      st: r2(s.steerAngle ?? s.steering ?? 0),
      th: r2(tel.throttle || 0),
      tr: [],
    };
    if (rec.scene !== 'playground' && g.traffic) {
      for (const v of g.traffic.active) {
        // userData è un oggetto nuovo a ogni spawn, quindi l'id registrato
        // muore con il veicolo e un riuso del pool ottiene un id nuovo.
        if (v.userData._recId == null) {
          v.userData._recId = rec.nextId++;
          rec.carTypes[v.userData._recId] = v.type?.id || 'car';
        }
        frame.tr.push([
          v.userData._recId,
          r1(v.position.x), r1(v.position.y), r1(v.position.z),
          Math.round(v.heading * 100) / 100,
          v.braking ? 1 : 0,
        ]);
      }
    }
    rec.frames.push(frame);
    if (this.badgeTime) this.badgeTime.textContent = fmtTime(frame.t);
    if (rec.frames.length >= MAX_FRAMES) this.stopRecording(true);
  }

  _defaultName(scene) {
    const time = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    return `REC ${time} · ${scene === 'playground' ? 'TEST PAD' : 'C1'}`;
  }

  // ---------------------------------------------------------------- storage
  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return Array.isArray(data?.clips) ? data.clips : [];
    } catch (e) {
      return [];
    }
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, clips: this.clips }));
      return true;
    } catch (e) {
      // Quota piena: sacrifica il replay più vecchio e riprova una volta.
      if (this.clips.length > 1) {
        this.clips.pop();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, clips: this.clips }));
          this.game.ui.toast('REPLAY // SPAZIO ESAUSTO — RIMOSSO IL PIÙ VECCHIO', 'amber');
          return true;
        } catch (e2) { /* fall through */ }
      }
      this.game.ui.toast('REPLAY // SALVATAGGIO FALLITO (QUOTA) — USA JSON', 'red');
      return false;
    }
  }

  saveClip(clip) {
    if (!clip) return;
    this.clips.unshift(clip);
    while (this.clips.length > MAX_STORED) this.clips.pop();
    if (this._persist()) {
      this._refreshMenu();
      this.game.ui.toast('REPLAY // SALVATO', 'green');
    }
  }

  deleteClip(id) {
    const i = this.clips.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.clips.splice(i, 1);
    this._persist();
    this._refreshMenu();
  }

  exportClip(clip) {
    const safe = (clip.name || 'replay').replace(/[^\wà-ù\- ]/gi, '').trim().replace(/\s+/g, '-').toLowerCase() || 'replay';
    this._download(`hesi-replay-${safe}.json`, JSON.stringify(clip));
  }

  importClip(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let clip = null;
      try { clip = this._normalizeImported(JSON.parse(String(reader.result))); } catch (e) { /* invalid */ }
      if (!clip) { this.game.ui.toast('REPLAY // FILE NON VALIDO', 'red'); return; }
      if (this.clips.some((c) => c.id === clip.id)) clip.id = `r${Date.now().toString(36)}`;
      this.clips.unshift(clip);
      while (this.clips.length > MAX_STORED) this.clips.pop();
      this._persist();
      this._refreshMenu();
      this.game.ui.toast(`REPLAY // IMPORTATO "${clip.name.toUpperCase()}"`, 'green');
    };
    reader.readAsText(file);
  }

  _normalizeImported(data) {
    if (!data || !Array.isArray(data.frames) || !data.frames.length) return null;
    return {
      version: 1,
      id: typeof data.id === 'string' ? data.id : `r${Date.now().toString(36)}`,
      name: String(data.name || 'REPLAY IMPORTATO').slice(0, 40),
      createdAt: Number(data.createdAt) || Date.now(),
      scene: data.scene === 'playground' ? 'playground' : 'map',
      hz: Number(data.hz) || SAMPLE_HZ,
      duration: Number(data.duration) || data.frames[data.frames.length - 1].t || 0,
      frames: data.frames,
      carTypes: data.carTypes && typeof data.carTypes === 'object' ? data.carTypes : {},
    };
  }

  _download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --------------------------------------------------------------- playback
  startPlayback(clip) {
    const g = this.game;
    if (!g.editorTest || !clip?.frames?.length) return;
    if (this.playback) this.stopPlayback();
    if (g.mode !== 'driving' || g.crash?.active) { g.ui.toast('REPLAY // PLAYBACK SOLO ALLA GUIDA', 'red'); return; }
    const inPlayground = !!g.playground?.active;
    if ((clip.scene === 'playground') !== inPlayground) {
      g.ui.toast(clip.scene === 'playground' ? 'REPLAY // ENTRA NEL PLAYGROUND PER VEDERLO' : 'REPLAY // REGISTRATO SU MAPPA — ESCI DAL PLAYGROUND', 'amber');
      return;
    }
    if (this.rec) this.stopRecording();
    const s = g.getVehicleState();
    const p = s.position || s;
    const heading = s.heading ?? s.yaw ?? 0;
    const dir = new THREE.Vector3();
    g.camera.getWorldDirection(dir);
    this.playback = {
      clip,
      time: 0,
      speed: 1,
      paused: false,
      cam: 'chase',
      ghosts: new Map(),
      scrubbing: false,
      returnPose: { position: new THREE.Vector3(p.x, p.y, p.z), heading },
      prevHitboxes: { ...g.debug.hitboxes },
      prevCameraMode: g.cameraMode,
      orbit: { yaw: heading + Math.PI, pitch: 0.35, dist: 9 },
      fly: { pos: g.camera.position.clone(), yaw: Math.atan2(dir.x, dir.z), pitch: Math.asin(clampNum(dir.y, -1, 1)) },
      tv: { pos: new THREE.Vector3(), valid: false },
    };
    g.traffic?.clear?.();
    // La camera replay "chase" riusa updateCamera(): forziamo la modalità
    // chase del gioco (altrimenti hood/cockpit nasconderebbero l'auto) e la
    // ripristiniamo all'uscita.
    g.cameraMode = 'chase';
    g.snapDrivingCamera();
    this._applyHitboxOptions();
    this.toggleMenu(false);
    this.hud?.classList.remove('hidden');
    this._syncHud();
    g.ui.toast('REPLAY // PLAYBACK — SPAZIO pausa · ←/→ ±2s · ,/. frame · C camera', 'green');
    g.debugStats?.event?.('replay_playback_started', { name: clip.name, seconds: clip.duration });
  }

  stopPlayback() {
    const pb = this.playback;
    if (!pb) return;
    this.playback = null;
    const g = this.game;
    g.traffic?.clear?.();
    for (const kind of Object.keys(pb.prevHitboxes)) g.setDebugHitbox(kind, pb.prevHitboxes[kind]);
    g.cameraMode = pb.prevCameraMode || 'chase';
    g.placeVehicle(pb.returnPose.position, pb.returnPose.heading);
    g.updatePlayerMesh();
    g.snapDrivingCamera();
    g.updateSpeedBlur?.(0);
    this.hud?.classList.add('hidden');
    document.exitPointerLock?.();
    this._refreshMenu();
    g.ui.toast('REPLAY // PLAYBACK CHIUSO', 'amber');
  }

  togglePause() {
    const pb = this.playback;
    if (!pb) return;
    pb.paused = !pb.paused;
    this._syncHud();
  }

  seek(delta) {
    const pb = this.playback;
    if (!pb) return;
    pb.time = clampNum(pb.time + delta, 0, pb.clip.duration);
    this._syncHud();
  }

  stepFrame(dir) {
    const pb = this.playback;
    if (!pb) return;
    pb.paused = true;
    const frames = pb.clip.frames;
    let i = frames.findIndex((f) => f.t >= pb.time - 1e-4);
    if (i < 0) i = frames.length - 1;
    i = clampNum(i + dir, 0, frames.length - 1);
    pb.time = frames[i].t;
    this._syncHud();
  }

  cycleCamera() {
    const pb = this.playback;
    if (!pb) return;
    pb.cam = CAMERAS[(CAMERAS.indexOf(pb.cam) + 1) % CAMERAS.length];
    const g = this.game;
    if (pb.cam === 'chase') g.snapDrivingCamera();
    else if (pb.cam === 'tv') pb.tv.valid = false;
    else if (pb.cam === 'fly') {
      pb.fly.pos.copy(g.camera.position);
      const dir = new THREE.Vector3();
      g.camera.getWorldDirection(dir);
      pb.fly.yaw = Math.atan2(dir.x, dir.z);
      pb.fly.pitch = Math.asin(clampNum(dir.y, -1, 1));
    }
    if (this._camWantsPointer() && !this.menuOpen && !g.isTouchDevice) g.requestDronePointerLock?.();
    else if (!this._camWantsPointer()) document.exitPointerLock?.();
    g.ui.toast(`REPLAY CAM // ${pb.cam.toUpperCase()}`, 'amber');
    this._syncHud();
  }

  _camWantsPointer() {
    return !!this.playback && (this.playback.cam === 'orbit' || this.playback.cam === 'fly');
  }

  _applyHitboxOptions() {
    const g = this.game;
    g.setDebugHitbox('vehicles', this.options.hitboxes);
    g.setDebugHitbox('roads', this.options.roads);
    g.setDebugHitbox('walls', this.options.walls);
  }

  // Chiamato da animate() al posto di updateDriving() durante il playback.
  update(dt) {
    const pb = this.playback;
    if (!pb) return;
    const g = this.game;
    const clip = pb.clip;
    const inPlayground = !!g.playground?.active;
    if ((clip.scene === 'playground') !== inPlayground) { this.stopPlayback(); return; }
    if (!pb.paused && !pb.scrubbing) {
      pb.time += dt * pb.speed;
      if (pb.time >= clip.duration) {
        if (this.options.loop) pb.time = 0;
        else { pb.time = clip.duration; pb.paused = true; }
      }
    }
    const pose = this._sample(clip, pb.time);
    if (!pose) return;
    g.placeVehicle(pose.pos, pose.h);
    g.updatePlayerMesh(dt);
    this._poseGhosts(pose.cars);
    if (clip.scene !== 'playground') g.map?.update?.(pose.pos, performance.now() / 1000);
    const tel = {
      speedKmh: pose.v,
      speedMS: pose.v / 3.6,
      rpm: pose.r,
      gear: pose.g,
      gearLabel: pose.g === 0 ? 'N' : pose.g < 0 ? 'R' : String(pose.g),
      redline: 7000,
      throttle: pose.th,
      slip: 0,
      fuel: 1,
      fuelFraction: 1,
    };
    this._updateCamera(dt, pose, tel);
    g.updateSpeedBlur?.(tel.speedKmh);
    g.updateAudio?.(tel, dt);
    if (g.shouldUpdateHUD?.()) {
      g.ui.updateHUD(tel, g.run, { money: g.displayMoney(), routeName: 'REPLAY', areaName: clip.scene === 'playground' ? 'TEST PAD' : 'PLAYBACK' });
    }
    if (this.hudSpeedo) this.hudSpeedo.textContent = `${pose.v} KM/H`;
    this._syncHud();
  }

  _syncHud() {
    const pb = this.playback;
    if (!pb || !this.hud) return;
    if (!pb.scrubbing && this.hudSeek) this.hudSeek.value = Math.round((pb.time / Math.max(0.001, pb.clip.duration)) * 1000);
    if (this.hudTime) this.hudTime.textContent = `${fmtTime(pb.time)} / ${fmtTime(pb.clip.duration)}`;
    if (this.hudPlay) this.hudPlay.textContent = pb.paused ? '>' : '||';
    if (this.hudSpeed) this.hudSpeed.textContent = `${pb.speed}×`;
    if (this.hudCam) this.hudCam.textContent = `CAM ${pb.cam.toUpperCase()}`;
    this.hudHitbox?.classList.toggle('on', this.options.hitboxes);
  }

  // Interpola la posa (giocatore + traffico) al tempo richiesto.
  _sample(clip, time) {
    const frames = clip.frames;
    if (!frames.length) return null;
    const last = frames.length - 1;
    if (time <= frames[0].t) return this._poseFrom(frames[0], frames[0], 0);
    if (time >= frames[last].t) return this._poseFrom(frames[last], frames[last], 0);
    let lo = 0;
    let hi = last;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= time) lo = mid;
      else hi = mid;
    }
    const a = frames[lo];
    const b = frames[hi];
    return this._poseFrom(a, b, (time - a.t) / Math.max(1e-6, b.t - a.t));
  }

  _poseFrom(a, b, t) {
    const pos = new THREE.Vector3(
      a.p[0] + (b.p[0] - a.p[0]) * t,
      a.p[1] + (b.p[1] - a.p[1]) * t,
      a.p[2] + (b.p[2] - a.p[2]) * t,
    );
    const bMap = new Map();
    for (const c of b.tr) bMap.set(c[0], c);
    const seen = new Set();
    const cars = [];
    for (const ca of a.tr) {
      seen.add(ca[0]);
      const cb = bMap.get(ca[0]);
      if (cb) {
        cars.push([
          ca[0],
          ca[1] + (cb[1] - ca[1]) * t,
          ca[2] + (cb[2] - ca[2]) * t,
          ca[3] + (cb[3] - ca[3]) * t,
          lerpAngle(ca[4], cb[4], t),
          cb[5],
        ]);
      } else cars.push(ca);
    }
    for (const cb of b.tr) if (!seen.has(cb[0])) cars.push(cb);
    return {
      pos,
      h: lerpAngle(a.h, b.h, t),
      v: Math.round(a.v + (b.v - a.v) * t),
      r: Math.round(a.r + (b.r - a.r) * t),
      g: t < 0.5 ? a.g : b.g,
      th: a.th + (b.th - a.th) * t,
      cars,
    };
  }

  // Riposiziona i ghost del traffico: veicoli del pool spawnati fuori scena
  // con il modello registrato e poi posati a mano a ogni frame.
  _poseGhosts(cars) {
    const g = this.game;
    const traffic = g.traffic;
    if (!traffic) return;
    const pb = this.playback;
    const seen = new Set();
    for (const c of cars) {
      const id = c[0];
      seen.add(id);
      let v = pb.ghosts.get(id);
      if (!v) {
        v = this._spawnGhost(id);
        if (!v) continue;
        pb.ghosts.set(id, v);
      }
      v.position.set(c[1], c[2], c[3]);
      v.previousPosition.copy(v.position);
      v.heading = c[4];
      v.tangent.set(Math.sin(c[4]), 0, Math.cos(c[4]));
      v.right.set(Math.cos(c[4]), 0, -Math.sin(c[4]));
      v.up.set(0, 1, 0);
      v.braking = !!c[5];
      traffic._orientVehicle(v);
    }
    for (const [id, v] of [...pb.ghosts]) {
      if (!seen.has(id)) {
        try { traffic._deactivate(v, 'replay'); } catch (e) { /* pool già pulito */ }
        pb.ghosts.delete(id);
      }
    }
    const s = g.getVehicleState();
    const p = s.position || s;
    const h = s.heading ?? s.yaw ?? 0;
    this._batchPlayer = this._batchPlayer || { position: new THREE.Vector3(), forward: new THREE.Vector3() };
    this._batchPlayer.position.set(p.x, p.y, p.z);
    this._batchPlayer.forward.set(Math.sin(h), 0, Math.cos(h));
    traffic._syncRenderBatches(this._batchPlayer);
  }

  _spawnGhost(id) {
    const traffic = this.game.traffic;
    const type = this.playback?.clip?.carTypes?.[id];
    const spawn = {
      position: new THREE.Vector3(0, -1000 - id * 30, 0),
      tangent: new THREE.Vector3(0, 0, 1),
      playerDistance: Infinity,
    };
    try {
      return traffic.spawnVehicle(spawn, { type: type || undefined, speed: 0, initialSpeed: 0, userData: { replayGhost: true } });
    } catch (e) {
      return null;
    }
  }

  _updateCamera(dt, pose, tel) {
    const g = this.game;
    const pb = this.playback;
    const p = pose.pos;
    if (pb.cam === 'chase') {
      g.updateCamera(dt, tel);
      return;
    }
    if (pb.cam === 'orbit') {
      const o = pb.orbit;
      const cp = Math.cos(o.pitch);
      g.camera.position.set(
        p.x - Math.sin(o.yaw) * cp * o.dist,
        p.y + Math.sin(o.pitch) * o.dist + 1.2,
        p.z - Math.cos(o.yaw) * cp * o.dist,
      );
      g.camera.up.set(0, 1, 0);
      g.camera.lookAt(p.x, p.y + 1, p.z);
      g.camera.fov = 64;
      g.camera.updateProjectionMatrix();
      return;
    }
    if (pb.cam === 'tv') {
      // Camera da circuito: fissa finché l'auto non si allontana, poi salta
      // a una postazione più avanti lungo la traiettoria.
      const tv = pb.tv;
      if (!tv.valid || tv.pos.distanceTo(p) > 95) {
        const f = new THREE.Vector3(Math.sin(pose.h), 0, Math.cos(pose.h));
        const r = new THREE.Vector3(f.z, 0, -f.x);
        tv.pos.copy(p).addScaledVector(f, 26).addScaledVector(r, 10).add(new THREE.Vector3(0, 5.5, 0));
        tv.valid = true;
      }
      g.camera.position.copy(tv.pos);
      g.camera.up.set(0, 1, 0);
      g.camera.lookAt(p.x, p.y + 0.8, p.z);
      g.camera.fov = 40;
      g.camera.updateProjectionMatrix();
      return;
    }
    // Volo libero: WASD + mouse come il drone noclip.
    const fly = pb.fly;
    const keys = g.keys;
    const turn = 1.4 * dt;
    if (keys.ArrowLeft) fly.yaw += turn;
    if (keys.ArrowRight) fly.yaw -= turn;
    if (keys.ArrowUp) fly.pitch = clampNum(fly.pitch + turn, -1.5, 1.5);
    if (keys.ArrowDown) fly.pitch = clampNum(fly.pitch - turn, -1.5, 1.5);
    const cp = Math.cos(fly.pitch);
    const fwd = new THREE.Vector3(Math.sin(fly.yaw) * cp, Math.sin(fly.pitch), Math.cos(fly.yaw) * cp);
    const right = new THREE.Vector3(-Math.cos(fly.yaw), 0, Math.sin(fly.yaw));
    const move = new THREE.Vector3();
    if (keys.KeyW) move.add(fwd);
    if (keys.KeyS) move.sub(fwd);
    if (keys.KeyD) move.add(right);
    if (keys.KeyA) move.sub(right);
    if (keys.Space || keys.KeyE) move.y += 1;
    if (keys.ControlLeft || keys.KeyQ) move.y -= 1;
    if (move.lengthSq()) fly.pos.addScaledVector(move.normalize(), ((keys.ShiftLeft || keys.ShiftRight) ? 90 : 30) * dt);
    g.camera.position.copy(fly.pos);
    g.camera.up.set(0, 1, 0);
    g.camera.lookAt(fly.pos.x + fwd.x, fly.pos.y + fwd.y, fly.pos.z + fwd.z);
    g.camera.fov = 64;
    g.camera.updateProjectionMatrix();
  }
}
