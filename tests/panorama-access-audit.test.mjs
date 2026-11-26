import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditPanoramaAccess } from '../tools/audit_panorama_access.mjs';

const map = id => ({ route: 'map-entry', to: id, observed: id, result: 'reached', location: 'test map click', evidence: 'map' });
const arrow = (from, to) => ({ route: 'arrow', from, to, observed: to, result: 'reached', evidence: 'arrow' });
const date = (from, to, dateBefore, dateAfter) => ({ route: 'date-switch', from, to, observed: to, result: 'reached', dateBefore, dateAfter, sameLocation: true, evidence: 'date' });
const direct = id => ({ route: 'panoid-url', to: id, observed: id, result: 'reached', evidence: 'url' });
const audit = (panoid, ...traces) => auditPanoramaAccess({
  schemaVersion: 1, panoid, client: 'synthetic', checkedAt: '2026-11-25T12:00:00Z',
  sessions: traces.map((steps, i) => ({ id: `session-${i}`, steps })),
});

test('regular needs map entry and movement, regardless of metadata links', () => {
  const entry = { ...map('A'), links: [] };
  assert.equal(audit('A', [entry, arrow('A', 'B'), arrow('B', 'C')]).category, 'regular');
  assert.equal(audit('A', [entry, arrow('A', 'B'), arrow('B', 'A')]).category, 'regular');
  assert.equal(audit('A', [direct('A'), arrow('A', 'B'), arrow('B', 'C')]).category, 'unknown');
});

test('time-machine needs date selection both ways from a documented regular anchor', () => {
  const regular = [map('A'), arrow('A', 'B'), arrow('B', 'C')];
  const outward = date('A', 'H', '2023-09', '2016-05');
  const returning = date('H', 'A', '2016-05', '2023-09');
  assert.equal(audit('H', regular, [map('A'), arrow('A', 'B'), map('A'), outward, returning]).category, 'time-machine');
  const dateBeforeMovement = [map('A'), outward, returning, arrow('A', 'B'), arrow('B', 'C')];
  assert.equal(audit('A', dateBeforeMovement).category, 'regular');
  assert.equal(audit('H', dateBeforeMovement).status, 'time-machine-roundtrip');
  assert.equal(audit('A', [map('A'), outward, arrow('H', 'B'), arrow('B', 'C')]).category, 'unknown');
  assert.equal(audit('H', regular, [map('A'), outward]).category, 'unknown');
  assert.equal(audit('H', [map('A'), arrow('A', 'B'), map('A'), outward, returning]).status, 'time-machine-roundtrip');
  assert.equal(audit('H', regular, [map('A'), outward, returning], [map('H')]).status, 'unknown');
});

test('hidden candidate requires direct URL plus explicit negative map, date and road observations', () => {
  const missedEntry = { ...map('H'), result: 'alternative', observed: 'A' };
  const missedDate = { route: 'date-switch', from: 'A', to: 'H', result: 'unavailable', evidence: 'date option not reached' };
  const missedReturn = { route: 'arrow', from: 'A', to: 'H', result: 'unavailable', evidence: 'reverse attempt' };
  const result = audit('H', [missedEntry, missedDate], [direct('H'), arrow('H', 'A'), missedReturn]);
  assert.equal(result.status, 'hidden-candidate');
  assert.equal(result.category, 'unknown');
  assert.equal(result.evidence.oneWayArrows.length, 0);
  assert.equal(audit('H', [missedEntry, missedDate], [direct('H'), arrow('H', 'A'), { ...missedReturn, result: 'error' }]).status, 'access-error');
  assert.equal(audit('H', [missedEntry, missedDate, arrow('A', 'H')], [direct('H'), arrow('H', 'A'), missedReturn]).status, 'unknown');
});

test('metadata-only links and timeline are unknown without observed history reference', () => {
  assert.equal(audit('H', [{ ...direct('H'), links: ['H'] }, { ...direct('H'), TimeLine: [{ ID: 'H' }] }]).status, 'unknown');
  assert.equal(audit('H', [direct('H')]).status, 'unknown');
  const history = { panoid: 'H', relation: 'history', source: 'TimeLine' };
  assert.equal(audit('H', [direct('H')]).status, 'unknown');
  const check = history => auditPanoramaAccess({ schemaVersion: 1, panoid:'H', client:'synthetic', checkedAt:'2026-11-25T12:00:00Z', history:[history], sessions:[] });
  assert.equal(check(history).status,'unknown');
  history.extra = {returnedBy:'A', parentPanoid:'A', timelineLabel:'201605', coordinateSource:'parent-reference-only', inheritedCoordinate:{inheritedFrom:'A',coordinateSource:'parent-reference-only'}};
  assert.equal(check(history).status,'time-machine-history-only');
  assert.equal(check({...history,panoid:'A'}).status,'unknown');
});

test('regular movement and direction evidence stay target-scoped', () => {
  assert.equal(audit('A', [map('A')], [map('B'), arrow('B', 'C')]).status, 'unknown');
  assert.equal(audit('A', [map('A'), arrow('A', 'B')]).status, 'regular-confirmed');
  assert.equal(audit('H', [map('A'), arrow('A', 'B'), map('A'), date('A', 'H', '2023-09', '2016-05')]).status, 'time-machine-one-way');
});

test('a successful one-way date candidate does not imply a round trip', () => {
  const result = audit('H', [map('A'), arrow('A', 'B'), map('A'), date('A', 'H', '2023-09', '2016-05')]);
  assert.equal(result.status, 'time-machine-one-way');
  assert.equal(result.evidence.dateTrips.length, 0);
  assert.equal(result.evidence.dateCandidates.length, 1);
});

test('one-way requires observed incoming arrow and an explicit reverse miss on that edge', () => {
  const onward = arrow('A','H'), back = {route:'arrow',from:'H',to:'A',result:'unavailable',evidence:'reverse arrow checked'};
  assert.equal(audit('H',[map('A'),onward]).status,'unknown');
  assert.equal(audit('H',[map('A'),onward,back]).status,'time-machine-one-way');
  assert.equal(audit('H',[map('A'),onward],[direct('H'),back]).status,'unknown');
  assert.equal(audit('H',[map('A'),onward,back],[direct('H'),arrow('H','A')]).status,'unknown');
  assert.equal(audit('H',[map('A'),onward,{...back,result:'error'}]).status,'access-error');
  assert.equal(audit('H',[map('A'),onward,back],[map('H'),arrow('H','C')]).status,'regular-confirmed');
});

test('map and date evidence cannot be assembled across direct URL resets', () => {
  const from = date('A','H','2023-09','2016-05'), back = date('H','A','2016-05','2023-09');
  assert.equal(audit('A',[map('A'),direct('A'),arrow('A','B')]).status,'unknown');
  const standaloneReturn=audit('H',[map('A'),arrow('A','B'),direct('A'),from,back]);
  assert.equal(standaloneReturn.status,'time-machine-one-way');assert.equal(standaloneReturn.evidence.dateTrips.length,0);
  assert.equal(audit('H',[map('A'),from,back,map('A'),arrow('A','B')]).status,'unknown');
  assert.equal(audit('H',[map('A'),arrow('A','B'),map('A'),from,direct('H'),back]).status,'time-machine-one-way');
  assert.equal(audit('H',[map('A'),arrow('A','B'),map('A'),from,{...back,dateAfter:'2022-09'}]).status,'unknown');
  assert.throws(()=>audit('H',[map('A'),from,{...back,dateBefore:'2015-05'}]),/previously observed date/);
  assert.throws(()=>audit('H',[map('A'),{...from,dateAfter:'2016-13'}]),/valid YYYY-MM/);
});

test('failure is counted once and missed routes from unrelated anchors cannot imply hidden', () => {
  const missMap = {...map('H'),observed:'A',result:'alternative'};
  const missDate = {route:'date-switch',from:'A',to:'H',evidence:'control inspected',result:'unavailable'};
  assert.equal(audit('H',[missMap,{...missDate,result:'error'}]).evidence.unresolved.length,1);
  assert.equal(audit('H',[map('X'),{...missDate,from:'X',to:'Y',result:'error'}]).evidence.unresolved.length,0);
  assert.equal(audit('H',[missMap,missDate],[direct('H'),arrow('H','B'),{route:'arrow',from:'B',to:'H',evidence:'checked',result:'unavailable'}]).status,'unknown');
});

test('CLI reads UTF-8 with a BOM and exits nonzero for broken traces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panorama-access-audit-'));
  const script = fileURLToPath(new URL('../tools/audit_panorama_access.mjs', import.meta.url));
  const file = join(dir, 'trace.json');
  const input = { schemaVersion: 1, panoid: 'A', client: 'synthetic', checkedAt: '2026-11-25T12:00:00Z', sessions: [
    { id: 'map', steps: [map('A'), arrow('A', 'B'), arrow('B', 'C')] },
  ] };
  try {
    await writeFile(file, '\uFEFF' + JSON.stringify(input));
    const valid = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).category, 'regular');
    input.sessions[0].steps[1].from = 'Z';
    await writeFile(file, JSON.stringify(input));
    const invalid = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /starting panorama differs/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('inconsistent observation records fail closed', () => {
  assert.throws(() => audit('H', [map('A'), arrow('B', 'H')]), /starting panorama differs/);
  assert.throws(() => audit('H', [map('A'), { ...date('A', 'H', '2023-09', '2016-05'), sameLocation: false }]), /same location/);
});


test('date control identified without clicking, and reverse-only date return, do not prove a round trip',()=>{
  const anchor=[map('A'),arrow('A','N'),map('A')];
  const option={route:'date-option',result:'listed',from:'A',to:'H',dateBefore:'2023-09',dateAfter:'2016-05',sameLocation:true,evidence:'target id and month in control'};
  const listed=audit('H',[...anchor,option]);assert.equal(listed.status,'time-machine-history-only');assert.equal(listed.evidence.dateTrips.length,0);assert.equal(listed.evidence.optionCandidates.length,1);
  assert.equal(audit('H',[...anchor,direct('H'),date('H','A','2016-05','2023-09')]).status,'time-machine-one-way');
  assert.equal(audit('H',[map('A'),option]).status,'unknown');
});

test('hidden candidate does not require a road arrow OUT OF the target',()=>{
  const miss=(route)=>({route,from:'A',to:'H',result:'unavailable',evidence:'normal route inspected'});
  const anchor=[map('A'),arrow('A','N'),map('A')];
  const tries=[[{...map('H'),result:'alternative',observed:'X'}],[...anchor,miss('date-switch')],[...anchor,miss('arrow')],[direct('H')]];
  assert.equal(audit('H',...tries).status,'hidden-candidate');assert.equal(audit('H',tries[0],tries[1],tries[3]).status,'unknown');
  assert.equal(audit('H',...tries,[...anchor,arrow('A','H')]).status,'unknown');
});
