/**
 * HUD — the interface editor.
 *
 * Two live previews side by side, PC and phone, each one the game's real HUD
 * inside a real device viewport (see hud-preview.js). You click a piece of it,
 * drag it where you want it, pull a corner to resize it, and the fields that
 * describe it are written for the profile of the preview you touched. The
 * inspector on the right is for the things a pointer cannot express — a colour, a
 * font, a string of text — and for the screens that are not a layout at all.
 *
 * Why it works this way:
 *
 *  - **The preview you drag is the profile you edit.** Grab something in the
 *    phone frame and the phone profile moves; the PC frame does not. That is the
 *    whole PC-versus-phone story, with no mode switch to forget about.
 *  - **Drags write named fields, not free coordinates.** A drag adds to
 *    `--hud-tl-y`, a corner multiplies `--hud-tl-scale`; the authored `2.2vw`
 *    anchor and the four responsive layout variants underneath stay exactly as
 *    they are, so a theme at zero is the shipped game and every drag is
 *    reversible by construction.
 *  - **Undo is the whole theme.** A theme is a few hundred numbers, so the stack
 *    holds complete records and cannot leave a half-applied edit behind.
 *
 * The result is written to data/editor/custom-assets.json → `runtimeTuning.hud`
 * by the same store the Modeler and Surfaces use, and Save broadcasts the car
 * channel so an open test game restyles itself without a reload.
 */
import {
  HUD_COLOR_ROLES,
  HUD_DEVICES,
  HUD_FONT_STACKS,
  HUD_THEME_SECTIONS,
  defaultHudTheme,
  hudFieldScope,
  hudThemeField,
  hudThemeSignature,
  hudThemeValue,
  normalizeHudTheme,
} from '/js/hud-theme.js';
import {
  HUD_SCREENS,
  HUD_THEME_PRESETS,
  HUD_WIDGETS_BY_ID,
  copyHudProfile,
  dragWidget,
  formatHudValue,
  hudThemeFromPreset,
  resetHudSection,
  resetHudWidget,
  resizeWidget,
  setHudField,
  widgetsForScreen,
} from './hud-vocabulary.js';
import { HudPreview } from './hud-preview.js';

const HANDLES = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const UNDO_DEPTH = 60;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className = 'tool-button', title = '') {
  const node = element('button', className, label);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

export class HudPanel {
  /**
   * @param {object} options
   * @param {HTMLElement} options.host
   * @param {import('../world/custom-asset-store.js').CustomAssetStore} options.store
   * @param {(message: string) => void} [options.onStatus]
   * @param {(open: boolean) => void} [options.onOpenChange]
   */
  constructor({ host, store, onStatus = () => {}, onOpenChange = () => {} }) {
    Object.assign(this, { store, onStatus, onOpenChange });
    this.openState = false;
    this.loaded = false;
    this.theme = defaultHudTheme();
    this.savedSignature = hudThemeSignature(this.theme);
    this.undoStack = [];
    this.screen = 'hud';
    this.device = 'desktop';
    this.selected = null;
    this.hovered = null;
    this.drag = null;
    this.previews = new Map();
    this.controls = [];
    this._buildDom(host);
  }

  get isOpen() { return this.openState; }
  get dirty() { return hudThemeSignature(this.theme) !== this.savedSignature; }

  // ------------------------------------------------------------------ DOM --
  _buildDom(host) {
    this.overlay = element('div', 'hud-overlay');
    this.overlay.hidden = true;
    this.overlay.dataset.testid = 'hud-overlay';

    const header = element('header', 'modeler-header');
    header.append(element('strong', '', 'HUD'));

    this.screenSwitch = element('div', 'segmented hud-screen-switch');
    this.screenSwitch.setAttribute('role', 'radiogroup');
    this.screenSwitch.setAttribute('aria-label', 'Schermata');
    this.screenButtons = new Map();
    for (const screen of HUD_SCREENS) {
      const node = element('button', 'seg-button', screen.label);
      node.type = 'button';
      node.setAttribute('role', 'radio');
      node.title = screen.hint;
      node.dataset.testid = `hud-screen-${screen.id}`;
      node.addEventListener('click', () => this.setScreen(screen.id));
      this.screenButtons.set(screen.id, node);
      this.screenSwitch.append(node);
    }
    header.append(this.screenSwitch);

    this.presetSelect = document.createElement('select');
    this.presetSelect.className = 'hud-preset-select';
    this.presetSelect.title = 'Applica un preset a tutto il tema';
    this.presetSelect.dataset.testid = 'hud-preset';
    this.presetSelect.add(new Option('Preset…', ''));
    for (const [name, preset] of Object.entries(HUD_THEME_PRESETS)) this.presetSelect.add(new Option(preset.label, name));
    this.presetSelect.addEventListener('change', () => {
      const name = this.presetSelect.value;
      this.presetSelect.value = '';
      if (!name) return;
      const theme = hudThemeFromPreset(name);
      if (theme) this._commit(theme, `Preset ${HUD_THEME_PRESETS[name].label}`);
    });
    header.append(this.presetSelect);

    this.undoButton = button('↶ Annulla', 'tool-button', 'Annulla l\'ultima modifica (Ctrl+Z)');
    this.undoButton.dataset.testid = 'hud-undo';
    this.undoButton.addEventListener('click', () => this.undo());
    this.dirtyChip = element('span', 'modeler-dirty', '');
    this.dirtyChip.dataset.testid = 'hud-dirty';
    this.saveButton = button('Salva', 'tool-button accent', 'Scrive runtimeTuning.hud in data/editor/custom-assets.json e chiede al gioco aperto di ricaricare');
    this.saveButton.dataset.testid = 'hud-save';
    this.saveButton.addEventListener('click', () => this._save());
    this.closeButton = button('Chiudi ✕', 'tool-button', 'Torna all\'editor della mappa');
    this.closeButton.dataset.testid = 'hud-close';
    this.closeButton.addEventListener('click', () => this.close());
    header.append(this.undoButton, this.dirtyChip, element('span', 'toolbar-spacer'), this.saveButton, this.closeButton);

    const body = element('div', 'hud-body');
    this.stageHost = element('section', 'hud-stage');
    this.stageHost.dataset.testid = 'hud-stage';
    this.hintBar = element('p', 'hud-hint', 'Clicca un elemento, trascinalo per spostarlo, tira un angolo per ridimensionarlo · frecce per spostare di 2px · V nasconde · R ripristina · Ctrl+Z annulla');
    this.inspector = element('aside', 'hud-inspector');
    this.inspector.dataset.testid = 'hud-inspector';
    body.append(this.stageHost, this.inspector);
    this.overlay.append(header, this.hintBar, body);
    host.append(this.overlay);

    for (const device of HUD_DEVICES) {
      const preview = new HudPreview({
        host: this.stageHost,
        device: device.id,
        label: device.id === 'desktop' ? 'PC · 1280×720' : 'Telefono · 393×851',
        width: device.id === 'desktop' ? 1280 : 393,
        height: device.id === 'desktop' ? 720 : 851,
      });
      this._bindPointer(preview);
      this.previews.set(device.id, preview);
    }

    this.resizeObserver = new ResizeObserver(() => this._layout());
    this.resizeObserver.observe(this.stageHost);
    this._keyHandler = (event) => this._onKey(event);
  }

  // ------------------------------------------------------------- lifecycle --
  async open(screen = null) {
    if (screen) this.screen = screen;
    this.overlay.hidden = false;
    this.openState = true;
    this.onOpenChange(true);
    window.addEventListener('keydown', this._keyHandler, true);
    if (!this.loaded) await this._load();
    this.setScreen(this.screen);
    this._layout();
    this._render();
  }

  close() {
    this.overlay.hidden = true;
    this.openState = false;
    this.selected = null;
    window.removeEventListener('keydown', this._keyHandler, true);
    this.onOpenChange(false);
  }

  async _load() {
    try {
      if (!this.store.loaded) await this.store.load();
      this.theme = normalizeHudTheme(this.store.hudTheme());
      this.savedSignature = hudThemeSignature(this.theme);
    } catch (error) {
      this.onStatus(`HUD · impossibile leggere il tema salvato · ${error.message}`);
    }
    const missing = [];
    for (const preview of this.previews.values()) {
      try {
        missing.push(...await preview.load());
      } catch (error) {
        this.onStatus(`HUD · anteprima non disponibile · ${error.message}`);
      }
    }
    this.loaded = true;
    // A HUD root the game renamed would otherwise preview as a blank frame; say
    // so instead, because the widget table is what would need fixing.
    if (missing.length) this.onStatus(`HUD · index.html non contiene ${[...new Set(missing)].join(', ')}`);
    this._applyTheme();
  }

  // ---------------------------------------------------------------- state --
  setScreen(screen) {
    this.screen = HUD_SCREENS.some((entry) => entry.id === screen) ? screen : 'hud';
    for (const [id, node] of this.screenButtons) node.setAttribute('aria-checked', String(id === this.screen));
    for (const preview of this.previews.values()) preview.setScreen(this.screen);
    const widgets = widgetsForScreen(this.screen);
    if (!widgets.some((entry) => entry.id === this.selected)) this.selected = widgets[0]?.id || null;
    this._render();
  }

  select(widgetId, device = null) {
    this.selected = widgetId;
    if (device) this.device = device;
    this._render();
  }

  /** Installs the current theme on both previews. */
  _applyTheme() {
    for (const preview of this.previews.values()) preview.apply(this.theme);
  }

  /**
   * The one place a theme changes. `label` is what the status line says, and
   * `coalesce` keeps a whole drag as a single undo step.
   */
  _commit(theme, label, { coalesce = false } = {}) {
    const next = normalizeHudTheme(theme);
    if (hudThemeSignature(next) === hudThemeSignature(this.theme)) return;
    if (!coalesce || !this.undoStack.length || this.undoStack.at(-1).label !== label) {
      this.undoStack.push({ theme: this.theme, label });
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    }
    this.theme = next;
    this._applyTheme();
    this._render();
    if (label) this.onStatus(`HUD · ${label}`);
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) { this.onStatus('HUD · niente da annullare'); return; }
    this.theme = previous.theme;
    this._applyTheme();
    this._render();
    this.onStatus(`HUD · annullato: ${previous.label}`);
  }

  setField(key, value, { label = null, coalesce = false } = {}) {
    const entry = hudThemeField(key);
    if (!entry) return;
    const shared = hudFieldScope(entry.section, entry.field) === 'shared';
    const name = label || `${entry.field.label}${shared ? '' : ` · ${this.device === 'desktop' ? 'PC' : 'telefono'}`}`;
    this._commit(setHudField(this.theme, key, value, this.device), name, { coalesce });
  }

  async _save() {
    try {
      this.store.setHudTheme(this.theme);
      await this.store.save();
      this.savedSignature = hudThemeSignature(this.theme);
      let hot = false;
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('hesi-car-models');
        channel.postMessage({ type: 'reload-car-models', at: Date.now() });
        channel.close();
        hot = true;
      }
      this._render();
      this.onStatus(hot ? 'HUD salvato · ricarica chiesta al gioco aperto' : 'HUD salvato · ricarica il gioco per vederlo');
    } catch (error) {
      this.onStatus(`Salvataggio HUD fallito · ${error.message}`);
    }
  }

  // ------------------------------------------------------------- pointers --
  _bindPointer(preview) {
    const overlay = preview.overlay;
    overlay.addEventListener('pointerdown', (event) => this._onPointerDown(event, preview));
    overlay.addEventListener('pointermove', (event) => this._onHover(event, preview));
    overlay.addEventListener('pointerleave', () => { if (!this.drag) { this.hovered = null; this._renderOverlays(); } });
  }

  _localPoint(event, preview) {
    const rect = preview.overlay.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** The widget under a point, innermost first — a click selects what it hits. */
  _widgetAt(point, preview) {
    const chain = preview.chainAt(point);
    const candidates = widgetsForScreen(this.screen);
    for (const node of chain) {
      for (const entry of candidates) {
        if (node.matches?.(entry.selector)) return entry;
      }
    }
    // Nothing under the pointer: fall back to whichever widget box contains it,
    // so a transparent piece of HUD (an empty toast stack) is still grabbable.
    for (const entry of candidates) {
      const rect = preview.overlayRect(entry.measure || entry.selector);
      if (rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) return entry;
    }
    return null;
  }

  _onHover(event, preview) {
    if (this.drag) return;
    const entry = this._widgetAt(this._localPoint(event, preview), preview);
    const next = entry?.id || null;
    if (next === this.hovered) return;
    this.hovered = next;
    this._renderOverlays();
  }

  _onPointerDown(event, preview) {
    if (event.button !== 0) return;
    const handle = event.target?.dataset?.hudHandle || null;
    const point = this._localPoint(event, preview);
    const entry = handle
      ? HUD_WIDGETS_BY_ID.get(event.target.dataset.hudWidget)
      : this._widgetAt(point, preview);
    if (!entry) { this.selected = null; this._render(); return; }

    this.device = preview.device;
    this.selected = entry.id;
    const rect = preview.rectFor(entry.measure || entry.selector) || { width: 100, height: 100 };
    const start = {};
    for (const key of [entry.move?.x, entry.move?.y, entry.resize?.field, entry.resize?.width, entry.resize?.height]) {
      if (!key) continue;
      const found = hudThemeField(key);
      if (found) start[key] = hudThemeValue(this.theme, found.section, found.field, this.device);
    }
    this.drag = {
      entry, preview, handle, start, rect,
      from: point,
      base: this.theme,
      label: handle ? `Ridimensiona ${entry.label}` : `Sposta ${entry.label}`,
      moved: false,
    };
    preview.overlay.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => this._onPointerMove(moveEvent);
    const up = (upEvent) => {
      preview.overlay.releasePointerCapture?.(upEvent.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const done = this.drag;
      this.drag = null;
      if (done && !done.moved) this.onStatus(`HUD · ${done.entry.label} selezionato`);
      this._render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this._render();
    event.preventDefault();
  }

  _onPointerMove(event) {
    const drag = this.drag;
    if (!drag) return;
    const point = this._localPoint(event, drag.preview);
    // Deltas are converted into the preview's own pixels, so a frame shown at
    // 60% still moves the HUD by the number of pixels the pointer travelled
    // *there* rather than on the editor's screen.
    const dx = (point.x - drag.from.x) / drag.preview.scale;
    const dy = (point.y - drag.from.y) / drag.preview.scale;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 1.5) return;
    drag.moved = true;
    const fine = event.shiftKey;
    const theme = drag.handle
      ? resizeWidget(drag.base, drag.entry, { handle: drag.handle, dx, dy, size: drag.rect, device: this.device, start: drag.start, fine })
      : dragWidget(drag.base, drag.entry, { dx: fine ? dx * 0.25 : dx, dy: fine ? dy * 0.25 : dy, device: this.device, start: { x: drag.start[drag.entry.move.x], y: drag.start[drag.entry.move.y] } });
    this._commit(theme, drag.label, { coalesce: true });
  }

  _onKey(event) {
    if (!this.openState) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '');
    if ((event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.undo();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    if (typing) return;
    const entry = this.selected ? HUD_WIDGETS_BY_ID.get(this.selected) : null;
    if (!entry) return;
    const step = event.shiftKey ? 10 : 2;
    const nudges = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (nudges[event.key] && entry.move) {
      event.preventDefault();
      const [dx, dy] = nudges[event.key];
      this._commit(dragWidget(this.theme, entry, { dx, dy, device: this.device }), `Sposta ${entry.label}`, { coalesce: true });
      return;
    }
    if ((event.key === 'v' || event.key === 'V') && entry.visibility) {
      event.preventDefault();
      const field = hudThemeField(entry.visibility);
      const current = hudThemeValue(this.theme, field.section, field.field, this.device);
      this.setField(entry.visibility, !current, { label: `${current ? 'Nascondi' : 'Mostra'} ${entry.label}` });
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      this._commit(resetHudWidget(this.theme, entry, this.device), `Ripristina ${entry.label}`);
    }
  }

  // ------------------------------------------------------------ rendering --
  _layout() {
    const width = this.stageHost.clientWidth;
    const height = this.stageHost.clientHeight;
    if (!width || !height) return;
    // Side by side while there is room; the phone frame is narrow, so the PC one
    // gets the lion's share of the width.
    const stacked = width < 900;
    this.stageHost.classList.toggle('stacked', stacked);
    const pc = this.previews.get('desktop');
    const phone = this.previews.get('mobile');
    if (stacked) {
      pc?.layout({ width: width - 20, height: height * 0.52 });
      phone?.layout({ width: width - 20, height: height * 0.44 });
    } else {
      pc?.layout({ width: width * 0.62, height: height - 20 });
      phone?.layout({ width: width * 0.34, height: height - 20 });
    }
    this._renderOverlays();
  }

  _render() {
    if (!this.openState) return;
    this.dirtyChip.textContent = this.dirty ? '● non salvato' : '';
    this.undoButton.disabled = !this.undoStack.length;
    this._renderOverlays();
    this._renderInspector();
  }

  /** The marquees: one box per widget, handles on the selected one. */
  _renderOverlays() {
    for (const preview of this.previews.values()) {
      if (!preview.ready) continue;
      preview.overlay.replaceChildren();
      for (const entry of widgetsForScreen(this.screen)) {
        const rect = preview.overlayRect(entry.measure || entry.selector);
        if (!rect) continue;
        const box = element('div', 'hud-widget');
        box.dataset.hudWidget = entry.id;
        box.style.left = `${rect.x}px`;
        box.style.top = `${rect.y}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        const selected = entry.id === this.selected && preview.device === this.device;
        box.classList.toggle('selected', selected);
        box.classList.toggle('hovered', entry.id === this.hovered && !selected);
        box.classList.toggle('faded', !!rect.hidden);
        const tag = element('span', 'hud-widget-tag', entry.label);
        box.append(tag);
        if (selected && entry.resize) {
          for (const handle of HANDLES) {
            const grip = element('span', `hud-handle ${handle}`);
            grip.dataset.hudHandle = handle;
            grip.dataset.hudWidget = entry.id;
            grip.dataset.testid = `hud-handle-${entry.id}-${handle}`;
            box.append(grip);
          }
        }
        preview.overlay.append(box);
      }
    }
  }

  _renderInspector() {
    this.inspector.replaceChildren();
    this.controls = [];
    const entry = this.selected ? HUD_WIDGETS_BY_ID.get(this.selected) : null;

    const deviceRow = element('div', 'hud-device-row');
    deviceRow.append(element('small', '', 'Profilo in modifica'));
    for (const device of HUD_DEVICES) {
      const node = button(device.label, 'tool-button small');
      node.dataset.testid = `hud-device-${device.id}`;
      node.setAttribute('aria-pressed', String(device.id === this.device));
      node.title = 'Anche trascinare dentro un\'anteprima cambia il profilo in modifica';
      node.addEventListener('click', () => { this.device = device.id; this._render(); });
      deviceRow.append(node);
    }
    this.inspector.append(deviceRow);

    if (entry) {
      const head = element('div', 'hud-selected');
      head.append(element('strong', '', entry.label));
      const meta = [];
      if (entry.move) meta.push('trascinabile');
      if (entry.resize) meta.push(entry.resize.kind === 'box' ? 'ridimensionabile' : 'scalabile');
      head.append(element('small', '', meta.join(' · ') || 'solo proprietà'));
      const reset = button('Ripristina', 'tool-button small', 'Riporta i campi di questo elemento ai valori originali (R)');
      reset.dataset.testid = 'hud-reset-widget';
      reset.addEventListener('click', () => this._commit(resetHudWidget(this.theme, entry, this.device), `Ripristina ${entry.label}`));
      head.append(element('span', 'toolbar-spacer'), reset);
      this.inspector.append(head);
      const group = element('div', 'hud-fields');
      group.dataset.testid = 'hud-widget-fields';
      for (const key of entry.fields || []) {
        const control = this._buildControl(key, 'hud-input');
        if (control) group.append(control);
      }
      this.inspector.append(group);
    } else {
      this.inspector.append(element('p', 'hud-empty', 'Clicca un elemento nell\'anteprima per modificarlo.'));
    }

    // Everything else, by section: palette, type, and whatever the selected
    // widget does not own.
    for (const section of HUD_THEME_SECTIONS) {
      const details = element('details', 'hud-section');
      details.dataset.hudSection = section.id;
      const summary = element('summary', '', section.label);
      const chip = element('small', '', section.scope === 'shared' ? 'PC + telefono' : 'per profilo');
      summary.append(chip);
      details.append(summary);
      if (section.note) details.append(element('p', 'hud-note', section.note));
      const rows = element('div', 'hud-fields');
      for (const field of section.fields) {
        const control = this._buildControl(field.key, 'hud-section-input');
        if (control) rows.append(control);
      }
      const reset = button('Ripristina sezione', 'tool-button small');
      reset.addEventListener('click', () => this._commit(
        resetHudSection(this.theme, section.id, section.scope === 'shared' ? null : this.device),
        `Ripristina ${section.label}`,
      ));
      details.append(rows, reset);
      this.inspector.append(details);
    }

    const tools = element('div', 'hud-tools');
    const copy = button(`Copia ${this.device === 'desktop' ? 'PC → telefono' : 'telefono → PC'}`, 'tool-button small');
    copy.dataset.testid = 'hud-copy-profile';
    copy.addEventListener('click', () => {
      const to = this.device === 'desktop' ? 'mobile' : 'desktop';
      this._commit(copyHudProfile(this.theme, this.device, to), `Copia profilo ${this.device} → ${to}`);
    });
    const exportButton = button('Copia JSON', 'tool-button small', 'Copia il tema negli appunti');
    exportButton.addEventListener('click', async () => {
      const text = JSON.stringify(this.theme, null, 2);
      try { await navigator.clipboard.writeText(text); this.onStatus('HUD · tema copiato negli appunti'); }
      catch { this.onStatus('HUD · appunti non disponibili'); }
    });
    const importButton = button('Incolla JSON', 'tool-button small', 'Sostituisce il tema con quello negli appunti');
    importButton.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        this._commit(normalizeHudTheme(JSON.parse(text)), 'Tema incollato');
      } catch (error) {
        this.onStatus(`HUD · JSON non valido · ${error.message}`);
      }
    });
    tools.append(copy, exportButton, importButton);
    this.inspector.append(tools);
  }

  /**
   * One inspector control, wired to the theme. Returns null for unknown keys.
   *
   * `testid` distinguishes the copy under the selected widget from the copy in
   * its section: both write the same field on purpose (the widget block is the
   * shortcut), but two identical hooks would make a test ambiguous.
   */
  _buildControl(key, testid = 'hud-input') {
    const found = hudThemeField(key);
    if (!found) return null;
    const { section, field } = found;
    const shared = hudFieldScope(section, field) === 'shared';
    const value = hudThemeValue(this.theme, section, field, this.device);
    const row = element('label', 'hud-field');
    row.dataset.hudField = key;
    const caption = element('span', 'hud-field-name', field.label);
    if (shared) caption.append(element('i', 'hud-shared', '·2'));
    const readout = element('b', 'hud-field-value', formatHudValue(field, value));
    row.append(caption, readout);

    const commit = (next, coalesce) => this.setField(key, next, { coalesce });
    let input;
    if (field.type === 'range') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = field.min; input.max = field.max; input.step = field.step;
      input.value = String(value);
      input.addEventListener('input', () => commit(input.value, true));
    } else if (field.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = String(value);
      input.addEventListener('input', () => commit(input.value, true));
    } else if (field.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', () => commit(input.checked, false));
      row.classList.add('hud-field-toggle');
    } else if (field.type === 'text') {
      input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 200;
      input.value = String(value);
      input.addEventListener('input', () => commit(input.value, true));
    } else {
      input = document.createElement('select');
      for (const option of field.type === 'role' ? HUD_COLOR_ROLES : HUD_FONT_STACKS) input.add(new Option(option.label, option.id));
      input.value = String(value);
      input.addEventListener('change', () => commit(input.value, false));
    }
    input.dataset.testid = `${testid}-${key}`;
    if (field.note) row.title = field.note;
    row.append(input);
    this.controls.push({ key, input, readout, field, section });
    return row;
  }

  dispose() {
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this._keyHandler, true);
  }
}
