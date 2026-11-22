import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const context = {};
runInNewContext(await readFile(new URL('../assets/follower-tiers.js', import.meta.url), 'utf8'), context);
const rules = context.FikratakFollowerTiers;

test('canonical follower tiers match the agreed inclusive boundaries', () => {
  assert.deepEqual([...rules.tiers], ['Nano', 'Micro', 'Macro', 'Semi Mega', 'Mega']);
  assert.equal(rules.minimumFollowers, 0);
  assert.deepEqual([...rules.thresholds], [10000, 100000, 500000, 1000000]);
  for (const [count, tier] of [
    [0, 'Nano'], [999, 'Nano'], [1000, 'Nano'], [9999, 'Nano'], [10000, 'Micro'], [99999, 'Micro'],
    [100000, 'Macro'], [499999, 'Macro'], [500000, 'Semi Mega'], [999999, 'Semi Mega'],
    [1000000, 'Mega']
  ]) assert.equal(rules.classify(count), tier, `${count} followers`);
});

test('missing and malformed counts stay unclassified; localized numbers parse', () => {
  for (const value of ['', null, undefined, 'unknown']) assert.equal(rules.classify(value), '');
  assert.equal(rules.classify('0.9K'), 'Nano');
  assert.equal(rules.classify('٥٠٬٠٠٠'), 'Micro');
  assert.equal(rules.classify('1.5M'), 'Mega');
  assert.equal(rules.highest(['50K', '500K', '999']), 'Semi Mega');
  assert.equal(rules.highest(['0', 'missing']), 'Nano');
  assert.equal(rules.highest(['missing']), '');
});

test('tier thresholds are fixed and cannot be changed from stale settings', () => {
  assert.equal(rules.validateThresholds([10000, 100000, 500000, 1000000]), true);
  for (const invalid of [
    null, [10000], [10000, 50000, 500000, 1000000], [500, 5000, 25000, 75000],
    [-1, 100000, 500000, 1000000]
  ]) {
    assert.equal(rules.validateThresholds(invalid), false);
    assert.equal(rules.setThresholds(invalid), false);
  }
  assert.deepEqual([...rules.thresholds], [10000, 100000, 500000, 1000000]);
});
