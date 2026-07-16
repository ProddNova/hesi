/** Generic render/collision deck classifier regression for Checkpoint 2. */
import { readFile } from 'node:fs/promises';
import { HighwayMap } from '../js/map.js';
import { PROGRESSIVE_MERGE_PROTOTYPES } from '../js/progressive-merge-prototypes.js';
import { classifyProgressiveJunction } from '../js/progressive-junction-classifier.js';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const map = new HighwayMap(null, { addLighting: false, progressiveMerges: false });
const activeMap = new HighwayMap(null, { addLighting: false, progressiveMerges: true });
const expected = new Map([
  ['P1', 'same-level-simple'],
  ['P2', 'vertical-ramp-complex'],
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
  if (prototype.pinId === 'P1') {
    check(classification.eligible, 'P1: preserved same-level candidate was rejected');
    check(metrics.lateralSeparationReached, 'P1: no measured lateral separation');
    check(metrics.ownershipBreakRows === 0, 'P1: deck ownership breaks before lateral separation');
    check(metrics.collisionDeckOwnership === 'continuous-to-lateral-separation',
      'P1: collision ownership invariant is not continuous');
  } else {
    check(prototype.approvedSameLevel === true, 'P2: missing explicit lower-deck approval');
    check(!classification.eligible, 'P2: measured classifier result unexpectedly changed');
    check(metrics.ownershipBreakRows > 0, `${prototype.pinId}: missing planar-overlap ownership break evidence`);
    check(metrics.collisionDeckOwnership === 'breaks-before-lateral-separation',
      `${prototype.pinId}: incorrect collision ownership invariant`);
    const effective = activeMap.progressiveCandidateClassifications
      .find((candidate) => candidate.id === prototype.id);
    check(effective?.active === true, 'P2: approved transition is not active');
    check(effective?.classification.category === 'same-level-approved',
      'P2: effective approval classification is not transparent');
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
