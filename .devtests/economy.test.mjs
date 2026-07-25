import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateScorePayout, ECONOMY } from '../js/data.js';

test('score payout uses the configured score conversion rate', () => {
  assert.equal(calculateScorePayout(1000), 440);
});

test('run-end payout applies the temporary x5 multiplier', () => {
  assert.equal(ECONOMY.runEndPayoutMultiplier, 5);
  assert.equal(calculateScorePayout(1000, ECONOMY.runEndPayoutMultiplier), 2200);
});

test('score payout never returns negative money', () => {
  assert.equal(calculateScorePayout(-1000, ECONOMY.runEndPayoutMultiplier), 0);
});
