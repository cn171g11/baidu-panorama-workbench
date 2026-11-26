#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const routes = ['map-entry', 'date-switch', 'date-option', 'arrow', 'panoid-url'];
const results = ['reached', 'alternative', 'unavailable', 'error'];
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const negative = step => ['alternative', 'unavailable'].includes(step.result);
// Record the date-control labels at month precision, not dates inferred from an ID.
const month = value => typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);

export function explicitSourceHistory(id, extra) {
  const inherited = extra?.inheritedCoordinate, parent = extra?.parentPanoid;
  return isId(id) && isId(parent) && parent !== id && extra.returnedBy === parent &&
    extra.coordinateSource === 'parent-reference-only' && inherited?.coordinateSource === 'parent-reference-only' &&
    inherited.inheritedFrom === parent && typeof extra.timelineLabel === 'string' && /^\d{4}(?:0[1-9]|1[0-2])$/.test(extra.timelineLabel);
}

function validateObservation(step, index) {
  const fail = message => { throw new Error(`Observation ${index + 1}: ${message}`); };
  if (!step || !routes.includes(step.route) || !(step.route==='date-option' ? step.result==='listed' : results.includes(step.result)) || !isId(step.to) || !isText(step.evidence)) {
    fail('invalid route, result, target or evidence reference');
  }
  const transition = ['date-switch','date-option','arrow'].includes(step.route);
  if (transition ? !isId(step.from) || step.from === step.to : step.from !== undefined) fail('invalid starting panorama');
  if ((step.result === 'reached' && step.observed !== step.to) ||
      (step.result === 'alternative' && (!isId(step.observed) || step.observed === step.to)) ||
      (['unavailable', 'error'].includes(step.result) && step.observed !== undefined)) fail('invalid observed panorama for result');
  if (step.route==='date-option' && (step.observed!==undefined || !month(step.dateBefore) || !month(step.dateAfter) || step.dateBefore===step.dateAfter || step.sameLocation!==true)) fail('date option must identify a distinct dated version at the same location, without claiming a transition');
  if (step.route === 'map-entry' && !isText(step.location)) fail('missing map click location');
  if (step.route === 'date-switch' && (step.result === 'reached' || step.result === 'alternative') &&
      (!month(step.dateBefore) || !month(step.dateAfter) || step.dateBefore === step.dateAfter || step.sameLocation !== true)) {
    fail('date switch must document two distinct valid YYYY-MM labels at the same location');
  }
}

export function auditPanoramaAccess(input) {
  if (!input || input.schemaVersion !== 1 || !isId(input.panoid) || !isText(input.client) || !isText(input.checkedAt) || Number.isNaN(Date.parse(input.checkedAt)) || !Array.isArray(input.sessions)) {
    throw new Error('Expected schemaVersion 1, panoid, client, checkedAt and sessions');
  }
  const { panoid, client, checkedAt } = input;
  const entries = [], mapPaths = [], dateTrips = [], dateCandidates = [], dateSwitches = [], urlEntries = [], checkedRoutes = [], mapAttempts = [];
  const incoming = [], outgoingArrows = [], oneWayCandidates = [], unresolved = [], missedMapDates = [], failedRoadReturns = [];
  let observedAccess = false, ambiguousDates = false;
  const optionCandidates=[], reverseDates=[], missedEntries=[], normalMissDates=[], normalMissArrows=[];
  const sessions = new Set();
  for (const session of input.sessions) {
    if (!session || !isText(session.id) || sessions.has(session.id) || !Array.isArray(session.steps)) throw new Error('Invalid or duplicate session');
    sessions.add(session.id);
    // A map/URL reset starts a new chain. A regular anchor may be reused only
    // after a new successful map click on that same ID within this session.
    const regular = new Set(), regularClicks = new Set(), candidates = [], trips = [];
    let current, currentDate, mapRoot, atMapRoot = false, last, pendingDate;
    const supported = candidate => candidate.knownRegular || regularClicks.has(candidate.click);
    const options=[], returning=[], sessionDateMiss=[], sessionArrowMiss=[];
    for (const [index, step] of session.steps.entries()) {
      validateObservation(step, index);
      const ref = { ...step, session: session.id, step: index + 1 };
      if (step.from !== undefined && step.from !== current) throw new Error(`Session ${session.id}, step ${index + 1}: starting panorama differs from previously observed ID`);
      if (!step.from) { current = currentDate = mapRoot = pendingDate = last = undefined; atMapRoot = false; }
      if (step.route === 'date-switch' && step.dateBefore && currentDate && step.dateBefore !== currentDate) throw new Error(`Session ${session.id}, step ${index + 1}: dateBefore differs from previously observed date`);
      if (step.result === 'error' && (step.to === panoid || step.from === panoid)) unresolved.push(ref);
      if (step.route !== 'panoid-url' && step.observed === panoid) observedAccess = true;
      if (step.route === 'map-entry') {
        mapAttempts.push(ref);
        if (step.result === 'reached' || step.result === 'alternative') mapRoot = ref;
        atMapRoot = step.result === 'reached';
        if (atMapRoot && step.observed === panoid) entries.push(ref);
        if(step.to===panoid && negative(step))missedEntries.push(ref);
      } else if (step.route === 'panoid-url') {
        if (step.result === 'reached' && step.to === panoid) urlEntries.push(ref);
      } else if (step.route==='date-option') {
        if(atMapRoot && step.to===panoid)options.push({...ref,click:mapRoot.step,knownRegular:regular.has(step.from)});
        // Inspecting the list leaves the current panorama, selected date and pending outbound intact.
        continue;
      } else if (step.route === 'arrow') {
        if(negative(step) && step.to===panoid && atMapRoot && mapRoot?.observed===step.from)sessionArrowMiss.push({...ref,click:mapRoot.step,knownRegular:regular.has(step.from)});
        if (step.result === 'reached') {
          if (step.from === panoid) outgoingArrows.push(ref);
          if (step.to === panoid) incoming.push(ref);
          if (atMapRoot && step.from === mapRoot?.observed) {
            regular.add(step.from); regularClicks.add(mapRoot.step);
            if (step.from === panoid) mapPaths.push(ref);
          }
        }
        if (negative(step) && last?.route === 'arrow' && last.result === 'reached' && last.from === step.to && last.to === step.from) {
          if (last.to === panoid) oneWayCandidates.push({ outbound: last, reverseAttempts: [ref] });
          if (last.from === panoid) failedRoadReturns.push(ref);
        }
        atMapRoot = false; pendingDate = undefined;
      } else {
        if(negative(step) && step.to===panoid && atMapRoot && mapRoot?.observed===step.from)sessionDateMiss.push({...ref,click:mapRoot.step,knownRegular:regular.has(step.from)});
        const reverse = pendingDate && step.from === pendingDate.to && step.to === pendingDate.from;
        if (step.result === 'reached') {
          dateSwitches.push(ref);
          if(step.from===panoid && regular.has(step.to))returning.push(ref);
          if (reverse && pendingDate.dateAfter === step.dateBefore && pendingDate.dateBefore === step.dateAfter) {
            if (pendingDate.to === panoid) trips.push([pendingDate, ref]);
            atMapRoot = true; pendingDate = undefined;
          } else {
            if (reverse && pendingDate.to === panoid) ambiguousDates = true;
            pendingDate = atMapRoot && mapRoot?.observed === step.from ? { ...ref, click: mapRoot.step, knownRegular: regular.has(step.from) } : undefined;
            if (pendingDate?.to === panoid) candidates.push(pendingDate);
            atMapRoot = false;
          }
          currentDate = step.dateAfter;
        } else {
          if (negative(step) && step.to === panoid && mapRoot?.to === panoid && mapRoot.result === 'alternative' && mapRoot.observed === step.from && last === mapRoot) missedMapDates.push(ref);
          pendingDate = undefined; atMapRoot = false;
        }
      }
      if (step.from && negative(step) && (step.to === panoid || step.from === panoid)) checkedRoutes.push(ref);
      current = step.observed ?? (step.result === 'unavailable' ? current : undefined);
      if (step.route !== 'date-switch' || !['reached','unavailable'].includes(step.result)) currentDate = undefined;
      last = ref;
    }
    dateCandidates.push(...candidates.filter(supported));
    optionCandidates.push(...options.filter(supported));
    reverseDates.push(...returning.filter(step=>regular.has(step.to)));
    normalMissDates.push(...sessionDateMiss.filter(supported));normalMissArrows.push(...sessionArrowMiss.filter(supported));
    dateTrips.push(...trips.filter(([step]) => supported(step)));
  }

  const oneWayArrows = oneWayCandidates.filter(({outbound}) => !outgoingArrows.some(reverse => reverse.to === outbound.from));
  const hiddenCandidate = urlEntries.length && !observedAccess && !unresolved.length && (missedMapDates.some(date => failedRoadReturns.some(road => road.from === date.from)) || (missedEntries.length && normalMissDates.length && normalMissArrows.length));
  const historyOnly = Array.isArray(input.history) && input.history.some(item => item?.panoid === panoid && explicitSourceHistory(panoid, item.extra));
  let category = 'unknown', status = unresolved.length ? 'access-error' : 'unknown';
  if (mapPaths.length) { category = 'regular'; status = 'regular-confirmed'; }
  else if (!entries.length && !ambiguousDates && dateTrips.length) { category = 'time-machine'; status = 'time-machine-roundtrip'; }
  else if (!entries.length && !ambiguousDates && (dateCandidates.length || reverseDates.length)) { category = 'time-machine'; status = 'time-machine-one-way'; }
  else if (!entries.length && oneWayArrows.length) { category = 'time-machine'; status = 'time-machine-one-way'; }
  else if (!entries.length && !ambiguousDates && (historyOnly || optionCandidates.length)) { category = 'time-machine'; status = 'time-machine-history-only'; }
  else if (hiddenCandidate) status = 'hidden-candidate';
  return { panoid, client, checkedAt, category, status, evidence: { entries, mapPaths, dateTrips, dateCandidates, reverseDates, optionCandidates, dateSwitches, urlEntries, checkedRoutes, mapAttempts, incoming, outgoingArrows, oneWayArrows, unresolved } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node tools/audit_panorama_access.mjs <observations.json>');
    process.exitCode = 1;
  } else {
    try {
      const input = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
      console.log(JSON.stringify(auditPanoramaAccess(input), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
