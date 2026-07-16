import { HighwayMap } from '../js/map.js';
import { PROGRESSIVE_PHASES } from '../js/progressive-merge.js';
import { PROGRESSIVE_MERGE_PROTOTYPES } from '../js/progressive-merge-prototypes.js';
import { createHash } from 'node:crypto';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const distance = (left, right) => Math.hypot(
  left.x - right.x,
  left.y - right.y,
  left.z - right.z,
);
const P1_ID = 'J2:diverge:c1_0:r1_0:start';
const P2_ID = 'J48:merge:wangan_1:ramp_41:end';

const map = new HighwayMap(null, { addLighting: false });
const legacy = new HighwayMap(null, { addLighting: false, progressiveMerges: false });
check(map.progressiveTransitions.length === 2, `active record count ${map.progressiveTransitions.length} != 2`);
check(legacy.progressiveTransitions.length === 0, `legacy record count ${legacy.progressiveTransitions.length} != 0`);
check(PROGRESSIVE_MERGE_PROTOTYPES.length === 2, 'prototype allow-list is not exactly P1/P2');
check(map.progressiveCandidateClassifications.length === 2, 'candidate classification count is not exactly two');
check(map.progressiveCandidateClassifications.every((candidate) => candidate.active),
  'P1/P2 are not both active');
const p1 = map.progressiveTransitionById.get(P1_ID);
const p1GeometryDigest = createHash('sha256').update(JSON.stringify({
  approachStart: p1.approachStart,
  openingStart: p1.openingStart,
  parallelStart: p1.parallelStart,
  absorptionStart: p1.absorptionStart,
  transitionEnd: p1.transitionEnd,
  topology: p1.topology,
  laneCentres: p1.laneCentres,
  laneBoundaries: p1.laneBoundaries,
  markingPaths: p1.markingPaths,
  pavedEnvelope: p1.pavedEnvelope,
  guardrailEnvelope: p1.guardrailEnvelope,
  laneMappings: p1.laneMappings,
})).digest('hex');
check(p1GeometryDigest === '2779a9ef94a8b556d0a3d85e2493dbc474dc2c8fd4351303b5d797524f88d0a0',
  `P1 geometry changed (${p1GeometryDigest})`);

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
    check(transition.id !== P1_ID
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
    if (transition.id === P2_ID) {
      check(transition.topology === '2+3-merge'
        && transition.hostLaneCount === 3
        && transition.branchLaneCount === 2
        && transition.auxiliaryLaneCount === 2
        && transition.temporaryLaneCount === 5
        && transition.finalLaneCount === 3,
      `${transition.id}: P2 topology is not 2+3 -> 5 -> 4 -> 3`);
      check(transition.firstAbsorptionEnd > transition.absorptionStart
        && transition.secondAbsorptionStart > transition.firstAbsorptionEnd
        && transition.secondAbsorptionStart < transition.transitionEnd,
      `${transition.id}: missing sequential absorption boundary`);
      check(transition.absorptionSteps.length === 2
        && transition.absorptionSteps[0].fromLaneCount === 5
        && transition.absorptionSteps[0].toLaneCount === 4
        && transition.absorptionSteps[1].fromLaneCount === 4
        && transition.absorptionSteps[1].toLaneCount === 3,
      `${transition.id}: absorption sequence is not 5 -> 4 -> 3`);
      check(transition.laneMappings.filter((mapping) => mapping.source.startsWith('branch:')).length === 2
        && transition.laneMappings.filter((mapping) => mapping.source.startsWith('host:'))
          .every((mapping) => mapping.outcome === 'survives'),
      `${transition.id}: branch/host lane mapping changed`);
      check(transition.laneBoundaries.some((path) => path.id === 'aux-divider-boundary'),
        `${transition.id}: missing first-absorption boundary`);
    }
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
check(map.getMinimapData().prototypePins.length === 2, 'minimap does not expose exactly P1/P2');
check(map.getMinimapData().prototypePins.every((pin) => pin.category === 'progressive-prototype'),
  'minimap contains a deferred/obsolete prototype pin');
check(map.getMinimapData().prototypePins.map((pin) => pin.pinId).join(',') === 'P1,P2',
  'minimap pin labels are not exactly P1,P2');
check(map.getMinimapData().prototypePins.find((pin) => pin.pinId === 'P1')?.id === P1_ID,
  'the successful old P4 was not relabelled P1');
check(map.getMinimapData().prototypePins.find((pin) => pin.pinId === 'P2')?.id === P2_ID,
  'P2 is not the approved J48 merge');
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
