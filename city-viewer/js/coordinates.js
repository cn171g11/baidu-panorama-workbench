const SYSTEMS = new Set(["BD-09", "GCJ-02", "WGS84"]);
const PI = Math.PI;
const X_PI = PI * 3000 / 180;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function assertCoordinate(lng, lat, system) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new TypeError("Coordinates must be finite numbers");
  if (!SYSTEMS.has(system)) throw new TypeError(`Unknown coordinate system: ${system}`);
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) throw new RangeError("Coordinates are out of range");
}

function outsideChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  value += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return value;
}

function transformLng(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  value += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return value;
}

function wgsToGcj(lng, lat) {
  if (outsideChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = dLat * 180 / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = dLng * 180 / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

function gcjToWgs(lng, lat) {
  if (outsideChina(lng, lat)) return [lng, lat];
  let wgsLng = lng;
  let wgsLat = lat;
  for (let i = 0; i < 8; i++) {
    const [guessLng, guessLat] = wgsToGcj(wgsLng, wgsLat);
    const dLng = guessLng - lng;
    const dLat = guessLat - lat;
    wgsLng -= dLng;
    wgsLat -= dLat;
    if (Math.abs(dLng) < 1e-8 && Math.abs(dLat) < 1e-8) break;
  }
  return [wgsLng, wgsLat];
}

function bdToGcj(lng, lat) {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}

function gcjToBd(lng, lat) {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

function toWgs84(lng, lat, from = "BD-09") {
  assertCoordinate(lng, lat, from);
  if (from === "WGS84") return [lng, lat];
  const gcj = from === "BD-09" ? bdToGcj(lng, lat) : [lng, lat];
  return gcjToWgs(...gcj);
}

function convertCoordinate(lng, lat, from, to) {
  assertCoordinate(lng, lat, from);
  if (!SYSTEMS.has(to)) throw new TypeError(`Unknown coordinate system: ${to}`);
  if (from === to) return [lng, lat];
  if (to === "WGS84") return toWgs84(lng, lat, from);
  let gcj = from === "BD-09" ? bdToGcj(lng, lat) : from === "WGS84" ? wgsToGcj(lng, lat) : [lng, lat];
  if (to === "GCJ-02") return gcj;
  if (to === "BD-09") return gcjToBd(...gcj);
  return [lng, lat];
}

export { convertCoordinate, toWgs84 };
