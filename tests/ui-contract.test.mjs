import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('root route leads to the Baidu-only viewer', async () => {
  const html = await read('index.html');
  assert.match(html, /\.\/city-viewer\//);
  assert.doesNotMatch(html, /tencent|qqpano|qq\.com/i);
});

test('viewer exposes stable accessible controls and local privacy language', async () => {
  const html = await read('city-viewer/index.html');
  for (const id of ['source-state', 'province-filter', 'city-filter', 'load-city', 'search-input', 'road-filter', 'date-filter', 'result-count', 'empty-state', 'record-list', 'record-rows', 'detail-panel', 'open-import', 'import-dialog', 'import-format', 'coordinate-system', 'import-file', 'import-text', 'confirm-baidu', 'confirm-import', 'import-message', 'clear-local', 'reload-data', 'export-data']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /不会自动上传/);
  assert.match(html, /百度/);
  assert.match(html, /本地浏览器/);
  assert.match(html, /<label/);
  assert.match(html, /aria-live/);
  assert.doesNotMatch(html, /tencent|qqpano|qq\.com/i);
});

test('app uses metadata and isolated local storage APIs with bounded pagination', async () => {
  const app = await read('city-viewer/js/app.js');
  assert.match(app, /parseImport/);
  assert.match(app, /importSummary/);
  const viewer = await read('city-viewer/index.html');
  assert.match(viewer, /id="catalog-summary"/);
  assert.match(app, /summary\.rawRecords/);
  assert.match(app, /日期未知/);
  assert.match(app, /extras\.pitch/);
  assert.match(app, /extras\.zoom/);
  assert.match(app, /extras\.links/);
  assert.match(app, /extras\.extra\?\.imageDate/);
  assert.match(app, /extras\.observations\?\.imageDate/);
  assert.match(app, /saveLocalRows\('local'/);
  assert.match(app, /loadLocalRows\('local'/);
  assert.match(app, /clearLocalRows\('local'/);
  assert.match(app, /const PAGE_SIZE = 50/);
  assert.match(app, /state\.visibleRows\.slice\(start, start \+ PAGE_SIZE\)/);
  assert.match(app, /window\.__BAIDU_WORKBENCH__/);
  assert.match(app, /getState: \(\) => Object\.freeze/);
  assert.match(app, /rows: state\.visibleRows\.length/);
  assert.match(app, /incoming\.length > 10000/);
  assert.match(app, /catch \(error\) \{ setMessage\(error\.message/);
  assert.match(app, /baiduPanoramaUrl\(row\[0\]/);
  assert.match(app, /priorRows/);
  assert.match(app, /collectionRequest/);
  assert.match(app, /load-city/);
  assert.match(app, /loadCollection\(collection\)/);
});

test('map uses local Leaflet host dependency and public OSM, never requires tiles for table', async () => {
  const html = await read('city-viewer/index.html');
  const map = await read('city-viewer/js/map.js');
  assert.match(html, /\.\/vendor\/leaflet\/leaflet\.css/);
  assert.match(html, /\.\/vendor\/leaflet\/leaflet\.js/);
  assert.match(html, /leaflet\.js[\s\S]*type="module" src="\.\/js\/app\.js"/);
  assert.match(map, /openstreetmap\.org/);
  assert.match(map, /BD-09/);
  assert.doesNotMatch(map, /tencent|qq\.com/i);
  assert.match(map, /if \(!globalThis\.L/);
  assert.match(map, /CANVAS_THRESHOLD/);
  assert.match(map, /GRID_SIZE/);
  assert.match(map, /bindMapInteractions/);
  assert.match(map, /toWgs84/);
});

test('report counts only the published catalog and uses child-path assets', async () => {
  const html = await read('city-viewer/report.html');
  const js = await read('city-viewer/js/report.js');
  assert.match(html, /\.\/css\/app\.css/);
  assert.match(html, /\.\/js\/report\.js/);
  assert.match(html, /id="report-total" data-ready="false"/);
  assert.match(js, /loadCatalog\(\)/);
  assert.match(js, /report-search/);
  assert.match(js, /rawRecords/);
  assert.match(js, /uniquePanoids/);
  assert.match(js, /exactDuplicates/);
  assert.doesNotMatch(js, /loadLocalRows|localStorage/i);
  assert.match(html, /尚无已发布点位/);
  assert.match(html, /id="report-total" data-ready="false"/);
  assert.match(js, /total\.dataset\.ready = 'true'/);
});

test('responsive styles cover narrow devices without viewport-scaled type', async () => {
  const css = await read('city-viewer/css/theme.css');
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.doesNotMatch(css, /font-size:\s*[^;]*vw/i);
  assert.match(css, /min-width:\s*320px/);
});
