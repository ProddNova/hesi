/**
 * The city's building catalogue — the single table both the generator and the
 * editor read.
 *
 * ONE TYPE IS ONE BUILDING. Every copy of a type in the world is the exact
 * same box: same width, same height, same depth, same UVs. That is what makes
 * a custom texture or a custom model assigned to a type land identically on
 * every copy of it — model it once in the editor, and the whole city follows.
 * (Before this table each building rolled its own random size, so a saved
 * model was stretched differently at every corner.)
 *
 * Sizes are not free-hand numbers: a type declares its window grid and the
 * size falls out of it, so windows never land half-cut at a corner or a roof.
 *
 *    width  = cols  * cellW * repeatX      depth = depthCols * cellW * repeatX
 *    height = rows  * cellH * repeatY
 *
 * `cellW`/`cellH` are the metres one window bay / one floor occupies, `cols`
 * and `rows` are what the 256x256 facade texture holds, and `repeatX/repeatY`
 * are how many times that texture repeats around and up the box. The facade
 * quads themselves carry plain 0..1 UVs (one wall = one image), which is the
 * blank canvas a custom texture is dropped onto: `fit: stretch` puts one copy
 * on each wall, `tile` repeats it however many times the editor asks for.
 *
 * Fields:
 *  - `slot`      the material name. It IS the identity of the type: the world
 *                surface the editor repaints, and — behind `facade:` — the
 *                worldModels key a custom model is saved under. The four
 *                legacy slots (facadeOffice/Dark/Hotel/Industrial) are kept on
 *                the types that inherit their role, so models saved before this
 *                catalogue existed still apply.
 *  - `group`     which placement tables may draw the type (see _buildCity).
 *  - `radius`    keep-out circle used when placing, in metres. Smaller than the
 *                box's half-diagonal on purpose: neighbours stand close, the
 *                way a real block does.
 *  - `blinker`   red aircraft warning light on the roof (the tall ones only).
 *
 * Deliberately NOT here: rooftop billboards, neon strips, water tanks,
 * antennas. Buildings are left as bare volumes so the user's own textures and
 * models are what dresses them.
 */

/** Grid -> metres, so a size can never drift out of step with its facade. */
function sized(entry) {
  const width = entry.cols * entry.cellW * (entry.repeatX ?? 1);
  const depth = entry.depthCols * entry.cellW * (entry.repeatX ?? 1);
  const height = entry.rows * entry.cellH * (entry.repeatY ?? 1);
  return Object.freeze({
    ...entry,
    repeatX: entry.repeatX ?? 1,
    repeatY: entry.repeatY ?? 1,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    depth: Math.round(depth * 100) / 100,
    radius: entry.radius ?? Math.round(Math.max(width, depth) * 0.56 * 10) / 10,
    blinker: entry.blinker ?? false,
  });
}

export const BUILDING_TYPES = Object.freeze([
  sized({
    id: 'shopRow', slot: 'facadeShop', label: 'Shop row', group: 'low',
    description: 'Two-storey shopfront row — the street-level filler between the blocks',
    cols: 7, depthCols: 5, cellW: 4.4, rows: 4, cellH: 3.6,
    base: '#1b1d24', lit: 0.62, warm: 0.72, seed: 0x5e6f70,
  }),
  sized({
    id: 'apartmentBlock', slot: 'facadeApartment', label: 'Apartment block', group: 'mid',
    description: 'Wide low-rise housing block with warm windows',
    cols: 12, depthCols: 8, cellW: 3.2, rows: 11, cellH: 3.0,
    base: '#191b20', lit: 0.5, warm: 0.82, seed: 0x6f7081,
  }),
  sized({
    id: 'darkBlock', slot: 'facadeDark', label: 'Dark block', group: 'mid',
    description: 'Mostly unlit mid-rise block — the quiet side of the street',
    cols: 9, depthCols: 8, cellW: 3.4, rows: 13, cellH: 3.3,
    base: '#0f1219', lit: 0.13, warm: 0.55, seed: 0x2b3c4d,
  }),
  sized({
    id: 'officeBlock', slot: 'facadeOffice', label: 'Office block', group: 'mid',
    description: 'Lit office block — the most common city building',
    cols: 10, depthCols: 9, cellW: 3.4, rows: 9, cellH: 3.3, repeatY: 2,
    base: '#141823', lit: 0.44, warm: 0.45, seed: 0x1a2b3c,
  }),
  sized({
    id: 'hotelSlab', slot: 'facadeHotel', label: 'Hotel slab', group: 'tall',
    description: 'Narrow-window hotel slab, warm lit',
    cols: 9, depthCols: 8, cellW: 2.8, rows: 14, cellH: 3.0, repeatY: 2,
    base: '#171a21', lit: 0.32, warm: 0.85, seed: 0x3c4d5e,
  }),
  sized({
    id: 'slimTower', slot: 'facadeSlim', label: 'Slim tower', group: 'tall',
    description: 'Thin residential tower — height without bulk, fits tight corners',
    cols: 6, depthCols: 6, cellW: 3.3, rows: 16, cellH: 3.25, repeatY: 2,
    base: '#151824', lit: 0.38, warm: 0.6, seed: 0x70819a, blinker: true,
  }),
  sized({
    id: 'officeTower', slot: 'facadeTower', label: 'Office tower', group: 'tall',
    description: 'Full office tower — the backbone of the C1 canyon',
    cols: 11, depthCols: 10, cellW: 3.6, rows: 12, cellH: 3.5, repeatY: 3,
    base: '#131722', lit: 0.4, warm: 0.4, seed: 0x819aab, blinker: true,
  }),
  sized({
    id: 'skyscraper', slot: 'facadeSky', label: 'Skyscraper', group: 'tall',
    description: 'The tallest thing standing — reads over the expressway from far away',
    cols: 15, depthCols: 14, cellW: 3.2, rows: 14, cellH: 3.6, repeatY: 4,
    base: '#10141d', lit: 0.3, warm: 0.3, seed: 0x9aabbc, blinker: true,
  }),
  sized({
    id: 'warehouse', slot: 'facadeIndustrial', label: 'Warehouse', group: 'industrial',
    description: 'Bay-side warehouse — big doors, few windows',
    cols: 10, depthCols: 6, cellW: 6.0, rows: 4, cellH: 5.0,
    base: '#171a1e', lit: 0.2, warm: 0.35, seed: 0x4d5e6f,
  }),
  sized({
    id: 'depotShed', slot: 'facadeDepot', label: 'Depot shed', group: 'industrial',
    description: 'Long low dock shed — the flat mass along the K1 and the port',
    cols: 16, depthCols: 8, cellW: 5.5, rows: 3, cellH: 4.5,
    base: '#16181d', lit: 0.12, warm: 0.3, seed: 0xabbccd,
  }),

  // ---------------------------------------------------------- the small six --
  // A type is one fixed box, so the ONLY way a street stops reading as copies
  // of itself is more types standing in it. The ten above are the city's big
  // masses; these six are the small ones that stand between them, and every
  // one of them has a footprint small enough to fit where the big boxes are
  // refused (_canPlaceBuilding) — which is exactly where the gaps were.
  sized({
    id: 'townHouse', slot: 'facadeTownHouse', label: 'Town house', group: 'low',
    description: 'Narrow three-storey infill house — what stands in the gap between two blocks',
    cols: 4, depthCols: 4, cellW: 3.2, rows: 3, cellH: 3.3,
    base: '#1a1d23', lit: 0.55, warm: 0.88, seed: 0x1c2d3e,
  }),
  sized({
    id: 'roadsideRetail', slot: 'facadeRetail', label: 'Roadside retail', group: 'low',
    description: 'Wide two-storey roadside store — flat, bright and low against the barrier',
    cols: 9, depthCols: 7, cellW: 3.6, rows: 2, cellH: 4.6,
    base: '#1d2028', lit: 0.7, warm: 0.66, seed: 0x2d3e4f,
  }),
  sized({
    id: 'tenementBlock', slot: 'facadeTenement', label: 'Tenement block', group: 'mid',
    description: 'Small six-storey walk-up — height on a footprint the big blocks cannot use',
    cols: 5, depthCols: 5, cellW: 3.4, rows: 6, cellH: 3.1,
    base: '#171a21', lit: 0.46, warm: 0.86, seed: 0x3e4f60,
  }),
  sized({
    id: 'worksOffice', slot: 'facadeWorksOffice', label: 'Works office', group: 'industrial',
    description: 'Four-storey office standing at the gate of a yard',
    cols: 6, depthCols: 4, cellW: 3.6, rows: 4, cellH: 3.4,
    base: '#161a22', lit: 0.4, warm: 0.5, seed: 0x4f6071,
  }),
  sized({
    id: 'machineWorks', slot: 'facadeWorks', label: 'Machine works', group: 'industrial',
    description: 'Factory hall — taller and half the length of a depot shed',
    cols: 8, depthCols: 5, cellW: 5.0, rows: 3, cellH: 5.4,
    base: '#181b20', lit: 0.24, warm: 0.42, seed: 0x607182,
  }),
  sized({
    id: 'coldStore', slot: 'facadeColdStore', label: 'Cold store', group: 'industrial',
    description: 'Blank refrigerated block — the one thing with height in a low industrial band',
    cols: 7, depthCols: 7, cellW: 4.0, rows: 8, cellH: 3.6,
    base: '#13161c', lit: 0.06, warm: 0.4, seed: 0x718293,
  }),
]);

/** Material slot -> type, the lookup both the generator and the editor use. */
export const BUILDING_TYPE_BY_SLOT = Object.freeze(
  Object.fromEntries(BUILDING_TYPES.map((type) => [type.slot, type])),
);

/** Every type in a placement group ('low' | 'mid' | 'tall' | 'industrial'). */
export function buildingTypesInGroup(group) {
  return BUILDING_TYPES.filter((type) => type.group === group);
}

/** The one shared roof-cap material every type is topped with. */
export const BUILDING_ROOF_SLOT = 'building';
