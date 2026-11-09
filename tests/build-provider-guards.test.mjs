import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImport, validateRows } from '../city-viewer/js/metadata.js';

const sample = () => ({
  provider: 'baidu', panoid: '090000000000000000000000001',
  longitude: 118.7801, latitude: 32.0501, road: '合成隔离测试',
  captured: '2020-01-01', heading: 90,
});
const options = { format: 'json', confirmedBaidu: true, coordinateSystem: 'BD-09' };
const imports = value => parseImport(JSON.stringify(value), options);

test('Baidu confirmation cannot override explicit non-Baidu provenance, including nested metadata', () => {
  const cases = [
    [{ ...sample(), provider: 'tencent' }],
    [{ ...sample(), provider: 'qq' }],
    { provider: 'tencent', rows: [sample()] },
    { provider: 'baidu', source: 'tencent', rows: [sample()] },
    [{ ...sample(), extras: { history: [{ provider: 'google', panoid: 'not-baidu' }] } }],
    [{ ...sample(), svid: '10000000000000000000001' }],
    [{ ...sample(), rdid: 'qq-road' }],
    [{ ...sample(), source: 'tencent' }],
    [{ ...sample(), jumpUrl: 'https://qq-map.netlify.app/?pano=10000000000000000000001' }],
    [{ ...sample(), sourceUrl: 'https://sv.map.qq.com/sv?svid=10000000000000000000001' }],
    [{ ...sample(), extras: { history: [{ provider: 'tencent', panoid: '10000000000000000000001' }] } }],
    [{ ...sample(), extras: { links: [{ provider: 'qq', url: 'https://map.qq.com/' }] } }],
  ];
  for (const value of cases) assert.throws(() => imports(value), undefined, 'Non-Baidu provenance was accepted: ' + JSON.stringify(value));
});

test('explicit coordinate systems cannot silently be overridden or mixed in one import', () => {
  assert.throws(() => imports({ provider: 'baidu', coordinateSystem: 'WGS84', rows: [sample()] }));
  assert.throws(() => imports([{ ...sample(), coordinateSystem: 'WGS84' }]));
});

test('raw array and object metadata cannot convert numeric IDs into imprecise Baidu strings', () => {
  assert.throws(() => imports([{ ...sample(), panoid: 9e25 }]));
  assert.throws(() => validateRows([[9e25, 118.78, 32.05, '', '', 0, false, false, 'baidu']]));
  assert.throws(() => imports([{ ...sample(), longitude: null }]));
  assert.throws(() => imports([{ ...sample(), latitude: '' }]));
});

test('JavaScript wrappers from another viewer are never executed as imported metadata', () => {
  globalThis.__BAIDU_IMPORT_EXECUTED__ = false;
  assert.throws(() => parseImport('globalThis.__BAIDU_IMPORT_EXECUTED__=true; window.PANO_CITY={};', options));
  assert.equal(globalThis.__BAIDU_IMPORT_EXECUTED__, false);
  delete globalThis.__BAIDU_IMPORT_EXECUTED__;
});
