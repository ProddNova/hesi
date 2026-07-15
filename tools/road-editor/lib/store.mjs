/**
 * Override file store: safe load, ATOMIC save, timestamped backups, restore.
 *
 * Guarantees:
 *   - a save is always schema-validated first;
 *   - the new content is written to a temporary file in the same directory
 *     and moved into place with rename() — no partial JSON is ever visible;
 *   - the previous file (if any) is backed up with a timestamped name BEFORE
 *     being replaced; restores back up the current file too;
 *   - a malformed existing file never throws: load() reports the parse error
 *     and keeps the raw text available so nothing is lost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateOverrides, emptyOverrides } from './schema.mjs';

function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

export class OverrideStore {
  /**
   * @param {object} opts
   * @param {string} opts.file       path of route-overrides.json
   * @param {string} opts.backupDir  directory for timestamped backups
   * @param {Iterable<string>} [opts.knownRouteIds]  validated against on save
   */
  constructor({ file, backupDir, knownRouteIds = null }) {
    this.file = path.resolve(file);
    this.backupDir = path.resolve(backupDir);
    this.knownRouteIds = knownRouteIds ? [...knownRouteIds] : null;
  }

  /** Never throws. → { ok, exists, doc?, error?, rawText? } */
  load() {
    let rawText;
    try {
      rawText = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, exists: false, doc: emptyOverrides() };
      return { ok: false, exists: false, error: `impossibile leggere ${this.file}: ${e.message}` };
    }
    if (!rawText.trim()) return { ok: true, exists: true, doc: emptyOverrides(), empty: true };
    let doc;
    try {
      doc = JSON.parse(rawText);
    } catch (e) {
      return {
        ok: false, exists: true, rawText,
        error: `route-overrides.json non è JSON valido: ${e.message}. Il file NON è stato toccato; ripristina un backup o correggilo a mano.`,
      };
    }
    const v = validateOverrides(doc, this.knownRouteIds);
    if (!v.ok) {
      return {
        ok: false, exists: true, rawText, doc,
        error: 'route-overrides.json non rispetta lo schema',
        validation: v,
      };
    }
    return { ok: true, exists: true, doc, version: v.version };
  }

  /**
   * Validate + backup + atomic replace. Never leaves a partial file.
   * → { ok, errors? , backupPath?, bytes? }
   */
  save(doc) {
    const v = validateOverrides(doc, this.knownRouteIds);
    if (!v.ok) return { ok: false, errors: v.errors };
    const json = `${JSON.stringify(doc, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let backupPath = null;
    if (fs.existsSync(this.file)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      backupPath = path.join(this.backupDir, `route-overrides-${stamp()}.json`);
      fs.copyFileSync(this.file, backupPath);
    }
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, json);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      return { ok: false, errors: [{ path: '$', message: `scrittura fallita: ${e.message}` }] };
    }
    return { ok: true, backupPath, bytes: Buffer.byteLength(json) };
  }

  /** → [ { name, path, mtime, size } ] newest first. Never throws. */
  listBackups() {
    let names;
    try {
      names = fs.readdirSync(this.backupDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => /^route-overrides-\d{8}-\d{6}-\d{3}\.json$/.test(n))
      .map((n) => {
        const p = path.join(this.backupDir, n);
        const st = fs.statSync(p);
        return { name: n, path: p, mtime: st.mtime.toISOString(), size: st.size };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  /**
   * Restore a named backup into the live file (backing up the current file
   * first). The name must be one of listBackups() — no path components.
   */
  restore(name) {
    if (!/^route-overrides-\d{8}-\d{6}-\d{3}\.json$/.test(name)) {
      return { ok: false, errors: [{ path: '$', message: 'nome di backup non valido' }] };
    }
    const src = path.join(this.backupDir, name);
    let text;
    try {
      text = fs.readFileSync(src, 'utf8');
    } catch (e) {
      return { ok: false, errors: [{ path: '$', message: `backup illeggibile: ${e.message}` }] };
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: [{ path: '$', message: `il backup non è JSON valido: ${e.message}` }] };
    }
    const saved = this.save(doc);
    if (!saved.ok) return saved;
    return { ok: true, doc, backupPath: saved.backupPath };
  }
}
