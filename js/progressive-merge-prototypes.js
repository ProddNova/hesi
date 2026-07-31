/**
 * Approved progressive-transition set.
 *
 * These are identities and audit metadata, not route-specific geometry.
 * Eligibility is classified from authoritative render/collision deck
 * ownership.
 *
 * `flow` records which network sense a record was engineered against.
 * `reverseNetworkData` (js/map.js) flips every junction sense for left-hand
 * traffic, so a record is only valid in the flow whose junction ID it names:
 * P1/P2 are the original pre-reversal pair and stay bound to `legacyFlow`,
 * while P3 is authored directly against the live left-hand network.
 */
export const PROGRESSIVE_MERGE_PROTOTYPES = Object.freeze([
  Object.freeze({
    pinId: 'P1',
    id: 'J2:diverge:c1_0:r1_0:start',
    label: '2+2 progressive diverge',
    flow: 'legacy',
    type: 'diverge',
    hostRouteId: 'c1_0',
    branchRouteId: 'r1_0',
    which: 'start',
    pin: Object.freeze({ x: -1094.38, y: 57.33, z: -3014.18 }),
  }),
  Object.freeze({
    pinId: 'P2',
    id: 'J48:merge:wangan_1:ramp_41:end',
    label: '2+3 progressive merge',
    flow: 'legacy',
    type: 'merge',
    topology: '2+3-merge',
    hostRouteId: 'wangan_1',
    branchRouteId: 'ramp_41',
    which: 'end',
    approvedSameLevel: true,
    approvalReason: 'J48 lower-deck pair explicitly approved after rendered/collision deck verification',
    pin: Object.freeze({ x: -8164.3, y: 76.7, z: -24238.6 }),
  }),
  Object.freeze({
    pinId: 'P3',
    id: 'J13:merge:wangan_0:ramp_8:end',
    label: 'Tatsumi PA ramp 2+3 progressive merge',
    flow: 'live',
    type: 'merge',
    topology: '2+3-merge',
    hostRouteId: 'wangan_0',
    branchRouteId: 'ramp_8',
    which: 'end',
    // No explicit approval: once the branch is anchored alongside instead of
    // across, the generic classifier measures a continuous same-level deck all
    // the way to lateral separation and admits J13 on its own evidence.
    // The branch arrives on lanes APPENDED outside the Wangan's paved edge
    // instead of being glued onto its outer lane pair. Ramp 8's source
    // alignment dives straight across the mainline, so the host-lane glue line
    // left the model only 4.7 m to hand a rigid 7.10 m carriageway over — the
    // hard diagonal join. P2 keeps the host-lane glue it was measured with.
    branchAnchor: 'appended',
    pin: Object.freeze({ x: 3150.58, y: 48.41, z: -4244.33 }),
  }),
  Object.freeze({
    pinId: 'P4',
    id: 'J38:diverge:wangan_0:ramp_30:start',
    label: 'Wangan 3+2 progressive diverge',
    flow: 'live',
    type: 'diverge',
    topology: '3+2-diverge',
    hostRouteId: 'wangan_0',
    branchRouteId: 'ramp_30',
    which: 'start',
    // The exact inverse of P3 on the same three-lane Wangan carriageway: the
    // mainline opens two extra lanes OUTSIDE its paved edge one at a time
    // (3 -> 4 -> 5), holds them, and the ramp leaves as a rigid two-lane
    // carriageway off those appended slots. `appended` is what makes that
    // possible — the host-lane glue line would start the ramp on the Wangan's
    // own outer lanes and turn the exit back into a diagonal cut across the
    // mainline.
    branchAnchor: 'appended',
    pin: Object.freeze({ x: 1701.81, y: 32.87, z: -5140.93 }),
  }),
  Object.freeze({
    pinId: 'P5',
    id: 'J39:merge:ramp_3:ramp_30:end',
    label: 'R11 Daiba 2+2 progressive merge',
    flow: 'live',
    type: 'merge',
    topology: '2+2-merge',
    hostRouteId: 'ramp_3',
    branchRouteId: 'ramp_30',
    which: 'end',
    // P3's model on a two-lane host: ramp 30 arrives on two lanes APPENDED
    // outside ramp 3's paved edge (4 lanes), and they are closed one at a time
    // (4 -> 3 -> 2) before the joined carriageway continues as R11. The
    // junction itself is created by `applyContinuationMerges` (js/map.js) —
    // OSM records both ramps as continuing into R11 and nothing between them.
    branchAnchor: 'appended',
    // The parallel run here is ~200 m, not the Wangan's 400: the default blend
    // would derive its alignment from the host over more than a third of the
    // whole ramp and drag its approach tens of metres off the OSM curve.
    branchBlendLength: 240,
    // Ramp 30's tail is cut where the parallel run starts, so its data heights
    // stop describing anything at the glue line: ramp 3 is banked there and its
    // deck 7.10 m out is 0.4-0.8 m above its centreline. The appended slots are
    // that deck, so the tail rides it.
    branchDeckFollowsHost: true,
    pin: Object.freeze({ x: 1170.3, y: 27.2, z: -5298.9 }),
  }),
]);

export const PROGRESSIVE_MERGE_PROTOTYPE_IDS = new Set(
  PROGRESSIVE_MERGE_PROTOTYPES.map((prototype) => prototype.id),
);

/**
 * The prototype subset whose junction identities exist in the requested flow.
 * A record engineered for the other sense is not merely inactive there: its
 * junction ID does not exist, and the builder throws on a missing zone.
 */
export function progressiveMergePrototypesForFlow(legacyFlow) {
  const flow = legacyFlow === true ? 'legacy' : 'live';
  return PROGRESSIVE_MERGE_PROTOTYPES.filter((prototype) => prototype.flow === flow);
}
