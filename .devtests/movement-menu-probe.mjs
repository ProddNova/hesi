/**
 * MOVIMENTI // 8 — the panel, in the real game.
 *
 * .devtests/movement-tuning-probe.mjs covers the record and the physics that
 * reads it, headlessly. What it cannot cover is the half that only exists in a
 * browser: the key opening the panel, the sections and sliders being generated
 * from js/vehicle-movement.js, dragging one reaching the running car, a preset
 * moving every dial, the drive NOT freezing while the panel is open (the whole
 * reason it is docked to the side), and the panel staying out of a player's way
 * when the game is not the editor test build.
 *
 * Run from repo root:  node .devtests/movement-menu-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
// Split routing: the core build and the examples/jsm addons are different files.
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
  const file = addon
    ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
    : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());

// The editor test game: the build the playground and MOVIMENTI belong to.
await page.goto(`http://127.0.0.1:${port}/?editorTest=1`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 90000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 20000 });

// --- the panel is generated, not hand-written -------------------------------
const built = await page.evaluate(() => {
  const menu = document.getElementById('movement-menu');
  return {
    exists: !!menu,
    hidden: menu?.classList.contains('hidden'),
    groups: menu?.querySelectorAll('[data-movement-group]').length || 0,
    sliders: menu?.querySelectorAll('.debug-range input[type=range]').length || 0,
    presets: menu?.querySelectorAll('[data-movement-preset]').length || 0,
  };
});
check('the panel exists and starts closed', built.exists && built.hidden);
check('one section per group, one slider per field',
  built.groups >= 8 && built.sliders === 55 && built.presets >= 4,
  `${built.groups} sections, ${built.sliders} sliders, ${built.presets} presets`);

// --- 8 opens it, and the drive keeps running --------------------------------
await page.keyboard.press('Digit8');
const opened = await page.evaluate(() => ({
  open: window.shutoko.debug.movementOpen,
  hidden: document.getElementById('movement-menu').classList.contains('hidden'),
  frozen: window.shutoko.debug.menuOpen,
}));
check('8 opens MOVIMENTI', opened.open && !opened.hidden);
check('and it does NOT freeze the drive (unlike DEBUG and FILTRO)', !opened.frozen);

// Stepped through the game's own driving update rather than left to
// requestAnimationFrame: a headless page renders a handful of frames a second,
// so wall-clock driving would measure the browser, not the panel.
const moving = await page.evaluate(() => {
  const game = window.shutoko;
  const travel = () => {
    const before = game.physics.position.clone();
    game.keys.KeyW = true;
    for (let i = 0; i < 60; i += 1) game.updateDriving(1 / 60);
    game.keys.KeyW = false;
    return game.physics.position.distanceTo(before);
  };
  const withMovementPanel = travel();
  game.toggleFilterMenu(true);
  const withFilterPanel = travel();
  game.toggleFilterMenu(false);
  return { withMovementPanel, withFilterPanel, stillOpen: game.debug.movementOpen };
});
check('the car still drives with MOVIMENTI open', moving.withMovementPanel > 0.3,
  `${moving.withMovementPanel.toFixed(2)} m in a second`);
check('while FILTRO does freeze it (the contrast this panel exists for)',
  moving.withFilterPanel < 0.01, `${moving.withFilterPanel.toFixed(3)} m`);
check('and opening FILTRO leaves MOVIMENTI open beside it', moving.stillOpen);

// --- a slider reaches the running car --------------------------------------
const dragged = await page.evaluate(() => {
  const game = window.shutoko;
  const input = document.getElementById('movement-rollPerGDeg');
  input.value = '12';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    admin: game.admin.movement.rollPerGDeg,
    physics: game.physics.movement.rollPerGDeg,
    label: document.getElementById('movement-rollPerGDeg-val').textContent,
    summary: document.querySelector('[data-movement-summary]').textContent,
  };
});
check('dragging a slider reaches admin AND the running physics',
  dragged.admin === 12 && dragged.physics === 12, `admin ${dragged.admin}, physics ${dragged.physics}`);
check('the readout and the header follow',
  dragged.label === '12.00°/g' && /1 VALORI MODIFICATI/.test(dragged.summary),
  `${dragged.label} · ${dragged.summary}`);

// The body has to actually lean further. Held lock at speed, twice.
const lean = await page.evaluate(async () => {
  const game = window.shutoko;
  const roll = async (rollPerGDeg) => {
    game.applyMovementPreset('stock');
    game.setMovementParam('rollPerGDeg', rollPerGDeg, false);
    game.setMovementParam('rollLimitDeg', 25, false);
    game.physics.setPosition(game.physics.position.x, game.physics.position.y, game.physics.position.z, game.physics.heading);
    game.physics.setSpeed(100 / 3.6);
    let peak = 0;
    for (let i = 0; i < 180; i += 1) {
      game.physics.update(1 / 60, { throttle: 0.4, steer: 1 }, game.roadAdapter, {});
      peak = Math.max(peak, Math.abs(game.physics.bodyRoll));
    }
    return peak * 180 / Math.PI;
  };
  const soft = await roll(14);
  const flat = await roll(1);
  game.applyMovementPreset('stock');
  return { soft, flat };
});
check('a bigger gradient visibly leans the shell further',
  lean.soft > lean.flat * 3, `${lean.soft.toFixed(2)}° vs ${lean.flat.toFixed(2)}°`);

// --- presets and reset -----------------------------------------------------
const preset = await page.evaluate(() => {
  const game = window.shutoko;
  game.applyMovementPreset('drift');
  const drift = { ...game.admin.movement };
  const label = document.getElementById('movement-rearCornerScale-val').textContent;
  game.applyMovementPreset('stock');
  return { drift, label, stock: { ...game.admin.movement }, physics: { ...game.physics.movement } };
});
check('a preset moves the dials and the sliders',
  preset.drift.rearCornerScale === 0.8 && preset.label === '0.80×', `${preset.label}`);
check('RESET / stock puts the shipped record back everywhere',
  preset.stock.rearCornerScale === 1 && preset.stock.rollPerGDeg === 3.5 && preset.physics.rollPerGDeg === 3.5);

// --- 8 closes it -----------------------------------------------------------
await page.keyboard.press('Digit8');
check('8 closes it again', await page.evaluate(() => !window.shutoko.debug.movementOpen));

// --- and the playground panel can open it without a keyboard --------------
const fromPlayground = await page.evaluate(() => {
  const game = window.shutoko;
  game.enterPlayground();
  game.playgroundPanel.toggle(true);
  const button = document.querySelector('.playground-movement-open');
  button?.click();
  const open = game.debug.movementOpen;
  game.setMovementMenuOpen(false);
  game.exitPlayground();
  return { hasButton: !!button, open };
});
check('the playground panel offers a way in without a keyboard',
  fromPlayground.hasButton && fromPlayground.open);

// --- the record survives a reload -----------------------------------------
await page.evaluate(() => {
  window.shutoko.setMovementParam('gripScale', 1.25, true);
});
await page.waitForTimeout(200);
await page.reload();
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 90000 });
await page.waitForFunction(() => window.shutoko.physics, null, { timeout: 20000 });
const reloaded = await page.evaluate(() => ({
  admin: window.shutoko.admin.movement.gripScale,
  physics: window.shutoko.physics.movement.gripScale,
}));
check('a tuned value survives a reload and reaches the new physics instance',
  reloaded.admin === 1.25 && reloaded.physics === 1.25, `admin ${reloaded.admin}, physics ${reloaded.physics}`);

// --- not offered outside the vehicle laboratory ---------------------------
const player = await context.newPage();
const playerErrors = [];
player.on('pageerror', (error) => playerErrors.push(String(error)));
player.on('dialog', (dialog) => dialog.accept());
await player.goto(`http://127.0.0.1:${port}/`);
await player.waitForFunction(() => window.shutoko?.map, null, { timeout: 90000 });
await player.click('#new-game-button');
await player.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await player.keyboard.press('Digit8');
const gated = await player.evaluate(() => ({
  open: window.shutoko.debug.movementOpen,
  hidden: document.getElementById('movement-menu').classList.contains('hidden'),
  row: document.getElementById('debug-movement-row').hidden,
  tunable: window.shutoko.canTuneMovement(),
}));
check('a normal game does not open MOVIMENTI on 8', !gated.open && gated.hidden && !gated.tunable);
check('and does not advertise it in the debug menu', gated.row);

check('no page errors', errors.length === 0 && playerErrors.length === 0,
  [...errors, ...playerErrors].slice(0, 2).join(' | '));

await browser.close();
server.close();
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
