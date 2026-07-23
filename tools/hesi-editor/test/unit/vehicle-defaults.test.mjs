import test from 'node:test';
import assert from 'node:assert/strict';
import * as Data from '../../../../js/data.js';
import { DEFAULT_PSX_CAR_ID, getPSXCarModel } from '../../../../js/psx-car-pack.js';

test('Japan Sedan is the only playable starter car and default PSX model', () => {
  assert.equal(Data.CARS.length, 1);
  assert.equal(Data.CARS[0].id, Data.STARTER_CAR_ID);
  assert.equal(Data.CARS[0].name, 'Japan Sedan');
  assert.deepEqual(Object.keys(Data.CAR_BY_ID), [Data.STARTER_CAR_ID]);
  assert.equal(DEFAULT_PSX_CAR_ID, 'JapanSedan');
  assert.equal(getPSXCarModel().label, 'Japan Sedan');
});
