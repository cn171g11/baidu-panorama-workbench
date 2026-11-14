// WGS84-only county matching. No projection, boundary simplification, or inference.
// Budgets bound the additional index memory and reject pathological input up front.
const EPSILON = 1e-10; // degrees; used only to make exact boundary tests stable.
const MAX_COUNTIES = 512;
const MAX_EDGES = 1_000_000;
const MAX_RINGS = 16_384;
const MAX_INDEX_REFERENCES = 8_000_000;
const MAX_VALIDATION_WORK = 50_000_000;
const MAX_BANDS = 4096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const WGS84_NAMES = new Set([
  "EPSG:4326", "urn:ogc:def:crs:EPSG::4326",
  "urn:ogc:def:crs:OGC:1.3:CRS84", "OGC:CRS84",
]);

function fail(message) {
  throw new TypeError(`Invalid county GeoJSON: ${message}`);
}

function validateCoordinate(lng, lat, label) {
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new TypeError(`${label} must contain finite numeric longitude and latitude`);
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new RangeError(`${label} is outside WGS84 longitude/latitude ranges`);
  }
}

function validateCrs(value, label) {
  if (value === undefined) return;
  if (!value || value.type !== "name" || !WGS84_NAMES.has(value.properties?.name)) {
    fail(`${label} CRS must be WGS84 (longitude, latitude)`);
  }
}

function normalizeProperties(properties, index) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) fail(`feature ${index} properties are required`);
  const { id, name } = properties;
  if (typeof id !== "string" || !SAFE_ID.test(id) || RESERVED_ID.test(id)
    || id.toLowerCase() === "unmatched" || id.toLowerCase() === "ambiguous") fail(`feature ${index} has an unsafe id`);
  if (typeof name !== "string" || !name.trim() || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail(`feature ${id} name must be a nonempty, bounded string`);
  }
  const relation = properties.osmRelationId;
  if (!((typeof relation === "number" && Number.isSafeInteger(relation) && relation > 0)
    || (typeof relation === "string" && /^[1-9]\d{0,15}$/.test(relation) && Number.isSafeInteger(Number(relation))))) {
    fail(`feature ${id} osmRelationId must be a positive safe integer or decimal string`);
  }
  const level = properties.adminLevel;
  if (!((typeof level === "number" && Number.isInteger(level))
    || (typeof level === "string" && /^(?:[1-9]|1[0-2])$/.test(level)))
    || Number(level) < 1 || Number(level) > 12) {
    fail(`feature ${id} adminLevel must be an integer from 1 to 12`);
  }
  const normalized = { id, name: name.trim(), osmRelationId: String(relation), adminLevel: Number(level) };
  if (properties.adcode !== undefined) {
    const code = properties.adcode;
    if (!((typeof code === "string" && /^\d{6}$/.test(code))
      || (typeof code === "number" && Number.isInteger(code) && code >= 100000 && code <= 999999))) {
      fail(`feature ${id} adcode must be a six-digit code`);
    }
    normalized.adcode = String(code);
  }
  return Object.freeze(normalized);
}

function insideBounds(bounds, lng, lat) {
  return lng >= bounds[0] - EPSILON && lng <= bounds[2] + EPSILON
    && lat >= bounds[1] - EPSILON && lat <= bounds[3] + EPSILON;
}

function boundsOverlap(a, b) {
  return a[0] <= b[2] + EPSILON && b[0] <= a[2] + EPSILON
    && a[1] <= b[3] + EPSILON && b[1] <= a[3] + EPSILON;
}

function addBounds(target, bounds) {
  target[0] = Math.min(target[0], bounds[0]);
  target[1] = Math.min(target[1], bounds[1]);
  target[2] = Math.max(target[2], bounds[2]);
  target[3] = Math.max(target[3], bounds[3]);
}

function bandAt(ring, y) {
  return Math.max(0, Math.min(ring.bandCount - 1, Math.floor((y - ring.bounds[1]) * ring.bandScale)));
}

function edgeBands(ring, edge) {
  const coords = ring.coords;
  const next = edge + 1 === ring.size ? 0 : edge + 1;
  return [bandAt(ring, Math.min(coords[edge * 2 + 1], coords[next * 2 + 1]) - EPSILON),
    bandAt(ring, Math.max(coords[edge * 2 + 1], coords[next * 2 + 1]) + EPSILON)];
}

function buildBands(ring, budget) {
  let count = Math.min(MAX_BANDS, Math.max(1, Math.ceil(ring.size / 24)));
  let counts;
  let references;
  // Full-height edges would otherwise replicate into thousands of bands.
  // Adapt only the index resolution; every original segment is retained.
  do {
    ring.bandCount = count;
    ring.bandScale = count / (ring.bounds[3] - ring.bounds[1]);
    references = 0;
    for (let edge = 0; edge < ring.size; edge++) {
      const [first, last] = edgeBands(ring, edge);
      references += last - first + 1;
    }
    if (references <= ring.size * 8) break;
    count = Math.max(1, Math.floor(count / 2));
  } while (true);
  budget.references += references;
  if (budget.references > MAX_INDEX_REFERENCES) fail("Y-band index memory budget exceeded");
  counts = new Uint32Array(count);
  for (let edge = 0; edge < ring.size; edge++) {
    const [first, last] = edgeBands(ring, edge);
    for (let band = first; band <= last; band++) counts[band]++;
  }
  const offsets = new Uint32Array(count + 1);
  for (let band = 0; band < count; band++) offsets[band + 1] = offsets[band] + counts[band];
  const edges = new Uint32Array(references);
  const cursors = offsets.slice(0, count);
  for (let edge = 0; edge < ring.size; edge++) {
    const [first, last] = edgeBands(ring, edge);
    for (let band = first; band <= last; band++) edges[cursors[band]++] = edge;
  }
  ring.offsets = offsets;
  ring.edges = edges;
}

function orientation(ax, ay, bx, by, x, y) {
  const dx = bx - ax;
  const dy = by - ay;
  const cross = dx * (y - ay) - dy * (x - ax);
  const tolerance = EPSILON * (Math.abs(dx) + Math.abs(dy));
  return Math.abs(cross) <= tolerance ? 0 : cross < 0 ? -1 : 1;
}

function onSegment(ax, ay, bx, by, x, y) {
  return x >= Math.min(ax, bx) - EPSILON && x <= Math.max(ax, bx) + EPSILON
    && y >= Math.min(ay, by) - EPSILON && y <= Math.max(ay, by) + EPSILON
    && orientation(ax, ay, bx, by, x, y) === 0;
}

// 0 = exterior, 1 = strict interior, 2 = boundary. The horizontal ray only
// visits edges in the query's Y-band, including epsilon-expanded boundary edges.
function classifyRing(ring, lng, lat) {
  if (!insideBounds(ring.bounds, lng, lat)) return 0;
  const coords = ring.coords;
  const band = bandAt(ring, lat);
  let inside = false;
  for (let slot = ring.offsets[band]; slot < ring.offsets[band + 1]; slot++) {
    const edge = ring.edges[slot];
    const current = edge * 2;
    const next = edge + 1 === ring.size ? 0 : current + 2;
    const ax = coords[current];
    const ay = coords[current + 1];
    const bx = coords[next];
    const by = coords[next + 1];
    if (onSegment(ax, ay, bx, by, lng, lat)) return 2;
    if ((ay > lat) !== (by > lat) && lng < ax + (lat - ay) * (bx - ax) / (by - ay)) inside = !inside;
  }
  return inside ? 1 : 0;
}

function segmentsIntersect(a, edgeA, b, edgeB) {
  const ac = a.coords;
  const bc = b.coords;
  const ai = edgeA * 2;
  const aj = edgeA + 1 === a.size ? 0 : ai + 2;
  const bi = edgeB * 2;
  const bj = edgeB + 1 === b.size ? 0 : bi + 2;
  const ax = ac[ai]; const ay = ac[ai + 1];
  const bx = ac[aj]; const by = ac[aj + 1];
  const cx = bc[bi]; const cy = bc[bi + 1];
  const dx = bc[bj]; const dy = bc[bj + 1];
  if (Math.max(ax, bx) < Math.min(cx, dx) - EPSILON || Math.max(cx, dx) < Math.min(ax, bx) - EPSILON
    || Math.max(ay, by) < Math.min(cy, dy) - EPSILON || Math.max(cy, dy) < Math.min(ay, by) - EPSILON) return false;
  const abc = orientation(ax, ay, bx, by, cx, cy);
  const abd = orientation(ax, ay, bx, by, dx, dy);
  const cda = orientation(cx, cy, dx, dy, ax, ay);
  const cdb = orientation(cx, cy, dx, dy, bx, by);
  return (abc !== 0 && abd !== 0 && cda !== 0 && cdb !== 0 && abc !== abd && cda !== cdb)
    || (abc === 0 && onSegment(ax, ay, bx, by, cx, cy))
    || (abd === 0 && onSegment(ax, ay, bx, by, dx, dy))
    || (cda === 0 && onSegment(cx, cy, dx, dy, ax, ay))
    || (cdb === 0 && onSegment(cx, cy, dx, dy, bx, by));
}

function spendValidationWork(budget) {
  if (++budget.work > MAX_VALIDATION_WORK) fail("topology validation work budget exceeded");
}

function ringsIntersect(a, b, budget, self = false) {
  if (!boundsOverlap(a.bounds, b.bounds)) return false;
  // Query the larger ring's band index with each segment of the smaller ring.
  if (!self && a.size > b.size) [a, b] = [b, a];
  for (let edgeA = 0; edgeA < a.size; edgeA++) {
    const ai = edgeA * 2;
    const aj = edgeA + 1 === a.size ? 0 : ai + 2;
    const low = Math.min(a.coords[ai + 1], a.coords[aj + 1]);
    const high = Math.max(a.coords[ai + 1], a.coords[aj + 1]);
    if (high < b.bounds[1] - EPSILON || low > b.bounds[3] + EPSILON) continue;
    const first = bandAt(b, low - EPSILON);
    const last = bandAt(b, high + EPSILON);
    for (let band = first; band <= last; band++) {
      for (let slot = b.offsets[band]; slot < b.offsets[band + 1]; slot++) {
        spendValidationWork(budget);
        const edgeB = b.edges[slot];
        if (self && (edgeB <= edgeA || edgeB === edgeA + 1 || (edgeA === 0 && edgeB === a.size - 1))) continue;
        // A pair sharing several bands is checked only in its first shared band.
        const bi = edgeB * 2;
        const bj = edgeB + 1 === b.size ? 0 : bi + 2;
        const otherFirst = bandAt(b, Math.min(b.coords[bi + 1], b.coords[bj + 1]) - EPSILON);
        if (band !== Math.max(first, otherFirst)) continue;
        if (segmentsIntersect(a, edgeA, b, edgeB)) return true;
      }
    }
  }
  return false;
}

function prepareRing(input, label, budget) {
  if (!Array.isArray(input) || input.length < 4) fail(`${label} needs at least four positions including closure`);
  const size = input.length - 1;
  budget.edges += size;
  if (++budget.rings > MAX_RINGS || budget.edges > MAX_EDGES) fail("boundary size budget exceeded");
  const coords = new Float64Array(size * 2);
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < input.length; i++) {
    const position = input[i];
    if (!Array.isArray(position) || (position.length !== 2 && position.length !== 3)) fail(`${label} position ${i} must be [lng, lat] (optional finite altitude)`);
    validateCoordinate(position[0], position[1], `${label} position ${i}`);
    if (position.length === 3 && (typeof position[2] !== "number" || !Number.isFinite(position[2]))) fail(`${label} altitude must be finite`);
    if (i === size) {
      if (position.length !== input[0].length || position.some((value, axis) => value !== input[0][axis])) fail(`${label} is not closed`);
    } else {
      coords[i * 2] = position[0];
      coords[i * 2 + 1] = position[1];
      bounds[0] = Math.min(bounds[0], position[0]);
      bounds[1] = Math.min(bounds[1], position[1]);
      bounds[2] = Math.max(bounds[2], position[0]);
      bounds[3] = Math.max(bounds[3], position[1]);
    }
  }
  let area = 0;
  let correction = 0;
  for (let edge = 0; edge < size; edge++) {
    const ai = edge * 2;
    const bi = edge + 1 === size ? 0 : ai + 2;
    const dx = coords[bi] - coords[ai];
    const dy = coords[bi + 1] - coords[ai + 1];
    if (dx === 0 && dy === 0) fail(`${label} has consecutive duplicate vertices`);
    if (Math.abs(dx) > 180) fail(`${label} crosses the antimeridian; split the geometry explicitly`);
    // Shift the shoelace origin to avoid loss of tiny areas near longitude 180.
    const term = (coords[ai] - coords[0]) * (coords[bi + 1] - coords[1])
      - (coords[bi] - coords[0]) * (coords[ai + 1] - coords[1]);
    const adjusted = term - correction;
    const sum = area + adjusted;
    correction = (sum - area) - adjusted;
    area = sum;
    const previous = edge === 0 ? (size - 1) * 2 : ai - 2;
    if (orientation(coords[previous], coords[previous + 1], coords[ai], coords[ai + 1], coords[bi], coords[bi + 1]) === 0
      && (coords[ai] - coords[previous]) * dx + (coords[ai + 1] - coords[previous + 1]) * dy < 0) {
      fail(`${label} has a backtracking segment`);
    }
  }
  if (area === 0 || bounds[0] === bounds[2] || bounds[1] === bounds[3]) fail(`${label} is degenerate`);
  const ring = { coords, size, bounds };
  buildBands(ring, budget);
  if (ringsIntersect(ring, ring, budget, true)) fail(`${label} is self-intersecting`);
  return ring;
}

function preparePolygon(input, label, budget) {
  if (!Array.isArray(input) || input.length === 0) fail(`${label} needs an exterior ring`);
  if (input.length + budget.rings > MAX_RINGS) fail("boundary size budget exceeded");
  const rings = Array.from(input, (ring, index) => prepareRing(ring, `${label} ring ${index}`, budget));
  const exterior = rings[0];
  for (let index = 1; index < rings.length; index++) {
    const hole = rings[index];
    if (classifyRing(exterior, hole.coords[0], hole.coords[1]) !== 1 || ringsIntersect(exterior, hole, budget)) {
      fail(`${label} hole ${index} must be strictly within its exterior without crossing or touching it`);
    }
    for (let earlier = 1; earlier < index; earlier++) {
      const other = rings[earlier];
      spendValidationWork(budget);
      if (boundsOverlap(hole.bounds, other.bounds) && (ringsIntersect(hole, other, budget)
        || classifyRing(hole, other.coords[0], other.coords[1]) !== 0
        || classifyRing(other, hole.coords[0], hole.coords[1]) !== 0)) {
        fail(`${label} holes ${earlier} and ${index} overlap, touch, or nest`);
      }
    }
  }
  return { rings, bounds: exterior.bounds };
}

function containsPolygon(polygon, lng, lat) {
  if (!insideBounds(polygon.bounds, lng, lat)) return false;
  const exterior = classifyRing(polygon.rings[0], lng, lat);
  if (exterior === 0) return false;
  if (exterior === 2) return true;
  for (let index = 1; index < polygon.rings.length; index++) {
    const hole = classifyRing(polygon.rings[index], lng, lat);
    // A hole's interior is excluded, but its ring belongs to the polygon's
    // boundary. Thus a shared shell/hole edge can correctly be ambiguous.
    if (hole === 2) return true;
    if (hole === 1) return false;
  }
  return true;
}

/**
 * Prepare a bounded, immutable WGS84 county matcher from a FeatureCollection or
 * Feature[]. Each Feature must have Polygon/MultiPolygon geometry and properties
 * {id, name, osmRelationId, adminLevel, adcode?}. id is a safe ASCII shard id
 * excluding Windows device names and reserved unmatched/ambiguous ids; duplicate
 * ids are checked case-insensitively. osmRelationId normalizes to a decimal string,
 * adminLevel to a number, adcode to a six-digit string, and name is trimmed.
 * Unknown properties are not copied.
 *
 * districts is a frozen array of frozen normalized properties in input order.
 * assign(lng, lat) returns {county, status}: county is one of those same metadata
 * objects only when exactly one county covers the point; otherwise null and
 * status is 'unmatched' or 'ambiguous'. All exterior/hole boundaries are covered.
 * Multiple components of one county count only once. Invalid queries throw.
 *
 * Rings must be closed, simple, nondegenerate; holes must be strictly interior
 * and mutually disjoint. Winding order does not matter. Unsplit antimeridian
 * edges and declared non-WGS84 CRSs are rejected rather than guessed. Limits:
 * 512 counties, 1M original edges, 16384 rings, 8M packed index references, and
 * 50M topology validation candidates. These are county-shard budgets, not a
 * nationwide index. Original input coordinates are never mutated or retained.
 */
export function prepareCountyMatcher(features) {
  if (!Array.isArray(features)) {
    if (!features || features.type !== "FeatureCollection" || !Array.isArray(features.features)) {
      fail("expected a FeatureCollection or features array");
    }
    validateCrs(features.crs, "collection");
    features = features.features;
  }
  if (features.length > MAX_COUNTIES) fail(`at most ${MAX_COUNTIES} counties may be prepared at once`);
  const budget = { edges: 0, rings: 0, references: 0, work: 0 };
  const ids = new Set();
  const counties = Array.from(features, (feature, index) => {
    if (!feature || feature.type !== "Feature") fail(`entry ${index} must be a Feature`);
    validateCrs(feature.crs, `feature ${index}`);
    const properties = normalizeProperties(feature.properties, index);
    const idKey = properties.id.toLowerCase();
    if (ids.has(idKey)) fail(`duplicate county id ${properties.id}`);
    ids.add(idKey);
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) fail(`feature ${properties.id} needs Polygon or MultiPolygon geometry`);
    validateCrs(geometry.crs, `geometry ${properties.id}`);
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length === 0) fail(`feature ${properties.id} geometry is empty`);
    const components = geometry.type === "Polygon" ? [coordinates] : coordinates;
    if (components.length + budget.rings > MAX_RINGS) fail("boundary size budget exceeded");
    const polygons = Array.from(components, (polygon, component) => preparePolygon(polygon, `${properties.id} polygon ${component}`, budget));
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of polygons) addBounds(bounds, polygon.bounds);
    return { properties, polygons, bounds };
  });
  const districts = Object.freeze(counties.map(county => county.properties));
  function assign(lng, lat) {
    validateCoordinate(lng, lat, "query point");
    let match = null;
    for (let index = 0; index < counties.length; index++) {
      const county = counties[index];
      if (!insideBounds(county.bounds, lng, lat)) continue;
      let contains = false;
      for (let component = 0; component < county.polygons.length; component++) {
        if (containsPolygon(county.polygons[component], lng, lat)) {
          contains = true;
          break;
        }
      }
      if (!contains) continue;
      if (match !== null) return { county: null, status: "ambiguous" };
      match = county.properties;
    }
    return { county: match, status: match === null ? "unmatched" : "matched" };
  }
  return Object.freeze({ assign, districts });
}
