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
  assert.match(report.limitation, /No per-row official arrow clicking/);
  assert.match(report.limitation, /copied from timeLine/);
  assert.equal(report.changedFiles.length, 80);
  assert(report.changedFiles.includes('data/baidu/371600/points-001.json'));
});
