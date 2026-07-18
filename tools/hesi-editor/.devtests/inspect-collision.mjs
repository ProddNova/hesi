// Debug: check collision overlay geometry + identify object at screen center.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.waitForTimeout(1200);

const report = await page.evaluate(async () => {
  const ed = window.hesiEditor;
  const THREE = ed.THREE || window.THREE;
  // apply preset
  const s = document.querySelector('.preset-select');
  s.value = 'tatsumi-pa';
  s.dispatchEvent(new CustomEvent('preset-selected', { detail: 'tatsumi-pa' }));
  await new Promise((r) => setTimeout(r, 600));
  // enable collision overlay via checkbox
  document.querySelector('[data-testid="debug-collision"]').click();
  await new Promise((r) => setTimeout(r, 400));

  const scene = ed.viewport?.scene || ed.adapter?.group?.parent;
  const out = { foundScene: Boolean(scene) };
  if (scene) {
    const obj = scene.getObjectByName('Debug collision walls');
    out.overlayExists = Boolean(obj);
    if (obj) {
      out.overlayVisible = obj.visible;
      const pos = obj.geometry.getAttribute('position');
      out.vertexCount = pos.count;
      let nan = 0;
      for (let i = 0; i < pos.count * 3; i += 1) if (!Number.isFinite(pos.array[i])) nan += 1;
      out.nanCount = nan;
      obj.geometry.computeBoundingBox();
      const bb = obj.geometry.boundingBox;
      out.bbox = { min: bb.min.toArray().map((v) => Math.round(v)), max: bb.max.toArray().map((v) => Math.round(v)) };
    }
  }
  // camera state
  const cam = ed.viewport?.camera || ed.adapter?.camera;
  if (cam) out.camera = { pos: cam.position.toArray().map((v) => +v.toFixed(1)) };
  // wallSegments sample
  const ws = ed.adapter?.map?.wallSegments;
  out.wallCount = ws?.length ?? null;
  if (ws?.length) {
    const seg = ws[0];
    out.sample = { start: [seg.start.x, seg.start.y, seg.start.z].map((v) => +(+v).toFixed(1)), height: seg.height };
  }
  // identify cyan ring: raycast center of screen
  try {
    const adapter = ed.adapter;
    const viewport = ed.viewport;
    if (adapter && viewport && THREE) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0, -0.1), viewport.camera);
      const hits = ray.intersectObjects(adapter.group.children, true).slice(0, 4);
      out.centerHits = hits.map((h) => ({
        name: h.object.name || h.object.type,
        parentName: h.object.parent?.name || null,
        dist: +h.distance.toFixed(1),
      }));
    }
  } catch (err) { out.raycastError = String(err); }
  return out;
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
