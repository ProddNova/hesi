/**
 * Checkpoint-1 progressive-transition allow-list.
 *
 * These are identities and audit metadata, not route-specific geometry.
 * Every enabled case is built by the same transition model. Keeping the
 * allow-list in one module makes the limited rollout explicit and reversible.
 */
export const PROGRESSIVE_MERGE_PROTOTYPES = Object.freeze([
  Object.freeze({
    id: 'J8:merge:r11_0:ramp_1:end',
    label: 'one-to-two merge',
    type: 'merge',
    hostRouteId: 'r11_0',
    branchRouteId: 'ramp_1',
    which: 'end',
  }),
  Object.freeze({
    id: 'J0:merge:c1_0:c1_3:end',
    label: 'two-to-two merge',
    type: 'merge',
    hostRouteId: 'c1_0',
    branchRouteId: 'c1_3',
    which: 'end',
  }),
  Object.freeze({
    id: 'J10:merge:wangan_1:ramp_3:end',
    label: 'two-to-three merge',
    type: 'merge',
    hostRouteId: 'wangan_1',
    branchRouteId: 'ramp_3',
    which: 'end',
  }),
  Object.freeze({
    id: 'J2:diverge:c1_0:r1_0:start',
    label: 'right-side diverge',
    type: 'diverge',
    hostRouteId: 'c1_0',
    branchRouteId: 'r1_0',
    which: 'start',
  }),
]);

export const PROGRESSIVE_MERGE_PROTOTYPE_IDS = new Set(
  PROGRESSIVE_MERGE_PROTOTYPES.map((prototype) => prototype.id),
);

