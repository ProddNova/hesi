/** Generic render/collision deck classifier regression for Checkpoint 2. */
import { readFile } from 'node:fs/promises';
import { HighwayMap } from '../js/map.js';
import { PROGRESSIVE_MERGE_PROTOTYPES } from '../js/progressive-merge-prototypes.js';
import { classifyProgressiveJunction } from '../js/progressive-junction-classifier.js';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const map = new HighwayMap(null, { addLighting: false, progressiveMerges: false });
const expected = new Map([
  ['P1', 'vertical-ramp-complex'],
  ['P2', 'vertical-ramp-complex'],
  ['P3', 'vertical-ramp-complex'],
  ['P4', 'same-level-simple'],
]);

const source = await readFile(new URL('../js/progressive-junction-classifier.js', import.meta.url), 'utf8');
for (const prototype of PROGRESSIVE_MERGE_PROTOTYPES) {
  check(!source.includes(prototype.id), `${prototype.pinId}: classifier hard-codes the junction ID`);
  const zone = map.junctionZones.find((candidate) => candidate.id === prototype.id);
  check(!!zone, `${prototype.pinId}: candidate zone is missing`);
  if (!zone) continue;
  const classification = classifyProgressiveJunction(map, zone);
  const metrics = classification.metrics;
  check(classification.category === expected.get(prototype.pinId),
    `${prototype.pinId}: ${classification.category} != ${expected.get(prototype.pinId)}`);
  check(metrics.transferConnected === true, `${prototype.pinId}: transfer deck is not connected`);
  check(Number.isFinite(metrics.planarOverlapLength), `${prototype.pinId}: invalid overlap length`);
  check(Number.isFinite(metrics.maximumVerticalDeckSeparation), `${prototype.pinId}: invalid deck separation`);
  if (prototype.pinId === 'P4') {
    check(classification.eligible, 'P4: same-level candidate was rejected');
    check(metrics.lateralSeparationReached, 'P4: no measured lateral separation');
    check(metrics.ownershipBreakRows === 0, 'P4: deck ownership breaks before lateral separation');
    check(metrics.collisionDeckOwnership === 'continuous-to-lateral-separation',
      'P4: collision ownership invariant is not continuous');
  } else {
    check(!classification.eligible, `${prototype.pinId}: vertical candidate was enabled`);
    check(metrics.ownershipBreakRows > 0, `${prototype.pinId}: missing planar-overlap ownership break evidence`);
    check(metrics.collisionDeckOwnership === 'breaks-before-lateral-separation',
      `${prototype.pinId}: incorrect collision ownership invariant`);
  }
  console.log(`${prototype.pinId} ${prototype.id}: ${classification.category}`
    + ` ownership=${metrics.collisionDeckOwnership} overlap=${metrics.planarOverlapLength}m`);
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  console.error(`PROGRESSIVE JUNCTION CLASSIFICATION PROBE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('PROGRESSIVE JUNCTION CLASSIFICATION PROBE: PASS');
}
