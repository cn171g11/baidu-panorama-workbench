import { convertCoordinate } from "./coordinates.js";

const PANORAMA_FIELDS = ["panoid", "longitude", "latitude", "road", "captured", "heading", "hasThumb", "hasPano", "provider"];
const FORBIDDEN_KEYS = /^(tencent|qq|qqpano|qqpanoid|tx|腾讯|腾讯街景|svid|rdid|sno|level0|providerSource)$/i;

function fail(message) { throw new Error(message); }
function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function isBaiduProvider(value) { return value === "baidu" || value === "baidu_pano" || value === "百度"; }

function assertPlainBaiduRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("Each row must be an object or nine-field array");
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.test(key) || /tencent|qq|svid|rdid|sno|level0/i.test(key)) fail(`Non-Baidu field is forbidden: ${key}`);
    if (key === "source" || key === "tags") inspectProvenance(record[key], key);
    if (/url|link/i.test(key)) inspectProvenance(record[key], key);
  }
}

function inspectProvenance(value, key = "") {
  if (Array.isArray(value)) { for (const item of value) inspectProvenance(item, key); return; }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^provider$/i.test(key) && value && !isBaiduProvider(value)) fail("Non-Baidu provenance is forbidden");
    if (typeof value === "string" && /^(source|tag|tags|history)$/i.test(key) && value && /tencent|qq|腾讯/i.test(value)) fail("Non-Baidu provenance is forbidden");
    if (typeof value === "string" && /url|link/i.test(key) && /tencent|qq|qq-map\.netlify\.app/i.test(value)) fail("Non-Baidu panorama URLs are forbidden");
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    if (/tencent|qq|svid|rdid|sno|level0/i.test(childKey)) fail(`Non-Baidu field is forbidden: ${childKey}`);
    inspectProvenance(child, childKey);
  }
}

function isRealIsoDate(value) {
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  return !timePart || !Number.isNaN(Date.parse(value));
}

function normalizeRow(row) {
  if (Array.isArray(row)) {
    if (row.length < 8 || row.length > 10) fail("Panorama arrays must have eight data fields, provider, and optional extras");
    const [panoid, longitude, latitude, road, captured, heading, hasThumb, hasPano, provider, extras] = row;
    if (extras !== undefined && (!extras || typeof extras !== "object" || Array.isArray(extras))) fail("Optional panorama extras must be an object");
    if (extras) assertPlainBaiduRecord(extras);
    return [panoid, longitude, latitude, road, captured, heading, hasThumb, hasPano, provider, ...(extras === undefined ? [] : [extras])];
  }
  assertPlainBaiduRecord(row);
  const panoid = row.panoid ?? row.streetViewId;
  const road = row.road ?? row.streetName ?? "";
  const captured = row.captured ?? row.captureDateTime ?? row.captureDate ?? "";
  for (const [key, value] of [["panoid", panoid], ["longitude", row.longitude], ["latitude", row.latitude], ["road", road], ["captured", captured], ["heading", row.heading ?? null], ["hasThumb", row.hasThumb ?? false], ["hasPano", row.hasPano ?? true], ["provider", row.provider]]) {
    if (value === undefined) fail(`Missing field: ${key}`);
  }
  const extras = row.extras ?? ((row.links !== undefined || row.historical !== undefined) ? { ...(row.links === undefined ? {} : { links: row.links }), ...(row.historical === undefined ? {} : { history: row.historical }) } : undefined);
  if (extras !== undefined) assertPlainBaiduRecord(extras);
  const normalized = [panoid, row.longitude, row.latitude, road, captured, row.heading ?? null, row.hasThumb ?? false, row.hasPano ?? true, row.provider];
  if (extras !== undefined) normalized.push(extras);
  return normalized;
}

function validateRows(rows) {
  if (!Array.isArray(rows)) fail("Rows must be an array");
  const ids = new Set();
  return rows.map((input, index) => {
    let row;
    try { row = normalizeRow(input); } catch (error) { fail(`Row ${index + 1}: ${error.message}`); }
    const [panoid, lng, lat, road, captured, heading, hasThumb, hasPano, provider, extras] = row;
    if (typeof panoid !== "string" || !/^[\x21-\x7e]{1,256}$/.test(panoid)) fail(`Row ${index + 1}: panoid must be a non-empty printable ASCII string of at most 256 characters`);
    if (ids.has(panoid)) fail(`Duplicate panoid in batch: ${panoid}`);
    ids.add(panoid);
    if (provider !== undefined && !isBaiduProvider(provider)) fail(`Row ${index + 1}: provider must be Baidu`);
    if (provider === undefined) fail(`Row ${index + 1}: missing provider marker`);
    row[8] = "baidu";
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) fail(`Row ${index + 1}: invalid coordinates`);
    if (typeof road !== "string" || typeof captured !== "string") fail(`Row ${index + 1}: road and captured must be strings`);
    if (captured && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(captured) || !isRealIsoDate(captured))) fail(`Row ${index + 1}: captured must be an actual ISO date/time`);
    if (heading !== null && (!Number.isFinite(heading) || heading < 0 || heading >= 360)) fail(`Row ${index + 1}: heading must be null or in [0, 360)`);
    if (typeof hasThumb !== "boolean" || typeof hasPano !== "boolean") fail(`Row ${index + 1}: hasThumb and hasPano must be booleans`);
    if (extras !== undefined) {
      inspectProvenance(extras);
      for (const key of Object.keys(extras)) if (!["district", "links", "history"].includes(key)) fail(`Unsupported extras field: ${key}`);
      if (extras.district !== undefined && typeof extras.district !== "string") fail("extras.district must be a string");
      if (extras.links !== undefined && !(Array.isArray(extras.links) || (extras.links && typeof extras.links === "object"))) fail("extras.links must be an array or object");
      if (extras.links !== undefined) {
        const serialized = JSON.stringify(extras.links);
        if (serialized.length > 20000 || /tencent|qq\.com|map\.qq/i.test(serialized)) fail("extras.links contains forbidden or excessive content");
      }
      if (extras.history !== undefined && !(Array.isArray(extras.history) || (extras.history && typeof extras.history === "object"))) fail("extras.history must be an array or object");
      if (extras.history !== undefined && JSON.stringify(extras.history).length > 20000) fail("extras.history is too large");
    }
    return row;
  });
}

function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') {
      if (value) fail("Invalid CSV quote placement");
      quoted = true;
    } else if (char === ",") { fields.push(value); value = ""; }
    else value += char;
  }
  if (quoted) fail("Unclosed quoted CSV field");
  fields.push(value);
  return fields;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const first = parseCsvLine(lines[0]);
  const hasHeader = ["panoid", "streetviewid"].includes(first[0].trim().toLowerCase());
  const columns = hasHeader ? first.map(v => v.trim()) : PANORAMA_FIELDS;
  const rows = (hasHeader ? lines.slice(1) : lines).map((line, index) => {
    const fields = parseCsvLine(line);
    if (fields.length !== columns.length) fail(`CSV row ${index + (hasHeader ? 2 : 1)} has ${fields.length} columns; expected ${columns.length}`);
    const record = Object.fromEntries(columns.map((key, i) => [key, fields[i]]));
    for (const [canonical, aliases] of [["panoid", ["streetViewId"]], ["road", ["streetName"]], ["captured", ["captureDate", "captureDateTime"]]]) {
      const alias = aliases.find(key => record[key] !== undefined);
      if (record[canonical] === undefined && alias) record[canonical] = record[alias];
    }
    if (record.longitude === undefined || record.latitude === undefined || !record.longitude.trim() || !record.latitude.trim()) fail(`CSV row ${index + (hasHeader ? 2 : 1)} has empty coordinates`);
    record.longitude = Number(record.longitude);
    record.latitude = Number(record.latitude);
    if (record.heading === undefined || record.heading === "") record.heading = null;
    else record.heading = Number(record.heading);
    for (const key of ["hasThumb", "hasPano"]) {
      if (record[key] === undefined || record[key] === "") record[key] = key === "hasPano";
      else if (record[key] === "true") record[key] = true;
      else if (record[key] === "false") record[key] = false;
      else fail(`CSV ${key} must be true or false`);
    }
    return record;
  });
  return rows;
}

function parseJsonLines(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { fail(`JSONL line ${index + 1}: ${error.message}`); }
  });
}

function parseReference(text) {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const fields = parseCsvLine(line);
    if (fields.length !== 9) fail(`Reference row ${index + 1} must have exactly nine fields`);
    if (!fields[1].trim() || !fields[2].trim()) fail(`Reference row ${index + 1} has empty coordinates`);
    if (!isBaiduProvider(fields[8])) fail(`Reference row ${index + 1} provider marker must be Baidu`);
    const parseFlag = (value, label, fallback) => {
      if (value === "1" || value === "true") return true;
      if (value === "0" || value === "false") return false;
      if (value === "") return fallback;
      fail(`Reference row ${index + 1} ${label} must be 0/1 or false/true`);
    };
    return [fields[0], Number(fields[1]), Number(fields[2]), fields[3], fields[4], fields[5].trim() ? Number(fields[5]) : null, parseFlag(fields[6], "hasThumb", false), parseFlag(fields[7], "hasPano", true), "baidu"];
  });
}

function parseImport(text, { format, confirmedBaidu = false, coordinateSystem } = {}) {
  if (typeof text !== "string") fail("Import content must be text");
  text = text.replace(/^\uFEFF/, "");
  if (!coordinateSystem || !["BD-09", "GCJ-02", "WGS84"].includes(coordinateSystem)) fail("Declare coordinateSystem as BD-09, GCJ-02, or WGS84");
  if (!confirmedBaidu) fail("Confirm that the source is Baidu metadata before importing");
  let parsed;
  try {
    if (format === "json") parsed = JSON.parse(text);
    else if (format === "jsonl") parsed = parseJsonLines(text);
    else if (format === "csv") parsed = parseCsv(text);
    else if (format === "reference") parsed = parseReference(text);
    else fail(`Unsupported import format: ${format}`);
  } catch (error) {
    if (error instanceof SyntaxError) fail(`Invalid ${format.toUpperCase()} syntax: ${error.message}`);
    throw error;
  }
  if (!Array.isArray(parsed)) {
    if (parsed && typeof parsed === "object") {
      if (parsed.provider !== undefined && !isBaiduProvider(parsed.provider)) fail(`Import provider must be Baidu, got ${parsed.provider}`);
      if (parsed.source !== undefined) inspectProvenance({ source: parsed.source }, "source");
      if (parsed.coordinateSystem !== undefined && parsed.coordinateSystem !== coordinateSystem) fail("Declared import coordinateSystem conflicts with supplied option");
      if (parsed.sourceUrl !== undefined) inspectProvenance({ url: parsed.sourceUrl }, "sourceUrl");
      if (parsed.rows !== undefined) parsed = parsed.rows;
      else if (parsed.points !== undefined) parsed = parsed.points;
      else if (parsed.panoramas !== undefined) parsed = parsed.panoramas;
      else fail("JSON import object must contain rows, points, or panoramas");
    } else fail("JSON import must be an array or a rows/points/panoramas object");
  }
  const rows = parsed.map((value, index) => {
    if (Array.isArray(value)) {
      if (value.length < 8) fail(`Row ${index + 1}: expected at least eight fields`);
      if (value[8] !== undefined && !isBaiduProvider(value[8])) fail(`Row ${index + 1}: provider marker must be Baidu`);
      if (value[8] === undefined && !confirmedBaidu) fail(`Row ${index + 1}: missing provider marker requires Baidu confirmation`);
      return [...value.slice(0, 8), "baidu", ...value.slice(9)];
    }
    assertPlainBaiduRecord(value);
    if (value.coordinateSystem !== undefined && value.coordinateSystem !== coordinateSystem) fail(`Row ${index + 1}: coordinateSystem conflicts with supplied option`);
    if (value.provider !== undefined && !isBaiduProvider(value.provider)) fail(`Row ${index + 1}: provider marker must be Baidu`);
    if (value.provider === undefined && !confirmedBaidu) fail(`Row ${index + 1}: missing provider marker requires Baidu confirmation`);
    return { ...value, provider: "baidu" };
  });
  const validated = validateRows(rows);
  return validated.map((row, index) => {
    const sourceRow = rows[index];
    if (!Array.isArray(sourceRow) && sourceRow.coordinateSystem !== undefined && sourceRow.coordinateSystem !== coordinateSystem) fail(`Row ${index + 1}: coordinateSystem conflicts with supplied option`);
    const converted = convertCoordinate(row[1], row[2], coordinateSystem, "BD-09");
    if (converted[0] < -180 || converted[0] > 180 || converted[1] < -90 || converted[1] > 90) fail(`Converted coordinates are out of range for panoid ${row[0]}`);
    return [row[0], converted[0], converted[1], ...row.slice(3)];
  });
}

function filterRows(rows, { query = "", road = "", date = "" } = {}) {
  const q = String(query).toLocaleLowerCase();
  return rows.filter(row => {
    const searchable = `${row[0]} ${row[3]} ${row[4]} ${row[1]} ${row[2]}`.toLocaleLowerCase();
    return (!q || searchable.includes(q)) && (!road || row[3] === road) && (!date || row[4].startsWith(date));
  });
}
function baiduPanoramaUrl(panoid) {
  if (typeof panoid !== "string" || !panoid.trim()) fail("panoid must be a non-empty string");
  return `https://map.baidu.com/?qt=pano&panoId=${encodeURIComponent(panoid)}`;
}
function mergeRows(existing, incoming) {
  const left = validateRows(existing);
  const right = validateRows(incoming);
  const ids = new Set(left.map(row => row[0]));
  for (const row of right) {
    if (ids.has(row[0])) fail(`Duplicate panoid already exists: ${row[0]}`);
    ids.add(row[0]);
  }
  return [...left, ...right];
}

export { baiduPanoramaUrl, filterRows, mergeRows, parseImport, validateRows };
