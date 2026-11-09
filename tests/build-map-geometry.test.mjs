import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPixelGrid, GRID_SIZE } from '../city-viewer/js/map.js';

test('density bins preserve exactly the visible raw-point counts, including negative pixel cells', () => {
  const points = [{ x: 1, y: 2, point: 'a' }, { x: 31, y: 31, point: 'b' }, { x: 32, y: 0, point: 'c' }, { x: -1, y: -1, point: 'd' }];
  const grid = buildPixelGrid(points);
  assert.equal(GRID_SIZE, 32); assert.equal(grid.size, 3);
  assert.equal([...grid.values()].reduce((sum, bucket) => sum + bucket.count, 0), points.length);
  assert.equal(grid.get('0:0').count, 2); assert.equal(grid.get('-1:-1').count, 1);
  assert.equal(grid.get('0:0').first, 'a');
  assert.equal(grid.get('0:0').sumX / grid.get('0:0').count, 16);
});

test('map density helper rejects invalid geometry rather than silently omitting points', () => {
  assert.throws(() => buildPixelGrid([{ x: NaN, y: 0 }]), /Invalid/);
  assert.throws(() => buildPixelGrid([], 0), /Invalid/);
});
