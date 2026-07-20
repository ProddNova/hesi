// UI overflow audit across viewports and UI states. Usage: node .devtests/ui-audit.mjs [--shots]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = fileURLToPath(new URL('./shots/audit/', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8081';
const SHOTS = process.argv.includes('--shots');
await mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  [1920, 1080],
  [1600, 950],
  [1366, 768],
  [1280, 720],
  [1100, 650],
  [900, 600],
];

const AUDIT_JS = `(() => {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const issues = [];
  const label = (el) => (el.tagName.toLowerCase() + '.' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ').filter(Boolean).slice(0,2).join('.')) + ' "' + (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24) + '"';
  const inScrollable = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX + ' ' + s.overflowY + ' ' + s.overflow)) {
        const pr = p.getBoundingClientRect();
        if (pr.right <= vw + 1 && pr.bottom <= vh + 1 && pr.left >= -1 && pr.top >= -1) return true;
      }
    }
    return false;
  };
  if (document.documentElement.scrollWidth > vw + 1) issues.push('PAGE-HSCROLL width=' + document.documentElement.scrollWidth);
  if (document.documentElement.scrollHeight > vh + 1) issues.push('PAGE-VSCROLL height=' + document.documentElement.scrollHeight);
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return;
    if (el.tagName === 'CANVAS') return;
    if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
      if (!inScrollable(el)) issues.push('OFFSCREEN ' + label(el) + ' rect=' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
      return;
    }
    // clipped by an overflow-hidden ancestor
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (/(hidden|clip)/.test(ps.overflowX + ' ' + ps.overflowY + ' ' + ps.overflow)) {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 2 || r.bottom > pr.bottom + 2 || r.left < pr.left - 2) {
          if ((el.tagName === 'BUTTON' || el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'LABEL' || el.tagName === 'SPAN') && !inScrollable(el)) {
            issues.push('CLIPPED ' + label(el) + ' by ' + p.tagName.toLowerCase() + '.' + String(p.className).split(' ')[0] + ' overX=' + Math.round(r.right - pr.right) + ' overY=' + Math.round(r.bottom - pr.bottom));
          }
        }
        break;
      }
    }
  });
  // controls that stick out of a card/box container horizontally: siblings
  // paint over the overhang, so the control looks cut in half
  document.querySelectorAll('button, select, input, .asset-kind, .chip, .badge').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    if (getComputedStyle(el).visibility === 'hidden') return;
    for (let p = el.parentElement, depth = 0; p && p !== document.body && depth < 4; p = p.parentElement, depth++) {
      const ps = getComputedStyle(p);
      const boxed = (ps.borderLeftWidth !== '0px' || ps.borderRightWidth !== '0px' || (ps.backgroundColor !== 'rgba(0, 0, 0, 0)' && ps.backgroundColor !== 'transparent'));
      if (!boxed) continue;
      const pr = p.getBoundingClientRect();
      if (r.right > pr.right + 2 || r.left < pr.left - 2) {
        issues.push('OVERHANG ' + label(el) + ' out of ' + p.tagName.toLowerCase() + '.' + String(p.className).split(' ')[0] + ' overX=' + Math.round(r.right - pr.right));
      }
      break;
    }
  });
  // text ellipsis on buttons (truncated labels)
  // .entity-row ellipsizes long entity IDs by design.
  document.querySelectorAll('button:not(.entity-row), .chip, .badge').forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && getComputedStyle(el).visibility !== 'hidden') issues.push('TRUNCATED ' + label(el) + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth);
    }
  });
  return { vw, vh, issues: [...new Set(issues)] };
})()`;

const tabSetup = (label) => `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}'); if (!b) return 'NO-TAB'; b.click(); return 'ok'; })()`;
const STATES = [
  { name: 'assets', setup: null },
  { name: 'edit-tab', setup: tabSetup('Edit') },
  { name: 'project-tab', setup: tabSetup('Project') },
  { name: 'help-tab', setup: tabSetup('Help') },
  { name: 'world-tab', setup: tabSetup('World') },
  { name: 'view-menu', setup: `(() => { const b = document.querySelector('[data-action="view-menu"]'); if (!b) return 'NO-VIEW-BUTTON'; b.click(); const m = document.querySelector('.view-menu'); return m && !m.hidden ? 'ok' : 'MENU-NOT-OPEN'; })()` },
  { name: 'road-selected', setup: `(() => { const ed = window.hesiEditor; const road = ed?.registry?.list()?.find(e => e.type === 'road' || /road|route/.test(String(e.id))); if (!road) return 'NO-ROAD'; ed.selection.select(road.id); return 'ok'; })()`, verify: `Boolean(document.querySelector('.road-panel, [class*=road-panel]'))` },
  { name: 'modeler', setup: `(() => { const b = document.querySelector('[data-action="open-modeler"]') || [...document.querySelectorAll('button')].find(b => /Modeler/i.test(b.title || b.textContent)); if (!b) return 'NO-MODELER-BUTTON'; b.click(); return 'ok'; })()`, settle: 900 },
];

const browser = await chromium.launch();
let totalIssues = 0;
for (const [w, h] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hesiEditor?.adapter?.strategy === 'real', null, { timeout: 90000 });
  await page.waitForSelector('[data-testid="loading-overlay"]', { state: 'hidden' });
  await page.waitForTimeout(600);
  for (const state of STATES) {
    if (state.setup) {
      let marker;
      try { marker = await page.evaluate(state.setup); } catch (e) { console.log(`  [${w}x${h}] ${state.name}: setup failed: ${e.message.split('\n')[0]}`); continue; }
      if (marker !== 'ok') { console.log(`[${w}x${h}] ${state.name}: NOT ENGAGED (${marker})`); continue; }
      await page.waitForTimeout(state.settle || 350);
      if (state.verify) {
        const ok = await page.evaluate(state.verify);
        if (!ok) console.log(`[${w}x${h}] ${state.name}: VERIFY FAILED`);
      }
    }
    const report = await page.evaluate(AUDIT_JS);
    if (report.issues.length) {
      totalIssues += report.issues.length;
      console.log(`[${w}x${h}] ${state.name}: ${report.issues.length} issues`);
      report.issues.slice(0, 25).forEach((i) => console.log('   - ' + i));
    } else {
      console.log(`[${w}x${h}] ${state.name}: clean`);
    }
    if (SHOTS) await page.screenshot({ path: path.join(OUT, `${w}x${h}-${state.name}.png`) });
    if (state.setup) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
  }
  if (errors.length) console.log(`[${w}x${h}] PAGE ERRORS: ${errors.join(' | ')}`);
  await page.close();
}
await browser.close();
console.log(totalIssues ? `TOTAL ISSUES: ${totalIssues}` : 'ALL CLEAN');
