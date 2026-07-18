// Quick single-view screenshot for iteration. Usage: node .devtests/shot.mjs <name> [evalJs]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const name = process.argv[2] || 'shot';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.waitForTimeout(1200);
if (process.argv[3]) {
  await page.evaluate(process.argv[3]);
  await page.waitForTimeout(900);
}
await page.screenshot({ path: path.join(OUT, `${name}.png`) });
console.log('ERRORS:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
