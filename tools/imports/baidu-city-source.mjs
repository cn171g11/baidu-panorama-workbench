import { validateRows } from '../../city-viewer/js/metadata.js';
import { captureInfo, validCaptured } from '../../city-viewer/js/panoid-time.js';
import { categoryFor } from '../../city-viewer/js/classification.js';

const PROVIDERS = new Set(['baidu', 'baidu_pano', 'baidu_road_member']);
const SOURCE_LABEL = /^data_\d{6}\.js$/;

/** Normalize a JSON-only PANO_CITY record with explicitly established BD-09 coordinates.
 * No script execution, network calls, province/panoid-prefix inference or imagery claims.
 * Existing canonical rows supplement missing fields and keep an independent observation.
 */
export function normalizeCitySource(raw, { sourceFile, sourceSha256, coordinateSystem, previous = null, previousSourceFile = null } = {}) {
  if (coordinateSystem !== 'BD-09') throw Error('This native source adapter requires established BD-09 coordinates');
  if (typeof sourceFile !== 'string' || !SOURCE_LABEL.test(sourceFile) || !/^[a-f0-9]{64}$/.test(sourceSha256 || '')) throw Error('Safe source label and SHA-256 are required');
  if (!Array.isArray(raw) || raw.length !== 9 || !PROVIDERS.has(raw[8])) throw Error('Expected an explicit nine-field Baidu source record');
  if (previous && previous[0] !== raw[0]) throw Error('Supplemental panoid differs from source panoid');
  const old = previous ? validateRows([structuredClone(previous)])[0] : null;
  const provenance = { originalRecord: structuredClone(raw), sourceFile, sourceSha256, sourceCoordinateSystem: 'BD-09', sourceDateFormat: 'YYYYMMDD' };
  const oldExtra = old ? structuredClone(old[9] || {}) : {};
  const extras = { ...oldExtra, source: raw[8], sourceType: raw[8] === 'baidu_road_member' ? categoryFor(old || { sourceType: 'unknown' }) : categoryFor(old || { sourceType: 'regular' }), extra: { ...(oldExtra.extra || {}), ...provenance } };
  const flag = (value, index) => {
    if (value === 0 || value === false) return false;
    if (value === 1 || value === true) return true;
    if ((value === '' || value === null || value === undefined) && old) return old[index];
    throw Error('Source flags must be 0/1 or booleans');
  };
  let captured = raw[4];
  if (typeof captured !== 'string') throw Error('Source capture date must be a string');
  if (/^\d{8}$/.test(captured)) captured = captured.slice(0, 4) + '-' + captured.slice(4, 6) + '-' + captured.slice(6, 8);
  if (!captured && old && captureInfo(old).source === 'source') captured = old[4];
  if (captured && !validCaptured(captured)) throw Error('Invalid source calendar date');
  // Never let a copied encoded-date marker re-label a newly supplied explicit day.
  if (captured && extras.captureTime?.source === 'panoid') delete extras.captureTime;
  let heading;
  if (raw[5] === '' || raw[5] === null || raw[5] === undefined) heading = old ? old[5] : null;
  else {
    if (!(typeof raw[5] === 'number' || (typeof raw[5] === 'string' && /^\d+(?:\.\d+)?$/.test(raw[5])))) throw Error('Invalid source heading');
    heading = Number(raw[5]);
    if (!Number.isFinite(heading) || heading < 0 || heading > 360) throw Error('Source heading is outside [0,360]');
    if (heading === 360) heading = 0;
  }
  const coordinates = [raw[1], raw[2]];
  for (let i = 0; i < 2; i++) {
    if (coordinates[i] === '' || coordinates[i] === null || coordinates[i] === undefined) {
      if (!old) throw Error('Missing source coordinate without an exact local panoid match');
      coordinates[i] = old[i + 1];
    }
  }
  let road = raw[3];
  if (road === '' && old?.[3]) road = old[3];
  if (typeof road !== 'string') throw Error('Source road must be a string');
  if (old) {
    const observation = { sourceFile: previousSourceFile || 'local-baidu-archive', role: 'local-panoid-supplement', variant: structuredClone(old) };
    extras.observations = [...(oldExtra.observations || []), observation];
  }
  const row = [raw[0], coordinates[0], coordinates[1], road, captured, heading, flag(raw[6], 6), flag(raw[7], 7), 'baidu', extras];
  return validateRows([row])[0];
}
