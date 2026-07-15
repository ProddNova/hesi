/**
 * REAL-DATA parity: the shared fairing core must reproduce the committed
 * production asset byte-for-byte (modulo the generatedAt timestamp), and
 * building must never write into data/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildSmoothedData, makeParams } from '../lib/fairing.mjs';

const root = new URL('../../../', import.meta.url);
const sha = (u) => crypto.createHash('sha256').update(fs.readFileSync(u)).digest('hex');

test('no-override build reproduces the committed routes-smoothed.json exactly', { timeout: 300000 }, () => {
  const data = JSON.parse(fs.readFileSync(new URL('data/routes.json', root), 'utf8'));
  const committedRaw = fs.readFileSync(new URL('data/routes-smoothed.json', root), 'utf8');
  const committed = JSON.parse(committedRaw);

  const hashesBefore = ['data/routes.json', 'data/routes.js', 'data/routes-smoothed.json', 'data/routes-smoothed.js']
    .map((p) => sha(new URL(p, root)));

  const { out } = buildSmoothedData(data, { params: makeParams() });
  out.meta.fairing = committed.meta.fairing; // timestamp differs by design

  assert.equal(JSON.stringify(out), JSON.stringify(committed),
    'shared fairing core output must be byte-identical to the committed asset');

  const hashesAfter = ['data/routes.json', 'data/routes.js', 'data/routes-smoothed.json', 'data/routes-smoothed.js']
    .map((p) => sha(new URL(p, root)));
  assert.deepEqual(hashesAfter, hashesBefore, 'production files untouched by the build');
});
