/**
 * SHUTOKO NIGHTS — world editor dev server (CONTRACTS §12).
 *
 * Dependency-free node:http static server for the external world editor.
 * Serves the REPO ROOT so the editor page resolves the importmap
 * (/node_modules/three/...), /js/map.js and /data/... over plain absolute
 * URLs. Dev-only: the game never loads anything under tools/hesi-editor/.
 *
 * `/` and `/editor` redirect to the editor page. Path traversal outside
 * the repo root is rejected.
 *
 * Run from repo root:  node tools/hesi-editor/server.mjs
 * Port override:       HESI_EDITOR_PORT=8082 node tools/hesi-editor/server.mjs
 */
import { createServer } from 'node:http';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProjectDocument, serializeProjectDocument, validateProjectDocument } from './src/overrides/override-schema.js';
import { BUILD_PATHS, serializeBuildDocument } from './src/overrides/build-schema.js';
import {
  ROAD_ROUTE_PATHS,
  applyRoadRouteOverrides,
  blankRoadRouteOverrides,
  canonicalizeRoadRouteOverrides,
  mergeRoadRouteUpdates,
  productionRouteModuleSource,
  serializeProductionRoutes,
  serializeRoadRouteOverrides,
  validateProductionRouteDocument,
} from './src/overrides/road-route-schema.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = Number(process.env.HESI_EDITOR_PORT) || 8081;
const EDITOR_PATH = '/tools/hesi-editor/index.html';
const PROJECT_ENDPOINT = '/__hesi_editor_project';
const BUILD_ENDPOINT = '/__hesi_editor_build';
const COMMITS_ENDPOINT = '/__hesi_editor_commits';
const ROUTES_ENDPOINT = '/__hesi_editor_routes';
const COMMITS_DIR = 'data/editor/commits';
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_COMMITS_LISTED = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

function sendJson(res, status, payload, method = 'GET') {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : body);
}

function projectFile(projectPath) {
  const normalized = String(projectPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('data/editor/') || !normalized.toLowerCase().endsWith('.json') || normalized.includes('\0')) {
    throw new Error('Project path must be a .json file under data/editor/');
  }
  const file = resolve(ROOT, normalized);
  const fromRoot = relative(ROOT, file);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Project path escapes the repository');
  return { normalized, file };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_PROJECT_BYTES) throw new Error('Project request exceeds 2 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw new Error(`Request JSON is invalid: ${error.message}`); }
}

// Full write into a temporary sibling, previous content copied to .bak, then an
// atomic swap: a crash mid-save never leaves a truncated file behind.
async function writeFileSafe(file, serialized, { backup = true } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  let backedUp = false;
  if (backup) {
    try {
      await stat(file);
      await copyFile(file, `${file}.bak`);
      backedUp = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
    try { await rename(temporary, file); }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      await rm(file);
      await rename(temporary, file);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return backedUp;
}

async function saveProject(projectPath, document) {
  const { normalized, file } = projectFile(projectPath);
  const validated = parseProjectDocument(JSON.stringify(document));
  const serialized = serializeProjectDocument(validated);
  const backedUp = await writeFileSafe(file, serialized);
  return { path: normalized, bytes: Buffer.byteLength(serialized), backup: backedUp ? `${normalized}.bak` : null };
}

async function saveBuild(scene, build) {
  const targetPath = BUILD_PATHS[scene];
  if (!targetPath) throw new Error(`Unknown build scene: ${scene}`);
  const serialized = serializeBuildDocument(build);
  const file = resolve(ROOT, targetPath);
  await writeFileSafe(file, serialized);
  return { path: targetPath, bytes: Buffer.byteLength(serialized), operations: build.operations.length };
}

// Road edits have a versioned source file and an explicit publish step. This
// keeps editor Save separate from the generated files loaded by the game.
async function readProductionRoutes() {
  const file = resolve(ROOT, ROAD_ROUTE_PATHS.productionJson);
  let document;
  try { document = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Production route data is unreadable: ${error.message}`); }
  return validateProductionRouteDocument(document);
}

async function readRoadRouteOverrides(production) {
  const file = resolve(ROOT, ROAD_ROUTE_PATHS.source);
  try {
    const document = JSON.parse(await readFile(file, 'utf8'));
    return canonicalizeRoadRouteOverrides(document, { production });
  } catch (error) {
    if (error.code === 'ENOENT') return blankRoadRouteOverrides();
    throw new Error(`Saved road route overrides are unreadable: ${error.message}`);
  }
}

// Save only the explicitly changed routes. Unrelated routes are copied from
// the existing source document and raw/generated production data is untouched.
async function saveRoadRouteUpdates(updates) {
  const production = await readProductionRoutes();
  const previous = await readRoadRouteOverrides(production);
  const document = mergeRoadRouteUpdates(previous, updates, production);
  const serialized = serializeRoadRouteOverrides(document, { production });
  await writeFileSafe(resolve(ROOT, ROAD_ROUTE_PATHS.source), serialized);
  return {
    path: ROAD_ROUTE_PATHS.source,
    bytes: Buffer.byteLength(serialized),
    routes: [...Object.keys(document.routes), ...Object.keys(document.syntheticRoutes)].sort(),
  };
}

// Publish is deliberately separate from Save: it validates the versioned
// editor source, merges only its route point arrays into production data, and
// emits the JSON + ES module consumed by js/map.js and the playable game.
async function publishRoadRoutes() {
  const production = await readProductionRoutes();
  const overrides = await readRoadRouteOverrides(production);
  const routeIds = [...Object.keys(overrides.routes), ...Object.keys(overrides.syntheticRoutes)].sort();
  if (!routeIds.length) throw new Error(`No saved road route edits found in ${ROAD_ROUTE_PATHS.source}; edit and Save a road first`);
  const output = applyRoadRouteOverrides(production, overrides);
  const json = serializeProductionRoutes(output);
  const moduleSource = productionRouteModuleSource(json);
  await writeFileSafe(resolve(ROOT, ROAD_ROUTE_PATHS.productionModule), moduleSource);
  await writeFileSafe(resolve(ROOT, ROAD_ROUTE_PATHS.productionJson), json);
  return {
    sourcePath: ROAD_ROUTE_PATHS.source,
    jsonPath: ROAD_ROUTE_PATHS.productionJson,
    modulePath: ROAD_ROUTE_PATHS.productionModule,
    bytes: Buffer.byteLength(json),
    routes: routeIds,
  };
}

// ---- Commit management: every commit snapshots one full project version ----

function commitScene(scene) {
  if (!Object.hasOwn(BUILD_PATHS, String(scene || ''))) throw new Error(`Commit scene must be one of ${Object.keys(BUILD_PATHS).join(', ')}`);
  return String(scene);
}

function commitFile(scene, id) {
  const normalizedScene = commitScene(scene);
  const normalizedId = String(id || '');
  if (!/^[a-z0-9][a-z0-9_-]{0,120}$/i.test(normalizedId)) throw new Error('Commit id contains unsupported characters');
  return resolve(ROOT, COMMITS_DIR, normalizedScene, `${normalizedId}.json`);
}

function commitId(message) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const slug = String(message || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `${stamp}-${randomUUID().slice(0, 8)}${slug ? `-${slug}` : ''}`;
}

async function createCommit({ scene, message, projectPath, document, build = null }) {
  const normalizedScene = commitScene(scene);
  const trimmedMessage = String(message || '').trim();
  if (!trimmedMessage || trimmedMessage.length > 400) throw new Error('Commit message must be 1-400 characters');
  const validated = parseProjectDocument(JSON.stringify(document));
  const { normalized } = projectFile(projectPath);
  const id = commitId(trimmedMessage);
  const meta = {
    id,
    scene: normalizedScene,
    message: trimmedMessage,
    createdAt: new Date().toISOString(),
    projectPath: normalized,
    projectName: validated.project.name,
    overrideCount: Object.keys(validated.entityOverrides).length,
    placedObjectCount: validated.placedObjects.length,
  };
  const payload = { meta, document: validated };
  if (build) {
    serializeBuildDocument(build); // validation only; the raw build travels with the commit
    payload.build = build;
  }
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFileSafe(commitFile(normalizedScene, id), serialized, { backup: false });
  return { ...meta, bytes: Buffer.byteLength(serialized) };
}

async function listCommits(scene) {
  const normalizedScene = commitScene(scene);
  const directory = resolve(ROOT, COMMITS_DIR, normalizedScene);
  let names = [];
  try { names = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const commits = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort().reverse().slice(0, MAX_COMMITS_LISTED)) {
    try {
      const text = await readFile(resolve(directory, name), 'utf8');
      const payload = JSON.parse(text);
      if (!payload?.meta?.id) continue;
      commits.push({ ...payload.meta, bytes: Buffer.byteLength(text), hasBuild: Boolean(payload.build) });
    } catch { /* Unreadable snapshots are skipped rather than blocking the list. */ }
  }
  commits.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return commits;
}

async function readCommit(scene, id) {
  const text = await readFile(commitFile(scene, id), 'utf8');
  const payload = JSON.parse(text);
  validateProjectDocument(payload.document);
  return payload;
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const path = decodeURIComponent(requestUrl.pathname);
    if (path === PROJECT_ENDPOINT) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const target = projectFile(requestUrl.searchParams.get('path'));
        let text;
        try {
          text = await readFile(target.file, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // "No project saved yet" is a normal state, not an error: answer 204 so
          // the browser does not log a console error for a routine startup probe.
          res.writeHead(204);
          res.end();
          return;
        }
        const details = await stat(target.file);
        const document = parseProjectDocument(text);
        sendJson(res, 200, { ok: true, path: target.normalized, modifiedMs: details.mtimeMs, document }, req.method);
        return;
      }
      if (req.method === 'PUT') {
        const payload = await readJsonBody(req);
        const result = await saveProject(payload.path, payload.document);
        sendJson(res, 200, { ok: true, ...result }, req.method);
        return;
      }
      if (req.method === 'DELETE') {
        const target = projectFile(requestUrl.searchParams.get('path'));
        if (!target.normalized.endsWith('.autosave.json')) throw new Error('Only autosave recovery files can be deleted through the editor endpoint');
        await rm(target.file, { force: true });
        sendJson(res, 200, { ok: true, path: target.normalized }, req.method);
        return;
      }
      sendJson(res, 405, { ok: false, error: 'Method not allowed' }, req.method);
      return;
    }
    if (path === BUILD_ENDPOINT) {
      if (req.method === 'PUT') {
        const payload = await readJsonBody(req);
        const result = await saveBuild(payload.scene, payload.build);
        sendJson(res, 200, { ok: true, ...result }, req.method);
        return;
      }
      sendJson(res, 405, { ok: false, error: 'Method not allowed' }, req.method);
      return;
    }
    if (path === COMMITS_ENDPOINT) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const commits = await listCommits(requestUrl.searchParams.get('scene'));
        sendJson(res, 200, { ok: true, commits }, req.method);
        return;
      }
      if (req.method === 'POST') {
        const payload = await readJsonBody(req);
        const commit = await createCommit(payload);
        sendJson(res, 200, { ok: true, commit }, req.method);
        return;
      }
      sendJson(res, 405, { ok: false, error: 'Method not allowed' }, req.method);
      return;
    }
    if (path === `${COMMITS_ENDPOINT}/one`) {
      const scene = requestUrl.searchParams.get('scene');
      const id = requestUrl.searchParams.get('id');
      if (req.method === 'GET' || req.method === 'HEAD') {
        const commit = await readCommit(scene, id);
        sendJson(res, 200, { ok: true, ...commit }, req.method);
        return;
      }
      if (req.method === 'DELETE') {
        await rm(commitFile(scene, id), { force: true });
        sendJson(res, 200, { ok: true, id }, req.method);
        return;
      }
      sendJson(res, 405, { ok: false, error: 'Method not allowed' }, req.method);
      return;
    }
    if (path === ROUTES_ENDPOINT) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const production = await readProductionRoutes();
        const document = await readRoadRouteOverrides(production);
        sendJson(res, 200, { ok: true, path: ROAD_ROUTE_PATHS.source, document }, req.method);
        return;
      }
      if (req.method === 'PUT') {
        const payload = await readJsonBody(req);
        const result = await saveRoadRouteUpdates(payload.updates);
        sendJson(res, 200, { ok: true, ...result }, req.method);
        return;
      }
      if (req.method === 'POST') {
        const result = await publishRoadRoutes();
        sendJson(res, 200, { ok: true, ...result }, req.method);
        return;
      }
      sendJson(res, 405, { ok: false, error: 'Method not allowed' }, req.method);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' }, req.method);
      return;
    }
    if (path === '/' || path === '/editor' || path === '/editor/') {
      res.writeHead(302, { location: `${EDITOR_PATH}${requestUrl.search}` });
      res.end();
      return;
    }
    if (path === '/__hesi_editor_health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, editor: EDITOR_PATH }));
      return;
    }
    // Prefix with a dot so a leading slash cannot replace ROOT on POSIX.
    const file = resolve(ROOT, `.${path}`);
    const fromRoot = relative(ROOT, file);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 400;
    if (!res.headersSent) sendJson(res, status, { ok: false, error: error.message }, req.method);
    else res.end();
  }
});

server.on('error', (err) => {
  console.error(`[hesi-editor] cannot start on port ${PORT}: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[hesi-editor] serving repo root: ${ROOT}`);
  console.log(`[hesi-editor] editor  -> http://localhost:${PORT}${EDITOR_PATH}`);
  console.log(`[hesi-editor] aliases -> http://localhost:${PORT}/ and http://localhost:${PORT}/editor`);
});
