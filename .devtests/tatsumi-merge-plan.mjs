/**
 * Measured plan overlay of the Tatsumi PA ramp merge (`J13:merge:wangan_0:ramp_8:end`).
 *
 * Draws the authoritative geometry the map itself builds: the Wangan pavement
 * edges, the ramp pavement edges, the progressive paved envelope and every
 * temporary lane centre, in world XZ. The night renderer cannot show this
 * clearly from above, so this is the readable before/after evidence.
 *
 * Run: node .devtests/tatsumi-merge-plan.mjs [--legacy] [out.svg]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HighwayMap } from '../js/map.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const LEGACY = process.argv.includes('--legacy');
const fileArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const target = join(OUT, fileArg || (LEGACY ? 'TM-plan-legacy.svg' : 'TM-plan-progressive.svg'));

const ZONE_ID = 'J13:merge:wangan_0:ramp_8:end';
const HOST_FROM = 1380;
const HOST_TO = 1820;

const map = new HighwayMap(null, { addLighting: false, ...(LEGACY ? { progressiveMerges: false } : {}) });
const zone = map.junctionZones.find((candidate) => candidate.id === ZONE_ID);
if (!zone) throw new Error(`zone missing: ${ZONE_ID}`);
const transition = map.progressiveTransitionById?.get(ZONE_ID) || null;

const hostEdge = (lateralSign) => {
  const points = [];
  for (let s = HOST_FROM; s <= HOST_TO; s += 2) {
    const frame = map._frameAt(zone.host, map._normalizeDistance(zone.host, s));
    points.push(map._deckPoint(frame, lateralSign * frame.half));
  }
  return points;
};
const branchEdge = (lateralSign) => {
  const points = [];
  const [b0, b1] = [zone.branchSpan[0] - 120, zone.branch.length];
  for (let s = Math.max(0, b0); s <= b1; s += 2) {
    const frame = map._frameAt(zone.branch, s);
    points.push(map._deckPoint(frame, lateralSign * frame.half));
  }
  return points;
};
const hostLaneCentre = (lane) => {
  const points = [];
  for (let s = HOST_FROM; s <= HOST_TO; s += 4) {
    const frame = map._frameAt(zone.host, map._normalizeDistance(zone.host, s));
    points.push(map._deckPoint(frame, map._laneOffset(zone.host, lane, 1)));
  }
  return points;
};

const layers = [];
layers.push({ id: 'host-edge-left', stroke: '#8899aa', width: 0.5, points: hostEdge(-1) });
layers.push({ id: 'host-edge-right', stroke: '#8899aa', width: 0.5, points: hostEdge(1) });
for (let lane = 0; lane < zone.host.lanes; lane += 1) {
  layers.push({ id: `host-lane-${lane}`, stroke: '#44515e', width: 0.25, dash: '4 4', points: hostLaneCentre(lane) });
}
layers.push({ id: 'ramp-edge-hostward', stroke: '#d2a24c', width: 0.5, points: branchEdge(zone.hostwardSign) });
layers.push({ id: 'ramp-edge-outer', stroke: '#d2a24c', width: 0.5, points: branchEdge(-zone.hostwardSign) });

if (transition) {
  layers.push({
    id: 'progressive-outer-envelope',
    stroke: '#e0457b',
    width: 0.8,
    points: transition.pavedEnvelope.map((row) => (zone.side > 0 ? row.upper : row.lower)),
  });
  for (const path of transition.laneCentres) {
    layers.push({
      id: `centre-${path.id}`,
      stroke: path.id.startsWith('aux') ? '#3fd0c9' : '#3f6fd0',
      width: 0.35,
      dash: path.id.startsWith('aux') ? null : '6 6',
      points: path.points.map((point) => point.position),
    });
  }
}

const all = layers.flatMap((layer) => layer.points);
const minX = Math.min(...all.map((p) => p.x)) - 10;
const maxX = Math.max(...all.map((p) => p.x)) + 10;
const minZ = Math.min(...all.map((p) => p.z)) - 10;
const maxZ = Math.max(...all.map((p) => p.z)) + 10;
// Long thin corridor: rotate so the road runs left-to-right in the image.
const scale = 3.2;
const width = (maxX - minX) * scale;
const height = (maxZ - minZ) * scale;
const project = (point) => `${((point.x - minX) * scale).toFixed(1)},${((point.z - minZ) * scale).toFixed(1)}`;

const marks = [];
if (transition) {
  const stations = [
    ['approach', transition.approachStart],
    ['opening', transition.openingStart],
    ['FULL 5', transition.parallelStart],
    ['5->4', transition.absorptionStart],
    ['4 lanes', transition.firstAbsorptionEnd],
    ['4->3', transition.secondAbsorptionStart],
    ['3 lanes', transition.transitionEnd],
  ];
  for (const [label, station] of stations) {
    if (!Number.isFinite(station)) continue;
    const frame = map._frameAt(zone.host, map._normalizeDistance(zone.host, station));
    const a = map._deckPoint(frame, -frame.half - 14);
    const b = map._deckPoint(frame, frame.half + 14);
    marks.push(`<line x1="${project(a).split(',')[0]}" y1="${project(a).split(',')[1]}" x2="${project(b).split(',')[0]}" y2="${project(b).split(',')[1]}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1"/>`);
    marks.push(`<text x="${project(b).split(',')[0]}" y="${project(b).split(',')[1]}" fill="#ffffff" font-size="11" font-family="monospace">${label} ${station.toFixed(0)}</text>`);
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}">
<rect width="100%" height="100%" fill="#10141a"/>
${layers.map((layer) => `<polyline fill="none" stroke="${layer.stroke}" stroke-width="${(layer.width * scale).toFixed(2)}"${layer.dash ? ` stroke-dasharray="${layer.dash}"` : ''} points="${layer.points.map(project).join(' ')}"/>`).join('\n')}
${marks.join('\n')}
<text x="12" y="20" fill="#cfd6e0" font-size="14" font-family="monospace">${LEGACY ? 'LEGACY junction treatment' : `PROGRESSIVE ${transition?.topology || 'none'}`} — ${ZONE_ID}</text>
</svg>`;
await writeFile(target, svg);
console.log(`wrote ${target}`);
if (transition) {
  console.log(`phases: approach ${transition.approachStart.toFixed(1)} | opening ${transition.openingStart.toFixed(1)}`
    + ` | full5 ${transition.parallelStart.toFixed(1)} | 5->4 ${transition.absorptionStart.toFixed(1)}`
    + ` | 4 ${transition.firstAbsorptionEnd.toFixed(1)} | 4->3 ${transition.secondAbsorptionStart.toFixed(1)}`
    + ` | 3 ${transition.transitionEnd.toFixed(1)}`);
}
