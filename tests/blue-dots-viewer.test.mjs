import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { POINT_COLORS } from '../city-viewer/js/map.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('blue dot rows keep blue color and draw above regular records', async () => {
  const source = await readFile(path.join(root, 'city-viewer/js/map.js'), 'utf8');
  assert.equal(POINT_COLORS.blue, '#27A9FF');
  // blue rows are converted to blue points and drawn last
  assert.match(source, /state\.bluePoints=blueRows\.map\(row=>pointFor\(row,state\.map\)\)/);
  const drawOrder = source.indexOf("for(const p of bluePixels)");
  const drawRegular = source.indexOf("for(const key of ['regular','unknown','time-machine','hidden'])");
  assert.ok(drawRegular > 0 && drawOrder > drawRegular, 'blue dots must draw after regular rows');
  assert.match(source, /blueRows\.includes\(state\.activeRow\)/);
  // blue rows never merge into published/list rows
  const app = await readFile(path.join(root, 'city-viewer/js/app.js'), 'utf8');
  assert.match(app, /renderMap\(state\.map, state\.visibleRows, state\.mode, showContext\?rows:\[\], blueVisibleRows\)/);
  assert.match(app, /blueCountyOptions/);
  assert.match(app, /administrativeArea/);
  assert.match(app, /__blueDotsBridge/);
  assert.match(app, /blue-dots-osm\/county-matched-manifest\.json/);
  assert.match(app, /DecompressionStream\('gzip'\)/);
  assert.match(app, /administrativeArea\?\.county/);
  assert.match(app, /combinedTotal/);
  assert.match(app, /小蓝点/);
});

test('blue dot legend and small-dot label exist in viewer chrome', async () => {
  const html = await readFile(path.join(root, 'city-viewer/index.html'), 'utf8');
  assert.match(html, /legend-blue/);
  assert.match(html, /小蓝点/);
  const css = await readFile(path.join(root, 'city-viewer/css/viewer.css'), 'utf8');
  assert.match(css, /\.legend-blue\s*{[^}]*#27A9FF/);
});

test('blue dot bridge loads per province without whole-country fetch', async () => {
  const app = await readFile(path.join(root, 'city-viewer/js/app.js'), 'utf8');
  assert.match(app, /loadBlueDotsForProvince/);
  assert.match(app, /blueDotCache/);
  assert.match(app, /AbortController/);
});
