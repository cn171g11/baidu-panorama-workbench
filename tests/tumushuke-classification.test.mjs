import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Tumushuke user-confirmed regular correction preserves supplement provenance', async () => {
  const rows = JSON.parse(await readFile('data/baidu/659003/points-001.json', 'utf8'));
  const regular = rows.filter(row => row[9]?.sourceType === 'regular' && row[9]?.extra?.classificationBasis === 'user-confirmed-regular');
  const timeMachine = rows.filter(row => row[9]?.sourceType === 'time-machine');
  const hidden = rows.filter(row => row[9]?.sourceType === 'hidden');
  const inherited = rows.filter(row => row[9]?.extra?.inheritedCoordinate);
  const linked = rows.filter(row => Array.isArray(row[9]?.links) && row[9].links.length > 0);
  assert.equal(regular.length, 11796);
  assert.equal(timeMachine.length, 0);
  assert.equal(hidden.length, 0);
  assert.equal(inherited.length, 1461);
  assert.equal(linked.length, 1592);
  assert(regular.every(row => row[9]?.isHidden !== true));
  assert(regular.every(row => row[9]?.extra?.sourceBatch === 'baidu-supplement-20261123'));
  assert(regular.every(row => row[9]?.extra?.classificationReviewedAt === '2026-11-25'));
  assert(regular.every(row => row[9]?.links === undefined || Array.isArray(row[9]?.links)));
  assert(regular.every(row => row[9]?.extra?.classificationBasis === 'user-confirmed-regular'));
});
