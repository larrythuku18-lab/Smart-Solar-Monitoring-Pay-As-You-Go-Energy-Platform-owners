/**
 * Unit tests for appliances.js — the pure heavy-usage classification logic
 * behind the owner appliance monitor upgrade. No DB or server involved:
 * these exercise classifyApplianceUsage() directly against fixed inputs.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  APPLIANCE_CATEGORIES,
  effectiveWattage,
  classifyApplianceUsage
} = require('../appliances');

describe('effectiveWattage', () => {
  test('uses the owner-entered rated_wattage when present', () => {
    assert.equal(effectiveWattage({ rated_wattage: 500, category: 'other' }), 500);
  });

  test('falls back to the category typical wattage when unset', () => {
    assert.equal(effectiveWattage({ rated_wattage: null, category: 'fridge' }), 150);
  });

  test('falls back to "other" for an unknown category', () => {
    assert.equal(effectiveWattage({ rated_wattage: null, category: 'spaceship' }), 200);
  });

  test('ignores a non-positive rated_wattage and falls back to category', () => {
    assert.equal(effectiveWattage({ rated_wattage: 0, category: 'fan' }), 75);
    assert.equal(effectiveWattage({ rated_wattage: -10, category: 'fan' }), 75);
  });
});

describe('classifyApplianceUsage', () => {
  test('flags an appliance whose share of average consumption is high', () => {
    const [result] = classifyApplianceUsage(
      [{ id: 1, name: 'Water Pump', category: 'pump', rated_wattage: 750 }],
      1000 // avg consumption — 750/1000 = 75% share
    );
    assert.equal(result.heavy, true);
    assert.equal(result.estimatedSharePct, 75);
    assert.match(result.reason, /75%/);
  });

  test('flags a large absolute load even with a low share', () => {
    const [result] = classifyApplianceUsage(
      [{ id: 1, name: 'Water Heater', category: 'heater', rated_wattage: 2000 }],
      20000 // 2000/20000 = 10% share — not flagged by share alone
    );
    assert.equal(result.heavy, true);
    assert.match(result.reason, /large load on its own/);
  });

  test('does not flag a small appliance with a small share', () => {
    const [result] = classifyApplianceUsage(
      [{ id: 1, name: 'Fridge', category: 'fridge', rated_wattage: 150 }],
      1000
    );
    assert.equal(result.heavy, false);
    assert.equal(result.reason, null);
  });

  test('handles a null average consumption (new device, no history)', () => {
    const [normal, heavy] = classifyApplianceUsage(
      [
        { id: 1, name: 'Fridge', category: 'fridge', rated_wattage: null },
        { id: 2, name: 'Heater', category: 'heater', rated_wattage: null }
      ],
      null
    );
    assert.equal(normal.estimatedSharePct, null);
    assert.equal(normal.heavy, false); // 150W fridge default — below absolute threshold
    assert.equal(heavy.heavy, true);   // 2000W heater default — above absolute threshold
  });

  test('marks wattage as estimated when no rated_wattage was entered', () => {
    const [result] = classifyApplianceUsage(
      [{ id: 1, name: 'Lighting', category: 'lighting', rated_wattage: null }],
      1000
    );
    assert.equal(result.isEstimatedWattage, true);
    assert.equal(result.effectiveWattage, 60);
  });

  test('every declared category has a positive typical wattage', () => {
    for (const category of APPLIANCE_CATEGORIES) {
      const watts = effectiveWattage({ rated_wattage: null, category });
      assert.ok(watts > 0, `category "${category}" must map to a positive wattage`);
    }
  });
});
