/**
 * Fixed cameras on the two spots the lamp work targets:
 *  1. MBL-merge-*  — the ramp_8 -> wangan_0 progressive merge (J13). The poles
 *     used to stand on the wangan's pre-merge kerb, which the appended ramp
 *     lanes turned into a paint line down the middle of the five-lane deck.
 *  2. MBL-bay-*    — the Tatsumi PA lay-by, whose outer (PA-side) edge carried
 *     no lamp row at all.
 *
 * Every camera is derived from the map's own geometry, so runs are comparable.
 *
 * Run: node .devtests/merge-bay-lamp-shots.mjs  -> .devtests/shots/MBL-*.png
 *
 * NOTE the SPLIT cdn routing: the game imports both `three` and
 * `three/addons/...`, so a blanket jsdelivr route kills the page.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
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

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/build/three.module.js')) });
});
await context.route('https://cdn.jsdelivr.net/**/examples/jsm/**', async (route) => {
  const rest = route.request().url().split('/examples/jsm/')[1];
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/examples/jsm', rest)) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 90000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 20000 });
await page.evaluate(() => { window.shutoko.setNoclip(true); });
await page.waitForTimeout(800);

// Camera at (station `s`, `lateral`, `up`) on `routeId`, aimed exactly at
// (station `aimS`, `aimLateral`) on the same route — both yaw AND pitch come
// out of the geometry, so the framing is reproducible instead of guessed.
const aim = async (name, routeId, { s, lateral, up }, { s: aimS, lateral: aimLateral = 0 }) => {
  const info = await page.evaluate(({ routeId, s, lateral, up, aimS, aimLateral }) => {
    const map = window.shutoko.map;
    const route = map.routes.get(routeId);
    const at = (distance, across) => {
      const center = map._sampleCenter(route, distance, 1);
      const t = center.baseTangent;
      const n = { x: -t.z, z: t.x };
      const length = Math.hypot(n.x, n.z) || 1;
      return {
        x: center.position.x + (n.x / length) * across,
        y: center.position.y,
        z: center.position.z + (n.z / length) * across,
      };
    };
    const eye = at(s, lateral);
    eye.y += up;
    const target = at(aimS, aimLateral);
    const dx = target.x - eye.x;
    const dz = target.z - eye.z;
    const g = window.shutoko;
    g.debug.position.set(eye.x, eye.y, eye.z);
    // The drone camera's forward is (sin yaw, sin pitch, cos yaw) — POSITIVE
    // (game.js updateDebugCamera), so the yaw toward a target is un-negated.
    g.debug.yaw = Math.atan2(dx, dz);
    g.debug.pitch = Math.atan2(target.y - eye.y, Math.hypot(dx, dz));
    return {
      eye: [+eye.x.toFixed(1), +eye.y.toFixed(1), +eye.z.toFixed(1)],
      pitch: +g.debug.pitch.toFixed(2),
      range: +Math.hypot(dx, dz).toFixed(1),
    };
  }, { routeId, s, lateral, up, aimS, aimLateral });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`${name} ${JSON.stringify(info)}`);
};

// Camera looking down `routeId` from station `s`, `up` metres over the deck,
// offset `lateral` metres across it. Pitch is set from the geometry.
const look = async (name, routeId, s, lateral, up, pitch, ahead = 120) => {
  const info = await page.evaluate(({ routeId, s, lateral, up, pitch, ahead }) => {
    const map = window.shutoko.map;
    const route = map.routes.get(routeId);
    const at = (distance) => {
      const center = map._sampleCenter(route, distance, 1);
      const tangent = center.baseTangent;
      const normal = { x: -tangent.z, y: 0, z: tangent.x };
      const length = Math.hypot(normal.x, normal.z) || 1;
      normal.x /= length; normal.z /= length;
      return { center, tangent, normal };
    };
    const here = at(s);
    const target = at(Math.min(route.length - 1, s + ahead));
    const eye = {
      x: here.center.position.x + here.normal.x * lateral,
      y: here.center.position.y + up,
      z: here.center.position.z + here.normal.z * lateral,
    };
    const to = { x: target.center.position.x - eye.x, z: target.center.position.z - eye.z };
    const g = window.shutoko;
    g.debug.position.set(eye.x, eye.y, eye.z);
    g.debug.yaw = Math.atan2(to.x, to.z);
    g.debug.pitch = pitch;
    return { eye: [+eye.x.toFixed(1), +eye.y.toFixed(1), +eye.z.toFixed(1)], yaw: +g.debug.yaw.toFixed(2) };
  }, { routeId, s, lateral, up, pitch, ahead });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`${name} ${JSON.stringify(info)}`);
};

// 1. The merge. 1520 catches the opening, 1640 the five-lane section where the
//    six stray poles stood, 1760 the taper back to three lanes.
await look('MBL-merge-opening', 'wangan_0', 1500, 0, 14, -0.22);
await look('MBL-merge-full5', 'wangan_0', 1600, -6, 12, -0.20);
await look('MBL-merge-taper', 'wangan_0', 1720, -6, 12, -0.20);
await look('MBL-merge-eye', 'wangan_0', 1560, -4, 2.2, -0.04, 160);

// Camera placed IN THE AIM POINT'S OWN FRAME: `back` metres upstream along the
// road, `out` metres to the side of it, `up` metres above — so the subject is
// always centred no matter which way the route runs.
const orbit = async (name, routeId, target, { back, out, up }) => {
  const info = await page.evaluate(({ routeId, target, back, out, up }) => {
    const map = window.shutoko.map;
    const route = map.routes.get(routeId);
    const center = map._sampleCenter(route, target.s, 1);
    const t = center.baseTangent;
    const n = { x: -t.z, z: t.x };
    const length = Math.hypot(n.x, n.z) || 1;
    n.x /= length; n.z /= length;
    const point = {
      x: center.position.x + n.x * (target.lateral || 0),
      y: center.position.y,
      z: center.position.z + n.z * (target.lateral || 0),
    };
    const eye = {
      x: point.x - t.x * back + n.x * out,
      y: point.y + up,
      z: point.z - t.z * back + n.z * out,
    };
    const dx = point.x - eye.x;
    const dz = point.z - eye.z;
    const g = window.shutoko;
    g.debug.position.set(eye.x, eye.y, eye.z);
    g.debug.yaw = Math.atan2(dx, dz);
    g.debug.pitch = Math.atan2(point.y - eye.y, Math.hypot(dx, dz));
    return { eye: [+eye.x.toFixed(1), +eye.y.toFixed(1), +eye.z.toFixed(1)], pitch: +g.debug.pitch.toFixed(2) };
  }, { routeId, target, back, out, up });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  // Centre crop as well: at deviceScaleFactor 1.5 this reads as a 2x zoom on
  // whatever the camera was aimed at, which is what these shots exist for.
  await page.screenshot({ path: join(OUT, `${name}-crop.png`), clip: { x: 660, y: 330, width: 600, height: 420 } });
  console.log(`${name} ${JSON.stringify(info)}`);
};

// 1b. Close on the outer edge where ramp_8's deck hands the parapet to the
//     host envelope (host s ~1580) — the reported break in the surface.
// Straight down over the whole handoff: any bite out of the pavement, any step
// in the parapet line, shows up immediately from here.
await orbit('MBL-seam-top', 'wangan_0', { s: 1570, lateral: -8 }, { back: 0.01, out: 0, up: 110 });
await orbit('MBL-seam-top2', 'wangan_0', { s: 1620, lateral: -8 }, { back: 0.01, out: 0, up: 110 });
await orbit('MBL-seam-a', 'wangan_0', { s: 1580, lateral: -12 }, { back: 22, out: -6, up: 6 });

// 1c. The new Shutoko-style road markings on the ramp before the merge.
await aim('MBL-mark-text', 'ramp_8', { s: 962, lateral: 1.6, up: 2.0 }, { s: 1020, lateral: 2.2 });
await aim('MBL-mark-arrow', 'ramp_8', { s: 1022, lateral: 1.6, up: 2.2 }, { s: 1078, lateral: 2.2 });
await orbit('MBL-mark-top', 'ramp_8', { s: 1020, lateral: 2.2 }, { back: 0.01, out: 0, up: 60 });

// 2. The Tatsumi bay: down it at eye level, and from up the approach so the
//    whole widening is in frame.
await look('MBL-bay-eye', 'ramp_8', 575, 8, 2.2, -0.03, 90);
await orbit('MBL-bay-drone', 'ramp_8', { s: 625, lateral: 8 }, { back: 150, out: 26, up: 46 });
await orbit('MBL-bay-tail', 'ramp_8', { s: 680, lateral: 8 }, { back: -55, out: 14, up: 8 });

console.log(errors.length ? `ERRORS: ${errors.slice(0, 5).join(' | ')}` : 'no page errors');
await browser.close(); server.close();
