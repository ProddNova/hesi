import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OverrideStore } from '../lib/store.mjs';
import { tmpdir, rmrf } from './helpers.mjs';

function makeStore(dir) {
  return new OverrideStore({
    file: path.join(dir, 'route-overrides.json'),
    backupDir: path.join(dir, 'backups'),
    knownRouteIds: ['r1', 'r2'],
  });
}

const DOC = { version: 2, meta: { tool: 'road-editor' }, routes: { r1: [{ id: 'a', op: 'pin', anchor: { station: 10, point: [0, 0] }, span: 30 }] } };

test('load of a missing file yields an empty document (ok)', () => {
  const dir = tmpdir();
  try {
    const st = makeStore(dir).load();
    assert.equal(st.ok, true);
    assert.equal(st.exists, false);
    assert.equal(st.doc.version, 2);
  } finally { rmrf(dir); }
});

test('save validates, writes atomically, backs up, restores', () => {
  const dir = tmpdir();
  try {
    const store = makeStore(dir);
    // invalid doc rejected, file untouched
    const bad = store.save({ version: 2, routes: { r1: [{ op: 'nope' }] } });
    assert.equal(bad.ok, false);
    assert.equal(fs.existsSync(store.file), false);

    // first save: file created, no backup yet
    const s1 = store.save(DOC);
    assert.equal(s1.ok, true);
    assert.equal(s1.backupPath, null);
    const onDisk = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.deepEqual(onDisk, DOC);
    // no stray tmp files
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);

    // second save: timestamped backup of the previous content
    const doc2 = JSON.parse(JSON.stringify(DOC));
    doc2.routes.r1[0].span = 60;
    const s2 = store.save(doc2);
    assert.equal(s2.ok, true);
    assert.ok(s2.backupPath && fs.existsSync(s2.backupPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(s2.backupPath, 'utf8')), DOC);

    // list + restore (current file backed up again first)
    const backups = store.listBackups();
    assert.equal(backups.length, 1);
    const r = store.restore(backups[0].name);
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), DOC);
    assert.equal(store.listBackups().length, 2);

    // restore refuses path-like names
    assert.equal(store.restore('../evil.json').ok, false);
  } finally { rmrf(dir); }
});

test('malformed JSON never throws and never modifies the file', () => {
  const dir = tmpdir();
  try {
    const store = makeStore(dir);
    fs.writeFileSync(store.file, '{ broken json !!!');
    const st = store.load();
    assert.equal(st.ok, false);
    assert.match(st.error, /JSON/);
    assert.equal(st.rawText, '{ broken json !!!');
    assert.equal(fs.readFileSync(store.file, 'utf8'), '{ broken json !!!');
    // a subsequent save still backs the broken file up before replacing it
    const s = store.save(DOC);
    assert.equal(s.ok, true);
    assert.ok(fs.existsSync(s.backupPath));
    assert.equal(fs.readFileSync(s.backupPath, 'utf8'), '{ broken json !!!');
  } finally { rmrf(dir); }
});

test('schema-invalid but parseable file reports validation details', () => {
  const dir = tmpdir();
  try {
    const store = makeStore(dir);
    fs.writeFileSync(store.file, JSON.stringify({ version: 2, routes: { r1: [{ op: 'bad' }] } }));
    const st = store.load();
    assert.equal(st.ok, false);
    assert.ok(st.validation);
    assert.equal(st.validation.ok, false);
  } finally { rmrf(dir); }
});
