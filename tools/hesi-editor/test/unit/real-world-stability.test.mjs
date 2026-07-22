import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HighwayMap } from '../../../../js/map.js';
import ROUTE_DATA from '../../../../data/routes-smoothed.js';
import { discoverHesiEntities } from '../../src/world/entity-discovery.js';
import { EDITOR_LAYERS } from '../../src/entity-registry.js';

function crashCushionSnapshot(map) {
  const snapshot = { total: 0, visible: 0 };
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  map.group.traverse((object) => {
    if (!object.isInstancedMesh || !object.name.endsWith('box:cushion')) return;
    snapshot.total += object.count;
    for (let index = 0; index < object.count; index += 1) {
      object.getMatrixAt(index, matrix);
      matrix.decompose(position, quaternion, scale);
      if (scale.lengthSq() > 1e-12) snapshot.visible += 1;
    }
  });
  return snapshot;
}

function buildIdentitySnapshot() {
  const map = new HighwayMap({ quality: 'low', applyFog: false });
  try {
    const discovery = discoverHesiEntities(map);
    const tatsumiExit = map.routes.get('tatsumi_pa_exit');
    const editedExitPoints = tatsumiExit?.points.map((point) => point.toArray()) || [];
    if (editedExitPoints.length > 2) editedExitPoints[1][0] += 0.75;
    const exitEndpointBefore = tatsumiExit?.points.at(-1).clone();
    const syntheticPreviewApplied = map.applyEditorRouteOverride('tatsumi_pa_exit', editedExitPoints);
    const productionMatch = ROUTE_DATA.routes.find((sourceRoute) => {
      const runtimeRoute = map.routes.get(sourceRoute.id);
      return runtimeRoute && runtimeRoute.points.length === sourceRoute.points.length;
    });
    const productionRuntime = productionMatch && map.routes.get(productionMatch.id);
    return {
      ids: discovery.entities.map((entity) => entity.id),
      layers: discovery.layerCounts,
      gameplayStarted: Boolean(globalThis.shutoko),
      roadNetworkYOffset: map.roadNetworkYOffset,
      crashCushions: crashCushionSnapshot(map),
      productionYOffset: productionMatch
        ? productionRuntime.points[0].y - productionMatch.points.at(-1)[1]
        : null,
      tatsumiExit: {
        exists: Boolean(tatsumiExit),
        synthetic: Boolean(tatsumiExit?.synthetic),
        discovered: discovery.entities.some((entity) => entity.metadata?.routeId === 'tatsumi_pa_exit'),
        previewApplied: syntheticPreviewApplied,
        changed: Math.abs((tatsumiExit?.points[1]?.x || 0) - (editedExitPoints[1]?.[0] || 0)) < 1e-6,
        endpointPreserved: Boolean(exitEndpointBefore?.distanceTo(tatsumiExit?.points.at(-1)) < 1e-6),
        samplesRebuilt: Boolean(tatsumiExit?.samples.length > 2 && Number.isFinite(tatsumiExit.length)),
      },
    };
  } finally {
    map.dispose();
  }
}

test('two independent real-world builds produce identical stable entity IDs and layer counts', { timeout: 60000 }, () => {
  const first = buildIdentitySnapshot();
  const second = buildIdentitySnapshot();
  assert.deepEqual(second.ids, first.ids);
  assert.deepEqual(second.layers, first.layers);
  assert.equal(new Set(first.ids).size, first.ids.length, 'all generated IDs are unique');
  assert.ok(first.ids.includes('lamp:wangan-0:0042'), 'known real Wangan lamp ID is discoverable');
  assert.ok(EDITOR_LAYERS.every((layer) => first.layers[layer] > 0), 'every truthful semantic layer is populated');
  assert.equal(first.roadNetworkYOffset, 25, 'editor exposes the production road elevation offset');
  assert.ok(first.crashCushions.total > 0, 'removed crash cushions keep ID-preserving tombstones');
  assert.equal(first.crashCushions.visible, 0, 'yellow crash cushions stay removed from the rendered road');
  assert.ok(Math.abs(first.productionYOffset - first.roadNetworkYOffset) < 1e-6,
    'production route controls can be placed at the runtime road/collision elevation');
  assert.deepEqual(first.tatsumiExit, {
    exists: true,
    synthetic: true,
    discovered: true,
    previewApplied: true,
    changed: true,
    endpointPreserved: true,
    samplesRebuilt: true,
  });
  assert.equal(first.gameplayStarted, false);
  assert.equal(second.gameplayStarted, false);
});
