/**
 * EDITOR HUD // 8 — the panel that edits the whole interface.
 *
 * A view, and only a view: every control reports back through the callbacks and
 * the game (js/game.js) owns the theme, applies it and decides when it is worth
 * writing to disk. The panel holds no copy of the values — `sync()` reads them
 * back out of the theme — because a second copy is exactly how a slider ends up
 * showing something the game is not doing.
 *
 * The controls are generated from HUD_THEME_SECTIONS rather than written into
 * index.html. There are around 120 of them across seven sections and two device
 * profiles; a hand-written copy of that table would be stale within a week, and
 * the panel would be lying about ranges it does not enforce.
 *
 * Three decisions worth stating because they are not obvious from the code:
 *
 *  - **Live drag, commit on release.** `input` events apply immediately and do
 *    not persist; `change` events persist. Same contract as the traffic and
 *    picture dials, so dragging a slider never writes localStorage 60 times.
 *
 *  - **Opening the panel previews the profile you are editing.** Authoring the
 *    phone HUD on a PC would otherwise mean editing numbers with no picture. So
 *    while the panel is open the *edited* profile's properties are the ones on
 *    the document, and closing it puts the real profile back. What preview
 *    cannot do is move the compact-HUD *rules* — those belong to a media query,
 *    and forcing them would mean maintaining a second copy of every one. The
 *    panel says so in as many words.
 *
 *  - **A filter box, not a tidier tree.** With this many controls the fastest
 *    route to one of them is typing part of its name. The filter matches labels
 *    and keys and opens the sections that still have a visible row.
 */
import {
  HUD_COLOR_ROLES,
  HUD_DEVICES,
  HUD_FONT_STACKS,
  HUD_THEME_PRESETS,
  HUD_THEME_SECTIONS,
  formatHudValue,
  hudFieldScope,
  hudThemeValue,
} from './hud-theme.js?v=aa56cc4f53cb';

const SECTION_OPEN_BY_DEFAULT = 'hud';

export class HudEditor {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root          the <aside> shell in index.html
   * @param {() => object} options.getTheme     the live, normalized theme
   * @param {(key:string,value:*,opts:{commit:boolean,device:string})=>void} options.onField
   * @param {(name:string)=>void} options.onPreset
   * @param {(sectionId:string,device:string|null)=>void} options.onResetSection
   * @param {()=>void} options.onResetAll
   * @param {(from:string,to:string)=>void} options.onCopyProfile
   * @param {(theme:object)=>boolean} options.onImport   false when the JSON is refused
   * @param {(device:string)=>void} options.onEditDevice fired when the tab changes
   * @param {()=>void} options.onClose
   * @param {()=>string} options.getActiveDevice  the profile the browser is in
   * @param {(message:string,tone?:string)=>void} [options.toast]
   */
  constructor(options) {
    this.options = options;
    this.root = options.root;
    this.controls = [];
    this.sections = new Map();
    this.device = options.getActiveDevice?.() || 'desktop';
    this.open = false;
    this.filter = '';
    if (this.root) this.build();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  build() {
    this.root.replaceChildren();
    this.root.append(this.buildHeader(), this.buildBody());
    this.sync();
  }

  buildHeader() {
    const header = document.createElement('header');
    const title = document.createElement('div');
    const small = document.createElement('small');
    small.textContent = 'INTERFACE EDITOR';
    const heading = document.createElement('h2');
    heading.textContent = 'HUD // 8';
    title.append(small, heading);
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Chiudi editor HUD');
    close.textContent = '×';
    close.addEventListener('click', () => this.options.onClose?.());
    header.append(title, close);
    return header;
  }

  buildBody() {
    const body = document.createElement('div');
    body.className = 'debug-menu-body hud-editor-body';
    body.append(this.buildDeviceTabs(), this.buildPresets(), this.buildFilter());
    for (const section of HUD_THEME_SECTIONS) body.append(this.buildSection(section));
    body.append(this.buildFooter(), this.buildTransfer());
    return body;
  }

  buildDeviceTabs() {
    const wrap = document.createElement('div');
    wrap.className = 'hud-editor-tabs';
    const label = document.createElement('b');
    label.textContent = 'PROFILO IN MODIFICA';
    const row = document.createElement('div');
    this.tabButtons = new Map();
    for (const device of HUD_DEVICES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.hudDevice = device.id;
      button.append(document.createTextNode(device.label));
      const note = document.createElement('small');
      note.textContent = device.note;
      button.append(note);
      button.addEventListener('click', () => this.setDevice(device.id));
      row.append(button);
      this.tabButtons.set(device.id, button);
    }
    this.deviceNote = document.createElement('p');
    this.deviceNote.className = 'debug-range-note';
    wrap.append(label, row, this.deviceNote);
    return wrap;
  }

  buildPresets() {
    const wrap = document.createElement('div');
    wrap.className = 'filter-presets';
    const label = document.createElement('b');
    label.textContent = 'PRESET';
    const row = document.createElement('div');
    for (const [name, preset] of Object.entries(HUD_THEME_PRESETS)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = preset.label;
      button.addEventListener('click', () => this.options.onPreset?.(name));
      row.append(button);
    }
    wrap.append(label, row);
    return wrap;
  }

  buildFilter() {
    const label = document.createElement('label');
    label.className = 'hud-editor-search';
    const caption = document.createElement('span');
    caption.textContent = 'CERCA';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'punteggio, font, caricamento…';
    input.setAttribute('aria-label', 'Filtra i controlli');
    input.addEventListener('input', () => this.applyFilter(input.value));
    label.append(caption, input);
    this.filterInput = input;
    return label;
  }

  buildSection(section) {
    const details = document.createElement('details');
    details.className = 'debug-traffic-panel hud-editor-section';
    details.dataset.hudSection = section.id;
    if (section.id === SECTION_OPEN_BY_DEFAULT) details.open = true;
    const summary = document.createElement('summary');
    const caption = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = section.label;
    const note = document.createElement('small');
    note.textContent = section.scope === 'shared' ? 'PC + telefono' : 'per profilo';
    caption.append(name, note);
    const badge = document.createElement('em');
    badge.textContent = 'EDIT';
    summary.append(caption, badge);
    details.append(summary);

    if (section.note) {
      const explain = document.createElement('p');
      explain.className = 'debug-range-note';
      explain.textContent = section.note;
      details.append(explain);
    }
    const rows = document.createElement('div');
    rows.className = 'hud-editor-rows';
    for (const field of section.fields) rows.append(this.buildControl(section, field));
    details.append(rows);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'hud-editor-section-reset';
    reset.textContent = 'RIPRISTINA SEZIONE';
    reset.addEventListener('click', () => {
      this.options.onResetSection?.(section.id, section.scope === 'shared' ? null : this.device);
    });
    details.append(reset);
    this.sections.set(section.id, { section, details, rows });
    return details;
  }

  /** One control, wired to the callbacks. The record is what `sync()` reads. */
  buildControl(section, field) {
    const record = { section, field, row: null, input: null, valueLabel: null };
    const emit = (value, commit) => this.options.onField?.(field.key, value, { commit, device: this.device });

    if (field.type === 'toggle') {
      const label = document.createElement('label');
      label.className = 'debug-toggle hud-editor-row';
      const caption = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = field.label;
      caption.append(name);
      if (field.note) {
        const note = document.createElement('small');
        note.textContent = field.note;
        caption.append(note);
      }
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => emit(input.checked, true));
      label.append(caption, input, document.createElement('i'));
      record.row = label;
      record.input = input;
    } else if (field.type === 'range') {
      const label = document.createElement('label');
      label.className = 'debug-range hud-editor-row';
      const caption = document.createElement('span');
      const value = document.createElement('b');
      caption.append(document.createTextNode(`${field.label} `), value);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.addEventListener('input', () => emit(input.value, false));
      input.addEventListener('change', () => emit(input.value, true));
      label.append(caption, input);
      if (field.note) {
        const note = document.createElement('small');
        note.className = 'hud-editor-note';
        note.textContent = field.note;
        label.append(note);
      }
      record.row = label;
      record.input = input;
      record.valueLabel = value;
    } else if (field.type === 'color') {
      const label = document.createElement('label');
      label.className = 'debug-select hud-editor-row hud-editor-color';
      const caption = document.createElement('span');
      const value = document.createElement('b');
      caption.append(document.createTextNode(`${field.label} `), value);
      const input = document.createElement('input');
      input.type = 'color';
      // Colour inputs stream `input` while the picker is open; the same
      // live-drag / commit-on-release contract as the sliders applies.
      input.addEventListener('input', () => emit(input.value, false));
      input.addEventListener('change', () => emit(input.value, true));
      label.append(caption, input);
      record.row = label;
      record.input = input;
      record.valueLabel = value;
    } else if (field.type === 'role' || field.type === 'font') {
      const label = document.createElement('label');
      label.className = 'debug-select hud-editor-row';
      const caption = document.createElement('span');
      caption.textContent = field.label;
      const select = document.createElement('select');
      const entries = field.type === 'role' ? HUD_COLOR_ROLES : HUD_FONT_STACKS;
      for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.label;
        select.append(option);
      }
      select.addEventListener('change', () => emit(select.value, true));
      label.append(caption, select);
      record.row = label;
      record.input = select;
    } else if (field.type === 'text') {
      const label = document.createElement('label');
      label.className = 'debug-select hud-editor-row hud-editor-text';
      const caption = document.createElement('span');
      caption.textContent = field.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 200;
      input.addEventListener('input', () => emit(input.value, false));
      input.addEventListener('change', () => emit(input.value, true));
      label.append(caption, input);
      record.row = label;
      record.input = input;
    } else {
      record.row = document.createElement('div');
    }

    record.row.dataset.hudField = field.key;
    record.row.dataset.hudSearch = `${field.label} ${field.key} ${field.note || ''}`.toLowerCase();
    this.controls.push(record);
    return record.row;
  }

  buildFooter() {
    const wrap = document.createElement('div');
    wrap.className = 'hud-editor-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const to = HUD_DEVICES.find((device) => device.id !== this.device)?.id;
      if (to) this.options.onCopyProfile?.(this.device, to);
    });
    const resetAll = document.createElement('button');
    resetAll.type = 'button';
    resetAll.textContent = 'RIPRISTINA TUTTO';
    resetAll.addEventListener('click', () => this.options.onResetAll?.());
    this.copyButton = copy;
    wrap.append(copy, resetAll);
    return wrap;
  }

  /**
   * Export/import as JSON text. The point is a theme that survives without the
   * editor server: copy it out of one browser, paste it into another, or commit
   * it. Import goes through the same normalizer as everything else, so a
   * hand-edited file cannot install a value the panel could not have produced.
   */
  buildTransfer() {
    const details = document.createElement('details');
    details.className = 'debug-traffic-panel hud-editor-transfer';
    const summary = document.createElement('summary');
    const caption = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = 'ESPORTA / IMPORTA';
    const note = document.createElement('small');
    note.textContent = 'Il tema come testo JSON: copialo, incollalo, salvalo';
    caption.append(name, note);
    const badge = document.createElement('em');
    badge.textContent = 'JSON';
    summary.append(caption, badge);

    const area = document.createElement('textarea');
    area.className = 'hud-editor-json';
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Tema in formato JSON');
    const row = document.createElement('div');
    row.className = 'hud-editor-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'COPIA';
    copy.addEventListener('click', async () => {
      area.value = this.themeJson();
      try {
        await navigator.clipboard?.writeText?.(area.value);
        this.options.toast?.('TEMA COPIATO // JSON', 'amber');
      } catch (error) {
        // No clipboard permission (or no clipboard at all): the text is on
        // screen and selectable, which is the whole requirement.
        area.select();
      }
    });
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = 'APPLICA JSON';
    apply.addEventListener('click', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(area.value);
      } catch (error) {
        this.options.toast?.(`JSON NON VALIDO // ${error.message}`, 'red');
        return;
      }
      this.options.onImport?.(parsed);
    });
    row.append(copy, apply);
    details.append(summary, area, row);
    // Filling it on open keeps the text in step with the panel without
    // serializing the theme on every slider move.
    details.addEventListener('toggle', () => { if (details.open) area.value = this.themeJson(); });
    this.jsonArea = area;
    return details;
  }

  themeJson() {
    return JSON.stringify(this.options.getTheme?.() || {}, null, 2);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  setDevice(device) {
    if (this.device === device) return;
    this.device = device;
    this.options.onEditDevice?.(device);
    this.sync();
  }

  setOpen(open) {
    this.open = !!open;
    this.root?.classList.toggle('hidden', !this.open);
    this.root?.setAttribute('aria-hidden', String(!this.open));
    if (this.open) this.sync();
  }

  applyFilter(value) {
    this.filter = String(value || '').trim().toLowerCase();
    for (const record of this.controls) {
      const hidden = this.filter.length > 0 && !record.row.dataset.hudSearch.includes(this.filter);
      record.row.hidden = hidden;
    }
    for (const { details, rows } of this.sections.values()) {
      const visible = [...rows.children].some((row) => !row.hidden);
      details.hidden = this.filter.length > 0 && !visible;
      if (this.filter.length > 0 && visible) details.open = true;
    }
  }

  /**
   * Pulls every control back from the theme. Skips whatever has focus, so a
   * value cannot jump out from under a finger mid-drag, and re-labels the tabs
   * with which profile is live versus which one is being previewed.
   */
  sync() {
    const theme = this.options.getTheme?.();
    if (!theme) return;
    for (const record of this.controls) {
      const { section, field, input, valueLabel } = record;
      const value = hudThemeValue(theme, section, field, this.device);
      if (valueLabel) valueLabel.textContent = formatHudValue(field, value);
      if (!input || document.activeElement === input) continue;
      if (field.type === 'toggle') input.checked = !!value;
      else input.value = String(value);
    }
    for (const [id, button] of this.tabButtons || []) {
      button.classList.toggle('active', id === this.device);
      button.setAttribute('aria-pressed', String(id === this.device));
    }
    const active = this.options.getActiveDevice?.() || 'desktop';
    const activeLabel = HUD_DEVICES.find((device) => device.id === active)?.label || active;
    const editingLabel = HUD_DEVICES.find((device) => device.id === this.device)?.label || this.device;
    this.deviceNote.textContent = active === this.device
      ? `Questo browser è in profilo ${activeLabel}: stai vedendo esattamente il risultato.`
      : `Questo browser è in profilo ${activeLabel}. Con l'editor aperto vedi colori e corpi del profilo ${editingLabel}; posizioni e ingombri restano quelli di ${activeLabel}, perché li decide la media query.`;
    if (this.copyButton) {
      const other = HUD_DEVICES.find((device) => device.id !== this.device);
      this.copyButton.textContent = `COPIA ${editingLabel} ▶ ${other?.label || ''}`.trim();
    }
    if (this.jsonArea && this.jsonArea.closest('details')?.open) this.jsonArea.value = this.themeJson();
  }
}
