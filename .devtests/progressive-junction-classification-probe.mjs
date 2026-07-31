/** Generic render/collision deck classifier regression for Checkpoint 2. */
import { readFile } from 'node:fs/promises';
import { HighwayMap } from '../js/map.js';
import { progressiveMergePrototypesForFlow } from '../js/progressive-merge-prototypes.js';
import { classifyProgressiveJunction } from '../js/progressive-junction-classifier.js';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const map = new HighwayMap(null, { addLighting: false, legacyFlow: true, progressiveMerges: false });
const activeMap = new HighwayMap(null, { addLighting: false, legacyFlow: true, progressiveMerges: true });
// P3 is authored against the live left-hand network, so its junction ID does
// not exist in the legacy-flow maps built above; it is graded separately below.
const legacyPrototypes = progressiveMergePrototypesForFlow(true);
const expected = new Map([
  ['P1', 'same-level-simple'],
  ['P2', 'vertical-ramp-complex'],
]);

const source = await readFile(new URL('../js/progressive-junction-classifier.js', import.meta.url), 'utf8');
for (const prototype of legacyPrototypes) {
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

// Live-flow records: the same measured classifier, the same explicit-approval
// contract. P3's Tatsumi ramp/Wangan decks are level at transfer, so its
// approval must stay transparent rather than silently reclassifying the source.
const liveMap = new HighwayMap(null, { addLighting: false, progressiveMerges: true });
for (const prototype of progressiveMergePrototypesForFlow(false)) {
  const zone = liveMap.junctionZones.find((candidate) => candidate.id === prototype.id);
  check(!!zone, `${prototype.pinId}: live-flow candidate zone is missing`);
  if (!zone) continue;
  const measured = classifyProgressiveJunction(liveMap, zone);
  const effective = liveMap.progressiveCandidateClassifications
    .find((candidate) => candidate.id === prototype.id);
  check(effective?.active === true, `${prototype.pinId}: approved transition is not active`);
  if (measured.eligible) {
    check(!prototype.approvedSameLevel,
      `${prototype.pinId}: carries an explicit approval it does not need`);
  } else {
    check(prototype.approvedSameLevel === true,
      `${prototype.pinId}: ineligible measurement without an explicit approval`);
    check(effective?.classification.category === 'same-level-approved',
      `${prototype.pinId}: effective approval classification is not transparent`);
    check(effective?.classification.measuredCategory === measured.category,
      `${prototype.pinId}: approval hides the measured category`);
  }
  check(measured.metrics.transferConnected === true,
    `${prototype.pinId}: transfer deck is not connected`);
  console.log(`${prototype.pinId} ${prototype.id}: ${measured.category}`
    + ` ownership=${measured.metrics.collisionDeckOwnership}`
    + ` overlap=${measured.metrics.planarOverlapLength}m`
    + ` maxDeckSeparation=${measured.metrics.maximumVerticalDeckSeparation}m`);
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  console.error(`PROGRESSIVE JUNCTION CLASSIFICATION PROBE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('PROGRESSIVE JUNCTION CLASSIFICATION PROBE: PASS');
}
