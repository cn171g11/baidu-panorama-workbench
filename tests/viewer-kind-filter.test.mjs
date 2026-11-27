// Type filter (#kind-filter) must scope both map layers: street source types and the
// independent 小蓝点 layer. Blue rows are never street categories and never enter the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const province = '山东省', city = '滨州', id = '371600', county = '371602', other = '370100';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bounds = [117, 37, 117, 37];
const countyPath = `baidu/${id}/counties/${county}/points-001.json`;
const unmatchedPath = `baidu/${id}/counties/unmatched/points-001.json`;
const otherPath = `baidu/${other}/points-001.json`;
const row = (id, sourceType) => [id, 117, 37, '路', '2024-01-01', null, false, true, 'baidu', { sourceType, ...(sourceType === 'hidden' ? {isHidden:true} : {}) }];
const pack = rows => {
  const plain = Buffer.from(JSON.stringify(rows)), gzip = gzipSync(plain);
  return { gzip, meta: { count: rows.length, bytes: plain.length, sha256: hash(plain), compressedBytes: gzip.length, compressedSha256: hash(gzip) } };
};
const json = value => new Response(JSON.stringify(value));
const blueRow = (panoid, lng) => [panoid, 13000000, 4000000, `${province}|${city}市`, lng, 37.39];

function setup(t, { search = '' } = {}) {
  class Element {
    constructor(text = '', value = '') {
      this.textContent = text; this.value = value; this.options = []; this.dataset = {}; this.events = {};
      this.style = { setProperty() {} }; this.hidden = false;
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    set innerHTML(value) { if (value.startsWith('<option')) this.replaceChildren(new Element('', '')); }
    replaceChildren(...children) { this.options = children; this.value = children[0]?.value ?? ''; }
    add(option) { this.options.push(option); }
    setAttribute(attr, value) { this[attr] = value; }
    removeAttribute(attr) { delete this[attr]; }
    querySelector() { return new Element(); }
    querySelectorAll() { return []; }
    append() {}
    getBoundingClientRect() { return { height: 100 }; }
    addEventListener(name, fn) { this.events[name] = fn; }
    fire(name) { return this.events[name]?.({ target: this }); }
  }
  const elements = new Map();
  const get = elementId => {
    if (!elements.has(elementId)) elements.set(elementId, new Element('', elementId === 'kind-filter' ? 'all' : ''));
    return elements.get(elementId);
  };
  const window = { addEventListener() {} };
  const globals = {
    document: { getElementById: get, createElement: () => new Element(), querySelectorAll: () => [], addEventListener() {}, body: new Element() },
    window, location: { search }, Option: Element,
  };
  for (const [key, value] of Object.entries(globals)) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (saved) Object.defineProperty(globalThis, key, saved); else delete globalThis[key]; });
  }
  return { get, snapshot: () => window.__BAIDU_WORKBENCH__?.getState() };
}

async function until(condition) {
  for (let i = 0; i < 600; i++) { const result = condition(); if (result) return result; await delay(3); }
  assert.fail('Timed out waiting for viewer state');
}

function mockPublication(t) {
  const flat = (id, name, province, files) => ({ id, adcode: id, name, province, coordinateSystem: 'BD-09', bounds, count: files.length, files, shardMaxRows: 1 });
  const collections = [
    {
      ...flat(id, city, province, [countyPath, unmatchedPath]),
      partition: 'osm-county-wgs84-v1',
      partitionSummary: { matched: 1, unmatched: 1, ambiguous: 0, total: 2 },
      counties: [
        { id: county, cityId: id, name: '滨城区', coordinateSystem: 'BD-09', kind: 'county', bounds, count: 1, files: [countyPath] },
        { id: 'unmatched', cityId: id, name: '未匹配', coordinateSystem: 'BD-09', kind: 'unmatched', bounds, count: 1, files: [unmatchedPath] },
      ],
    },
    flat(other, '济南', province, [otherPath]),
  ];
  const packs = new Map([
    [countyPath, pack([row('hidden-one', 'hidden')])],
    [unmatchedPath, pack([row('time-machine-one', 'time-machine')])],
    [otherPath, pack([row('regular-one', 'regular')])],
  ]);
  const assets = Object.fromEntries([...packs].map(([path, { meta }]) => [path, { ...meta, url: path + '.gz' }]));
  const blue = pack([blueRow('blue-one', 118.01), blueRow('blue-two', 118.02)]);
  const blueManifest = { schemaVersion: 1, coordinateSystem: 'BD09MC / BD09LL', total: 2, parts: [{ province, file: 'province.json.gz', rows: 2, bytes: blue.gzip.length, sha256: hash(blue.gzip) }] };
  // A same-origin city shard keeps the city scope selectable instead of falling back to the province.
  const blueKey = 'b'.repeat(16), blueCityFile = `${blueKey}/points-001.json.gz`;
  const cityManifest = {
    schemaVersion: 1, provider: 'baidu', source: 'github-pages', coordinateSystem: 'BD09MC / BD09LL', partition: 'blue-city-v1', shardMaxRows: 25, total: 2,
    collections: [{ key: blueKey, province, name: city, count: 2, bounds, files: [blueCityFile] }],
    assets: { [blueCityFile]: { ...blue.meta, url: blueCityFile } },
  };
  t.mock.method(globalThis, 'fetch', async input => {
    const path = String(input).split('/data/').at(-1);
    if (path === 'catalog.json') return json({ schemaVersion: 1, provider: 'baidu', coordinateSystem: 'BD-09', updatedAt: null, total: 3, collections });
    if (path === 'asset-manifest.json') return json({ schemaVersion: 1, provider: 'baidu', codec: 'gzip', source: 'github-pages', assets });
    if (path === 'blue-dots/parts-manifest.json') return json(blueManifest);
    if (path === 'blue-dots/province.json.gz') return new Response(blue.gzip);
    if (path === `blue-dots-cities/${blueCityFile}`) return new Response(blue.gzip);
    if (path === 'blue-dots-osm/county-matched-manifest.json') return json({ schemaVersion: 1, parts: [] });
    if (path === 'blue-dots-osm/national-county-directory.json') return json({ cities: [] });
    if (path === 'blue-dots-cities/city-manifest.json') return json(cityManifest);
    const payload = packs.get(path.slice(0, -3));
    assert(payload, `Unexpected request: ${path}`);
    return new Response(payload.gzip);
  });
}

const KIND_OPTIONS = [
  ['all', '全部类型'], ['regular', '常规'], ['hidden', '隐藏 · 源标注'],
  ['time-machine', '时光机 · 源标注'], ['unknown', '未知'], ['blue', '小蓝点'],
];

test('the viewer exposes 小蓝点 as a type-filter option and documents legend state', async () => {
  const html = await readFile(new URL('../city-viewer/index.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="kind-filter"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, '#kind-filter select missing');
  const options = [...select[1].matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(match => [match[1], match[2].trim()]);
  assert.deepEqual(options, KIND_OPTIONS);
  assert.match(html, /id="legend-note"/, 'legend must explain the active type filter');
  for (const kind of ['regular', 'hidden', 'time-machine', 'unknown', 'blue']) assert.match(html, new RegExp(`data-kind="${kind}"`));
  const css = await readFile(new URL('../city-viewer/css/viewer.css', import.meta.url), 'utf8');
  assert.match(css, /\.viewer-legend \[data-kind\]\.legend-muted\s*\{[^}]*opacity/);
  assert.match(css, /\.legend-blue\s*\{[^}]*#27A9FF/i);
});

test('type filter scopes the blue layer: street kinds hide it, 小蓝点 shows only it, 全部类型 shows both', async t => {
  const { get, snapshot } = setup(t);
  mockPublication(t);
  await import('../city-viewer/js/app.js');
  await until(() => snapshot()?.ready);
  const kind = get('kind-filter');
  assert.equal(snapshot().kind, 'all');
  assert.equal(snapshot().blueLayerVisible, true);

  get('province-filter').value = province;
  get('province-filter').fire('change');
  await until(() => !snapshot().loading && snapshot().rows === 3 && snapshot().blueCount === 2);

  // 全部类型: both layers, blue rows stay outside the street list/counter.
  let state = snapshot();
  assert.equal(state.kind, 'all');
  assert.equal(state.visibleCount, 3);
  assert.equal(state.blueVisibleCount, 2);
  assert.equal(state.blueMapCount, 2);
  assert.equal(state.blueLayerVisible, true);
  assert.match(get('map-result-count').textContent, /街景 3/);
  assert.match(get('map-result-count').textContent, /小蓝点 2/);

  // A street type hides every blue dot from the map layer and from the 匹配点 counter.
  for (const [streetKind, expectedRows] of [['regular', 1], ['hidden', 1], ['time-machine', 1], ['unknown', 0]]) {
    kind.value = streetKind;
    kind.fire('change');
    state = snapshot();
    assert.equal(state.kind, streetKind);
    assert.equal(state.visibleCount, expectedRows, `${streetKind} street rows`);
    assert.equal(state.blueVisibleCount, 2, 'loaded blue rows must stay loaded while filtered out');
    assert.equal(state.blueMapCount, 0, `${streetKind} must hide blue dots from the map`);
    assert.equal(state.blueLayerVisible, false);
    assert.equal(state.blueRenderedCount, 0);
    assert.doesNotMatch(get('map-result-count').textContent, /小蓝点/, `${streetKind} counter must not advertise blue dots`);
    assert.equal(get('legend-note').textContent, `仅显示${{ regular: '常规', hidden: '隐藏 · 源标注', 'time-machine': '时光机 · 源标注', unknown: '未知' }[streetKind]}街景 · 小蓝点已隐藏`);
  }

  // 小蓝点: only the blue layer, no street rows, no street list.
  kind.value = 'blue';
  kind.fire('change');
  state = snapshot();
  assert.equal(state.kind, 'blue');
  assert.equal(state.kindLabel, '小蓝点');
  assert.equal(state.visibleCount, 0, 'street rows must be hidden for 小蓝点');
  assert.equal(state.blueMapCount, 2);
  assert.equal(state.blueLayerVisible, true);
  assert.equal(get('empty-state').hidden, true, 'blue-only view must not cover the dots with a blocking gate');
  assert.match(get('empty-title').textContent, /小蓝点/);
  assert.match(get('map-result-count').textContent, /^视野 .* 匹配 2 条小蓝点$/);
  assert.equal(get('record-list').hidden, true);
  assert.equal(get('empty-state').hidden, true, 'blue-only view must not cover the dots with a blocking gate');
  assert.match(get('empty-title').textContent, /小蓝点/);
  assert.match(get('legend-note').textContent, /仅显示小蓝点图层/);

  // Back to 全部类型, then 清除筛选 must restore the neutral all-types view.
  kind.value = 'all';
  kind.fire('change');
  assert.equal(snapshot().visibleCount, 3);
  assert.equal(snapshot().blueMapCount, 2);
  kind.value = 'blue';
  kind.fire('change');
  get('clear-filters').fire('click');
  state = snapshot();
  assert.equal(state.kind, 'all', '清除筛选 must reset the type filter');
  assert.equal(state.visibleCount, 3);
  assert.equal(state.blueMapCount, 2);
  assert.equal(state.blueLayerVisible, true);
  assert.equal(get('search-input').value, '');
  assert.equal(get('legend-note').textContent, '类型按源标注 · 同时显示街景与小蓝点');
});

test('?kind=blue deep links keep the 小蓝点 layer scope and ignore unknown values', async t => {
  const { snapshot } = setup(t, { search: '?kind=blue' });
  mockPublication(t);
  await import(`../city-viewer/js/app.js?deep-link-kind=${Date.now()}`);
  await until(() => snapshot()?.ready);
  assert.equal(snapshot().kind, 'blue');
  assert.equal(snapshot().blueLayerVisible, true);
});

test('blue layer filtering stays consistent across province, city and county scope', async t => {
  const { get, snapshot } = setup(t);
  mockPublication(t);
  await import(`../city-viewer/js/app.js?scope-kind=${Date.now()}`);
  await until(() => snapshot()?.ready);
  const kind = get('kind-filter');
  get('province-filter').value = province;
  get('province-filter').fire('change');
  await until(() => !snapshot().loading && snapshot().rows === 3 && snapshot().blueCount === 2);

  kind.value = 'blue';
  kind.fire('change');
  assert.equal(snapshot().visibleCount, 0);
  assert.equal(snapshot().blueMapCount, 2);

  // Selecting a city keeps the blue scope filtered the same way.
  get('city-filter').value = id;
  get('city-filter').fire('change');
  await until(() => !snapshot().loading && snapshot().blueCount === 2);
  assert.equal(snapshot().kind, 'all', 'scope change resets the type filter to 全部类型');
  assert.equal(snapshot().visibleCount, 2, 'city scope street rows');
  assert.equal(snapshot().blueMapCount, 2);

  kind.value = 'hidden';
  kind.fire('change');
  assert.equal(snapshot().visibleCount, 1);
  assert.equal(snapshot().blueMapCount, 0);
  assert.equal(snapshot().blueVisibleCount, 2, 'blue rows remain loaded, only the layer is filtered out');

  // County scope then 清除筛选 returns to a neutral all-types view of the current scope.
  get('county-filter').value = county;
  get('county-filter').fire('change');
  await until(() => !snapshot().loading && snapshot().visibleCount === 1);
  kind.value = 'blue';
  kind.fire('change');
  assert.equal(snapshot().visibleCount, 0);
  assert.equal(snapshot().blueMapCount, 2);
  get('clear-filters').fire('click');
  assert.equal(snapshot().kind, 'all');
  assert.equal(snapshot().blueLayerVisible, true);
  assert.equal(snapshot().blueMapCount, 2);
  assert.equal(snapshot().visibleCount, 1, 'county street scope preserved after 清除筛选');
});

test('the filtered blue layer still renders in density mode and never becomes a street category', async t => {
  const { renderMap, createMap, GRID_SIZE } = await import('../city-viewer/js/map.js');
  const { categoryFor } = await import('../city-viewer/js/classification.js');
  const drawn = { arcs: [], rectangles: [] };
  const ctx = {
    setTransform() {}, clearRect() { drawn.arcs.length = 0; drawn.rectangles.length = 0; },
    fillRect(x, y, width, height) { drawn.rectangles.push({ x, y, width, height, color: this.fillStyle }); },
    strokeRect() {}, beginPath() {}, moveTo() {}, fill() {}, stroke() {}, arc(...args) { drawn.arcs.push(args); },
  };
  const canvas = { style: {}, getContext: () => ctx };
  const map = {
    setView() { return this; }, on() {}, getPane: () => ({ appendChild() {} }),
    getSize: () => ({ x: 256, y: 256 }), containerPointToLayerPoint: () => ({}),
    getPixelOrigin: () => ({ add: () => ({ x: 0, y: 0 }) }), getZoomScale: () => 1,
    getCenter: () => ({ lng: 118, lat: 37 }), getZoom: () => 12, fitBounds() {},
    project: ([, lng]) => ({ x: (lng - 118) * 2000, y: 10 }),
  };
  class Layer {
    addTo(instance) { this.onAdd(instance); return this; }
    static extend(methods) { return Object.assign(class extends Layer {}.prototype, methods).constructor; }
  }
  const saved = { L: globalThis.L, raf: globalThis.requestAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.L = { map: () => map, DomUtil: { create: () => canvas, setPosition() {} }, tileLayer: () => ({ addTo() {} }), Layer };
  t.after(() => {
    if (saved.L) globalThis.L = saved.L; else delete globalThis.L;
    if (saved.raf) globalThis.requestAnimationFrame = saved.raf; else delete globalThis.requestAnimationFrame;
  });
  const state = createMap({ classList: { toggle() {} }, dispatchEvent() {} });
  assert.ok(state);
  const blueRow = id => [id, 118.0005, 37, '山东省|滨州市', null, null, false, true, 'baidu', { blueDot: true, source: 'blue-dots' }];
  const streetRow = id => [id, 118.001, 37, '路', '2024-01-01', null, false, true, 'baidu', { sourceType: 'regular' }];
  const street = [streetRow('street-1'), streetRow('street-2')];
  const blue = [blueRow('blue-1'), blueRow('blue-2'), blueRow('blue-3')];
  assert.equal(categoryFor(blue[0]), 'blue');
  // Density mode with the filtered blue rows: the blue grid must be populated, street grid separate.
  renderMap(state, [], 'density', [], blue);
  state.canvasLayer.draw();
  assert.equal(state.actualMode, 'density-grid');
  assert.equal(state.bluePoints.length, 3);
  assert.equal([...state.blueGrid.values()].reduce((sum, cell) => sum + cell.count, 0), 3);
  assert.equal(state.grid.size, 0, '小蓝点-only view must not draw street density cells');
  assert.equal(state.drawnSymbols, state.blueGrid.size);
  const blueStrips = drawn.rectangles.filter(rect => rect.color.startsWith('rgba(39,169,255,'));
  assert.equal(blueStrips.length, state.blueGrid.size);
  assert.ok(blueStrips.every(rect => rect.width === GRID_SIZE - 2));
  // A street type hides the blue layer entirely, leaving only the street grid.
  renderMap(state, street, 'density', [], []);
  state.canvasLayer.draw();
  assert.equal(state.bluePoints.length, 0);
  assert.equal(state.blueGrid.size, 0);
  assert.equal(state.renderedCount, 2);
  assert.ok(drawn.rectangles.every(rect => !rect.color.startsWith('rgba(39,169,255,')));
  // 全部类型 renders both layers on the same canvas.
  renderMap(state, street, 'density', [], blue);
  state.canvasLayer.draw();
  assert.equal(state.blueGrid.size > 0 && state.grid.size > 0, true);
  assert.equal(state.renderedCount, 5);
});
