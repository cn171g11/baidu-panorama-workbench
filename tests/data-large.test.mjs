import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateCatalog } from "../tools/validate_data.mjs";

const ROWS_PER_SHARD = 180000;
test("validates a city split into multiple shards without variadic bounds overflow", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "baidu-large-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "baidu", "320100");
  await mkdir(directory, { recursive: true });
  const rowsA = [];
  const rowsB = [];
  for (let index = 0; index < ROWS_PER_SHARD + 1; index++) {
    const row = [`synthetic-${index}`, 100 + index / 1000000, 20 + index / 1000000, "Road", "", null, false, true, "baidu"];
    (index < ROWS_PER_SHARD ? rowsA : rowsB).push(row);
  }
  const files = ["baidu/320100/points-001.json", "baidu/320100/points-002.json"];
  await writeFile(path.join(directory, "points-001.json"), JSON.stringify(rowsA));
  await writeFile(path.join(directory, "points-002.json"), JSON.stringify(rowsB));
  const lngs = [rowsA[0][1], rowsA.at(-1)[1], rowsB[0][1]];
  const lats = [rowsA[0][2], rowsA.at(-1)[2], rowsB[0][2]];
  const catalog = { schemaVersion: 1, provider: "baidu", coordinateSystem: "BD-09", updatedAt: null, total: ROWS_PER_SHARD + 1, collections: [{ id: "320100", adcode: "320100", name: "Synthetic Test City", province: "Synthetic", coordinateSystem: "BD-09", count: ROWS_PER_SHARD + 1, bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], files }] };
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  const result = await validateCatalog(root);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].rows.length, ROWS_PER_SHARD);
  assert.equal(result.files[1].rows.length, 1);
});
