import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../city-viewer/js/data-store.js';

test('browser catalog accepts numeric source-file counts and a separate manifest array', async () => {
  const original = globalThis.fetch;
  const catalog = {schemaVersion:1,provider:'baidu',coordinateSystem:'BD-09',updatedAt:null,total:0,collections:[],importSummary:{sourceFiles:281,rawRecords:0,uniquePanoids:0,exactDuplicates:0,differingDuplicates:0,invalidRecords:0,files:[]}};
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(catalog), {status:200});
    assert.equal((await loadCatalog()).importSummary.sourceFiles,281);
    catalog.importSummary.sourceFiles = ['invalid'];
    await assert.rejects(loadCatalog(), /sourceFiles/);
  } finally { globalThis.fetch = original; }
});
