import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/home/user/hesi';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => { try { const f = req.url.split('?')[0]; const file = f === '/' ? '/index.html' : f; const body = await readFile(join(ROOT, file)); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'text/plain' }); res.end(body); } catch { res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await ctx.route('https://cdn.jsdelivr.net/**', async r => r.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/build/three.module.js')) }));
const page = await ctx.newPage();
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(ROOT, '.devtests/shots/08b-portrait-fixed.png') });
// overlap audit portrait
const overlaps = await page.evaluate(() => {
  const rects = [];
  const grab = (sel, label) => document.querySelectorAll(sel).forEach((el) => { const r = el.getBoundingClientRect(); if (r.width > 4 && r.height > 4 && getComputedStyle(el).display !== 'none') rects.push({ label, x: r.x, y: r.y, w: r.width, h: r.height }); });
  grab('.touch-steer button', 'steer'); grab('.touch-pedals button', 'pedal'); grab('.touch-actions button', 'action'); grab('.touch-utility button', 'utility');
  grab('.cluster', 'cluster'); grab('.route-chip', 'route'); grab('.bank', 'bank'); grab('.lives', 'lives'); grab('.score-stack', 'score');
  const bad = [];
  for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
    const a = rects[i]; const b = rects[j];
    if (a.label === b.label) continue;
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 6 && oy > 6) bad.push(`${a.label}~${b.label}`);
  }
  return bad;
});
console.log('portrait overlaps:', overlaps.length ? overlaps.join(', ') : 'none');
await browser.close(); server.close();
