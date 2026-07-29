/**
 * ?diag=native probe (handheld profile).
 *
 * Verifies the diagnostic switch actually removes the variable it claims to,
 * on the profile it exists for. A phone never draws at native: qualityScale in
 * applyRenderResolution is .4/.5/.62, so even High renders ~38% of the pixels
 * and stretches the frame over the display. Desktop Medium and High draw at
 * 1.0. That difference is the last structural one between the two, and the
 * road speckling has only ever been reported on the phone.
 *
 * Sending someone to test on a real device is only worth it if the switch is
 * known to work, so this asserts the frame really is native with the parameter
 * and really is not without it — including that the adaptive governor and the
 * thermal pixel cap both stand aside, either of which would silently clamp the
 * frame back down and make the test answer the wrong question.
 *
 * Run: node .devtests/diag-native-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.obj': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
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
await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

async function boot(query) {
  // A real phone context: coarse primary pointer, no fine pointer, touch — the
  // inputs isHandheldDevice keys on (see .devtests/device-profile.test.mjs).
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const url = new URL(route.request().url());
    const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
    const file = addon
      ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
      : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto(`http://127.0.0.1:${port}/${query}`);
  await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
  // High is the tier that gets closest to native on its own (.62), so it is the
  // strictest backdrop for the claim that only the switch reaches 1.0.
  const measured = await page.evaluate(() => {
    window.shutoko.changeSetting('quality', 'high');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    return {
      handheld: window.shutoko.isHandheld,
      diagNative: window.shutoko.diagNative,
      width: window.shutoko.canvas.width,
      height: window.shutoko.canvas.height,
      displayWidth: Math.round(window.innerWidth * dpr),
      displayHeight: Math.round(window.innerHeight * dpr),
      badge: document.getElementById('render-info')?.textContent || '',
    };
  });
  await context.close();
  return { ...measured, errors };
}

const off = await boot('');
check('probe runs on the handheld profile', off.handheld === true, `handheld=${off.handheld}`);
check('without the parameter the switch is inert', off.diagNative === false, `diagNative=${off.diagNative}`);
check('without it a phone draws BELOW native even at High',
  off.width < off.displayWidth,
  `${off.width}×${off.height} vs display ${off.displayWidth}×${off.displayHeight}`);
check('and the boot readout does not claim the diagnostic', !off.badge.includes('DIAG:NATIVE'), off.badge.trim());

const on = await boot('?diag=native');
check('the parameter is picked up', on.diagNative === true, `diagNative=${on.diagNative}`);
check('with it the frame IS native — quality scale bypassed',
  on.width === on.displayWidth && on.height === on.displayHeight,
  `${on.width}×${on.height} vs display ${on.displayWidth}×${on.displayHeight}`);
check('the thermal pixel cap stands aside too',
  on.width * on.height > off.width * off.height,
  `${(on.width * on.height / 1e6).toFixed(2)} MP vs ${(off.width * off.height / 1e6).toFixed(2)} MP`);
check('the boot readout names the switch, so a photo is self-documenting',
  on.badge.includes('DIAG:NATIVE') && on.badge.includes('✓'), on.badge.trim());
check('no console errors', on.errors.length === 0 && off.errors.length === 0,
  [...on.errors, ...off.errors].slice(0, 2).join(' · '));

await browser.close();
server.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
