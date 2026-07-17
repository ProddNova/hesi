import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);
const PORT = 9100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const TEST_PROJECT = `data/editor/.test-project-${PORT}.json`;

before(async () => {
  child = spawn(process.execPath, ['tools/hesi-editor/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HESI_EDITOR_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Editor server did not start')), 10000);
    child.stdout.on('data', (data) => {
      if (String(data).includes('[hesi-editor] editor')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('exit', (code) => reject(new Error(`Editor server exited early (${code})`)));
  });
});

after(async () => {
  child?.kill();
  await rm(new URL(`../../../${TEST_PROJECT}`, import.meta.url), { force: true });
  await rm(new URL(`../../../${TEST_PROJECT}.bak`, import.meta.url), { force: true });
});

test('server starts and editor page resolves', async () => {
  const health = await fetch(`${BASE}/__hesi_editor_health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(`${BASE}/tools/hesi-editor/index.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /src\/main\.js/);
});

test('server redirects editor aliases and blocks traversal', async () => {
  const alias = await fetch(`${BASE}/editor`, { redirect: 'manual' });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get('location'), '/tools/hesi-editor/index.html');
  const demoAlias = await fetch(`${BASE}/editor?world=demo`, { redirect: 'manual' });
  assert.equal(demoAlias.headers.get('location'), '/tools/hesi-editor/index.html?world=demo');
  const traversal = await fetch(`${BASE}/..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 403);
});

test('production page does not import editor code', async () => {
  const source = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /tools\/hesi-editor|hesiEditor/);
});

test('project endpoint validates, saves, backs up, and reloads deterministic JSON', async () => {
  const document = {
    version: 1,
    project: { name: 'Endpoint test' },
    entityOverrides: { 'lamp:test:0001': { visible: false } },
    placedObjects: [], groups: [], editorState: {},
  };
  const save = await fetch(`${BASE}/__hesi_editor_project`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: TEST_PROJECT, document }),
  });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).backup, null);
  const load = await fetch(`${BASE}/__hesi_editor_project?path=${encodeURIComponent(TEST_PROJECT)}`);
  const loaded = await load.json();
  assert.equal(loaded.document.project.name, 'Endpoint test');
  assert.ok(Number.isFinite(loaded.modifiedMs));
  document.project.name = 'Endpoint test second save';
  const overwrite = await fetch(`${BASE}/__hesi_editor_project`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: TEST_PROJECT, document }),
  });
  assert.equal((await overwrite.json()).backup, `${TEST_PROJECT}.bak`);
  const backup = JSON.parse(await readFile(new URL(`../../../${TEST_PROJECT}.bak`, import.meta.url), 'utf8'));
  assert.equal(backup.project.name, 'Endpoint test');
  const invalid = await fetch(`${BASE}/__hesi_editor_project`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '../outside.json', document }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /data\/editor/);
});
