/**
 * Driving stutter probe: boots the real game in Chromium, drives the car with
 * a lane-following autopilot for a while, and attributes every long frame to
 * a subsystem (physics / traffic / map streaming / render / other) plus the
 * renderer resource deltas (geometry uploads, texture uploads, shader program
 * compiles) that happened on that frame.
 *
 * Run: node .devtests/driving-stutter-probe.mjs [--seconds=75] [--label=name]
 *      [--root=/path/to/checkout]
 * Prints a summary and writes the full per-frame log to
 * .devtests/diag/stutter-<label>.json
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => {
  const raw = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : fallback;
};
const ROOT = (() => {
  const raw = arg('root', HARNESS_ROOT);
  return isAbsolute(raw) ? raw : resolve(raw);
})();
const SECONDS = Number(arg('seconds', '75'));
const LABEL = arg('label', 'run');
const THREE_MODULE = join(HARNESS_ROOT, 'node_modules', 'three', 'build', 'three.module.js');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = request.url.split('?')[0];
    const file = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 880, height: 500 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(THREE_MODULE);
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 15000 });
// Let the exit-garage fade and first-frame work settle before measuring.
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const game = window.shutoko;
  const clampValue = (value, low, high) => Math.min(high, Math.max(low, value));
  const wrapAngle = (value) => {
    const tau = Math.PI * 2;
    return ((value + Math.PI) % tau + tau) % tau - Math.PI;
  };

  // Keep the probe alive: scrapes must not enter crash mode / tow flow.
  game.registerContact = () => {};
  game.admin.infiniteFuel = true;

  const probe = {
    frames: [],
    teleports: 0,
    started: performance.now(),
    acc: { phys: 0, traffic: 0, map: 0, render: 0, roadInfo: 0 },
  };
  window.__stutterProbe = probe;

  const wrapMethod = (target, key, slot) => {
    const original = target[key].bind(target);
    target[key] = (...args) => {
      const t0 = performance.now();
      const result = original(...args);
      probe.acc[slot] += performance.now() - t0;
      return result;
    };
  };
  wrapMethod(game.physics, 'update', 'phys');
  if (game.traffic) wrapMethod(game.traffic, 'update', 'traffic');
  wrapMethod(game.map, 'update', 'map');
  wrapMethod(game.renderer, 'render', 'render');
  wrapMethod(game.map, 'getRoadInfo', 'roadInfo');

  // Lane-following autopilot at highway speed.
  let preferredRoute = null;
  let stuckSince = null;
  game.getInput = () => {
    const physics = game.physics;
    const position = physics.position;
    const speed = physics.velocity.length();
    let steer = 0;
    let throttle = 1;
    let brake = 0;
    try {
      const info = game.map.getRoadInfo(position, preferredRoute);
      if (info) {
        preferredRoute = info.routeId;
        const direction = info.direction || 1;
        const lookahead = 15 + speed * 0.6;
        const target = game.map.sampleLane(
          info.routeId,
          info.distance + lookahead * direction,
          Math.min(info.lane ?? 0, (info.lanes ?? 1) - 1),
          direction,
        );
        if (target) {
          const desired = Math.atan2(target.position.x - position.x, target.position.z - position.z);
          steer = clampValue(wrapAngle(desired - physics.heading) * 2.4, -1, 1);
        }
      }
      const speedKmh = speed * 3.6;
      throttle = speedKmh < 125 ? 1 : 0;
      brake = speedKmh > 140 ? 0.4 : 0;

      const now = performance.now();
      if (speed < 2.5) {
        stuckSince = stuckSince ?? now;
        if (now - stuckSince > 3500 && info) {
          const direction = info.direction || 1;
          const rescue = game.map.sampleLane(info.routeId, info.distance + 30 * direction, 0, direction);
          if (rescue) {
            physics.setPosition(rescue.position.x, rescue.position.y + 0.6, rescue.position.z, rescue.heading);
            physics.setSpeed(20);
            game.snapDrivingCamera();
            probe.teleports += 1;
          }
          stuckSince = null;
        }
      } else {
        stuckSince = null;
      }
    } catch {
      /* keep last input on transient sampling errors */
    }
    return { throttle, brake, steer, handbrake: false, shiftUp: false, shiftDown: false, clutch: false };
  };

  // Frame recorder around the real loop. `game.animate` re-reads
  // `this.animate` when scheduling the next frame, so this override takes
  // effect from the next frame on.
  const originalAnimate = game.animate.bind(game);
  let lastStart = null;
  let frameIndex = 0;
  game.animate = () => {
    const info = game.renderer.info;
    const before = {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs.length,
    };
    for (const key of Object.keys(probe.acc)) probe.acc[key] = 0;
    const t0 = performance.now();
    originalAnimate();
    const total = performance.now() - t0;
    const record = {
      t: Math.round(t0 - probe.started),
      gap: lastStart === null ? 0 : Number((t0 - lastStart).toFixed(2)),
      total: Number(total.toFixed(2)),
      phys: Number(probe.acc.phys.toFixed(2)),
      traffic: Number(probe.acc.traffic.toFixed(2)),
      map: Number(probe.acc.map.toFixed(2)),
      render: Number(probe.acc.render.toFixed(2)),
      roadInfo: Number(probe.acc.roadInfo.toFixed(2)),
      dGeo: info.memory.geometries - before.geometries,
      dTex: info.memory.textures - before.textures,
      dProg: info.programs.length - before.programs,
      traf: game.traffic?.active?.length ?? 0,
      speed: Math.round(game.physics.velocity.length() * 3.6),
      route: preferredRoute,
    };
    if (frameIndex % 30 === 0 || total > 25) {
      record.heapMb = performance.memory
        ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(1))
        : null;
      let visible = 0;
      for (const chunk of game.map._chunks.values()) if (chunk.group.visible) visible += 1;
      record.chunksVis = visible;
    }
    lastStart = t0;
    frameIndex += 1;
    probe.frames.push(record);
  };
});

console.log(`Driving for ${SECONDS}s ...`);
await page.waitForTimeout(SECONDS * 1000);

const data = await page.evaluate(() => {
  const probe = window.__stutterProbe;
  return { frames: probe.frames, teleports: probe.teleports };
});
await browser.close();
server.close();

const frames = data.frames.slice(5); // discard wrapper warm-up frames
const sortedTotals = frames.map((frame) => frame.total).sort((a, b) => a - b);
const sortedGaps = frames.map((frame) => frame.gap).sort((a, b) => a - b);
const percentile = (fraction) => sortedTotals[Math.min(sortedTotals.length - 1, Math.floor(sortedTotals.length * fraction))];
const gapPercentile = (fraction) => sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(sortedGaps.length * fraction))];
const spikes = frames.filter((frame) => frame.total > 25);
const attribute = (frame) => {
  const known = { phys: frame.phys, traffic: frame.traffic, map: frame.map, render: frame.render };
  const other = frame.total - known.phys - known.traffic - known.map - known.render;
  const entries = [...Object.entries(known), ['other', other]];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
};
const byCause = {};
for (const frame of spikes) {
  const cause = attribute(frame);
  byCause[cause] = byCause[cause] ?? { count: 0, worst: 0, uploads: 0 };
  byCause[cause].count += 1;
  byCause[cause].worst = Math.max(byCause[cause].worst, frame.total);
  if (frame.dGeo > 0 || frame.dTex > 0 || frame.dProg > 0) byCause[cause].uploads += 1;
}

const summary = {
  label: LABEL,
  seconds: SECONDS,
  frames: frames.length,
  teleports: data.teleports,
  frameMs: {
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    p99: Number(percentile(0.99).toFixed(2)),
    max: Number(sortedTotals[sortedTotals.length - 1].toFixed(2)),
  },
  frameGapMs: {
    p50: Number(gapPercentile(0.5).toFixed(2)),
    p95: Number(gapPercentile(0.95).toFixed(2)),
    p99: Number(gapPercentile(0.99).toFixed(2)),
    max: Number(sortedGaps[sortedGaps.length - 1].toFixed(2)),
  },
  spikesOver25ms: spikes.length,
  spikesOver50ms: spikes.filter((frame) => frame.total > 50).length,
  spikesOver100ms: spikes.filter((frame) => frame.total > 100).length,
  spikeCauses: byCause,
  uploadsDuringDrive: {
    geometries: frames.reduce((sum, frame) => sum + Math.max(0, frame.dGeo), 0),
    textures: frames.reduce((sum, frame) => sum + Math.max(0, frame.dTex), 0),
    programs: frames.reduce((sum, frame) => sum + Math.max(0, frame.dProg), 0),
  },
  errors,
};
console.log(JSON.stringify(summary, null, 2));
console.log('\nWorst 12 frames:');
for (const frame of [...spikes].sort((a, b) => b.total - a.total).slice(0, 12)) {
  console.log(
    `  t=${(frame.t / 1000).toFixed(1)}s total=${frame.total}ms `
    + `phys=${frame.phys} traffic=${frame.traffic} map=${frame.map} render=${frame.render} `
    + `roadInfo=${frame.roadInfo} dGeo=${frame.dGeo} dTex=${frame.dTex} dProg=${frame.dProg} `
    + `traf=${frame.traf} route=${frame.route} speed=${frame.speed}`,
  );
}

await mkdir(join(HARNESS_ROOT, '.devtests', 'diag'), { recursive: true });
const outPath = join(HARNESS_ROOT, '.devtests', 'diag', `stutter-${LABEL}.json`);
await writeFile(outPath, JSON.stringify({ summary, frames }, null, 1));
console.log(`\nFull log: ${outPath}`);
