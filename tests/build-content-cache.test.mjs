import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateCatalog } from '../tools/validate_data.mjs';
import { importDirectory } from '../tools/import_directory.mjs';

test('content validation cache detects same-length source changes and remains outside public data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-content-test-'));
  try {
    await mkdir(path.join(root, 'baidu/320100'), { recursive: true });
    const logical = 'baidu/320100/points-001.json';
    const row = ['panoid',116,32,'','',45,false,true,'baidu'];
    await writeFile(path.join(root, logical), JSON.stringify([row]));
    await writeFile(path.join(root, 'catalog.json'), JSON.stringify({schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:1,collections:[{id:'320100',adcode:'320100',name:'Test',province:'Test',coordinateSystem:'BD-09',count:1,bounds:[116,32,116,32],files:[logical]}]}));
    const first = await validateCatalog(root), second = await validateCatalog(root);
    assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true);
    assert.equal('rows' in second.files[0], false); assert(!second.indexPath.startsWith(root + path.sep));
    row[5] = 46;
    await writeFile(path.join(root, logical), JSON.stringify([row]));
    const changed = await validateCatalog(root);
    assert.equal(changed.cacheHit, false); assert.notEqual(changed.signature, second.signature);
  } finally { assert(path.basename(root).startsWith('baidu-content-test-')); await rm(root,{recursive:true}); }
});

test('different link versions preserve both observations without circular JSON or lost fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baidu-variant-test-'));
  try {
    const source = path.join(root, 'source'), output = path.join(root, 'data'); await mkdir(source);
    const record = {panoId:'27-character-baidu-id',lng:116,lat:32,heading:45,pitch:0,zoom:0,source:'baidu_pano',links:['first-link'],extra:{tags:['baidu']}};
    await writeFile(path.join(source,'A.json'),JSON.stringify({customCoordinates:[record]}));
    await writeFile(path.join(source,'B.json'),JSON.stringify({customCoordinates:[{...record,links:['first-link','second-link']}]}));
    const mapping = path.join(root,'cities.json');
    await writeFile(mapping,JSON.stringify({A:{id:'320100',adcode:'320100',name:'A',province:'Test'},B:{id:'320200',adcode:'320200',name:'B',province:'Test'}}));
    const result = await importDirectory(['--source',source,'--output-root',output,'--cities',mapping,'--coordinate-system','GCJ-02','--index',path.join(root,'index.sqlite')]);
    assert.equal(result.rawRecords,2); assert.equal(result.uniquePanoids,1); assert.equal(result.differingDuplicates,1);
    const validated = await validateCatalog(output,{includeRows:true});
    const stored = validated.files[0].rows[0];
    assert.deepEqual(stored[9].links,['first-link','second-link']);
    assert.deepEqual(stored[9].observations[0].variant[9].links,['first-link']);
    assert.deepEqual(stored[9].observations[1].variant[9].links,['first-link','second-link']);
    assert.equal('cachePath' in validated.catalog.importSummary,false);
    const members=JSON.parse(await readFile(path.join(output,'imports/source-memberships.json'),'utf8'));
    assert.deepEqual(members.entries[0].sources,['A.json','B.json']);
  } finally { assert(path.basename(root).startsWith('baidu-variant-test-')); await rm(root,{recursive:true}); }
});
