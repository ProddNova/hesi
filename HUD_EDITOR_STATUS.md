# HUD EDITOR STATUS — 29 Jul 2026

The interface editor is a **tool**, not a game panel: `npm run editor` → **HUD**.
You get the game's real HUD in two live device frames — PC and phone — click a
piece of it, drag it where you want it, pull a corner to resize it. What comes out
is `runtimeTuning.hud` in `data/editor/custom-assets.json`, and the playable build
does nothing but apply it.

- New in the tool: `tools/hesi-editor/src/hud/{hud-panel,hud-preview,hud-vocabulary}.js`,
  panel styling in `tools/hesi-editor/styles.css`, a toolbar button, and
  `CustomAssetStore.hudTheme()/setHudTheme()`.
- New in the game: `js/hud-instruments.js` — the dial and minimap painters, moved
  out of `js/ui.js` so the editor can preview the real instruments.
- **Removed from the game**: `js/hud-editor.js` (the old ~500-line panel), its
  `#hud-editor` markup, its ~40 CSS rules, the key-`8` binding, the debug-menu
  button, the per-player theme in the save file, and the publish/adopt/preset/
  import machinery in `js/game.js`. What is left there is ~30 lines that apply a
  published theme.

Tests: `node --test .devtests/hud-theme.test.mjs` — **29/29** (the game's side);
`node --test tools/hesi-editor/test/unit/hud-editor.test.mjs` — **28/28** (the
editor's side); `npm run editor:test` — **189/190**, the one failure
(`car-models.test.mjs`, traffic lights) fails identically on `main`.
Browser: `node .devtests/hud-tool-probe.mjs` — **47 checks, all passed, 0 page
errors** (see *Evidence*).

---

## 1. What the game still carries

| Piece | Why it has to be in the game |
| --- | --- |
| `js/hud-theme.js` | the field table with its ranges and defaults, and `applyHudTheme()`, which turns a published theme into CSS custom properties on `<html>` |
| `js/hud-instruments.js` | the dials and the GPS are canvas; they sample eleven colours out of those properties |
| `var(--hud-…)` in `styles.css` | the declarations a theme reaches. Free when nothing is published: every fallback is the value the stylesheet had before |
| ~30 lines in `js/game.js` | read `runtimeTuning.hud` from the document, apply it, re-apply when the device media query flips |

There is deliberately **no per-player theme and no adopt-once revision** any more.
With nothing in the game able to change the interface, "what the document says" is
the whole truth, so it is read on every boot: simpler, and one less block in the
save file. `admin.hudTheme` and `state.hudThemeRevision` are gone.

## 2. What the editor does

Open it and you get the driving HUD in two frames. Every grabbable piece is a
**widget** (23 of them across five screens) that declares what a pointer does to
it — see the table in `hud-vocabulary.js`:

| Screen | Widgets |
| --- | --- |
| Guida | score block, bank, GPS + zone, dial cluster, toasts, action prompt, near-miss splash, FPS readout |
| Telefono | shell, LCD, app grid |
| Terminale | window, header, section title |
| Caricamento | title, ring, bar, subtitle |
| Avvio | logo, menu, kanji, ticker, backdrop |

- **Drag** moves it. The gesture writes named nudge fields (`--hud-tl-y` and
  friends), never absolute coordinates, so the authored `2.2vw` anchor and the
  four responsive layout variants under it stay exactly as they are — a theme at
  zero is the shipped game, and every drag is reversible by construction.
- **Corner handles** resize it, in whichever way that element can be resized:
  a *scale* multiplier (the HUD corners, the boot logo — their authored size is
  responsive and must stay so), real *pixels* (the phone shell, the loading bar:
  they are boxes and behave like boxes), a *type size* (the prompt, the splash,
  the loading title), or the terminal's inverted *window margin*.
- **Keyboard**: arrows nudge 2px (10 with Shift), `V` hides, `R` restores that
  widget, `Ctrl+Z` undoes, `Esc` closes. Shift while dragging damps to a quarter.
- **The inspector** is for what a pointer cannot say: colours, palette roles, font
  families, text strings, on/off switches — the selected widget's own fields
  first, then every section (palette, type, HUD, dials/GPS, phone, terminal,
  loading, boot: ~140 fields), presets, per-section reset, profile copy, JSON in
  and out.
- **Save** writes the document through the same store the Modeler and Surfaces
  use, and broadcasts the car channel, so a test game that is already open
  restyles itself without a reload.

### The preview is an iframe, and that is the point

The compact HUD is not a set of variables, it is a media query
(`(pointer:coarse), (max-width:700px)`), and a media query answers to the
viewport. An iframe has its own viewport: at 393×851 the phone rules *genuinely*
apply — the minimap really is gone, the cluster really is at `.62`, the touch
buttons really are there. The previous in-game panel could only show the desktop
layout wearing phone numbers, and had to say so in a footnote; this shows the
phone.

The frame is built from the real `/index.html` and the real `/styles.css`, fetched
when the panel opens — not from a copy. Three things are added: sample content (an
empty HUD cannot be laid out), a paused frame (the toast, prompt and near-miss
animations exist to remove themselves from the screen), and a night-road backdrop
so contrast is judged against something like the real thing. The dials and the
minimap are painted by the game's own `js/hud-instruments.js`.

### Which profile you are editing

Whichever frame you touched. Drag in the phone frame and the phone profile moves;
the PC frame does not. No mode to forget about, and no preview that lies about
which layout it is showing.

## 3. Validation

`runtimeTuning.hud` reaches every visitor, so a malformed theme is **named** rather
than clamped in silence: `hudThemeDocumentErrors()` reports out-of-range numbers,
invalid roles/fonts/colours, unknown fields, and a device field written into the
shared block. `js/custom-assets.js` runs it on fetch; the dependency-free dev
server keeps a shape gate on the way in. Text fields are written with
`textContent`, never `innerHTML`, control characters are stripped and the length is
capped at 200.

## 4. The contract that keeps the default look

Every default in `js/hud-theme.js` equals the fallback `styles.css` already
carries, so an untouched build renders the authored 2002 look and a stylesheet
that loads before the module does not flash. `.devtests/hud-theme.test.mjs` parses
the stylesheet, walks each `var(--x, …)` to its matching parenthesis and fails if
a default and its fallback disagree, if a property nothing reads is written, or if
a property with a single fallback has two different profile defaults. It also
fails if the game grows an editor panel again.

## 5. Bugs this work found and fixed

- **The cluster multiplier.** `--hud-cluster-scale` is multiplied into
  `scale(calc(.62 * var(…)))`, and its phone default was still the absolute `.62`,
  which would have drawn every phone's cluster at .62 × .62. Caught by the
  one-fallback-one-default test, which was then checked by putting the bug back.
- **The resize signs.** The first version keyed the handle direction off the
  element's `transform-origin`, which got the phone shell backwards: anchored
  bottom-right, so pulling its top-left corner further left made it *narrower*.
  Which way the pointer travels to grow a thing is only ever "away from its
  middle"; where it grows *from* is the stylesheet's business. A unit test pins
  all four corners of both anchorings.
- **Handles outside the frame.** `.hud-br` is wider than a phone screen, so the
  cluster's marquee — and its resize handles — landed outside the 393px frame,
  where the stage clips them and a click hits the panel behind. Rects are now
  clamped to the frame, and a widget can name a child to measure instead (the
  cluster measures `.cluster`, whose transform makes it the box you actually see).
- **The FPS readout could not be shown on a PC.** Its looks and position lived
  inside the touch media query, so a theme that switched it on for the desktop
  profile got an unpositioned block in the HUD flow. Hoisted into the base rule;
  the media query now only says "on by default here".

## 6. Evidence

`node .devtests/hud-tool-probe.mjs` — **47 checks, 0 page errors.** It boots the
editor's own dev server on a test port, drives the panel with a real mouse and
keyboard, saves for real (restoring `custom-assets.json` afterwards), and then
**boots the game twice** — a 1280×720 client and a Pixel 5 — to measure what the
save produced:

- the panel builds from the game's markup (`128'450` comes out of index.html) and
  the phone frame is genuinely compact (`matrix(0.62,…)`, no minimap, touch
  controls visible) while the PC frame is not
- clicking the score block selects it; dragging it 60×40 overlay pixels writes
  `tlX`/`tlY` in *preview* pixels, the property lands on the frame's root, and the
  element moves — with the phone profile untouched
- pulling the cluster's corner handle in the phone frame multiplies
  `clusterScale`, and the frame's computed transform is `.62 ×` that
- arrows nudge 2px each, `V` hides the bank in the preview, `R` restores only that
  widget, `Ctrl+Z` puts the nudge back
- the loading screen previews on its own (`#hud` display:none), and its title text
  and size reach the frame
- Save writes `runtimeTuning.hud` to disk with both scopes intact
- the **game** then renders it: the published nudge as `matrix(1,0,0,1,…)` on
  `.hud-tl`, the published palette as `--green` with the bank following it, its own
  profile chosen, and **no editor panel in the document**
- the Pixel 5 client takes the phone profile, carries the authored cluster
  multiplier through the portrait rule (`.5 ×`), and does not inherit the PC nudge

Screenshots: `.devtests/shots/hud-tool-01…05-*.png`.

## 7. Truthful limitations

- **The editor needs the dev server.** It is a tool in `tools/hesi-editor`, so
  authoring happens locally and the result is deployed as data. There is no way to
  restyle a HUD from a phone in the field any more — that was the old panel's one
  advantage, and it cost the playable build an editor.
- **Two device profiles, four layout variants.** The stylesheet has separate rules
  for touch-portrait and touch-landscape; the theme has PC and phone. Because
  positions are nudges and scales are multipliers, the other two orientations
  follow correctly, but they cannot be tuned independently.
- **The preview is a still frame.** It is the real markup and the real stylesheet,
  not a running game: no traffic, no speed changing, the animated states pinned
  open. A theme that depends on motion still has to be seen in `Test Game`.
- **`.market-title` is sample markup.** The terminal's market page is rendered by
  `js/ui.js` at runtime, so the preview supplies a representative sample of it.
  The widget table marks those widgets `injected`, and the unit test checks their
  selectors against the sample rather than pretending index.html contains them.
- **Decorative glows scale but do not repaint.** Colours reach everything that
  goes through the palette, a role or the instrument colours; a hand-written
  `rgba(255,176,46,.6)` inside one specific `box-shadow` stays what it is. The
  glow/shadow dials scale those blurs and offsets.
