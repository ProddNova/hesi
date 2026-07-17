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
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = Number(process.env.HESI_EDITOR_PORT) || 8081;
const EDITOR_PATH = '/tools/hesi-editor/index.html';

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

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const path = decodeURIComponent(requestUrl.pathname);
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
  } catch {
    res.writeHead(404);
    res.end('Not found');
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
