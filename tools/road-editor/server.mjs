/**
 * SHUTOKO ROAD EDITOR — local server.
 *
 *   node tools/road-editor/server.mjs [--port=8123] [--overrides=path]
 *                                     [--backups=dir] [--open] [--allow-apply]
 *
 * Serves the editor UI and a NARROW JSON API on 127.0.0.1 only. There is no
 * arbitrary-command endpoint and no arbitrary-filesystem endpoint: every
 * operation is one of the fixed routes below, every write goes through the
 * validated, atomic, backed-up OverrideStore, and "full validation" runs
 * only hardcoded allowlisted commands.
 *
 *   GET  /api/meta              server paths + flags
 *   GET  /api/network           raw + processed datasets, protected zones
 *   GET  /api/quality           per-route base curvature quality (cached)
 *   GET  /api/overrides         current override file (never throws)
 *   POST /api/preview           { routeId, overrides, light? } → faired
 *                               preview + warnings via the SHARED fairing
 *                               core (identical to the CLI generator)
 *   POST /api/save              { doc } → validate, backup, atomic write
 *   GET  /api/backups           timestamped backups list
 *   POST /api/restore           { name } → restore a backup (backs up first)
 *   POST /api/generate-preview  { overrides? } → full pipeline to TEMP paths;
 *                               production data/ is never written
 *   POST /api/validate-quick    { overrides? } → focused checks, all routes
 *   POST /api/validate-full     streams allowlisted project probes
 *   POST /api/apply             disabled unless started with --allow-apply
 *
 * No framework, no build step, Node built-ins only (+ `three` which the
 * fairing core already requires: npm i --no-save three@0.166.1).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeParams, buildSmoothedData } from './lib/fairing.mjs';
import { OverrideStore } from './lib/store.mjs';
import { validateOverrides } from './lib/schema.mjs';
import { analyzeRouteEdit, baseQualitySnapshot, describeZones } from './lib/analysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PUBLIC = path.join(HERE, 'public');

function argVal(flag, dflt) {
  const a = process.argv.find((x) => x.startsWith(`${flag}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const PORT = Number(argVal('--port', 8123));
const OVERRIDES_FILE = path.resolve(ROOT, argVal('--overrides', 'data/route-overrides.json'));
const BACKUP_DIR = path.resolve(ROOT, argVal('--backups', 'tools/road-editor/backups'));
const ALLOW_APPLY = process.argv.includes('--allow-apply');
const OPEN_BROWSER = process.argv.includes('--open');

// ------------------------------------------------------------ data at boot
const rawData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/routes.json'), 'utf8'));
const smoothedData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/routes-smoothed.json'), 'utf8'));
const params = makeParams();
const store = new OverrideStore({
  file: OVERRIDES_FILE,
  backupDir: BACKUP_DIR,
  knownRouteIds: rawData.routes.map((r) => r.id),
});

const zonesByRoute = {};
for (const r of rawData.routes) zonesByRoute[r.id] = describeZones(r, rawData, params).spans;

let qualityCache = null; // computed lazily (a few seconds for 64 routes)

const PRODUCTION_FILES = ['data/routes.json', 'data/routes.js', 'data/routes-smoothed.json', 'data/routes-smoothed.js'];
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
const productionHashes = () => Object.fromEntries(PRODUCTION_FILES.map((p) => [p, sha(p)]));
const BOOT_HASHES = productionHashes();

// one temp dir per server run for preview regenerations
const PREVIEW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'road-editor-preview-'));

// ------------------------------------------------------------- validation
/** Hardcoded full-validation allowlist — never accept commands from input. */
const FULL_VALIDATION_STEPS = [
  { label: 'Metriche di curvatura (tools/fairing-metrics.mjs)', cmd: process.execPath, args: ['tools/fairing-metrics.mjs'] },
  { label: 'Suite di validazione mappa (.devtests/osm-validate.mjs)', cmd: process.execPath, args: ['.devtests/osm-validate.mjs'] },
];

// ---------------------------------------------------------------- helpers
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body troppo grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.normalize(path.join(PUBLIC, rel));
  if (!abs.startsWith(PUBLIC + path.sep) && abs !== path.join(PUBLIC, 'index.html')) {
    json(res, 403, { ok: false, error: 'percorso non consentito' });
    return;
  }
  const ext = path.extname(abs);
  if (!MIME[ext]) { json(res, 404, { ok: false, error: 'tipo di file non servito' }); return; }
  fs.readFile(abs, (err, buf) => {
    if (err) { json(res, 404, { ok: false, error: 'file non trovato' }); return; }
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-store' });
    res.end(buf);
  });
}

/** Serialize a generated dataset exactly like the CLI generator does. */
function serializeGenerated(out, toolLabel) {
  out.meta.fairing = {
    tool: toolLabel,
    source: 'data/routes.json',
    generatedAt: new Date().toISOString(),
    ds: params.DS, lambda: params.LAMBDA, cap: params.CAP, outSpacing: params.DS * params.OUT_EVERY,
  };
  const jsonText = JSON.stringify(out);
  const jsText = `// GENERATED by tools/build-smoothed-routes.mjs from data/routes.json — do not edit by hand.\n`
    + `// Offline-faired centrelines (XZ only). Raw OSM data lives in data/routes.js.\n`
    + `// Data © OpenStreetMap contributors, ODbL 1.0.\n`
    + `export default ${jsonText};\n`;
  return { jsonText, jsText };
}

function summarizeBuild(build) {
  const changed = [];
  for (const r of build.out.routes) {
    const prod = smoothedData.routes.find((x) => x.id === r.id);
    if (!prod || JSON.stringify(prod.points) !== JSON.stringify(r.points)) {
      const res = build.results.get(r.id);
      changed.push({
        id: r.id,
        maxDev: res ? Math.round(res.stats.maxDev * 100) / 100 : null,
        lenDelta: res ? Math.round(res.stats.lenDelta * 10) / 10 : null,
        points: r.points.length,
      });
    }
  }
  return changed;
}

// ------------------------------------------------------------------ routes
const routes = {
  'GET /api/meta': async (req, res) => {
    json(res, 200, {
      ok: true,
      root: ROOT,
      overridesFile: OVERRIDES_FILE,
      backupDir: BACKUP_DIR,
      previewDir: PREVIEW_DIR,
      allowApply: ALLOW_APPLY,
      params,
    });
  },

  'GET /api/network': async (req, res) => {
    json(res, 200, {
      ok: true,
      data: rawData,
      smoothed: {
        meta: smoothedData.meta,
        routes: smoothedData.routes.map((r) => ({ id: r.id, points: r.points, length: r.length, closed: r.closed })),
        edges: smoothedData.edges,
      },
      zones: zonesByRoute,
    });
  },

  'GET /api/quality': async (req, res) => {
    if (!qualityCache) qualityCache = baseQualitySnapshot(smoothedData);
    json(res, 200, { ok: true, quality: qualityCache });
  },

  'GET /api/overrides': async (req, res) => {
    const loaded = store.load();
    json(res, 200, { ...loaded, path: OVERRIDES_FILE });
  },

  'POST /api/preview': async (req, res) => {
    const body = await readJson(req);
    const { routeId, overrides = null, light = false } = body;
    if (typeof routeId !== 'string') { json(res, 400, { ok: false, error: 'routeId mancante' }); return; }
    if (overrides !== null) {
      const v = validateOverrides(overrides, rawData.routes.map((r) => r.id));
      if (!v.ok) { json(res, 422, { ok: false, error: 'override non validi', validation: v }); return; }
    }
    const t0 = Date.now();
    const result = analyzeRouteEdit({ data: rawData, smoothedData, routeId, overrides, params, light: !!light });
    if (!result.ok) { json(res, 404, result); return; }
    json(res, 200, { ...result, ms: Date.now() - t0 });
  },

  'POST /api/save': async (req, res) => {
    const body = await readJson(req);
    const doc = body.doc;
    if (!doc || typeof doc !== 'object') { json(res, 400, { ok: false, error: 'doc mancante' }); return; }
    const v = validateOverrides(doc, rawData.routes.map((r) => r.id));
    if (!v.ok) { json(res, 422, { ok: false, error: 'schema non valido', errors: v.errors }); return; }
    // hard structural errors block the save
    const blocking = [];
    const routeIds = v.version === 2 ? Object.keys(doc.routes) : Object.keys(doc);
    for (const id of routeIds) {
      const a = analyzeRouteEdit({ data: rawData, smoothedData, routeId: id, overrides: doc, params });
      if (a.ok && a.hasErrors) blocking.push({ routeId: id, findings: a.findings.filter((f) => f.severity === 'error') });
    }
    if (blocking.length) {
      json(res, 409, { ok: false, error: 'errori bloccanti: correggi prima di salvare', blocking });
      return;
    }
    const previous = store.load();
    const saved = store.save(doc);
    if (!saved.ok) { json(res, 500, { ok: false, error: 'salvataggio fallito', errors: saved.errors }); return; }
    json(res, 200, {
      ok: true,
      path: OVERRIDES_FILE,
      backupPath: saved.backupPath,
      bytes: saved.bytes,
      previous: previous.ok ? previous.doc : null,
    });
  },

  'GET /api/backups': async (req, res) => {
    json(res, 200, { ok: true, backups: store.listBackups(), dir: BACKUP_DIR });
  },

  'POST /api/restore': async (req, res) => {
    const body = await readJson(req);
    const result = store.restore(String(body.name || ''));
    if (!result.ok) { json(res, 400, result); return; }
    json(res, 200, result);
  },

  'POST /api/generate-preview': async (req, res) => {
    const body = await readJson(req);
    let overrides = body.overrides ?? undefined;
    if (overrides === undefined) {
      const loaded = store.load();
      if (!loaded.ok) { json(res, 409, { ok: false, error: `file override attuale non utilizzabile: ${loaded.error}` }); return; }
      overrides = loaded.doc;
    }
    if (overrides !== null) {
      const v = validateOverrides(overrides, rawData.routes.map((r) => r.id));
      if (!v.ok) { json(res, 422, { ok: false, error: 'override non validi', validation: v }); return; }
    }
    const before = productionHashes();
    const t0 = Date.now();
    const logs = [];
    const build = buildSmoothedData(rawData, { overrides, params, log: (l) => logs.push(l) });
    const { jsonText, jsText } = serializeGenerated(build.out, 'tools/road-editor/server.mjs#generate-preview');
    const jsonPath = path.join(PREVIEW_DIR, 'routes-smoothed.json');
    const jsPath = path.join(PREVIEW_DIR, 'routes-smoothed.js');
    fs.writeFileSync(jsonPath, jsonText);
    fs.writeFileSync(jsPath, jsText);
    const after = productionHashes();
    json(res, 200, {
      ok: true,
      files: [jsonPath, jsPath],
      ms: Date.now() - t0,
      worstDev: build.worstDev,
      guardRounds: build.guardRounds,
      changedRoutes: summarizeBuild(build),
      productionUntouched: JSON.stringify(before) === JSON.stringify(after),
      logs: logs.slice(-80),
    });
  },

  'POST /api/validate-quick': async (req, res) => {
    const body = await readJson(req);
    let overrides = body.overrides ?? undefined;
    if (overrides === undefined) {
      const loaded = store.load();
      if (!loaded.ok) { json(res, 409, { ok: false, error: loaded.error }); return; }
      overrides = loaded.doc;
    }
    const v = validateOverrides(overrides, rawData.routes.map((r) => r.id));
    if (!v.ok) { json(res, 200, { ok: true, schema: v, routes: [] }); return; }
    const ids = v.version === 2 ? Object.keys(overrides.routes) : Object.keys(overrides);
    const perRoute = [];
    const t0 = Date.now();
    for (const id of ids) {
      if (!rawData.routes.some((r) => r.id === id)) continue;
      const a = analyzeRouteEdit({ data: rawData, smoothedData, routeId: id, overrides, params });
      perRoute.push({
        routeId: id,
        findings: a.findings,
        hasErrors: a.hasErrors,
        stats: a.stats,
        overrideWarnings: a.overrideWarnings,
      });
    }
    json(res, 200, { ok: true, schema: v, routes: perRoute, ms: Date.now() - t0 });
  },

  'POST /api/validate-full': async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.write(`Validazione completa: ${FULL_VALIDATION_STEPS.length} controlli (comandi fissi, sola lettura)\n`);
    res.write('NOTA: questi controlli analizzano i dati ATTUALI del gioco (data/routes-smoothed.*),\n');
    res.write('non le modifiche non ancora applicate.\n\n');
    for (const step of FULL_VALIDATION_STEPS) {
      res.write(`\n=== ${step.label} ===\n`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        const child = spawn(step.cmd, step.args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { child.kill('SIGKILL'); res.write('\n[interrotto: timeout 10 minuti]\n'); }, 600000);
        child.stdout.on('data', (d) => res.write(d));
        child.stderr.on('data', (d) => res.write(d));
        child.on('close', (code) => {
          clearTimeout(timer);
          res.write(`\n[${step.label}] exit ${code}\n`);
          resolve();
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          res.write(`\n[${step.label}] errore di avvio: ${e.message}\n`);
          resolve();
        });
      });
    }
    res.end('\nValidazione completa terminata.\n');
  },

  'POST /api/apply': async (req, res) => {
    if (!ALLOW_APPLY) {
      json(res, 403, {
        ok: false,
        error: 'Applicazione alla working tree DISABILITATA. Riavvia il server con --allow-apply per usarla. '
          + 'Questa azione riscrive data/route-overrides.json e rigenera data/routes-smoothed.{json,js}.',
      });
      return;
    }
    const body = await readJson(req);
    if (body.confirm !== 'APPLICA') {
      json(res, 400, { ok: false, error: "conferma mancante: invia { confirm: 'APPLICA' }" });
      return;
    }
    const doc = body.doc;
    if (!doc || typeof doc !== 'object') { json(res, 400, { ok: false, error: 'doc mancante' }); return; }
    const v = validateOverrides(doc, rawData.routes.map((r) => r.id));
    if (!v.ok) { json(res, 422, { ok: false, error: 'schema non valido', errors: v.errors }); return; }
    const saved = store.save(doc);
    if (!saved.ok) { json(res, 500, { ok: false, error: 'salvataggio override fallito', errors: saved.errors }); return; }
    const build = buildSmoothedData(rawData, { overrides: doc, params });
    const { jsonText, jsText } = serializeGenerated(build.out, 'tools/build-smoothed-routes.mjs');
    // back up production files before overwriting
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const t = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of ['routes-smoothed.json', 'routes-smoothed.js']) {
      const p = path.join(ROOT, 'data', f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(BACKUP_DIR, `${f}.${t}.bak`));
    }
    fs.writeFileSync(path.join(ROOT, 'data', 'routes-smoothed.json'), jsonText);
    fs.writeFileSync(path.join(ROOT, 'data', 'routes-smoothed.js'), jsText);
    json(res, 200, {
      ok: true,
      changedFiles: ['data/route-overrides.json', 'data/routes-smoothed.json', 'data/routes-smoothed.js'],
      changedRoutes: summarizeBuild(build),
      note: 'Nessun commit automatico: controlla il diff con git.',
    });
  },
};

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) {
      await routes[key](req, res);
      return;
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      serveStatic(res, url.pathname);
      return;
    }
    json(res, 404, { ok: false, error: `endpoint sconosciuto: ${key}` });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    else res.end(`\n[errore interno] ${e.message}\n`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('SHUTOKO ROAD EDITOR');
  console.log(`  UI:            ${url}`);
  console.log(`  override file: ${OVERRIDES_FILE}`);
  console.log(`  backup:        ${BACKUP_DIR}`);
  console.log(`  anteprime:     ${PREVIEW_DIR}`);
  console.log(`  apply:         ${ALLOW_APPLY ? 'ABILITATO (--allow-apply)' : 'disabilitato'}`);
  if (OPEN_BROWSER) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* best effort */ }
  }
});

export default server;
