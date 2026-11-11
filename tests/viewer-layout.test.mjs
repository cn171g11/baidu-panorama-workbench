import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=file=>readFile(new URL('../'+file,import.meta.url),'utf8');
test('Baidu viewer follows map-first toolbar and popup pattern without permanent sidebars',async()=>{
 const html=await read('city-viewer/index.html'),css=await read('city-viewer/css/viewer.css'),app=await read('city-viewer/js/app.js');
 assert.match(html,/class="map-viewer"/);assert.match(html,/id="viewer-toolbar"/);assert.match(html,/id="records-panel" hidden/);
 assert.match(html,/id="detail-host" hidden/);assert.match(html,/id="basemap-select"/);assert.match(html,/id="fit-city"/);
 assert.doesNotMatch(html,/<aside class="filters"|class="workspace"/);
 assert.match(css,/\.viewer-map\s*\{[^}]*position:\s*fixed/);assert.match(css,/inset:\s*var\(--toolbar-height\) 0 0/);
 assert.match(app,/openRowPopup\(state\.map,row,elements\.detail\)/);assert.match(app,/listOpen:\s*false/);
 assert.doesNotMatch(html,/map\.qq|qq-map|腾讯街景|tencent-panorama-workbench/i);
});
test('popup map controller only uses Baidu metadata and preserves bounded canvas rendering',async()=>{
 const map=await read('city-viewer/js/map.js');assert.match(map,/openRowPopup/);assert.match(map,/fitRows/);assert.match(map,/setBasemap/);
 assert.match(map,/baidu:popupclosed/);assert.match(map,/new CustomEvent\('baidu:select'/);assert.doesNotMatch(map,/qq\.com|gtimg|tencent/i);
});
