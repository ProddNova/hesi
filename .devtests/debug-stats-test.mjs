/**
 * Debug stats overlay regression: I toggles the on-screen stats panel,
 * P starts/stops a stats-log recording and stopping copies a tab-separated
 * log to the clipboard.
 *
 * Run from repo root:  node .devtests/debug-stats-test.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : decodeURIComponent(path);
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1024, height: 600 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

await page.goto(`${origin}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.click('#continue-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.waitForTimeout(800);

// --- I toggles the overlay ---
check('overlay hidden before first toggle', await page.evaluate(() => {
  const panel = document.getElementById('debug-stats-panel');
  return !panel || panel.style.display === 'none';
}));
await page.keyboard.press('KeyI');
await page.waitForTimeout(600);
const panelText = await page.evaluate(() => document.getElementById('debug-stats-panel')?.textContent || '');
check('I shows the stats panel', await page.evaluate(() => document.getElementById('debug-stats-panel')?.style.display === 'block'));
check('panel reports FPS and frame times', /FPS \d+(\.\d+)? · frame \d+(\.\d+)? ms/.test(panelText), panelText.split('\n')[1] || '');
check('panel reports renderer counters', /RENDER [\d,]+ calls · [\d,]+ tris/.test(panelText));
check('panel reports scene objects', /SCENE [\d,]+ objects · [\d,]+ meshes/.test(panelText));
check('panel reports chunks + traffic', /WORLD chunks [\d,]+ \/ [\d,]+ · traffic [\d,]+/.test(panelText));
check('panel reports mode/quality/resolution', /MODE garage · quality (low|medium|high) · \d+x\d+/.test(panelText));
const heapLine = panelText.split('\n').find((line) => line.startsWith('HEAP')) || '';
check('panel reports heap (or explains absence)', /HEAP (\d|not exposed)/.test(heapLine), heapLine);

// --- P records and copies a log ---
await page.keyboard.press('KeyP');
await page.waitForTimeout(300);
check('P shows the REC badge', await page.evaluate(() => document.getElementById('debug-stats-rec')?.style.display === 'block'));
await page.waitForTimeout(2100);
await page.keyboard.press('KeyP');
await page.waitForTimeout(600);
check('stopping hides the REC badge', await page.evaluate(() => document.getElementById('debug-stats-rec')?.style.display === 'none'));

const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
const lines = clipboard.split('\n');
const headerIndex = lines.findIndex((line) => line.startsWith('time_s\t'));
const dataRows = headerIndex >= 0 ? lines.slice(headerIndex + 1).filter(Boolean) : [];
const columns = headerIndex >= 0 ? lines[headerIndex].split('\t').length : 0;
check('clipboard contains the stats log header', clipboard.startsWith('# Shutoko Nights stats log'), `${clipboard.length} chars`);
check('log records GPU + quality metadata', /# gpu: /.test(clipboard) && /# quality: /.test(clipboard));
check('log has >= 4 data rows after ~2.4 s', dataRows.length >= 4, `${dataRows.length} rows`);
check('every row matches the column header', columns > 20 && dataRows.every((row) => row.split('\t').length === columns), `${columns} columns`);
check('rows carry numeric fps and draw calls', dataRows.every((row) => {
  const cells = row.split('\t');
  return Number(cells[2]) > 0 && Number(cells[6]) >= 0;
}));

// --- recording works with the panel hidden; I hides the panel ---
await page.keyboard.press('KeyI');
await page.waitForTimeout(200);
check('I hides the stats panel', await page.evaluate(() => document.getElementById('debug-stats-panel')?.style.display === 'none'));
await page.keyboard.press('KeyP');
await page.waitForTimeout(700);
const badgeWhileHidden = await page.evaluate(() => document.getElementById('debug-stats-rec')?.style.display === 'block');
await page.keyboard.press('KeyP');
await page.waitForTimeout(400);
check('REC badge shows even with the panel hidden', badgeWhileHidden);

// --- keys still work while driving ---
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.keyboard.press('KeyI');
await page.waitForTimeout(600);
const drivingText = await page.evaluate(() => document.getElementById('debug-stats-panel')?.textContent || '');
check('overlay reports driving mode on the highway', /MODE driving/.test(drivingText), drivingText.split('\n').find((l) => l.startsWith('MODE')) || '');
await page.keyboard.press('KeyI');

check('no console errors through the whole flow', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('DEBUG STATS REGRESSION');
  process.exit(1);
}
