/** Test helpers: synthetic network fixture + temp dirs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Small synthetic network: one 1.2 km S-curve mainline (test_a) with a
 * 480 m ramp (test_b) diverging at ~600 m. Geometry mimics the real data:
 * DP-style chords with occasional direction kinks.
 */
export function makeFixtureData() {
  const aPts = [];
  for (let i = 0; i <= 60; i += 1) {
    const s = i * 20;
    const x = s;
    const z = 40 * Math.sin(s / 260) + (i % 7 === 3 ? 1.2 : 0); // waves + kinks
    aPts.push([round2(x), 2, round2(z)]);
  }
  const bPts = [];
  // ramp leaves test_a near s=600 and curls away
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    const s = 600 + t * 480;
    const off = 90 * t * t;
    bPts.push([round2(s), 2 + 3 * t, round2(40 * Math.sin(s / 260) - off)]);
  }
  const len = (pts) => {
    let L = 0;
    for (let i = 1; i < pts.length; i += 1) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
    return Math.round(L * 100) / 100;
  };
  return {
    meta: { laneWidth: 3.5, origin: { lat: 0, lon: 0 }, stats: {} },
    groups: [],
    routes: [
      {
        id: 'test_a', group: 'ta', code: 'TA', name: 'Test A', nameJa: '', kind: 'mainline',
        closed: false, synthetic: false, lanes: 2, speedLimit: 80,
        length: len(aPts), points: aPts, tunnels: [], bridges: [], destinations: [], paId: null,
      },
      {
        id: 'test_b', group: 'tb', code: 'TB', name: 'Test B', nameJa: '', kind: 'ramp',
        closed: false, synthetic: false, lanes: 1, speedLimit: 40,
        length: len(bPts), points: bPts, tunnels: [], bridges: [], destinations: [], paId: null,
      },
    ],
    edges: [
      { from: { route: 'test_a', distance: 600 }, to: { route: 'test_b', distance: 0 }, kind: 'diverge', point: [600, 34] },
    ],
    junctions: [],
    serviceAreas: [],
    terrain: [],
  };
}

export function round2(v) { return Math.round(v * 100) / 100; }

export function tmpdir(prefix = 'road-editor-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

export const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

/** In-memory Storage stand-in for EditorState drafts. */
export class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
