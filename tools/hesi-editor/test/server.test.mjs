import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);
const PORT = 9100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

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

after(() => child?.kill());

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
