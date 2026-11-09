import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateCatalog } from "../tools/validate_data.mjs";
import { importBaidu } from "../tools/import_baidu.mjs";

const sample = (id = "synthetic-1") => [id, 116.4, 39.9, "Test Road", "2025-01-02", 45, false, true, "baidu"];
async function tempData(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-workbench-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, provider: "baidu", coordinateSystem: "BD-09", updatedAt: null, total: 0, collections: [] }));
  return root;
}

test("validates empty catalog with required return API", async t => {
  const root = await tempData(t);
  const result = await validateCatalog(root);
  assert.equal(result.catalog.provider, "baidu");
  assert.equal(result.catalog.total, 0);
  assert.deepEqual(result.files, []);
});

test("validates synthetic shard paths, counts, bounds and global uniqueness", async t => {
  const root = await tempData(t);
  const relative = "baidu/320100/points-001.json";
  await mkdir(path.join(root, "baidu", "320100"), { recursive: true });
  const rows = [sample()];
  await writeFile(path.join(root, relative), JSON.stringify(rows));
  const catalog = { schemaVersion: 1, provider: "baidu", coordinateSystem: "BD-09", updatedAt: null, total: 1, collections: [{ id: "320100", adcode: "320100", name: "Test City", province: "Test Province", coordinateSystem: "BD-09", count: 1, bounds: [116.4, 39.9, 116.4, 39.9], files: [relative] }] };
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  const result = await validateCatalog(root);
  assert.equal(result.files[0].path, relative);
  assert.equal(result.files[0].rows[0][0], "synthetic-1");
  assert.equal(typeof result.files[0].sha256, "string");
  await writeFile(path.join(root, "baidu", "320100", "points-002.json"), JSON.stringify([sample("orphan")]));
  await assert.rejects(validateCatalog(root), /Unreferenced/);
});

test("rejects non-Baidu rows, bad source paths, wrong totals/bounds and duplicate panoid", async t => {
  const root = await tempData(t);
  const relative = "baidu/320100/points-001.json";
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const build = async (rows, overrides = {}) => {
    await writeFile(path.join(root, relative), JSON.stringify(rows));
    await writeFile(path.join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, provider: "baidu", coordinateSystem: "BD-09", updatedAt: null, total: 1, collections: [{ id: "320100", adcode: "320100", name: "Test", province: "Province", coordinateSystem: "BD-09", count: 1, bounds: [116.4, 39.9, 116.4, 39.9], files: [relative] }], ...overrides }));
  };
  await build([[...sample().slice(0, 8), "tencent"]]);
  await assert.rejects(validateCatalog(root), /provider/);
  await build([sample()], { total: 2 });
  await assert.rejects(validateCatalog(root), /total/);
  await build([sample()], { collections: [{ id: "320100", adcode: "320100", name: "Test", province: "Province", coordinateSystem: "BD-09", count: 1, bounds: [0, 0, 0, 0], files: [relative] }] });
  await assert.rejects(validateCatalog(root), /bounds/);
  await build([sample(), sample("synthetic-1")]);
  await assert.rejects(validateCatalog(root), /Duplicate/);
  await build([sample()], { collections: [{ id: "320100", adcode: "320100", name: "Test", province: "Province", coordinateSystem: "BD-09", count: 1, bounds: [116.4, 39.9, 116.4, 39.9], files: ["baidu/320100/../points-001.json"] }] });
  await assert.rejects(validateCatalog(root), /Shard path/);
});

test("CLI import handles aliases, confirms missing provider, and leaves existing data unchanged on failure", async t => {
  const root = await tempData(t);
  const inputPath = path.join(root, "input.json");
  const baseArgs = ["--input", inputPath, "--format", "json", "--city", "320100", "--adcode", "320100", "--name", "Test City", "--province", "Test", "--coordinate-system", "BD-09", "--confirm-baidu"];
  await writeFile(inputPath, JSON.stringify([{ streetViewId: "000000000000000000000000001", longitude: 116.4, latitude: 39.9, streetName: "Lane", captureDate: "2024-02-01", provider: "baidu_pano" }]));
  const success = await importBaidu(baseArgs, root);
  assert.equal(success.rows, 1);
  const before = await readFile(path.join(root, "baidu", "320100", "points-001.json"), "utf8");
  await writeFile(inputPath, JSON.stringify([{ panoid: "bad", longitude: 116.4, latitude: 39.9, road: "x", captured: "", provider: "tencent" }]));
  await assert.rejects(importBaidu(baseArgs, root), /provider/);
  assert.equal(await readFile(path.join(root, "baidu", "320100", "points-001.json"), "utf8"), before);
});

test("imports multiple cities without touching other shards and prechecks cross-city panoids", async t => {
  const root = await tempData(t);
  const input = path.join(root, "incoming.json");
  const args = (city, name) => ["--input", input, "--format", "json", "--city", city, "--adcode", city, "--name", name, "--province", "Province", "--coordinate-system", "BD-09", "--confirm-baidu"];
  await writeFile(input, JSON.stringify([{ ...{ panoid: "shared-id", longitude: 116.4, latitude: 39.9, road: "A", captured: "", provider: "baidu" } }]));
  await importBaidu(args("320100", "City A"), root);
  const cityAPath = path.join(root, "baidu", "320100", "points-001.json");
  const cityABefore = await readFile(cityAPath, "utf8");
  await writeFile(input, JSON.stringify([{ panoid: "city-b-id", longitude: 117, latitude: 40, road: "B", captured: "", provider: "baidu" }]));
  await importBaidu(args("320200", "City B"), root);
  const cityBPath = path.join(root, "baidu", "320200", "points-001.json");
  const cityBBefore = await readFile(cityBPath, "utf8");
  assert.equal(await readFile(cityAPath, "utf8"), cityABefore);
  await writeFile(input, JSON.stringify([{ panoid: "shared-id", longitude: 116.5, latitude: 39.9, road: "Conflict", captured: "", provider: "baidu" }]));
  await assert.rejects(importBaidu(args("320200", "City B"), root), /another collection/);
  assert.equal(await readFile(cityAPath, "utf8"), cityABefore);
  assert.equal(await readFile(cityBPath, "utf8"), cityBBefore);
  assert.equal((await validateCatalog(root)).catalog.total, 2);
});
