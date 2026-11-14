import assert from "node:assert/strict";
import test from "node:test";
import { prepareCountyMatcher } from "../tools/counties/geometry.mjs";

const rectangle = (west, south, east, north) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];
const feature = (id = "370102", rings = [rectangle(116, 36, 117, 37)], properties = {}) => ({
  type: "Feature",
  properties: { id, name: `县 ${id}`, adcode: "370102", osmRelationId: 1234, adminLevel: "6", ...properties },
  geometry: { type: "Polygon", coordinates: rings },
});
const collection = (...features) => ({ type: "FeatureCollection", features });
const result = (matcher, lng, lat, status, id = null) => {
  const actual = matcher.assign(lng, lat);
  assert.deepEqual(Object.keys(actual).sort(), ["county", "status"]);
  assert.equal(actual.status, status);
  assert.equal(actual.county?.id ?? null, id);
  if (status !== "matched") assert.equal(actual.county, null);
  return actual;
};

// Independent O(edges) oracle is intentionally used only on small synthetic data.
function bruteRing(ring, x, y) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) <= 1e-10 * (Math.abs(bx - ax) + Math.abs(by - ay))
      && x >= Math.min(ax, bx) - 1e-10 && x <= Math.max(ax, bx) + 1e-10
      && y >= Math.min(ay, by) - 1e-10 && y <= Math.max(ay, by) + 1e-10) return 2;
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
  }
  return inside ? 1 : 0;
}

function detailedCircle(cx, cy, radius, size) {
  const ring = Array.from({ length: size }, (_, i) => {
    const angle = 2 * Math.PI * i / size;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
  ring.push([...ring[0]]);
  return ring;
}

test("FeatureCollection and features arrays yield frozen normalized metadata without mutating input", () => {
  const input = feature("370102", undefined, { name: "  县名  ", adcode: 370102, extra: "not copied" });
  const original = structuredClone(input);
  const matcher = prepareCountyMatcher(collection(input));
  assert.deepEqual(matcher.districts, [{ id: "370102", name: "县名", adcode: "370102", osmRelationId: "1234", adminLevel: 6 }]);
  assert.deepEqual(input, original);
  assert.ok(Object.isFrozen(matcher));
  assert.ok(Object.isFrozen(matcher.districts));
  assert.ok(Object.isFrozen(matcher.districts[0]));
  assert.equal(result(matcher, 116.5, 36.5, "matched", "370102").county, matcher.districts[0]);
  assert.throws(() => { matcher.districts[0].id = "changed"; }, TypeError);
  input.properties.id = "changed";
  input.geometry.coordinates[0][0][0] = 0;
  result(matcher, 116.5, 36.5, "matched", "370102");
  assert.deepEqual(prepareCountyMatcher([original]).districts, matcher.districts);
});

test("holes exclude their interiors but exterior and hole boundaries are included", () => {
  const outer = rectangle(116, 36, 117, 37);
  const hole = rectangle(116.3, 36.3, 116.7, 36.7);
  for (const rings of [[outer, hole], [[...outer].reverse(), [...hole].reverse()]]) {
    const matcher = prepareCountyMatcher([feature("370102", rings)]);
    for (const point of [[116.1, 36.1], [116, 36.5], [117, 37], [116, 36], [116.3, 36.5], [116.7, 36.7]]) {
      result(matcher, ...point, "matched", "370102");
    }
    for (const point of [[116.5, 36.5], [115.9, 36.5], [116.5, 37.1]]) result(matcher, ...point, "unmatched");
  }
});

test("MultiPolygon islands retain component-local holes and bbox gaps stay unmatched", () => {
  const county = feature("osm-r1234", undefined, { adcode: undefined });
  county.geometry = { type: "MultiPolygon", coordinates: [
    [rectangle(116, 36, 117, 37), rectangle(116.3, 36.3, 116.7, 36.7)],
    [rectangle(118, 36, 119, 37)],
    // An island inside a hole is another component, not a nested hole.
    [rectangle(116.4, 36.4, 116.6, 36.6)],
  ] };
  const matcher = prepareCountyMatcher([county]);
  for (const point of [[116.1, 36.1], [118.5, 36.5], [118, 36], [116.5, 36.5]]) result(matcher, ...point, "matched", "osm-r1234");
  for (const point of [[117.5, 36.5], [116.35, 36.35], [118.5, 35.9]]) result(matcher, ...point, "unmatched");
  assert.equal("adcode" in matcher.districts[0], false);
});

test("a hole-filling county's shared hole boundary is ambiguous, never arbitrarily assigned", () => {
  const outer = feature("370102", [rectangle(116, 36, 117, 37), rectangle(116.3, 36.3, 116.7, 36.7)]);
  const enclave = feature("370103", [rectangle(116.3, 36.3, 116.7, 36.7)]);
  for (const order of [[outer, enclave], [enclave, outer]]) {
    const matcher = prepareCountyMatcher(order);
    result(matcher, 116.5, 36.5, "matched", "370103");
    result(matcher, 116.1, 36.1, "matched", "370102");
    result(matcher, 116.3, 36.5, "ambiguous");
    result(matcher, 116.7, 36.7, "ambiguous");
  }
});

test("shared edges, vertices, and overlapping county interiors are ambiguous in either input order", () => {
  const left = feature("370102", [rectangle(116, 36, 117, 37)]);
  const right = feature("370103", [rectangle(117, 36, 118, 37)]);
  for (const order of [[left, right], [right, left]]) {
    const matcher = prepareCountyMatcher(order);
    result(matcher, 116.5, 36.5, "matched", "370102");
    result(matcher, 117.5, 36.5, "matched", "370103");
    result(matcher, 117, 36.5, "ambiguous");
    result(matcher, 117, 36, "ambiguous");
    result(matcher, 119, 36.5, "unmatched");
  }
  const overlap = prepareCountyMatcher([left, feature("370104", [rectangle(116.5, 36.5, 117.5, 37.5)])]);
  result(overlap, 116.75, 36.75, "ambiguous");
  result(overlap, 117, 37, "ambiguous");
  result(overlap, 117.25, 37.25, "matched", "370104");
});

test("concave edges and narrow bays use original segments rather than bbox or simplified boundaries", () => {
  const concave = [[116, 36], [117, 36], [117, 37], [116.500001, 37], [116.500001, 36.2],
    [116.5, 36.2], [116.5, 37], [116, 37], [116, 36]];
  const matcher = prepareCountyMatcher([feature("370102", [concave])]);
  result(matcher, 116.5000005, 36.5, "unmatched");
  result(matcher, 116.5, 36.5, "matched", "370102");
  result(matcher, 116.500001, 36.5, "matched", "370102");
  result(matcher, 116.5000005, 36.1, "matched", "370102");
});

test("band indexes agree with independent full-ring oracle across Y-band seams and detailed boundaries", () => {
  const ring = detailedCircle(116.5, 36.5, 0.4, 2048);
  const matcher = prepareCountyMatcher([feature("370102", [ring])]);
  for (let y = 0; y <= 50; y++) {
    for (let x = 0; x <= 50; x++) {
      const point = [116 + x / 50, 36 + y / 50];
      const expected = bruteRing(ring, ...point) === 0 ? "unmatched" : "matched";
      result(matcher, ...point, expected, expected === "matched" ? "370102" : null);
    }
  }
  for (let i = 0; i < ring.length - 1; i += 13) {
    const next = ring[i + 1];
    result(matcher, ...ring[i], "matched", "370102");
    result(matcher, (ring[i][0] + next[0]) / 2, (ring[i][1] + next[1]) / 2, "matched", "370102");
  }
  // A million queries exercise the hot path without any giant input corpus.
  let matched = 0;
  for (let i = 0; i < 1_000_000; i++) {
    const assigned = matcher.assign(116.5, i % 2 ? 36.5 : 35.5);
    if (assigned.status === "matched") matched++;
  }
  assert.equal(matched, 500_000);
});

test("Y-band index adapts for long spanning edges without losing exact containment", () => {
  const ring = Array.from({ length: 512 }, (_, i) => [116 + i / 512, i % 2 ? 36.8 : 36]);
  ring.push([117, 37], [116, 37], [...ring[0]]);
  const matcher = prepareCountyMatcher([feature("370102", [ring])]);
  for (let i = 0; i < 257; i++) {
    const point = [116 + (i + 0.3) / 258, 36 + (i % 17) / 17];
    const expected = bruteRing(ring, ...point) === 0 ? "unmatched" : "matched";
    result(matcher, ...point, expected, expected === "matched" ? "370102" : null);
  }
});

test("several detailed holes use separate band indexes and preserve their boundaries", () => {
  const first = detailedCircle(116.3, 36.5, 0.1, 512);
  const second = detailedCircle(116.7, 36.5, 0.1, 512);
  const matcher = prepareCountyMatcher([feature("370102", [rectangle(116, 36, 117, 37), first, second])]);
  result(matcher, 116.3, 36.5, "unmatched");
  result(matcher, 116.7, 36.5, "unmatched");
  result(matcher, 116.5, 36.5, "matched", "370102");
  for (let i = 0; i < first.length - 1; i += 29) {
    result(matcher, ...first[i], "matched", "370102");
    result(matcher, ...second[i], "matched", "370102");
  }
});

test("boundary epsilon is small and bbox prefilters do not drop near-boundary queries", () => {
  const matcher = prepareCountyMatcher([feature()]);
  result(matcher, 116 - 5e-11, 36.5, "matched", "370102");
  result(matcher, 116 - 1e-8, 36.5, "unmatched");
  result(matcher, 117 + 5e-11, 36.5, "matched", "370102");
  result(matcher, 117 + 1e-8, 36.5, "unmatched");
});

test("empty feature sets match nothing, and invalid query coordinates throw rather than guess", () => {
  const matcher = prepareCountyMatcher([]);
  assert.deepEqual(matcher.districts, []);
  result(matcher, -180, -90, "unmatched");
  result(matcher, 180, 90, "unmatched");
  for (const point of [[NaN, 36], [116, Infinity], ["116", 36], [116, null], [undefined, 36]]) {
    assert.throws(() => matcher.assign(...point), TypeError);
  }
  for (const point of [[-180.1, 36], [180.1, 36], [116, -90.1], [116, 90.1]]) {
    assert.throws(() => matcher.assign(...point), RangeError);
  }
});

test("rejects wrong collection/features/geometry types, empty components, and non-WGS84 declarations", () => {
  for (const input of [null, {}, { type: "FeatureCollection", features: {} }, [null], new Array(1), [{ type: "Polygon" }]]) {
    assert.throws(() => prepareCountyMatcher(input), /Invalid county GeoJSON/);
  }
  for (const geometry of [null, { type: "Point", coordinates: [116, 36] }, { type: "LineString", coordinates: rectangle(116, 36, 117, 37) },
    { type: "Polygon", coordinates: [] }, { type: "Polygon", coordinates: new Array(1) },
    { type: "MultiPolygon", coordinates: [] }, { type: "MultiPolygon", coordinates: new Array(1) }, { type: "MultiPolygon", coordinates: [[]] }]) {
    const input = feature();
    input.geometry = geometry;
    assert.throws(() => prepareCountyMatcher([input]), /Invalid county GeoJSON/);
  }
  const wrong = collection(feature());
  wrong.crs = { type: "name", properties: { name: "EPSG:3857" } };
  assert.throws(() => prepareCountyMatcher(wrong), /WGS84/);
  const namedWgs84 = collection(feature());
  namedWgs84.crs = { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } };
  result(prepareCountyMatcher(namedWgs84), 116.5, 36.5, "matched", "370102");
});

test("rejects unsafe/duplicate ids and malformed required metadata without coercing arbitrary values", () => {
  for (const id of ["", "..", "../县", "a/b", "a\\b", "a.b", "县", "-x", "x".repeat(129), "CON", "nul", "COM1", "unmatched", "ambiguous", 1234, null]) {
    assert.throws(() => prepareCountyMatcher([feature(id)]), /unsafe id/);
  }
  assert.throws(() => prepareCountyMatcher([feature(), feature()]), /duplicate county id/);
  assert.throws(() => prepareCountyMatcher([feature("osm-rA"), feature("osm-ra")]), /duplicate county id/);
  for (const properties of [{ name: "" }, { name: "\n" }, { name: 5 }, { name: "\u0000县" },
    { osmRelationId: 0 }, { osmRelationId: "01" }, { osmRelationId: "1e4" }, { osmRelationId: -1 }, { osmRelationId: Infinity },
    { osmRelationId: Number.MAX_SAFE_INTEGER + 1 }, { osmRelationId: "9007199254740992" }, { osmRelationId: undefined },
    { adminLevel: 0 }, { adminLevel: 13 }, { adminLevel: 6.5 }, { adminLevel: "06" }, { adminLevel: null },
    { adcode: "37010" }, { adcode: "370102/" }, { adcode: 37010 }, { adcode: null }]) {
    assert.throws(() => prepareCountyMatcher([feature("370102", undefined, properties)]), /Invalid county GeoJSON/);
  }
  const input = feature();
  input.properties = null;
  assert.throws(() => prepareCountyMatcher([input]), /properties/);
});

test("rejects nonfinite/out-of-range/malformed positions, unclosed or degenerate rings", () => {
  const badRings = [
    [], [[116, 36], [117, 36], [116, 36]],
    [[116, 36], [117, 36], [117, 37], [116, 37]],
    [[116, 36], [117, 36], [117, 37], [116 + 1e-12, 36]],
    [[116, 36], [117, 36], [117, 36], [116, 37], [116, 36]],
    [[116, 36], [117, 36], [118, 36], [116, 36]],
    [[179, 36], [-179, 36], [-179, 37], [179, 37], [179, 36]],
  ];
  for (const ring of badRings) assert.throws(() => prepareCountyMatcher([feature("370102", [ring])]), /Invalid county GeoJSON/);
  for (const point of [[NaN, 36], [116, Infinity], [181, 36], [116, 91], ["116", 36], [116], null, [116, 36, NaN], [116, 36, 0, 4]]) {
    const ring = rectangle(116, 36, 117, 37);
    ring[1] = point;
    assert.throws(() => prepareCountyMatcher([feature("370102", [ring])]));
  }
  const altitude = rectangle(116, 36, 117, 37).map(point => [...point, 12]);
  result(prepareCountyMatcher([feature("370102", [altitude])]), 116.5, 36.5, "matched", "370102");
});

test("rejects self-crossings/backtracking and misplaced, crossing, touching or nested holes", () => {
  const invalidRings = [
    [[116, 36], [117, 37], [116, 37], [117, 36], [116, 36]],
    // Nonzero signed area, so shoelace alone cannot validate this crossing.
    [[116, 36], [117, 37], [116, 36.8], [117, 36], [116, 36]],
    [[116, 36], [117, 36], [116.5, 36], [116.5, 37], [116, 37], [116, 36]],
    [[116, 36], [117, 36], [117, 37], [116.5, 36.5], [116, 37], [116.5, 36.5], [116, 36]],
  ];
  for (const ring of invalidRings) assert.throws(() => prepareCountyMatcher([feature("370102", [ring])]), /Invalid county GeoJSON/);
  const outer = rectangle(116, 36, 117, 37);
  const invalidHoles = [
    [rectangle(118, 36.2, 118.2, 36.4)],
    [rectangle(116.5, 36.5, 117.5, 37.5)],
    [rectangle(116, 36.2, 116.2, 36.4)],
    [rectangle(116.2, 36.2, 116.6, 36.6), rectangle(116.4, 36.4, 116.8, 36.8)],
    [rectangle(116.2, 36.2, 116.8, 36.8), rectangle(116.4, 36.4, 116.6, 36.6)],
    [rectangle(116.2, 36.2, 116.4, 36.4), rectangle(116.4, 36.2, 116.6, 36.4)],
  ];
  for (const holes of invalidHoles) assert.throws(() => prepareCountyMatcher([feature("370102", [outer, ...holes])]), /Invalid county GeoJSON/);
});

test("explicit county/edge/ring budgets reject giant input declarations before large allocations", () => {
  assert.throws(() => prepareCountyMatcher(Array.from({ length: 513 }, (_, index) => feature(`osm-r${index + 1}`))), /at most 512/);
  assert.throws(() => prepareCountyMatcher([feature("370102", [new Array(1_000_002)])]), /boundary size budget/);
  const county = feature();
  county.geometry = { type: "MultiPolygon", coordinates: new Array(16_385) };
  assert.throws(() => prepareCountyMatcher([county]), /boundary size budget/);
});
