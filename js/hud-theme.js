/**
 * The interface theme: what the game reads, not what edits it.
 *
 * Everything the player looks at is described here — the palette, the two font
 * families, every size/offset/visibility of the driving HUD, the in-game keitai,
 * the WANGAN MARKET terminal, the loading screen and the boot menu — as one
 * table of fields with a default per device profile. `applyHudTheme()` turns a
 * theme into CSS custom properties on <html> and styles.css reads them as
 * `var(--hud-x, fallback)`.
 *
 * The editor is NOT here. It lives in tools/hesi-editor (toolbar → HUD), where
 * the HUD is edited by dragging and resizing it on real device previews, and it
 * writes the result into data/editor/custom-assets.json → `runtimeTuning.hud`.
 * The playable build therefore ships the model and the values, never the panel:
 * presets, value formatting and the edit operations live in
 * tools/hesi-editor/src/hud/hud-vocabulary.js.
 *
 * Field `label`s do stay here, beside the ranges and defaults they belong to,
 * because a second table of ~140 names is a synchronization hazard for the sake
 * of a few kilobytes.
 *
 * Two rules shape the whole design:
 *
 *  1. **A default theme changes nothing.** Every default below is the value
 *     styles.css already had, and every declaration in styles.css keeps that
 *     value as its `var(--x, fallback)` fallback. So a browser that never opens
 *     the editor renders the authored 2002 look byte for byte, and a stylesheet
 *     that loads before the module does not flash. `.devtests/hud-theme.test.mjs`
 *     reads styles.css and fails if a default and its fallback ever drift.
 *
 *  2. **PC and phone are separate profiles.** The compact HUD is not a smaller
 *     copy of the desktop HUD: the minimap is gone, the cluster is scaled, the
 *     FPS readout only exists there. So most fields carry one value per device
 *     and only the active profile is written to the document. The profile is
 *     chosen with `HUD_DEVICE_QUERY` — the *same* media query the compact-HUD
 *     rules use, so the variables can never describe a layout the stylesheet
 *     is not currently applying.
 *
 * Colours are kept as palette *roles* rather than as per-element hex values
 * (`scoreRole: 'paper'` emits `var(--paper)`), so recolouring the palette still
 * moves everything that follows it. The alternative — a colour picker per
 * element — freezes each one at whatever hex it had when it was first touched.
 *
 * The authored theme travels in data/editor/custom-assets.json under
 * `runtimeTuning.hud`, the same way the picture does (see js/playground-config.js),
 * and the game applies what the document says on every boot.
 */

/** The two profiles. `label` is what the panel's tabs say. */
export const HUD_DEVICES = Object.freeze([
  Object.freeze({ id: 'desktop', label: 'PC', note: 'Mouse e tastiera · HUD completo' }),
  Object.freeze({ id: 'mobile', label: 'TELEFONO', note: 'Touch · HUD compatto' }),
]);

export const HUD_DEVICE_IDS = Object.freeze(HUD_DEVICES.map((device) => device.id));

/**
 * Which profile is live. This is deliberately the media query from styles.css
 * that switches the compact HUD on, and not `detectHandheld()`: the render
 * profile answers "how fast is this machine", while this answers "which set of
 * layout rules is the browser applying right now". A 600px-wide desktop window
 * gets the compact HUD, so it must also get the compact profile's numbers.
 */
export const HUD_DEVICE_QUERY = '(pointer:coarse), (max-width:700px)';

/** Reads the live browser and returns the profile id to apply. */
export function detectHudDevice(view = typeof window === 'undefined' ? null : window) {
  if (!view?.matchMedia) return 'desktop';
  return view.matchMedia(HUD_DEVICE_QUERY).matches ? 'mobile' : 'desktop';
}

/**
 * The font stacks offered for the two families. `signal` and `display` are the
 * shipped faces (subset from the project's own OFL sources, see
 * fonts/OFL-Shutoko-Signal.txt); `rounded` is the M PLUS Rounded 1c subset that
 * was already in fonts/ but had no @font-face — it is declared in styles.css as
 * "Shutoko Rounded" so selecting it here is the only thing that loads it.
 */
export const HUD_FONT_STACKS = Object.freeze([
  Object.freeze({ id: 'signal', label: 'Shutoko Signal (segnaletica)', stack: '"Shutoko Signal","Arial Narrow","Hiragino Maru Gothic ProN","MS Gothic",sans-serif' }),
  Object.freeze({ id: 'display', label: 'Shutoko Signal Display (titoli)', stack: '"Shutoko Signal Display","Shutoko Signal","Arial Narrow",sans-serif' }),
  Object.freeze({ id: 'rounded', label: 'Shutoko Rounded (morbido)', stack: '"Shutoko Rounded","Hiragino Maru Gothic ProN","MS PGothic",sans-serif' }),
  Object.freeze({ id: 'narrow', label: 'Stretta di sistema', stack: '"Arial Narrow","Liberation Sans Narrow","Helvetica Neue",sans-serif' }),
  Object.freeze({ id: 'sans', label: 'Sans di sistema', stack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' }),
  Object.freeze({ id: 'mono', label: 'Monospaziata', stack: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace' }),
  Object.freeze({ id: 'serif', label: 'Serif', stack: 'Georgia,"Times New Roman",serif' }),
]);

const FONT_STACK_BY_ID = new Map(HUD_FONT_STACKS.map((font) => [font.id, font.stack]));

/**
 * Palette roles. A `role` field stores one of these ids and emits the matching
 * custom property, so every element that points at `green` follows the palette
 * when the palette moves.
 */
export const HUD_COLOR_ROLES = Object.freeze([
  Object.freeze({ id: 'paper', label: 'Carta (bianco sporco)', css: 'var(--paper)' }),
  Object.freeze({ id: 'green', label: 'Verde fosforo', css: 'var(--green)' }),
  Object.freeze({ id: 'amber', label: 'Ambra', css: 'var(--amber)' }),
  Object.freeze({ id: 'red', label: 'Rosso', css: 'var(--red)' }),
  Object.freeze({ id: 'cyan', label: 'Ciano', css: 'var(--cyan)' }),
  Object.freeze({ id: 'lav', label: 'Lavanda', css: 'var(--lav)' }),
  Object.freeze({ id: 'dim', label: 'Grigio spento', css: 'var(--dim)' }),
  Object.freeze({ id: 'white', label: 'Bianco pieno', css: '#ffffff' }),
]);

const ROLE_CSS_BY_ID = new Map(HUD_COLOR_ROLES.map((role) => [role.id, role.css]));

const range = (key, label, extra) => Object.freeze({ key, label, type: 'range', ...extra });
const color = (key, label, extra) => Object.freeze({ key, label, type: 'color', ...extra });
const role = (key, label, extra) => Object.freeze({ key, label, type: 'role', ...extra });
const toggle = (key, label, extra) => Object.freeze({ key, label, type: 'toggle', ...extra });
const text = (key, label, extra) => Object.freeze({ key, label, type: 'text', ...extra });
const font = (key, label, extra) => Object.freeze({ key, label, type: 'font', ...extra });

/**
 * The whole editable surface, in the order the panel shows it.
 *
 * `scope: 'shared'` means one value for both devices (a palette is a palette);
 * `scope: 'device'` means one value per profile, and every field in such a
 * section carries a `desktop` and a `mobile` default.
 *
 * Field types:
 *  - `range`  a number plus `unit` ('px' | '%' | 's' | 'em' | ''); `scaled`
 *             fields are multiplied by that profile's `fontScale` on the way out
 *  - `color`  a hex string, emitted as-is
 *  - `role`   a palette role id (see HUD_COLOR_ROLES)
 *  - `font`   a stack id (see HUD_FONT_STACKS)
 *  - `toggle` a boolean emitted as the `on`/`off` CSS keyword pair — always a
 *             `display` or `animation-name` value, never `!important`, so a
 *             game rule that must win (`.hidden`) still wins
 *  - `text`   a string written with textContent into `target` (never innerHTML)
 *
 * A field may override its section's scope with `scope: 'shared'`. The three HUD
 * label texts do: there is one document, so "UNBANKED · 未精算" cannot sensibly
 * be one string on a PC and another on a phone, but the panel should still show
 * them beside the HUD sizes they belong to rather than in a texts-only section.
 */
export const HUD_THEME_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'palette',
    label: 'PALETTE',
    note: 'I colori che tutto il resto segue. Ogni elemento punta a un ruolo, non a un esadecimale.',
    scope: 'shared',
    fields: Object.freeze([
      color('colorPaper', 'CARTA', { css: '--paper', value: '#e2e8dd' }),
      color('colorDim', 'GRIGIO SPENTO', { css: '--dim', value: '#7d8a99' }),
      color('colorGreen', 'VERDE FOSFORO', { css: '--green', value: '#5cff8a' }),
      color('colorAmber', 'AMBRA', { css: '--amber', value: '#ffb02e' }),
      color('colorRed', 'ROSSO', { css: '--red', value: '#ff2e4d' }),
      color('colorCyan', 'CIANO', { css: '--cyan', value: '#41d8f2' }),
      color('colorLav', 'LAVANDA', { css: '--lav', value: '#b9a7ff' }),
      color('colorPanel', 'PANNELLI', { css: '--panel', value: '#070b12' }),
      color('colorLine', 'BORDI', { css: '--line', value: '#1d2a3a' }),
      color('colorBg', 'FONDO', { css: '--bg', value: '#04060b' }),
      range('glowAlpha', 'ALONE VERDE', {
        value: 0.55, min: 0, max: 1, step: 0.05, percent: true,
        note: 'Opacità di --green-soft, il colore con cui il verde brilla.',
      }),
    ]),
  }),

  Object.freeze({
    id: 'type',
    label: 'FONT & TESTO',
    note: 'Le due famiglie e la forza di alone e ombra. Separate per PC e telefono: una scala che funziona su un monitor annega uno schermo da 6".',
    scope: 'device',
    fields: Object.freeze([
      font('fontTerm', 'FONT TERMINALE', { css: '--term', desktop: 'signal', mobile: 'signal', note: 'Etichette, quadranti, liste: il testo piccolo.' }),
      font('fontDisp', 'FONT TITOLI', { css: '--disp', desktop: 'display', mobile: 'display', note: 'Punteggio, nomi zona, logo: il testo grande.' }),
      range('fontScale', 'SCALA TESTO', {
        css: '--hud-font-scale', desktop: 1, mobile: 1, min: 0.5, max: 2.5, step: 0.05, percent: true,
        note: 'Moltiplica ogni corpo di testo di questo profilo in un colpo solo.',
      }),
      range('hudGlow', 'FORZA ALONE', { css: '--hud-glow', desktop: 1, mobile: 1, min: 0, max: 3, step: 0.05, percent: true, zero: 'SPENTO' }),
      range('hudShadow', 'FORZA OMBRA', { css: '--hud-shadow', desktop: 1, mobile: 1, min: 0, max: 3, step: 0.05, percent: true, zero: 'PIATTA' }),
    ]),
  }),

  Object.freeze({
    id: 'hud',
    label: 'HUD GUIDA',
    note: 'I quattro angoli durante la guida. Gli spostamenti sono relativi alla posizione autorizzata, così un profilo a zero resta quello originale.',
    scope: 'device',
    fields: Object.freeze([
      range('hudOpacity', 'OPACITÀ HUD', { css: '--hud-opacity', desktop: 1, mobile: 1, min: 0.05, max: 1, step: 0.05, percent: true }),

      range('tlX', 'PUNTEGGIO ORIZZONTALE', { css: '--hud-tl-x', unit: 'px', desktop: 0, mobile: 0, min: -400, max: 400, step: 2 }),
      range('tlY', 'PUNTEGGIO VERTICALE', { css: '--hud-tl-y', unit: 'px', desktop: 0, mobile: 0, min: -300, max: 500, step: 2 }),
      range('tlScale', 'PUNTEGGIO SCALA', { css: '--hud-tl-scale', desktop: 1, mobile: 1, min: 0.4, max: 2.5, step: 0.05, percent: true }),
      range('trX', 'BANCA ORIZZONTALE', { css: '--hud-tr-x', unit: 'px', desktop: 0, mobile: 0, min: -400, max: 400, step: 2 }),
      range('trY', 'BANCA VERTICALE', { css: '--hud-tr-y', unit: 'px', desktop: 0, mobile: 0, min: -300, max: 500, step: 2 }),
      range('trScale', 'BANCA SCALA', { css: '--hud-tr-scale', desktop: 1, mobile: 1, min: 0.4, max: 2.5, step: 0.05, percent: true }),
      range('blX', 'GPS ORIZZONTALE', { css: '--hud-bl-x', unit: 'px', desktop: 0, mobile: 0, min: -400, max: 400, step: 2 }),
      range('blY', 'GPS VERTICALE', { css: '--hud-bl-y', unit: 'px', desktop: 0, mobile: 0, min: -500, max: 300, step: 2 }),
      range('blScale', 'GPS SCALA', { css: '--hud-bl-scale', desktop: 1, mobile: 1, min: 0.4, max: 2.5, step: 0.05, percent: true }),
      range('brX', 'QUADRANTI ORIZZONTALE', { css: '--hud-br-x', unit: 'px', desktop: 0, mobile: 0, min: -400, max: 400, step: 2 }),
      range('brY', 'QUADRANTI VERTICALE', { css: '--hud-br-y', unit: 'px', desktop: 0, mobile: 0, min: -500, max: 300, step: 2 }),

      // The floating pieces get the same treatment as the four corners, so the
      // editor can drag them too. Nudges, not positions: the authored anchors
      // stay authored and a profile at zero is the original layout.
      range('toastX', 'AVVISI ORIZZONTALE', { css: '--hud-toast-x', unit: 'px', desktop: 0, mobile: 0, min: -600, max: 600, step: 2 }),
      range('toastY', 'AVVISI VERTICALE', { css: '--hud-toast-y', unit: 'px', desktop: 0, mobile: 0, min: -400, max: 600, step: 2 }),
      range('toastScale', 'AVVISI SCALA', { css: '--hud-toast-scale', desktop: 1, mobile: 1, min: 0.4, max: 2.5, step: 0.05, percent: true }),
      range('promptX', 'RICHIESTE ORIZZONTALE', { css: '--hud-prompt-x', unit: 'px', desktop: 0, mobile: 0, min: -600, max: 600, step: 2 }),
      range('promptY', 'RICHIESTE VERTICALE', { css: '--hud-prompt-y', unit: 'px', desktop: 0, mobile: 0, min: -600, max: 400, step: 2 }),
      range('splashX', 'NEAR MISS ORIZZONTALE', { css: '--hud-splash-x', unit: 'px', desktop: 0, mobile: 0, min: -600, max: 600, step: 2 }),
      range('splashY', 'NEAR MISS VERTICALE', { css: '--hud-splash-y', unit: 'px', desktop: 0, mobile: 0, min: -400, max: 600, step: 2 }),
      range('fpsX', 'FPS ORIZZONTALE', { css: '--hud-fps-x', unit: 'px', desktop: 0, mobile: 0, min: -600, max: 600, step: 2 }),
      range('fpsY', 'FPS VERTICALE', { css: '--hud-fps-y', unit: 'px', desktop: 0, mobile: 0, min: -400, max: 600, step: 2 }),
      range('fpsSize', 'CORPO FPS', { css: '--hud-fps-size', unit: 'px', scaled: true, desktop: 8, mobile: 8, min: 5, max: 30, step: 1 }),

      toggle('showScore', 'PUNTEGGIO', { css: '--hud-show-score', on: 'block', off: 'none', desktop: true, mobile: true }),
      toggle('showScoreLabel', 'ETICHETTA PUNTEGGIO', { css: '--hud-show-score-label', on: 'block', off: 'none', desktop: true, mobile: true }),
      toggle('showCombo', 'COMBO', { css: '--hud-show-combo', on: 'flex', off: 'none', desktop: true, mobile: true }),
      toggle('showComboBar', 'BARRA COMBO', { css: '--hud-show-combo-bar', on: 'block', off: 'none', desktop: true, mobile: true }),
      toggle('showLives', 'VITE', { css: '--hud-show-lives', on: 'flex', off: 'none', desktop: true, mobile: true }),
      toggle('showBank', 'BANCA', { css: '--hud-show-bank', on: 'block', off: 'none', desktop: true, mobile: true }),
      toggle('showMinimap', 'MINIMAPPA GPS', { css: '--hud-show-minimap', on: 'block', off: 'none', desktop: true, mobile: false, note: 'Sul telefono è nascosta da sempre: accenderla costa un disegno canvas per frame.' }),
      toggle('showArea', 'ZONA / ROTTA', { css: '--hud-show-area', on: 'block', off: 'none', desktop: true, mobile: true }),
      toggle('showCluster', 'QUADRANTI', { css: '--hud-show-cluster', on: 'flex', off: 'none', desktop: true, mobile: true }),
      toggle('showTach', 'CONTAGIRI', { css: '--hud-show-tach', on: 'block', off: 'none', desktop: true, mobile: true }),
      toggle('showGear', 'MARCIA', { css: '--hud-show-gear', on: 'grid', off: 'none', desktop: true, mobile: true }),
      toggle('showFuel', 'CARBURANTE', { css: '--hud-show-fuel', on: 'flex', off: 'none', desktop: true, mobile: true }),
      toggle('showFps', 'CONTATORE FPS', { css: '--hud-show-fps', on: 'block', off: 'none', desktop: false, mobile: true }),
      toggle('showToasts', 'AVVISI', { css: '--hud-show-toast', on: 'flex', off: 'none', desktop: true, mobile: true }),
      toggle('showPrompt', 'RICHIESTE AZIONE', { css: '--hud-show-prompt', on: 'flex', off: 'none', desktop: true, mobile: true }),
      toggle('showSplash', 'NEAR MISS', { css: '--hud-show-splash', on: 'block', off: 'none', desktop: true, mobile: true }),

      range('scoreSize', 'CORPO PUNTEGGIO', { css: '--hud-score-size', unit: 'px', scaled: true, desktop: 46, mobile: 30, min: 8, max: 140, step: 1 }),
      range('scoreLabelSize', 'CORPO ETICHETTA', { css: '--hud-score-label-size', unit: 'px', scaled: true, desktop: 10, mobile: 8, min: 5, max: 40, step: 1 }),
      range('comboSize', 'CORPO COMBO', { css: '--hud-combo-size', unit: 'px', scaled: true, desktop: 22, mobile: 16, min: 6, max: 80, step: 1 }),
      range('comboBarWidth', 'LARGHEZZA BARRA COMBO', { css: '--hud-combo-bar-width', unit: 'px', desktop: 170, mobile: 120, min: 40, max: 500, step: 5 }),
      range('lifeSize', 'DIMENSIONE VITE', { css: '--hud-life-size', unit: 'px', desktop: 15, mobile: 11, min: 5, max: 40, step: 1 }),
      range('bankSize', 'CORPO BANCA', { css: '--hud-bank-size', unit: 'px', scaled: true, desktop: 26, mobile: 17, min: 8, max: 90, step: 1 }),
      range('bankLabelSize', 'CORPO ETICHETTA BANCA', { css: '--hud-bank-label-size', unit: 'px', scaled: true, desktop: 9, mobile: 7, min: 5, max: 30, step: 1 }),
      range('minimapWidth', 'GPS LARGHEZZA', { css: '--hud-minimap-width', unit: 'px', desktop: 220, mobile: 220, min: 80, max: 520, step: 5 }),
      range('minimapHeight', 'GPS ALTEZZA', { css: '--hud-minimap-height', unit: 'px', desktop: 150, mobile: 150, min: 60, max: 420, step: 5 }),
      range('areaSize', 'CORPO ZONA', { css: '--hud-area-size', unit: 'px', scaled: true, desktop: 24, mobile: 15, min: 8, max: 80, step: 1 }),
      range('areaLabelSize', 'CORPO ROTTA', { css: '--hud-area-label-size', unit: 'px', scaled: true, desktop: 10, mobile: 7, min: 5, max: 30, step: 1 }),
      // A multiplier, not a size: the compact HUD scales the cluster to .62 and
      // the two phone orientations to .5/.54, so an absolute value here would
      // have had to pick one of the three and would have broken the other two.
      range('clusterScale', 'SCALA QUADRANTI', { css: '--hud-cluster-scale', desktop: 1, mobile: 1, min: 0.3, max: 2.5, step: 0.02, percent: true }),
      range('dialTachSize', 'CONTAGIRI Ø', { css: '--hud-dial-tach', unit: 'px', desktop: 118, mobile: 118, min: 50, max: 320, step: 2 }),
      range('dialSpeedSize', 'TACHIMETRO Ø', { css: '--hud-dial-speed', unit: 'px', desktop: 152, mobile: 152, min: 60, max: 400, step: 2 }),
      range('speedSize', 'CORPO KM/H', { css: '--hud-speed-size', unit: 'px', scaled: true, desktop: 15, mobile: 15, min: 6, max: 60, step: 1 }),
      range('rpmSize', 'CORPO GIRI', { css: '--hud-rpm-size', unit: 'px', scaled: true, desktop: 11, mobile: 11, min: 5, max: 48, step: 1 }),
      range('gearSize', 'CORPO MARCIA', { css: '--hud-gear-size', unit: 'px', scaled: true, desktop: 27, mobile: 27, min: 8, max: 90, step: 1 }),
      range('fuelWidth', 'BARRA CARBURANTE', { css: '--hud-fuel-width', unit: 'px', desktop: 76, mobile: 76, min: 30, max: 300, step: 2 }),
      range('toastSize', 'CORPO AVVISI', { css: '--hud-toast-size', unit: 'px', scaled: true, desktop: 12, mobile: 9, min: 6, max: 40, step: 1 }),
      range('promptSize', 'CORPO RICHIESTE', { css: '--hud-prompt-size', unit: 'px', scaled: true, desktop: 14, mobile: 11, min: 6, max: 48, step: 1 }),
      range('splashSize', 'CORPO NEAR MISS', { css: '--hud-splash-size', unit: 'px', scaled: true, desktop: 46, mobile: 30, min: 10, max: 140, step: 1 }),

      role('scoreRole', 'COLORE PUNTEGGIO', { css: '--hud-score-color', desktop: 'paper', mobile: 'paper' }),
      role('scoreLabelRole', 'COLORE ETICHETTA', { css: '--hud-score-label-color', desktop: 'green', mobile: 'green' }),
      role('comboRole', 'COLORE COMBO', { css: '--hud-combo-color', desktop: 'amber', mobile: 'amber' }),
      role('bankRole', 'COLORE BANCA', { css: '--hud-bank-color', desktop: 'green', mobile: 'green' }),
      role('areaRole', 'COLORE ZONA', { css: '--hud-area-color', desktop: 'paper', mobile: 'paper' }),
      role('areaLabelRole', 'COLORE ROTTA', { css: '--hud-area-label-color', desktop: 'green', mobile: 'green' }),
      role('speedRole', 'COLORE QUADRANTI', { css: '--hud-readout-color', desktop: 'green', mobile: 'green' }),
      role('gearRole', 'COLORE MARCIA', { css: '--hud-gear-color', desktop: 'amber', mobile: 'amber' }),
      role('toastRole', 'COLORE AVVISI', { css: '--hud-toast-color', desktop: 'paper', mobile: 'paper' }),
      role('promptRole', 'COLORE RICHIESTE', { css: '--hud-prompt-color', desktop: 'paper', mobile: 'paper' }),
      role('splashRole', 'COLORE NEAR MISS', { css: '--hud-splash-color', desktop: 'white', mobile: 'white' }),

      text('scoreLabel', 'TESTO ETICHETTA PUNTEGGIO', { scope: 'shared', target: '.score-block small', value: 'UNBANKED · 未精算' }),
      text('bankLabel', 'TESTO ETICHETTA BANCA', { scope: 'shared', target: '.bank small', value: 'BANK · 残高' }),
      text('livesLabel', 'TESTO VITE', { scope: 'shared', target: '#lives span', value: 'RUN LIVES' }),
    ]),
  }),

  Object.freeze({
    id: 'canvas',
    label: 'QUADRANTI & GPS',
    note: 'Quadranti e minimappa sono disegnati su canvas, non con il CSS: qui i colori sono esadecimali diretti invece di ruoli, perché un contesto 2D non sa risolvere var().',
    scope: 'device',
    fields: Object.freeze([
      color('dialFace', 'FONDO QUADRANTE', { css: '--hud-dial-face', desktop: '#0a0f15', mobile: '#0a0f15' }),
      color('dialNeedle', 'LANCETTA & ZONA ROSSA', { css: '--hud-dial-needle', desktop: '#ff2e4d', mobile: '#ff2e4d' }),
      color('dialTick', 'TACCHE', { css: '--hud-dial-tick', desktop: '#8cffab', mobile: '#8cffab', note: 'Le tacche minori e la scritta km/h ne sono la versione trasparente.' }),
      color('dialLabel', 'NUMERI', { css: '--hud-dial-label', desktop: '#b6ffcc', mobile: '#b6ffcc' }),
      color('dialGlow', 'ALONE QUADRANTE', { css: '--hud-dial-glow', desktop: '#5cff8a', mobile: '#5cff8a', note: 'Alone di tacche e numeri, anello esterno e perno della lancetta.' }),
      color('mapBg', 'FONDO GPS', { css: '--hud-map-bg', desktop: '#020a06', mobile: '#020a06' }),
      color('mapRoute', 'ROTTA ATTIVA', { css: '--hud-map-route', desktop: '#35ff85', mobile: '#35ff85' }),
      color('mapRouteAlt', 'ALTRE ROTTE', { css: '--hud-map-route-alt', desktop: '#1d3f2c', mobile: '#1d3f2c' }),
      color('mapService', 'AREE DI SERVIZIO', { css: '--hud-map-service', desktop: '#3affd2', mobile: '#3affd2' }),
      color('mapGarage', 'GARAGE', { css: '--hud-map-garage', desktop: '#ff4d6d', mobile: '#ff4d6d' }),
      color('mapPlayer', 'FRECCIA GIOCATORE', { css: '--hud-map-player', desktop: '#ffffff', mobile: '#ffffff' }),
    ]),
  }),

  Object.freeze({
    id: 'phone',
    label: 'TELEFONO IN GIOCO',
    note: 'Il keitai del 2002 (F). Larghezza e raggio hanno già due valori diversi fra PC e touch, quindi restano per profilo.',
    scope: 'device',
    fields: Object.freeze([
      range('phoneWidth', 'LARGHEZZA', { css: '--hud-phone-width', unit: 'px', desktop: 336, mobile: 360, min: 200, max: 640, step: 2, note: 'Sul telefono resta comunque sotto il 96% dello schermo.' }),
      range('phoneHeight', 'ALTEZZA', { css: '--hud-phone-height', unit: 'px', desktop: 612, mobile: 612, min: 320, max: 1100, step: 4, note: 'Solo su PC: in touch il guscio segue lo schermo.' }),
      range('phoneScale', 'SCALA GUSCIO', { css: '--hud-phone-scale', desktop: 1, mobile: 1, min: 0.5, max: 1.6, step: 0.02, percent: true }),
      range('phoneRadius', 'RAGGIO ANGOLI', { css: '--hud-phone-radius', unit: 'px', desktop: 34, mobile: 26, min: 0, max: 60, step: 1 }),
      color('phoneLcd1', 'LCD ALTO', { css: '--hud-phone-lcd-1', desktop: '#cfc6f2', mobile: '#cfc6f2' }),
      color('phoneLcd2', 'LCD CENTRO', { css: '--hud-phone-lcd-2', desktop: '#b7aae4', mobile: '#b7aae4' }),
      color('phoneLcd3', 'LCD BASSO', { css: '--hud-phone-lcd-3', desktop: '#a493d6', mobile: '#a493d6' }),
      color('phoneInk', 'INCHIOSTRO', { css: '--hud-phone-ink', desktop: '#241a44', mobile: '#241a44' }),
      color('phoneInk2', 'INCHIOSTRO MEDIO', { css: '--hud-phone-ink-2', desktop: '#3a2c66', mobile: '#3a2c66' }),
      color('phoneInk3', 'INCHIOSTRO CHIARO', { css: '--hud-phone-ink-3', desktop: '#4c3d80', mobile: '#4c3d80' }),
      range('phoneScan', 'RIGHE LCD', { css: '--hud-phone-scan', desktop: 0.06, mobile: 0.06, min: 0, max: 0.35, step: 0.01, percent: true, zero: 'PULITO' }),
      range('phoneHeaderSize', 'CORPO BARRA ALTA', { css: '--hud-phone-header-size', unit: 'px', scaled: true, desktop: 10, mobile: 10, min: 5, max: 26, step: 1 }),
      range('phoneTitleSize', 'CORPO TITOLO', { css: '--hud-phone-title-size', unit: 'px', scaled: true, desktop: 40, mobile: 40, min: 12, max: 90, step: 1 }),
      range('phoneLabelSize', 'CORPO TESTO', { css: '--hud-phone-label-size', unit: 'px', scaled: true, desktop: 10, mobile: 10, min: 5, max: 28, step: 1 }),
      range('phoneCardSize', 'CORPO SCHEDE', { css: '--hud-phone-card-size', unit: 'px', scaled: true, desktop: 17, mobile: 17, min: 7, max: 40, step: 1 }),
      range('phoneAppIcon', 'ICONE APP', { css: '--hud-phone-app-icon', unit: 'px', desktop: 52, mobile: 52, min: 26, max: 110, step: 2 }),
      range('phoneAppCols', 'COLONNE APP', { css: '--hud-phone-app-cols', desktop: 3, mobile: 3, min: 2, max: 5, step: 1, unit: '' }),
      toggle('showPhoneFooter', 'TASTI SOTTO LO SCHERMO', { css: '--hud-show-phone-footer', on: 'flex', off: 'none', desktop: true, mobile: true }),
    ]),
  }),

  Object.freeze({
    id: 'pc',
    label: 'TERMINALE PC',
    note: 'WANGAN MARKET: la schermata d\'asta del garage. Su touch occupa lo schermo intero, su PC è una finestra.',
    scope: 'device',
    fields: Object.freeze([
      range('pcInset', 'MARGINE FINESTRA', { css: '--hud-pc-inset', unit: '%', desktop: 2.5, mobile: 0, min: 0, max: 20, step: 0.5 }),
      range('pcHeader', 'ALTEZZA INTESTAZIONE', { css: '--hud-pc-header', unit: 'px', desktop: 84, mobile: 70, min: 40, max: 200, step: 2 }),
      role('pcAccentRole', 'COLORE ACCENTO', { css: '--hud-pc-accent', desktop: 'red', mobile: 'red' }),
      range('pcBrandSize', 'CORPO MARCHIO', { css: '--hud-pc-brand-size', unit: 'px', scaled: true, desktop: 21, mobile: 13, min: 8, max: 48, step: 1 }),
      range('pcNavSize', 'CORPO SCHEDE', { css: '--hud-pc-nav-size', unit: 'px', scaled: true, desktop: 11, mobile: 8, min: 5, max: 26, step: 1 }),
      range('pcBalanceSize', 'CORPO SALDO', { css: '--hud-pc-balance-size', unit: 'px', scaled: true, desktop: 20, mobile: 14, min: 7, max: 44, step: 1 }),
      range('pcTitleSize', 'CORPO TITOLI', { css: '--hud-pc-title-size', unit: 'px', scaled: true, desktop: 30, mobile: 22, min: 10, max: 64, step: 1 }),
      range('pcCardMin', 'LARGHEZZA MINIMA SCHEDE', { css: '--hud-pc-card-min', unit: 'px', desktop: 290, mobile: 290, min: 160, max: 520, step: 10 }),
      range('pcScan', 'RIGHE SCHERMO', { css: '--hud-pc-scan', desktop: 0.16, mobile: 0.16, min: 0, max: 0.6, step: 0.01, percent: true, zero: 'PULITO' }),
      // No `css` of its own: it is the alpha of the derived --hud-pc-grid below,
      // so storing it as a property too would let the two contradict each other.
      range('pcGridAlpha', 'GRIGLIA DI FONDO', { desktop: 0.025, mobile: 0.025, min: 0, max: 0.3, step: 0.005, percent: true, zero: 'ASSENTE' }),
      range('pcGridSize', 'PASSO GRIGLIA', { css: '--hud-pc-grid-size', unit: 'px', desktop: 22, mobile: 22, min: 6, max: 90, step: 2 }),
    ]),
  }),

  Object.freeze({
    id: 'loading',
    label: 'CARICAMENTO',
    note: 'La prima cosa che si vede, prima che esista un gioco. Testi compresi.',
    scope: 'shared',
    fields: Object.freeze([
      text('loadTitle', 'TITOLO', { target: '#loading b', value: 'SHUTOKO NIGHTS' }),
      text('loadSubtitle', 'SOTTOTITOLO', { target: '#loading span', value: 'NOW LOADING // 首都高速' }),
      color('loadBg', 'FONDO', { css: '--hud-load-bg', value: '#020408' }),
      range('loadTitleSize', 'CORPO TITOLO', { css: '--hud-load-title-size', unit: 'px', value: 46, min: 10, max: 140, step: 1 }),
      role('loadTitleRole', 'COLORE TITOLO', { css: '--hud-load-title-color', value: 'amber' }),
      toggle('loadJitter', 'SCATTO DEL TITOLO', { css: '--hud-load-jitter', on: 'title-jitter', off: 'none', value: true, note: 'Il tremolio da nastro sul titolo.' }),
      range('loadSubtitleSize', 'CORPO SOTTOTITOLO', { css: '--hud-load-subtitle-size', unit: 'px', value: 11, min: 5, max: 40, step: 1 }),
      color('loadSubtitleColor', 'COLORE SOTTOTITOLO', { css: '--hud-load-subtitle-color', value: '#66788e' }),
      toggle('showLoadRing', 'ANELLO', { css: '--hud-show-load-ring', on: 'block', off: 'none', value: true }),
      range('loadRingSize', 'ANELLO Ø', { css: '--hud-load-ring-size', unit: 'px', value: 58, min: 16, max: 220, step: 2 }),
      role('loadRingRole', 'COLORE ANELLO', { css: '--hud-load-ring-color', value: 'green' }),
      range('loadRingSpeed', 'GIRO ANELLO', { css: '--hud-load-ring-speed', unit: 's', value: 0.9, min: 0.15, max: 5, step: 0.05 }),
      toggle('showLoadBar', 'BARRA', { css: '--hud-show-load-bar', on: 'block', off: 'none', value: true }),
      range('loadBarWidth', 'BARRA LARGHEZZA', { css: '--hud-load-bar-width', unit: 'px', value: 250, min: 60, max: 900, step: 5 }),
      range('loadBarHeight', 'BARRA ALTEZZA', { css: '--hud-load-bar-height', unit: 'px', value: 6, min: 1, max: 40, step: 1 }),
      role('loadBarRole', 'COLORE BARRA', { css: '--hud-load-bar-color', value: 'amber' }),
    ]),
  }),

  Object.freeze({
    id: 'boot',
    label: 'SCHERMATA INIZIALE',
    note: 'Il menu di avvio. Le scale partono da 100%: la tipografia originale è responsive e va moltiplicata, non riscritta.',
    scope: 'shared',
    fields: Object.freeze([
      range('bootLogoScale', 'SCALA LOGO', { css: '--hud-boot-logo-scale', value: 1, min: 0.3, max: 2.2, step: 0.05, percent: true }),
      range('bootMenuScale', 'SCALA VOCI MENU', { css: '--hud-boot-menu-scale', value: 1, min: 0.4, max: 2.2, step: 0.05, percent: true }),
      range('bootKanjiScale', 'SCALA KANJI', { css: '--hud-boot-kanji-scale', value: 1, min: 0.2, max: 2.5, step: 0.05, percent: true }),
      role('bootLogoRole', 'COLORE LOGO', { css: '--hud-boot-logo-color', value: 'paper' }),
      role('bootLogoAccentRole', 'COLORE "NIGHTS"', { css: '--hud-boot-logo-accent', value: 'amber' }),
      toggle('showBootGrid', 'GRIGLIA PROSPETTICA', { css: '--hud-show-boot-grid', on: 'block', off: 'none', value: true }),
      toggle('showBootCity', 'SKYLINE', { css: '--hud-show-boot-city', on: 'block', off: 'none', value: true }),
      toggle('showBootKanji', 'KANJI VERTICALE', { css: '--hud-show-boot-kanji', on: 'block', off: 'none', value: true }),
      toggle('showBootTop', 'BARRA DI SISTEMA', { css: '--hud-show-boot-top', on: 'flex', off: 'none', value: true }),
      toggle('showBootTicker', 'STRISCIA IN BASSO', { css: '--hud-show-boot-ticker', on: 'block', off: 'none', value: true }),
      text('bootTicker', 'TESTO STRISCIA', {
        target: '.boot-ticker-track span', all: true,
        value: 'NO FINISH LINE · JUST ONE MORE EXIT · NO MEMORY CARD REQUIRED · HEADPHONES ON · KEYBOARD & TOUCH · © 2002 WANGAN WORKS · ',
      }),
    ]),
  }),
]);

const FIELD_INDEX = new Map();
for (const section of HUD_THEME_SECTIONS) {
  for (const field of section.fields) FIELD_INDEX.set(`${section.id}.${field.key}`, { section, field });
}

/** The section/field pair a key belongs to, or null. Keys are unique globally. */
export function hudThemeField(key) {
  for (const entry of FIELD_INDEX.values()) if (entry.field.key === key) return entry;
  return null;
}

/**
 * Which block of the theme a field lives in: 'shared', or one value per device.
 * Section-level by default, overridable per field (see the note above).
 */
export function hudFieldScope(section, field) {
  return field.scope === 'shared' ? 'shared' : section.scope;
}

const isShared = (section, field) => hudFieldScope(section, field) === 'shared';

const isFinitely = (value) => Number.isFinite(+value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const quantize = (value, step) => (step > 0 ? Math.round(value / step) * step : value);

/**
 * A number snapped to its field's range and step, then rounded to five decimals
 * so 0.1 steps do not serialize as 0.30000000000000004 — the same rounding the
 * editor's project files use, for the same reason (a stable signature).
 */
function normalizeRange(field, value, fallback) {
  const amount = isFinitely(value) ? +value : fallback;
  return Math.round(clamp(quantize(amount, field.step || 0), field.min, field.max) * 1e5) / 1e5;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const hex = value.trim().toLowerCase();
  if (!HEX.test(hex)) return fallback;
  // Expand #abc so the emitted value and the <input type=color> agree; the
  // browser hands back six digits and a mismatch would look like a pending edit.
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

/**
 * Text is written with textContent, never innerHTML, so markup inside it is
 * inert by construction. Control characters are dropped (a newline inside a
 * one-line HUD label is a layout bug, not a style) and the length is bounded so
 * a published theme cannot push a paragraph through a label.
 */
function normalizeText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
}

function defaultFor(section, field, device) {
  return isShared(section, field) ? field.value : field[device];
}

/** One field's value, coerced into range. Never throws. */
export function normalizeHudValue(section, field, value, device = 'desktop') {
  const fallback = defaultFor(section, field, device);
  switch (field.type) {
    case 'range': return normalizeRange(field, value, fallback);
    case 'color': return normalizeColor(value, fallback);
    case 'role': return ROLE_CSS_BY_ID.has(value) ? value : fallback;
    case 'font': return FONT_STACK_BY_ID.has(value) ? value : fallback;
    case 'toggle': return typeof value === 'boolean' ? value : Boolean(fallback);
    case 'text': return normalizeText(value, fallback);
    default: return fallback;
  }
}

/**
 * Turns anything — a save from an older build, a hand-edited JSON, `null` — into
 * a complete theme with a `shared` block and one block per device. Unknown keys
 * are dropped rather than carried, so a renamed field cannot resurrect later.
 */
export function normalizeHudTheme(value) {
  const input = value && typeof value === 'object' ? value : {};
  const theme = { shared: {} };
  for (const device of HUD_DEVICE_IDS) theme[device] = {};
  for (const { section, field } of FIELD_INDEX.values()) {
    if (isShared(section, field)) {
      theme.shared[field.key] = normalizeHudValue(section, field, input.shared?.[field.key]);
      continue;
    }
    for (const device of HUD_DEVICE_IDS) {
      theme[device][field.key] = normalizeHudValue(section, field, input[device]?.[field.key], device);
    }
  }
  return theme;
}

/** The shipped theme: every default, i.e. exactly what styles.css already says. */
export function defaultHudTheme() {
  return normalizeHudTheme(null);
}

/** One field's value out of a normalized theme. */
export function hudThemeValue(theme, section, field, device) {
  const scope = isShared(section, field) ? 'shared' : device;
  const normalized = theme?.[scope]?.[field.key];
  return normalized === undefined ? defaultFor(section, field, device) : normalized;
}

function hexToRgb(hex) {
  const value = normalizeColor(hex, '#000000');
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

/** `rgba(r,g,b,a)` from a hex colour and an alpha — used for the derived tokens. */
export function rgbaFromHex(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.round(clamp(+alpha || 0, 0, 1) * 1000) / 1000})`;
}

function cssValue(section, field, value, { fontScale }) {
  switch (field.type) {
    case 'range': {
      const amount = field.scaled ? Math.round(value * fontScale * 100) / 100 : value;
      return `${amount}${field.unit ?? ''}`;
    }
    case 'color': return value;
    case 'role': return ROLE_CSS_BY_ID.get(value) || ROLE_CSS_BY_ID.get('paper');
    case 'font': return FONT_STACK_BY_ID.get(value) || FONT_STACK_BY_ID.get('signal');
    case 'toggle': return value ? field.on : field.off;
    default: return null;
  }
}

/**
 * The custom properties for one device profile: `{ '--hud-score-size': '46px' }`.
 *
 * `fontScale` is applied here rather than in CSS `calc()` because it has to
 * multiply ~30 sizes; doing it once on the way out keeps every declaration in
 * styles.css a plain `var(--x, fallback)` that reads like the value it is.
 *
 * Two tokens are derived rather than stored: `--green-soft` (the phosphor glow,
 * used by name across the stylesheet) and `--hud-pc-grid` (the terminal's
 * background grid), because both are one colour at one alpha and storing them
 * separately would let them contradict the palette.
 */
export function hudThemeVariables(theme, device = 'desktop') {
  const settings = normalizeHudTheme(theme);
  const profile = HUD_DEVICE_IDS.includes(device) ? device : 'desktop';
  const fontScale = settings[profile].fontScale ?? 1;
  const variables = {};
  for (const { section, field } of FIELD_INDEX.values()) {
    if (!field.css) continue;
    const value = hudThemeValue(settings, section, field, profile);
    const css = cssValue(section, field, value, { fontScale });
    if (css !== null) variables[field.css] = String(css);
  }
  variables['--green-soft'] = rgbaFromHex(settings.shared.colorGreen, settings.shared.glowAlpha);
  variables['--hud-pc-grid'] = rgbaFromHex(settings.shared.colorGreen, settings[profile].pcGridAlpha);
  return variables;
}

/** The text fields, resolved to `{ selector, all, text }` write instructions. */
export function hudThemeTexts(theme) {
  const settings = normalizeHudTheme(theme);
  const writes = [];
  for (const { section, field } of FIELD_INDEX.values()) {
    if (field.type !== 'text' || !field.target) continue;
    writes.push({
      selector: field.target,
      all: Boolean(field.all),
      text: hudThemeValue(settings, section, field, 'desktop'),
    });
  }
  return writes;
}

/**
 * Installs a theme on a live document: custom properties on <html> for the
 * profile in force, plus the text fields.
 *
 * Writing to `documentElement.style` rather than to a <style> element means the
 * properties win over :root in styles.css without any specificity games, and a
 * `removeProperty` puts the stylesheet's own value back — which is what makes
 * "reset" honest rather than "write the defaults again".
 */
export function applyHudTheme(theme, { root = null, device = null, view = typeof window === 'undefined' ? null : window } = {}) {
  const target = root || view?.document?.documentElement;
  if (!target) return null;
  const profile = device || detectHudDevice(view);
  const variables = hudThemeVariables(theme, profile);
  for (const [name, value] of Object.entries(variables)) target.style.setProperty(name, value);
  target.dataset.hudProfile = profile;
  // The gauge and minimap painters (js/ui.js) read their colours out of these
  // properties, and a 2D context cannot resolve a var() chain lazily the way a
  // declaration can — it has to sample them. This stamp is what lets it cache
  // that sample and re-read only when something actually changed, instead of
  // calling getComputedStyle on every frame.
  target.dataset.hudRevision = hudThemeSignature(theme);
  const doc = target.ownerDocument || view?.document;
  if (doc) {
    for (const write of hudThemeTexts(theme)) {
      const nodes = write.all ? doc.querySelectorAll(write.selector) : [doc.querySelector(write.selector)];
      for (const node of nodes) if (node) node.textContent = write.text;
    }
  }
  return { profile, variables };
}

/**
 * A stable id for one theme, so a published revision can be adopted exactly
 * once per client (see adoptDocumentHudTheme in js/game.js). FNV-1a over a
 * key-ordered serialization, matching `pictureSignature`.
 */
export function hudThemeSignature(theme) {
  const settings = normalizeHudTheme(theme);
  const parts = [];
  for (const { section, field } of FIELD_INDEX.values()) {
    if (isShared(section, field)) { parts.push(`shared.${field.key}=${settings.shared[field.key]}`); continue; }
    for (const device of HUD_DEVICE_IDS) parts.push(`${device}.${field.key}=${settings[device][field.key]}`);
  }
  const serialized = parts.join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// Publishing. The theme rides in the same document as the picture and the
// camera tuning (data/editor/custom-assets.json → runtimeTuning.hud), so an
// interface authored in the test game is deployed with the site instead of
// living in one browser's localStorage.
// ---------------------------------------------------------------------------

/** Undefined, not a default, when nothing was published: the caller must tell. */
export function hudThemeFromDocument(document) {
  const hud = document?.runtimeTuning?.hud;
  return hud ? normalizeHudTheme(hud) : null;
}

export function setDocumentHudTheme(document, theme) {
  if (!document.runtimeTuning || typeof document.runtimeTuning !== 'object') document.runtimeTuning = {};
  document.runtimeTuning.hud = normalizeHudTheme(theme);
  return document.runtimeTuning.hud;
}

/**
 * Structural errors in a published theme, as sentences. Used by the document
 * validator (js/custom-assets.js) so a malformed interface is refused on the way
 * in rather than clamped silently on the way out to every visitor.
 */
export function hudThemeDocumentErrors(hud) {
  const errors = [];
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(hud)) return ['runtimeTuning.hud must be an object'];
  for (const scope of ['shared', ...HUD_DEVICE_IDS]) {
    if (hud[scope] !== undefined && !isRecord(hud[scope])) errors.push(`runtimeTuning.hud.${scope} must be an object`);
  }
  for (const key of Object.keys(hud)) {
    if (!['shared', ...HUD_DEVICE_IDS].includes(key)) errors.push(`runtimeTuning.hud.${key} is unknown`);
  }
  for (const { section, field } of FIELD_INDEX.values()) {
    const scopes = isShared(section, field) ? ['shared'] : HUD_DEVICE_IDS;
    for (const scope of scopes) {
      const value = hud[scope]?.[field.key];
      if (value === undefined) continue;
      const device = scope === 'shared' ? 'desktop' : scope;
      const normalized = normalizeHudValue(section, field, value, device);
      if (field.type === 'range' && (!Number.isFinite(value) || value < field.min || value > field.max)) {
        errors.push(`runtimeTuning.hud.${scope}.${field.key} must be a number between ${field.min} and ${field.max}`);
      } else if (field.type !== 'range' && normalized !== value) {
        errors.push(`runtimeTuning.hud.${scope}.${field.key} is not a valid ${field.type} value`);
      }
    }
  }
  for (const scope of ['shared', ...HUD_DEVICE_IDS]) {
    for (const key of Object.keys(hud[scope] || {})) {
      const entry = hudThemeField(key);
      const owns = entry && (isShared(entry.section, entry.field) ? scope === 'shared' : scope !== 'shared');
      if (!owns) errors.push(`runtimeTuning.hud.${scope}.${key} is unknown`);
    }
  }
  return errors;
}
