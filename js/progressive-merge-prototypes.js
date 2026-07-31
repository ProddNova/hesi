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
