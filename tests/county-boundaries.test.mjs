import assert from "node:assert/strict";
import test from "node:test";
import { prepareBoundarySnapshot } from "../tools/counties/boundaries.mjs";
import { prepareCountyMatcher } from "../tools/counties/geometry.mjs";

const city = { id: "533300", name: "怒江傈僳族自治州" };
const rectangle = (west = 98, south = 25, east = 99, north = 26) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];
const way = (ref, points, role = "outer") => ({
  type: "way", ref, role, geometry: points.map(([lon, lat]) => ({ lon, lat })),
});
const centre = (ref, lon, lat) => ({ type: "node", ref, role: "admin_centre", lon, lat });
const relation = (id, name, points = rectangle(), tags = {}, members = []) => ({
  type: "relation", id,
  tags: { type: "boundary", boundary: "administrative", admin_level: "6", name, ...tags },
  members: [...(points ? [way(id * 10, points)] : []), ...members],
});
const parent = (points = rectangle(98, 25, 101, 28), tags = {}, members = []) =>
  relation(100, city.name, points, { admin_level: "5", division_code: city.id, ...tags }, members);
const raw = (...elements) => ({ elements });
const prepare = (elements, parentElements) => prepareBoundarySnapshot({
  city, response: raw(...elements), parentResponse: parentElements ? raw(...parentElements) : undefined,
});
const countyIds = snapshot => snapshot.geometry.features.map(feature => feature.properties.osmRelationId);
const associated = (snapshot, id) => snapshot.metaFields.associations.find(item => item.osmRelationId === String(id));

// All test geometries are tiny synthetic fixtures. No network, real street-point
// datasets, raw files, browser, or nationwide polygon index is involved.
test("selects Nujiang by name at lowest level, not Gongshan's wrong 533300 code", () => {
  const gongshan = relation(200, "贡山独龙族怒族自治县", rectangle(98.2, 25.2, 98.8, 25.8),
    { division_code: "533300" }, [centre(2001, 98.5, 25.5)]);
  const namedParent = parent(undefined, { division_code: "533399" });
  const snapshot = prepare([gongshan, namedParent]);
  assert.equal(snapshot.metaFields.parentRelationId, "100");
  assert.equal(snapshot.metaFields.parentAdminLevel, 5);
  assert.equal(snapshot.metaFields.parentDivisionCode, "533399");
  assert.equal(snapshot.metaFields.parentSelectionBasis, "name-lowest-admin-level");
  assert.equal(snapshot.metaFields.parentUsable, true);
  assert.deepEqual(countyIds(snapshot), ["200"]);
  assert.equal(snapshot.geometry.features[0].properties.adcode, "533300");
  assert.equal(associated(snapshot, 200).status, "associated");
  assert.equal(snapshot.parentGeometry.properties.osmRelationId, "100");
});

test("name:zh or name match wins, then lowest numeric admin_level wins", () => {
  const province = relation(101, "English province", rectangle(98, 25, 102, 29),
    { "name:zh": city.name, admin_level: "4", division_code: "990000" });
  const countyNamesake = relation(102, city.name, rectangle(), { division_code: city.id });
  const snapshot = prepare([parent(), countyNamesake, province]);
  assert.equal(snapshot.metaFields.parentRelationId, "101");
  assert.equal(snapshot.metaFields.parentAdminLevel, 4);
  assert.equal(snapshot.parentGeometry.properties.name, city.name);
  const nameFallback = parent(undefined, { "name:zh": "Different Chinese name" });
  assert.equal(prepare([nameFallback]).metaFields.parentRelationId, "100");
});

test("code only breaks a same lowest-level named tie, never replaces a unique named parent", () => {
  const sameLevel = relation(101, city.name, rectangle(98, 25, 101, 28),
    { admin_level: "5", division_code: "533399" });
  const tied = prepare([sameLevel, parent()]);
  assert.equal(tied.metaFields.parentRelationId, "100");
  assert.equal(tied.metaFields.parentSelectionBasis, "name-lowest-admin-level-code-tiebreak");
  const lower = relation(103, city.name, rectangle(98, 25, 101, 28), { admin_level: "4" });
  assert.equal(prepare([sameLevel, parent(), lower]).metaFields.parentRelationId, "103");
});

test("ambiguous names and code-only parent candidates fail closed explicitly", () => {
  const sameLevel = relation(101, city.name, rectangle(), { admin_level: "5" });
  const ambiguous = prepare([parent(undefined, { division_code: undefined }), sameLevel]);
  assert.equal(ambiguous.parentGeometry, null);
  assert.equal(ambiguous.metaFields.parentUsable, false);
  assert.equal(ambiguous.metaFields.parentRelationId, null);
  assert.equal(ambiguous.metaFields.parentSelectionBasis, "ambiguous-name-matched-parent");
  assert.match(ambiguous.metaFields.rejected[0].reason, /must remain unmatched/);
  const codeOnly = prepare([relation(200, "贡山县", rectangle(), { division_code: city.id })]);
  assert.equal(codeOnly.parentGeometry, null);
  assert.equal(codeOnly.metaFields.parentUsable, false);
  assert.equal(codeOnly.metaFields.parentSelectionBasis, "no-name-matched-parent");
  assert.deepEqual(countyIds(codeOnly), ["200"]);
  assert.equal(associated(codeOnly, 200).status, "candidate");
});

test("prefers native member geometry across relation duplicates in either response order", () => {
  const rich = parent();
  const thin = { ...rich, bounds: { minlon: 98, minlat: 25, maxlon: 101, maxlat: 28 },
    members: rich.members.map(({ geometry, ...member }) => member) };
  const county = relation(200, "测试县", rectangle(), {}, [centre(2001, 98.5, 25.5)]);
  const countyThin = { ...county, members: county.members.filter(member => member.type !== "way") };
  for (const copies of [[thin, rich, countyThin, county], [rich, thin, county, countyThin]]) {
    const snapshot = prepare(copies, [thin]);
    assert.equal(snapshot.metaFields.parentUsable, true);
    assert.deepEqual(countyIds(snapshot), ["200"]);
    assert.deepEqual(snapshot.parentGeometry.geometry.coordinates, [rectangle(98, 25, 101, 28)]);
  }
  const fromParentResponse = prepare([thin, county], [rich]);
  assert.equal(fromParentResponse.metaFields.parentUsable, true);
});

test("admin centres outside actual concave parent are excluded even when bounds and code agree", () => {
  const concave = [[98, 25], [101, 25], [101, 26], [99, 26], [99, 28], [98, 28], [98, 25]];
  const inside = relation(200, "内县", rectangle(98.2, 26.2, 98.8, 26.8),
    { division_code: "990001" }, [centre(2001, 98.5, 26.5)]);
  const outside = relation(201, "邻市县", rectangle(100.2, 26.2, 100.8, 26.8),
    { division_code: "533301" }, [centre(2011, 100.5, 26.5)]);
  const snapshot = prepare([parent(concave), inside, outside]);
  assert.deepEqual(countyIds(snapshot), ["200"]);
  assert.equal(snapshot.metaFields.excluded.length, 1);
  assert.equal(snapshot.metaFields.excluded[0].osmRelationId, "201");
  assert.equal(associated(snapshot, 201).status, "excluded");
  assert.equal(associated(snapshot, 201).basis, "osm-admin-centre-point-in-parent");
  assert.deepEqual(associated(snapshot, 201).outsideAdminCentres, [{ ref: "2011", coordinates: [100.5, 26.5] }]);
  assert.equal(associated(snapshot, 200).status, "associated"); // No code-prefix requirement.
});

test("native parent hole and island fence drives exact admin-centre membership", () => {
  const main = rectangle(98, 25, 101, 28);
  const hole = rectangle(99, 26, 100, 27);
  const island = rectangle(104, 25, 105, 26);
  const counties = [
    relation(200, "洞内县", rectangle(99.2, 26.2, 99.8, 26.8), {}, [centre(2001, 99.5, 26.5)]),
    relation(201, "岛县", rectangle(104.2, 25.2, 104.8, 25.8), {}, [centre(2011, 104.5, 25.5)]),
    relation(202, "两岛之间", rectangle(102.2, 25.2, 102.8, 25.8), {}, [centre(2021, 102.5, 25.5)]),
    relation(203, "洞界县", rectangle(98.8, 26.2, 99.2, 26.8), {}, [centre(2031, 99, 26.5)]),
  ];
  const snapshot = prepare([parent(main, {}, [way(1001, hole, "inner"), way(1002, island)]), ...counties]);
  assert.equal(snapshot.parentGeometry.geometry.type, "MultiPolygon");
  assert.deepEqual(countyIds(snapshot), ["201", "203"]);
  assert.deepEqual(snapshot.metaFields.excluded.map(item => item.osmRelationId), ["200", "202"]);
  const fence = prepareCountyMatcher([snapshot.parentGeometry]);
  assert.equal(fence.assign(99.5, 26.5).status, "unmatched");
  assert.equal(fence.assign(104.5, 25.5).status, "matched");
  assert.equal(fence.assign(102.5, 25.5).status, "unmatched");
  assert.equal(fence.assign(99, 26.5).status, "matched");
});

test("only explicit OSM admin_centre nodes count; no label, bbox, center, or polygon average", () => {
  const noCentre = relation(200, "未核实县", rectangle(102, 25, 103, 26), {}, [
    { type: "node", ref: 2001, role: "label", lon: 98.5, lat: 25.5 },
  ]);
  noCentre.center = { lon: 98.5, lat: 25.5 };
  noCentre.bounds = { minlon: 98, minlat: 25, maxlon: 99, maxlat: 26 };
  const snapshot = prepare([parent(), noCentre]);
  assert.deepEqual(countyIds(snapshot), ["200"]);
  assert.equal(associated(snapshot, 200).status, "candidate");
  assert.equal(associated(snapshot, 200).basis, "no-osm-admin-centre-parent-fence-required");
  assert.deepEqual(associated(snapshot, 200).adminCentreRefs, []);
  assert.equal(snapshot.metaFields.parentFenceRequired, true);
  assert.match(associated(snapshot, 200).reason, /publisher must apply native parent geometry fence/);
});

test("uses referenced real OSM nodes but unresolved, invalid, and non-node centres stay candidates", () => {
  const referenced = relation(200, "实节点县", rectangle(), {}, [{ type: "node", ref: 2001, role: "admin_centre" }]);
  const unresolved = relation(201, "缺节点县", rectangle(), {}, [{ type: "node", ref: 2011, role: "admin_centre" }]);
  const invalid = relation(202, "坏坐标县", rectangle(), {}, [centre(2021, "98.5", 25.5)]);
  const wayCentre = relation(203, "非节点中心", rectangle(), {}, [{ type: "way", ref: 2031, role: "admin_centre" }]);
  const snapshot = prepare([parent(), referenced, unresolved, invalid, wayCentre,
    { type: "node", id: 2001, lon: 98.5, lat: 25.5 }]);
  assert.equal(associated(snapshot, 200).status, "associated");
  for (const id of [201, 202, 203]) {
    assert.equal(associated(snapshot, id).status, "candidate");
    assert.equal(associated(snapshot, id).unresolvedAdminCentres, 1);
    assert.equal(associated(snapshot, id).basis, "unresolved-osm-admin-centre-parent-fence-required");
  }
});

test("any resolved outside admin centre excludes; conflicting referenced nodes never silently win", () => {
  const mixed = relation(200, "多中心县", rectangle(), {}, [centre(2001, 98.5, 25.5), centre(2002, 103, 25.5)]);
  const conflict = relation(201, "冲突节点县", rectangle(), {}, [{ type: "node", ref: 2011, role: "admin_centre" }]);
  const inlineConflict = relation(202, "内嵌冲突节点县", rectangle(), {}, [centre(2021, 98.5, 25.5)]);
  const snapshot = prepare([parent(), mixed, conflict, inlineConflict, { type: "node", id: 2011, lon: 98.5, lat: 25.5 }],
    [{ type: "node", id: 2011, lon: 103, lat: 25.5 }, { type: "node", id: 2021, lon: 103, lat: 25.5 }]);
  assert.deepEqual(countyIds(snapshot), []);
  assert.deepEqual(snapshot.metaFields.excluded.map(item => item.osmRelationId), ["200", "201", "202"]);
});

test("a crossing county remains centre-associated, not polygon-contained; parent fence is mandatory", () => {
  const crossing = relation(200, "跨界候选", rectangle(100, 25.2, 102, 25.8), {}, [centre(2001, 100.5, 25.5)]);
  const snapshot = prepare([parent(), crossing]);
  assert.deepEqual(countyIds(snapshot), ["200"]);
  assert.equal(associated(snapshot, 200).basis, "osm-admin-centre-point-in-parent");
  const counties = prepareCountyMatcher(snapshot.geometry);
  const fence = prepareCountyMatcher([snapshot.parentGeometry]);
  assert.equal(counties.assign(101.5, 25.5).status, "matched");
  assert.equal(fence.assign(101.5, 25.5).status, "unmatched");
  assert.equal(snapshot.metaFields.parentFenceRequired, true);
  assert.match(snapshot.metaFields.associationCaveat, /not full county-polygon intersection/);
});

test("a direct-admin level-6 city is included as its own county and independent parent", () => {
  const directCity = { id: "469001", name: "五指山市" };
  const direct = relation(300, directCity.name, rectangle(), { division_code: directCity.id });
  const snapshot = prepareBoundarySnapshot({ city: directCity, response: raw(direct) });
  assert.equal(snapshot.metaFields.parentAdminLevel, 6);
  assert.deepEqual(countyIds(snapshot), ["300"]);
  assert.equal(associated(snapshot, 300).basis, "parent-relation-self");
  assert.equal(associated(snapshot, 300).status, "associated");
  assert.notEqual(snapshot.parentGeometry, snapshot.geometry.features[0]);
  snapshot.parentGeometry.geometry.coordinates[0][0][0] = 0;
  assert.equal(snapshot.geometry.features[0].geometry.coordinates[0][0][0], 98);
});

test("parent missing geometry or invalid coordinates explicitly returns null/false, never bounds", () => {
  const missing = parent(null);
  missing.bounds = { minlon: 98, minlat: 25, maxlon: 101, maxlat: 28 };
  const county = relation(200, "县", rectangle(), {}, [centre(2001, 98.5, 25.5)]);
  const malformed = parent();
  malformed.members[0].geometry[1].lon = 181;
  for (const unusable of [missing, malformed]) {
    const snapshot = prepare([unusable, county]);
    assert.equal(snapshot.metaFields.parentUsable, false);
    assert.equal(snapshot.parentGeometry, null);
    assert.equal(snapshot.metaFields.parentRelationId, "100");
    assert.equal(snapshot.metaFields.associationBasis, "unusable-parent-no-spatial-association");
    assert.equal(snapshot.metaFields.rejected[0].scope, "parent");
    assert.match(snapshot.metaFields.rejected[0].reason, /no outer ring|outside WGS84/);
    assert.equal(associated(snapshot, 200).status, "candidate");
    assert.match(associated(snapshot, 200).reason, /publication must remain unmatched/);
  }
});

test("records rejected counties while legitimate label/admin_centre/subarea members remain legal", () => {
  const broken = relation(200, "缺界县", null);
  const nested = relation(201, "嵌套县", rectangle(), {}, [{ type: "relation", ref: 2000, role: "outer" }]);
  const legal = relation(202, "合法县", rectangle(), {}, [
    { type: "node", ref: 2021, role: "label", lon: 98.5, lat: 25.5 },
    { type: "node", ref: 2022, role: "admin_centre" },
    { type: "relation", ref: 2023, role: "subarea" },
  ]);
  const malformed = { ...relation(203, "坏members县"), members: {} };
  const malformedCopy = structuredClone(malformed);
  const snapshot = prepare([parent(), broken, nested, legal, malformed, malformedCopy]);
  assert.deepEqual(countyIds(snapshot), ["202"]);
  assert.deepEqual(snapshot.metaFields.rejected.map(item => item.osmRelationId), ["200", "201", "203"]);
  assert.match(snapshot.metaFields.rejected[0].reason, /no outer ring/);
  assert.match(snapshot.metaFields.rejected[1].reason, /nested relation geometry/);
  assert.match(snapshot.metaFields.rejected[2].reason, /members array/);
  assert.equal(associated(snapshot, 202).status, "candidate");
});

test("duplicate retained OSM adcodes use relation ids without losing adcode or conflict evidence", () => {
  const counties = [200, 201].map((id, index) => relation(id, `县${index}`, rectangle(98 + index, 25, 99 + index, 26),
    { division_code: "533301" }, [centre(id * 10 + 1, 98.5 + index, 25.5)]));
  const snapshot = prepare([parent(), ...counties, structuredClone(counties[0])]);
  assert.deepEqual(snapshot.geometry.features.map(feature => feature.properties.id), ["osm-r200", "osm-r201"]);
  assert.deepEqual(snapshot.geometry.features.map(feature => feature.properties.adcode), ["533301", "533301"]);
  assert.deepEqual(snapshot.metaFields.idConflicts, [
    { adcode: "533301", osmRelationId: "200", name: "县0", id: "osm-r200" },
    { adcode: "533301", osmRelationId: "201", name: "县1", id: "osm-r201" },
  ]);
  assert.equal(associated(snapshot, 200).id, "osm-r200");
  assert.equal(prepareCountyMatcher(snapshot.geometry).districts.length, 2);
});

test("excluded duplicate adcode cannot alter retained county id; snapshot never mutates inputs", () => {
  const county = relation(200, "内县", rectangle(), { division_code: "533301" }, [centre(2001, 98.5, 25.5)]);
  const outside = relation(201, "外县", rectangle(102, 25, 103, 26), { division_code: "533301" }, [centre(2011, 102.5, 25.5)]);
  const response = raw(parent(), county, outside);
  const original = structuredClone(response);
  const snapshot = prepareBoundarySnapshot({ city, response });
  assert.equal(snapshot.geometry.features[0].properties.id, "533301");
  assert.deepEqual(snapshot.metaFields.idConflicts, []);
  assert.deepEqual(response, original);
  snapshot.geometry.features[0].geometry.coordinates[0][0][0] = 0;
  assert.deepEqual(response, original);
});

test("invalid API envelopes fail explicitly and empty complete response stays unfenced", () => {
  for (const response of [undefined, {}, { elements: null }, { elements: [], remark: "runtime error" }]) {
    assert.throws(() => prepareBoundarySnapshot({ city, response }), /complete Overpass elements/);
  }
  assert.throws(() => prepareBoundarySnapshot({ city, response: raw(), parentResponse: { remark: "timeout", elements: [] } }), /parent response/);
  assert.throws(() => prepareBoundarySnapshot({ city: { id: "../x", name: "x" }, response: raw() }), /Invalid boundary city/);
  const snapshot = prepare([]);
  assert.deepEqual(snapshot.geometry, { type: "FeatureCollection", features: [] });
  assert.equal(snapshot.parentGeometry, null);
  assert.equal(snapshot.metaFields.parentUsable, false);
});
