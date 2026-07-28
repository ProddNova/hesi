#!/usr/bin/env node
/**
 * Stamps the current build id into the two places that otherwise have to be
 * bumped by hand before every deploy:
 *
 *   sw.js      const CACHE = 'shutoko-nights-<id>'
 *   index.html <script type="module" src="js/game.js?v=<id>">
 *
 * Both exist to make a deploy visible to a browser that is already holding the
 * previous one, and both were being edited manually — which means they were
 * sometimes not edited at all, and the player saw a deploy that "did not
 * apply". Render runs this as its build command, so the stamp now happens on
 * every deploy including ones pushed from a phone.
 *
 * The id is the commit being deployed (RENDER_GIT_COMMIT on Render, otherwise
 * git). A UTC timestamp is the last resort, so a build outside git still
 * produces a unique id rather than silently reusing the previous one.
 *
 * Idempotent: stamping the same commit twice is a no-op, and the file keeps a
 * readable `shutoko-nights-<sha>` shape so it is obvious what is deployed.
 *
 * Run: node scripts/stamp-build.mjs [--check]
 *   --check verifies the patterns still match without writing (for CI/tests).
 */
import { readFile, writeFile } from 'node:fs/promises';
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

// Each target names the file, the pattern to find, and how to rewrite it. The
// patterns are deliberately narrow: a silent no-match would put the manual
// bumping back without anyone noticing, so a miss is a hard failure.
const TARGETS = [
  {
    file: 'sw.js',
    find: /const CACHE = 'shutoko-nights-[^']+';/,
    replace: (id) => `const CACHE = 'shutoko-nights-${id}';`,
    what: "the service worker's cache name",
  },
  {
    file: 'index.html',
    find: /(<script type="module" src="js\/game\.js)\?v=[^"]*(")/,
    replace: (id) => `$1?v=${id}$2`,
    what: "the entry module's cache-busting query",
  },
];

const id = buildId();
let changed = 0;
for (const target of TARGETS) {
  const path = join(ROOT, target.file);
  const before = await readFile(path, 'utf8');
  if (!target.find.test(before)) {
    console.error(`stamp-build: could not find ${target.what} in ${target.file}.`);
    console.error('  The pattern in scripts/stamp-build.mjs no longer matches — deploys would go out unstamped.');
    process.exit(1);
  }
  const after = before.replace(target.find, target.replace(id));
  if (after === before) {
    console.log(`stamp-build: ${target.file} already at ${id}`);
    continue;
  }
  if (!CHECK_ONLY) await writeFile(path, after);
  changed += 1;
  console.log(`stamp-build: ${target.file} → ${id}${CHECK_ONLY ? ' (check only, not written)' : ''}`);
}

if (CHECK_ONLY) console.log(`stamp-build: patterns OK (${TARGETS.length} targets, ${changed} would change)`);
else console.log(`stamp-build: build id ${id}`);
