import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPixelGrid, BASEMAP_MODES, CANVAS_THRESHOLD, GRID_SIZE, projectForBasemap, displayModeFor } from '../city-viewer/js/map.js';
import { categoryFor } from '../city-viewer/js/classification.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('map supports the approved basemap modes and canvas thresholds', () => {
  assert.deepEqual(BASEMAP_MODES, ['amap-dark', 'amap', 'amap-satellite', 'osm', 'osm-dark', 'none']);
  assert.equal(CANVAS_THRESHOLD, 1500);
  assert.equal(GRID_SIZE, 32);
  const amap = projectForBasemap(116.4, 39.9, 'amap-dark');
  const osm = projectForBasemap(116.4, 39.9, 'osm');
  assert.notDeepEqual(amap, osm);
  assert.deepEqual(projectForBasemap(116.4, 39.9, 'osm-dark'), osm);
  assert.equal(displayModeFor('density', 14), 'density-grid');
  assert.equal(displayModeFor('density', 15), 'points');
  assert.equal(displayModeFor('points', 10), 'points');
});

test('pixel density aggregation preserves all visible point counts', () => {
  const grid = buildPixelGrid([{ x: 1, y: 2, point: 'a' }, { x: 4, y: 3, point: 'b' }, { x: 40, y: 3, point: 'c' }], 32);
  assert.equal([...grid.values()].reduce((sum, bucket) => sum + bucket.count, 0), 3);
  assert.equal(grid.size, 2);
  assert.throws(() => buildPixelGrid([{ x: Number.NaN, y: 1 }]), /Invalid projected point/);
});

test('classification colors are consumed by map source without provider leakage', async () => {
  const source = await readFile(path.join(root, 'city-viewer/js/map.js'), 'utf8');
  assert.match(source, /categoryFor/);
  assert.match(source, /POINT_COLORS/);
  assert.match(source, /is\.autonavi\.com/);
  assert.doesNotMatch(source, /tencent|qq\.com|gtimg/i);
  assert.equal(categoryFor(['id', 116, 40, '', '', null, false, true, 'baidu', { sourceType: 'time-machine' }]), 'time-machine');
  assert.equal(categoryFor(['id', 116, 40, '', '', null, false, true, 'baidu', { isHidden: true }]), 'hidden');
});

test('map keeps one canvas layer and preserves official map controls', async () => {
  const source = await readFile(path.join(root, 'city-viewer/js/map.js'), 'utf8');
  assert.match(source, /classList\.toggle\('map-dark'/);
  assert.match(source, /setBasemap/);
  assert.match(source, /new PointCanvas\(\)\.addTo\(map\)/);
  assert.match(source, /renderedCount/);
  assert.match(source, /d<best/);
});
