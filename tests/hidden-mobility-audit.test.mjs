import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('full hidden mobility audit has reconciled coverage and explicit limitations', async () => {
  const report = JSON.parse(await readFile('docs/hidden-mobility-audit-2026-11-25.json', 'utf8'));
  assert.equal(report.scope, 'all archived rows currently sourceType=hidden');
  assert.equal(report.reviewed, 238833);
  assert.equal(report.moved, 0);
  assert.equal(report.retainedHidden, 238833);
  assert.equal(report.reviewed, report.moved + report.retainedHidden);
  assert.equal(report.byEvidence['timeline-only'], 7024);
  assert.equal(report.byEvidence.none, 231809);
  assert.match(report.limitation, /没有逐条点击百度官网箭头/);
  assert.match(report.limitation, /图木舒克市 659003/);
  assert.equal(report.changedFiles.length, 80);
  assert(report.changedFiles.includes('data/baidu/371600/points-001.json'));
  const correction = report.userCorrections.find(row => row.city === '659003');
  assert.deepEqual(correction && { rows: correction.rows, previousHidden: correction.previousHidden, previousTimeMachine: correction.previousTimeMachine, newSourceType: correction.newSourceType }, { rows: 11796, previousHidden: 8743, previousTimeMachine: 3053, newSourceType: 'regular' });
});
