/**
 * Body attitude on the shell, in the real game.
 *
 * The car mesh used to be yaw-only — a brick that changed heading, never leaned
 * into a corner, never dived on the brakes and stayed level up a ramp. It now
 * takes the sim's roll and pitch plus the gradient it is driving on. The model
 * faces backwards (yaw + PI), so its local +X points to the car's LEFT and its
 * local -Z is the nose, which flips two of the three signs; this checks
 * world-space nose and roof vectors rather than raw Euler numbers.
 *
 * Like driving-camera-probe.mjs this drives the real `updatePlayerMesh()` with
 * synthetic vehicle state instead of trying to drive the world, which is what
 * makes it deterministic. The physics that produces those roll/pitch values is
 * covered by handling-probe.mjs.
 *
 * Run from repo root:  node .devtests/body-attitude-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// Split routing: the core build and the examples/jsm addons are different files,
// and a blanket route hands `three/addons/` the core build and kills the boot.
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
  try {
    const body = await readFile(join(ROOT, 'node_modules/three', rel));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  } catch {
    await route.fulfill({ status: 404, body: 'nope' });
  }
});

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const page = await context.newPage();
const consoleErrors = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 90000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 20000 });

/**
 * Pose the car with a given heading, body attitude and climb, then read back
 * the shell's nose and roof in world space relative to the car's own heading.
 * `rise` is metres gained per metre travelled, fed in over several frames so
 * the climb smoother settles.
 */
const pose = (options) => page.evaluate(({ heading, bodyRoll, bodyPitch, rise, frames }) => {
  const game = window.shutoko;
  const physics = game.physics;
  const step = 3;
  physics.setPosition(0, 0, 0, heading);
  game._bodyClimb = 0;
  game._bodyClimbFrom = null;
  game.updatePlayerMesh(null);
  for (let i = 0; i < frames; i += 1) {
    physics.position.set(Math.sin(heading) * step * i, rise * step * i, Math.cos(heading) * step * i);
    physics.bodyRoll = bodyRoll;
    physics.bodyPitch = bodyPitch;
    physics._refreshPublicState();
    game.updatePlayerMesh(1 / 60);
  }
  const q = game.playerMesh.quaternion;
  const apply = (x, y, z) => {
    const ix = q.w * x + q.y * z - q.z * y;
    const iy = q.w * y + q.z * x - q.x * z;
    const iz = q.w * z + q.x * y - q.y * x;
    const iw = -q.x * x - q.y * y - q.z * z;
    return [
      ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
      iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
      iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    ];
  };
  const nose = apply(0, 0, -1);
  const roof = apply(0, 1, 0);
  const forward = [Math.sin(heading), 0, Math.cos(heading)];
  const right = [Math.cos(heading), 0, -Math.sin(heading)];
  return {
    noseY: nose[1],
    noseForward: (nose[0] * forward[0] + nose[2] * forward[2]) / Math.hypot(nose[0], nose[2]),
    roofRight: roof[0] * right[0] + roof[2] * right[2],
    climb: game._bodyClimb,
  };
}, { heading: 0, bodyRoll: 0, bodyPitch: 0, rise: 0, frames: 40, ...options });

// Heading 0 and an awkward heading, so nothing passes by accident on a
// world axis.
for (const heading of [0, 1.1]) {
  const level = await pose({ heading });
  check(`heading ${heading}: level car sits level and faces forward`,
    Math.abs(level.noseY) < 1e-6 && level.noseForward > 0.9999 && Math.abs(level.roofRight) < 1e-6,
    `nose·forward ${level.noseForward.toFixed(4)}`);

  // A right-hand corner puts lateral acceleration to the car's right, which the
  // sim signs as a negative bodyRoll. The shell must lean OUTWARD, to the left.
  const rightTurn = await pose({ heading, bodyRoll: -0.058 });
  check(`heading ${heading}: right-hand corner leans the roof outward (left)`,
    rightTurn.roofRight < -0.05, `roof·right ${rightTurn.roofRight.toFixed(3)}`);

  const leftTurn = await pose({ heading, bodyRoll: 0.058 });
  check(`heading ${heading}: left-hand corner leans it the other way`,
    leftTurn.roofRight > 0.05, `roof·right ${leftTurn.roofRight.toFixed(3)}`);

  const braking = await pose({ heading, bodyPitch: 0.05 });
  check(`heading ${heading}: braking dives the nose`, braking.noseY < -0.045,
    `nose Y ${braking.noseY.toFixed(3)}`);

  const accelerating = await pose({ heading, bodyPitch: -0.05 });
  check(`heading ${heading}: accelerating squats and lifts the nose`, accelerating.noseY > 0.045,
    `nose Y ${accelerating.noseY.toFixed(3)}`);

  const climbing = await pose({ heading, rise: 0.12 });
  check(`heading ${heading}: a climb points the nose up it`, climbing.noseY > 0.1,
    `nose Y ${climbing.noseY.toFixed(3)}, climb ${climbing.climb.toFixed(3)} rad`);

  const descending = await pose({ heading, rise: -0.12 });
  check(`heading ${heading}: a descent points it down`, descending.noseY < -0.1,
    `nose Y ${descending.noseY.toFixed(3)}`);
}

// A teleport (dt null) must not pitch the car through the jump.
const jumped = await pose({ heading: 0.6, rise: 0.15, frames: 1 });
check('a teleport does not fling the body', Math.abs(jumped.noseY) < 0.02,
  `nose Y ${jumped.noseY.toFixed(4)}`);

check('no page errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await browser.close();
server.close();
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
