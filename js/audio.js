/**
 * Procedural WebAudio soundscape. No files, media elements, or decoded assets
 * are used: every continuous sound and one-shot is synthesised at runtime.
 */

export const ENGINE_PROFILES = Object.freeze({
  I3: Object.freeze({ cylinders: 3, firingEvents: 1.5, ratios: [1, 2, 3.02], waves: ['sawtooth', 'square', 'sine'], gains: [0.62, 0.20, 0.12], detune: [-5, 7, 2], tone: 0.74, noise: 0.22, distortion: 34, uneven: 0.07 }),
  I4: Object.freeze({ cylinders: 4, firingEvents: 2, ratios: [1, 2, 4.01], waves: ['sawtooth', 'square', 'sine'], gains: [0.57, 0.24, 0.10], detune: [-3, 4, 0], tone: 0.86, noise: 0.19, distortion: 42, uneven: 0 }),
  H4: Object.freeze({ cylinders: 4, firingEvents: 2, ratios: [0.5, 1, 2.01], waves: ['sawtooth', 'square', 'triangle'], gains: [0.46, 0.50, 0.16], detune: [-9, 5, 11], tone: 0.66, noise: 0.25, distortion: 54, uneven: 0.16 }),
  I6: Object.freeze({ cylinders: 6, firingEvents: 3, ratios: [0.5, 1, 2], waves: ['triangle', 'sawtooth', 'sine'], gains: [0.32, 0.54, 0.19], detune: [-2, 1, 3], tone: 1.02, noise: 0.12, distortion: 25, uneven: 0 }),
  V6: Object.freeze({ cylinders: 6, firingEvents: 3, ratios: [0.5, 1, 1.5], waves: ['sawtooth', 'triangle', 'square'], gains: [0.39, 0.48, 0.12], detune: [-8, 6, 13], tone: 0.82, noise: 0.17, distortion: 38, uneven: 0.08 }),
  V8: Object.freeze({ cylinders: 8, firingEvents: 4, ratios: [0.25, 0.5, 1], waves: ['square', 'sawtooth', 'triangle'], gains: [0.49, 0.53, 0.18], detune: [-12, 8, 1], tone: 0.52, noise: 0.24, distortion: 67, uneven: 0.12 }),
  R2: Object.freeze({ cylinders: 2, firingEvents: 3, ratios: [1, 2, 3], waves: ['sawtooth', 'sine', 'triangle'], gains: [0.47, 0.33, 0.21], detune: [0, 5, -4], tone: 1.18, noise: 0.14, distortion: 31, uneven: 0 }),
});

const DEFAULT_VOLUMES = Object.freeze({ master: 0.82, engine: 0.88, effects: 0.90, ambient: 0.28 });
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : min));
const lerp = (a, b, t) => a + (b - a) * t;

export function normalizeEngineLayout(layout) {
  const normalized = String(layout || 'I4').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (ENGINE_PROFILES[normalized]) return normalized;
  if (normalized.includes('ROTARY') || normalized.startsWith('R')) return 'R2';
  if (normalized.includes('BOXER') || normalized.includes('FLAT4')) return 'H4';
  if (normalized.includes('V8') || normalized.includes('8')) return 'V8';
  if (normalized.includes('I6') || normalized.includes('L6') || normalized.includes('STRAIGHT6')) return 'I6';
  if (normalized.includes('V6') || normalized.includes('6')) return 'V6';
  if (normalized.includes('I3') || normalized.includes('3')) return 'I3';
  return 'I4';
}

function audioContextConstructor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function distortionCurve(amount = 40, samples = 2048) {
  const curve = new Float32Array(samples);
  const k = Math.max(0, amount);
  const deg = Math.PI / 180;
  for (let index = 0; index < samples; index += 1) {
    const x = index * 2 / samples - 1;
    curve[index] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function createNoiseBuffer(context, seconds = 2, color = 'pink') {
  const frames = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const channel = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let previous = 0;
  for (let index = 0; index < frames; index += 1) {
    const white = Math.random() * 2 - 1;
    if (color === 'brown') {
      previous = (previous + 0.018 * white) / 1.018;
      channel[index] = previous * 3.2;
    } else if (color === 'pink') {
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      channel[index] = (b0 + b1 + white * 0.1848) * 0.22;
    } else {
      channel[index] = white;
    }
  }
  return buffer;
}

function setTarget(param, value, now, timeConstant = 0.04) {
  if (!param) return;
  const target = Number.isFinite(value) ? value : 0;
  try {
    param.cancelScheduledValues(now);
    param.setTargetAtTime(target, now, Math.max(0.001, timeConstant));
  } catch {
    param.value = target;
  }
}

function envelope(param, now, peak, attack, hold, release, start = 0.0001) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.max(0.0001, start), now);
  param.exponentialRampToValueAtTime(Math.max(0.0001, peak), now + attack);
  param.setValueAtTime(Math.max(0.0001, peak), now + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, now + attack + hold + release);
}

export class AudioSystem {
  constructor(options = {}) {
    this.context = null;
    this.nodes = {};
    this.buffers = {};
    this.sources = [];
    this.supported = Boolean(audioContextConstructor());
    this.unlocked = false;
    this.disposed = false;
    this.muted = false;
    this.engineRunning = false;
    this.ambientRunning = options.ambient !== false;
    this.layout = normalizeEngineLayout(options.layout || 'I4');
    this.profile = ENGINE_PROFILES[this.layout];
    this.redlineRpm = clamp(options.redlineRpm || 7500, 3000, 12000);
    this.turboLevel = Math.max(0, Number(options.turboLevel) || 0);
    this.volumes = {
      master: clamp(options.masterVolume ?? options.master ?? options.volume ?? DEFAULT_VOLUMES.master),
      engine: clamp(options.engineVolume ?? options.engine ?? DEFAULT_VOLUMES.engine),
      effects: clamp(options.effectsVolume ?? options.effects ?? DEFAULT_VOLUMES.effects),
      ambient: clamp(options.ambientVolume ?? options.ambient ?? DEFAULT_VOLUMES.ambient),
    };
    this.state = {
      rpm: 850, throttle: 0, load: 0, boost: 0, slip: 0,
      speedKmh: 0, fuel: 1, previousThrottle: 0, previousBoost: 0,
    };
    this._unlockTarget = null;
    this._lastNearMissAt = -Infinity;
    this._lastCrashAt = -Infinity;
    this._lastUiAt = -Infinity;
    this._unlockHandler = () => { this.unlock(); };
    this._visibilityHandler = () => {
      if (!this.context) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.context.suspend().catch(() => {});
    };
    if (options.bindGestures !== false && typeof document !== 'undefined') this.bindUnlockGestures(document);
  }

  get ready() { return this.unlocked && this.context?.state === 'running'; }
  get isSupported() { return this.supported; }

  bindUnlockGestures(target = typeof document !== 'undefined' ? document : null) {
    if (!target || this._unlockTarget === target) return;
    this.unbindUnlockGestures();
    this._unlockTarget = target;
    target.addEventListener('pointerdown', this._unlockHandler, { capture: true, passive: true });
    target.addEventListener('touchstart', this._unlockHandler, { capture: true, passive: true });
    target.addEventListener('keydown', this._unlockHandler, { capture: true });
  }

  unbindUnlockGestures() {
    if (!this._unlockTarget) return;
    this._unlockTarget.removeEventListener('pointerdown', this._unlockHandler, true);
    this._unlockTarget.removeEventListener('touchstart', this._unlockHandler, true);
    this._unlockTarget.removeEventListener('keydown', this._unlockHandler, true);
    this._unlockTarget = null;
  }

  async unlock() {
    if (!this.supported || this.disposed) return false;
    try {
      if (!this.context) {
        const Context = audioContextConstructor();
        try { this.context = new Context({ latencyHint: 'interactive' }); }
        catch { this.context = new Context(); }
        this._buildGraph();
      }
      if (this.context.state !== 'running') await this.context.resume();
      this.unlocked = this.context.state === 'running';
      if (this.unlocked) {
        this.unbindUnlockGestures();
        this._applyVolumes(0.025);
        this._applyEngineState(true);
        this._setAmbient(this.ambientRunning, 0.7);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._visibilityHandler);
      }
      return this.unlocked;
    } catch (error) {
      console.warn('WebAudio could not be unlocked:', error);
      this.unlocked = false;
      return false;
    }
  }

  async resume() { return this.unlock(); }

  async suspend() {
    if (!this.context || this.context.state !== 'running') return false;
    await this.context.suspend();
    return true;
  }

  _buildGraph() {
    const context = this.context;
    const now = context.currentTime;
    this.buffers.white = createNoiseBuffer(context, 1.25, 'white');
    this.buffers.pink = createNoiseBuffer(context, 2.5, 'pink');
    const masterGain = context.createGain();
    masterGain.gain.value = 0.0001;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -7;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.16;
    masterGain.connect(limiter).connect(context.destination);

    const engineBus = context.createGain();
    const effectsBus = context.createGain();
    const ambientBus = context.createGain();
    engineBus.gain.value = this.volumes.engine;
    effectsBus.gain.value = this.volumes.effects;
    ambientBus.gain.value = this.volumes.ambient;
    engineBus.connect(masterGain);
    effectsBus.connect(masterGain);
    ambientBus.connect(masterGain);

    const engineMix = context.createGain();
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.Q.value = 0.75;
    const engineDrive = context.createWaveShaper();
    engineDrive.oversample = '2x';
    engineDrive.curve = distortionCurve(this.profile.distortion);
    const engineOutput = context.createGain();
    engineOutput.gain.value = 0.0001;
    engineMix.connect(engineFilter).connect(engineDrive).connect(engineOutput).connect(engineBus);

    const engineOscillators = [];
    const engineOscillatorGains = [];
    for (let index = 0; index < 3; index += 1) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = this.profile.waves[index];
      oscillator.frequency.value = 30;
      oscillator.detune.value = this.profile.detune[index];
      gain.gain.value = this.profile.gains[index];
      oscillator.connect(gain).connect(engineMix);
      oscillator.start(now);
      engineOscillators.push(oscillator);
      engineOscillatorGains.push(gain);
      this.sources.push(oscillator);
    }

    const engineNoise = context.createBufferSource();
    engineNoise.buffer = this.buffers.pink;
    engineNoise.loop = true;
    const engineNoiseFilter = context.createBiquadFilter();
    engineNoiseFilter.type = 'bandpass';
    engineNoiseFilter.frequency.value = 520;
    engineNoiseFilter.Q.value = 0.7;
    const engineNoiseGain = context.createGain();
    engineNoiseGain.gain.value = 0.0001;
    engineNoise.connect(engineNoiseFilter).connect(engineNoiseGain).connect(engineMix);
    engineNoise.start(now);
    this.sources.push(engineNoise);

    const turboOscillator = context.createOscillator();
    turboOscillator.type = 'sine';
    turboOscillator.frequency.value = 900;
    const turboFilter = context.createBiquadFilter();
    turboFilter.type = 'bandpass';
    turboFilter.frequency.value = 1400;
    turboFilter.Q.value = 3.8;
    const turboGain = context.createGain();
    turboGain.gain.value = 0.0001;
    turboOscillator.connect(turboFilter).connect(turboGain).connect(engineBus);
    turboOscillator.start(now);
    this.sources.push(turboOscillator);

    const tireSource = context.createBufferSource();
    tireSource.buffer = this.buffers.white;
    tireSource.loop = true;
    const tireHighpass = context.createBiquadFilter();
    tireHighpass.type = 'highpass';
    tireHighpass.frequency.value = 1100;
    const tireFilter = context.createBiquadFilter();
    tireFilter.type = 'bandpass';
    tireFilter.frequency.value = 2400;
    tireFilter.Q.value = 1.7;
    const tireGain = context.createGain();
    tireGain.gain.value = 0.0001;
    tireSource.connect(tireHighpass).connect(tireFilter).connect(tireGain).connect(effectsBus);
    tireSource.start(now);
    this.sources.push(tireSource);

    const windSource = context.createBufferSource();
    windSource.buffer = this.buffers.pink;
    windSource.loop = true;
    const windHighpass = context.createBiquadFilter();
    windHighpass.type = 'highpass';
    windHighpass.frequency.value = 260;
    const windLowpass = context.createBiquadFilter();
    windLowpass.type = 'lowpass';
    windLowpass.frequency.value = 1700;
    const windGain = context.createGain();
    windGain.gain.value = 0.0001;
    windSource.connect(windHighpass).connect(windLowpass).connect(windGain).connect(effectsBus);
    windSource.start(now);
    this.sources.push(windSource);

    const padFilter = context.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 380;
    padFilter.Q.value = 0.8;
    const padGain = context.createGain();
    padGain.gain.value = 0.0001;
    padFilter.connect(padGain).connect(ambientBus);
    const padOscillators = [];
    const chord = [55, 82.41, 110, 164.81];
    for (let index = 0; index < chord.length; index += 1) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = index % 2 ? 'triangle' : 'sine';
      oscillator.frequency.value = chord[index];
      oscillator.detune.value = [-7, 4, -3, 8][index];
      gain.gain.value = [0.24, 0.16, 0.11, 0.07][index];
      oscillator.connect(gain).connect(padFilter);
      oscillator.start(now);
      padOscillators.push(oscillator);
      this.sources.push(oscillator);
    }
    const padLfo = context.createOscillator();
    const padLfoGain = context.createGain();
    padLfo.type = 'sine';
    padLfo.frequency.value = 0.075;
    padLfoGain.gain.value = 95;
    padLfo.connect(padLfoGain).connect(padFilter.frequency);
    padLfo.start(now);
    this.sources.push(padLfo);

    Object.assign(this.nodes, {
      masterGain, limiter, engineBus, effectsBus, ambientBus,
      engineMix, engineFilter, engineDrive, engineOutput,
      engineOscillators, engineOscillatorGains, engineNoise, engineNoiseFilter, engineNoiseGain,
      turboOscillator, turboFilter, turboGain,
      tireSource, tireHighpass, tireFilter, tireGain,
      windSource, windHighpass, windLowpass, windGain,
      padFilter, padGain, padOscillators, padLfo,
    });
  }

  _applyVolumes(timeConstant = 0.04) {
    if (!this.context) return;
    const now = this.context.currentTime;
    setTarget(this.nodes.masterGain?.gain, this.muted ? 0.0001 : this.volumes.master, now, timeConstant);
    setTarget(this.nodes.engineBus?.gain, this.volumes.engine, now, timeConstant);
    setTarget(this.nodes.effectsBus?.gain, this.volumes.effects, now, timeConstant);
    setTarget(this.nodes.ambientBus?.gain, this.volumes.ambient, now, timeConstant);
  }

  setVolume(channel, value) {
    if (typeof channel === 'number' && value === undefined) {
      value = channel;
      channel = 'master';
    }
    const key = channel === 'sfx' ? 'effects' : channel;
    if (!(key in this.volumes)) return false;
    this.volumes[key] = clamp(value);
    this._applyVolumes();
    return true;
  }

  setMasterVolume(value) { return this.setVolume('master', value); }
  setEngineVolume(value) { return this.setVolume('engine', value); }
  setEffectsVolume(value) { return this.setVolume('effects', value); }
  setAmbientVolume(value) { return this.setVolume('ambient', value); }

  setVolumes(settings = {}) {
    const mappings = {
      master: settings.master ?? settings.masterVolume,
      engine: settings.engine ?? settings.engineVolume,
      effects: settings.effects ?? settings.sfx ?? settings.effectsVolume,
      ambient: settings.ambient ?? settings.ambientVolume,
    };
    for (const [key, value] of Object.entries(mappings)) {
      if (value !== undefined) this.volumes[key] = clamp(value);
    }
    this._applyVolumes();
    return { ...this.volumes };
  }

  mute(value = true) {
    this.muted = Boolean(value);
    this._applyVolumes(0.025);
    return this.muted;
  }

  unmute() { return this.mute(false); }
  toggleMute() { return this.mute(!this.muted); }

  setEngineLayout(layout, options = {}) {
    this.layout = normalizeEngineLayout(layout);
    this.profile = ENGINE_PROFILES[this.layout];
    if (options.redlineRpm !== undefined) this.redlineRpm = clamp(options.redlineRpm, 3000, 12000);
    if (options.turboLevel !== undefined) this.turboLevel = Math.max(0, Number(options.turboLevel) || 0);
    if (!this.context) return this.layout;
    const now = this.context.currentTime;
    this.nodes.engineDrive.curve = distortionCurve(this.profile.distortion);
    this.nodes.engineOscillators.forEach((oscillator, index) => {
      oscillator.type = this.profile.waves[index];
      setTarget(oscillator.detune, this.profile.detune[index], now, 0.03);
      setTarget(this.nodes.engineOscillatorGains[index].gain, this.profile.gains[index], now, 0.05);
    });
    this._applyEngineState(true);
    return this.layout;
  }

  setVehicle(vehicle = {}) {
    const engine = vehicle.engine || vehicle;
    const aspiration = String(engine.aspiration || '');
    const turboLevel = engine.turboLevel ?? vehicle.modifiers?.turboLevel ?? (aspiration.toLowerCase().includes('turbo') ? 0.55 : 0);
    this.setEngineLayout(engine.layout || 'I4', {
      redlineRpm: engine.redlineRpm || 7500,
      turboLevel,
    });
    return { layout: this.layout, redlineRpm: this.redlineRpm, turboLevel: this.turboLevel };
  }

  startEngine(options = {}) {
    this.engineRunning = true;
    if (options.layout || options.engine) this.setVehicle(options.engine || options);
    this._applyEngineState(true);
  }

  stopEngine(immediate = false) {
    this.engineRunning = false;
    if (!this.context) return;
    setTarget(this.nodes.engineOutput.gain, 0.0001, this.context.currentTime, immediate ? 0.005 : 0.18);
    setTarget(this.nodes.turboGain.gain, 0.0001, this.context.currentTime, immediate ? 0.005 : 0.10);
  }

  setEngineRunning(running) {
    if (running) this.startEngine(); else this.stopEngine();
  }

  updateEngine(input = {}, throttleValue, speedValue, slipValue) {
    const update = typeof input === 'number'
      ? { rpm: input, throttle: throttleValue, speedKmh: speedValue, slip: slipValue }
      : (input || {});
    if (update.engineLayout && normalizeEngineLayout(update.engineLayout) !== this.layout) {
      this.setEngineLayout(update.engineLayout, { redlineRpm: update.redline || update.redlineRpm || this.redlineRpm, turboLevel: update.turbo ?? this.turboLevel });
    } else {
      if (update.redline !== undefined || update.redlineRpm !== undefined) this.redlineRpm = clamp(update.redline ?? update.redlineRpm, 3000, 12000);
      if (update.turbo !== undefined && update.boost === undefined) this.turboLevel = Math.max(0, Number(update.turbo) || 0);
    }
    const previousThrottle = this.state.throttle;
    const previousBoost = this.state.boost;
    this.state.rpm = clamp(update.rpm ?? this.state.rpm, 0, 13000);
    this.state.throttle = clamp(update.throttle ?? this.state.throttle);
    this.state.load = clamp(update.load ?? this.state.throttle);
    this.state.speedKmh = Math.max(0, Number(update.speedKmh ?? update.speed ?? this.state.speedKmh) || 0);
    const slipInput = update.slip ?? update.tireSlip ?? Math.max(Math.abs(Number(update.frontSlip) || 0), Math.abs(Number(update.rearSlip) || 0));
    this.state.slip = Math.max(0, Number(slipInput) || 0);
    this.state.fuel = clamp(update.fuel ?? this.state.fuel);
    const boostThreshold = clamp((this.state.rpm / Math.max(1, this.redlineRpm) - 0.22) / 0.55);
    this.state.boost = clamp(update.boost ?? (this.turboLevel > 0 ? boostThreshold * this.state.throttle * Math.min(1, this.turboLevel) : 0));
    this.state.previousThrottle = previousThrottle;
    this.state.previousBoost = previousBoost;
    if (update.running !== undefined) this.engineRunning = Boolean(update.running);
    else if (this.state.rpm > 300 && this.state.fuel > 0.0001) this.engineRunning = true;
    if (this.state.fuel <= 0.0001) this.engineRunning = false;

    if (previousThrottle - this.state.throttle > 0.34 && previousBoost > 0.22 && this.turboLevel > 0) {
      this.blowOff(Math.min(1, previousBoost * (0.65 + this.turboLevel * 0.25)));
    }
    this._applyEngineState(false);
    return { ...this.state };
  }

  update(input, throttle, speedKmh, slip) { return this.updateEngine(input, throttle, speedKmh, slip); }
  setRPM(rpm, throttle, speedKmh, slip) { return this.updateEngine(rpm, throttle, speedKmh, slip); }

  _applyEngineState(immediate = false) {
    if (!this.context || !this.nodes.engineOscillators) return;
    const now = this.context.currentTime;
    const state = this.state;
    const profile = this.profile;
    const rpm = Math.max(300, state.rpm);
    const firingHz = rpm / 60 * profile.firingEvents;
    const normalizedRpm = clamp(rpm / this.redlineRpm);
    this.nodes.engineOscillators.forEach((oscillator, index) => {
      const unevenWobble = profile.uneven * Math.sin(now * (5.2 + index * 1.7)) * firingHz;
      const frequency = Math.max(18, firingHz * profile.ratios[index] + unevenWobble);
      setTarget(oscillator.frequency, frequency, now, immediate ? 0.008 : 0.025);
    });
    const alive = this.engineRunning && state.fuel > 0;
    const idlePresence = alive ? 0.022 : 0.0001;
    const engineLevel = alive
      ? idlePresence + (0.035 + state.throttle * 0.095 + state.load * 0.025) * (0.45 + normalizedRpm * 0.82)
      : 0.0001;
    setTarget(this.nodes.engineOutput.gain, engineLevel, now, immediate ? 0.006 : 0.035);
    setTarget(this.nodes.engineFilter.frequency, 430 + normalizedRpm * 3650 * profile.tone + state.throttle * 900, now, 0.045);
    setTarget(this.nodes.engineNoiseFilter.frequency, 320 + normalizedRpm * 3200, now, 0.05);
    setTarget(this.nodes.engineNoiseGain.gain, alive ? profile.noise * (0.08 + state.throttle * 0.20 + normalizedRpm * 0.15) : 0.0001, now, 0.04);

    const turboAudible = alive ? clamp(state.boost * Math.min(1.35, this.turboLevel)) : 0;
    const whistleFrequency = 650 + normalizedRpm * 4100 + turboAudible * 1850;
    setTarget(this.nodes.turboOscillator.frequency, whistleFrequency, now, 0.025);
    setTarget(this.nodes.turboFilter.frequency, whistleFrequency * 1.06, now, 0.04);
    setTarget(this.nodes.turboGain.gain, 0.0001 + turboAudible * 0.028, now, 0.035);

    const slipThreshold = Math.max(0, state.slip - 0.08);
    const slipLevel = clamp(slipThreshold / 0.65) * clamp(state.speedKmh / 38);
    setTarget(this.nodes.tireGain.gain, 0.0001 + slipLevel * 0.13, now, 0.025);
    setTarget(this.nodes.tireFilter.frequency, 1850 + clamp(state.slip / 1.2) * 2300 + Math.min(1200, state.speedKmh * 3), now, 0.045);

    const wind = Math.pow(clamp((state.speedKmh - 25) / 285), 1.55);
    setTarget(this.nodes.windGain.gain, 0.0001 + wind * 0.115, now, 0.10);
    setTarget(this.nodes.windLowpass.frequency, 900 + Math.min(3600, state.speedKmh * 9), now, 0.12);
  }

  setTireSlip(slip, speedKmh = this.state.speedKmh) {
    return this.updateEngine({ slip, speedKmh });
  }

  setSpeed(speedKmh) { return this.updateEngine({ speedKmh }); }

  gearShift(direction = 1, intensity = 0.7) {
    if (!this.context || !this.ready) return false;
    const now = this.context.currentTime;
    const amount = clamp(intensity);
    setTarget(this.nodes.engineOutput.gain, 0.018, now, 0.008);
    setTarget(this.nodes.engineOutput.gain, this.engineRunning ? 0.07 : 0.0001, now + 0.065, 0.025);
    this._metalClick(direction > 0 ? 820 : 610, amount * 0.65);
    if (direction > 0 && this.turboLevel > 0 && this.state.boost > 0.15) this.blowOff(this.state.boost * 0.62);
    return true;
  }

  _metalClick(frequency = 760, intensity = 0.5) {
    if (!this.context || !this.ready) return;
    const context = this.context;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.55, now + 0.045);
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 2.8;
    envelope(gain.gain, now, 0.08 * clamp(intensity), 0.002, 0.005, 0.055);
    oscillator.connect(filter).connect(gain).connect(this.nodes.effectsBus);
    oscillator.start(now);
    oscillator.stop(now + 0.08);
  }

  blowOff(intensity = 1) {
    if (!this.context || !this.ready) return false;
    const context = this.context;
    const now = context.currentTime;
    const amount = clamp(intensity);
    const source = context.createBufferSource();
    source.buffer = this.buffers.white;
    const highpass = context.createBiquadFilter();
    const bandpass = context.createBiquadFilter();
    const gain = context.createGain();
    highpass.type = 'highpass';
    highpass.frequency.value = 700;
    bandpass.type = 'bandpass';
    bandpass.Q.value = 1.8;
    bandpass.frequency.setValueAtTime(6800, now);
    bandpass.frequency.exponentialRampToValueAtTime(1050, now + 0.34);
    envelope(gain.gain, now, 0.14 * amount, 0.006, 0.025, 0.34);
    source.connect(highpass).connect(bandpass).connect(gain).connect(this.nodes.effectsBus);
    source.start(now);
    source.stop(now + 0.43);
    return true;
  }

  nearMiss(options = {}, legacySpeed) {
    if (!this.context || !this.ready) return false;
    const eventNow = performance.now();
    if (eventNow - this._lastNearMissAt < 35) return false;
    this._lastNearMissAt = eventNow;
    const config = typeof options === 'number'
      ? (Math.abs(options) <= 1 && Number.isFinite(Number(legacySpeed))
        ? { side: options, speedKmh: legacySpeed }
        : { speedKmh: options })
      : options;
    const context = this.context;
    const now = context.currentTime;
    const speed = Math.max(80, Number(config.speedKmh ?? config.speed ?? 180) || 180);
    const closeness = clamp(config.closeness ?? config.proximity ?? 0.8);
    const side = clamp(config.side ?? (Math.random() < 0.5 ? -1 : 1), -1, 1);
    const duration = lerp(0.82, 0.38, clamp((speed - 80) / 240));
    const source = context.createBufferSource();
    source.buffer = this.buffers.pink;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.25;
    filter.frequency.setValueAtTime(420 + speed * 5.0, now);
    filter.frequency.exponentialRampToValueAtTime(2600 + speed * 7.5, now + duration * 0.43);
    filter.frequency.exponentialRampToValueAtTime(320 + speed * 2.0, now + duration);
    const gain = context.createGain();
    const panner = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : context.createGain();
    if (panner.pan) {
      panner.pan.setValueAtTime(side, now);
      panner.pan.linearRampToValueAtTime(-side * 0.45, now + duration);
    }
    const peak = (0.065 + closeness * 0.16) * clamp(speed / 210, 0.55, 1.35);
    envelope(gain.gain, now, peak, duration * 0.20, duration * 0.12, duration * 0.68);
    source.connect(filter).connect(gain).connect(panner).connect(this.nodes.effectsBus);
    source.start(now);
    source.stop(now + duration + 0.05);

    const doppler = context.createOscillator();
    const dopplerGain = context.createGain();
    doppler.type = 'sine';
    doppler.frequency.setValueAtTime(150 + speed * 1.9, now);
    doppler.frequency.exponentialRampToValueAtTime(75 + speed * 0.62, now + duration);
    envelope(dopplerGain.gain, now, peak * 0.28, duration * 0.15, duration * 0.08, duration * 0.72);
    doppler.connect(dopplerGain).connect(panner);
    doppler.start(now);
    doppler.stop(now + duration + 0.03);
    return true;
  }

  trafficWhoosh(options) { return this.nearMiss(options); }
  playNearMiss(speedKmh, side = 0) { return this.nearMiss({ speedKmh, side }); }

  crash(intensity = 1) {
    if (!this.context || !this.ready) return false;
    const eventNow = performance.now();
    if (eventNow - this._lastCrashAt < 45) return false;
    this._lastCrashAt = eventNow;
    const context = this.context;
    const now = context.currentTime;
    const amount = clamp(intensity, 0.1, 1.5);
    const noise = context.createBufferSource();
    noise.buffer = this.buffers.white;
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(6200, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(420, now + 0.85);
    const noiseGain = context.createGain();
    envelope(noiseGain.gain, now, 0.42 * amount, 0.002, 0.018, 0.82);
    noise.connect(noiseFilter).connect(noiseGain).connect(this.nodes.effectsBus);
    noise.start(now);
    noise.stop(now + 0.95);

    const thump = context.createOscillator();
    const thumpGain = context.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(105, now);
    thump.frequency.exponentialRampToValueAtTime(29, now + 0.48);
    envelope(thumpGain.gain, now, 0.44 * amount, 0.001, 0.012, 0.48);
    thump.connect(thumpGain).connect(this.nodes.effectsBus);
    thump.start(now);
    thump.stop(now + 0.55);

    for (let index = 0; index < 4; index += 1) {
      const delay = index * 0.035 + Math.random() * 0.018;
      const shard = context.createOscillator();
      const shardGain = context.createGain();
      shard.type = 'square';
      shard.frequency.setValueAtTime(520 + Math.random() * 1700, now + delay);
      shard.frequency.exponentialRampToValueAtTime(160 + Math.random() * 280, now + delay + 0.14);
      envelope(shardGain.gain, now + delay, 0.025 * amount, 0.001, 0.004, 0.13);
      shard.connect(shardGain).connect(this.nodes.effectsBus);
      shard.start(now + delay);
      shard.stop(now + delay + 0.16);
    }
    return true;
  }

  collision(intensity) { return this.crash(intensity); }
  playCrash(intensity) { return this.crash(intensity); }

  uiClick(type = 'click', intensity = 1) {
    if (!this.context || !this.ready) return false;
    const eventNow = performance.now();
    if (eventNow - this._lastUiAt < 18) return false;
    this._lastUiAt = eventNow;
    const presets = {
      click: [620, 880, 0.045], hover: [980, 1180, 0.025], confirm: [520, 1040, 0.085],
      back: [520, 360, 0.075], error: [180, 145, 0.13], purchase: [660, 1320, 0.12],
    };
    const [from, to, duration] = presets[type] || presets.click;
    const context = this.context;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type === 'error' ? 'square' : 'triangle';
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);
    envelope(gain.gain, now, 0.055 * clamp(intensity), 0.002, 0.004, duration);
    oscillator.connect(gain).connect(this.nodes.effectsBus);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.025);
    return true;
  }

  click(type, intensity) { return this.uiClick(type, intensity); }
  playUI(type, intensity) { return this.uiClick(type, intensity); }

  _setAmbient(enabled, fadeSeconds = 1.2) {
    if (!this.context || !this.nodes.padGain) return;
    const now = this.context.currentTime;
    setTarget(this.nodes.padGain.gain, enabled ? 0.16 : 0.0001, now, Math.max(0.02, fadeSeconds / 4));
  }

  startAmbient(fadeSeconds = 1.5) {
    this.ambientRunning = true;
    this._setAmbient(true, fadeSeconds);
  }

  stopAmbient(fadeSeconds = 1.0) {
    this.ambientRunning = false;
    this._setAmbient(false, fadeSeconds);
  }

  setAmbientEnabled(enabled) {
    if (enabled) this.startAmbient(); else this.stopAmbient();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindUnlockGestures();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._visibilityHandler);
    if (this.context) {
      for (const source of this.sources) {
        try { source.stop(); } catch { /* already stopped */ }
        try { source.disconnect(); } catch { /* already disconnected */ }
      }
      this.sources.length = 0;
      try { await this.context.close(); } catch { /* browser may already have closed it */ }
    }
    this.context = null;
    this.nodes = {};
    this.buffers = {};
    this.unlocked = false;
  }
}

export const audioSystem = new AudioSystem();
export const audio = audioSystem;
export default audioSystem;
