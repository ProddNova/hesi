// Modeler "Body paint" panel probe. Opens the Modeler, switches to the Cars
// library, picks the player car, and checks the paint controls exist, write
// through to the document, and repaint the live preview in place.
// Usage: node .devtests/car-paint-panel-probe.mjs   (editor server on :8081)
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

await page.goto(BASE);
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.evaluate(() => {
  const open = document.querySelector('[data-action="open-modeler"]')
    || [...document.querySelectorAll('button')].find((b) => /Modeler/i.test(b.title || b.textContent));
  open.click();
});
await page.waitForTimeout(1200);

// Switch to the Cars library and select the first player car.
const opened = await page.evaluate(async () => {
  const tab = document.querySelector('[data-testid="modeler-library-cars"]');
  if (!tab) return 'NO-CARS-TAB';
  tab.click();
  await new Promise((done) => setTimeout(done, 800));
  const row = document.querySelector('[data-testid^="modeler-car-player-"]');
  if (!row) return 'NO-PLAYER-CAR-ROW';
  row.click();
  await new Promise((done) => setTimeout(done, 3000));
  return 'ok';
});
check('Cars library opens', opened === 'ok', opened);

const controls = await page.evaluate(() => ({
  color: !!document.querySelector('[data-car-paint="color"]'),
  metallic: !!document.querySelector('[data-car-paint="metallic"]'),
  gloss: !!document.querySelector('[data-car-paint="gloss"]'),
  target: window.hesiEditor?.modeler?.carTarget || null,
}));
check('Body paint controls render', controls.color && controls.metallic && controls.gloss,
  `target ${controls.target}`);

const applied = await page.evaluate(async () => {
  const modeler = window.hesiEditor.modeler;
  const color = document.querySelector('[data-car-paint="color"]');
  const metallic = document.querySelector('[data-car-paint="metallic"]');
  color.value = '#1b3fa8';
  color.dispatchEvent(new Event('input', { bubbles: true }));
  metallic.value = '0.8';
  metallic.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((done) => setTimeout(done, 400));
  const body = [];
  modeler.carPreviewVisual?.traverse((child) => {
    for (const material of (Array.isArray(child.material) ? child.material : [child.material])) {
      if (material && /(^|:)psxbody$/i.test(material.name || '')) {
        body.push({ type: material.type, color: `#${material.color.getHexString()}` });
      }
    }
  });
  return {
    saved: modeler.store.carModel(modeler.carTarget)?.paint || null,
    body,
    // The slider must survive its own input handler: a panel re-render would
    // replace the node under the pointer mid-drag.
    sliderStillMounted: document.querySelector('[data-car-paint="metallic"]') === metallic,
  };
});
check('paint writes through to the document',
  applied.saved?.color === '#1b3fa8' && applied.saved?.metallic === 0.8, JSON.stringify(applied.saved));
check('preview repaints every body slot in place',
  applied.body.length > 0 && applied.body.every((entry) => entry.type === 'MeshPhongMaterial')
    && new Set(applied.body.map((entry) => entry.color)).size === 1, JSON.stringify(applied.body));
check('sliders are not torn out mid-drag', applied.sliderStillMounted === true);

// A body image is the control the per-face texture rows could never provide:
// one picture across the whole bodywork, however many parts it is cut into.
const wrapped = await page.evaluate(async () => {
  const modeler = window.hesiEditor.modeler;
  const store = modeler.store;
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let textureId = null;
  try { textureId = store.addTextureFromDataUrl('probe wrap', image); }
  catch (error) { return { error: `could not add a texture: ${error.message}` }; }
  store.setCarModel(modeler.carTarget, { paint: { texture: textureId } });
  modeler._renderCarInspector();
  modeler._repaintCarPreview();
  await new Promise((done) => setTimeout(done, 400));

  const body = [];
  let wrapUVs = 0;
  modeler.carPreviewVisual?.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of (Array.isArray(child.material) ? child.material : [child.material])) {
      if (material && /(^|:)psxbody$/i.test(material.name || '')) {
        body.push(!!material.map);
        if (child.geometry?.getAttribute?.('uv1')) wrapUVs += 1;
      }
    }
  });
  const controls = {
    button: !!document.querySelector('[data-car-paint-image]') || !!document.querySelector('[data-testid="car-paint-image"]'),
    scale: !!document.querySelector('[data-car-paint="wrapScale"]'),
  };

  store.setCarModel(modeler.carTarget, { paint: { texture: null } });
  modeler._renderCarInspector();
  modeler._repaintCarPreview();
  await new Promise((done) => setTimeout(done, 300));
  let stillMapped = 0;
  modeler.carPreviewVisual?.traverse((child) => {
    for (const material of (Array.isArray(child.material) ? child.material : [child.material])) {
      if (material?.map && /(^|:)psxbody$/i.test(material.name || '')) stillMapped += 1;
    }
  });
  return { body, wrapUVs, controls, stillMapped, saved: store.carModel(modeler.carTarget)?.paint || null };
});
check('a body image reaches every body slot of the preview',
  !wrapped.error && wrapped.body.length > 0 && wrapped.body.every(Boolean),
  wrapped.error || `${wrapped.body.filter(Boolean).length}/${wrapped.body.length} slot(s) · ${wrapped.wrapUVs} projected mesh(es)`);
check('the image controls appear once there is an image',
  !!wrapped.controls?.button && !!wrapped.controls?.scale, JSON.stringify(wrapped.controls));
check('removing the image goes back to plain paint',
  wrapped.stillMapped === 0 && !wrapped.saved?.texture,
  `${wrapped.stillMapped} mapped slot(s) · ${JSON.stringify(wrapped.saved)}`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((entry) => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
