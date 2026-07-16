/**
 * Ratchet for the exhaustive P2 same-level 2+2 candidate decision.
 *
 * Run the audit first, then:
 *   node .devtests/progressive-merge-p2-candidate-probe.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const auditPath = fileURLToPath(new URL('./progressive-merge-audit.json', import.meta.url));
const audit = JSON.parse(await readFile(auditPath, 'utf8'));
const candidates = audit.connections.filter((connection) => (
  connection.type === 'merge'
  && connection.hostLaneCount === 2
  && connection.branchLaneCount === 2
));

const EXPECTED_IDS = [
  'J0:merge:c1_0:c1_3:end',
  'J1:merge:c1_2:c1_6:end',
  'J5:merge:c1_0:r6_3:end',
  'J16:merge:r1_3:ramp_10:end',
  'J33:merge:r6_0:ramp_22:end',
];
assert.deepEqual(candidates.map((candidate) => candidate.id), EXPECTED_IDS,
  'the exhaustive 2+2 merge candidate set drifted');
assert.equal(audit.summary.p2Decision, 'no-valid-candidate');
assert.deepEqual(audit.summary.validP2CandidateIds, []);
assert.equal(audit.summary.p2TwoPlusTwoMergeCandidates.length, EXPECTED_IDS.length);

for (const candidate of candidates) {
  assert.equal(candidate.progressiveDeckClassification.eligible, false,
    `${candidate.id} unexpectedly passed the same-deck gate`);
  assert.equal(candidate.trafficDirection.branch.includes('increasing chainage'), true,
    `${candidate.id} is not reported in actual merge travel direction`);
  assert.ok(candidate.availableApproachLength > 0);
  assert.ok(candidate.possibleParallelLength > 0);
  assert.ok(candidate.availableLaneAbsorptionLength >= 0);
  assert.ok(candidate.finalHostWidth >= 9);
  assert.ok(candidate.interactionProfile.length >= 8);
  for (let index = 1; index < candidate.interactionProfile.length; index += 1) {
    assert.ok(
      candidate.interactionProfile[index].branchStation
        >= candidate.interactionProfile[index - 1].branchStation,
      `${candidate.id} profile is not ordered toward the end merge`,
    );
  }
  const ranked = audit.summary.p2TwoPlusTwoMergeCandidates
    .find((entry) => entry.id === candidate.id);
  assert.ok(ranked?.rejectionReasons.length,
    `${candidate.id} has no explicit rejection evidence`);
}

assert.deepEqual(
  audit.summary.p2TwoPlusTwoMergeCandidates.map((candidate) => candidate.id),
  [
    'J5:merge:c1_0:r6_3:end',
    'J1:merge:c1_2:c1_6:end',
    'J0:merge:c1_0:c1_3:end',
    'J33:merge:r6_0:ramp_22:end',
    'J16:merge:r1_3:ramp_10:end',
  ],
  'candidate evidence ranking drifted',
);
assert.deepEqual(audit.summary.activePrototypeIds, ['J2:diverge:c1_0:r1_0:start'],
  'validated diverge active state changed during a report-only task');

console.log('PASS P2 candidate gate: 5 exhaustive 2+2 merges, 0 valid same-level candidates');
for (const candidate of audit.summary.p2TwoPlusTwoMergeCandidates) {
  console.log(`${candidate.rank}. ${candidate.id}: ${candidate.rejectionReasons.join('; ')}`);
}
