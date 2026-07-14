#!/usr/bin/env node
/**
 * SHUTOKO NIGHTS — one-off OSM extractor.
 *
 * Queries the Overpass API for the real Shuto Expressway subset the game
 * drives (C1, Route 11 + Rainbow Bridge, Bayshore B between Tatsumi and
 * Daikoku, Route 9 Fukagawa, K1 Yokohane between Heiwajima and Daikoku,
 * plus every motorway_link interconnecting them), converts it to local
 * metres, builds a topology graph of one-way carriageway chains + ramp
 * chains with diverge/merge/continuation connections, assigns and smooths
 * elevation from layer/bridge/tunnel tags, enforces plan-separation and
 * vertical clearance, Douglas-Peucker-simplifies the geometry and writes:
 *
 *   data/routes.json  — canonical committed network (the game's ground truth)
 *   data/routes.js    — same payload as an ES module (no runtime fetch/API)
 *   tools/debug-map.svg — quick visual sanity check of the extracted shape
 *
 * The game NEVER talks to any API: this script is run offline by a
 * developer and its output is committed. Raw Overpass responses are cached
 * in tools/cache/ so re-runs are instant and reproducible.
 *
 * Usage:  node tools/extract-osm.js [--refresh] [--offline]
 *   --refresh  ignore the cache and re-query Overpass
 *   --offline  fail if the cache is missing instead of querying
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ORIGIN = { lat: 35.68, lon: 139.77 };      // ~Nihonbashi; +X east, +Z north
const BBOX = { s: 35.42, w: 139.60, n: 35.73, e: 139.87 }; // Tokyo + Yokohama bay
const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

const LANE_W = 3.5;
const MAIN_SHOULDER = 1.3;
const RAMP_SHOULDER = 0.95;
const LAYER_STEP = 12;        // metres of elevation per OSM layer step
const TUNNEL_Y = -15;         // base elevation of a layer=-1 tunnel
const MAX_GRADE = 0.06;       // 6 %
const MIN_CLEARANCE = 6.5;    // deck-to-deck at crossings (>= 5.5 m headroom + structure)
const DP_TOLERANCE = 2.0;     // Douglas-Peucker simplification tolerance (m)

// Route groups. `match` is tested against way name / ref. `clip` trims the
// group to the game's subset (the real routes continue far beyond it).
// The connector lines (r1 Haneda, r6 Mukojima stub, k5 Daikoku) are how the
// named routes REALLY interconnect: R11 meets C1 through the Haneda line at
// Hamazakibashi, R9 meets C1 through the Mukojima line at Edobashi, and K1
// reaches Daikoku JCT over the K5 Daikoku line from Namamugi.
const GROUPS = [
  {
    id: 'c1', code: 'C1', name: 'C1 Inner Loop', nameJa: '都心環状線',
    kind: 'loop', match: /都心環状/, ref: /^C1$/, speedLimit: 80,
    destinations: [['都心環状', 'C1 LOOP'], ['銀座', 'GINZA'], ['芝浦', 'SHIBAURA'], ['神田橋', 'KANDABASHI']],
  },
  {
    id: 'r11', code: '11', name: 'Route 11 Daiba', nameJa: '台場線',
    kind: 'connector', match: /台場線/, ref: /^11$/, speedLimit: 80,
    destinations: [['台場', 'DAIBA'], ['湾岸線', 'WANGAN'], ['レインボーブリッジ', 'RAINBOW BRIDGE']],
  },
  {
    id: 'wangan', code: 'B', name: 'Wangan Bayshore', nameJa: '湾岸線',
    kind: 'arterial', match: /湾岸線/, ref: /^B$/, speedLimit: 100,
    // Tatsumi (NE) to just past Daikoku (SW). Trim the Bayshore beyond.
    clip: { minLat: 35.451, maxLat: 35.662, maxLon: 139.824 },
    destinations: [['湾岸線', 'WANGAN LINE'], ['大黒', 'DAIKOKU'], ['羽田', 'HANEDA'], ['空港中央', 'AIRPORT']],
  },
  {
    id: 'r9', code: '9', name: 'Route 9 Fukagawa', nameJa: '深川線',
    kind: 'connector', match: /深川線/, ref: /^9$/, speedLimit: 80,
    destinations: [['深川', 'FUKAGAWA'], ['都心環状', 'C1 LOOP'], ['箱崎', 'HAKOZAKI']],
  },
  {
    id: 'r1', code: '1', name: 'Route 1 Haneda', nameJa: '羽田線',
    kind: 'arterial', match: /羽田線/, ref: /^$/, speedLimit: 80, // ref 1 is ambiguous (Ueno line)
    // Hamazakibashi JCT (C1) down past Heiwajima PA to Haneda (K1 start).
    clip: { maxLat: 35.660, minLat: 35.52 },
    destinations: [['羽田', 'HANEDA'], ['平和島', 'HEIWAJIMA'], ['横浜', 'YOKOHAMA']],
  },
  {
    id: 'r6', code: '6', name: 'Route 6 Mukojima', nameJa: '向島線',
    kind: 'connector', match: /向島線/, ref: /^$/, speedLimit: 60, // ref 6 is ambiguous (Misato line)
    // Only the Edobashi (C1) - Hakozaki (R9) stitch.
    clip: { maxLat: 35.6885, maxLon: 139.792 },
    destinations: [['箱崎', 'HAKOZAKI'], ['都心環状', 'C1 LOOP']],
  },
  {
    id: 'k1', code: 'K1', name: 'K1 Yokohane', nameJa: '横羽線',
    kind: 'arterial', match: /横羽線/, ref: /^K1$/, speedLimit: 80,
    // Haneda down to Namamugi JCT (where K5 splits for Daikoku).
    clip: { minLat: 35.478 },
    destinations: [['横羽線', 'K1 YOKOHANE'], ['大黒', 'DAIKOKU'], ['羽田', 'HANEDA'], ['横浜', 'YOKOHAMA']],
  },
  {
    id: 'k5', code: 'K5', name: 'K5 Daikoku', nameJa: '大黒線',
    kind: 'connector', match: /大黒線/, ref: /^K5$/, speedLimit: 60,
    destinations: [['大黒', 'DAIKOKU'], ['大黒PA', 'DAIKOKU PA'], ['湾岸線', 'WANGAN']],
  },
];

// Parking areas. OSM centroids are used when found (matched by name);
// the coordinates below are fallbacks and sanity anchors.
const SERVICE_AREAS = [
  { id: 'shibaura_pa', name: 'Shibaura PA', nameJa: '芝浦', match: /芝浦.*(パーキング|PA)/, lat: 35.6427, lon: 139.7550, groups: ['r11'], hasGarage: true, density: 'medium', width: 118, length: 250 },
  { id: 'tatsumi_pa', name: 'Tatsumi PA', nameJa: '辰巳', match: /辰巳第一.*(パーキング|PA)/, lat: 35.6482, lon: 139.8109, groups: ['r9', 'wangan'], density: 'light', width: 100, length: 215 },
  { id: 'heiwajima_pa', name: 'Heiwajima PA', nameJa: '平和島', match: /平和島.*(パーキング|PA)/, lat: 35.5787, lon: 139.7428, groups: ['r1'], density: 'light', width: 104, length: 225 },
  { id: 'daikoku_pa', name: 'Daikoku PA', nameJa: '大黒', match: /大黒.*(パーキング|PA)/, lat: 35.4590, lon: 139.6846, groups: ['wangan', 'k5'], density: 'packed', width: 150, length: 230 },
];

// Land slabs (dressing only; water fills everything else). Authored in
// lat/lon so they stay geographically true under the projection.
const TERRAIN_SLABS = [
  { name: 'central Tokyo', lat: 35.690, lon: 139.755, w: 11000, d: 8000 },
  { name: 'Koto / Tatsumi land', lat: 35.655, lon: 139.815, w: 8000, d: 5200 },
  { name: 'Daiba island', lat: 35.627, lon: 139.780, w: 4200, d: 2800 },
  { name: 'Shinagawa waterfront', lat: 35.615, lon: 139.748, w: 6000, d: 4200 },
  { name: 'Oi / Haneda strip', lat: 35.556, lon: 139.766, w: 7000, d: 6500 },
  { name: 'Keihin industrial belt', lat: 35.510, lon: 139.717, w: 9000, d: 6500 },
  { name: 'Kawasaki Ukishima', lat: 35.492, lon: 139.760, w: 5000, d: 3200 },
  { name: 'Daikoku island', lat: 35.4620, lon: 139.690, w: 4200, d: 3400 },
];

const OVERPASS_MIRRORS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const CACHE_DIR = path.join(__dirname, 'cache');
const OUT_JSON = path.join(__dirname, '..', 'data', 'routes.json');
const OUT_ESM = path.join(__dirname, '..', 'data', 'routes.js');
const OUT_SVG = path.join(__dirname, 'debug-map.svg');

const argv = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

function project(lat, lon) {
  // Equirectangular around ORIGIN, real 1:1 metres. +X east, +Z north.
  const x = (lon - ORIGIN.lon) * DEG * Math.cos(ORIGIN.lat * DEG) * EARTH_R;
  const z = (lat - ORIGIN.lat) * DEG * EARTH_R;
  return [x, z];
}

function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return total;
}

/** Distance from point p to segment ab in the XZ plane, plus the segment parameter. */
function pointSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq)) : 0;
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return { d: Math.hypot(px - cx, pz - cz), t, cx, cz };
}

/** XZ intersection of segments a0a1 / b0b1 (proper crossings only). */
function segmentIntersection(a0, a1, b0, b1) {
  const d1x = a1[0] - a0[0];
  const d1z = a1[1] - a0[1];
  const d2x = b1[0] - b0[0];
  const d2z = b1[1] - b0[1];
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b0[0] - a0[0]) * d2z - (b0[1] - a0[1]) * d2x) / denom;
  const u = ((b0[0] - a0[0]) * d1z - (b0[1] - a0[1]) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: a0[0] + d1x * t, z: a0[1] + d1z * t };
}

/** Douglas-Peucker on [x,z] with a parallel payload array kept in sync. */
function simplifyDP(points, payloads, tolerance) {
  if (points.length <= 2) return { points: points.slice(), payloads: payloads.map((p) => p.slice()) };
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i += 1) {
      const { d } = pointSegment(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1]);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  const outPoints = [];
  const outPayloads = payloads.map(() => []);
  for (let i = 0; i < points.length; i += 1) {
    if (!keep[i]) continue;
    outPoints.push(points[i]);
    payloads.forEach((payload, j) => outPayloads[j].push(payload[i]));
  }
  return { points: outPoints, payloads: outPayloads };
}

/** Arc-length table for a chain's [x,z] points. */
function arcLengths(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i += 1) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return s;
}

/** Project (x,z) onto a chain polyline; returns {distance, d, index}. */
function projectToChain(chain, x, z) {
  let best = null;
  for (let i = 0; i < chain.pts.length - 1; i += 1) {
    const seg = pointSegment(x, z, chain.pts[i][0], chain.pts[i][1], chain.pts[i + 1][0], chain.pts[i + 1][1]);
    if (!best || seg.d < best.d) {
      best = { d: seg.d, distance: chain.arc[i] + seg.t * (chain.arc[i + 1] - chain.arc[i]), index: i, t: seg.t, cx: seg.cx, cz: seg.cz };
    }
  }
  return best;
}

function sampleChain(chain, distance) {
  const s = Math.max(0, Math.min(chain.arc[chain.arc.length - 1], distance));
  let i = 0;
  while (i < chain.arc.length - 2 && chain.arc[i + 1] < s) i += 1;
  const span = Math.max(1e-9, chain.arc[i + 1] - chain.arc[i]);
  const t = (s - chain.arc[i]) / span;
  const x = chain.pts[i][0] + (chain.pts[i + 1][0] - chain.pts[i][0]) * t;
  const z = chain.pts[i][1] + (chain.pts[i + 1][1] - chain.pts[i][1]) * t;
  const y = chain.elev[i] + (chain.elev[i + 1] - chain.elev[i]) * t;
  const tx = (chain.pts[i + 1][0] - chain.pts[i][0]) / span;
  const tz = (chain.pts[i + 1][1] - chain.pts[i][1]) / span;
  return { x, z, y, tx, tz, index: i };
}

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------

async function overpass(name, query) {
  const cacheFile = path.join(CACHE_DIR, `${name}.json`);
  if (!argv.has('--refresh') && fs.existsSync(cacheFile)) {
    console.log(`  [cache] ${name}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  if (argv.has('--offline')) throw new Error(`--offline set but no cache for ${name}`);
  let lastError = null;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        console.log(`  [query] ${name} via ${new URL(mirror).host} (attempt ${attempt + 1})`);
        const response = await fetch(mirror, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(json));
        return json;
      } catch (error) {
        lastError = error;
        console.warn(`    failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function fetchOsm() {
  const bbox = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;
  const roads = await overpass('roads', `
    [out:json][timeout:300][bbox:${bbox}];
    (
      way["highway"="motorway"];
      way["highway"="motorway_link"];
    );
    out body; >; out skel qt;`);
  const pas = await overpass('service-areas', `
    [out:json][timeout:120][bbox:${bbox}];
    (
      way["highway"="services"];
      way["highway"="rest_area"];
      node["highway"="services"];
      node["highway"="rest_area"];
      way["amenity"="parking"]["name"~"パーキングエリア|PA"];
    );
    out body center; >; out skel qt;`);
  return { roads, pas };
}

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

function indexElements(osm) {
  const nodes = new Map();
  const ways = new Map();
  for (const el of osm.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
  }
  return { nodes, ways };
}

function classifyWay(way) {
  const tags = way.tags || {};
  const name = tags.name || '';
  const ref = tags.ref || '';
  for (const group of GROUPS) {
    if (group.match.test(name) || group.ref.test(ref)) return group.id;
  }
  return null;
}

function nodeInside(node, clip) {
  if (!node) return false;
  if (clip.minLat !== undefined && node.lat < clip.minLat) return false;
  if (clip.maxLat !== undefined && node.lat > clip.maxLat) return false;
  if (clip.minLon !== undefined && node.lon < clip.minLon) return false;
  if (clip.maxLon !== undefined && node.lon > clip.maxLon) return false;
  return true;
}

/**
 * Node-level clipping: returns the way itself when fully inside, otherwise
 * synthetic sub-ways for each inside run of >= 2 consecutive nodes (so long
 * boundary-crossing ways are trimmed at the boundary, not dropped whole).
 * The original way is flagged `clipped` so later passes never resurrect
 * the outside part.
 */
function clipWay(way, nodes, clip) {
  if (!clip) return [way];
  const inside = way.nodes.map((id) => nodeInside(nodes.get(id), clip));
  if (inside.every(Boolean)) return [way];
  way.clipped = true;
  const pieces = [];
  let run = [];
  for (let i = 0; i < way.nodes.length; i += 1) {
    if (inside[i]) {
      run.push(way.nodes[i]);
    } else if (run.length) {
      if (run.length >= 2) pieces.push(run);
      run = [];
    }
  }
  if (run.length >= 2) pieces.push(run);
  return pieces.map((nodeIds, index) => ({
    id: `${way.id}#${index}`,
    type: 'way',
    nodes: nodeIds,
    tags: way.tags,
    synthetic: true,
  }));
}

/**
 * Way-level base elevation from bridge/tunnel/layer tags.
 * layer >= 1 viaduct: 12 m per layer. Tunnels: -15 m at layer -1, deeper
 * below. Unlayered bridges count as layer 1. At-grade motorway: +2 m
 * (Shutoko at-grade sections still ride on low embankments).
 */
function wayElevation(tags) {
  const layer = Number.parseInt(tags.layer ?? '', 10);
  const hasLayer = Number.isFinite(layer);
  if (tags.tunnel && tags.tunnel !== 'no') {
    const l = hasLayer ? Math.min(layer, -1) : -1;
    return TUNNEL_Y + (l + 1) * LAYER_STEP;
  }
  if (tags.bridge && tags.bridge !== 'no') {
    const l = hasLayer ? Math.max(layer, 1) : 1;
    return l * LAYER_STEP;
  }
  if (hasLayer && layer > 0) return layer * LAYER_STEP;
  return 2;
}

function parseLanes(tags, fallback) {
  const lanes = Number.parseInt(tags.lanes ?? '', 10);
  if (Number.isFinite(lanes) && lanes >= 1 && lanes <= 5) return lanes;
  return fallback;
}

function parseMaxspeed(tags) {
  const speed = Number.parseInt(String(tags.maxspeed ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(speed) && speed >= 30 && speed <= 120 ? speed : null;
}

/**
 * Stitch a set of directed ways (already oriented along oneway travel) into
 * maximal chains. Ways connect where they share an endpoint node id.
 * Returns chains of way objects with node id lists concatenated.
 */
function buildChains(wayIds, ways, label) {
  const startsAt = new Map(); // first node id -> way ids
  const remaining = new Set(wayIds);
  for (const id of wayIds) {
    const first = ways.get(id).nodes[0];
    if (!startsAt.has(first)) startsAt.set(first, []);
    startsAt.get(first).push(id);
  }
  // Count how many kept ways END at each node, so chains begin at true heads.
  const endsAt = new Map();
  for (const id of wayIds) {
    const last = ways.get(id).nodes[ways.get(id).nodes.length - 1];
    endsAt.set(last, (endsAt.get(last) || 0) + 1);
  }
  const chains = [];
  const takeChain = (seedId) => {
    const chainWays = [];
    let current = seedId;
    while (current && remaining.has(current)) {
      remaining.delete(current);
      chainWays.push(current);
      const way = ways.get(current);
      const tail = way.nodes[way.nodes.length - 1];
      const nextCandidates = (startsAt.get(tail) || []).filter((id) => remaining.has(id));
      // Follow only unambiguous continuations: a fork means a junction — the
      // chain ends there and each branch becomes its own chain.
      current = nextCandidates.length === 1 ? nextCandidates[0] : null;
      if (nextCandidates.length > 1) break;
    }
    if (chainWays.length) chains.push(chainWays);
  };
  // Heads first (no kept way ends at their first node)…
  for (const id of wayIds) {
    if (!remaining.has(id)) continue;
    const first = ways.get(id).nodes[0];
    const feeders = endsAt.get(first) || 0;
    const siblingStarts = (startsAt.get(first) || []).length;
    if (feeders === 0 || feeders > 1 || siblingStarts > 1) takeChain(id);
  }
  // …then whatever is left (pure loops).
  for (const id of wayIds) if (remaining.has(id)) takeChain(id);
  console.log(`  ${label}: ${wayIds.length} ways -> ${chains.length} chains`);
  return chains;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('SHUTOKO NIGHTS OSM extractor');
  console.log('— fetching…');
  const { roads, pas } = await fetchOsm();
  const { nodes, ways } = indexElements(roads);
  console.log(`  raw: ${ways.size} ways, ${nodes.size} nodes`);

  // -- classify + orient ----------------------------------------------------
  const groupWays = new Map(GROUPS.map((group) => [group.id, []]));
  const linkWays = [];
  let reversedCount = 0;
  let twoWayMainlines = 0;
  for (const way of ways.values()) {
    const tags = way.tags || {};
    if (way.synthetic) continue; // clip pieces added during this loop
    if (!way.nodes || way.nodes.length < 2) continue;
    // Orient every way along its direction of travel.
    if (tags.oneway === '-1') {
      way.nodes.reverse();
      reversedCount += 1;
    }
    if (tags.highway === 'motorway_link') {
      linkWays.push(way.id);
      continue;
    }
    const groupId = classifyWay(way);
    if (!groupId) continue;
    const group = GROUPS.find((entry) => entry.id === groupId);
    const pieces = clipWay(way, nodes, group.clip);
    if (!pieces.length) continue;
    if (!tags.oneway || tags.oneway === 'no') twoWayMainlines += 1; // rare; treated as oneway
    for (const piece of pieces) {
      if (piece !== way) ways.set(piece.id, piece);
      groupWays.get(groupId).push(piece.id);
    }
  }
  if (twoWayMainlines) console.warn(`  note: ${twoWayMainlines} mainline ways lack oneway=yes (treated as one-way)`);

  // Absorb unnamed connector pieces: a short motorway way whose both
  // endpoints touch ways of exactly one group belongs to that group.
  const nodeGroups = new Map(); // node id -> Set(groupId)
  for (const [groupId, ids] of groupWays) {
    for (const id of ids) {
      for (const nodeId of ways.get(id).nodes) {
        if (!nodeGroups.has(nodeId)) nodeGroups.set(nodeId, new Set());
        nodeGroups.get(nodeId).add(groupId);
      }
    }
  }
  let absorbed = 0;
  for (const way of ways.values()) {
    const tags = way.tags || {};
    if (tags.highway !== 'motorway' || classifyWay(way) || way.clipped || way.synthetic) continue;
    const headGroups = nodeGroups.get(way.nodes[0]);
    const tailGroups = nodeGroups.get(way.nodes[way.nodes.length - 1]);
    if (!headGroups || !tailGroups) continue;
    const common = [...headGroups].filter((groupId) => tailGroups.has(groupId));
    if (common.length === 1) {
      groupWays.get(common[0]).push(way.id);
      absorbed += 1;
    }
  }
  if (absorbed) console.log(`  absorbed ${absorbed} unnamed connector ways into their groups`);

  // Bridge remaining mainline gaps: inside big JCTs the through carriageway
  // is often mapped under the crossing route's name or as motorway_link.
  // Find dead tails, path-search (<= 1.5 km) through unclassified ways to a
  // dead head of the SAME group, and absorb the path.
  bridgeGaps(groupWays, ways, nodes);
  const claimed = new Set();
  for (const ids of groupWays.values()) for (const id of ids) claimed.add(id);
  const linkWaysFiltered = linkWays.filter((id) => !claimed.has(id));
  for (const group of GROUPS) console.log(`  ${group.id}: ${groupWays.get(group.id).length} mainline ways`);
  console.log(`  motorway_link candidates: ${linkWays.length} (${reversedCount} ways re-oriented)`);

  // -- mainline chains -------------------------------------------------------
  /** chain = { id, group, kind, nodeIds, pts[[x,z]], elev[], lanes, speed,
   *            tunnelFlags[], bridgeFlags[], closed } */
  const chains = [];
  const chainByNode = new Map(); // node id -> [{chain, index}]
  const registerChain = (chain) => {
    chain.arc = arcLengths(chain.pts);
    chains.push(chain);
    chain.nodeIds.forEach((nodeId, index) => {
      if (!chainByNode.has(nodeId)) chainByNode.set(nodeId, []);
      chainByNode.get(nodeId).push({ chain, index });
    });
  };

  const buildChainRecord = (chainWays, group, kind, index) => {
    const nodeIds = [];
    const perNode = []; // {elev, tunnel, bridge, lanes, speed}
    let laneVotes = new Map();
    let speedVotes = new Map();
    for (const wayId of chainWays) {
      const way = ways.get(wayId);
      const tags = way.tags || {};
      const elevation = wayElevation(tags);
      const tunnel = !!(tags.tunnel && tags.tunnel !== 'no');
      const bridge = !!(tags.bridge && tags.bridge !== 'no');
      const lanes = parseLanes(tags, null);
      const speed = parseMaxspeed(tags);
      const wayLen = way.nodes.length;
      if (lanes) laneVotes.set(lanes, (laneVotes.get(lanes) || 0) + wayLen);
      if (speed) speedVotes.set(speed, (speedVotes.get(speed) || 0) + wayLen);
      way.nodes.forEach((nodeId, nodeIndex) => {
        if (nodeIds.length && nodeIds[nodeIds.length - 1] === nodeId) return; // shared junction node
        if (nodeIndex === 0 && nodeIds.length) {
          // disjoint jump inside a chain should not happen (buildChains guards it)
        }
        nodeIds.push(nodeId);
        perNode.push({ elevation, tunnel, bridge });
      });
    }
    const pts = nodeIds.map((nodeId) => {
      const node = nodes.get(nodeId);
      return project(node.lat, node.lon);
    });
    const majority = (votes, fallback) => {
      let best = fallback;
      let bestCount = -1;
      for (const [value, count] of votes) if (count > bestCount) { best = value; bestCount = count; }
      return best;
    };
    const closed = nodeIds.length > 3 && nodeIds[0] === nodeIds[nodeIds.length - 1];
    if (closed) {
      nodeIds.pop();
      pts.pop();
      perNode.pop();
    }
    return {
      id: `${group.id}_${index}`,
      group: group.id,
      kind,
      nodeIds,
      pts,
      elev: perNode.map((entry) => entry.elevation),
      tunnelFlags: perNode.map((entry) => entry.tunnel),
      bridgeFlags: perNode.map((entry) => entry.bridge),
      lanes: majority(laneVotes, kind === 'ramp' ? 1 : 2),
      speedLimit: majority(speedVotes, group.speedLimit || 60),
      closed,
      synthetic: false,
    };
  };

  for (const group of GROUPS) {
    const chainWayLists = buildChains(groupWays.get(group.id), ways, group.id);
    let records = chainWayLists.map((chainWays, index) => buildChainRecord(chainWays, group, 'mainline', index));
    records = mergeChainFragments(records, group.id);
    records.forEach((chain, index) => {
      chain.id = `${group.id}_${index}`;
      registerChain(chain);
    });
  }

  console.log(`  mainline chains: ${chains.map((chain) => `${chain.id}${chain.closed ? '(closed)' : ''}`).join(', ')}`);

  // -- ramp chains ------------------------------------------------------------
  // Keep link chains whose BOTH endpoints land on kept chains (mainline or,
  // transitively, other kept links) — i.e. ramps interconnecting the subset.
  // Link chains touching a PA centroid are kept with one open end.
  const linkChainLists = buildChains(linkWaysFiltered, ways, 'links');
  const mainlineNodeSet = new Set(chainByNode.keys());
  const linkGroup = { id: 'ramp', speedLimit: 50 };
  const linkRecords = linkChainLists.map((chainWays, index) => buildChainRecord(chainWays, linkGroup, 'ramp', index));

  const paCentroids = extractPaCentroids(pas);
  const nearPa = (chain) => {
    for (const pa of SERVICE_AREAS) {
      const centroid = paCentroids.get(pa.id) || project(pa.lat, pa.lon);
      for (const pt of chain.pts) {
        if (dist2(pt[0], pt[1], centroid[0], centroid[1]) < 400 * 400) return pa.id;
      }
    }
    return null;
  };

  const keptLinks = new Set();
  let changed = true;
  const linkEndpointNodes = (record) => [record.nodeIds[0], record.nodeIds[record.nodeIds.length - 1]];
  const attachedNodeSet = new Set(mainlineNodeSet);
  while (changed) {
    changed = false;
    for (let i = 0; i < linkRecords.length; i += 1) {
      if (keptLinks.has(i)) continue;
      const record = linkRecords[i];
      const [head, tail] = linkEndpointNodes(record);
      const headAttached = attachedNodeSet.has(head);
      const tailAttached = attachedNodeSet.has(tail);
      const paId = nearPa(record);
      if ((headAttached && tailAttached) || (paId && (headAttached || tailAttached))) {
        keptLinks.add(i);
        record.paId = paId;
        for (const nodeId of record.nodeIds) attachedNodeSet.add(nodeId);
        changed = true;
      }
    }
  }
  let rampIndex = 0;
  for (const index of [...keptLinks].sort((a, b) => a - b)) {
    const record = linkRecords[index];
    if (polylineLength(record.pts) < 45) continue; // stub fragments
    record.id = `ramp_${rampIndex}`;
    rampIndex += 1;
    registerChain(record);
  }
  console.log(`  kept ${rampIndex} ramp chains (of ${linkRecords.length} link chains)`);

  // -- connections -----------------------------------------------------------
  // Ground truth: chains connect ONLY where OSM says they share a node.
  const connections = []; // {fromChain, fromDistance, toChain, toDistance, kind, nodeId}
  const junctionNames = extractJunctionNames(roads);

  for (const chain of chains) {
    const head = chain.closed ? null : chain.nodeIds[0];
    const tail = chain.closed ? null : chain.nodeIds[chain.nodeIds.length - 1];
    // head: someone flows INTO this chain start (handled from the other side);
    // tail: this chain flows into whatever shares the node.
    if (tail !== null) {
      for (const { chain: other, index } of chainByNode.get(tail) || []) {
        if (other === chain) continue;
        const atStart = index === 0 && !other.closed;
        const atEnd = index === other.nodeIds.length - 1 && !other.closed;
        if (atEnd) continue; // their tail — the other side will link to us if needed
        connections.push({
          fromChain: chain,
          fromDistance: chain.arc[chain.arc.length - 1],
          toChain: other,
          toDistance: atStart ? 0 : other.arc[index],
          kind: atStart ? 'continuation' : 'merge',
          nodeId: tail,
        });
      }
    }
    if (head !== null) {
      for (const { chain: other, index } of chainByNode.get(head) || []) {
        if (other === chain) continue;
        const atEnd = (index === other.nodeIds.length - 1) && !other.closed;
        if (atEnd) continue; // covered as their tail continuation
        const atStart = index === 0 && !other.closed;
        if (atStart) continue; // two chains starting at one node — no flow
        connections.push({
          fromChain: other,
          fromDistance: other.arc[index],
          toChain: chain,
          toDistance: 0,
          kind: 'diverge',
          nodeId: head,
        });
      }
    }
  }
  console.log(`  ${connections.length} raw connections`);

  // -- graph surgery -------------------------------------------------------------
  pruneExternalStubs(chains, connections);
  stitchDanglingEnds(chains, connections, registerChain);

  // -- elevation solve ---------------------------------------------------------
  solveElevations(chains, connections);

  // -- vertical clearance at plan crossings -------------------------------------
  enforceClearance(chains, connections);

  // -- plan separation between parallel carriageways ----------------------------
  enforceSeparation(chains, connections);

  // -- simplify -----------------------------------------------------------------
  let pointsBefore = 0;
  let pointsAfter = 0;
  for (const chain of chains) {
    pointsBefore += chain.pts.length;
    const closedExtra = chain.closed ? [chain.pts[0]] : [];
    const pts = chain.pts.concat(closedExtra);
    const payloads = [
      chain.elev.concat(chain.closed ? [chain.elev[0]] : []),
      chain.tunnelFlags.concat(chain.closed ? [chain.tunnelFlags[0]] : []),
      chain.bridgeFlags.concat(chain.closed ? [chain.bridgeFlags[0]] : []),
    ];
    const result = simplifyDP(pts, payloads, DP_TOLERANCE);
    chain.pts = result.points;
    chain.elev = result.payloads[0];
    chain.tunnelFlags = result.payloads[1];
    chain.bridgeFlags = result.payloads[2];
    if (chain.closed) {
      chain.pts.pop();
      chain.elev.pop();
      chain.tunnelFlags.pop();
      chain.bridgeFlags.pop();
    }
    chain.arc = arcLengths(chain.closed ? chain.pts.concat([chain.pts[0]]) : chain.pts);
    if (chain.closed) chain.arc.pop();
    pointsAfter += chain.pts.length;
  }
  console.log(`  simplified ${pointsBefore} -> ${pointsAfter} points (${(100 * pointsAfter / pointsBefore).toFixed(1)} %)`);

  // Re-resolve connection distances on simplified geometry via node position.
  for (const connection of connections) {
    const node = connection.nodeId ? nodes.get(connection.nodeId) : null;
    const [x, z] = node ? project(node.lat, node.lon) : connection.point;
    connection.point = [x, z];
    connection.fromDistance = projectToChain(connection.fromChain, x, z).distance;
    connection.toDistance = projectToChain(connection.toChain, x, z).distance;
  }

  // -- synthetic U-turns at subset cut ends --------------------------------------
  synthesizeUturns(chains, connections, registerChain);

  // -- drop anything not reachable from the main network --------------------------
  const anchorChain = chains.reduce((longest, chain) => (
    chain.kind === 'mainline' && (!longest || chain.arc[chain.arc.length - 1] > longest.arc[longest.arc.length - 1])
      ? chain : longest), null);
  pruneDisconnected(chains, connections, anchorChain?.id);

  // -- tunnel/bridge zones ---------------------------------------------------------
  for (const chain of chains) {
    chain.tunnels = flagZones(chain, chain.tunnelFlags);
    chain.bridges = flagZones(chain, chain.bridgeFlags);
  }

  // -- junctions -------------------------------------------------------------------
  const junctions = buildJunctions(chains, connections, junctionNames, nodes);

  // -- service areas ------------------------------------------------------------------
  const serviceAreas = buildServiceAreas(chains, paCentroids);

  // -- destinations (from link destination tags) -----------------------------------------
  attachDestinations(chains, ways, nodes);

  // -- emit ---------------------------------------------------------------------------
  emit(chains, connections, junctions, serviceAreas, { ways: ways.size, nodes: nodes.size, pointsBefore, pointsAfter });
}

function wayLength(way, nodes) {
  let total = 0;
  for (let i = 1; i < way.nodes.length; i += 1) {
    const a = nodes.get(way.nodes[i - 1]);
    const b = nodes.get(way.nodes[i]);
    if (!a || !b) continue;
    const [ax, az] = project(a.lat, a.lon);
    const [bx, bz] = project(b.lat, b.lon);
    total += Math.hypot(bx - ax, bz - az);
  }
  return total;
}

/**
 * Bridge mainline gaps through unclassified ways. A group's chain graph has a
 * "dead tail" where no same-group way continues; if a short (<= 1.5 km) path
 * of unclassified motorway/motorway_link ways leads from it to a same-group
 * "dead head", the path IS the missing carriageway piece — absorb it.
 */
function bridgeGaps(groupWays, ways, nodes) {
  const inGroup = new Set();
  for (const ids of groupWays.values()) for (const id of ids) inGroup.add(id);
  // Node-level directed graph over every unclassified motorway/link segment
  // (bridges regularly attach INSIDE ways, not at way boundaries).
  const backward = new Map(); // node -> [{prev, way}]
  for (const way of ways.values()) {
    const tags = way.tags || {};
    if (way.clipped || inGroup.has(way.id)) continue;
    if (tags.highway !== 'motorway' && tags.highway !== 'motorway_link') continue;
    for (let i = 1; i < way.nodes.length; i += 1) {
      const to = way.nodes[i];
      if (!backward.has(to)) backward.set(to, []);
      backward.get(to).push({ prev: way.nodes[i - 1], way });
    }
  }
  const nodeDistance = (a, b) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    const [ax, az] = project(na.lat, na.lon);
    const [bx, bz] = project(nb.lat, nb.lon);
    return Math.hypot(bx - ax, bz - az);
  };
  let bridged = 0;
  for (const [groupId, ids] of groupWays) {
    const headsSet = new Set();
    const tailsSet = new Set();
    const groupNodes = new Set();
    for (const id of ids) {
      const way = ways.get(id);
      headsSet.add(way.nodes[0]);
      tailsSet.add(way.nodes[way.nodes.length - 1]);
      for (const nodeId of way.nodes) groupNodes.add(nodeId);
    }
    // A dead head is a chain source with no same-group feeder: the missing
    // carriageway piece flows INTO it. Walk the node graph backwards until
    // any same-group node is reached, then absorb the path as one way.
    const deadHeads = [...headsSet].filter((node) => !tailsSet.has(node));
    for (const target of deadHeads) {
      const queue = [{ node: target, dist: 0, path: [target], wayVotes: new Map() }];
      const seen = new Map([[target, 0]]);
      let found = null;
      while (queue.length && !found) {
        queue.sort((a, b) => a.dist - b.dist);
        const current = queue.shift();
        for (const { prev, way } of backward.get(current.node) || []) {
          const dist = current.dist + nodeDistance(prev, current.node);
          if (dist > 1500) continue;
          const wayVotes = new Map(current.wayVotes);
          wayVotes.set(way, (wayVotes.get(way) || 0) + 1);
          const path = [prev].concat(current.path);
          if (groupNodes.has(prev)) { found = { path, wayVotes, dist }; break; }
          if (seen.has(prev) && seen.get(prev) <= dist) continue;
          seen.set(prev, dist);
          queue.push({ node: prev, dist, path, wayVotes });
        }
      }
      if (found) {
        let donor = null;
        let donorVotes = -1;
        for (const [way, votes] of found.wayVotes) if (votes > donorVotes) { donor = way; donorVotes = votes; }
        const bridge = {
          id: `bridge_${groupId}_${bridged}`,
          type: 'way',
          nodes: found.path,
          tags: donor.tags,
          synthetic: true,
        };
        ways.set(bridge.id, bridge);
        groupWays.get(groupId).push(bridge.id);
        bridged += 1;
        console.log(`  bridged ${groupId} gap via ${donor.tags.name || 'link'} (${Math.round(found.dist)} m)`);
      }
    }
  }
  if (bridged) console.log(`  bridged ${bridged} mainline gap(s) total`);
}

/**
 * Merge chain fragments end-to-end: A joins B when A's tail node is B's head
 * node and no other fragment competes for that node. Then mark loops closed.
 * (buildChains splits conservatively at every shared node with siblings; for
 * a carriageway that is really one continuous roadway this stitches it back.)
 */
function mergeChainFragments(records, label) {
  let merged = true;
  while (merged) {
    merged = false;
    for (const record of records) {
      if (record.closed) continue;
      const tail = record.nodeIds[record.nodeIds.length - 1];
      const candidates = records.filter((other) => other !== record && !other.closed && other.nodeIds[0] === tail);
      const competing = records.filter((other) => other !== record && !other.closed
        && other.nodeIds[other.nodeIds.length - 1] === tail);
      if (candidates.length !== 1 || competing.length > 0) continue;
      const next = candidates[0];
      record.nodeIds = record.nodeIds.concat(next.nodeIds.slice(1));
      record.pts = record.pts.concat(next.pts.slice(1));
      record.elev = record.elev.concat(next.elev.slice(1));
      record.tunnelFlags = record.tunnelFlags.concat(next.tunnelFlags.slice(1));
      record.bridgeFlags = record.bridgeFlags.concat(next.bridgeFlags.slice(1));
      const keepLonger = polylineLength(record.pts) >= polylineLength(next.pts);
      if (!keepLonger) {
        record.lanes = next.lanes;
        record.speedLimit = next.speedLimit;
      }
      records.splice(records.indexOf(next), 1);
      merged = true;
      break;
    }
  }
  for (const record of records) {
    if (!record.closed && record.nodeIds.length > 3
      && record.nodeIds[0] === record.nodeIds[record.nodeIds.length - 1]) {
      record.nodeIds.pop();
      record.pts.pop();
      record.elev.pop();
      record.tunnelFlags.pop();
      record.bridgeFlags.pop();
      record.closed = true;
    }
  }
  console.log(`  ${label}: merged into ${records.length} chain(s)`);
  return records;
}

// ---------------------------------------------------------------------------
// Graph surgery: prune external stubs, stitch dangling ends, drop islands
// ---------------------------------------------------------------------------

function removeChain(chains, connections, chain) {
  const index = chains.indexOf(chain);
  if (index >= 0) chains.splice(index, 1);
  for (let i = connections.length - 1; i >= 0; i -= 1) {
    if (connections[i].fromChain === chain || connections[i].toChain === chain) connections.splice(i, 1);
  }
}

/**
 * Mainline stubs that only exist as on/off branches of routes OUTSIDE the
 * subset (unfed head, or dead tail) are pruned: they would be undrivable
 * spawn-from-nothing / drive-into-nothing carriageways.
 */
function pruneExternalStubs(chains, connections) {
  const MAX_STUB = 900;
  let removed = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const chain of [...chains]) {
      if (chain.kind !== 'mainline' || chain.closed) continue;
      const length = chain.arc[chain.arc.length - 1];
      if (length > MAX_STUB) continue;
      const headFed = connections.some((connection) => connection.toChain === chain && connection.toDistance < 60);
      const tailOut = connections.some((connection) => connection.fromChain === chain && connection.fromDistance > length - 60);
      const midTouched = connections.some((connection) =>
        (connection.toChain === chain && connection.toDistance >= 60)
        || (connection.fromChain === chain && connection.fromDistance <= length - 60));
      if ((headFed && tailOut) || midTouched) continue;
      removeChain(chains, connections, chain);
      console.log(`  pruned stub ${chain.id} (${Math.round(length)} m)`);
      removed += 1;
      changed = true;
    }
  }
  if (removed) console.log(`  pruned ${removed} external stub branch(es)`);
}

/**
 * Stitch dangling mainline tails. OSM maps route concurrencies under the
 * crossing route's name (Tanimachi, Takebashi), leaving our per-route chain
 * sets with short gaps. Preference order: an unfed same/any-group head
 * (self => close the loop), else a merge into a chain passing right there.
 */
function stitchDanglingEnds(chains, connections, registerChain) {
  let stitched = 0;
  for (const chain of [...chains]) {
    if (chain.kind !== 'mainline' || chain.closed) continue;
    const length = chain.arc[chain.arc.length - 1];
    const hasOut = connections.some((connection) => connection.fromChain === chain && connection.fromDistance > length - 60);
    if (hasOut) continue;
    const tailPt = chain.pts[chain.pts.length - 1];
    const tailY = chain.elev[chain.elev.length - 1];
    const tailDir = sampleChain(chain, length - 10);

    // 1) self-closure: a loop route whose seam is a concurrency gap.
    const selfGap = Math.hypot(chain.pts[0][0] - tailPt[0], chain.pts[0][1] - tailPt[1]);
    if (length > 4000 && selfGap <= 600) {
      const headDir = sampleChain(chain, 5);
      const alignHead = tailDir.tx * headDir.tx + tailDir.tz * headDir.tz;
      if (alignHead >= 0.2 && Math.abs(chain.elev[0] - tailY) <= 14) {
        if (selfGap > 20) appendBezier(chain, chain, selfGap);
        chain.closed = true;
        chain.arc = arcLengths(chain.pts);
        console.log(`  stitched ${chain.id} closed (gap ${Math.round(selfGap)} m)`);
        stitched += 1;
        continue;
      }
    }

    // 2) another chain's unfed head, direction-compatible.
    let best = null;
    for (const other of chains) {
      if (other === chain || other.kind !== 'mainline' || other.closed) continue;
      const headFed = connections.some((connection) => connection.toChain === other && connection.toDistance < 60);
      if (headFed) continue;
      const headPt = other.pts[0];
      const gap = Math.hypot(headPt[0] - tailPt[0], headPt[1] - tailPt[1]);
      if (gap > 600) continue;
      if (Math.abs(other.elev[0] - tailY) > 14) continue;
      const headDir = sampleChain(other, 5);
      const alignHead = tailDir.tx * headDir.tx + tailDir.tz * headDir.tz;
      if (alignHead < (gap <= 25 ? 0.5 : 0.25)) continue; // antiparallel ends are U-turns, not stitches
      const bearingX = gap > 1 ? (headPt[0] - tailPt[0]) / gap : tailDir.tx;
      const bearingZ = gap > 1 ? (headPt[1] - tailPt[1]) / gap : tailDir.tz;
      const alignBearing = bearingX * tailDir.tx + bearingZ * tailDir.tz;
      if (gap > 25 && alignBearing < 0.25) continue;
      const score = gap - alignHead * 60 + (other.group === chain.group ? -100 : 0);
      if (!best || score < best.score) best = { other, gap, score };
    }
    if (best) {
      const other = best.other;
      if (best.gap < 25) {
        connections.push({
          fromChain: chain, fromDistance: length,
          toChain: other, toDistance: 0, kind: 'continuation', nodeId: null,
          point: tailPt.slice(),
        });
      } else {
        const connector = makeConnector(chain, other, `${chain.group}_stitch_${stitched}`);
        registerChain(connector);
        connections.push({
          fromChain: chain, fromDistance: length,
          toChain: connector, toDistance: 0, kind: 'continuation', nodeId: null,
          point: tailPt.slice(),
        });
        connections.push({
          fromChain: connector, fromDistance: connector.arc[connector.arc.length - 1],
          toChain: other, toDistance: 0, kind: 'continuation', nodeId: null,
          point: other.pts[0].slice(),
        });
      }
      console.log(`  stitched ${chain.id} -> ${other.id} (gap ${Math.round(best.gap)} m)`);
      stitched += 1;
      continue;
    }
    // Fallback: merge into a chain passing right next to the tail.
    let merge = null;
    for (const other of chains) {
      if (other === chain || other.kind !== 'mainline') continue;
      const projection = projectToChain(other, tailPt[0], tailPt[1]);
      if (projection.d > 30) continue;
      const sample = sampleChain(other, projection.distance);
      if (Math.abs(sample.y - tailY) > 5) continue;
      const align = sample.tx * tailDir.tx + sample.tz * tailDir.tz;
      if (align < 0.5) continue;
      if (!merge || projection.d < merge.projection.d) merge = { other, projection };
    }
    if (merge) {
      connections.push({
        fromChain: chain, fromDistance: length,
        toChain: merge.other, toDistance: merge.projection.distance, kind: 'merge', nodeId: null,
        point: tailPt.slice(),
      });
      console.log(`  stitched ${chain.id} -> merge into ${merge.other.id}`);
      stitched += 1;
    }
  }
  if (stitched) console.log(`  ${stitched} dangling end(s) stitched`);
}

/** Append a tangent-continuous Bezier from `chain`'s tail to `target`'s head (interior points only). */
function appendBezier(chain, target, gap) {
  const length = chain.arc[chain.arc.length - 1];
  const tail = chain.pts[chain.pts.length - 1];
  const head = target.pts[0];
  const tailDir = sampleChain(chain, length - 10);
  const headDir = sampleChain(target, 5);
  const handle = Math.max(20, gap * 0.4);
  const c1x = tail[0] + tailDir.tx * handle;
  const c1z = tail[1] + tailDir.tz * handle;
  const c2x = head[0] - headDir.tx * handle;
  const c2z = head[1] - headDir.tz * handle;
  const steps = Math.max(3, Math.round(gap / 18));
  const tailY = chain.elev[chain.elev.length - 1];
  const headY = target.elev[0];
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    chain.pts.push([
      mt * mt * mt * tail[0] + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * head[0],
      mt * mt * mt * tail[1] + 3 * mt * mt * t * c1z + 3 * mt * t * t * c2z + t * t * t * head[1],
    ]);
    chain.elev.push(tailY + (headY - tailY) * t);
    chain.tunnelFlags.push(false);
    chain.bridgeFlags.push(false);
  }
}

/** Synthesized connector carriageway between two chains (concurrency gap). */
function makeConnector(chain, target, id) {
  const tail = chain.pts[chain.pts.length - 1];
  const head = target.pts[0];
  const tailY = chain.elev[chain.elev.length - 1];
  const headY = target.elev[0];
  const tailDir = sampleChain(chain, chain.arc[chain.arc.length - 1] - 10);
  const headDir = sampleChain(target, 5);
  const gap = Math.hypot(head[0] - tail[0], head[1] - tail[1]);
  const handle = Math.max(20, gap * 0.4);
  const c1x = tail[0] + tailDir.tx * handle;
  const c1z = tail[1] + tailDir.tz * handle;
  const c2x = head[0] - headDir.tx * handle;
  const c2z = head[1] - headDir.tz * handle;
  const pts = [];
  const elev = [];
  const steps = Math.max(4, Math.round(gap / 18));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push([
      mt * mt * mt * tail[0] + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * head[0],
      mt * mt * mt * tail[1] + 3 * mt * mt * t * c1z + 3 * mt * t * t * c2z + t * t * t * head[1],
    ]);
    elev.push(tailY + (headY - tailY) * t);
  }
  return {
    id,
    group: chain.group,
    kind: 'mainline',
    nodeIds: [],
    pts,
    elev,
    tunnelFlags: pts.map(() => false),
    bridgeFlags: pts.map(() => false),
    lanes: Math.min(chain.lanes, target.lanes),
    speedLimit: Math.min(chain.speedLimit, target.speedLimit),
    closed: false,
    synthetic: true,
  };
}

/** Keep only chains weakly connected to the anchor chain. */
function pruneDisconnected(chains, connections, anchorId) {
  const anchor = chains.find((chain) => chain.id === anchorId) || chains[0];
  const adjacency = new Map();
  for (const connection of connections) {
    if (!adjacency.has(connection.fromChain)) adjacency.set(connection.fromChain, new Set());
    if (!adjacency.has(connection.toChain)) adjacency.set(connection.toChain, new Set());
    adjacency.get(connection.fromChain).add(connection.toChain);
    adjacency.get(connection.toChain).add(connection.fromChain);
  }
  const keep = new Set([anchor]);
  const queue = [anchor];
  while (queue.length) {
    const current = queue.pop();
    for (const next of adjacency.get(current) || []) {
      if (!keep.has(next)) { keep.add(next); queue.push(next); }
    }
  }
  const dropped = chains.filter((chain) => !keep.has(chain));
  for (const chain of dropped) {
    console.log(`  dropped disconnected ${chain.id} (${Math.round(chain.arc[chain.arc.length - 1])} m)`);
    removeChain(chains, connections, chain);
  }
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

function solveElevations(chains, connections) {
  // 1. Pin connection nodes: ramp endpoints adopt the elevation of the chain
  //    they attach to (mainlines win over ramps).
  const mainAt = (chain, distance) => {
    const sample = sampleChain(chain, distance);
    return sample.y;
  };
  for (let pass = 0; pass < 3; pass += 1) {
    for (const connection of connections) {
      const { fromChain, toChain } = connection;
      if (fromChain.kind === 'ramp' && toChain.kind === 'mainline') {
        // merge: ramp end must land at mainline height
        fromChain.elev[fromChain.elev.length - 1] = mainAt(toChain, connection.toDistance);
      } else if (fromChain.kind === 'mainline' && toChain.kind === 'ramp') {
        toChain.elev[0] = mainAt(fromChain, connection.fromDistance);
      } else if (connection.kind === 'continuation') {
        toChain.elev[0] = mainAt(fromChain, connection.fromDistance);
      } else if (fromChain.kind === 'ramp' && toChain.kind === 'ramp') {
        fromChain.elev[fromChain.elev.length - 1] = mainAt(toChain, connection.toDistance);
      }
    }
    // 2. Smooth along each chain with pinned tunnel/bridge zones relaxed less,
    //    then clamp gradients to MAX_GRADE.
    for (const chain of chains) smoothChainElevation(chain, connections);
  }
}

function smoothChainElevation(chain, connections) {
  const count = chain.pts.length;
  if (count < 3) return;
  const arc = chain.arc;
  const pinned = new Array(count).fill(false);
  if (!chain.closed) {
    // endpoints pinned when they participate in a connection
    for (const connection of connections) {
      if (connection.fromChain === chain && connection.fromDistance > arc[count - 1] - 30) pinned[count - 1] = true;
      if (connection.toChain === chain && connection.toDistance < 30) pinned[0] = true;
    }
  }
  // window smoothing (moving average over ~180 m), several relaxation passes
  const smoothed = chain.elev.slice();
  for (let pass = 0; pass < 4; pass += 1) {
    for (let i = 0; i < count; i += 1) {
      if (pinned[i]) continue;
      const prev = (i - 1 + count) % count;
      const next = (i + 1) % count;
      if (!chain.closed && (i === 0 || i === count - 1)) continue;
      const dPrev = Math.max(1, Math.abs(arc[i] - arc[prev]));
      const dNext = Math.max(1, Math.abs(arc[next] - arc[i]));
      const target = (smoothed[prev] * dNext + smoothed[next] * dPrev) / (dPrev + dNext);
      // tunnels/bridges keep 60 % of their authored level, open road relaxes fully
      const anchored = chain.tunnelFlags[i] || chain.bridgeFlags[i] ? 0.45 : 0.85;
      smoothed[i] = smoothed[i] * (1 - anchored) + target * anchored;
    }
  }
  // gradient clamp (forward + backward sweeps)
  for (let i = 1; i < count; i += 1) {
    const run = Math.max(1, arc[i] - arc[i - 1]);
    const maxStep = run * MAX_GRADE;
    smoothed[i] = Math.max(smoothed[i - 1] - maxStep, Math.min(smoothed[i - 1] + maxStep, smoothed[i]));
  }
  for (let i = count - 2; i >= 0; i -= 1) {
    const run = Math.max(1, arc[i + 1] - arc[i]);
    const maxStep = run * MAX_GRADE;
    smoothed[i] = Math.max(smoothed[i + 1] - maxStep, Math.min(smoothed[i + 1] + maxStep, smoothed[i]));
  }
  chain.elev = smoothed;
}

// ---------------------------------------------------------------------------
// Clearance + separation
// ---------------------------------------------------------------------------

function chainHalfWidth(chain) {
  const shoulder = chain.kind === 'ramp' ? RAMP_SHOULDER : MAIN_SHOULDER;
  return chain.lanes * LANE_W * 0.5 + shoulder;
}

function connectedNear(connections, a, b, distA, distB, radius = 260) {
  for (const connection of connections) {
    const pair = (connection.fromChain === a && connection.toChain === b)
      || (connection.fromChain === b && connection.toChain === a);
    if (!pair) continue;
    const da = connection.fromChain === a ? connection.fromDistance : connection.toDistance;
    const db = connection.fromChain === b ? connection.fromDistance : connection.toDistance;
    if (Math.abs(da - distA) < radius && Math.abs(db - distB) < radius) return true;
  }
  return false;
}

function enforceClearance(chains, connections) {
  // Where two chains cross in plan, force |Δy| >= MIN_CLEARANCE by locally
  // lifting the higher / dropping the lower with a smooth 160 m falloff.
  let adjusted = 0;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    let violations = 0;
    for (let i = 0; i < chains.length; i += 1) {
      for (let j = i + 1; j < chains.length; j += 1) {
        const a = chains[i];
        const b = chains[j];
        for (let si = 0; si < a.pts.length - 1; si += 1) {
          for (let sj = 0; sj < b.pts.length - 1; sj += 1) {
            const hit = segmentIntersection(a.pts[si], a.pts[si + 1], b.pts[sj], b.pts[sj + 1]);
            if (!hit) continue;
            const da = a.arc[si] + hit.t * (a.arc[si + 1] - a.arc[si]);
            const db = b.arc[sj] + hit.u * (b.arc[sj + 1] - b.arc[sj]);
            if (connectedNear(connections, a, b, da, db)) continue;
            const ya = a.elev[si] + hit.t * (a.elev[si + 1] - a.elev[si]);
            const yb = b.elev[sj] + hit.u * (b.elev[sj + 1] - b.elev[sj]);
            const gap = Math.abs(ya - yb);
            if (gap >= MIN_CLEARANCE) continue;
            violations += 1;
            const need = (MIN_CLEARANCE - gap) * 0.55 + 0.3;
            const upper = ya >= yb ? a : b;
            const lower = ya >= yb ? b : a;
            const upperDist = ya >= yb ? da : db;
            const lowerDist = ya >= yb ? db : da;
            bumpElevation(upper, upperDist, +need);
            bumpElevation(lower, lowerDist, -need);
            adjusted += 1;
          }
        }
      }
    }
    if (!violations) break;
  }
  if (adjusted) console.log(`  clearance: adjusted ${adjusted} crossing(s)`);
}

function bumpElevation(chain, atDistance, delta, falloff = 170) {
  for (let i = 0; i < chain.pts.length; i += 1) {
    let along = Math.abs(chain.arc[i] - atDistance);
    if (chain.closed) {
      const total = chain.arc[chain.arc.length - 1] + Math.hypot(
        chain.pts[0][0] - chain.pts[chain.pts.length - 1][0],
        chain.pts[0][1] - chain.pts[chain.pts.length - 1][1],
      );
      along = Math.min(along, total - along);
    }
    if (along > falloff) continue;
    const w = 0.5 + 0.5 * Math.cos((along / falloff) * Math.PI);
    // never drag a tunnel above ground or a bridge below its zone
    chain.elev[i] += delta * w;
  }
}

function enforceSeparation(chains, connections) {
  // Same-level parallel corridors must not overlap in plan (opposing
  // carriageways drawn close together in OSM). Push both apart along the
  // mutual normal. Gores (connected regions) are exempt — corridor overlap
  // is how merges/diverges seal themselves.
  let pushes = 0;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    let overlaps = 0;
    for (let i = 0; i < chains.length; i += 1) {
      for (let j = i + 1; j < chains.length; j += 1) {
        const a = chains[i];
        const b = chains[j];
        const need = chainHalfWidth(a) + chainHalfWidth(b) + 0.6;
        for (let si = 0; si < a.pts.length; si += 1) {
          const projection = projectToChain(b, a.pts[si][0], a.pts[si][1]);
          if (projection.d >= need) continue;
          const ya = a.elev[si];
          const sample = sampleChain(b, projection.distance);
          if (Math.abs(ya - sample.y) > 4.5) continue; // different decks
          const da = a.arc[si];
          if (connectedNear(connections, a, b, da, projection.distance, 320)) continue;
          overlaps += 1;
          const push = (need - projection.d) * 0.5 + 0.05;
          let nx = a.pts[si][0] - sample.x;
          let nz = a.pts[si][1] - sample.z;
          const len = Math.hypot(nx, nz);
          if (len < 0.01) { nx = -sample.tz; nz = sample.tx; } else { nx /= len; nz /= len; }
          nudgeChain(a, da, nx * push, nz * push);
          nudgeChain(b, projection.distance, -nx * push, -nz * push);
          pushes += 1;
        }
      }
    }
    for (const chain of chains) {
      chain.arc = arcLengths(chain.closed ? chain.pts.concat([chain.pts[0]]) : chain.pts);
      if (chain.closed) chain.arc.pop();
    }
    if (!overlaps) break;
  }
  if (pushes) console.log(`  separation: nudged ${pushes} overlap sample(s)`);
}

function nudgeChain(chain, atDistance, dx, dz, falloff = 120) {
  for (let i = 0; i < chain.pts.length; i += 1) {
    const along = Math.abs(chain.arc[i] - atDistance);
    if (along > falloff) continue;
    const w = 0.5 + 0.5 * Math.cos((along / falloff) * Math.PI);
    chain.pts[i][0] += dx * w;
    chain.pts[i][1] += dz * w;
  }
}

// ---------------------------------------------------------------------------
// Synthetic turnarounds at network cut points
// ---------------------------------------------------------------------------

function synthesizeUturns(chains, connections, registerChain) {
  const outgoing = new Set(connections.map((connection) => connection.fromChain));
  const incoming = new Set(connections.map((connection) => connection.toChain));
  const danglingOut = chains.filter((chain) => chain.kind === 'mainline' && !chain.closed
    && !connections.some((connection) => connection.fromChain === chain
      && connection.fromDistance > chain.arc[chain.arc.length - 1] - 60));
  let made = 0;
  for (const chain of danglingOut) {
    // find the opposite carriageway of the same group whose START is nearby
    const end = chain.pts[chain.pts.length - 1];
    const endY = chain.elev[chain.elev.length - 1];
    let best = null;
    for (const other of chains) {
      if (other === chain || other.group !== chain.group || other.kind !== 'mainline' || other.closed) continue;
      const start = other.pts[0];
      const d = Math.hypot(start[0] - end[0], start[1] - end[1]);
      if (d < 220 && (!best || d < best.d)) best = { other, d };
    }
    if (!best) {
      console.warn(`  ! no U-turn partner for dangling end of ${chain.id} (${chain.group})`);
      continue;
    }
    const other = best.other;
    const start = other.pts[0];
    const startY = other.elev[0];
    // Teardrop turnaround: cubic Bezier with both control handles pushed
    // forward along the cut direction — tangent-continuous with both
    // carriageway ends at any gap width. It reads as the JCT-end loop of a
    // clipped route; speed limit keeps AI honest through the apex.
    const tangent = sampleChain(chain, chain.arc[chain.arc.length - 1] - 1);
    const fx = tangent.tx;
    const fz = tangent.tz;
    const gap = Math.hypot(start[0] - end[0], start[1] - end[1]);
    const handle = Math.max(110, gap * 2.2);
    const c1x = end[0] + fx * handle;
    const c1z = end[1] + fz * handle;
    const c2x = start[0] + fx * handle;
    const c2z = start[1] + fz * handle;
    const pts = [];
    const elev = [];
    const steps = 22;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const mt = 1 - t;
      const x = mt * mt * mt * end[0] + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * start[0];
      const z = mt * mt * mt * end[1] + 3 * mt * mt * t * c1z + 3 * mt * t * t * c2z + t * t * t * start[1];
      pts.push([x, z]);
      elev.push(endY + (startY - endY) * t);
    }
    const uturn = {
      id: `${chain.group}_uturn_${made}`,
      group: chain.group,
      kind: 'ramp',
      nodeIds: [],
      pts,
      elev,
      tunnelFlags: pts.map(() => false),
      bridgeFlags: pts.map(() => false),
      lanes: 1,
      speedLimit: 40,
      closed: false,
      synthetic: true,
    };
    registerChain(uturn);
    connections.push({
      fromChain: chain, fromDistance: chain.arc[chain.arc.length - 1],
      toChain: uturn, toDistance: 0, kind: 'continuation', nodeId: null,
      point: end.slice(),
    });
    connections.push({
      fromChain: uturn, fromDistance: uturn.arc[uturn.arc.length - 1],
      toChain: other, toDistance: 0, kind: 'continuation', nodeId: null,
      point: start.slice(),
    });
    made += 1;
  }
  if (made) console.log(`  synthesized ${made} U-turn(s) at subset cut ends`);
  void outgoing;
  void incoming;
}

// ---------------------------------------------------------------------------
// Zones, junctions, PAs, destinations
// ---------------------------------------------------------------------------

function flagZones(chain, flags) {
  const zones = [];
  let start = null;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] && start === null) start = chain.arc[i];
    if ((!flags[i] || i === flags.length - 1) && start !== null) {
      const end = flags[i] ? chain.arc[i] : chain.arc[Math.max(0, i - 1)];
      if (end - start > 60) zones.push({ start: Math.round(start), end: Math.round(end) });
      start = null;
    }
  }
  return zones;
}

function extractJunctionNames(roads) {
  const names = [];
  for (const el of roads.elements) {
    if (el.type !== 'node' || !el.tags) continue;
    if (el.tags.highway === 'motorway_junction' && (el.tags.name || el.tags['name:en'])) {
      const [x, z] = project(el.lat, el.lon);
      names.push({ x, z, name: el.tags.name || '', nameEn: el.tags['name:en'] || '', ref: el.tags.ref || '' });
    }
  }
  return names;
}

function extractPaCentroids(pas) {
  const centroids = new Map();
  const { nodes } = indexElements(pas);
  for (const el of pas.elements) {
    const name = el.tags?.name || '';
    if (!name) continue;
    for (const pa of SERVICE_AREAS) {
      if (!pa.match.test(name)) continue;
      let lat;
      let lon;
      if (el.type === 'node') { lat = el.lat; lon = el.lon; }
      else if (el.center) { lat = el.center.lat; lon = el.center.lon; }
      else if (el.type === 'way' && el.nodes) {
        let sumLat = 0;
        let sumLon = 0;
        let count = 0;
        for (const nodeId of el.nodes) {
          const node = nodes.get(nodeId);
          if (!node) continue;
          sumLat += node.lat;
          sumLon += node.lon;
          count += 1;
        }
        if (!count) continue;
        lat = sumLat / count;
        lon = sumLon / count;
      }
      if (lat === undefined) continue;
      // sanity: within 1.5 km of the expected spot
      const [x, z] = project(lat, lon);
      const [ex, ez] = project(pa.lat, pa.lon);
      if (dist2(x, z, ex, ez) > 1500 * 1500) continue;
      if (!centroids.has(pa.id)) centroids.set(pa.id, [x, z]);
    }
  }
  for (const pa of SERVICE_AREAS) {
    console.log(`  PA ${pa.id}: ${centroids.has(pa.id) ? 'OSM centroid' : 'fallback coordinates'}`);
    if (!centroids.has(pa.id)) centroids.set(pa.id, project(pa.lat, pa.lon));
  }
  return centroids;
}

function buildJunctions(chains, connections, junctionNames, nodes) {
  // Cluster mainline<->ramp connection points; name clusters from the nearest
  // motorway_junction node name.
  const clusters = [];
  for (const connection of connections) {
    if (!connection.point) continue;
    const involvesTwoGroups = connection.fromChain.group !== connection.toChain.group
      || connection.fromChain.kind !== connection.toChain.kind;
    if (!involvesTwoGroups) continue;
    let cluster = clusters.find((entry) => dist2(entry.x, entry.z, connection.point[0], connection.point[1]) < 420 * 420);
    if (!cluster) {
      cluster = { x: connection.point[0], z: connection.point[1], groups: new Set(), count: 0 };
      clusters.push(cluster);
    }
    cluster.x = (cluster.x * cluster.count + connection.point[0]) / (cluster.count + 1);
    cluster.z = (cluster.z * cluster.count + connection.point[1]) / (cluster.count + 1);
    cluster.count += 1;
    cluster.groups.add(connection.fromChain.group);
    cluster.groups.add(connection.toChain.group);
  }
  const junctions = [];
  let index = 0;
  for (const cluster of clusters) {
    if (cluster.count < 2) continue;
    let bestName = null;
    let bestD = Infinity;
    for (const junction of junctionNames) {
      const d = dist2(junction.x, junction.z, cluster.x, cluster.z);
      if (d < bestD) { bestD = d; bestName = junction; }
    }
    const named = bestName && bestD < 600 * 600;
    junctions.push({
      id: `jct_${index}`,
      name: named ? (bestName.nameEn || bestName.name) : 'JCT',
      nameJa: named ? bestName.name : '',
      x: Math.round(cluster.x * 100) / 100,
      z: Math.round(cluster.z * 100) / 100,
      groups: [...cluster.groups].filter((group) => group !== 'ramp'),
    });
    index += 1;
  }
  console.log(`  ${junctions.length} junction clusters`);
  void nodes;
  return junctions;
}

function buildServiceAreas(chains, paCentroids) {
  const areas = [];
  for (const pa of SERVICE_AREAS) {
    const [x, z] = paCentroids.get(pa.id);
    // anchor: nearest mainline chain of the allowed groups
    let best = null;
    for (const chain of chains) {
      if (chain.kind !== 'mainline' || !pa.groups.includes(chain.group)) continue;
      const projection = projectToChain(chain, x, z);
      if (!best || projection.d < best.projection.d) best = { chain, projection };
    }
    if (!best) {
      console.warn(`  ! no anchor chain for ${pa.id}`);
      continue;
    }
    const sample = sampleChain(best.chain, best.projection.distance);
    // side of the anchor chain the lot sits on: sign of cross(tangent, toLot)
    const toLotX = x - sample.x;
    const toLotZ = z - sample.z;
    const cross = sample.tx * toLotZ - sample.tz * toLotX; // >0 => left of travel
    areas.push({
      id: pa.id,
      name: pa.name,
      nameJa: pa.nameJa,
      x: Math.round(x * 100) / 100,
      z: Math.round(z * 100) / 100,
      routeId: best.chain.id,
      distance: Math.round(best.projection.distance * 10) / 10,
      lateral: Math.round(best.projection.d * 10) / 10,
      side: cross > 0 ? 'left' : 'right',
      hasGarage: !!pa.hasGarage,
      density: pa.density,
      width: pa.width,
      length: pa.length,
    });
    console.log(`  PA ${pa.id}: anchored to ${best.chain.id} @ ${best.projection.distance.toFixed(0)} m (${best.projection.d.toFixed(0)} m ${cross > 0 ? 'left' : 'right'})`);
  }
  return areas;
}

function attachDestinations(chains, ways, nodes) {
  // Ramp destination signs from OSM destination tags on the underlying ways.
  const destinationByChain = new Map();
  for (const way of ways.values()) {
    const tags = way.tags || {};
    if (tags.highway !== 'motorway_link' || !tags.destination) continue;
    const [x, z] = project(nodes.get(way.nodes[0]).lat, nodes.get(way.nodes[0]).lon);
    for (const chain of chains) {
      if (chain.kind !== 'ramp') continue;
      const projection = projectToChain(chain, x, z);
      if (projection.d < 12) {
        destinationByChain.set(chain.id, tags.destination.split(/[;、]/).slice(0, 3));
        break;
      }
    }
  }
  for (const chain of chains) {
    if (destinationByChain.has(chain.id)) {
      chain.destinations = destinationByChain.get(chain.id).map((entry) => [entry.trim(), '']);
    }
  }
  console.log(`  destinations on ${destinationByChain.size} ramp(s)`);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emit(chains, connections, junctions, serviceAreas, rawStats) {
  const round = (value) => Math.round(value * 100) / 100;
  const routes = chains.map((chain) => {
    const group = GROUPS.find((entry) => entry.id === chain.group);
    return {
      id: chain.id,
      group: chain.group,
      code: group ? group.code : 'R',
      name: chain.kind === 'ramp'
        ? (chain.synthetic ? `${chain.group} turnaround` : `Ramp ${chain.id.split('_')[1]}`)
        : (group ? group.name : chain.id),
      nameJa: group ? group.nameJa : '',
      kind: chain.kind,
      closed: !!chain.closed,
      synthetic: !!chain.synthetic,
      lanes: chain.lanes,
      speedLimit: chain.speedLimit,
      length: round(chain.arc[chain.arc.length - 1]),
      points: chain.pts.map((pt, index) => [round(pt[0]), round(chain.elev[index]), round(pt[1])]),
      tunnels: chain.tunnels || [],
      bridges: chain.bridges || [],
      destinations: chain.destinations || (group ? group.destinations : []),
      paId: chain.paId || null,
    };
  });
  const edges = connections.map((connection) => ({
    from: { route: connection.fromChain.id, distance: round(connection.fromDistance) },
    to: { route: connection.toChain.id, distance: round(connection.toDistance) },
    kind: connection.kind,
    point: connection.point ? [round(connection.point[0]), round(connection.point[1])] : null,
  }));
  const terrain = TERRAIN_SLABS.map((slab) => {
    const [x, z] = project(slab.lat, slab.lon);
    return { name: slab.name, x: round(x), z: round(z), w: slab.w, d: slab.d };
  });
  const mainlineKm = routes.filter((route) => route.kind === 'mainline').reduce((sum, route) => sum + route.length, 0) / 1000;
  const rampKm = routes.filter((route) => route.kind === 'ramp').reduce((sum, route) => sum + route.length, 0) / 1000;
  const payload = {
    meta: {
      source: 'OpenStreetMap via Overpass API (ODbL). © OpenStreetMap contributors.',
      generatedAt: new Date().toISOString(),
      origin: ORIGIN,
      bbox: BBOX,
      laneWidth: LANE_W,
      stats: {
        rawWays: rawStats.ways,
        rawNodes: rawStats.nodes,
        routes: routes.length,
        mainlines: routes.filter((route) => route.kind === 'mainline').length,
        ramps: routes.filter((route) => route.kind === 'ramp').length,
        edges: edges.length,
        junctions: junctions.length,
        mainlineKm: Math.round(mainlineKm * 10) / 10,
        rampKm: Math.round(rampKm * 10) / 10,
        pointsBeforeSimplify: rawStats.pointsBefore,
        pointsAfterSimplify: rawStats.pointsAfter,
      },
    },
    groups: GROUPS.map((group) => ({ id: group.id, code: group.code, name: group.name, nameJa: group.nameJa, kind: group.kind, destinations: group.destinations })),
    routes,
    edges,
    junctions,
    serviceAreas,
    terrain,
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload));
  const esm = `// GENERATED by tools/extract-osm.js — do not edit by hand.\n// Data © OpenStreetMap contributors, ODbL 1.0.\nexport default ${JSON.stringify(payload)};\n`;
  fs.writeFileSync(OUT_ESM, esm);
  writeDebugSvg(payload);
  console.log('— written:');
  console.log(`  ${OUT_JSON} (${(fs.statSync(OUT_JSON).size / 1024).toFixed(0)} KiB)`);
  console.log(`  ${OUT_ESM}`);
  console.log(`  ${OUT_SVG}`);
  console.log(JSON.stringify(payload.meta.stats, null, 2));
}

function writeDebugSvg(payload) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const route of payload.routes) {
    for (const [x, , z] of route.points) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  const pad = 500;
  const width = 1200;
  const scale = width / (maxX - minX + pad * 2);
  const height = Math.ceil((maxZ - minZ + pad * 2) * scale);
  const sx = (x) => ((x - minX + pad) * scale).toFixed(1);
  const sz = (z) => (height - (z - minZ + pad) * scale).toFixed(1);
  const colors = { c1: '#ffb454', wangan: '#4fc9ff', k1: '#e87bff', r11: '#ffe667', r9: '#79e690', ramp: '#8b98ab' };
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="background:#0a0d18">`];
  for (const route of payload.routes) {
    const color = colors[route.group] || colors.ramp;
    const d = route.points.map(([x, , z], index) => `${index ? 'L' : 'M'}${sx(x)},${sz(z)}`).join('') + (route.closed ? 'Z' : '');
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${route.kind === 'ramp' ? 1 : 2.2}" opacity="${route.kind === 'ramp' ? 0.75 : 1}"/>`);
  }
  for (const pa of payload.serviceAreas) {
    parts.push(`<circle cx="${sx(pa.x)}" cy="${sz(pa.z)}" r="6" fill="none" stroke="#6fe3ff" stroke-width="1.6"/>`);
    parts.push(`<text x="${Number(sx(pa.x)) + 9}" y="${sz(pa.z)}" fill="#9fc" font-size="11" font-family="monospace">${pa.name}</text>`);
  }
  for (const junction of payload.junctions) {
    parts.push(`<circle cx="${sx(junction.x)}" cy="${sz(junction.z)}" r="3" fill="#f66"/>`);
  }
  parts.push('</svg>');
  fs.writeFileSync(OUT_SVG, parts.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
