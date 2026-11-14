import { relationToFeature } from "./osm-convert.mjs";
import { prepareCountyMatcher } from "./geometry.mjs";

const PARENT_LEVELS = new Set([4, 5, 6]);
const CENTRE_BASIS = "osm-admin-centre-point-in-parent";

function levelOf(relation) {
  const level = relation.tags?.admin_level;
  if ((typeof level === "number" && Number.isInteger(level))
    || (typeof level === "string" && /^(?:[1-9]|1[0-2])$/.test(level))) return Number(level);
  return null;
}

function codeOf(relation) {
  const code = relation?.tags?.division_code;
  return ((typeof code === "string") || (typeof code === "number" && Number.isInteger(code)))
    && /^\d{6}$/.test(String(code)) ? String(code) : null;
}

function nameOf(relation) {
  return relation?.tags?.["name:zh"] || relation?.tags?.name || "";
}

function validId(id) {
  return ((typeof id === "number" && Number.isSafeInteger(id)) || typeof id === "string")
    && /^[1-9]\d{0,15}$/.test(String(id)) && Number.isSafeInteger(Number(id));
}

function pointOf(value) {
  const { lon, lat } = value || {};
  return typeof lon === "number" && typeof lat === "number"
    && Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90 ? [lon, lat] : null;
}

function elementsOf(response, label, optional = false) {
  if (optional && (response === undefined || response === null)) return [];
  if (!response || response.remark || !Array.isArray(response.elements)) {
    throw new TypeError(`Invalid ${label}: complete Overpass elements are required`);
  }
  return response.elements;
}

// Prefer the complete out-body-geom copy over out-body/bb copies, independent
// of response order. Coordinates are inspected only by length, never copied here.
function geometryRank(relation) {
  let boundaryWays = 0;
  let missingWays = 0;
  let coordinates = 0;
  for (const member of Array.isArray(relation.members) ? relation.members : []) {
    if (member?.type !== "way" || !["outer", "inner", ""].includes(member.role ?? "")) continue;
    boundaryWays++;
    if (!Array.isArray(member.geometry) || member.geometry.length < 2) missingWays++;
    else coordinates += member.geometry.length;
  }
  return [Number(boundaryWays > 0 && missingWays === 0), Number(coordinates > 0), coordinates];
}

function preferGeometry(candidate, earlier) {
  const a = geometryRank(candidate);
  const b = geometryRank(earlier);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function selectParent(relations, city) {
  const named = relations.filter(relation => PARENT_LEVELS.has(levelOf(relation))
    && [relation.tags?.name, relation.tags?.["name:zh"]]
      .some(name => typeof name === "string" && name.trim() === city.name.trim()));
  if (!named.length) return { parent: null, basis: "no-name-matched-parent" };
  const lowestLevel = Math.min(...named.map(levelOf));
  const peers = named.filter(relation => levelOf(relation) === lowestLevel);
  if (peers.length === 1) return { parent: peers[0], basis: "name-lowest-admin-level" };
  // A code can break a tie only among lowest-level name matches. In particular,
  // an unrelated level-6 Gongshan relation tagged 533300 cannot replace Nujiang.
  const sameLevelCode = peers.filter(relation => codeOf(relation) === city.id);
  return sameLevelCode.length === 1
    ? { parent: sameLevelCode[0], basis: "name-lowest-admin-level-code-tiebreak" }
    : { parent: null, basis: "ambiguous-name-matched-parent" };
}

function adminCentres(relation, nodes) {
  const members = (relation.members || []).filter(member => member?.role === "admin_centre");
  const points = [];
  let unresolved = 0;
  for (const member of members) {
    // Only an explicit OSM node admin_centre is a semantic association point.
    // Labels, Overpass center/bounds, way midpoints, and polygon averages are not.
    if (member.type !== "node" || !validId(member.ref)) {
      unresolved++;
      continue;
    }
    const direct = pointOf(member);
    const referenced = nodes.get(String(member.ref)) || [];
    // Preserve conflicting actual OSM coordinates rather than silently preferring
    // an inline member over a separate node copy that could lie outside parent.
    const candidates = direct ? [direct, ...referenced.filter(point => point[0] !== direct[0] || point[1] !== direct[1])] : referenced;
    if (!candidates.length) unresolved++;
    else for (const point of candidates) points.push({ ref: String(member.ref), point });
  }
  return { members: members.length, points, unresolved };
}

/**
 * Prepare one in-memory, already fetched OSM boundary snapshot. No I/O, network,
 * projection, invented centre, code-prefix inference, or bbox polygon is used.
 *
 * Returns {geometry, parentGeometry, metaFields}. geometry contains level-6
 * county candidates only; the selected native WGS84 parent is a separate Feature.
 * Named level-4/5/6 parents win at their lowest numeric admin_level. Codes only
 * break a same-level named tie: code-only parents are intentionally not trusted.
 * Duplicate relation copies prefer native way geometry; duplicate retained county
 * adcodes keep adcode but use osm-r<relation-id> as their unique publication id.
 *
 * Candidate association uses actual node admin_centre coordinates and the stable
 * exact WGS84 matcher (boundary-inclusive, holes/islands respected), NOT full
 * polygon intersection. Any resolved centre outside the usable parent excludes
 * that county. Missing/unresolved centres retain an explicitly unverified
 * candidate. Every candidate still requires the publisher's real parent fence:
 * a centre proves OSM semantic association, not full county containment. With no
 * usable parent, converted candidates remain metadata only; parentGeometry=null
 * and parentUsable=false, and a fail-closed publisher must leave points unmatched.
 */
export function prepareBoundarySnapshot({ city, response, parentResponse } = {}) {
  if (typeof city?.id !== "string" || !/^\d{6}$/.test(city.id)
    || typeof city.name !== "string" || !city.name.trim()) {
    throw new TypeError("Invalid boundary city: six-digit id and nonempty name are required");
  }
  const sourceElements = elementsOf(response, "county response");
  const parentElements = elementsOf(parentResponse, "parent response", true);
  const relationMap = new Map();
  const nodes = new Map();
  let invalidRelation = 0;
  for (const elements of [sourceElements, parentElements]) {
    for (const element of elements) {
      if (element?.type === "relation") {
        const key = validId(element.id) ? String(element.id) : `invalid-${invalidRelation++}`;
        const earlier = relationMap.get(key);
        if (!earlier || preferGeometry(element, earlier)) relationMap.set(key, element);
      } else if (element?.type === "node" && validId(element.id)) {
        const point = pointOf(element);
        if (!point) continue;
        const key = String(element.id);
        const points = nodes.get(key) || [];
        if (!points.some(other => other[0] === point[0] && other[1] === point[1])) points.push(point);
        nodes.set(key, points);
      }
    }
  }
  const relations = [...relationMap.values()];
  const { parent, basis: parentSelectionBasis } = selectParent(relations, city);
  const metaFields = {
    parentRelationId: parent && validId(parent.id) ? String(parent.id) : null,
    parentAdminLevel: parent ? levelOf(parent) : null,
    parentDivisionCode: codeOf(parent),
    parentUsable: false,
    parentSelectionBasis,
    parentFenceRequired: true,
    rejected: [],
    idConflicts: [],
    excluded: [],
    associationBasis: "unusable-parent-no-spatial-association",
    associations: [],
    associationCaveat: "OSM node admin_centre association is boundary-inclusive, not full county-polygon intersection or an official registry. Missing centres are unverified candidates; publication requires the independent native WGS84 parent fence.",
  };
  let parentGeometry = null;
  let parentMatcher = null;
  if (!parent) {
    metaFields.rejected.push({ scope: "parent", osmRelationId: null, name: city.name,
      reason: `${parentSelectionBasis}; no usable named OSM parent, points must remain unmatched` });
  } else {
    try {
      parentGeometry = relationToFeature(parent);
      parentMatcher = prepareCountyMatcher([parentGeometry]);
      metaFields.parentUsable = true;
      metaFields.associationBasis = CENTRE_BASIS;
    } catch (error) {
      parentGeometry = null;
      metaFields.rejected.push({ scope: "parent", osmRelationId: String(parent.id), name: nameOf(parent), reason: error.message });
    }
  }
  const features = [];
  for (const relation of relations) {
    if (levelOf(relation) !== 6) continue;
    let feature;
    try {
      feature = relationToFeature(relation);
    } catch (error) {
      metaFields.rejected.push({ scope: "county", osmRelationId: validId(relation.id) ? String(relation.id) : null,
        name: nameOf(relation), reason: error.message });
      continue;
    }
    const centres = adminCentres(relation, nodes);
    const association = {
      id: feature.properties.id,
      osmRelationId: feature.properties.osmRelationId,
      name: feature.properties.name,
      status: "candidate",
      basis: "unusable-parent-no-spatial-association",
      adminCentreRefs: [...new Set(centres.points.map(centre => centre.ref))],
      unresolvedAdminCentres: centres.unresolved,
    };
    if (parentMatcher) {
      const outside = centres.points.filter(centre => parentMatcher.assign(...centre.point).status !== "matched");
      if (outside.length) {
        association.status = "excluded";
        association.basis = CENTRE_BASIS;
        association.reason = "OSM admin_centre outside native parent geometry";
        association.outsideAdminCentres = outside.map(centre => ({ ref: centre.ref, coordinates: centre.point }));
        metaFields.excluded.push(association);
        metaFields.associations.push(association);
        continue;
      }
      if (String(relation.id) === String(parent.id)) {
        association.status = "associated";
        association.basis = "parent-relation-self";
      } else if (centres.points.length && centres.unresolved === 0) {
        association.status = "associated";
        association.basis = CENTRE_BASIS;
      } else {
        association.basis = centres.members ? "unresolved-osm-admin-centre-parent-fence-required" : "no-osm-admin-centre-parent-fence-required";
        association.reason = "Unverified county candidate retained; publisher must apply native parent geometry fence";
      }
    } else {
      association.reason = "No usable native parent geometry; candidate metadata only, publication must remain unmatched";
    }
    features.push(feature);
    metaFields.associations.push(association);
  }
  const codeCounts = new Map();
  for (const feature of features) codeCounts.set(feature.properties.id, (codeCounts.get(feature.properties.id) || 0) + 1);
  const associationByRelation = new Map(metaFields.associations.map(association => [association.osmRelationId, association]));
  for (const feature of features) {
    if (codeCounts.get(feature.properties.id) <= 1) continue;
    const { adcode, osmRelationId, name } = feature.properties;
    feature.properties.id = `osm-r${osmRelationId}`;
    associationByRelation.get(osmRelationId).id = feature.properties.id;
    metaFields.idConflicts.push({ adcode: adcode || null, osmRelationId, name, id: feature.properties.id });
  }
  const geometry = { type: "FeatureCollection", features };
  prepareCountyMatcher(geometry);
  return { geometry, parentGeometry, metaFields };
}
