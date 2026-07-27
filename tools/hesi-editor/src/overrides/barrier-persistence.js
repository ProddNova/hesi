/**
 * Lateral barrier persistence.
 *
 * Barrier styles are pure look, so unlike road centrelines they have no
 * draft/publish split: one save writes data/road-barriers.json (canonical)
 * AND data/road-barriers.js (the module js/map.js imports), and the next world
 * build — game boot or an editor reload — renders them.
 *
 * The catalogue itself lives in js/road-barrier-styles.js and is shared by the
 * game, this editor and the dev server, so a style can never exist on one side
 * of the pipe only.
 */
import {
  BARRIER_STYLES,
  DEFAULT_BARRIER_STYLE_ID,
  blankBarrierDocument,
  canonicalizeBarrierDocument,
  flattenBarrierSpans,
} from '../../../../js/road-barrier-styles.js';

const BARRIERS_ENDPOINT = '/__hesi_editor_barriers';

export function createBarrierPersistence({ onStatus = () => {} } = {}) {
  const responseJson = async (response) => {
    const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Barrier request failed (HTTP ${response.status})`);
    return payload;
  };

  return {
    async load() {
      try {
        const payload = await responseJson(await fetch(BARRIERS_ENDPOINT, { cache: 'no-store' }));
        return canonicalizeBarrierDocument(payload.document || blankBarrierDocument());
      } catch (error) {
        // A missing or unreadable barrier file must not block the editor: the
        // world already rendered with default parapets.
        onStatus(`Barrier styles unavailable: ${error.message}`);
        return blankBarrierDocument();
      }
    },

    async save(document) {
      const payload = await responseJson(await fetch(BARRIERS_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document: canonicalizeBarrierDocument(document) }),
      }));
      onStatus(`Saved barrier styles · ${payload.spanCount} span${payload.spanCount === 1 ? '' : 's'} on ${payload.routes.length} road${payload.routes.length === 1 ? '' : 's'} · reload the editor to preview`);
      return payload;
    },
  };
}

export {
  BARRIER_STYLES,
  DEFAULT_BARRIER_STYLE_ID,
  blankBarrierDocument,
  canonicalizeBarrierDocument,
  flattenBarrierSpans,
};
