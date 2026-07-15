/**
 * Server integration: boots the real editor server on a random port with a
 * TEMPORARY override file, exercises the API end-to-end and proves the
 * production data/ files are never modified.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir, rmrf } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PORT = 8300 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = tmpdir('road-editor-server-test-');
const OVERRIDES = path.join(DIR, 'route-overrides.json');

const PROD = ['data/routes.json', 'data/routes.js', 'data/routes-smoothed.json', 'data/routes-smoothed.js'];
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
const prodHashes = () => PROD.map(sha).join('|');

let child = null;
let bootHashes = null;

before(async () => {
  bootHashes = prodHashes();
  child = spawn(process.execPath, [
    'tools/road-editor/server.mjs',
    `--port=${PORT}`,
    `--overrides=${OVERRIDES}`,
    `--backups=${path.join(DIR, 'backups')}`,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 20000);
    child.stdout.on('data', (d) => { if (String(d).includes('UI:')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
  });
});

after(() => {
  if (child) child.kill('SIGKILL');
  rmrf(DIR);
});

const post = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

function moveDoc(dz, station = 1700, extra = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/routes.json'), 'utf8'));
  const r = data.routes.find((x) => x.id === 'r11_0');
  // walk to the vertex nearest the station
  let s = 0; let best = 0; let bestD = Infinity;
  for (let i = 1; i < r.points.length; i += 1) {
    s += Math.hypot(r.points[i][0] - r.points[i - 1][0], r.points[i][2] - r.points[i - 1][2]);
    if (Math.abs(s - station) < bestD) { bestD = Math.abs(s - station); best = i; }
  }
  const p = r.points[best];
  return {
    version: 2,
    meta: { tool: 'test' },
    routes: {
      r11_0: [{
        id: 'srv_test', op: 'move',
        anchor: { station, point: [p[0], p[2]], tolerance: 25 },
        to: [p[0], p[2] + dz], influence: 60, weight: 24, ...extra,
      }],
    },
  };
}

test('preview endpoint runs the shared fairing and reports findings', async () => {
  const { status, body } = await post('/api/preview', { routeId: 'r11_0', overrides: moveDoc(2.0) });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.pts) && body.pts.length > 50);
  assert.ok(body.stats && Number.isFinite(body.stats.maxDev));
});

test('save → backup → restore cycle with schema and hard-error gates', async () => {
  // schema violation → 422
  const bad = await post('/api/save', { doc: { version: 2, routes: { r11_0: [{ op: 'warp' }] } } });
  assert.equal(bad.status, 422);
  assert.equal(fs.existsSync(OVERRIDES), false, 'nothing written on schema failure');

  // gross edit → blocking error → 409
  const blocked = await post('/api/save', { doc: moveDoc(40, 1700, { weight: 5000, influence: 150 }) });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.body.blocking.length >= 1);
  assert.equal(fs.existsSync(OVERRIDES), false, 'nothing written on blocking errors');

  // sane edit → saved atomically
  const ok1 = await post('/api/save', { doc: moveDoc(1.5) });
  assert.equal(ok1.status, 200);
  assert.equal(ok1.body.backupPath, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')).routes.r11_0[0].id, 'srv_test');

  // second save → timestamped backup
  const ok2 = await post('/api/save', { doc: moveDoc(2.0) });
  assert.equal(ok2.status, 200);
  assert.ok(ok2.body.backupPath);

  const backups = await (await fetch(`${BASE}/api/backups`)).json();
  assert.equal(backups.backups.length, 1);

  const restored = await post('/api/restore', { name: backups.backups[0].name });
  assert.equal(restored.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
  assert.equal(onDisk.routes.r11_0[0].to[1] - 1.5, moveDoc(0).routes.r11_0[0].anchor.point[1]);
});

test('generate-preview writes only temp files; production stays untouched', { timeout: 300000 }, async () => {
  const { status, body } = await post('/api/generate-preview', { overrides: moveDoc(1.5) });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.productionUntouched, true);
  assert.ok(body.files.every((f) => !f.startsWith(path.join(ROOT, 'data'))), 'outputs are outside data/');
  assert.ok(body.files.every((f) => fs.existsSync(f)), 'temp outputs exist');
  assert.ok(body.changedRoutes.some((c) => c.id === 'r11_0'), 'edited route regenerated differently');
  // the temp output parses and contains all routes
  const out = JSON.parse(fs.readFileSync(body.files[0], 'utf8'));
  assert.equal(out.routes.length, JSON.parse(fs.readFileSync(path.join(ROOT, 'data/routes.json'), 'utf8')).routes.length);
  assert.equal(prodHashes(), bootHashes, 'production data files byte-identical after preview generation');
});

test('apply endpoint is refused without --allow-apply', async () => {
  const { status } = await post('/api/apply', { doc: moveDoc(1.0), confirm: 'APPLICA' });
  assert.equal(status, 403);
  assert.equal(prodHashes(), bootHashes);
});

test('static serving refuses traversal and unknown types', async () => {
  const a = await fetch(`${BASE}/..%2f..%2fdata/routes.json`);
  assert.notEqual(a.status, 200);
  const b = await fetch(`${BASE}/../server.mjs`);
  assert.notEqual(b.status, 200);
});
