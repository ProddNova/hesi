/**
 * Road "confetti" probe.
 *
 * Shoots the same stretch of asphalt three ways:
 *   - desktop (what the PC shows),
 *   - phone-emulated (the code path a phone takes: low internal resolution,
 *     stretched over a dense display),
 *   - desktop with vUv forced through half precision.
 *
 * It also reports the road's sampling state — texture size, anisotropy, mip
 * bias, framebuffer vs display pixels — which is what the mobile-only speckle
 * turned out to hinge on: a phone draws ~421 px wide and shows it across 1170,
 * so the asphalt reaches the eye ~1.5 mip levels sharper than it can be
 * resolved. Half precision was ruled out as the cause by this probe; the
 * numbers it prints are the ones that matter.
 *
 * Run: node .devtests/confetti-probe.mjs
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const CASES = [
  { name: 'desktop', halfUv: false, options: { viewport: { width: 900, height: 1000 }, deviceScaleFactor: 1 } },
  { name: 'desktop-halfuv', halfUv: true, options: { viewport: { width: 900, height: 1000 }, deviceScaleFactor: 1 } },
  { name: 'phone', halfUv: false, options: { ...devices['iPhone 13'], isMobile: true, hasTouch: true } },
];

for (const spec of CASES) {
  const context = await browser.newContext(spec.options);
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const url = new URL(route.request().url());
    const addon = url.pathname.match(/examples\/jsm\/(.+)$/);
    const file = addon ? `node_modules/three/examples/jsm/${addon[1]}` : 'node_modules/three/build/three.module.js';
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, file)) });
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.error(`${spec.name} pageerror:`, String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 120000 });
  await page.click('#new-game-button');
  await page.waitForFunction(() => window.shutoko?.mode === 'garage', null, { timeout: 20000 });
  await page.evaluate(() => window.shutoko.exitGarage());
  await page.waitForFunction(() => window.shutoko?.mode === 'driving', null, { timeout: 20000 });
  await page.waitForTimeout(3000);

  if (spec.halfUv) {
    await page.evaluate(() => {
      const map = window.shutoko.map;
      for (const name of ['road', 'roadAlt', 'roadService', 'marking']) {
        const material = map.materials[name];
        if (!material) continue;
        material.onBeforeCompile = (shader) => {
          // Emulate a half-precision varying: snap vUv onto the fp16 lattice.
          shader.fragmentShader = shader.fragmentShader.replace('void main() {', `
            vec2 halfPrecision(vec2 value) {
              vec2 magnitude = max(abs(value), 1e-6);
              vec2 exponent = floor(log2(magnitude));
              vec2 step = exp2(exponent - 10.0);
              return floor(value / step + 0.5) * step;
            }
            void main() {`).replace('#include <map_fragment>', `
            {
              vec4 sampledDiffuseColor = texture2D( map, halfPrecision( vMapUv ) );
              diffuseColor *= sampledDiffuseColor;
            }`);
        };
        material.needsUpdate = true;
      }
    });
  }

  await page.addStyleTag({ content: '#game-shell > :not(#game-canvas) { visibility: hidden !important; }' });

  // Chase view down the Wangan mainline — the same angle the report shows.
  const placement = await page.evaluate(() => {
    const game = window.shutoko;
    game.traffic?.setDensity?.(0);
    game.traffic?.vehicles?.forEach?.((vehicle) => { if (vehicle.mesh) vehicle.mesh.visible = false; });
    const map = game.map;
    const route = map.getRoute('wangan_1');
    const distance = route.length * 0.35;
    if (game.debug.noclip) game.setNoclip(false);
    const lane = map.sampleLane(route.id, distance, 0, 1);
    game.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    game.physics.setSpeed(0);
    map._visibleKey = null;
    map.update(lane.position, performance.now() / 1000);
    game.snapDrivingCamera();
    return {
      route: route.id,
      world: { x: +lane.position.x.toFixed(1), z: +lane.position.z.toFixed(1) },
      uv: { u: +(lane.position.x / 12).toFixed(1), v: +(lane.position.z / 12).toFixed(1) },
    };
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `confetti-${spec.name}.png`) });

  const report = await page.evaluate(() => {
    const game = window.shutoko;
    const t = game.map.materials.road?.map;
    return {
      quality: game.renderQuality(),
      touch: game.isTouchDevice,
      precision: game.renderer.capabilities.precision,
      webgl2: game.renderer.capabilities.isWebGL2,
      canvas: [game.canvas.width, game.canvas.height],
      texture: t ? { w: t.image?.width, h: t.image?.height, aniso: t.anisotropy, mips: t.generateMipmaps } : null,
      mipBias: Number(game.map._surfaceMipBias?.value?.toFixed(2)),
      displayPx: Math.round(game.canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 3)),
    };
  });
  console.log(`${spec.name}: ${JSON.stringify({ ...report, ...placement })}`);
  await context.close();
}

await browser.close();
server.close();
