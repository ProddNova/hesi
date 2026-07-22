import {
  WORLD_SURFACES, WORLD_SURFACE_TILE_METERS, isDefaultWorldSurfaceStyle, textureSourceUrl,
} from '/js/custom-assets.js';

const TILE_PRESETS = [3, 6, 12, 24, 48];

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

const PREVIEW_SIZE = 168;

/**
 * Draws a live thumbnail of what a surface style does to its image: the
 * picture tiled at the chosen repeat, rotated, shifted, and multiplied by the
 * tint and brightness — the same maths the material ends up with, so the card
 * tells you whether the seams line up before you go looking in the world.
 */
export function paintSurfacePreview(canvas, style, image, { checker = true, generated = null } = {}) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const size = canvas.width;
  context.clearRect(0, 0, size, size);
  if (!image && generated) {
    // No override image. A tint here REPLACES the surface colour (that is what
    // applyWorldTextureOverrides does), so paint it flat rather than
    // multiplying it over the generated look.
    if (style.tint.toLowerCase() !== '#ffffff') {
      context.fillStyle = style.tint;
      context.fillRect(0, 0, size, size);
    } else {
      if (generated.color) {
        context.fillStyle = generated.color;
        context.fillRect(0, 0, size, size);
      }
      if (generated.image?.width) {
        try { context.drawImage(generated.image, 0, 0, size, size); } catch { /* tainted or unready canvas */ }
      }
    }
    if (style.brightness !== 1) {
      context.save();
      context.globalCompositeOperation = style.brightness < 1 ? 'multiply' : 'lighter';
      context.globalAlpha = style.brightness < 1 ? style.brightness : Math.min(1, style.brightness - 1);
      context.fillStyle = style.brightness < 1 ? '#ffffff' : style.tint;
      context.fillRect(0, 0, size, size);
      context.restore();
    }
    return;
  }
  if (checker) {
    // Checkerboard under the image so transparent pixels stay visible.
    context.fillStyle = '#161b22';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#1d232c';
    for (let y = 0; y < size; y += 8) {
      for (let x = (y / 8) % 2 ? 8 : 0; x < size; x += 16) context.fillRect(x, y, 8, 8);
    }
  }
  if (image?.width) {
    const imageAspect = image.width / Math.max(1, image.height);
    let repeatX = Math.min(16, Math.max(0.05, style.repeat[0]));
    let repeatY = Math.min(16, Math.max(0.05, style.repeat[1]));
    if (style.fit === 'stretch') {
      repeatX = 1;
      repeatY = 1;
    } else if (style.fit === 'cover') {
      // Same maths as faceTextureTransform: the image keeps its proportions in
      // a surface of `aspect`, and the overflow falls outside the canvas.
      repeatX = 1;
      repeatY = 1;
      if (imageAspect > style.aspect) repeatX = style.aspect / imageAspect;
      else if (imageAspect < style.aspect) repeatY = imageAspect / style.aspect;
    }
    context.save();
    context.beginPath();
    context.rect(0, 0, size, size);
    context.clip();
    context.translate(size / 2, size / 2);
    if (style.rotation) context.rotate(style.rotation * Math.PI / 180);
    // Rotation can expose the corners: draw a padded field so it stays covered.
    const span = size * 1.5;
    const tileW = (size / repeatX) * (style.flipX ? -1 : 1);
    const tileH = (size / repeatY) * (style.flipY ? -1 : 1);
    context.translate(-style.offset[0] * size / repeatX, -style.offset[1] * size / repeatY);
    for (let y = -span; y < span; y += Math.abs(tileH)) {
      for (let x = -span; x < span; x += Math.abs(tileW)) {
        context.save();
        context.translate(x + (tileW < 0 ? Math.abs(tileW) : 0), y + (tileH < 0 ? Math.abs(tileH) : 0));
        context.scale(Math.sign(tileW) || 1, Math.sign(tileH) || 1);
        context.drawImage(image, 0, 0, Math.abs(tileW), Math.abs(tileH));
        context.restore();
      }
    }
    context.restore();
  }
  const tinted = style.tint.toLowerCase() !== '#ffffff' || style.brightness !== 1;
  if (tinted) {
    context.save();
    context.globalCompositeOperation = image?.width ? 'multiply' : 'source-over';
    context.globalAlpha = image?.width ? Math.min(1, style.brightness) : 1;
    context.fillStyle = style.tint;
    context.fillRect(0, 0, size, size);
    context.restore();
  }
  if (!image?.width && !tinted) {
    context.fillStyle = 'rgba(150,166,186,.55)';
    context.font = '11px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('generated look', size / 2, size / 2);
  }
}

/**
 * What the map generator currently draws for a material: its own texture (a
 * generated canvas, for the lit facades) and its base colour. Used as the
 * preview backdrop wherever the user has not supplied an image.
 */
export function generatedLook(material) {
  if (!material) return null;
  const original = material.userData?.hesiGeneratedLook;
  const map = original ? original.map : material.map;
  const color = original?.color || (material.color?.getHexString ? `#${material.color.getHexString()}` : null);
  return { image: map?.image || null, color };
}

/** Loads a texture record's image once, caching by source url. */
const imageCache = new Map();
export function surfaceImage(record, onReady) {
  const source = textureSourceUrl(record);
  if (!source) return null;
  const cached = imageCache.get(source);
  if (cached) {
    if (!cached.complete) cached.addEventListener('load', onReady, { once: true });
    return cached.complete && cached.naturalWidth ? cached : null;
  }
  const image = new Image();
  image.addEventListener('load', onReady, { once: true });
  image.src = source;
  imageCache.set(source, image);
  return null;
}

/**
 * The paint controls of one generated-map surface: image, tiling, offset,
 * rotation, flips, tint and brightness. Shared by the Surfaces editor and the
 * Modeler's world-object browser so both places behave identically.
 *
 * Every change writes straight through the store and calls `onChange`, which
 * re-applies the whole override set to the live map — so the world updates
 * while the slider is still moving.
 */
export class SurfaceStyleEditor {
  constructor({ host, store, onChange = () => {}, onStatus = () => {}, pickTexture = null, onEditImage = null, getMaterial = () => null }) {
    Object.assign(this, { host, store, onChange, onStatus, pickTexture, onEditImage, getMaterial });
    this.slot = null;
  }

  setSlot(slot) {
    this.slot = slot;
    // Tiles start linked (square) and stay however the user left them for the
    // surface they are working on.
    const style = this.store.worldSurface(slot);
    this.tileLinked = Math.abs(style.repeat[0] - style.repeat[1]) < 1e-6;
    this.render();
  }

  refresh() { if (this.slot) this.render(); }

  _style() { return this.store.worldSurface(this.slot); }

  _patch(patch, statusText = '') {
    this.store.setWorldSurface(this.slot, patch);
    this._syncPreview();
    this._syncResetState();
    this.onChange(this.slot);
    if (statusText) this.onStatus(statusText);
  }

  _syncPreview() {
    if (!this.previewCanvas) return;
    const style = this._style();
    const record = style.texture ? this.store.getTexture(style.texture) : null;
    const image = record ? surfaceImage(record, () => this._syncPreview()) : null;
    paintSurfacePreview(this.previewCanvas, style, image, { generated: generatedLook(this.getMaterial(this.slot)) });
    if (this.imageNameNode) this.imageNameNode.textContent = record ? (record.name || style.texture) : 'No image · generated look';
  }

  _syncResetState() {
    if (!this.resetButton) return;
    const overridden = !isDefaultWorldSurfaceStyle(this._style());
    this.resetButton.disabled = !overridden;
    if (this.stateChip) {
      this.stateChip.textContent = overridden ? 'Custom' : 'Generated';
      this.stateChip.classList.toggle('is-custom', overridden);
    }
  }

  render() {
    this.host.innerHTML = '';
    const meta = WORLD_SURFACES[this.slot];
    if (!meta) {
      this.host.append(element('p', 'modeler-help', 'Pick a surface on the left to repaint it.'));
      return;
    }
    const style = this._style();

    const head = element('div', 'surface-head');
    head.append(element('b', '', meta.label));
    this.stateChip = element('span', 'surface-state-chip', '');
    head.append(this.stateChip);
    this.host.append(head);
    this.host.append(element('p', 'modeler-help', `${meta.description}. One material, one archetype: this repaints every ${meta.label.toLowerCase()} in the world at once.`));

    // --------------------------------------------------------------- preview --
    const previewWrap = element('div', 'surface-preview-wrap');
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = PREVIEW_SIZE;
    this.previewCanvas.height = PREVIEW_SIZE;
    this.previewCanvas.className = 'surface-preview';
    this.previewCanvas.dataset.testid = 'surface-preview';
    previewWrap.append(this.previewCanvas);
    const previewInfo = element('div', 'surface-preview-info');
    this.imageNameNode = element('small', 'surface-image-name', '');
    previewInfo.append(this.imageNameNode);
    if (!meta.tintOnly) {
      const imageRow = element('div', 'surface-button-row');
      const set = button(style.texture ? 'Replace image…' : 'Set image…', 'tool-button small accent', 'Choose an image from the library or upload a new one');
      set.dataset.testid = 'surface-set-image';
      set.addEventListener('click', () => this.pickTexture?.(`Image for ${meta.label}`, (textureId) => {
        this._patch({ texture: textureId }, `${meta.label} repainted · every one in the world updated`);
        this.render();
      }));
      imageRow.append(set);
      if (style.texture) {
        const edit = button('✎', 'tool-button small', 'Crop or erase this image');
        edit.addEventListener('click', () => this.onEditImage?.(style.texture));
        const clear = button('Clear', 'tool-button small danger', 'Back to the generated image/colour');
        clear.addEventListener('click', () => {
          this._patch({ texture: null }, `${meta.label} image removed`);
          this.render();
        });
        imageRow.append(edit, clear);
      }
      previewInfo.append(imageRow);
    } else {
      previewInfo.append(element('small', 'modeler-help', 'This surface reads as light, not as material — colour is the control that matters here.'));
    }
    previewWrap.append(previewInfo);
    this.host.append(previewWrap);

    // ------------------------------------------------------------ image fit --
    if (!meta.tintOnly) {
      // World-anchored asphalt runs unbounded across the map, so "one image
      // over the whole surface" has no meaning there — those slots only tile.
      const fit = meta.worldTiled ? 'tile' : style.fit;
      if (!meta.worldTiled) {
        this.host.append(element('h4', 'surface-group-title', 'Image fit'));
        const fitRow = element('label', 'modeler-field');
        const fitSelect = document.createElement('select');
        fitSelect.dataset.testid = 'surface-fit';
        fitSelect.setAttribute('aria-label', 'Image fit');
        fitSelect.add(new Option('Tile', 'tile'));
        fitSelect.add(new Option('Stretch', 'stretch'));
        fitSelect.add(new Option('Fit & crop', 'cover'));
        fitSelect.value = fit;
        fitSelect.title = 'Tile: the picture repeats, and the tile shape is yours to set. '
          + 'Stretch: one copy pulled over the whole surface, squeezed to its shape. '
          + "Fit & crop: one copy keeping the image's own proportions, with the overflow cut off.";
        fitSelect.addEventListener('change', () => {
          this._patch({ fit: fitSelect.value });
          this.render();
        });
        fitRow.append(element('span', '', 'Image fit'), fitSelect);
        this.host.append(fitRow);
        this.host.append(element('p', 'modeler-help', {
          tile: 'The picture repeats over the surface. Set the tile shape below — a tile does not have to be square.',
          stretch: 'One copy covers the whole surface, squeezed to whatever shape that surface is.',
          cover: "One copy covers the whole surface with the image's own proportions kept; whatever does not fit is cropped away. Set the surface shape below so the crop matches reality.",
        }[fit]));
      }

      // ------------------------------------------------------------- tiling --
      if (fit === 'tile') {
        this.host.append(element('h4', 'surface-group-title', 'Tile shape'));
        if (meta.worldTiled) {
          // Two independent metre fields: a tile may be a rectangle (finer
          // across the lanes than along them, say), not only a square.
          const metresOf = (axis) => Number((WORLD_SURFACE_TILE_METERS / (style.repeat[axis] || 1)).toFixed(2));
          const fields = [];
          const setMetres = (axis, value) => {
            if (!(value > 0)) return;
            const repeat = WORLD_SURFACE_TILE_METERS / value;
            const next = [...this._style().repeat];
            if (this.tileLinked) {
              next[0] = repeat;
              next[1] = repeat;
              // Keep the partner field in step in place: re-rendering here
              // would tear out the input being typed into.
              const partner = fields[axis === 0 ? 1 : 0];
              if (partner) partner.value = String(value);
            } else next[axis] = repeat;
            this._patch({ repeat: next });
          };
          for (const [axis, label, title] of [
            [0, 'Tile size X (m)', 'Metres of world covered by one tile along the world X axis'],
            [1, 'Tile size Z (m)', 'Metres of world covered by one tile along the world Z axis'],
          ]) {
            const row = element('label', 'modeler-field');
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '0.5';
            input.max = '200';
            input.step = '0.5';
            input.value = String(metresOf(axis));
            input.title = title;
            input.dataset.testid = axis === 0 ? 'surface-tile-meters' : 'surface-tile-meters-z';
            input.addEventListener('input', () => setMetres(axis, Number(input.value)));
            row.append(element('span', '', label), input);
            this.host.append(row);
            fields.push(input);
          }
          const linkRow = element('div', 'surface-button-row');
          const link = button(this.tileLinked ? '🔗 Square tiles' : '⛓ Free shape',
            `tool-button small${this.tileLinked ? ' active' : ''}`,
            'Keep both tile dimensions equal (square tiles), or set them independently to stretch the tile into a rectangle');
          link.dataset.testid = 'surface-tile-link';
          link.setAttribute('aria-pressed', String(this.tileLinked));
          link.addEventListener('click', () => {
            this.tileLinked = !this.tileLinked;
            if (this.tileLinked) {
              const across = this._style().repeat[0];
              this._patch({ repeat: [across, across] });
            }
            this.render();
          });
          linkRow.append(link);
          this.host.append(linkRow);
          const presets = element('div', 'surface-button-row');
          for (const preset of TILE_PRESETS) {
            const node = button(`${preset} m`, 'tool-button small', `Square tiles, one image copy every ${preset} metres`);
            node.addEventListener('click', () => {
              const repeat = WORLD_SURFACE_TILE_METERS / preset;
              for (const field of fields) field.value = String(preset);
              this._patch({ repeat: [repeat, repeat] }, `${meta.label} tiles every ${preset} m`);
              this.render();
            });
            presets.append(node);
          }
          this.host.append(presets);
          this.host.append(element('p', 'modeler-help', 'Road asphalt is anchored to world coordinates, so a tile is a fixed number of metres everywhere — across lanes, chunks, curves and junctions. X and Z are world axes; use Rotation below to turn the whole tile grid.'));
        } else {
          let acrossSlider = null;
          let downSlider = null;
          acrossSlider = this._slider('Repeat across', style.repeat[0], { min: 0.1, max: 24, step: 0.1, testid: 'surface-repeat-x' },
            (value) => {
              const next = this.tileLinked ? [value, value] : [value, this._style().repeat[1]];
              if (this.tileLinked) downSlider?.show(value);
              this._patch({ repeat: next });
            });
          downSlider = this._slider('Repeat down', style.repeat[1], { min: 0.1, max: 24, step: 0.1, testid: 'surface-repeat-y' },
            (value) => {
              const next = this.tileLinked ? [value, value] : [this._style().repeat[0], value];
              if (this.tileLinked) acrossSlider?.show(value);
              this._patch({ repeat: next });
            });
          const linkRow = element('div', 'surface-button-row');
          const link = button(this.tileLinked ? '🔗 Square tiles' : '⛓ Free shape',
            `tool-button small${this.tileLinked ? ' active' : ''}`,
            'Keep both repeats equal (square tiles), or set them independently to stretch the tile into a rectangle');
          link.dataset.testid = 'surface-tile-link';
          link.setAttribute('aria-pressed', String(Boolean(this.tileLinked)));
          link.addEventListener('click', () => {
            this.tileLinked = !this.tileLinked;
            if (this.tileLinked) {
              const across = this._style().repeat[0];
              this._patch({ repeat: [across, across] });
            }
            this.render();
          });
          linkRow.append(link);
          this.host.append(linkRow);
        }
      } else if (fit === 'cover') {
        this.host.append(element('h4', 'surface-group-title', 'Surface shape'));
        this._slider('Width ÷ height', style.aspect, { min: 0.1, max: 8, step: 0.05, testid: 'surface-aspect' },
          (value) => this._patch({ aspect: value }));
        this.host.append(element('p', 'modeler-help', 'How wide the surface is compared to its height — 1 is square, 3 is a long low wall. The crop is taken to match, so the picture never comes out squashed.'));
      }

      this.host.append(element('h4', 'surface-group-title', 'Placement'));
      this._slider('Shift across', style.offset[0], { min: -1, max: 1, step: 0.01, testid: 'surface-offset-x' },
        (value) => this._patch({ offset: [value, this._style().offset[1]] }));
      this._slider('Shift down', style.offset[1], { min: -1, max: 1, step: 0.01, testid: 'surface-offset-y' },
        (value) => this._patch({ offset: [this._style().offset[0], value] }));
      this._slider('Rotation °', style.rotation, { min: -180, max: 180, step: 1, testid: 'surface-rotation' },
        (value) => this._patch({ rotation: value }));
      const flips = element('div', 'surface-button-row');
      for (const [key, label, title] of [['flipX', 'Flip H', 'Mirror the image left-right'], ['flipY', 'Flip V', 'Mirror the image top-bottom']]) {
        const node = button(label, `tool-button small${style[key] ? ' active' : ''}`, title);
        node.setAttribute('aria-pressed', String(Boolean(style[key])));
        node.addEventListener('click', () => {
          this._patch({ [key]: !this._style()[key] });
          this.render();
        });
        flips.append(node);
      }
      this.host.append(flips);
    }

    // ------------------------------------------------------------------ tint --
    this.host.append(element('h4', 'surface-group-title', meta.tintOnly ? 'Colour' : 'Colour & light'));
    const tintRow = element('label', 'modeler-field');
    const tint = document.createElement('input');
    tint.type = 'color';
    tint.value = style.tint;
    tint.dataset.testid = 'surface-tint';
    tint.title = meta.tintOnly
      ? 'The colour this light or marking glows'
      : 'Multiplies the image — white leaves the picture untouched, a colour washes it';
    tint.addEventListener('input', () => this._patch({ tint: tint.value }));
    tintRow.append(element('span', '', meta.tintOnly ? 'Glow colour' : 'Tint'), tint);
    this.host.append(tintRow);
    this._slider('Brightness', style.brightness, { min: 0.1, max: 3, step: 0.05, testid: 'surface-brightness' },
      (value) => this._patch({ brightness: value }));

    // ----------------------------------------------------------------- reset --
    this.resetButton = button('Reset to generated', 'tool-button small danger', 'Drop every override on this surface and go back to the look the map generator makes');
    this.resetButton.dataset.testid = 'surface-reset';
    this.resetButton.addEventListener('click', () => {
      this.store.setWorldSurface(this.slot, null);
      this.onChange(this.slot);
      this.onStatus(`${meta.label} back to the generated look`);
      this.render();
    });
    this.host.append(this.resetButton);

    this._syncPreview();
    this._syncResetState();
  }

  /** Slider + number box bound to one numeric field of the style. */
  _slider(label, value, { min, max, step, testid }, apply) {
    const row = element('div', 'surface-slider-row');
    row.append(element('span', '', label));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.setAttribute('aria-label', label);
    if (testid) range.dataset.testid = testid;
    const box = document.createElement('input');
    box.type = 'number';
    box.min = String(min);
    box.max = String(max);
    box.step = String(step);
    box.value = String(Number(Number(value).toFixed(3)));
    box.setAttribute('aria-label', `${label} value`);
    range.addEventListener('input', () => {
      box.value = range.value;
      apply(Number(range.value));
    });
    box.addEventListener('change', () => {
      const next = Math.min(max, Math.max(min, Number(box.value) || 0));
      box.value = String(next);
      range.value = String(next);
      apply(next);
    });
    row.append(range, box);
    this.host.append(row);
    return {
      row,
      /** Move the control without firing its handler — for linked partners. */
      show(next) {
        range.value = String(next);
        box.value = String(Number(Number(next).toFixed(3)));
      },
    };
  }
}
