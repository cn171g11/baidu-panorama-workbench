// Literal JSON fields only. Links, time-line members and neighbours are never flag sources.
const aliases = ['id', 'panoId', 'panoid', 'sid', 'streetViewId'];
const own = (v, k) => v != null && Object.hasOwn(v, k);
function sameId(record, id, required = true) {
  let found = false;
  for (const key of aliases) if (own(record,key)) { if (record[key] !== id) return false; found = true; }
  return found || !required;
}
export function displaySourceIsHidden(row, m) {
  if (!own(m,'isHidden') || m.isHidden !== true) return false;
  const id = Array.isArray(row) ? row[0] : aliases.map(k=>row[k]).find(v=>v!==undefined);
  // A viewer accepts bare metadata too, but must not merge two conflicting identities.
  return sameId(row,id,false) && sameId(m,id,false);
}
export function sourceRecordHiddenFlag(record, id) {
  if (typeof id !== 'string' || !id || record == null || typeof record !== 'object') return undefined;
  if (Array.isArray(record)) {
    if (record[0] !== id || record[8] !== 'baidu' || !sameId(record[9],id,false)) return undefined;
    record = record[9];
  } else if (!sameId(record,id)) return undefined;
  return own(record,'isHidden') && typeof record.isHidden === 'boolean' ? record.isHidden : undefined;
}
export const sourceRecordIsHidden = (record,id) => sourceRecordHiddenFlag(record,id) === true;
export function canonicalIsHidden(meta) {
  return meta?.sourceType === 'hidden' && own(meta,'isHidden') && meta.isHidden === true;
}
// Observation variants are normalized rows: their own isHidden may be derived. Only
// original-record slots may contribute, bound to the outer and inner subject ID.
export function embeddedSourceHiddenFlag(row) {
  const id = row?.[0], meta = row?.[9];
  if (row?.[8] !== 'baidu' || !meta || !sameId(meta,id,false)) return undefined;
  let result, conflict = false;
  function collect(m) {
    for (const raw of [m?.extra?.originalRecord, m?.originalRecord]) {
      const flag = sourceRecordHiddenFlag(raw,id);
      if (flag === undefined) continue;
      if (result !== undefined && result !== flag) conflict = true;
      result = flag;
    }
  }
  collect(meta);
  if (result !== undefined) return conflict ? undefined : result; // identified primary always wins
  if (Array.isArray(meta.observations)) for (const obs of meta.observations) {
    const v = obs?.variant;
    if (Array.isArray(v)) {
      if (v[0] === id && v[8] === 'baidu' && sameId(v[9],id,false)) collect(v[9]);
    } else if (v && sameId(v,id,false)) collect(v);
    if (conflict) return undefined;
  }
  return result;
}
export const embeddedSourceIsHidden = row => embeddedSourceHiddenFlag(row) === true;
