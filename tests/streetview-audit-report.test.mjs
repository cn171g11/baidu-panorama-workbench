import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePublicAudit } from '../city-viewer/js/streetview-audit.js';
import { auditBreakdown } from '../city-viewer/js/report.js';

test('public release audit is independently balanced and never serializes record or local path fields',async()=>{
  const s=JSON.parse(await readFile('config/streetview-audit.json','utf8'));
  validatePublicAudit(s,18936803);
  assert.equal(s.uploads.rows,255422);assert.equal(s.catalog.byStatus['user-confirmed-hidden'],7418);
  assert.equal(s.catalog.byBasis['tumushuke-user-confirmed-source'],11796);
  assert.equal(s.catalog.byStatus['time-machine-history-only'],80636);
  assert(auditBreakdown(s.catalog).some(v=>v.includes('仅历史引用 80,636')));
  for(const mutate of [x=>x.path='file:///private',x=>x.uploads.byBasis.xyz=0,x=>x.catalog.sourceByStatus.hidden.unknown++,x=>x.uploads.timelineSingle++,x=>x.catalog.rows++]){
    const forged=structuredClone(s);mutate(forged);assert.throws(()=>validatePublicAudit(forged,18936803));
  }
});
