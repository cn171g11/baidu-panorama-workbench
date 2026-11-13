import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryFor, countCategories } from '../city-viewer/js/classification.js';
import { aggregate, countFor } from '../city-viewer/js/report.js';

test('classification prioritizes source type and explicit visibility evidence', () => {
  assert.equal(categoryFor(["id", 1, 2, "", "", null, false, true, "baidu", { sourceType: 'time-machine', isHidden: true }]), 'time-machine');
  assert.equal(categoryFor({ isHidden: true }), 'hidden'); assert.equal(categoryFor({ sourceType: 'unknown' }), 'unknown'); assert.equal(categoryFor({ timeline: [{ year: 2000 }] }), 'regular');
});
test('countCategories returns displayCounts naming', () => { assert.deepEqual(countCategories([{ sourceType: 'hidden' }, { sourceType: 'time-machine' }, {}]), { regular: 1, hidden: 1, timeMachine: 1, unknown: 0, total: 3 }); });
test('report aggregates province totals and preserves display count categories', () => {
  const result = aggregate([{ id:'1', province:'A', name:'One', count:10, displayCounts:{ regular:4, hidden:3, timeMachine:2, unknown:1, total:10 } }, { id:'2', province:'A', name:'Two', count:5, displayCounts:{ regular:5, hidden:0, timeMachine:0, unknown:0, total:5 } }, { id:'3', province:'B', name:'Three', count:2 }]);
  assert.deepEqual(result.total, { regular:11, hidden:3, timeMachine:2, unknown:1, total:17 });
  assert.equal(result.provinces.find(item => item.name === 'A').cities.length, 2); assert.equal(countFor(result.provinces[1].cities[0].item).regular, 2);
});

test('report structure contains cards, collapsible groups, ratio bars, filter and sorting controls', async () => {
  const html = await (await import('node:fs/promises')).readFile(new URL('../city-viewer/report.html', import.meta.url), 'utf8');
  const css = await (await import('node:fs/promises')).readFile(new URL('../city-viewer/css/report.css', import.meta.url), 'utf8');
  assert.match(html, /summary-cards/); assert.match(html, /province-groups/); assert.match(html, /report-hidden-only/); assert.match(html, /data-sort="timeMachine"/);
  assert.match(css, /province-card/); assert.match(css, /ratio-bar/); assert.match(css, /details/);
});
