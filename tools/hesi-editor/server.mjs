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
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProjectDocument, serializeProjectDocument } from './src/overrides/override-schema.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = Number(process.env.HESI_EDITOR_PORT) || 8081;
const EDITOR_PATH = '/tools/hesi-editor/index.html';
const PROJECT_ENDPOINT = '/__hesi_editor_project';
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;

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

async function saveProject(projectPath, document) {
  const { normalized, file } = projectFile(projectPath);
  const validated = parseProjectDocument(JSON.stringify(document));
  const serialized = serializeProjectDocument(validated);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  let backup = null;
  try {
    await stat(file);
    backup = `${file}.bak`;
    await copyFile(file, backup);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
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
  return { path: normalized, bytes: Buffer.byteLength(serialized), backup: backup ? `${normalized}.bak` : null };
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const path = decodeURIComponent(requestUrl.pathname);
    if (path === PROJECT_ENDPOINT) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const target = projectFile(requestUrl.searchParams.get('path'));
        const text = await readFile(target.file, 'utf8');
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
