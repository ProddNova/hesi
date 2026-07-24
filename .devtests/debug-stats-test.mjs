/**
 * Debug stats overlay regression: I toggles the on-screen stats panel,
 * P starts/stops a structured diagnostic recording. Stopping downloads the
 * complete JSON report and copies an AI-readable summary to the clipboard.
 *
 * Run from repo root:  node .devtests/debug-stats-test.mjs
 */
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);
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
  const url = new URL(route.request().url());
  const marker = '/npm/three@0.166.1/';
  const relative = url.pathname.includes(marker)
    ? url.pathname.split(marker)[1]
    : 'build/three.module.js';
  const body = await readFile(join(ROOT, 'node_modules/three', relative));
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
check('panel reports FPS and frame percentiles', /FPS \d+(\.\d+)? .* frame \d+(\.\d+)? ms .*p99/.test(panelText), panelText.split('\n')[1] || '');
check('panel reports renderer counters', /RENDER [\d,]+ calls .* [\d,]+ tris/.test(panelText));
check('panel reports scene objects', /SCENE [\d,]+ objects .* [\d,]+ meshes/.test(panelText));
check('panel reports chunks + visible traffic', /WORLD chunks [\d,]+ \/ [\d,]+ .* traffic [\d,]+ \([\d,]+ visible\)/.test(panelText));
check('panel reports mode/quality/resolution', /MODE garage .* quality (low|medium|high) .* \d+x\d+/.test(panelText));
const heapLine = panelText.split('\n').find((line) => line.startsWith('HEAP')) || '';
check('panel reports heap (or explains absence)', /HEAP (\d|not exposed)/.test(heapLine), heapLine);

// --- P records, downloads JSON, and copies a compact summary ---
await page.keyboard.press('KeyP');
await page.waitForTimeout(300);
check('P shows the REC badge', await page.evaluate(() => document.getElementById('debug-stats-rec')?.style.display === 'block'));
await page.keyboard.press('KeyO');
await page.evaluate(() => window.shutoko.debugStats.event('regression_marker', { value: 42 }));
await page.evaluate(() => console.warn('diagnostic console probe', { value: 7 }));
await page.evaluate(() => fetch('/manifest.webmanifest?diagnostic-probe=1').then((response) => response.text()));
// Produce one deterministic Long Task / spike so those channels are exercised.
await page.evaluate(() => {
  const started = performance.now();
  while (performance.now() - started < 70) { /* intentional diagnostic probe */ }
});
await page.waitForTimeout(2100);
const downloadPromise = page.waitForEvent('download');
await page.keyboard.press('KeyP');
const download = await downloadPromise;
await page.waitForTimeout(600);
check('stopping hides the REC badge', await page.evaluate(() => document.getElementById('debug-stats-rec')?.style.display === 'none'));

const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
const downloadedPath = await download.path();
const report = JSON.parse(await readFile(downloadedPath, 'utf8'));
check('clipboard contains the AI-readable summary', clipboard.startsWith('# Shutoko Nights diagnostic recording'), `${clipboard.length} chars`);
check('summary points to the downloaded JSON', clipboard.includes(download.suggestedFilename()) && clipboard.includes('attach this JSON'));
check('download uses the diagnostic filename', /^hesi-diagnostic-.*\.json$/.test(download.suggestedFilename()), download.suggestedFilename());
check('JSON declares the versioned diagnostic schema', report.schema === 'hesi.diagnostic-recording' && report.schema_version === 3);
check('report records browser/GPU/display metadata', !!report.environment?.user_agent && !!report.environment?.webgl?.gpu && !!report.environment?.display?.canvas_internal);
check('report records game/vehicle/world configuration', !!report.game?.game?.name && report.game?.vehicle && report.game?.world);
check('timeline has >= 8 samples after ~2.4 s', report.timeline.length >= 8, `${report.timeline.length} samples`);
check('every timeline tuple matches its schema', report.timeline_columns.length > 70 && report.timeline.every((row) => row.length === report.timeline_columns.length), `${report.timeline_columns.length} columns`);
check('spike tuples match their schema', report.spikes.length >= 1 && report.spikes.every((row) => row.length === report.spike_columns.length), `${report.spikes.length} spikes`);
check('manual and explicit events are retained', report.events.some((event) => event.type === 'manual_marker') && report.events.some((event) => event.type === 'regression_marker' && event.data.value === 42));
check('console output during recording is retained', report.events.some((event) => event.type === 'console_warn' && JSON.stringify(event.data).includes('diagnostic console probe')));
check('resources loaded during recording are retained', report.resources_loaded_during_recording.some((resource) => resource.name.includes('diagnostic-probe=1') && resource.duration_ms >= 0));
check('summary contains frame distribution and CPU breakdown', report.summary?.frame_pacing?.frame_ms?.p99 >= 0 && report.summary?.frame_pacing?.cpu_ms?.subsystems_average?.render >= 0);
check('summary identifies worst windows and automatic findings', report.summary?.worst_windows?.length >= 1 && report.summary?.findings?.length >= 1);
check('report captured Long Task diagnostics', report.long_tasks.length >= 1 && report.summary.browser_long_tasks.max_ms >= 50, `${report.long_tasks.length} long tasks`);
check('rows carry numeric FPS, draw calls, and gameplay position', report.timeline.every((row) => {
  const index = Object.fromEntries(report.timeline_columns.map((name, i) => [name, i]));
  return Number(row[index.fps]) > 0 && Number(row[index.draw_calls]) >= 0
    && Number.isFinite(Number(row[index.pos_x])) && Number.isFinite(Number(row[index.pos_z]));
}));
const analysis = await execFileAsync(process.execPath, [join(ROOT, 'tools/analyze-diagnostic.mjs'), downloadedPath]);
check('CLI analyzer renders the report as useful Markdown', analysis.stdout.includes('# HESI diagnostic analysis') && analysis.stdout.includes('## CPU attribution') && analysis.stdout.includes('## Worst sampled windows'));

// --- recording works with the panel hidden; I hides the panel ---
await page.keyboard.press('KeyI');
await page.waitForTimeout(200);
check('I hides the stats panel', await page.evaluate(() => document.getElementById('debug-stats-panel')?.style.display === 'none'));
await page.keyboard.press('Digit0');
check('debug menu exposes recorder controls for touch use', await page.evaluate(() => {
  const menu = document.getElementById('debug-menu');
  return !menu?.classList.contains('hidden') && !!document.getElementById('debug-rec-toggle') && !!document.getElementById('debug-rec-mark');
}));
await page.click('#debug-rec-toggle');
await page.waitForTimeout(700);
const badgeWhileHidden = await page.evaluate(() => document.getElementById('debug-stats-rec')?.style.display === 'block');
await page.click('#debug-rec-mark');
const secondDownloadPromise = page.waitForEvent('download');
await page.click('#debug-rec-toggle');
await secondDownloadPromise;
await page.waitForTimeout(400);
await page.click('#debug-close');
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
