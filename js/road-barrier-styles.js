/**
 * SHUTOKO NIGHTS — lateral barrier styles.
 *
 * The road edge used to be one hard-coded profile (a low capped parapet with a
 * steel handrail). This module turns that profile into a CATALOGUE, and adds
 * the addressing scheme that lets the world editor say
 *
 *     "ramp_8, both sides, 0 m -> end of route: shutokoTall"
 *     "wangan_0, left side, 1200 m -> 1480 m: soundWall"
 *
 * i.e. per route, per side, per arbitrary chainage span — spans do NOT have to
 * line up with route segments and can be much shorter than one.
 *
 * A style is ONE continuous cross-section swept along the road edge — inner
 * face, over the top, back down the outer face — so a wall is a single solid
 * piece of geometry, not two parallel sheets a texture would land on twice.
 *
 * Each profile point is `[inset, height, v]`:
 *   - `inset`  · metres INWARD from the drawn surface edge (positive = toward
 *                the road centre, 0 = exactly the deck edge). Keeps a style
 *                independent of carriageway width, lay-by bulges and
 *                progressive-merge envelopes.
 *   - `height` · metres above the deck.
 *   - `v`      · the texture coordinate at that point, 0 at the foot and 1 at
 *                the top. It is AUTHORED, not derived from the geometry: that
 *                is what makes a painted wall line up across segment joints on
 *                a graded ramp instead of stepping like a staircase (each quad
 *                would otherwise re-fit the image to its own foot and top).
 *                `u` is world chainage along the route, so the run tiles
 *                continuously with no seam per segment.
 *
 * Geometry is emitted as MERGED chunk quads only (never `_instance`), so
 * adding or retuning a style can never shift the (mesh, index) addresses the
 * editor's saved build operations rely on.
 */

/** Side signs as js/map.js uses them (lateral runs along +normal = right). */
export const BARRIER_SIDE_SIGNS = Object.freeze({ right: 1, left: -1 });

export const BARRIER_SIDE_KEYS = Object.freeze(['left', 'right', 'both']);

/** The shipped profile. A route with no override renders exactly as before. */
export const DEFAULT_BARRIER_STYLE_ID = 'parapet';

/**
 * `native: true` marks the one style js/map.js draws through its original
 * code path instead of the generic sweeper — the shipped silhouette stays
 * byte-identical wherever nobody has authored an override.
 *
 * sheets[].points are ordered from the INNERMOST/top-of-profile point down to
 * the outer deck edge; consecutive points are swept into one quad strip.
 */
export const BARRIER_STYLES = Object.freeze({
  parapet: {
    id: 'parapet',
    label: 'Parapet (default)',
    description: 'Capped concrete parapet with a steel handrail — the shipped Shutoko edge.',
    native: true,
    collisionHeight: null, // route-kind default (0.9 service / 1.15 mainline)
    approximateHeight: 1.15,
  },

  shutokoTall: {
    id: 'shutokoTall',
    label: 'Tall screen wall (Shutoko)',
    description: 'Concrete kerb plus a full-height screen wall with ribs and a capping rail — the walled ramp/PA approach look.',
    collisionHeight: 3.35,
    approximateHeight: 3.45,
    // ONE piece: up the road-side face, over the capping beam, back down the
    // outer face to the deck edge. Kerb, wall and cap are the same slot and
    // the same continuous strip, so a painted texture lands on it exactly
    // once — no doubled image from a second parallel sheet, and no separate
    // posts to break the run (the picture carries the ribs and joints).
    sheets: [{
      material: 'barrierScreen',
      points: [
        [0.34, 0.00, 0.00],
        [0.34, 0.62, 0.18],
        [0.26, 0.70, 0.20],
        [0.26, 3.30, 0.97],
        [0.22, 3.42, 1.00],
        [0.04, 3.42, 0.99],
        [0.04, 0.70, 0.20],
        [0.00, 0.62, 0.18],
        [0.00, 0.00, 0.00],
      ],
    }],
    posts: null,
  },

  meshScreen: {
    id: 'meshScreen',
    label: 'Parapet + anti-throw screen',
    description: 'The default parapet with a tall slim mesh screen and posts above it — overbridge / residential-frontage style.',
    collisionHeight: 1.15,
    approximateHeight: 3.0,
    sheets: [
      // The only style that deliberately shares slots: it IS the default
      // parapet with a screen bolted on, so its base follows "Concrete
      // barriers" and its handrail follows "Guardrails" — retexturing the
      // normal parapets should carry this one with them. Only the screen and
      // its posts sit on the style's own slot.
      { material: 'barrier', points: [[0.30, 0.85], [0.06, 0.91], [0.0, 0.0]] },
      { material: 'railMetal', points: [[0.18, 1.03], [0.18, 1.12]] },
      // The screen is its own single strip: up the inside, over the top rail,
      // back down the outside.
      {
        material: 'barrierMesh',
        points: [
          [0.18, 1.12, 0.00],
          [0.18, 2.92, 0.96],
          [0.15, 3.00, 1.00],
          [0.11, 2.92, 0.96],
          [0.11, 1.12, 0.00],
        ],
      },
    ],
    posts: { material: 'barrierMesh', spacing: 2.6, inset: 0.145, width: 0.11, depth: 0.13, base: 0.9, height: 2.12 },
  },

  soundWall: {
    id: 'soundWall',
    label: 'Sound wall',
    description: 'Solid 4.8 m acoustic wall on a low kerb — the fully enclosed elevated-canyon section.',
    collisionHeight: 4.7,
    approximateHeight: 4.85,
    sheets: [{
      material: 'barrierSound',
      points: [
        [0.38, 0.00, 0.00],
        [0.38, 0.52, 0.11],
        [0.28, 0.60, 0.13],
        [0.28, 4.72, 0.98],
        [0.24, 4.82, 1.00],
        [0.04, 4.82, 0.99],
        [0.04, 0.60, 0.13],
        [0.00, 0.52, 0.11],
        [0.00, 0.00, 0.00],
      ],
    }],
    posts: null,
  },

  jersey: {
    id: 'jersey',
    label: 'Jersey barrier',
    description: 'Bare jersey profile, no handrail — surface roads, PA aprons, temporary edges.',
    collisionHeight: 1.0,
    approximateHeight: 1.0,
    sheets: [{
      material: 'barrierJersey',
      points: [
        [0.36, 0.02, 0.02],
        [0.30, 0.30, 0.30],
        [0.11, 0.92, 0.94],
        [0.06, 0.98, 1.00],
        [0.00, 0.92, 0.94],
        [0.00, 0.00, 0.00],
      ],
    }],
  },

  guardrail: {
    id: 'guardrail',
    label: 'Open guardrail',
    description: 'W-beam steel rail on posts with an open gap underneath — embankment and slip-road edges.',
    collisionHeight: 0.85,
    approximateHeight: 0.9,
    sheets: [{
      material: 'barrierRail',
      points: [
        [0.24, 0.52, 0.00],
        [0.24, 0.86, 1.00],
        [0.16, 0.86, 0.98],
        [0.16, 0.52, 0.02],
      ],
    }],
    posts: { material: 'barrierRail', spacing: 3.6, inset: 0.2, width: 0.12, depth: 0.16, base: 0.0, height: 0.6 },
  },

  none: {
    id: 'none',
    label: 'No barrier (open edge)',
    description: 'Draws nothing. Collision is deliberately KEPT so the edge is still solid — this only removes the visual.',
    collisionHeight: null,
    approximateHeight: 0,
    sheets: [],
  },
});

export const BARRIER_STYLE_IDS = Object.freeze(Object.keys(BARRIER_STYLES));

/**
 * The materials the styles above introduce, on top of the ones the generator
 * already had. Rule: ONE STYLE = ONE PAINTABLE SLOT. Everything a style draws
 * — kerb, panels, posts, capping beam — sits on that style's own material, so
 * a slot in the editor's Surfaces app means exactly what its name says and
 * nothing else in the world moves with it.
 *
 * Which slot is which, for the record:
 *   `barrier` ("Concrete barriers")  = the DEFAULT low parapet, i.e. the
 *      muretti along every road in the map. Not one of these.
 *   `concrete` ("Concrete (pillars & lamp posts)") = pillars, lamp masts and
 *      the central median jersey on two-way routes.
 *   `railMetal` ("Guardrails") = the steel handrail on top of the default
 *      parapet.
 * The one deliberate exception is `meshScreen`, which IS the default parapet
 * plus a screen and therefore keeps its base on `barrier` (see its comment).
 */
export const BARRIER_MATERIALS = Object.freeze({
  barrierScreen: { color: 0x7f8790, emissive: 0x282c33, label: 'Tall screen wall', description: 'The whole tall screen wall on walled ramps and PA approaches — kerb, panels, posts and capping beam' },
  barrierSound: { color: 0x6d757e, emissive: 0x24272d, label: 'Sound wall', description: 'The whole acoustic wall on fully enclosed elevated sections' },
  barrierMesh: { color: 0x9aa3ad, emissive: 0x252930, label: 'Anti-throw screen', description: 'The slim mesh screen and posts standing above a parapet (the parapet itself is "Concrete barriers")' },
  barrierJersey: { color: 0x8f959d, emissive: 0x2a2d34, label: 'Jersey barrier (road edge)', description: 'Bare jersey blocks used as a road edge — not the central median, which is "Concrete (pillars & lamp posts)"' },
  barrierRail: { color: 0xaab2bc, emissive: 0x23262c, label: 'Open guardrail beam', description: 'W-beam guardrail and posts on open embankment edges' },
});

export const BARRIER_MATERIAL_NAMES = Object.freeze(Object.keys(BARRIER_MATERIALS));

/** Per-span height multiplier bounds. 1 = the style's own dimensions. */
export const BARRIER_HEIGHT_SCALE_RANGE = Object.freeze({ min: 0.4, max: 3, default: 1 });

export function isBarrierStyleId(id) {
  return typeof id === 'string' && Object.hasOwn(BARRIER_STYLES, id);
}

export function barrierStyle(id) {
  return BARRIER_STYLES[id] || BARRIER_STYLES[DEFAULT_BARRIER_STYLE_ID];
}

export function blankBarrierDocument() {
  return { version: 1, routes: {} };
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function roundMetres(value) {
  const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Structurally validates and normalizes a barrier document.
 *
 * Shape:
 *   {
 *     version: 1,
 *     routes: {
 *       "<routeId>": [
 *         { side: "both" | "left" | "right", start: 0, end: null, style: "shutokoTall" }
 *       ]
 *     }
 *   }
 *
 * `end: null` means "to the end of the route". Spans may overlap: they are
 * applied in order, so a later entry repaints the stretch it covers. That is
 * what makes short patches inside a long run possible without splitting the
 * run — author the full-length coat first, then the patches.
 */
export function canonicalizeBarrierDocument(document) {
  if (!isRecord(document)) throw new TypeError('Road barrier document must be an object');
  if (document.version !== 1) throw new TypeError('Road barrier document version must be 1');
  if (!isRecord(document.routes)) throw new TypeError('Road barrier document routes must be an object keyed by route id');
  const routes = {};
  for (const routeId of Object.keys(document.routes).sort()) {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(routeId)) throw new TypeError(`Invalid barrier route id: ${routeId}`);
    const spans = document.routes[routeId];
    if (!Array.isArray(spans)) throw new TypeError(`Barrier spans for ${routeId} must be an array`);
    const canonical = [];
    spans.forEach((span, index) => {
      const label = `Barrier span ${routeId}[${index}]`;
      if (!isRecord(span)) throw new TypeError(`${label} must be an object`);
      const side = span.side ?? 'both';
      if (!BARRIER_SIDE_KEYS.includes(side)) throw new TypeError(`${label}.side must be one of ${BARRIER_SIDE_KEYS.join(', ')}`);
      if (!isBarrierStyleId(span.style)) throw new TypeError(`${label}.style is not a known barrier style: ${span.style}`);
      const start = span.start == null ? 0 : span.start;
      if (!Number.isFinite(start) || start < 0) throw new TypeError(`${label}.start must be a non-negative number`);
      const end = span.end == null ? null : span.end;
      if (end !== null && (!Number.isFinite(end) || end <= start)) throw new TypeError(`${label}.end must be null or greater than start`);
      // Optional per-span height multiplier: the same style, taller or
      // shorter, without needing a new catalogue entry. Omitted when 1 so the
      // saved file stays minimal.
      const heightScale = span.heightScale == null ? 1 : span.heightScale;
      if (!Number.isFinite(heightScale) || heightScale < BARRIER_HEIGHT_SCALE_RANGE.min || heightScale > BARRIER_HEIGHT_SCALE_RANGE.max) {
        throw new TypeError(`${label}.heightScale must be between ${BARRIER_HEIGHT_SCALE_RANGE.min} and ${BARRIER_HEIGHT_SCALE_RANGE.max}`);
      }
      canonical.push({
        side,
        start: roundMetres(start),
        end: end === null ? null : roundMetres(end),
        style: span.style,
        ...(Math.abs(heightScale - 1) > 1e-4 ? { heightScale: roundMetres(heightScale) } : {}),
        ...(typeof span.note === 'string' && span.note.trim() ? { note: span.note.trim().slice(0, 160) } : {}),
      });
    });
    if (canonical.length) routes[routeId] = canonical;
  }
  return { version: 1, routes };
}

/**
 * Collapses a route's spans into a per-side lookup: an array of
 * `{ start, end, style }` sorted by start, with later authored spans winning
 * over earlier ones wherever they overlap. js/map.js resolves one of these per
 * surface frame, so the flattening happens once per route rather than per
 * frame.
 */
export function flattenBarrierSpans(document, routeId, routeLength = Infinity) {
  const spans = document?.routes?.[routeId];
  const output = { 1: [], [-1]: [] };
  if (!Array.isArray(spans) || !spans.length) return output;
  for (const side of [1, -1]) {
    const key = side === 1 ? 'right' : 'left';
    /** @type {{start:number,end:number,style:string}[]} */
    let painted = [];
    for (const span of spans) {
      if (span.side !== 'both' && span.side !== key) continue;
      const start = Math.max(0, span.start);
      const end = span.end === null ? routeLength : Math.min(span.end, routeLength);
      if (!(end > start)) continue;
      // Later spans repaint: punch this interval out of everything already
      // painted, then append it.
      const next = [];
      for (const existing of painted) {
        if (existing.end <= start || existing.start >= end) { next.push(existing); continue; }
        if (existing.start < start) next.push({ ...existing, end: start });
        if (existing.end > end) next.push({ ...existing, start: end });
      }
      next.push({ start, end, style: span.style, heightScale: span.heightScale ?? 1 });
      painted = next;
    }
    painted.sort((a, b) => a.start - b.start);
    output[side] = painted;
  }
  return output;
}

/** Resolved span at one chainage on one side of a flattened lookup, or null. */
export function barrierSpanAt(flattened, side, distance) {
  const list = flattened?.[side];
  if (!list?.length) return null;
  for (const span of list) {
    if (distance >= span.start && distance < span.end) return span;
  }
  return null;
}

/** Style id at one chainage on one side of a flattened lookup. */
export function barrierStyleIdAt(flattened, side, distance) {
  return barrierSpanAt(flattened, side, distance)?.style ?? DEFAULT_BARRIER_STYLE_ID;
}

export const ROAD_BARRIER_PATHS = Object.freeze({
  source: 'data/road-barriers.json',
  module: 'data/road-barriers.js',
});

export function barrierModuleSource(document) {
  const canonical = canonicalizeBarrierDocument(document);
  return '// GENERATED by the HESI world editor (Barriers app) — edit there, not by hand.\n'
    + '// Source of truth: data/road-barriers.json. Style catalogue: js/road-barrier-styles.js.\n'
    + `export default ${JSON.stringify(canonical, null, 2)};\n`;
}

export function serializeBarrierDocument(document) {
  return `${JSON.stringify(canonicalizeBarrierDocument(document), null, 2)}\n`;
}
