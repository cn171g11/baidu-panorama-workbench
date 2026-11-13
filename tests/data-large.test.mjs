import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
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
  async function writeRows(file,start,count){
    const output=createWriteStream(file,{highWaterMark:64*1024});output.write('[');let batch='';
    for(let index=start;index<start+count;index++){
      const row=[`synthetic-${index}`,100+index/1000000,20+index/1000000,'Road','',null,false,true,'baidu'];
      batch+=(index===start?'':',')+JSON.stringify(row);
      if(batch.length>=64*1024){if(!output.write(batch))await once(output,'drain');batch='';}
    }
    output.end(batch+']');await once(output,'finish');
  }
  const files = ["baidu/320100/points-001.json", "baidu/320100/points-002.json"];
  await writeRows(path.join(directory,'points-001.json'),0,ROWS_PER_SHARD);
  await writeRows(path.join(directory,'points-002.json'),ROWS_PER_SHARD,1);
  const lngs=[100,100+ROWS_PER_SHARD/1000000],lats=[20,20+ROWS_PER_SHARD/1000000];
  const catalog = { schemaVersion: 1, provider: "baidu", coordinateSystem: "BD-09", updatedAt: null, total: ROWS_PER_SHARD + 1, collections: [{ id: "320100", adcode: "320100", name: "Synthetic Test City", province: "Synthetic", coordinateSystem: "BD-09", count: ROWS_PER_SHARD + 1, bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], files }] };
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  const result = await validateCatalog(root);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].count, ROWS_PER_SHARD);
  assert.equal(result.files[1].count, 1);
  assert.equal('rows' in result.files[0], false);
});
