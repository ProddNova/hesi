import { HighwayMap } from '../js/map.js';
import { PROGRESSIVE_PHASES } from '../js/progressive-merge.js';
import { PROGRESSIVE_MERGE_PROTOTYPES } from '../js/progressive-merge-prototypes.js';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const distance = (left, right) => Math.hypot(
  left.x - right.x,
  left.y - right.y,
  left.z - right.z,
);

const map = new HighwayMap(null, { addLighting: false });
const legacy = new HighwayMap(null, { addLighting: false, progressiveMerges: false });
check(map.progressiveTransitions.length === 4, `active record count ${map.progressiveTransitions.length} != 4`);
check(legacy.progressiveTransitions.length === 0, `legacy record count ${legacy.progressiveTransitions.length} != 0`);
check(PROGRESSIVE_MERGE_PROTOTYPES.length === 4, 'prototype allow-list is not exactly four');

for (const transition of map.progressiveTransitions) {
  check(PROGRESSIVE_PHASES.every((phase, index) => transition.phaseOrder[index] === phase), `${transition.id}: phase order`);
  check(transition.approachStart < transition.openingStart
    && transition.openingStart < transition.parallelStart
    && transition.parallelStart < transition.absorptionStart
    && transition.absorptionStart < transition.transitionEnd, `${transition.id}: non-monotonic phases`);
  check(transition.length >= 100, `${transition.id}: transition only ${transition.length.toFixed(1)} m`);
  check(transition.temporaryLaneCount === transition.hostLaneCount + 1, `${transition.id}: temporary lane count`);
  check(transition.finalLaneCount === transition.hostLaneCount, `${transition.id}: final lane count`);
  check(transition.laneCentres.length === transition.temporaryLaneCount, `${transition.id}: lane-centre path count`);
  check(transition.laneMappings.length >= transition.hostLaneCount + 1, `${transition.id}: incomplete lane mappings`);
  check(transition.markingOwnership.every((boundary) => boundary.owner), `${transition.id}: ownerless boundary record`);
  check(transition.pavedEnvelope.length > 40, `${transition.id}: sparse paved envelope`);
  check(transition.crossableEnvelope.length > 20, `${transition.id}: sparse crossable envelope`);
  const first = transition.pavedEnvelope[0];
  const last = transition.pavedEnvelope.at(-1);
  check(first.extraWidth < 1e-6 && last.extraWidth < 1e-6, `${transition.id}: width does not finalize at base`);
  check(transition.pavedEnvelope.some((row) => row.extraWidth >= transition.auxiliaryWidth), `${transition.id}: no usable auxiliary width`);
  for (const lane of transition.laneCentres) {
    check(lane.points.length === transition.pavedEnvelope.length, `${transition.id}/${lane.id}: discontinuous sample count`);
    for (let index = 1; index < lane.points.length; index += 1) {
      const step = distance(lane.points[index - 1].position, lane.points[index].position);
      check(step < 4, `${transition.id}/${lane.id}: ${step.toFixed(2)} m lane step`);
    }
  }
  for (const row of transition.pavedEnvelope) {
    check(row.lateralMin < row.lateralMax, `${transition.id}: inverted envelope at ${row.hostS}`);
  }
}

console.log(`records=${map.progressiveTransitions.length} legacy=${legacy.progressiveTransitions.length}`);
console.log(map.progressiveTransitions.map((transition) => (
  `${transition.id} ${transition.type} ${transition.side} ${transition.hostLaneCount}+${transition.branchLaneCount}`
  + ` -> temporary ${transition.temporaryLaneCount} -> final ${transition.finalLaneCount}`
  + ` length=${transition.length.toFixed(1)}m`
)).join('\n'));
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`PROGRESSIVE MERGE MODEL PROBE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('PROGRESSIVE MERGE MODEL PROBE: PASS');
}
