#!/usr/bin/env node
/**
 * Stamps one build id onto every URL the browser could hold a stale copy of.
 *
 * The project already cache-busted by hand, with a per-file date written into
 * each import: `./map.js?v=20260728a`, `./garage.js?v=20260723b`. That is a
 * list nobody can keep correct — on 28 Jul 2026 a texture fix shipped in
 * `custom-assets.js`, which carried **no `?v=` at all**, and `garage.js` kept a
 * five-day-old stamp although it had changed. Same URLs as the previous build,
 * so browsers reused what they already had and the deploy was invisible: a
 * clean browser saw the fix, the player's did not.
 *
 * A URL that has never been requested cannot be stale in any cache layer —
 * HTTP, service worker, or module map. So every local asset URL gets the same
 * id, which changes exactly when the deploy does:
 *
 *   sw.js      const CACHE = 'shutoko-nights-<id>'
 *   index.html every local href=/src= .css/.js
 *   js/*.js    every relative module specifier
 *
 * The id is the commit being deployed (RENDER_GIT_COMMIT on Render, otherwise
 * git). A UTC timestamp is the last resort, so a build outside git still
 * produces a unique id rather than silently reusing the previous one.
 *
 * Idempotent: stamping the same commit twice is a no-op.
 *
 * NOTE this rewrites source files in place. It is meant to run in the deploy
 * (render.yaml `buildCommand`), but it is also safe to run before committing —
 * and must be, for as long as the Render service is not Blueprint-managed and
 * therefore ignores render.yaml.
 *
 * Run: node scripts/stamp-build.mjs [--check]
 *   --check reports what would change without writing.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');

function buildId() {
  const fromRender = process.env.RENDER_GIT_COMMIT;
  if (fromRender && /^[0-9a-f]{7,40}$/i.test(fromRender)) return fromRender.slice(0, 12);
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 12);
  } catch { /* not a checkout, or git is unavailable in the build image */ }
  return `t${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
}

// `from './x.js'`, `from'./x.js?v=old'`, `export * from '../data/y.js'` and
// `import('./z.js')`. Only relative specifiers: bare ones ('three') go through
// the import map to a CDN and must not be touched.
const MODULE_SPECIFIER = /((?:\bfrom|\bimport)\s*\(?\s*)(['"])((?:\.\.?\/)[^'"]*?\.js)(?:\?v=[^'"]*)?\2/g;
// href=/src= on a local .css/.js. Absolute and protocol-relative URLs are left
// alone — the three.js import map points at a CDN.
const ASSET_URL = /\b(href|src)=(["'])(?!https?:|\/\/)([^"']*?\.(?:css|js))(?:\?v=[^"']*)?\2/g;

// Shown on the boot screen, so "the deploy did not apply" can be answered by
// looking rather than by guessing which cache is holding what.
const BUILD_LABEL = /(<b id="build-id">)[^<]*(<\/b>)/;

const stampModules = (text, id) => text.replace(MODULE_SPECIFIER, (_m, lead, quote, path) => `${lead}${quote}${path}?v=${id}${quote}`);
const stampAssets = (text, id) => text.replace(ASSET_URL, (_m, attribute, quote, path) => `${attribute}=${quote}${path}?v=${id}${quote}`);

const id = buildId();

// The cache name is the one target that must match, because it is the whole
// service-worker invalidation mechanism: a silent miss would put the manual
// bumping back without anyone noticing, so it fails the build.
const CACHE_PATTERN = /const CACHE = 'shutoko-nights-[^']+';/;

const targets = [
  { file: 'sw.js', transform: (text) => text.replace(CACHE_PATTERN, `const CACHE = 'shutoko-nights-${id}';`), required: CACHE_PATTERN },
  {
    file: 'index.html',
    transform: (text) => stampAssets(text, id).replace(BUILD_LABEL, `$1${id.slice(0, 7)}$2`),
    required: BUILD_LABEL,
  },
];
for (const entry of await readdir(join(ROOT, 'js'))) {
  if (entry.endsWith('.js')) targets.push({ file: `js/${entry}`, transform: (text) => stampModules(text, id) });
}

let changed = 0;
for (const target of targets) {
  const path = join(ROOT, target.file);
  const before = await readFile(path, 'utf8');
  if (target.required && !target.required.test(before)) {
    console.error(`stamp-build: a required pattern is missing from ${target.file}: ${target.required}`);
    console.error('  scripts/stamp-build.mjs stopped matching — deploys would go out unstamped and untraceable.');
    process.exit(1);
  }
  const after = target.transform(before);
  if (after === before) continue;
  if (!CHECK_ONLY) await writeFile(path, after);
  changed += 1;
  console.log(`stamp-build: ${target.file}${CHECK_ONLY ? ' (would change)' : ''}`);
}

console.log(`stamp-build: build id ${id} · ${changed}/${targets.length} file(s) ${CHECK_ONLY ? 'would change' : 'stamped'}`);
