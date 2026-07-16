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
check(map.progressiveTransitions.length === 1, `active record count ${map.progressiveTransitions.length} != 1`);
check(legacy.progressiveTransitions.length === 0, `legacy record count ${legacy.progressiveTransitions.length} != 0`);
check(PROGRESSIVE_MERGE_PROTOTYPES.length === 4, 'prototype allow-list is not exactly four');
check(map.progressiveCandidateClassifications.length === 4, 'candidate classification count is not exactly four');
check(map.progressiveCandidateClassifications.filter((candidate) => !candidate.active).length === 3,
  'expected exactly three deferred candidates');

for (const transition of map.progressiveTransitions) {
  check(PROGRESSIVE_PHASES.every((phase, index) => transition.phaseOrder[index] === phase), `${transition.id}: phase order`);
  check(transition.approachStart < transition.openingStart
    && transition.openingStart < transition.parallelStart
    && transition.parallelStart < transition.absorptionStart
    && transition.absorptionStart < transition.transitionEnd, `${transition.id}: non-monotonic phases`);
  check(transition.length >= 100, `${transition.id}: transition only ${transition.length.toFixed(1)} m`);
  check(transition.temporaryLaneCount === transition.hostLaneCount + transition.auxiliaryLaneCount,
    `${transition.id}: temporary lane count`);
  check(transition.finalLaneCount === (transition.type === 'diverge'
    ? transition.hostLaneCount + transition.branchLaneCount
    : transition.hostLaneCount), `${transition.id}: final lane count`);
  if (transition.type === 'diverge') {
    check(transition.id !== 'J2:diverge:c1_0:r1_0:start'
      || (transition.topology === '2+2-diverge'
        && transition.auxiliaryLaneCount === 2
        && transition.temporaryLaneCount === 4),
    `${transition.id}: P4 is not an explicit temporary 2+2 diverge`);
    check(transition.branchFeedLane === 0, `${transition.id}: hostward branch feed lane`);
    check(transition.branchLaneCentres.length === transition.branchLaneCount,
      `${transition.id}: explicit branch lane-centre count`);
    check(transition.alignmentStart < transition.physicalSplitStart
      && transition.physicalSplitStart <= transition.goreStart,
    `${transition.id}: source-derived diverge landmarks`);
  }
  check(transition.laneCentres.length === transition.temporaryLaneCount, `${transition.id}: lane-centre path count`);
  check(transition.laneMappings.length >= transition.hostLaneCount + 1, `${transition.id}: incomplete lane mappings`);
  check(transition.markingOwnership.every((boundary) => boundary.owner), `${transition.id}: ownerless boundary record`);
  check(Number.isFinite(transition.pin.x + transition.pin.y + transition.pin.z), `${transition.id}: invalid developer-map pin`);
  check(transition.pavedEnvelope.length > 40, `${transition.id}: sparse paved envelope`);
  check(transition.crossableEnvelope.length > 20, `${transition.id}: sparse crossable envelope`);
  const first = transition.pavedEnvelope[0];
  const last = transition.pavedEnvelope.at(-1);
  check(first.extraWidth < 1e-6, `${transition.id}: transition does not begin at base width`);
  if (transition.type === 'diverge') {
    check(last.extraWidth >= transition.auxiliaryTotalWidth,
      `${transition.id}: host envelope closes before branch ownership`);
    check(transition.goreStart >= transition.transferComplete - 0.01,
      `${transition.id}: gore begins before lane transfer`);
    check(transition.auxiliaryCorridor.length > 20,
      `${transition.id}: missing explicit auxiliary corridor sections`);
    const expectedMarkedWidth = Math.min(
      transition.sourceZone.host.laneWidth
        + Math.max(0, transition.sourceZone.host.shoulder - 0.75),
      transition.sourceZone.branch.laneWidth
        + Math.max(0, transition.sourceZone.branch.shoulder - 0.75),
    );
    check(Math.abs(transition.auxiliaryMarkedWidth - expectedMarkedWidth) <= 0.01,
      `${transition.id}: auxiliary marked width ${transition.auxiliaryMarkedWidth.toFixed(2)} m`
        + ` != normal outer-lane width ${expectedMarkedWidth.toFixed(2)} m`);
    check(Math.abs(transition.targetExtraWidth - transition.auxiliaryTotalWidth) <= 0.01,
      `${transition.id}: widened envelope does not match explicit auxiliary topology`);
    check(transition.laneBoundaries.some((path) => path.id === 'aux-inner-boundary')
      && transition.laneBoundaries.some((path) => path.id === 'aux-divider-boundary')
      && transition.laneBoundaries.some((path) => path.id === 'aux-outer-boundary'),
    `${transition.id}: missing explicit 2-lane exit boundaries`);
    check(transition.markingPaths.some((path) => path.id === 'aux-divider-marking'),
      `${transition.id}: missing transition-owned exit divider`);
    check(transition.auxiliaryLaneCorridors.length === transition.auxiliaryLaneCount,
      `${transition.id}: missing per-lane exit corridors`);
  } else {
    check(last.extraWidth < 1e-6, `${transition.id}: merge width does not finalize at base`);
  }
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
check(map.getMinimapData().prototypePins.length === 4, 'minimap does not expose exactly four prototype pins');
check(map.getMinimapData().prototypePins.filter((pin) => pin.category === 'progressive-prototype').length === 1,
  'minimap does not expose exactly one active prototype');
check(map.getMinimapData().prototypePins.filter((pin) => pin.category === 'deferred-progressive-candidate').length === 3,
  'minimap does not expose exactly three deferred candidates');
check(map.getMinimapData().prototypePins.find((pin) => pin.pinId === 'P4')?.side === 'left',
  'P4 is not labelled from the driver-relative lateral convention');
check(legacy.getMinimapData().prototypePins.length === 0, 'legacy minimap exposes prototype pins');

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
