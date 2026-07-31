/**
 * MERGE-ARROW PROBE — the horizontal signage on the ramp 8 → Wangan merge
 * (P3, `J13:merge:wangan_0:ramp_8:end`).
 *
 * Two things it answers, both of which used to be wrong by eye and invisible
 * to every other probe:
 *
 *  1. IS THE ARROW STRAIGHT? The arrow texture is dumped to a PNG at its true
 *     world aspect, and the painted shaft is measured row by row: a
 *     lane-change arrow drawn correctly has a constant-width shaft (0.45 m)
 *     from the tail to the head base, and its centre moves monotonically
 *     across. A stroked arrow whose lineWidth is constant in TEXTURE space
 *     fattens on the swing; a mitre spike shows up as a width outlier.
 *  2. IS THERE AN ARROW BEFORE EACH LANE CLOSES? Every absorption step must
 *     carry a closure arrow that ENDS before its taper starts, sits inside the
 *     paved envelope, and rides the lane it belongs to.
 *
 * Run: node .devtests/merge-arrow-probe.mjs [--shots]
 * Writes .devtests/shots/MA-*.png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const SHOTS = process.argv.includes('--shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, decodeURIComponent(file)));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/build/three.module.js')) });
});
await context.route('https://cdn.jsdelivr.net/**/examples/jsm/**', async (route) => {
  const rest = route.request().url().split('/examples/jsm/')[1];
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/examples/jsm', rest)) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 90000 });
// The boot menu's buttons are in the DOM before they are clickable, and how
// long that takes depends on how long the map build ran. Wait for visibility,
// then click through the DOM so a stray overlay cannot make this flaky.
await page.waitForSelector('#new-game-button', { state: 'visible', timeout: 60000 });
await page.evaluate(() => document.querySelector('#new-game-button').click());
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 30000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 15000 });

const ID = 'J13:merge:wangan_0:ramp_8:end';
let failures = 0;
const fail = (label, detail) => { failures += 1; console.log(`FAIL  ${label}: ${detail}`); };

const report = await page.evaluate((id) => {
  const map = window.shutoko.map;
  const transition = map.progressiveTransitionById.get(id);
  if (!transition) return { error: 'no transition' };
  const host = map.getRoute(transition.hostRouteId);

  // --- painted meshes ---
  // Host station + lateral of each mesh centre, so a closure arrow can be
  // checked against the taper it warns about. The scratch vector is cloned off
  // a real frame so it is a genuine THREE.Vector3 for _projectToRoute.
  const scratch = map._frameAt(host, 0).position.clone();
  const located = [];
  map.group.traverse((object) => {
    if (!object.isMesh || !object.name?.startsWith(`road marking ${id}`)) return;
    object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox;
    const centre = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
    const projection = map._projectToRoute(host, scratch.set(centre.x, centre.y, centre.z));
    located.push({
      name: object.name.slice(`road marking ${id} `.length),
      centre,
      span: Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z),
      hostS: projection?.distance ?? null,
      lateral: projection?.signedLateral ?? null,
    });
  });

  // --- the arrow texture, measured ---
  const readArrow = (key) => {
    const material = map._roadPaintMaterials?.get(key);
    if (!material) return null;
    const canvas = material.map.image;
    const context = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = context.getImageData(0, 0, width, height).data;
    const rows = [];
    for (let y = 0; y < height; y += 1) {
      let first = -1;
      let last = -1;
      let runs = 0;
      let inRun = false;
      for (let x = 0; x < width; x += 1) {
        const on = data[(y * width + x) * 4 + 3] > 120;
        if (on) { if (first < 0) first = x; last = x; }
        if (on && !inRun) runs += 1;
        inRun = on;
      }
      rows.push({ y, first, last, runs, width: first < 0 ? 0 : last - first + 1 });
    }
    return { width, height, rows, dataUrl: canvas.toDataURL('image/png') };
  };

  // The branch side: the ramp markings are placed off route.laneWidth, but the
  // ramp's paved edge in the merge tail is DERIVED from the Wangan, so its
  // half-width there need not be lanes * laneWidth / 2.
  const branch = map.getRoute(transition.branchRouteId);
  const branchAt = located
    .filter((entry) => entry.name.startsWith('ramp arrow') || entry.name.length === 1)
    .map((entry) => {
      const projection = map._projectToRoute(branch, scratch.set(entry.centre.x, entry.centre.y, entry.centre.z));
      const s = projection.distance;
      return {
        name: entry.name,
        branchS: s,
        lateral: projection.signedLateral,
        half: map._halfWidthAt(branch, s),
        painted: map._paintedLanes(branch, s).map((lane) => ({ ...lane })),
      };
    });

  return {
    branch: { id: branch.id, lanes: branch.lanes, laneWidth: branch.laneWidth, halfWidth: branch.halfWidth },
    branchAt,
    steps: transition.absorptionSteps.map((step) => ({ ...step })),
    fiveLaneStart: transition.fiveLaneStart,
    transitionEnd: transition.transitionEnd,
    sideSign: transition.sideSign,
    laneWidth: host.laneWidth,
    hostLanes: host.lanes,
    meshes: located,
    // Where each closing lane's PAINTED edges actually are, at the station the
    // arrow sits at. The lane-centre path is what the arrow rides; the
    // boundaries are what the driver sees. If those two disagree the arrow is
    // off-centre no matter how well it rides its own path.
    // The three lateral functions that actually PAINT the lines around the aux
    // lanes (map.js route dressing), not the laneBoundaries debug paths. The
    // outer edge line is inset from the geometric edge by a shoulder, so the
    // painted lane is neither as wide nor as centred as the geometry.
    lanes: Object.fromEntries(transition.absorptionSteps.map((step) => {
      const stations = [step.from - 60, step.from - 40, step.from - 20];
      return [step.lane, stations.map((hostS) => {
        const distance = map._normalizeDistance(host, hostS);
        const lane = map._progressivePaintedLane(transition, step.lane, distance);
        return { hostS, ...lane, pavedOuter: transition.envelopeAt(distance).outerLateral };
      })];
    })),
    arrows: Object.fromEntries([...(map._roadPaintMaterials?.keys() ?? [])]
      .filter((key) => key.startsWith('lane-arrow:'))
      .map((key) => [key, readArrow(key)])),
  };
}, ID);

if (report.error) { console.log(`FAIL  ${report.error}`); process.exit(1); }

console.log(`branch ${report.branch.id}: ${report.branch.lanes} lanes x ${report.branch.laneWidth} m, halfWidth ${report.branch.halfWidth}`);
for (const row of report.branchAt) {
  // The ramp markings must sit on a PAINTED lane centre — the midpoint between
  // the lines the driver sees, not the midpoint of `lanes * laneWidth`.
  const nearest = row.painted.reduce((best, lane) => (
    Math.abs(lane.centre - row.lateral) < Math.abs(best.centre - row.lateral) ? lane : best), row.painted[0]);
  const off = Math.abs(nearest.centre - row.lateral);
  const flag = off > 0.15 ? `  <-- OFF by ${off.toFixed(2)} m` : '';
  console.log(`  ${row.name.padEnd(18)} branchS=${row.branchS.toFixed(1)} lat=${row.lateral.toFixed(2)} half=${row.half.toFixed(2)} painted=[${row.painted.map((l) => `${l.centre.toFixed(2)}/${l.width.toFixed(2)}`).join(', ')}]${flag}`);
  if (flag) fail('ramp-marking-off-painted-lane', `${row.name}: ${row.lateral.toFixed(2)} vs ${nearest.centre.toFixed(2)}`);
}

console.log(`meshes (${report.meshes.length}):`);
for (const mesh of report.meshes) {
  console.log(`  ${mesh.name.padEnd(28)} hostS=${mesh.hostS?.toFixed(1)} lat=${mesh.lateral?.toFixed(2)} span=${mesh.span.toFixed(1)} m`);
}

// 1. a closure arrow in every absorption step's lane, each ending before the
// taper, each inside its own lane rather than straddling the line beside it
for (const step of report.steps) {
  const arrows = report.meshes.filter((entry) => entry.name.startsWith(`${step.lane} closure arrow`));
  if (!arrows.length) { fail('missing-closure-arrow', `${step.lane} (taper ${step.from.toFixed(0)}..${step.to.toFixed(0)})`); continue; }
  for (const mesh of arrows) {
    const head = mesh.hostS + mesh.span / 2;
    if (head > step.from) fail('closure-arrow-inside-taper', `${mesh.name}: head at ${head.toFixed(1)} >= taper start ${step.from.toFixed(1)}`);
  }
  // The lane the driver SEES is the gap between the painted lines. The arrow's
  // ribbon centre has to be that gap's centre, and the ribbon has to fit in it
  // — a ribbon wider than its lane puts paint over the line beside it.
  for (const row of report.lanes[step.lane]) {
    if (row.inner == null || row.outer == null) continue;
    const near = arrows.reduce((best, mesh) => (
      Math.abs(mesh.hostS - row.hostS) < Math.abs(best.hostS - row.hostS) ? mesh : best), arrows[0]);
    const offset = near.lateral - row.centre;
    console.log(`  ${step.lane} @${row.hostS.toFixed(0)}: painted ${row.inner.toFixed(2)}..${row.outer.toFixed(2)} (${row.width.toFixed(2)} m), nearest arrow ${near.lateral.toFixed(2)}, off by ${offset.toFixed(2)} m`);
    if (Math.abs(row.hostS - near.hostS) > near.span * 0.5) continue;
    if (Math.abs(offset) > 0.15) {
      fail('arrow-off-painted-lane-centre', `${near.name} @${row.hostS.toFixed(0)}: ${near.lateral.toFixed(2)} vs painted centre ${row.centre.toFixed(2)} (${offset.toFixed(2)} m)`);
    }
    // The ribbon is cut to the painted width, so a nonsense width would put
    // the arrow's head over a line even with the centre right.
    if (row.width < 3.2 || row.width > 4.6) {
      fail('implausible-painted-lane', `${step.lane} @${row.hostS.toFixed(0)}: ${row.width.toFixed(2)} m between the painted lines`);
    }
    // And the whole ribbon has to be on asphalt, measured against the real
    // paved envelope rather than a guess at how wide the carriageway is.
    if (Math.abs(near.lateral) + row.width * 0.5 > Math.abs(row.pavedOuter) + 0.05) {
      fail('arrow-off-pavement', `${near.name} @${row.hostS.toFixed(0)}: reaches ${(Math.abs(near.lateral) + row.width * 0.5).toFixed(2)} m, pavement ends at ${Math.abs(row.pavedOuter).toFixed(2)} m`);
    }
  }
}

// 2. every arrow texture: constant shaft width, single run per row, monotone drift
for (const [key, arrow] of Object.entries(report.arrows)) {
  if (!arrow) { fail('arrow-texture-missing', key); continue; }
  const [, , lengthMetres, widthMetres] = key.split(':');
  const metresPerPixelX = Number(widthMetres) / arrow.width;
  // The shaft is everything above the head base: rows whose painted run is
  // near the 0.45 m nominal. Sample the tail half, which is pure shaft.
  const shaftRows = arrow.rows.filter((row) => row.width > 0 && row.y > arrow.height * 0.28);
  const widths = shaftRows.map((row) => row.width * metresPerPixelX);
  const min = Math.min(...widths);
  const max = Math.max(...widths);
  const multiRun = shaftRows.filter((row) => row.runs > 1).length;
  const centres = shaftRows.map((row) => ((row.first + row.last) / 2) * metresPerPixelX);
  let reversals = 0;
  for (let i = 2; i < centres.length; i += 1) {
    const a = centres[i - 1] - centres[i - 2];
    const b = centres[i] - centres[i - 1];
    if (a * b < -1e-9 && Math.abs(a) > 0.01 && Math.abs(b) > 0.01) reversals += 1;
  }
  console.log(`\n${key}  ${lengthMetres} x ${widthMetres} m, tile ${arrow.width}x${arrow.height}`);
  console.log(`  shaft width ${min.toFixed(2)}..${max.toFixed(2)} m  multi-run rows=${multiRun}  centre reversals=${reversals}`);
  if (max - min > 0.12) fail('shaft-width-varies', `${key}: ${min.toFixed(2)}..${max.toFixed(2)} m across the swing`);
  if (max > 0.75) fail('shaft-too-wide', `${key}: ${max.toFixed(2)} m (nominal 0.45)`);
  if (multiRun > 0) fail('shaft-broken', `${key}: ${multiRun} rows paint more than one run`);
  if (reversals > 2) fail('shaft-wobbles', `${key}: ${reversals} centre reversals`);
  await writeFile(join(OUT, `MA-${key.replace(/[:.]/g, '_')}.png`),
    Buffer.from(arrow.dataUrl.split(',')[1], 'base64'));
}

if (SHOTS) {
  // Straight down, tight, right over each marking: the only view in which
  // "is it centred in its lane and does it read" is answerable at all.
  const overhead = report.meshes.map((mesh) => ({
    name: `top-${mesh.name.replace(/[: ]/g, '-')}`,
    x: mesh.centre.x,
    z: mesh.centre.z,
    y: mesh.centre.y,
    up: 30,
  }));
  const cases = [
    ...overhead,
    // Driver's eye, ON the painted lane centre the arrows are drawn on — the
    // one view that answers "does this read at speed". Laterals come from the
    // measurement above, not from a guess at where the lane is.
    ...report.steps.map((step, index) => {
      const row = report.lanes[step.lane][0];
      return {
        name: `${step.lane.replace(':', '-')}-eye`,
        // Just inside the run in which this lane exists at full width, so both
        // of its arrows are ahead of the camera and nothing else is.
        at: step.from - 68,
        up: 1.7,
        pitch: -0.04,
        back: 0,
        lateral: row.centre,
      };
    }),
  ];
  for (const c of cases) {
    await page.evaluate((s) => {
      const g = window.shutoko;
      const host = g.map.getRoute('wangan_0');
      if (!g.debug.noclip) g.setNoclip(true);
      if (s.x !== undefined) {
        // Overhead: yaw along the host so "up" in the image is downstream.
        const projection = g.map._projectToRoute(host, g.map._frameAt(host, 0).position.clone().set(s.x, s.y, s.z));
        const frame = g.map._frameAt(host, projection.distance);
        g.debug.position.set(s.x, s.y + s.up, s.z);
        g.debug.yaw = Math.atan2(frame.tangent.x, frame.tangent.z);
        g.debug.pitch = -1.5;
        return;
      }
      const distance = g.map._normalizeDistance(host, s.at);
      const frame = g.map._frameAt(host, distance);
      const anchor = frame.position.clone().addScaledVector(frame.normal, s.lateral || 0);
      g.debug.position.set(
        anchor.x - frame.tangent.x * s.back,
        anchor.y + s.up,
        anchor.z - frame.tangent.z * s.back,
      );
      g.debug.yaw = Math.atan2(frame.tangent.x, frame.tangent.z);
      g.debug.pitch = s.pitch;
    }, c);
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `MA-${c.name}.png`) });
    console.log(`shot MA-${c.name}.png`);
  }
}

await browser.close();
server.close();
if (failures) { console.log(`\nMERGE ARROW PROBE: FAIL (${failures})`); process.exit(1); }
console.log('\nMERGE ARROW PROBE: PASS');
