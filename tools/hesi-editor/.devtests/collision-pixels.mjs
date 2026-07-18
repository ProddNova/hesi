// Verify collision overlay actually rasterizes: count green-dominant pixels on/off.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.waitForTimeout(1200);

const countGreen = () => page.evaluate(() => {
  const vp = window.hesiEditor.viewport;
  vp.renderer.render(vp.scene, vp.camera);
  const gl = vp.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let green = 0;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] + px[i + 1] + px[i + 2] > 90) lit += 1;
    if (px[i + 1] > 150 && px[i + 1] > px[i] + 40 && px[i + 1] > px[i + 2] + 30) green += 1;
  }
  return { w, h, green, lit, err: gl.getError() };
});

// fixed close-up camera on a known wall segment
await page.evaluate(() => {
  const vp = window.hesiEditor.viewport;
  vp.camera.position.set(196, 34, -958);
  vp.orbit.target.set(176.7, 26.2, -937.5);
  vp.camera.lookAt(vp.orbit.target);
  vp.orbit.update();
});
await page.waitForTimeout(400);

const off = await countGreen();
await page.evaluate(() => document.querySelector('[data-testid="debug-collision"]').click());
await page.waitForTimeout(400);
const on = await countGreen();
console.log(JSON.stringify({ off, on, delta: on.green - off.green, deltaLit: on.lit - off.lit }));
await browser.close();
