import * as THREE from 'three';

/**
 * PS2-era world textures — stylized pixel tiles, not realism.
 *
 * Core technique for every surface: paint a VERY low-res texel grid
 * (16-32 texels per tile) with broad, quantized tonal clusters, then
 * upscale it once with bilinear smoothing. The result is exactly the
 * period look: visibly pixel-based, blocky, mostly uniform, slightly
 * blurred — a "Minecraft-like" grid adapted into believable game asphalt
 * and concrete. No cracks, no photographic grain, no scan noise.
 *
 * Headless probes construct the map with no DOM; callers must handle a
 * null return and keep their flat-color fallbacks.
 */

const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const canvas2d = (w, h) => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return [canvas, canvas.getContext('2d')];
};

/**
 * Tileable value noise: a random lattice sampled with wrap-around bilinear
 * smoothstep. This is what gives the texel grid BROAD clusters (light and
 * dark regions several texels wide) instead of per-pixel noise.
 */
const makeValueNoise = (cells, random) => {
  const lattice = Array.from({ length: cells * cells }, () => random());
  const smooth = (t) => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = ((u % 1) + 1) % 1 * cells;
    const y = ((v % 1) + 1) % 1 * cells;
    const x0 = Math.floor(x) % cells;
    const y0 = Math.floor(y) % cells;
    const x1 = (x0 + 1) % cells;
    const y1 = (y0 + 1) % cells;
    const fx = smooth(x - Math.floor(x));
    const fy = smooth(y - Math.floor(y));
    const a = lattice[y0 * cells + x0];
    const b = lattice[y0 * cells + x1];
    const c = lattice[y1 * cells + x0];
    const d = lattice[y1 * cells + x1];
    return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy;
  };
};

/**
 * Paint a texel grid then upscale — the "pixelated, then lightly blurred"
 * finish every texture here shares. The upscale is NEAREST (hard texel
 * squares stay visible) followed by one down-up resample pass, which
 * softens edges by about a pixel without melting the grid into clouds.
 * paint(setTexel, texels): setTexel(x, y, cssColor).
 */
const pixelTile = (texelsX, texelsY, outW, outH, paint) => {
  const [small, sc] = canvas2d(texelsX, texelsY);
  paint((x, y, color) => {
    sc.fillStyle = color;
    sc.fillRect(x, y, 1, 1);
  });
  const [hard, hc] = canvas2d(outW, outH);
  hc.imageSmoothingEnabled = false;
  hc.drawImage(small, 0, 0, outW, outH);
  const [half, halfC] = canvas2d(Math.max(1, outW >> 1), Math.max(1, outH >> 1));
  halfC.imageSmoothingEnabled = true;
  halfC.drawImage(hard, 0, 0, half.width, half.height);
  const [canvas, c] = canvas2d(outW, outH);
  c.imageSmoothingEnabled = true;
  c.drawImage(half, 0, 0, outW, outH);
  return canvas;
};

/**
 * Posterized tone palette AROUND a base grey: cluster intensity t (0..1)
 * picks one of `levels` tones spaced `step` apart, with a small chance of
 * a ±1-tone per-texel shift so the grid reads as individual texels. This
 * keeps variation subtle and centred — never snapping to black or white.
 */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const toneAt = (base, step, levels, t, random, jitterChance = 0.25) => {
  let k = Math.round(clamp01(t) * (levels - 1));
  const roll = random();
  if (roll < jitterChance * 0.4) k += 1;
  else if (roll < jitterChance) k -= 1;
  k = Math.max(0, Math.min(levels - 1, k));
  return base + (k - (levels - 1) / 2) * step;
};

/** Cool-grey css color from luminance 0..1 (subtle night-blue bias). */
const grey = (l, warm = 0) => {
  const r = Math.round(255 * clamp01(l) * (0.975 + warm * 0.06));
  const g = Math.round(255 * clamp01(l) * (1.0 + warm * 0.01));
  const b = Math.round(255 * clamp01(l) * (1.035 - warm * 0.06));
  return `rgb(${r},${g},${b})`;
};

const finishTexture = (canvas, { srgb = true } = {}) => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  if (srgb && 'colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

/**
 * Stylized pixel asphalt. Mostly uniform grey; the only detail is the
 * quantized texel grid itself plus broad noise clusters. Style knobs:
 *   texels — grid resolution per 7 m tile (chunkier = more PS2)
 *   levels — posterization levels
 *   broad  — amplitude of the cluster noise
 *   jitter — tiny per-texel variation so the grid reads as texels
 */
const asphaltPixel = (random, { base = 0.29, texels = 24, levels = 4, step = 0.034 } = {}) => {
  // Minecraft-style tone distribution: EVERY texel rolls its own tone
  // (so the grid itself is the detail), shaped by only a mild small-cluster
  // vein so tones form 2-3 texel groups instead of large cloudy blobs.
  const veins = makeValueNoise(Math.max(6, Math.round(texels / 2)), random);
  const mid = (levels - 1) / 2;
  const canvas = pixelTile(texels, texels, 128, 128, (set) => {
    for (let y = 0; y < texels; y += 1) {
      for (let x = 0; x < texels; x += 1) {
        const vein = (veins(x / texels, y / texels) - 0.5) * 1.7;
        const jitter = (random() - 0.5) * 1.6;
        const k = Math.max(0, Math.min(levels - 1, Math.round(mid + vein + jitter)));
        set(x, y, grey(base + (k - mid) * step));
      }
    }
  });
  return finishTexture(canvas);
};

/**
 * Pixel concrete for barriers / walls: lighter grey, same texel language,
 * with a broad horizontal formwork band and a vertical joint column baked
 * at texel resolution — simple seams, no grime streaks.
 */
const concretePixel = (random, {
  base = 0.5, texels = 32, rows = 16, levels = 4, step = 0.035,
  bandEvery = 6, joints = 2,
} = {}) => {
  const clusters = makeValueNoise(5, random);
  const canvas = pixelTile(texels, rows, 128, 64, (set) => {
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < texels; x += 1) {
        const t = 0.5 + (clusters(x / texels, y / rows) - 0.5) * 1.4;
        let value = toneAt(base, step, levels, t, random);
        if (bandEvery && y % bandEvery === bandEvery - 1) value -= 0.06;
        for (let j = 0; j < joints; j += 1) {
          if (x === Math.floor((j + 0.5) * (texels / joints))) value -= 0.1;
        }
        set(x, y, grey(value));
      }
    }
  });
  return finishTexture(canvas);
};

/** Pixel concrete for pillars/fascia: vertical tone columns, stretch-safe. */
const pillarPixel = (random, { base = 0.3, texels = 16, rows = 32, levels = 4 } = {}) => {
  const columns = makeValueNoise(6, random);
  const canvas = pixelTile(texels, rows, 64, 128, (set) => {
    for (let x = 0; x < texels; x += 1) {
      const columnT = 0.5 + (columns(x / texels, 0.5) - 0.5) * 1.6;
      const edge = (x === 0 || x === texels - 1) ? -0.06 : 0;
      for (let y = 0; y < rows; y += 1) {
        set(x, y, grey(toneAt(base, 0.03, levels, columnT, random, 0.18) + edge));
      }
    }
  });
  return finishTexture(canvas);
};

/** Tunnel wall: per-panel tone blocks with dark joint texels. */
const tunnelPixel = (random, { base = 0.36, texels = 32, panelW = 8, panelH = 11, levels = 4 } = {}) => {
  const panelTone = makeValueNoise(4, random);
  const canvas = pixelTile(texels, texels, 128, 128, (set) => {
    for (let y = 0; y < texels; y += 1) {
      for (let x = 0; x < texels; x += 1) {
        const joint = x % panelW === 0 || y % panelH === 0;
        const t = 0.5 + (panelTone(Math.floor(x / panelW) / 4, Math.floor(y / panelH) / 3) - 0.5) * 1.5;
        const value = joint ? base - 0.12 : toneAt(base, 0.03, levels, t, random, 0.14);
        set(x, y, grey(value));
      }
    }
  });
  return finishTexture(canvas);
};

/** Service-area concrete: big slab quadrants with joint lines. */
const slabPixel = (random, { base = 0.32, texels = 32, slab = 16, levels = 4 } = {}) => {
  const slabTone = makeValueNoise(4, random);
  const canvas = pixelTile(texels, texels, 128, 128, (set) => {
    for (let y = 0; y < texels; y += 1) {
      for (let x = 0; x < texels; x += 1) {
        const joint = x % slab === 0 || y % slab === 0;
        const t = 0.5 + (slabTone(Math.floor(x / slab) / 2, Math.floor(y / slab) / 2) - 0.5) * 1.4;
        const value = joint ? base - 0.1 : toneAt(base, 0.028, levels, t, random, 0.2);
        set(x, y, grey(value));
      }
    }
  });
  return finishTexture(canvas);
};

/**
 * Warehouse/garage exterior siding: horizontal corrugation bands with a
 * dark plinth and sparse vertical joints. Horizontal features only, so the
 * one unit-box UV stretch over a large building face stays invisible.
 */
const sidingPixel = (random, { base = 0.24 } = {}) => {
  const canvas = pixelTile(32, 32, 128, 128, (set) => {
    for (let y = 0; y < 32; y += 1) {
      const rib = y % 3 === 0 ? 0.045 : y % 3 === 2 ? -0.05 : 0;
      const plinth = y > 27 ? -0.09 : 0;
      const cap = y < 2 ? -0.06 : 0;
      for (let x = 0; x < 32; x += 1) {
        let value = base + rib + plinth + cap;
        if (x % 16 === 0) value -= 0.05;
        value += (Math.round((random() - 0.5) * 2) * 0.018);
        set(x, y, grey(value));
      }
    }
  });
  return finishTexture(canvas);
};

/** Roller-shutter door: chunky horizontal slats, mid warm grey. */
const shutterPixel = (random, { base = 0.42 } = {}) => {
  const canvas = pixelTile(16, 32, 64, 128, (set) => {
    for (let y = 0; y < 32; y += 1) {
      const slat = y % 4;
      const tone = slat === 0 ? 0.06 : slat === 3 ? -0.08 : 0;
      for (let x = 0; x < 16; x += 1) {
        let value = base + tone + (Math.round((random() - 0.5) * 2) * 0.014);
        if (x === 0 || x === 15) value -= 0.1;
        set(x, y, grey(value, 0.35));
      }
    }
  });
  return finishTexture(canvas);
};

/** Corrugated container/industrial siding at texel resolution. */
const containerPixel = (random, { base = 0.62 } = {}) => {
  const canvas = pixelTile(32, 32, 64, 64, (set) => {
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const rib = x % 4;
        let value = base + (rib === 0 ? 0.07 : rib === 3 ? -0.1 : 0);
        if (y < 2 || y > 29) value -= 0.12;
        value += (Math.round((random() - 0.5) * 2) * 0.03);
        set(x, y, grey(value));
      }
    }
  });
  return finishTexture(canvas);
};

/** Sky gradient for the horizon dome: dark navy up top, city haze at the horizon. */
const skyGradientTexture = () => {
  const [canvas, c] = canvas2d(16, 128);
  const g = c.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#030509');
  g.addColorStop(0.52, '#04070f');
  g.addColorStop(0.8, '#0a1019');
  g.addColorStop(0.93, '#131a26');
  g.addColorStop(1, '#1a2230');
  c.fillStyle = g;
  c.fillRect(0, 0, 16, 128);
  const texture = finishTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
};

/**
 * Asphalt art-direction candidates (validated on the representative slice):
 *   A — 16 texels/tile, 3 tones, widest step: chunkiest
 *   B — 24 texels/tile, 4 tones: balanced (default)
 *   C — 32 texels/tile, 5 tones, tightest step: finest grid
 */
const ASPHALT_STYLES = {
  A: { texels: 16, levels: 3, step: 0.05, jitterChance: 0.3 },
  B: { texels: 24, levels: 4, step: 0.037, jitterChance: 0.28 },
  C: { texels: 32, levels: 5, step: 0.028, jitterChance: 0.3 },
};

const styleFromUrl = () => {
  try { return new URLSearchParams(window.location.search).get('asphaltStyle'); } catch (e) { return null; }
};

/**
 * Shared world texture set. Each entry is one small canvas; the same
 * object is handed to the material factory and the dispose list.
 */
export function createWorldTextures(seed = 0x51a7c1, { asphaltStyle = null } = {}) {
  if (typeof document === 'undefined') return null;
  const rng = (salt) => mulberry32((seed ^ salt) >>> 0);
  const style = ASPHALT_STYLES[asphaltStyle || styleFromUrl() || 'A'] || ASPHALT_STYLES.A;
  return {
    asphalt: asphaltPixel(rng(0x1111), { base: 0.29, ...style }),
    // ramps/connectors: same language, a step lighter
    asphaltRamp: asphaltPixel(rng(0x2222), { base: 0.315, ...style }),
    // shoulder band outside the edge line: paler, reads as a distinct strip
    shoulder: asphaltPixel(rng(0xaaaa), { base: 0.37, ...style }),
    service: slabPixel(rng(0x3333)),
    barrier: concretePixel(rng(0x4444), { base: 0.52 }),
    concrete: concretePixel(rng(0x5555), { base: 0.46, bandEvery: 8, joints: 1 }),
    pillar: pillarPixel(rng(0x6666)),
    tunnel: tunnelPixel(rng(0x7777)),
    container: containerPixel(rng(0x8888)),
    siding: sidingPixel(rng(0xbbbb)),
    shutter: shutterPixel(rng(0xcccc)),
    sky: skyGradientTexture(),
  };
}

// ---------------------------------------------------------------------
// Garage interior tiles — same pixel language, workshop palette.
// ---------------------------------------------------------------------

/**
 * Whole-room garage floor (not tiled): slab grid, a painted work-bay
 * outline around the car footprint, posterized oil shadows and tire
 * scuffs leading to the shutter. Drawn on a 64-texel grid for the room's
 * 22×28 m, so one texel is ~0.4 m — chunky and readable.
 */
const garageFloorTexture = (random) => {
  const T = 64;
  const veins = makeValueNoise(10, random);
  const canvas = pixelTile(T, T, 256, 256, (set) => {
    for (let y = 0; y < T; y += 1) {
      for (let x = 0; x < T; x += 1) {
        const vein = (veins(x / T, y / T) - 0.5) * 1.4;
        const jitter = (random() - 0.5) * 1.4;
        const k = Math.max(0, Math.min(3, Math.round(1.5 + vein + jitter)));
        let value = 0.30 + (k - 1.5) * 0.026;
        if (x % 16 === 0 || y % 16 === 0) value -= 0.07;             // slab joints
        // painted work bay outline around the car footprint (room centre)
        const inBayX = x >= 22 && x <= 42;
        const inBayY = y >= 16 && y <= 46;
        const onBorder = (inBayX && (y === 16 || y === 46)) || (inBayY && (x === 22 || x === 42));
        // oil shadow inside the bay + scuff lanes toward the shutter (high y)
        if (inBayX && y > 24 && y < 40 && random() < 0.3) value -= 0.05;
        if ((x === 29 || x === 30 || x === 34 || x === 35) && y > 40 && random() < 0.75) value -= 0.045;
        if (onBorder) {
          set(x, y, `rgb(${Math.round(198 * 0.72)},${Math.round(188 * 0.72)},${Math.round(120 * 0.72)})`);
          continue;
        }
        set(x, y, grey(value, 0.15));
      }
    }
  });
  return finishTexture(canvas);
};

/**
 * Garage wall: concrete block courses with mortar lines, dark plinth and
 * a faded workshop banner stripe. Horizontal features only, so one box
 * face stretch across the whole wall stays invisible; repeat is set by
 * the consumer.
 */
const garageWallTexture = (random) => {
  const canvas = pixelTile(32, 32, 128, 128, (set) => {
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const course = Math.floor(y / 4);
        const offset = course % 2 === 0 ? 0 : 4;
        let value = 0.27 + (Math.round((random() - 0.5) * 2) * 0.02);
        if (y % 4 === 3) value -= 0.06;                              // mortar row
        if ((x + offset) % 8 === 0) value -= 0.05;                   // head joints
        if (y >= 28) value -= 0.08;                                  // plinth
        if (y === 19 || y === 20) {
          // faded safety banner stripe
          set(x, y, `rgb(${Math.round(140 * 0.62)},${Math.round(52 * 0.62)},${Math.round(48 * 0.62)})`);
          continue;
        }
        set(x, y, grey(value, 0.1));
      }
    }
  });
  return finishTexture(canvas);
};

/** Small workshop poster: simple blocks + text, downsampled for the era look. */
const posterTexture = (kind) => {
  const [big, b] = canvas2d(96, 128);
  if (kind === 'tires') {
    b.fillStyle = '#20242c';
    b.fillRect(0, 0, 96, 128);
    b.fillStyle = '#d8d3c4';
    b.fillRect(6, 6, 84, 22);
    b.fillStyle = '#15181d';
    b.font = 'bold 15px monospace';
    b.textAlign = 'center';
    b.fillText('月光タイヤ', 48, 22);
    b.strokeStyle = '#aab0ba';
    b.lineWidth = 7;
    b.beginPath();
    b.arc(48, 72, 26, 0, Math.PI * 2);
    b.stroke();
    b.fillStyle = '#0c0e12';
    b.beginPath();
    b.arc(48, 72, 19, 0, Math.PI * 2);
    b.fill();
    b.fillStyle = '#c8b26a';
    b.font = 'bold 12px monospace';
    b.fillText('GEKKO TIRES', 48, 118);
  } else if (kind === 'safety') {
    b.fillStyle = '#c9b23a';
    b.fillRect(0, 0, 96, 128);
    b.fillStyle = '#15161a';
    for (let i = -3; i < 8; i += 1) {
      b.save();
      b.translate(i * 18, 0);
      b.rotate(-0.6);
      b.fillRect(0, -10, 9, 44);
      b.restore();
    }
    b.fillStyle = '#15161a';
    b.fillRect(0, 34, 96, 62);
    b.fillStyle = '#e8dfc2';
    b.font = 'bold 20px monospace';
    b.textAlign = 'center';
    b.fillText('安全第一', 48, 62);
    b.font = 'bold 11px monospace';
    b.fillText('SAFETY FIRST', 48, 82);
  } else {
    b.fillStyle = '#101623';
    b.fillRect(0, 0, 96, 128);
    b.fillStyle = '#2a3a5c';
    b.fillRect(0, 84, 96, 44);
    // simple coupe silhouette
    b.fillStyle = '#b8384a';
    b.fillRect(14, 74, 68, 14);
    b.fillRect(30, 64, 34, 12);
    b.fillStyle = '#0a0c10';
    b.fillRect(22, 84, 12, 8);
    b.fillRect(62, 84, 12, 8);
    b.fillStyle = '#e2e6ee';
    b.font = 'bold 14px monospace';
    b.textAlign = 'center';
    b.fillText('WANGAN', 48, 24);
    b.fillText('NIGHT', 48, 40);
    b.fillStyle = '#c8b26a';
    b.font = '10px monospace';
    b.fillText('SAT 25:00', 48, 116);
  }
  // era finish: downsample to half, back up — softened low-res print
  const [half, hc] = canvas2d(48, 64);
  hc.imageSmoothingEnabled = true;
  hc.drawImage(big, 0, 0, 48, 64);
  const [canvas, c] = canvas2d(96, 128);
  c.imageSmoothingEnabled = true;
  c.drawImage(half, 0, 0, 96, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

/** Cardboard crate face: taped box with a chunky label block. */
const crateTexture = (random) => {
  const canvas = pixelTile(16, 16, 64, 64, (set) => {
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        let value = 0.44 + (Math.round((random() - 0.5) * 2) * 0.025);
        if (x === 7 || x === 8) value += 0.09;                       // tape
        if (y === 0 || y === 15 || x === 0 || x === 15) value -= 0.08;
        if (x >= 2 && x <= 5 && y >= 10 && y <= 12) value -= 0.14;   // label
        set(x, y, `rgb(${Math.round(255 * value)},${Math.round(214 * value)},${Math.round(158 * value)})`);
      }
    }
  });
  return finishTexture(canvas);
};

export function createGarageTextures(seed = 0x6a7a8a) {
  if (typeof document === 'undefined') return null;
  const rng = (salt) => mulberry32((seed ^ salt) >>> 0);
  return {
    floor: garageFloorTexture(rng(0x11)),
    wall: garageWallTexture(rng(0x22)),
    shutter: shutterPixel(rng(0x33), { base: 0.4 }),
    crate: crateTexture(rng(0x44)),
    posterTires: posterTexture('tires'),
    posterSafety: posterTexture('safety'),
    posterNight: posterTexture('night'),
  };
}

export default createWorldTextures;
