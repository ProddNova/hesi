import test from 'node:test';
import assert from 'node:assert/strict';
import { HighwayMap } from '../../../../js/map.js';

function createMaterials() {
  return HighwayMap.prototype._createMaterials.call({
    _facadeTexture: () => null,
    _waterTexture: () => null,
    _chevronTexture: () => null,
    _glowTexture: () => null,
  });
}

test('road markings react to scene and vehicle lights', () => {
  const materials = createMaterials();
  try {
    for (const name of ['marking', 'amber']) {
      const material = materials[name];
      assert.equal(material.isMeshLambertMaterial, true, `${name} uses a lit material`);
      assert.equal(material.isMeshBasicMaterial, undefined, `${name} is not self-lit`);
      assert.equal(material.emissive.getHex(), 0, `${name} has no emissive floor`);
      assert.equal(material.toneMapped, true, `${name} follows scene exposure`);
    }

    assert.equal(materials.lampSodium.isMeshBasicMaterial, true,
      'actual lamp lenses remain intentionally self-lit');
  } finally {
    for (const material of Object.values(materials)) material.dispose();
  }
});
