// Diff off/on pixels of collision overlay and sample changed colors.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.waitForTimeout(1200);

const grab = () => page.evaluate(() => {
  const vp = window.hesiEditor.viewport;
  vp.renderer.render(vp.scene, vp.camera);
  const gl = vp.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, data: Array.from(px) };
});

await page.evaluate(() => {
  const vp = window.hesiEditor.viewport;
  vp.camera.position.set(196, 34, -958);
  vp.orbit.target.set(176.7, 26.2, -937.5);
  vp.camera.lookAt(vp.orbit.target);
  vp.orbit.update();
});
await page.waitForTimeout(400);

const off = await grab();
await page.evaluate(() => document.querySelector('[data-testid="debug-collision"]').click());
await page.waitForTimeout(400);
const on = await grab();

let changed = 0;
let greenish = 0;
const samples = [];
for (let i = 0; i < off.data.length; i += 4) {
  const dr = on.data[i] - off.data[i];
  const dg = on.data[i + 1] - off.data[i + 1];
  const db = on.data[i + 2] - off.data[i + 2];
  if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 24) {
    changed += 1;
    if (on.data[i + 1] > on.data[i] && on.data[i + 1] >= on.data[i + 2]) greenish += 1;
    if (samples.length < 12) {
      const p = i / 4;
      samples.push({ x: p % off.w, y: Math.floor(p / off.w), rgb: [on.data[i], on.data[i + 1], on.data[i + 2]] });
    }
  }
}
console.log(JSON.stringify({ changed, greenish, samples }));
await browser.close();
