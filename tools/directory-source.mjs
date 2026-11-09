import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { convertCoordinate } from "../city-viewer/js/coordinates.js";

const SAFE_KEYS = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
function fail(message) { throw new Error(message); }
function cityFromName(name) { return name.split(/[（(]/)[0].trim().replace(/\.(?:json)$/i, ""); }
function normalizeRecord(record, { coordinateSystem } = {}) {
  if (!coordinateSystem || !["BD-09", "GCJ-02", "WGS84"].includes(coordinateSystem)) fail("Declare coordinateSystem as BD-09, GCJ-02, or WGS84");
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("Source record must be an object");
  if (typeof record.panoId !== "string" || !record.panoId) fail("panoId must remain a non-empty string");
  if (record.source !== "baidu_pano" && record.source !== "baidu") fail("Source marker must be baidu_pano or baidu");
  if (typeof record.lng !== "number" || !Number.isFinite(record.lng) || typeof record.lat !== "number" || !Number.isFinite(record.lat)) fail("Source coordinates must be finite numbers");
  const [lng, lat] = convertCoordinate(record.lng, record.lat, coordinateSystem, "BD-09");
  if (!Array.isArray(record.links) || record.links.some(value => typeof value !== "string")) fail("links must be an array of strings");
  const extras = { source: record.source, links: structuredClone(record.links), pitch: Number.isFinite(record.pitch) ? record.pitch : null, zoom: Number.isFinite(record.zoom) ? record.zoom : null, extra: record.extra && typeof record.extra === "object" && !Array.isArray(record.extra) ? structuredClone(record.extra) : {}, tags: Array.isArray(record.extra?.tags) ? structuredClone(record.extra.tags) : [] };
  const captured = typeof record.imageDate === "string" && !Number.isNaN(Date.parse(record.imageDate)) ? record.imageDate : (typeof record.extra?.imageDate === "string" && !Number.isNaN(Date.parse(record.extra.imageDate)) ? record.extra.imageDate : "");
  for (const [key, value] of Object.entries(record)) if (!(key in { panoId: 1, lng: 1, lat: 1, heading: 1, source: 1, links: 1, pitch: 1, zoom: 1, extra: 1 })) { if (!SAFE_KEYS.test(key)) fail(`Unsafe source field: ${key}`); extras.extra[key] = structuredClone(value); }
  return [record.panoId, lng, lat, "", captured, Number.isFinite(record.heading) ? record.heading : null, false, true, "baidu", extras];
}
async function listSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name)).map(entry => path.join(root, entry.name));
}
async function* iterateSource(root, { coordinateSystem } = {}) {
  const sourceRoot = path.resolve(root); const files = await listSourceFiles(sourceRoot);
  for (const file of files) {
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) fail(`Source must be a regular file: ${file}`);
    const bytes = await readFile(file); const sha256 = createHash("sha256").update(bytes).digest("hex");
    const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
    if (!Array.isArray(document.customCoordinates)) fail(`Missing customCoordinates: ${path.basename(file)}`);
    yield { path: file, name: path.basename(file), city: cityFromName(path.basename(file)), bytes: bytes.byteLength, sha256, records: document.customCoordinates, coordinateSystem };
  }
}

export { cityFromName, iterateSource, normalizeRecord };
