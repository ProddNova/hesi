/**
 * Approved progressive-transition set.
 *
 * These are identities and audit metadata, not route-specific geometry.
 * Eligibility is classified from authoritative render/collision deck
 * ownership. The developer map intentionally exposes only the two accepted
 * progressive locations. Under left-hand traffic (the whole network flow is
 * reversed at load — see reverseNetworkData in js/map.js) the two junctions
 * keep their physical locations but swap sense: the historical 2+2
 * progressive diverge at J2 is now driven as a merge (r1_0 -> c1_0), and the
 * J48 2+3 merge is now driven as a diverge (wangan_1 -> ramp_41).
 */
export const PROGRESSIVE_MERGE_PROTOTYPES = Object.freeze([
  Object.freeze({
    pinId: 'P1',
    id: 'J2:merge:c1_0:r1_0:end',
    label: '2+2 progressive merge',
    type: 'merge',
    hostRouteId: 'c1_0',
    branchRouteId: 'r1_0',
    which: 'end',
    pin: Object.freeze({ x: -1094.38, y: 57.33, z: -3014.18 }),
  }),
  Object.freeze({
    pinId: 'P2',
    id: 'J48:diverge:wangan_1:ramp_41:start',
    label: '2+3 progressive diverge',
    type: 'diverge',
    hostRouteId: 'wangan_1',
    branchRouteId: 'ramp_41',
    which: 'start',
    approvedSameLevel: true,
    approvalReason: 'J48 lower-deck pair explicitly approved after rendered/collision deck verification',
    pin: Object.freeze({ x: -8164.3, y: 76.7, z: -24238.6 }),
  }),
]);

export const PROGRESSIVE_MERGE_PROTOTYPE_IDS = new Set(
  PROGRESSIVE_MERGE_PROTOTYPES.map((prototype) => prototype.id),
);
