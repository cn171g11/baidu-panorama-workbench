import test from "node:test";
import assert from "node:assert/strict";
import { convertCoordinate, toWgs84 } from "../city-viewer/js/coordinates.js";
import { baiduPanoramaUrl, filterRows, mergeRows, parseImport, validateRows } from "../city-viewer/js/metadata.js";

const row = (panoid = "090000000000000000000000001", extra = {}) => ({ panoid, longitude: 116.4, latitude: 39.9, road: 'North "Market", Road', captured: "2025-02-03", heading: 270, hasThumb: false, hasPano: true, provider: "baidu", ...extra });
const opts = { format: "json", confirmedBaidu: true, coordinateSystem: "BD-09" };

test("coordinates convert known systems and reject unknown/non-finite inputs", () => {
  const bd = convertCoordinate(116.4, 39.9, "WGS84", "BD-09");
  assert.ok(bd[0] > 116.4 && bd[1] > 39.9);
  const wgs = toWgs84(...bd);
  assert.ok(Math.abs(wgs[0] - 116.4) < 1e-5);
  assert.deepEqual(convertCoordinate(1, 2, "WGS84", "WGS84"), [1, 2]);
  assert.throws(() => convertCoordinate(NaN, 0, "WGS84", "BD-09"), /finite/);
  assert.throws(() => convertCoordinate(0, 0, "UNKNOWN", "BD-09"), /Unknown/);
});

test("parses Baidu panoramas envelope, aliases, 27-digit panoid, and extras", () => {
  const input = JSON.stringify({ panoramas: [{ provider: "baidu_pano", streetViewId: "090000000000000000000000001", longitude: 116.4, latitude: 39.9, captureDate: "2022-04-03", heading: 5, streetName: "Lane", links: { PID: "safe", X: 1 }, historical: [{ ID: "historic", Year: 1999 }] }] });
  const [parsed] = parseImport(input, opts);
  assert.equal(parsed[0], "090000000000000000000000001");
  assert.equal(parsed[3], "Lane");
  assert.equal(parsed[4], "2022-04-03");
  assert.equal(parsed[8], "baidu");
  assert.deepEqual(parsed[9].links, { PID: "safe", X: 1 });
  assert.equal(parsed[9].history[0].Year, 1999);
});

test("requires source confirmation and rejects Tencent markers, URLs, fields, and mixed providers", () => {
  assert.throws(() => parseImport(JSON.stringify([{ ...row(), tencentId: "1" }]), opts), /Non-Baidu/);
  assert.throws(() => parseImport(JSON.stringify([row("id", { provider: "tencent" })]), opts), /provider/);
  assert.throws(() => parseImport(JSON.stringify({ provider: "qq", rows: [] }), opts), /provider/);
  assert.throws(() => parseImport(JSON.stringify([row("id", { links: ["https://map.qq.com/foo"] })]), opts), /forbidden/);
  assert.throws(() => parseImport(JSON.stringify([row()]), { ...opts, confirmedBaidu: false }), /Confirm/);
  const legacy = { ...row() }; delete legacy.provider;
  assert.equal(parseImport(JSON.stringify([legacy]), opts)[0][8], "baidu");
});

test("rejects invalid rows, duplicate panoids and unknown coordinate systems", () => {
  assert.throws(() => validateRows([["x", 181, 0, "", "", 0, false, true, "baidu"]]), /coordinates/);
  assert.throws(() => validateRows([row("x"), row("x")]), /Duplicate/);
  assert.throws(() => parseImport("[]", { ...opts, coordinateSystem: "guess" }), /coordinateSystem/);
  assert.throws(() => parseImport("{broken", opts), /Invalid JSON/);
});

test("CSV quoting, JSONL, reference rows, filtering, merging, and official links", () => {
  const csv = 'panoid,longitude,latitude,road,captured,heading,hasThumb,hasPano,provider\nid-1,116.4,39.9,"North ""Market"", Road",2025-01-02,90,false,true,baidu';
  const [csvRow] = parseImport(csv, { ...opts, format: "csv" });
  assert.equal(csvRow[0], "id-1");
  assert.equal(csvRow[3], 'North "Market", Road');
  const jsonl = JSON.stringify(row("jsonl"));
  assert.equal(parseImport(jsonl, { ...opts, format: "jsonl" })[0][0], "jsonl");
  const ref = 'ref-id,116.4,39.9,"A, Road",2024-01-01,30,0,1,baidu';
  assert.equal(parseImport(ref, { ...opts, format: "reference" })[0][0], "ref-id");
  const rows = validateRows([row("one"), row("two", { road: "Other" })]);
  assert.equal(filterRows(rows, { query: "ONE", road: 'North "Market", Road', date: "2025" }).length, 1);
  assert.throws(() => mergeRows(rows, [row("one")]), /Duplicate/);
  assert.match(baiduPanoramaUrl("id /x"), /^https:\/\/map\.baidu\.com\//);
  assert.match(baiduPanoramaUrl("id /x"), /id%20%2Fx/);
});
