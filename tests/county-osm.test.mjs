import assert from "node:assert/strict";
import test from "node:test";
import { relationToFeature } from "../tools/counties/osm-convert.mjs";
import { prepareCountyMatcher } from "../tools/counties/geometry.mjs";

const rectangle = (west = 116, south = 36, east = 117, north = 37) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];
const way = (ref, points, role = "outer") => ({
  type: "way", ref, role, geometry: points.map(([lon, lat]) => ({ lat, lon })),
});
const relation = (members = [way(1, rectangle())], tags = {}, extra = {}) => ({
  type: "relation", id: 4434114, members,
  tags: { type: "boundary", boundary: "administrative", admin_level: "6", name: "English county", "name:zh": "测试县", division_code: "370102", ...tags },
  ...extra,
});
const convert = (members, tags, extra) => relationToFeature(relation(members, tags, extra));
const reject = (members, pattern, tags, extra) => assert.throws(() => convert(members, tags, extra), pattern);

function fragmented(points, firstRef = 1, role = "outer") {
  return [
    way(firstRef, points.slice(0, 3), role),
    way(firstRef + 1, points.slice(2).reverse(), role),
  ];
}

function canonicalRing(ring) {
  const vertices = ring.slice(0, -1).map(position => JSON.stringify(position));
  const rotations = [];
  for (const order of [vertices, [...vertices].reverse()]) {
    for (let i = 0; i < order.length; i++) rotations.push([...order.slice(i), ...order.slice(0, i)].join(";"));
  }
  return rotations.sort()[0];
}

function assertSameRing(actual, expected) {
  assert.equal(actual.length, expected.length);
  assert.deepEqual(actual[0], actual[actual.length - 1]);
  assert.equal(canonicalRing(actual), canonicalRing(expected));
}

test("closed real-format way preserves precise WGS84 numbers and required metadata", () => {
  const ring = [
    [117.33505151234567, 37.06941581234567],
    [117.35321201234567, 37.06717271234567],
    [117.35984641234567, 37.08753161234567],
    [117.33505151234567, 37.06941581234567],
  ];
  const input = relation([way(785737306, ring)], {}, { version: 8 });
  const original = structuredClone(input);
  const output = relationToFeature(input);
  assert.deepEqual(output, {
    type: "Feature",
    properties: { id: "370102", name: "测试县", osmRelationId: "4434114", adminLevel: 6, adcode: "370102", osmVersion: 8 },
    geometry: { type: "Polygon", coordinates: [ring] },
  });
  assert.deepEqual(input, original);
  input.members[0].geometry[0].lon = 0;
  assert.equal(output.geometry.coordinates[0][0][0], ring[0][0]);
  output.geometry.coordinates[0][1][0] = 0;
  assert.equal(input.members[0].geometry[1].lon, ring[1][0]);
});

test("division_code is accepted only as six digits; id and name fallbacks never infer from bounds", () => {
  for (const division_code of [undefined, "", "37010", "3701020", " 370102 ", "ABC102", {}, NaN]) {
    const output = convert(undefined, { division_code, "name:zh": "" });
    assert.deepEqual(output.properties, { id: "osm-r4434114", name: "English county", osmRelationId: "4434114", adminLevel: 6 });
  }
  for (const division_code of [370102, "370102"]) assert.equal(convert(undefined, { division_code }).properties.adcode, "370102");
  assert.equal(convert(undefined, {}, { id: "4434114" }).properties.osmRelationId, "4434114");
});

test("unordered forward and reversed outer fragments join without losing intermediate vertices", () => {
  const ring = [[116, 36], [116.4, 36], [117, 36], [117, 37], [116.2, 37], [116, 37], [116, 36]];
  const fragments = [
    way(11, ring.slice(2, 5).reverse()),
    way(12, ring.slice(0, 3)),
    way(13, ring.slice(4).reverse()),
  ];
  for (const members of [fragments, [...fragments].reverse()]) {
    const output = convert(members);
    assertSameRing(output.geometry.coordinates[0], ring);
  }
});

test("outer and inner orientation are retained but do not affect hole exclusion", () => {
  const outer = rectangle(116, 36, 119, 39);
  const holeA = rectangle(116.2, 36.2, 116.8, 36.8);
  const holeB = rectangle(117.2, 37.2, 117.8, 37.8);
  for (const reversed of [false, true]) {
    const rings = [outer, holeA, holeB].map(ring => reversed ? [...ring].reverse() : ring);
    const output = convert([
      ...fragmented(rings[1], 5, "inner"),
      ...fragmented(rings[0], 1),
      way(9, rings[2], "inner"),
    ]);
    assert.equal(output.geometry.type, "Polygon");
    assert.equal(output.geometry.coordinates.length, 3);
    assertSameRing(output.geometry.coordinates[0], rings[0]);
    assert.deepEqual(output.geometry.coordinates.slice(1).map(canonicalRing).sort(), rings.slice(1).map(canonicalRing).sort());
    const matcher = prepareCountyMatcher([output]);
    assert.equal(matcher.assign(118, 38).status, "matched");
    assert.equal(matcher.assign(116.5, 36.5).status, "unmatched");
    assert.equal(matcher.assign(117.5, 37.5).status, "unmatched");
  }
});

test("multiple islands map each hole to its owning outer even with inners first", () => {
  const outerA = rectangle(116, 36, 117, 37);
  const outerB = rectangle(118, 36, 119, 37);
  const holeA = rectangle(116.2, 36.2, 116.8, 36.8);
  const holeB = rectangle(118.2, 36.2, 118.8, 36.8);
  const output = convert([
    way(6, holeB, "inner"), way(5, holeA, "inner"),
    ...fragmented(outerA, 1), way(3, outerB),
  ]);
  assert.equal(output.geometry.type, "MultiPolygon");
  assert.equal(output.geometry.coordinates.length, 2);
  const components = new Map(output.geometry.coordinates.map(rings => [canonicalRing(rings[0]), rings]));
  assertSameRing(components.get(canonicalRing(outerA))[1], holeA);
  assertSameRing(components.get(canonicalRing(outerB))[1], holeB);
  const matcher = prepareCountyMatcher([output]);
  assert.equal(matcher.assign(117.5, 36.5).status, "unmatched"); // Not the relation bounds.
  assert.equal(matcher.assign(118.1, 36.1).status, "matched");
  assert.equal(matcher.assign(118.5, 36.5).status, "unmatched");
});

test("an outer island inside a hole remains an independent component", () => {
  const output = convert([
    way(1, rectangle(116, 36, 119, 39)),
    way(2, rectangle(117.2, 37.2, 117.8, 37.8)),
    way(3, rectangle(117, 37, 118, 38), "inner"),
  ]);
  assert.deepEqual(output.geometry.coordinates.map(rings => rings.length), [2, 1]);
  const matcher = prepareCountyMatcher([output]);
  assert.equal(matcher.assign(117.5, 37.5).status, "matched");
  assert.equal(matcher.assign(117.1, 37.1).status, "unmatched");
});

test("identical and reversed duplicate refs deduplicate; conflicting duplicates refuse", () => {
  const fragments = fragmented(rectangle());
  const output = convert([...fragments, structuredClone(fragments[0]), way(1, rectangle().slice(0, 3).reverse())]);
  assertSameRing(output.geometry.coordinates[0], rectangle());
  reject([way(1, rectangle()), way(1, rectangle(), "inner")], /conflicting duplicate/);
  reject([way(1, rectangle()), way(1, rectangle(116, 36, 118, 37))], /conflicting duplicate/);
});

test("legitimate label, admin_centre, and subarea members need no geometry", () => {
  const output = convert([
    { type: "node", ref: 244082551, role: "label", lat: 36.8629315, lon: 117.7369950 },
    { type: "node", ref: 2, role: "admin_centre" },
    { type: "relation", ref: 3, role: "subarea" },
    way(1, rectangle()),
  ]);
  assert.deepEqual(output.geometry.coordinates, [rectangle()]);
});

test("empty way role defaults outer only for boundary type; unknown or nested roles refuse", () => {
  assert.deepEqual(convert([way(1, rectangle(), "")]).geometry.coordinates, [rectangle()]);
  reject([way(1, rectangle(), "")], /unsupported boundary role/, { type: "multipolygon" });
  reject([way(1, rectangle(), "unexpected")], /unsupported boundary role/);
  reject([{ type: "relation", ref: 123, role: "outer" }], /fetch and resolve nested relation geometry/);
  reject([{ type: "relation", ref: 123, role: "inner" }, way(1, rectangle())], /fetch and resolve nested relation geometry/);
  reject([{ type: "node", ref: 123, role: "outer", lon: 116, lat: 36 }], /not a way/);
});

test("missing or partial geometry and bbox-only relations refuse rather than manufacture a ring", () => {
  const bounds = { minlat: 36, minlon: 116, maxlat: 37, maxlon: 117 };
  reject([], /no outer ring/, {}, { bounds });
  reject(undefined, /members array/, {}, { members: undefined, bounds });
  reject([{ type: "way", ref: 1, role: "outer" }], /missing or partial geometry/);
  reject([way(1, [[116, 36]])], /missing or partial geometry/);
  reject([{ type: "way", ref: 1, role: "outer", geometry: [{ lon: 116, lat: 36 }, null] }], /finite numeric lon\/lat/);
});

test("dangling, open, and almost-matching endpoints refuse artificial closure or coordinate snapping", () => {
  reject([way(1, rectangle().slice(0, -1))], /dangling\/open/);
  reject([...fragmented(rectangle()), way(3, [[118, 37], [118, 38]])], /dangling\/open/);
  const members = fragmented(rectangle());
  members[1].geometry[members[1].geometry.length - 1].lon += 1e-12;
  reject(members, /dangling\/open/);
});

test("degree-four shared fragment endpoints refuse ambiguous pairing; closed independent islands work", () => {
  const first = rectangle(116, 36, 117, 37);
  const second = rectangle(117, 37, 118, 38);
  const edges = [...first.slice(0, -1).map((point, i) => way(i + 1, [point, first[i + 1]])),
    ...second.slice(0, -1).map((point, i) => way(i + 5, [point, second[i + 1]]))];
  reject(edges, /ambiguous branched endpoint/);
  const output = convert([way(1, first), way(2, second)]);
  assert.equal(output.geometry.type, "MultiPolygon");
  assert.equal(output.geometry.coordinates.length, 2);
});

test("orphan and multiply-contained holes refuse ambiguous outer assignment", () => {
  reject([way(1, rectangle()), way(2, rectangle(118, 38, 119, 39), "inner")], /no strictly containing outer/);
  reject([
    way(1, rectangle(116, 36, 120, 40)), way(2, rectangle(117, 37, 119, 39)),
    way(3, rectangle(117.2, 37.2, 117.8, 37.8), "inner"),
  ], /ambiguous outer ownership/);
});

test("full topology validation refuses self-intersection, degeneracy, duplicate vertices, and backtracking", () => {
  reject([way(1, [[116, 36], [117, 37], [116, 37], [117, 36], [116, 36]])], /degenerate|self-intersecting/);
  reject([way(1, [[116, 36], [119, 39], [116, 39], [118, 36], [116, 36]])], /self-intersecting/);
  reject([way(1, [[116, 36], [116.5, 36], [117, 36], [116, 36]])], /degenerate|backtracking/);
  reject([way(1, [[116, 36], [117, 36], [117, 36], [117, 37], [116, 36]])], /consecutive duplicate/);
  reject([way(1, [[116, 36], [117, 36], [116.5, 36], [117, 37], [116, 36]])], /backtracking/);
  reject([way(1, [[116, 36], [117, 36], [116, 36]])], /too short/);
});

test("holes must remain fully inside nonconvex outer without touching or crossing", () => {
  // Hole's first vertex is inside and its bbox fits, but its right edge leaves the L-shaped outer.
  const concave = [[116, 36], [119, 36], [119, 37], [117, 37], [117, 39], [116, 39], [116, 36]];
  reject([way(1, concave), way(2, rectangle(116.5, 36.5, 118, 38), "inner")], /hole.*strictly within/);
  reject([way(1, rectangle()), way(2, rectangle(116.2, 36.2, 117, 36.8), "inner")], /hole.*strictly within/);
  reject([
    way(1, rectangle(116, 36, 120, 40)), way(2, rectangle(117, 37, 119, 39), "inner"),
    way(3, rectangle(117.2, 37.2, 117.8, 37.8), "inner"),
  ], /holes.*overlap, touch, or nest/);
});

test("nonfinite, nonnumeric, and out-of-range coordinates refuse", () => {
  for (const lon of [NaN, Infinity, "116", undefined, 181]) {
    const member = way(1, rectangle());
    member.geometry[1].lon = lon;
    reject([member], /finite numeric|outside WGS84/);
  }
  for (const lat of [NaN, -Infinity, "36", null, -91]) {
    const member = way(1, rectangle());
    member.geometry[1].lat = lat;
    reject([member], /finite numeric|outside WGS84/);
  }
});

test("invalid relation ids, member refs, names, admin levels, and versions refuse", () => {
  assert.throws(() => relationToFeature(null), /expected an Overpass relation/);
  assert.throws(() => relationToFeature({ type: "way" }), /expected an Overpass relation/);
  for (const id of [undefined, null, 0, -1, 1.5, "01", "../1", Number.MAX_SAFE_INTEGER + 1]) reject(undefined, /relation id/, {}, { id });
  reject([way(0, rectangle())], /member 0 ref/);
  reject(undefined, /name:zh or name/, { "name:zh": "", name: "" });
  reject(undefined, /tags are required/, {}, { tags: undefined });
  for (const admin_level of [undefined, "", "6x", "06", " 6 ", 0, 13, 6.5]) reject(undefined, /admin_level/, { admin_level });
  for (const version of [0, -1, 1.5, "2"]) reject(undefined, /relation version/, {}, { version });
});

test("oversized sparse coordinate/member lists fail their budget before allocation or geometry iteration", () => {
  // A sparse length-only fixture is tiny: no million-point source dataset or scan.
  const oversized = { type: "way", ref: 1, role: "outer", geometry: new Array(1_000_001) };
  reject([oversized], /coordinate budget exceeds 1000000/);
  reject(undefined, /member budget exceeded/, {}, { members: new Array(500_001) });
});
