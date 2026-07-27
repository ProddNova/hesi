/**
 * Barriers app smoke probe.
 *
 * Loads the real editor, opens the Barriers tab, targets ramp_8, edits a span,
 * adds a second one, and checks the resolved-edge summary reflects the paint
 * order. Nothing is saved to disk: the probe never presses Save barriers.
 *
 * Needs the dev server: node tools/hesi-editor/server.mjs
 * Run: node tools/hesi-editor/.devtests/barriers-panel-probe.mjs [--port 8081]
 */
import { chromium } from 'playwright';

const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? process.argv[portArg + 1] : '8081';
const URL = `http://localhost:${PORT}/tools/hesi-editor/index.html`;

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 240000 });
  check('editor loaded the real world', true);

  await page.click('[data-tab="barriers"]');
  await page.waitForSelector('.barriers-panel', { timeout: 10000 });
  check('Barriers panel renders', true);

  await page.fill('[data-testid="barrier-filter"]', 'ramp_8');
  await page.selectOption('[data-testid="barrier-route"]', 'ramp_8');
  await page.waitForSelector('[data-testid="barrier-span-0"]', { timeout: 10000 });
  const firstStyle = await page.$eval('[data-testid="barrier-span-0"] select:nth-of-type(2)', (node) => node.value);
  check('saved ramp_8 span loads as the tall screen', firstStyle === 'shutokoTall', firstStyle);

  // Add a short patch that must repaint the middle of the full-length coat.
  await page.selectOption('[data-testid="barrier-new-side"]', 'left');
  await page.fill('[data-testid="barrier-new-start"]', '300');
  await page.fill('[data-testid="barrier-new-end"]', '340');
  await page.selectOption('[data-testid="barrier-new-style"]', 'soundWall');
  await page.click('[data-action="barrier-span-add"]');
  await page.waitForSelector('[data-testid="barrier-span-1"]', { timeout: 10000 });
  check('patch span added', true);

  const chips = await page.$$eval('.barriers-resolved-side', (nodes) => nodes.map((node) => node.textContent));
  const leftLine = chips.find((line) => line.startsWith('Left')) || '';
  const rightLine = chips.find((line) => line.startsWith('Right')) || '';
  check('left edge splits around the patch', /Sound wall/.test(leftLine) && (leftLine.match(/Tall screen/g) || []).length === 2, leftLine.slice(0, 140));
  check('right edge is untouched by a left-only patch', !/Sound wall/.test(rightLine), rightLine.slice(0, 120));

  const overlay = await page.evaluate(() => {
    let found = null;
    window.hesiEditor.viewport.scene.traverse((object) => { if (object.name === 'Barrier span overlay') found = object; });
    return found ? found.geometry.attributes.position.count : 0;
  });
  check('span overlay is drawn in the viewport', overlay > 0, `${overlay} vertices`);

  // The styled barrier bodies must be paintable in the Surfaces app, not just
  // present in the material palette.
  await page.click('[data-action="open-world-textures"]');
  await page.waitForTimeout(1200);
  const surfaceLabels = await page.evaluate(() => document.body.innerText);
  for (const label of ['Tall screen wall', 'Sound wall', 'Anti-throw screen', 'Jersey barrier', 'Open guardrail beam']) {
    check(`Surfaces lists "${label}"`, surfaceLabels.includes(label));
  }

  const fatal = consoleErrors.filter((text) => !/404|favicon/i.test(text));
  check('no unexpected console errors', fatal.length === 0, fatal.slice(0, 2).join(' | '));
} catch (error) {
  failures += 1;
  console.log(`  FAIL  probe threw — ${error.message}`);
} finally {
  await browser.close();
}

console.log(failures ? `\nFAIL — ${failures} check(s) failed` : '\nPASS — all checks green');
process.exit(failures ? 1 : 0);
