/**
 * Checkpoint-2 progressive-transition candidate set.
 *
 * These are identities and audit metadata, not route-specific geometry.
 * Eligibility is classified from authoritative render/collision deck
 * ownership. Keeping the four audited identities in one module gives the
 * developer map stable pins even when a candidate is deferred.
 */
export const PROGRESSIVE_MERGE_PROTOTYPES = Object.freeze([
  Object.freeze({
    pinId: 'P1',
    id: 'J8:merge:r11_0:ramp_1:end',
    label: 'one-to-two merge',
    type: 'merge',
    hostRouteId: 'r11_0',
    branchRouteId: 'ramp_1',
    which: 'end',
    pin: Object.freeze({ x: -1128.45, y: 73.04, z: -3825.43 }),
  }),
  Object.freeze({
    pinId: 'P2',
    id: 'J0:merge:c1_0:c1_3:end',
    label: 'two-to-two merge',
    type: 'merge',
    hostRouteId: 'c1_0',
    branchRouteId: 'c1_3',
    which: 'end',
    pin: Object.freeze({ x: -897.45, y: 52.37, z: -2806.42 }),
  }),
  Object.freeze({
    pinId: 'P3',
    id: 'J10:merge:wangan_1:ramp_3:end',
    label: 'two-to-three merge',
    type: 'merge',
    hostRouteId: 'wangan_1',
    branchRouteId: 'ramp_3',
    which: 'end',
    pin: Object.freeze({ x: 696.08, y: 29.71, z: -5832.86 }),
  }),
  Object.freeze({
    pinId: 'P4',
    id: 'J2:diverge:c1_0:r1_0:start',
    label: 'left-side diverge',
    type: 'diverge',
    hostRouteId: 'c1_0',
    branchRouteId: 'r1_0',
    which: 'start',
    pin: Object.freeze({ x: -1094.38, y: 57.33, z: -3014.18 }),
  }),
]);

export const PROGRESSIVE_MERGE_PROTOTYPE_IDS = new Set(
  PROGRESSIVE_MERGE_PROTOTYPES.map((prototype) => prototype.id),
);
