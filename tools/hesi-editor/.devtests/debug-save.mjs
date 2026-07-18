import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGE-ERR:', String(e)));
await page.goto(`${BASE}/editor?project=${encodeURIComponent('data/editor/.devtest-save.json')}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
await page.getByTestId('place-editor:primitive:box').click();
await page.mouse.click(770, 500);
await page.waitForTimeout(400);
console.log('placed:', await page.evaluate(() => window.hesiEditor.selection.selected?.id));
const result = await page.evaluate(async () => {
  try {
    const doc = window.hesiEditor.persistence.toPersistedDocument();
    return { ok: true, placed: doc.placedObjects.length, doc: JSON.stringify(doc.placedObjects[0]).slice(0, 300) };
  } catch (error) {
    return { ok: false, error: String(error), stack: String(error.stack).slice(0, 500) };
  }
});
console.log('DOC:', JSON.stringify(result, null, 2));
const save = await page.evaluate(async () => {
  try { await window.hesiEditor.persistence.save(); return { ok: true, dirty: window.hesiEditor.history.dirty }; }
  catch (error) { return { ok: false, error: String(error) }; }
});
console.log('SAVE:', JSON.stringify(save));
await browser.close();
