import { prepareCountyMatcher } from "./geometry.mjs";

const MAX_COORDINATES = 1_000_000;
const MAX_MEMBERS = 500_000;
const MAX_RINGS = 16_384;
const MAX_HOLE_WORK = 50_000_000;
const NON_BOUNDARY_ROLES = new Set(["admin_centre", "label", "subarea"]);

function fail(message) {
  throw new TypeError(`Invalid OSM county relation: ${message}`);
}

function osmId(value, label) {
  const text = String(value);
  if (!((typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "string")
    || !/^[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail(`${label} must be a positive safe OSM id`);
  }
  return text;
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function pointKey(point) {
  // Number stringification is round-trip exact. No rounding, tolerance, or snapping.
  return `${point[0]},${point[1]}`;
}

function sameGeometry(a, b) {
  if (a.length !== b.length) return false;
  let forward = true;
  let reverse = true;
  for (let i = 0; i < a.length && (forward || reverse); i++) {
    forward &&= samePoint(a[i], b[i]);
    reverse &&= samePoint(a[i], b[b.length - i - 1]);
  }
  return forward || reverse;
}

function collectWays(relation) {
  const ways = { outer: [], inner: [] };
  const seen = new Map();
  let coordinateCount = 0;
  if (!Array.isArray(relation.members)) fail("members array is required; fetch relation out body geom");
  if (relation.members.length > MAX_MEMBERS) fail("member budget exceeded");
  // Count first, including duplicate member geometry, before allocating any copy.
  for (const member of relation.members) {
    if (Array.isArray(member?.geometry)) coordinateCount += member.geometry.length;
    if (coordinateCount > MAX_COORDINATES) fail(`coordinate budget exceeds ${MAX_COORDINATES}`);
  }
  for (const [index, member] of relation.members.entries()) {
    if (!member || typeof member !== "object" || Array.isArray(member)) fail(`member ${index} is malformed`);
    const suppliedRole = member.role ?? "";
    if (NON_BOUNDARY_ROLES.has(suppliedRole)) continue;
    let role = suppliedRole;
    if (role === "" && member.type === "way" && relation.tags?.type === "boundary") role = "outer";
    if (role !== "outer" && role !== "inner") fail(`member ${index} has unsupported boundary role ${JSON.stringify(suppliedRole)}`);
    if (member.type !== "way") {
      fail(`member ${index} (${role}) is ${member.type}, not a way; fetch and resolve nested relation geometry explicitly`);
    }
    const ref = osmId(member.ref, `member ${index} ref`);
    if (!Array.isArray(member.geometry) || member.geometry.length < 2) {
      fail(`way ${ref} has missing or partial geometry; fetch complete relation out body geom`);
    }
    const coordinates = new Array(member.geometry.length);
    for (let i = 0; i < member.geometry.length; i++) {
      const position = member.geometry[i];
      const lon = position?.lon;
      const lat = position?.lat;
      if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) {
        fail(`way ${ref} position ${i} must have finite numeric lon/lat; fetch complete geometry`);
      }
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) fail(`way ${ref} position ${i} is outside WGS84`);
      coordinates[i] = [lon, lat];
    }
    const earlier = seen.get(ref);
    if (earlier) {
      if (earlier.role !== role || !sameGeometry(earlier.coordinates, coordinates)) {
        fail(`way ${ref} has conflicting duplicate role or geometry`);
      }
      continue; // An identical (even reversed) repeated reference is not another edge.
    }
    const way = { ref, role, coordinates };
    seen.set(ref, way);
    ways[role].push(way);
  }
  return ways;
}

function stitch(ways, role) {
  const rings = [];
  const openWays = [];
  const endpoints = new Map();
  function addRing(ring) {
    if (ring.length < 4 || !samePoint(ring[0], ring[ring.length - 1])) fail(`${role} ring is open or too short`);
    if (rings.length >= MAX_RINGS) fail("ring budget exceeded");
    rings.push(ring);
  }
  for (const way of ways) {
    const coords = way.coordinates;
    if (samePoint(coords[0], coords[coords.length - 1])) {
      addRing(coords);
      continue;
    }
    const index = openWays.length;
    openWays.push(way);
    for (const point of [coords[0], coords[coords.length - 1]]) {
      const key = pointKey(point);
      const incident = endpoints.get(key);
      if (incident) incident.push(index);
      else endpoints.set(key, [index]);
    }
  }
  for (const [key, incident] of endpoints) {
    if (incident.length < 2) fail(`${role} has dangling/open endpoint ${key}; fetch complete member geometry`);
    if (incident.length > 2) fail(`${role} has ambiguous branched endpoint ${key}; explicit ring membership is required`);
  }
  const used = new Uint8Array(openWays.length);
  for (let seed = 0; seed < openWays.length; seed++) {
    if (used[seed]) continue;
    used[seed] = 1;
    const ring = openWays[seed].coordinates.slice();
    const start = pointKey(ring[0]);
    let end = pointKey(ring[ring.length - 1]);
    while (end !== start) {
      const incident = endpoints.get(end);
      const next = incident.find(index => !used[index]);
      if (next === undefined) fail(`${role} reaches a used fragment before closing; ambiguous/open ring`);
      used[next] = 1;
      const coords = openWays[next].coordinates;
      if (pointKey(coords[0]) === end) {
        for (let i = 1; i < coords.length; i++) ring.push(coords[i]);
      } else {
        for (let i = coords.length - 2; i >= 0; i--) ring.push(coords[i]);
      }
      end = pointKey(ring[ring.length - 1]);
    }
    addRing(ring);
  }
  return rings;
}

function ringBounds(ring) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}

function classifyPoint(ring, point, budget) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    if (++budget.work > MAX_HOLE_WORK) fail("hole ownership work budget exceeded");
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)
      && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return 2;
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
  }
  return inside ? 1 : 0;
}

function buildPolygons(outers, inners) {
  if (!outers.length) fail("no outer ring geometry; bounds cannot substitute for a polygon");
  if (outers.length + inners.length > MAX_RINGS) fail("ring budget exceeded");
  const polygons = outers.map(ring => [ring]);
  const bounds = outers.map(ringBounds);
  const budget = { work: 0 };
  for (const [index, hole] of inners.entries()) {
    const holeBounds = ringBounds(hole);
    let owner = -1;
    for (let i = 0; i < outers.length; i++) {
      const b = bounds[i];
      // Bounds only exclude impossible containment candidates; never make geometry.
      if (holeBounds[0] < b[0] || holeBounds[1] < b[1] || holeBounds[2] > b[2] || holeBounds[3] > b[3]) continue;
      if (classifyPoint(outers[i], hole[0], budget) !== 1) continue;
      if (owner !== -1) fail(`inner ring ${index} has ambiguous outer ownership`);
      owner = i;
    }
    if (owner === -1) fail(`inner ring ${index} has no strictly containing outer`);
    polygons[owner].push(hole);
  }
  return polygons;
}

/**
 * Convert one Overpass `out body geom` relation, not the response envelope, to a
 * WGS84 GeoJSON Feature. Complete outer/inner way geometry is required. Empty way
 * roles are outer only for tags.type=boundary. Label/admin_centre/subarea roles
 * are ignored; nested boundary members and all other roles fail explicitly.
 *
 * Exact endpoint equality joins fragments in either direction. Closed ways stay
 * independent islands; open fragment endpoints must have degree exactly two.
 * A shared degree-four endpoint is rejected rather than guessed into rings.
 * Duplicate refs are deduplicated only with identical (possibly reversed)
 * geometry and role. Original coordinates are copied without rounding,
 * simplification, artificial closure, bbox replacement, or input mutation.
 *
 * The geometry matcher validates the finished rings and every hole's complete
 * containment/intersections. Winding is retained and is not significant. Budgets:
 * 1M input positions (including duplicates), 500k members, 16384 rings, 50M hole
 * ownership edge visits, plus the independent geometry validator's budgets.
 */
export function relationToFeature(relation) {
  if (!relation || relation.type !== "relation") fail("expected an Overpass relation object");
  const relationId = osmId(relation.id, "relation id");
  const tags = relation.tags;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) fail("relation tags are required");
  const name = tags["name:zh"] || tags.name;
  if (typeof name !== "string" || !name.trim()) fail("relation name:zh or name is required");
  const level = tags.admin_level;
  if (!((typeof level === "number" && Number.isInteger(level))
    || (typeof level === "string" && /^(?:[1-9]|1[0-2])$/.test(level)))
    || Number(level) < 1 || Number(level) > 12) fail("admin_level must be an integer from 1 to 12");
  const division = tags.division_code;
  const code = ((typeof division === "string") || (typeof division === "number" && Number.isInteger(division)))
    && /^\d{6}$/.test(String(division)) ? String(division) : undefined;
  const properties = { id: code ?? `osm-r${relationId}`, name, osmRelationId: relationId, adminLevel: Number(level) };
  if (code !== undefined) properties.adcode = code;
  if (relation.version !== undefined) {
    if (!Number.isSafeInteger(relation.version) || relation.version <= 0) fail("relation version must be a positive safe integer");
    properties.osmVersion = relation.version;
  }
  const ways = collectWays(relation);
  const polygons = buildPolygons(stitch(ways.outer, "outer"), stitch(ways.inner, "inner"));
  const geometry = polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
  const feature = { type: "Feature", properties, geometry };
  try {
    prepareCountyMatcher([feature]);
  } catch (error) {
    fail(`relation ${relationId} geometry validation failed: ${error.message}`);
  }
  return feature;
}
