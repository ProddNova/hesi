/**
 * Close exterior shots of a styled barrier, with whatever texture the editor
 * project has assigned to it — the angle the tiling and the "is it one piece?"
 * question are actually judged from.
 *
 * Uses the editor viewport (free camera) rather than the game's chase camera.
 * Needs the dev server: node tools/hesi-editor/server.mjs
 * Run: node .devtests/barrier-texture-shots.mjs [--port 8081] [--route ramp_8]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, '.devtests/shots');
const PORT = arg('port', '8081');
const ROUTE = arg('route', 'ramp_8');

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(`http://localhost:${PORT}/tools/hesi-editor/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 240000 });
// Saved world textures land during project load; give them a beat to decode.
await page.waitForTimeout(6000);

for (const [name, fraction] of [['near', 0.25], ['far', 0.6]]) {
  const placed = await page.evaluate(({ routeId, atFraction }) => {
    const app = window.hesiEditor;
    const map = app.adapter.map;
    const route = map.routes.get(routeId);
    if (!route) return null;
    const frames = route.surfaceFrames;
    const frame = frames[Math.floor(frames.length * atFraction)];
    // Stand outside the barrier on the +normal side, at wall height, looking
    // along the run so several segments and their joints are in frame.
    const nx = -frame.tangent.z;
    const nz = frame.tangent.x;
    app.viewport.camera.position.set(
      frame.position.x + nx * 7 - frame.tangent.x * 13,
      frame.position.y + 2.2,
      frame.position.z + nz * 7 - frame.tangent.z * 13,
    );
    app.viewport.orbit.target.set(
      frame.position.x + nx * 2,
      frame.position.y + 1.9,
      frame.position.z + nz * 2,
    );
    app.viewport.orbit.update();
    app.adapter.setChunkMode('all');
    return { distance: frame.distance, y: frame.position.y };
  }, { routeId: ROUTE, atFraction: fraction });
  if (!placed) { console.log(`route ${ROUTE} not found`); break; }
  await page.waitForTimeout(1500);
  const file = join(SHOTS, `barrier-texture-${ROUTE}-${name}.png`);
  // The viewport canvas animates continuously, so Playwright's stability wait
  // never settles: clip the full-page shot to its box instead.
  const box = await page.locator('canvas').first().boundingBox();
  await page.screenshot({ path: file, clip: box });
  console.log(`${name}: chainage ${placed.distance.toFixed(0)} m → ${file}`);
}

if (errors.length) console.log(`page errors: ${errors.slice(0, 2).join(' | ')}`);
await browser.close();
