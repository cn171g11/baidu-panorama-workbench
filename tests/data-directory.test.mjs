import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeRecord } from "../tools/directory-source.mjs";
import { importDirectory } from "../tools/import_directory.mjs";
import { openUniqueIndex } from "../tools/unique-index.mjs";

const raw = (id, extra = {}) => ({ panoId: id, lng: 116.4, lat: 39.9, heading: 20, pitch: 1, zoom: 2, source: "baidu_pano", links: ["A"], extra: { tags: ["x"], country: "CN", imageDate: "2024-02-29", ...extra } });

test("normalizes customCoordinates while preserving source extras and no inferred date", () => {
  const row = normalizeRecord(raw("00000000000000000000000001"), { coordinateSystem: "BD-09" });
  assert.equal(row[0], "00000000000000000000000001"); assert.equal(row[3], ""); assert.equal(row[4], "2024-02-29"); assert.equal(row[8], "baidu");
  assert.equal(row[9].source, "baidu_pano"); assert.equal(row[9].pitch, 1); assert.equal(row[9].zoom, 2); assert.equal(row[9].extra.imageDate, "2024-02-29"); assert.equal(row[4], "2024-02-29");
});

test("disk index separates identical and differing payloads", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baidu-index-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const index = openUniqueIndex(path.join(dir, "ids.sqlite"));
  assert.equal(index.put({ panoid: "id", fingerprint: "a", sourceFile: "a.json" }).status, "unique");
  assert.equal(index.put({ panoid: "id", fingerprint: "a", sourceFile: "b.json" }).status, "identical");
  assert.equal(index.put({ panoid: "id", fingerprint: "b", sourceFile: "c.json", payload: { x: 1 } }).status, "conflict");
  index.close();
});

test("directory importer writes only supplied output root and records summary", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baidu-directory-")); const output = await mkdtemp(path.join(os.tmpdir(), "baidu-output-")); t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(output, { recursive: true, force: true })]));
  await writeFile(path.join(dir, "Alpha.json"), JSON.stringify({ customCoordinates: [raw("id-alpha")] }));
  await writeFile(path.join(dir, "Beta.json"), JSON.stringify({ customCoordinates: [raw("id-beta"), raw("id-beta")] }));
  const cities = path.join(output, "cities.json"); await writeFile(cities, JSON.stringify({ "Alpha.json": { id: "320100", adcode: "320100", name: "Alpha", province: "Test" }, "Beta.json": { id: "320200", adcode: "320200", name: "Beta", province: "Test" } }));
  const target = path.join(output, 'data');
  const summary = await importDirectory(["--source", dir, "--output-root", target, "--cities", cities, "--coordinate-system", "BD-09"]);
  assert.equal(summary.rawRecords, 3); assert.equal(summary.uniquePanoids, 2); assert.equal(summary.exactDuplicates, 1);
  assert.equal(JSON.parse(await readFile(path.join(target, "catalog.json"))).total, 2);
});
