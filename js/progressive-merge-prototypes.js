/**
 * Approved progressive-transition set.
 *
 * These are identities and audit metadata, not route-specific geometry.
 * Eligibility is classified from authoritative render/collision deck
 * ownership. The developer map intentionally exposes only the two accepted
 * progressive locations: the proven diverge (P1) and its 2+3 merge inverse
 * at J48 (P2).
 */
export const PROGRESSIVE_MERGE_PROTOTYPES = Object.freeze([
  Object.freeze({
    pinId: 'P1',
    id: 'J2:diverge:c1_0:r1_0:start',
    label: '2+2 progressive diverge',
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
    type: 'merge',
    hostRouteId: 'wangan_1',
    branchRouteId: 'ramp_41',
    which: 'end',
    approvedSameLevel: true,
    approvalReason: 'J48 lower-deck pair explicitly approved after rendered/collision deck verification',
    pin: Object.freeze({ x: -8164.3, y: 76.7, z: -24238.6 }),
  }),
]);

export const PROGRESSIVE_MERGE_PROTOTYPE_IDS = new Set(
  PROGRESSIVE_MERGE_PROTOTYPES.map((prototype) => prototype.id),
);
