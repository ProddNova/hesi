# HUD EDITOR STATUS — 29 Jul 2026

A third dev panel, on **key 8**, that edits the interface: the palette, the two
font families, every size / position / visibility of the driving HUD, the in-game
keitai, the WANGAN MARKET terminal, the loading screen and the boot menu — with
**a separate set of values for PC and for phone**.

- New: `js/hud-theme.js` (the model), `js/hud-editor.js` (the panel).
- Changed: `styles.css` (every editable declaration now reads a custom property),
  `js/ui.js` (the canvas dials and minimap sample their colours from the theme),
  `js/game.js` (state, hotkey, apply/persist/publish/adopt), `index.html`,
  `js/custom-assets.js` + `tools/hesi-editor/server.mjs` (document validation),
  `sw.js` (precache).

Tests: `node --test .devtests/hud-theme.test.mjs` — **31/31**.
Browser: `node .devtests/hud-editor-probe.mjs` — **all checks passed, 0 page
errors** (see *Evidence*).
Regression: `npm run editor:test` — 161/162, the one failure
(`car-models.test.mjs` "traffic configured lights stay unlit…") fails identically
on `main` and is unrelated to this work.

---

## 1. What it edits

Eight sections, ~130 fields. `PALETTE`, `CARICAMENTO` and `SCHERMATA INIZIALE`
are shared; `FONT & TESTO`, `HUD GUIDA`, `QUADRANTI & GPS`, `TELEFONO IN GIOCO`
and `TERMINALE PC` carry one value per device profile.

| Section | Examples |
| --- | --- |
| PALETTE | the ten palette colours plus the strength of the phosphor glow token |
| FONT & TESTO | the terminal and title families (7 stacks), a text scale, glow and hard-shadow strength |
| HUD GUIDA | per-corner nudge and scale, opacity, 17 visibility switches, ~20 sizes, 11 colour roles, 3 label texts |
| QUADRANTI & GPS | the five colours the dials are painted with and the six the minimap uses — hex rather than roles, because a canvas cannot resolve `var()` |
| TELEFONO IN GIOCO | width, height, shell scale, corner radius, the three LCD gradient stops, three ink colours, LCD scanlines, four type sizes, icon size, app-grid columns, soft-key row |
| TERMINALE PC | window margin, header height, accent role, four type sizes, card width, scanlines, background grid colour + pitch |
| CARICAMENTO | title and subtitle **text**, background, title size/colour, jitter on/off, ring size/colour/speed, bar size/colour, both on/off |
| SCHERMATA INIZIALE | logo / menu / kanji scales, logo colours, five decoration switches, the ticker text |

Plus, on the panel itself: four presets (`ORIGINALE`, `GRANDE`, `MINIMALE`,
`SENZA HUD`), per-section reset, reset-all, **copy one profile onto the other**,
a filter box, and JSON export/import.

## 2. How it works

Everything is a **CSS custom property on `<html>`**. `js/hud-theme.js` holds the
tables (label, type, range, unit, default per profile, the property name) and
`applyHudTheme()` writes them; `styles.css` reads them as
`font-size:var(--hud-score-size,46px)`.

Three properties of that design are the reason it was done this way:

- **A default theme changes nothing.** Every default equals the fallback already
  written in `styles.css`, so an untouched browser renders the authored look and
  a stylesheet that loads before the module does not flash. This is not a claim
  in a comment: `.devtests/hud-theme.test.mjs` parses `styles.css`, walks each
  `var(--x, …)` to its matching parenthesis, and fails if any default and its
  fallback disagree — plus it fails on a property the editor writes that the
  stylesheet never reads, and on a fallback with no default behind it. It also
  fails when a property with a single fallback has two different profile
  defaults, which is how the one real bug in this change was found: the cluster
  scale is a **multiplier** (`scale(calc(.62 * var(…)))`) and its phone default
  was still the absolute `.62`, so a phone would have rendered the cluster at
  .62 × .62. Fixed, and the test was checked by putting the bug back.
- **Colours are palette *roles*, not hex per element.** `scoreRole: 'paper'`
  emits `var(--paper)`. A colour picker per element would freeze each one at the
  hex it had when it was first touched, and recolouring the palette would then
  move only the things nobody had customised.
- **Positions are nudges, scales are multipliers.** `--hud-tl-y` defaults to
  `0px` and `--hud-cluster-scale` to `1`, added to / multiplied with the authored
  `2.2vw` and `scale(.62)`. The compact HUD has four layout variants (touch,
  touch-portrait, touch-landscape, desktop); an absolute value would have had to
  pick one and would have changed the other three.

### PC and phone are two profiles

`HUD_DEVICE_QUERY` is `(pointer:coarse), (max-width:700px)` — deliberately the
**same** query that switches the compact HUD on in `styles.css`, and not
`detectHandheld()` from `js/device-profile.js`. Those answer different questions:
`detectHandheld` answers "how fast is this machine" (it exists so a touchscreen
laptop does not get the phone render profile), while this answers "which layout
rules is the browser applying right now". Keying the theme off the render profile
would let a 600px desktop window get the compact *layout* with the desktop
*numbers*. The query is watched with `matchMedia().addEventListener('change')`,
so rotating a tablet or dragging a window across 700px re-applies without a
reload.

Only the live profile is written to the document. **While the panel is open, the
profile being edited is the one applied** — otherwise authoring the phone HUD on
a PC would mean dragging sliders with no picture — and closing it puts the real
one back. What preview deliberately does *not* do is move the compact-HUD rules
themselves: those live in a media query, and forcing them would mean maintaining
a second copy of every one as a class selector. The panel says exactly this in
its own note rather than letting the author guess.

### Where a theme lives

1. **The runtime save** (`admin.hudTheme` in `shutoko-nights.runtime.v2`), so it
   is the player's and survives a reload. Normalized on load, applied in
   `setupPersistence()` — early, because the loading screen is on screen at that
   moment and the theme owns it.
2. **`data/editor/custom-assets.json` → `runtimeTuning.hud`**, published from the
   editor test game (`?editorTest`) exactly like `runtimeTuning.picture`, so an
   interface authored while driving is deployed with the site instead of living
   in one browser. `adoptDocumentHudTheme()` takes a published revision **once**,
   keyed on an FNV-1a signature: adopting on every boot would stop the panel from
   holding a value across a reload, and adopting never would make publishing
   pointless.
3. **JSON text**, copied out of the panel and pasted into another browser. Import
   goes through the same normalizer, so hand-edited JSON can only produce values
   the panel could also have produced.

### Reaching it without a keyboard

The device whose HUD most needs editing is the one with no `8` key, so the panel
is also a button in the debug menu (`0` → *EDITOR HUD*), which on touch is itself
reachable from the on-screen `DBG` button. The probe opens it that way on a Pixel
5 context and checks the panel fits the screen.

## 3. Validation

`runtimeTuning.hud` reaches every visitor, so a malformed theme is **named**
rather than clamped in silence: `hudThemeDocumentErrors()` reports out-of-range
numbers, invalid roles/fonts/colours, unknown fields, and a device field written
into the shared block. `js/custom-assets.js` calls it on fetch; the dependency-
free server (`tools/hesi-editor/server.mjs`) keeps the shape gate on the way in.

Text fields are written with `textContent`, never `innerHTML`, control characters
are stripped and length is capped at 200, so a published theme cannot inject
markup or push a paragraph through a HUD label.

## 4. One deliberate addition to styles.css

The M PLUS Rounded 1c subsets have been in `fonts/` since the type pass but were
never declared in CSS. They are now declared as **"Shutoko Rounded"** so the
editor can offer a second family. The name is new on purpose: `js/ui.js` draws
the gauge faces with a canvas `font` of `"RoundedTit","Rounded"`, which has
always fallen back to `sans-serif`. Declaring the faces as `"Rounded"` would have
silently changed the dials — a real bug, but not this change's to make. Nothing
selects the family by default, so the files are not fetched unless a theme asks.

## 5. Evidence

`node --test .devtests/hud-theme.test.mjs` — 31/31. Beyond the CSS-contract
tests: junk input (`null`, `0`, `'nope'`, `[]`, `{desktop: 7}`) always yields a
complete in-range theme; out-of-range numbers clamp and snap to their step;
unknown roles/fonts/colours fall back instead of leaking into a property;
`#F0A` expands to `#ff00aa`; the emitted values contain no `!important`, so the
game's own `.hidden` still wins; signatures are stable and order-independent;
presets are checked to patch only fields that exist, in the scope that owns them.

`node .devtests/hud-editor-probe.mjs` — a real Chromium, 1280×720 and a Pixel 5
context, **94 checks, all passed, 0 page errors**:

- an untouched game computes the shipped values (score 46px on
  `rgb(226,232,221)`, minimap 220px, tachometer 118px, cluster `matrix(1,0,0,1)`,
  loading title `SHUTOKO NIGHTS` 46px amber, ring 58px, bar 250px, phone 336px
  with a 34px radius, terminal header 84px, `--green: #5cff8a`,
  `--green-soft: rgba(92,255,138,0.55)`)
- `8` opens a panel with 8 sections, >110 controls and both device tabs, and
  freezes the drive like the other two panels
- a slider, a role, a palette colour, a toggle, a text field, a font select, a
  nudge and a scale all reach the computed styles (score 96px × 1.5 text scale =
  144px; bank follows `--green` to `rgb(255,79,216)`; the glow token follows it
  to `rgba(255,79,216,0.55)`; the terminal body height follows its header)
- the two canvas instruments repaint with the theme: with the minimap background
  set to `#ff00ff` its corner pixel reads `#ff00ff`, and a dial face set to
  `#123456` paints thousands of pixels of it
- a full reload keeps all of it
- switching the panel to TELEFONO previews the phone numbers (30px score) while
  the desktop layout rules stay in force, edits apply there, and closing the
  panel restores both the profile and the PC numbers
- a Pixel 5 context takes the phone profile on its own: 30px score, no minimap,
  FPS readout visible, and the cluster at `matrix(0.5,…)` — that context is
  portrait, whose variant has always scaled to .5 while the base touch rule
  scales to .62 and landscape to .54. All three are untouched, which is what the
  multiplier design buys; the panel opens from the debug menu with no keyboard
  and fits the screen
- `RIPRISTINA TUTTO` returns **every** measured value to the line-1 numbers

Screenshots: `.devtests/shots/hud-editor-01…09-*.png` (default HUD, panel,
restyled HUD, boot after reload, phone-profile preview, reset, phone default,
phone panel, phone keitai).

## 6. Truthful limitations

- **Preview cannot move the compact-HUD layout.** Editing the phone profile from
  a PC shows its colours and type sizes, not its positions; those come from the
  media query. Authoring positions for the phone still wants a phone (or a narrow
  window, which switches the profile for real).
- **The canvas instruments follow the theme but not the palette.** The dials and
  the minimap are painted by `js/ui.js`, which samples eleven hex colours out of
  the same custom properties (cached against the theme's revision stamp, so it is
  one `getComputedStyle` per change rather than one per frame). They are hex and
  not palette roles because a 2D context cannot resolve a `var()` chain:
  recolouring the palette moves everything CSS draws, but the dials and the GPS
  have to be recoloured on their own page of the panel.
- **Decorative glows are still authored per element.** Colours reach everything
  that goes through the palette or a role, but a hand-written
  `rgba(255,176,46,.6)` inside a specific `box-shadow` stays what it is. The
  `FORZA ALONE` / `FORZA OMBRA` dials scale those blurs and offsets on the main
  HUD, loading and boot type; they do not repaint them.
- **The boot ticker is one string.** It is written into both copies of the marquee
  span (the duplicate is what makes the loop seamless), so the two cannot differ.
- **Three sizes are desktop-only by construction**: the phone shell's height and
  the terminal's window margin have no effect in the touch layout, where both are
  screen-sized. The fields say so in their notes.
- **The theme is not part of `SaveSystem`'s versioned schema.** It rides in the
  runtime save's `admin` block, like the picture dials, and an unknown field in
  it is dropped on load rather than migrated.
