import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPixelGrid, BASEMAP_MODES, CANVAS_THRESHOLD, GRID_SIZE, projectForBasemap, displayModeFor, createMap, renderMap } from '../city-viewer/js/map.js';
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

test('blue dots aggregate independently and return to scatter at high zoom', t => {
  const rectangles = [], arcs = [];
  const ctx = {
    setTransform() {}, clearRect() { rectangles.length = arcs.length = 0; },
    fillRect(x, y, width, height) { rectangles.push({ x, y, width, height, color: this.fillStyle }); },
    strokeRect() {}, beginPath() {}, moveTo() {}, fill() {}, stroke() {}, arc(...args) { arcs.push(args); },
  };
  const canvas = { style: {}, getContext: () => ctx };
  let zoom = 13;
  const map = {
    setView() { return this; }, on() {}, getPane: () => ({ appendChild() {} }),
    getSize: () => ({ x: 128, y: 128 }), containerPointToLayerPoint: () => ({}),
    getPixelOrigin: () => ({ add: () => ({ x: 0, y: 0 }) }), getZoomScale: () => 1,
    getCenter: () => ({ lng: 116, lat: 40 }), getZoom: () => zoom, fitBounds() {},
    project: ([, lng]) => ({ x: (lng - 116) * 1000, y: 10 }),
  };
  class Layer {
    addTo(instance) { this.onAdd(instance); return this; }
    static extend(methods) { return Object.assign(class extends Layer {}.prototype, methods).constructor; }
  }
  globalThis.requestAnimationFrame = () => 1;
  globalThis.L = {
    map: () => map, DomUtil: { create: () => canvas, setPosition() {} },
    tileLayer: () => ({ addTo() {} }), Layer,
  };
  t.after(() => { delete globalThis.L; delete globalThis.requestAnimationFrame; });
  const state = createMap({ classList: { toggle() {} }, dispatchEvent() {} });
  assert.ok(state);
  const row = (id, lng, extras) => [id, lng, 40, '', '', null, false, true, 'baidu', extras];
  const street = [row('hidden', 116.02, { isHidden: true }), row('history', 116.023, { sourceType: 'time-machine' })];
  const blue = [row('blue-1', 116.02, { blueDot: true }), row('blue-2', 116.021, { blueDot: true }), row('blue-3', 116.08, { blueDot: true })];
  renderMap(state, street, 'density', [], blue);
  state.canvasLayer.draw();
  assert.equal(state.actualMode, 'density-grid');
  assert.equal(state.renderedCount, 5);
  assert.equal(state.drawnSymbols, 3);
  assert.deepEqual([...state.grid.values()].map(c => [c.count, c.hidden, c.timeMachine]), [[2, 1, 1]]);
  assert.deepEqual([...state.blueGrid.values()].map(c => c.count), [2, 1]);
  assert.equal(arcs.length, 0);
  const bluePrefix = 'rgba(39,169,255,';
  const [shared, blueOnly] = rectangles.filter(r => r.color.startsWith(bluePrefix));
  assert.equal(shared.width, 8);
  assert.equal(blueOnly.width, GRID_SIZE - 2);
  const streetCell = rectangles.find(r => r.color === 'rgba(255,212,0,.83)');
  assert.ok(streetCell.x + streetCell.width < shared.x);
  const opacity = rectangle => Number(rectangle.color.slice(bluePrefix.length, -1));
  assert.ok(opacity(shared) > opacity(blueOnly));
  assert.ok(rectangles.some(r => r.color === '#FF1A1A'));
  assert.ok(rectangles.some(r => r.color === '#B47AF0'));

  zoom = 15;
  state.canvasLayer.draw();
  assert.equal(state.actualMode, 'points');
  assert.equal(state.blueGrid.size, 0);
  assert.equal(state.drawnSymbols, 5);
  assert.equal(arcs.filter(a => a[2] === 2.5).length, 3);
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
