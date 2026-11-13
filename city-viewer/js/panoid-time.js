// Pure, allocation-light parsing of the supported 27-character Baidu panoid format.
// Positions 11–25 (1-based) contain YYMMDDhhmmssSSS; no time zone is encoded.
// Reference: BaiduMapToy uses official panoData.date. Official Date samples were
// cross-checked separately; clock precision below is encoded, not server-certified.
export const PANOID_TIME_ENCODING = 'baidu-27-yymmdd-hhmmss-ms-v1';
const FORMAT = /^\d{25}[A-Za-z0-9]{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
function days(year, month) { return month === 2 ? (leap(year) ? 29 : 28) : (month===4||month===6||month===9||month===11 ? 30 : 31); }
function validDay(year,month,day) { return month>=1 && month<=12 && day>=1 && day<=days(year,month); }

export function panoidCaptured(panoid) {
  if (typeof panoid !== 'string' || !FORMAT.test(panoid)) return '';
  const year=2000+Number(panoid.slice(10,12)),month=Number(panoid.slice(12,14)),day=Number(panoid.slice(14,16));
  const hour=Number(panoid.slice(16,18)),minute=Number(panoid.slice(18,20)),second=Number(panoid.slice(20,22));
  if (!validDay(year,month,day) || hour>23 || minute>59 || second>59) return '';
  return `${year}-${panoid.slice(12,14)}-${panoid.slice(14,16)}T${panoid.slice(16,18)}:${panoid.slice(18,20)}:${panoid.slice(20,22)}.${panoid.slice(22,25)}`;
}
export function validCaptured(value) {
  if(typeof value!=='string'||!ISO.test(value))return false;
  const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
  if(!validDay(year,month,day))return false;
  if(value.length===10)return true;
  return Number(value.slice(11,13))<=23 && Number(value.slice(14,16))<=59 && Number(value.slice(17,19))<=59 && Number.isFinite(Date.parse(value));
}
function resolvedCapture(row) {
  if(!Array.isArray(row)||row[8]!=='baidu')return {value:'',source:'unknown'};
  const extras=row[9],marker=extras?.captureTime;
  // A marker is only recognized when it matches this format AND its value.
  // It cannot silently re-label a different, explicit date from an import.
  const marked=marker?.source==='panoid'&&marker.encoding===PANOID_TIME_ENCODING;
  const encoded=marked?panoidCaptured(row[0]):'';
  const derived=marked&&!!encoded&&row[4]===encoded;
  if(validCaptured(row[4])&&!derived)return {value:row[4],source:'source'};
  if(validCaptured(extras?.imageDate))return {value:extras.imageDate,source:'source'};
  if(validCaptured(extras?.extra?.imageDate))return {value:extras.extra.imageDate,source:'source'};
  const value=encoded||panoidCaptured(row[0]);
  return {value,source:value?'panoid':'unknown'};
}
// No per-panoid cache: suitable for streaming 19M records or city-sized filters.
export function capturedValue(row) { return resolvedCapture(row).value; }
export function captureInfo(row) {
  const {value,source}=resolvedCapture(row);
  if(source==='source')return {value,source,precision:value.length===10?'day':'source',timeZone:value.endsWith('Z')?'UTC':/[+-]\d{2}:\d{2}$/.test(value)?value.slice(-6):null};
  if(source==='panoid')return {value,source,precision:'encoded-millisecond',timeZone:null,encoding:PANOID_TIME_ENCODING};
  return {value:'',source:'unknown',precision:null,timeZone:null};
}
export function enrichCapturedRow(row) {
  if(!Array.isArray(row)||row[8]!=='baidu'||row[4])return row;
  const info=captureInfo(row);if(!info.value)return row;
  const copy=row.slice();copy[4]=info.value;
  if(info.source==='panoid')copy[9]={...(row[9]||{}),captureTime:{source:'panoid',encoding:PANOID_TIME_ENCODING,precision:'encoded-millisecond',timeZone:null}};
  return copy;
}
export function newCaptureSummary() { return {source:0,panoid:0,unknown:0,total:0,earliest:null,latest:null}; }
export function addCaptureSummary(summary,row) {
  const info=captureInfo(row);summary[info.source]++;summary.total++;
  if(info.value){const day=info.value.slice(0,10);if(summary.earliest===null||day<summary.earliest)summary.earliest=day;if(summary.latest===null||day>summary.latest)summary.latest=day;}
}
