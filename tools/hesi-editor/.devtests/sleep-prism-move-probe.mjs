// Regression probe: the garage's red sleep prism must STAY where the editor
// moves it, instead of being magnet-snapped back onto the placed bed.
// Reproduces the user report ("il prisma rosso torna alla posizione originale
// come una calamita") and asserts the fix (garage.refreshBedMarker guard +
// editor-app syncSleepPrism).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/editor?scene=garage`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'garage', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' }).catch(() => {});
await page.waitForTimeout(1200);

const result = await page.evaluate(() => {
  const app = window.hesiEditor;
  const bedMarkers = app.adapter.garage?.bedMarkers;
  const prism = app.registry.list().find((e) => e.object3D === bedMarkers);
  if (!bedMarkers || !prism) return { error: 'prism-not-found', hasBedMarkers: !!bedMarkers, hasPrism: !!prism };

  const pos = () => ({ x: +bedMarkers.position.x.toFixed(3), y: +bedMarkers.position.y.toFixed(3), z: +bedMarkers.position.z.toFixed(3) });
  const overrideBefore = !!app.projectState.getOverride(prism.id)?.transform;
  const visibleBefore = bedMarkers.visible;

  // 0. Baseline: clear any pre-existing override so the prism snaps onto the
  //    bed, and record that bed-follow position (robust to shipped overrides).
  app.transformManager.setSelection(prism);
  app.projectState.replaceOverride(prism.id, {});
  const bedPos = pos();
  const flagAtBed = !!bedMarkers.userData.editorBuildTransformApplied; // expect false

  // 1. Simulate a user drag: commit a translate away from the bed.
  const rotationDegrees = [bedMarkers.rotation.x, bedMarkers.rotation.y, bedMarkers.rotation.z].map((r) => (r * 180) / Math.PI);
  const scale = [bedMarkers.scale.x, bedMarkers.scale.y, bedMarkers.scale.z];
  const target = { x: +(bedPos.x + 6).toFixed(3), y: bedPos.y, z: +(bedPos.z + 4).toFixed(3) };
  app.transformManager.applyComponents({ position: [target.x, target.y, target.z], rotationDegrees, scale }, 'Probe move sleep prism');

  // syncSleepPrism runs synchronously on the projectState 'override' emit.
  const afterMove = pos();
  const flagAfterMove = !!bedMarkers.userData.editorBuildTransformApplied; // expect true

  // 2. Reset: drop the override → prism re-attaches to the bed (follow again).
  app.projectState.replaceOverride(prism.id, {});
  const afterReset = pos();
  const flagAfterReset = !!bedMarkers.userData.editorBuildTransformApplied; // expect false

  return {
    prismName: prism.name, prismEditable: prism.editable, overrideBefore, visibleBefore,
    bedPos, flagAtBed, target, afterMove, flagAfterMove, afterReset, flagAfterReset,
  };
});

const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
let verdict = 'UNKNOWN';
if (result.error) {
  verdict = `FAIL (${result.error})`;
} else {
  const stayed = near(result.afterMove.x, result.target.x) && near(result.afterMove.z, result.target.z);
  const snappedBack = near(result.afterMove.x, result.bedPos.x) && near(result.afterMove.z, result.bedPos.z);
  const resetFollows = near(result.afterReset.x, result.bedPos.x) && near(result.afterReset.z, result.bedPos.z);
  const flags = result.flagAtBed === false && result.flagAfterMove === true && result.flagAfterReset === false;
  verdict = stayed && !snappedBack && resetFollows && flags
    ? 'PASS (moved & stayed; reset re-attaches to bed; guard flag tracks override)'
    : 'FAIL (prism snapped back to the bed — magnet still present)';
}

console.log(JSON.stringify(result, null, 2));
console.log('VERDICT:', verdict);
console.log('ERRORS:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(verdict.startsWith('PASS') ? 0 : 1);
