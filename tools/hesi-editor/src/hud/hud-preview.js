/**
 * A live, grabbable copy of the game's interface — one per device profile.
 *
 * The preview is an **iframe**, and that is the whole design decision. The
 * compact HUD is not a set of CSS variables, it is a media query
 * (`(pointer:coarse), (max-width:700px)`), and a media query answers to the
 * viewport. An iframe has its own viewport: size it 393×851 and the phone rules
 * genuinely apply — the minimap really is gone, the cluster really is at .62, the
 * touch buttons really are there. Editing the phone HUD inside a `<div>` scaled
 * with a transform would have shown the desktop layout wearing phone numbers,
 * which is exactly the lie the previous in-game panel had to apologise for.
 *
 * Nothing here is a copy of the game's markup either. The document is built from
 * the real `/index.html` and the real `/styles.css`, fetched at open time, so a
 * HUD element renamed in the game shows up renamed here (or, if it is gone,
 * fails the panel's widget check) instead of drifting quietly. Only three things
 * are added on top:
 *
 *  - sample content, because an empty HUD cannot be laid out (`128'450`, `¥135'000`,
 *    a speed, a toast, a prompt);
 *  - a still frame: the toast, prompt and near-miss animations are paused, since
 *    they exist to remove themselves from the screen and this one has to stay;
 *  - a backdrop that reads as a night road, so contrast decisions are made
 *    against something like the real thing rather than against black.
 *
 * The canvas instruments are painted with the same code the game uses
 * (js/hud-instruments.js), which is the reason that module exists.
 */
import { applyHudTheme } from '/js/hud-theme.js';
import { createGauge, instrumentColors, paintDial, paintMinimap, speedConfig, tachConfig } from '/js/hud-instruments.js';

/** The five screens, and which root element each one shows. */
const SCREEN_ROOTS = Object.freeze({
  hud: ['#hud', '#touch-controls'],
  phone: ['#hud', '#phone'],
  pc: ['#pc-overlay'],
  loading: ['#loading'],
  boot: ['#boot-screen'],
});

/** Sample copy, so every widget has something to be the size of. */
const SAMPLE_TEXT = Object.freeze({
  '#hud-score': "128'450",
  '#hud-combo': '×2.5',
  '#combo-label': 'CLEAN PASSES',
  '#hud-money': "¥135'000",
  '#area-name': 'KANDABASHI',
  '#route-name': 'C1 INNER',
  '#speed-readout': '178',
  '#rpm-readout': '6400',
  '#gear-readout': '4',
  '#fuel-readout': '72%',
  '#mobile-fps': '60 FPS',
  '#phone-location': 'C1 INNER',
  '#pc-money': "¥135'000",
});

const PREVIEW_STYLE = `
  html, body { background: #05070c; }
  /* A night road under the HUD: the contrast decisions have to be made against
     something, and a black rectangle flatters everything. */
  body::before {
    content: ""; position: fixed; inset: 0; z-index: 0;
    background:
      radial-gradient(120% 60% at 50% 108%, rgba(255,176,46,.10), transparent 60%),
      linear-gradient(#04070e 0%, #0a1018 46%, #16110d 62%, #241a12 100%);
  }
  body::after {
    content: ""; position: fixed; left: 50%; bottom: -6%; z-index: 0;
    width: 42%; height: 62%; transform: translateX(-50%) perspective(240px) rotateX(64deg);
    background:
      linear-gradient(#0000 0 62%, rgba(226,232,221,.10) 62% 64%, #0000 64%),
      repeating-linear-gradient(90deg, transparent 0 46%, rgba(226,232,221,.22) 46% 54%, transparent 54% 100%),
      linear-gradient(#1b1b1e, #2a2a2d);
    background-size: 100% 100%, 100% 90px, 100% 100%;
  }
  #game-shell { position: fixed; inset: 0; z-index: 1; }
  /* One screen at a time: the panel HIDES the roots that are not on, and says
     nothing about the ones that are. Forcing display:block on the active roots
     was wrong twice over — it made the touch layer visible in the PC frame,
     where the game's own media query hides it, and it flattened the loading
     screen's flex centring. Both are exactly the kind of difference the preview
     exists to show. */
  .hud-preview-root:not(.on) { display: none !important; }
  /* A still frame: these three animate themselves off the screen. */
  .toast, .prompt, .event-splash, .phone, .modal-card, .load-ring, .loading b, .loading span:after,
  .boot-ticker-track, .boot-logo, .blink, .eyebrow:after { animation: none !important; }
  .event-splash { opacity: 1 !important; }
  .loading { animation: none !important; }
  /* Nothing in the preview is clickable: pointer work belongs to the editor's
     own overlay, which sits above this document. */
  * { cursor: default !important; }
  a, button, input, select, textarea { pointer-events: none !important; }
`;

const html = (markup) => new DOMParser().parseFromString(markup, 'text/html');

/** A short synthetic road network, so the GPS has something to draw. */
function sampleNetwork() {
  const routes = [];
  for (const [index, phase] of [0, 1.6, 3.1].entries()) {
    const points = [];
    for (let step = 0; step <= 60; step += 1) {
      const t = step / 60;
      points.push({
        x: -900 + t * 1800 + Math.sin(t * 5 + phase) * (160 + index * 60),
        z: -700 + Math.cos(t * 4 + phase) * (420 - index * 90) + index * 180,
      });
    }
    routes.push({ points });
  }
  return { routes };
}

const SAMPLE_SERVICES = Object.freeze([
  Object.freeze({ x: -420, z: 190, name: 'TATSUMI PA' }),
  Object.freeze({ x: 360, z: -240, name: 'WANGAN WORKS', garage: true }),
]);

export class HudPreview {
  /**
   * @param {object} options
   * @param {HTMLElement} options.host        where the framed preview is mounted
   * @param {'desktop'|'mobile'} options.device
   * @param {number} options.width            logical viewport width
   * @param {number} options.height           logical viewport height
   * @param {string} options.label            shown on the frame
   */
  constructor({ host, device, width, height, label }) {
    Object.assign(this, { device, width, height, label });
    this.scale = 1;
    this.ready = false;
    this.gauges = {};
    this.network = sampleNetwork();
    this._build(host);
  }

  _build(host) {
    this.root = document.createElement('div');
    this.root.className = 'hud-preview';
    this.root.dataset.device = this.device;

    const bar = document.createElement('div');
    bar.className = 'hud-preview-bar';
    const name = document.createElement('strong');
    name.textContent = this.label;
    this.sizeChip = document.createElement('small');
    this.sizeChip.textContent = `${this.width}×${this.height}`;
    bar.append(name, this.sizeChip);

    this.stage = document.createElement('div');
    this.stage.className = 'hud-preview-stage';
    this.frame = document.createElement('iframe');
    this.frame.className = 'hud-preview-frame';
    this.frame.title = `${this.label} preview`;
    this.frame.setAttribute('aria-hidden', 'true');
    // No `sandbox`: the panel has to read the document it is editing, and this is
    // a local dev tool serving its own repository.
    this.frame.style.width = `${this.width}px`;
    this.frame.style.height = `${this.height}px`;
    this.stage.append(this.frame);

    this.overlay = document.createElement('div');
    this.overlay.className = 'hud-preview-overlay';
    this.overlay.dataset.testid = `hud-overlay-${this.device}`;
    this.stage.append(this.overlay);

    this.root.append(bar, this.stage);
    host.append(this.root);
  }

  /**
   * Builds the preview document out of the game's own index.html and stylesheet.
   * Returns the list of HUD roots it could not find, which the panel reports
   * rather than silently previewing half an interface.
   */
  async load() {
    const markup = await fetch('/index.html', { cache: 'no-store' }).then((response) => response.text());
    const source = html(markup);
    const missing = [];
    const doc = this.frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/styles.css';
    const style = doc.createElement('style');
    style.textContent = PREVIEW_STYLE;
    doc.head.append(link, style);

    const shell = doc.createElement('div');
    shell.id = 'game-shell';
    const wanted = new Set(Object.values(SCREEN_ROOTS).flat());
    for (const selector of wanted) {
      const node = source.querySelector(selector);
      if (!node) { missing.push(selector); continue; }
      const copy = doc.importNode(node, true);
      copy.classList.remove('hidden');
      copy.classList.add('hud-preview-root', 'active');
      copy.removeAttribute('hidden');
      copy.dataset.previewRoot = selector;
      shell.append(copy);
    }
    doc.body.append(shell);
    doc.body.dataset.gameMode = 'driving';
    doc.documentElement.dataset.hudPreview = this.device;

    this._fillSamples(doc);
    this.doc = doc;
    this.ready = true;
    await doc.fonts?.ready?.catch(() => {});
    return missing;
  }

  /** Sample content, plus the states the game only shows on an event. */
  _fillSamples(doc) {
    for (const [selector, text] of Object.entries(SAMPLE_TEXT)) {
      const node = doc.querySelector(selector);
      if (node) node.textContent = text;
    }
    const fill = (selector, value) => { const node = doc.querySelector(selector); if (node) node.style.width = value; };
    fill('#combo-bar i', '64%');
    fill('#fuel-fill', '72%');
    const lives = doc.querySelectorAll('#lives i');
    if (lives[2]) lives[2].classList.add('lost');

    const prompt = doc.querySelector('#interaction-prompt');
    if (prompt) { prompt.classList.remove('hidden'); prompt.innerHTML = '<kbd>E</kbd> ENTER WANGAN WORKS GARAGE'; }
    const splash = doc.querySelector('#near-miss');
    if (splash) splash.innerHTML = 'NEAR MISS <b>+1240</b>';
    const toasts = doc.querySelector('#toast-stack');
    if (toasts) {
      for (const [text, tone] of [['TATSUMI PA // DRIVE SAFE', 'var(--amber)'], ["REFUELED 32.0L // ¥5'440", 'var(--cyan)']]) {
        const toast = doc.createElement('div');
        toast.className = 'toast';
        toast.textContent = text;
        toast.style.borderColor = tone;
        toasts.append(toast);
      }
    }
    const pcContent = doc.querySelector('#pc-content');
    if (pcContent) pcContent.innerHTML = PC_SAMPLE;

    for (const id of ['gauge-tach', 'gauge-speed']) {
      const canvas = doc.getElementById(id);
      if (canvas) this.gauges[id] = createGauge(canvas);
    }
  }

  /** Shows one screen. `phone` keeps the HUD behind it, as the game does. */
  setScreen(screen) {
    if (!this.doc) return;
    this.screen = screen;
    const roots = SCREEN_ROOTS[screen] || SCREEN_ROOTS.hud;
    this.doc.body.dataset.screen = screen;
    for (const node of this.doc.querySelectorAll('.hud-preview-root')) {
      node.classList.toggle('on', roots.includes(node.dataset.previewRoot));
    }
    this.paintInstruments();
  }

  /** Installs a theme: the same call the game makes, on this document's root. */
  apply(theme) {
    if (!this.doc) return;
    applyHudTheme(theme, { root: this.doc.documentElement, device: this.device, view: this.frame.contentWindow });
    this.paintInstruments();
  }

  /** Repaints the dials and the GPS with the theme now on this document. */
  paintInstruments() {
    if (!this.doc) return;
    const colors = instrumentColors(this.doc.documentElement);
    const tach = this.gauges['gauge-tach'];
    const speedo = this.gauges['gauge-speed'];
    // ease:false — a still preview must not creep toward its value over frames.
    if (tach) paintDial(tach, { ...tachConfig(7000), value: 6400 }, { colors, ease: false, dpr: 2 });
    if (speedo) paintDial(speedo, { ...speedConfig(), value: 178 }, { colors, ease: false, dpr: 2 });
    const minimap = this.doc.getElementById('minimap');
    if (minimap) {
      paintMinimap(minimap, {
        data: this.network,
        player: { x: -60, z: 40, heading: 0.7 },
        services: SAMPLE_SERVICES,
        colors,
      });
    }
  }

  /** Fits the logical viewport into the space the panel gives it. */
  layout(available) {
    const scale = Math.min(1, (available.width - 12) / this.width, (available.height - 34) / this.height);
    this.scale = Math.max(0.2, Number.isFinite(scale) ? scale : 1);
    this.frame.style.transform = `scale(${this.scale})`;
    this.stage.style.width = `${Math.round(this.width * this.scale)}px`;
    this.stage.style.height = `${Math.round(this.height * this.scale)}px`;
    this.sizeChip.textContent = `${this.width}×${this.height} · ${Math.round(this.scale * 100)}%`;
  }

  /**
   * Preview-pixel rectangle of one element, or null when it is not rendered.
   *
   * Clamped to the frame, because an element can stick out of the viewport (the
   * HUD's bottom-right container is wider than a phone screen) and a marquee
   * whose handles land outside the frame is a handle nobody can grab: the stage
   * clips it away, and the click lands on the panel behind.
   */
  rectFor(selector) {
    const node = this.doc?.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    const style = this.frame.contentWindow.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const left = Math.max(0, Math.min(rect.left, this.width - 8));
    const top = Math.max(0, Math.min(rect.top, this.height - 8));
    return {
      x: left,
      y: top,
      width: Math.max(8, Math.min(rect.right, this.width) - left),
      height: Math.max(8, Math.min(rect.bottom, this.height) - top),
      hidden: Number(style.opacity) === 0,
    };
  }

  /** Overlay-pixel rectangle: the same box, scaled into the panel's overlay. */
  overlayRect(selector) {
    const rect = this.rectFor(selector);
    if (!rect) return null;
    return {
      x: rect.x * this.scale, y: rect.y * this.scale,
      width: rect.width * this.scale, height: rect.height * this.scale,
      hidden: rect.hidden,
    };
  }

  /** Overlay point -> preview point. Every pointer delta goes through this. */
  toPreview(point) {
    return { x: point.x / this.scale, y: point.y / this.scale };
  }

  /** Topmost element at an overlay point, as a chain of ancestors. */
  chainAt(point) {
    if (!this.doc) return [];
    const local = this.toPreview(point);
    const node = this.doc.elementFromPoint(local.x, local.y);
    const chain = [];
    for (let current = node; current && current !== this.doc.documentElement; current = current.parentElement) chain.push(current);
    return chain;
  }
}

/** A couple of real market cards, so the terminal has content to be sized by. */
const PC_SAMPLE = `
  <div class="market-title"><h2>CAR AUCTION</h2><p>NIGHT SESSION · 12 LOTS</p></div>
  <div class="listing-grid">
    ${[['SILVIA S13', '1991', "¥890'000", '4.5'], ['SUPRA A80', '1995', "¥2'480'000", '4'], ['CIVIC EG6', '1993', "¥520'000", '3.5']].map(([name, year, price, grade], index) => `
      <article class="car-card">
        <div class="car-preview" style="--car:${['#c73642', '#2e5fc7', '#d8d5c9'][index]}"><span class="lot">LOT ${index + 1}</span></div>
        <div class="car-info">
          <h3>${name}</h3>
          <p class="meta">${year} · 86'000 KM · FR</p>
          <div class="auction-sheet"><span>GRADE</span><span class="grade">${grade}</span><span>POWER</span><span>205 PS</span></div>
          <div class="price-row"><small>BUY NOW</small><b>${price}</b><button type="button">BID</button></div>
        </div>
      </article>`).join('')}
  </div>
`;
