/**
 * Tatsumi PA editor-scene probe.
 *
 * Checks that the third scene is real: the selector offers it, ?scene=tatsumi_pa
 * loads the production PA generator, its children come through as editable
 * child-indexed entities, and a transform on one of them resolves into a build
 * op the game can replay. Nothing is written to disk.
 *
 * Needs the dev server: node tools/hesi-editor/server.mjs
 * Run: node tools/hesi-editor/.devtests/tatsumi-pa-scene-probe.mjs [--port 8081]
 */
import { chromium } from 'playwright';

const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? process.argv[portArg + 1] : '8081';
const BASE = `http://localhost:${PORT}/tools/hesi-editor/index.html`;

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  await page.goto(`${BASE}?scene=tatsumi_pa`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'tatsumi_pa', null, { timeout: 240000 });
  check('?scene=tatsumi_pa loads the PA adapter', true);

  const scenes = await page.$$eval('.scene-switch .seg-button', (nodes) => nodes.map((node) => ({
    label: node.textContent, id: node.dataset.testid, checked: node.getAttribute('aria-checked'),
  })));
  check('the scene selector offers all three scenes', scenes.length === 3, scenes.map((s) => s.label).join(' | '));
  check('Tatsumi PA is the selected one', scenes.find((s) => s.id === 'scene-tatsumi_pa')?.checked === 'true');

  const world = await page.evaluate(() => {
    const adapter = window.hesiEditor.adapter;
    const entities = adapter.entities;
    return {
      count: entities.length,
      labels: entities.map((entity) => entity.name),
      childIndices: entities.map((entity) => entity.metadata.childIndex),
      walls: entities.filter((entity) => entity.type === 'pa-wall').length,
      lamps: entities.filter((entity) => entity.type === 'pa-lamp').length,
      hasCar: entities.some((entity) => entity.type === 'pa-parked-car'),
      hasExitPrism: entities.some((entity) => entity.name.startsWith('Exit prism')),
      size: [adapter.metadata.worldSize.x, adapter.metadata.worldSize.z],
    };
  });
  check('every PA child is an editable entity', world.count >= 12, `${world.count} entities`);
  check('child indices are dense and ordered', world.childIndices.every((value, index) => value === index));
  check('the perimeter wall comes through as four runs', world.walls === 4);
  check('the four lamp masts come through', world.lamps === 4);
  check('the parked car anchor and the exit prism are editable', world.hasCar && world.hasExitPrism);
  check('the lot measures the authored footprint', Math.round(world.size[0]) === 46 && Math.round(world.size[1]) === 30,
    world.size.map((v) => v.toFixed(1)).join(' x '));

  // A transform on a PA child must resolve into the child-index build op.
  const build = await page.evaluate(() => {
    const editor = window.hesiEditor;
    const entity = editor.adapter.entities.find((candidate) => candidate.type === 'pa-lamp');
    editor.projectState.replaceOverride(entity.id, {
      transform: { position: [4, 0, 5], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    const document = editor.persistence.buildDocument();
    editor.projectState.replaceOverride(entity.id, null);
    return {
      scene: document.scene,
      ops: document.operations.map((op) => ({ op: op.op, childIndex: op.childIndex, position: op.position })),
    };
  }).catch((error) => ({ error: String(error) }));
  if (build.error) {
    check('a moved PA part resolves into a child-index build op', false, build.error);
  } else {
    check('the build document is stamped for the PA scene', build.scene === 'tatsumi_pa', build.scene);
    const op = build.ops.find((candidate) => candidate.op === 'garage-object');
    check('a moved PA part resolves into a child-index build op',
      !!op && Number.isInteger(op.childIndex), JSON.stringify(op));
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await page.evaluate(() => window.hesiEditor.applyPreset('map-center'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: new URL('../../../.devtests/shots/PAZONE-editor.png', import.meta.url).pathname.replace(/^\//, '') });
} finally {
  await browser.close();
}
console.log(failures ? `\nTATSUMI PA SCENE PROBE: FAIL(${failures})` : '\nTATSUMI PA SCENE PROBE: PASS');
process.exit(failures ? 1 : 0);
