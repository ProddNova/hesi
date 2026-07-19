import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);
const PORT = 9100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const TEST_PROJECT = `data/editor/.test-project-${PORT}.json`;
const ROUTE_FILES = [
  new URL('../../../data/editor/road-route-overrides.json', import.meta.url),
  new URL('../../../data/editor/road-route-overrides.json.bak', import.meta.url),
  new URL('../../../data/routes-smoothed.json', import.meta.url),
  new URL('../../../data/routes-smoothed.json.bak', import.meta.url),
  new URL('../../../data/routes-smoothed.js', import.meta.url),
  new URL('../../../data/routes-smoothed.js.bak', import.meta.url),
];

async function snapshotOptional(file) {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function restoreOptional(file, snapshot) {
  if (snapshot == null) await rm(file, { force: true });
  else await writeFile(file, snapshot);
}

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

const sampleProjectDocument = (name) => ({
  version: 1,
  project: { name },
  entityOverrides: { 'lamp:test:0001': { visible: false } },
  placedObjects: [], groups: [], editorState: {},
});

const sampleBuild = (scene) => ({
  version: 1,
  scene,
  generatedAt: new Date().toISOString(),
  project: { name: 'Build test', path: TEST_PROJECT },
  operations: [
    { op: 'instance', mesh: 'chunk 0,0 lamppost:lampPost', index: 3, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 2, 1] },
    { op: 'place-primitive', primitive: 'box', name: 'Test box', position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true },
  ],
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

test('build endpoint validates operations and writes the scene build file', async () => {
  const put = await fetch(`${BASE}/__hesi_editor_build`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene: 'garage', build: sampleBuild('garage') }),
  });
  assert.equal(put.status, 200);
  const result = await put.json();
  assert.equal(result.path, 'data/editor/garage-build.json');
  assert.equal(result.operations, 2);
  const written = JSON.parse(await readFile(new URL('../../../data/editor/garage-build.json', import.meta.url), 'utf8'));
  assert.equal(written.scene, 'garage');
  assert.equal(written.operations.length, 2);
  const badScene = await fetch(`${BASE}/__hesi_editor_build`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene: 'nope', build: sampleBuild('garage') }),
  });
  assert.equal(badScene.status, 400);
  const badOp = sampleBuild('highway');
  badOp.operations.push({ op: 'evil' });
  const invalid = await fetch(`${BASE}/__hesi_editor_build`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene: 'highway', build: badOp }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /operations\[2\]/);
  await rm(new URL('../../../data/editor/garage-build.json', import.meta.url), { force: true });
  await rm(new URL('../../../data/editor/garage-build.json.bak', import.meta.url), { force: true });
});

test('road route endpoint saves isolated source updates, rejects malformed data, and publishes only named routes', async () => {
  const snapshots = await Promise.all(ROUTE_FILES.map(snapshotOptional));
  try {
    await rm(ROUTE_FILES[0], { force: true });
    await rm(ROUTE_FILES[1], { force: true });
    const productionBeforeText = await readFile(ROUTE_FILES[2], 'utf8');
    const moduleBeforeText = await readFile(ROUTE_FILES[4], 'utf8');
    const productionBefore = JSON.parse(productionBeforeText);
    const target = structuredClone(productionBefore.routes[0]);
    const pointIndex = Math.floor(target.points.length / 2);
    target.points[pointIndex][0] += 0.25;

    const save = await fetch(`${BASE}/__hesi_editor_routes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updates: [{ id: target.id, points: target.points }] }),
    });
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.equal(saved.path, 'data/editor/road-route-overrides.json');
    assert.deepEqual(saved.routes, [target.id]);
    assert.equal(await readFile(ROUTE_FILES[2], 'utf8'), productionBeforeText, 'Save leaves production JSON untouched');
    assert.equal(await readFile(ROUTE_FILES[4], 'utf8'), moduleBeforeText, 'Save leaves the game module untouched');

    const read = await fetch(`${BASE}/__hesi_editor_routes`);
    const readPayload = await read.json();
    assert.equal(readPayload.document.routes[target.id].points[pointIndex][0], target.points[pointIndex][0]);

    const malformed = await fetch(`${BASE}/__hesi_editor_routes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updates: [{ id: target.id, points: [[null, 0, 0], [1, 0, 1]] }] }),
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /finite number/);

    const syntheticPoints = [[10, 30, 20], [15, 31, 25], [20, 30, 30]];
    const syntheticSave = await fetch(`${BASE}/__hesi_editor_routes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updates: [{ id: 'tatsumi_pa_exit', synthetic: true, points: syntheticPoints }] }),
    });
    assert.equal(syntheticSave.status, 200);
    assert.deepEqual((await syntheticSave.json()).routes, [target.id, 'tatsumi_pa_exit'].sort());
    const syntheticRead = await (await fetch(`${BASE}/__hesi_editor_routes`)).json();
    assert.deepEqual(syntheticRead.document.syntheticRoutes.tatsumi_pa_exit.points, syntheticPoints);

    const publish = await fetch(`${BASE}/__hesi_editor_routes`, { method: 'POST' });
    assert.equal(publish.status, 200);
    const published = await publish.json();
    assert.equal(published.modulePath, 'data/routes-smoothed.js');
    const productionAfter = JSON.parse(await readFile(ROUTE_FILES[2], 'utf8'));
    assert.equal(productionAfter.routes[0].points[pointIndex][0], target.points[pointIndex][0]);
    assert.deepEqual(productionAfter.routes[1], productionBefore.routes[1], 'an unrelated route is byte-for-byte equivalent as JSON data');
    assert.deepEqual(productionAfter.meta.editorRoadOverrides.routes, [target.id]);
    assert.deepEqual(productionAfter.meta.editorRoadOverrides.syntheticRoutes.tatsumi_pa_exit.points, syntheticPoints);
    assert.match(await readFile(ROUTE_FILES[4], 'utf8'), new RegExp(`editorRoadOverrides.*${target.id}`));
  } finally {
    await Promise.all(ROUTE_FILES.map((file, index) => restoreOptional(file, snapshots[index])));
  }
});

test('commit endpoints snapshot, list, read, and delete map versions', async () => {
  const create = await fetch(`${BASE}/__hesi_editor_commits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scene: 'garage',
      message: 'Test commit / versione di prova',
      projectPath: TEST_PROJECT,
      document: sampleProjectDocument('Commit test'),
      build: sampleBuild('garage'),
    }),
  });
  assert.equal(create.status, 200);
  const { commit } = await create.json();
  assert.equal(commit.scene, 'garage');
  assert.equal(commit.message, 'Test commit / versione di prova');
  assert.equal(commit.overrideCount, 1);
  try {
    const list = await fetch(`${BASE}/__hesi_editor_commits?scene=garage`);
    assert.equal(list.status, 200);
    const commits = (await list.json()).commits;
    const found = commits.find((entry) => entry.id === commit.id);
    assert.ok(found, 'created commit appears in the list');
    assert.equal(found.hasBuild, true);
    const one = await fetch(`${BASE}/__hesi_editor_commits/one?scene=garage&id=${encodeURIComponent(commit.id)}`);
    assert.equal(one.status, 200);
    const payload = await one.json();
    assert.equal(payload.document.project.name, 'Commit test');
    assert.equal(payload.build.operations.length, 2);
    const missingMessage = await fetch(`${BASE}/__hesi_editor_commits`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: 'garage', message: '', projectPath: TEST_PROJECT, document: sampleProjectDocument('x') }),
    });
    assert.equal(missingMessage.status, 400);
    const traversal = await fetch(`${BASE}/__hesi_editor_commits/one?scene=garage&id=..%2f..%2fsecrets`, { method: 'DELETE' });
    assert.equal(traversal.status, 400);
  } finally {
    const remove = await fetch(`${BASE}/__hesi_editor_commits/one?scene=garage&id=${encodeURIComponent(commit.id)}`, { method: 'DELETE' });
    assert.equal(remove.status, 200);
  }
  const listAfter = await fetch(`${BASE}/__hesi_editor_commits?scene=garage`);
  const remaining = (await listAfter.json()).commits;
  assert.ok(!remaining.some((entry) => entry.id === commit.id), 'deleted commit disappears from the list');
});
