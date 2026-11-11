import { toWgs84 } from './coordinates.js';

export const CANVAS_THRESHOLD = 1500;
export const GRID_SIZE = 32;
const coordinateCache = new WeakMap();

function addToGrid(grid, pixel, cellSize) {
  const key = `${Math.floor(pixel.x / cellSize)}:${Math.floor(pixel.y / cellSize)}`;
  let bucket = grid.get(key);
  if (!bucket) {
    bucket = { count: 0, sumX: 0, sumY: 0, first: pixel.point };
    grid.set(key, bucket);
  }
  bucket.count++;
  bucket.sumX += pixel.x;
  bucket.sumY += pixel.y;
}

// Pure helper for regression tests: aggregation never discards rows or invents points.
export function buildPixelGrid(pixels, cellSize = GRID_SIZE) {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Invalid density cell size');
  const grid = new Map();
  for (const pixel of pixels) {
    if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) throw new Error('Invalid projected point');
    addToGrid(grid, pixel, cellSize);
  }
  return grid;
}

function pointFor(row, map) {
  let point = coordinateCache.get(row);
  if (!point) {
    const [lng, lat] = toWgs84(row[1], row[2], 'BD-09');
    const world = map.project([lat, lng], 0);
    point = Object.freeze({ row, lng, lat, worldX: world.x, worldY: world.y });
    coordinateCache.set(row, point);
  }
  return point;
}

function frameFor(map) {
  const size = map.getSize();
  const topLeft = map.containerPointToLayerPoint([0, 0]);
  const origin = map.getPixelOrigin().add(topLeft);
  const scale = map.getZoomScale(map.getZoom(), 0);
  return { width: size.x, height: size.y, topLeft, originX: origin.x, originY: origin.y, scale, worldWidth: 256 * scale };
}

function pixelFor(point, frame) {
  let x = point.worldX * frame.scale - frame.originX;
  // OSM wraps the world; choose the copy nearest the current viewport without duplicating a row.
  x += Math.round((frame.width / 2 - x) / frame.worldWidth) * frame.worldWidth;
  return { x, y: point.worldY * frame.scale - frame.originY, point };
}

export function createMap(container) {
  if (!globalThis.L || !container) return null;
  const L = globalThis.L;
  try {
    const map = L.map(container, { zoomControl: true, scrollWheelZoom: true, preferCanvas: true, minZoom: 3 }).setView([35.8, 104.2], 4);
    const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const state = { map, tileLayer, container, popup: null, points: [], grid: new Map(), mode: 'points', renderedCount: 0, activeRow: null, canvasLayer: null, bound: false };
    const PointCanvas = L.Layer.extend({
      onAdd(instance) {
        this._map = instance;
        this._canvas = L.DomUtil.create('canvas', 'baidu-point-canvas leaflet-zoom-hide');
        this._canvas.style.position = 'absolute';
        this._canvas.style.pointerEvents = 'none';
        instance.getPane('overlayPane').appendChild(this._canvas);
        instance.on('move moveend zoomend viewreset resize', this.schedule, this);
        this.draw();
      },
      onRemove(instance) {
        instance.off('move moveend zoomend viewreset resize', this.schedule, this);
        if (this._frame) cancelAnimationFrame(this._frame);
        this._frame = 0;
        L.DomUtil.remove(this._canvas);
        this._map = null;
      },
      schedule() {
        if (!this._map || this._frame) return;
        this._frame = requestAnimationFrame(() => { this._frame = 0; if (this._map) this.draw(); });
      },
      draw() {
        if (!this._map) return;
        const frame = frameFor(this._map);
        const canvas = this._canvas;
        const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(frame.width * ratio));
        const height = Math.max(1, Math.round(frame.height * ratio));
        L.DomUtil.setPosition(canvas, frame.topLeft);
        canvas.style.width = frame.width + 'px';
        canvas.style.height = frame.height + 'px';
        canvas.style.display = '';
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, frame.width, frame.height);
        state.grid.clear();
        state.renderedCount = 0;
        const radius = state.points.length >= CANVAS_THRESHOLD ? 3 : 5;
        if (state.mode === 'points') ctx.beginPath();
        for (const point of state.points) {
          const pixel = pixelFor(point, frame);
          if (pixel.x < -20 || pixel.x > frame.width + 20 || pixel.y < -20 || pixel.y > frame.height + 20) continue;
          state.renderedCount++;
          if (state.mode === 'density') addToGrid(state.grid, pixel, GRID_SIZE);
          else {
            ctx.moveTo(pixel.x + radius, pixel.y);
            ctx.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
          }
        }
        if (state.mode === 'points') {
          ctx.fillStyle = '#ef6570';
          ctx.fill();
          ctx.strokeStyle = '#ffd9dc';
          ctx.lineWidth = 0.7;
          ctx.stroke();
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = 'bold 11px "Segoe UI", "Microsoft YaHei", sans-serif';
          for (const bucket of state.grid.values()) {
            const x = bucket.sumX / bucket.count, y = bucket.sumY / bucket.count;
            const r = Math.min(18, 5 + Math.log2(bucket.count + 1) * 2);
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = bucket.count > 50 ? '#dc5660' : '#b57731'; ctx.fill();
            ctx.lineWidth = 1; ctx.strokeStyle = '#f4d9b1'; ctx.stroke();
            if (bucket.count > 1) { ctx.fillStyle = '#fff'; ctx.fillText(String(bucket.count), x, y); }
          }
        }
        if (state.activeRow) {
          const pixel = pixelFor(pointFor(state.activeRow, this._map), frame);
          ctx.beginPath(); ctx.arc(pixel.x, pixel.y, 9, 0, Math.PI * 2);
          ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
        }
      },
    });
    state.canvasLayer = new PointCanvas().addTo(map);
    return state;
  } catch (error) {
    // The list/import remains usable when a browser cannot initialize a map.
    console.warn('Baidu metadata map unavailable:', error.message);
    return null;
  }
}

export function renderMap(state, rows, mode = 'points') {
  if (!state) return;
  if (!['points', 'density'].includes(mode)) throw new Error('Unknown map display mode');
  const sameRows = state.points.length === rows.length && (!rows.length || (state.points[0]?.row === rows[0] && state.points.at(-1)?.row === rows.at(-1)));
  const points = [];
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const row of rows) {
    const point = pointFor(row, state.map);
    points.push(point);
    minLng = Math.min(minLng, point.lng); minLat = Math.min(minLat, point.lat);
    maxLng = Math.max(maxLng, point.lng); maxLat = Math.max(maxLat, point.lat);
  }
  state.points = points;
  state.mode = mode;
  if (state.activeRow && !rows.includes(state.activeRow)) state.activeRow = null;
  if (!sameRows && points.length) {
    if (points.length === 1) state.map.setView([points[0].lat, points[0].lng], 13);
    else state.map.fitBounds([[minLat, minLng], [maxLat, maxLng]], { padding: [24, 24], maxZoom: 15 });
  }
  state.canvasLayer.schedule();
}

export function highlightRow(state, row, focus = false) {
  if (!state) return;
  state.activeRow = row || null;
  if (row && focus) {
    const point = pointFor(row, state.map);
    state.map.setView([point.lat, point.lng], Math.max(state.map.getZoom(), 14));
  }
  state.canvasLayer.schedule();
}

export function fitRows(state, rows) {
  if (!state || !rows.length) return;
  let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(const row of rows){const point=pointFor(row,state.map);west=Math.min(west,point.lng);south=Math.min(south,point.lat);east=Math.max(east,point.lng);north=Math.max(north,point.lat);}
  state.map.fitBounds([[south,west],[north,east]],{padding:[30,45],maxZoom:15});
}

export function setBasemap(state, mode) {
  if(!state||!['osm','osm-dark','none'].includes(mode))return;
  state.container.classList.toggle('map-dark',mode==='osm-dark');
  state.container.classList.toggle('map-blank',mode==='none');
  if(mode==='none')state.tileLayer.remove();else if(!state.map.hasLayer(state.tileLayer))state.tileLayer.addTo(state.map);
}

export function openRowPopup(state,row,element) {
  if(!state||!row)return;
  if(state.popup){state.popup.off('remove');state.popup.remove();}
  const point=pointFor(row,state.map);
  const popup=globalThis.L.popup({maxWidth:360,minWidth:250,autoPanPadding:[20,25],closeButton:true}).setLatLng([point.lat,point.lng]).setContent(element);
  state.popup=popup;
  popup.on('remove',()=>{if(state.popup===popup){state.popup=null;document.dispatchEvent(new CustomEvent('baidu:popupclosed'));}});
  popup.openOn(state.map);
}

export function closeRowPopup(state) {
  if(!state?.popup)return;
  state.popup.off('remove');state.popup.remove();state.popup=null;
}

export function bindMapInteractions(state) {
  if (!state || state.bound) return;
  state.bound = true;
  state.map.on('click', event => {
    const frame = frameFor(state.map);
    const clicked = event.containerPoint || state.map.latLngToContainerPoint(event.latlng);
    const radius = globalThis.matchMedia?.('(max-width: 680px)').matches ? 24 : 16;
    let nearest = null, distanceSquared = radius * radius;
    for (const point of state.points) {
      const pixel = pixelFor(point, frame);
      const dx = pixel.x - clicked.x, dy = pixel.y - clicked.y, d = dx * dx + dy * dy;
      if (d < distanceSquared) { nearest = point; distanceSquared = d; }
    }
    if (!nearest && state.mode === 'density') {
      for (const bucket of state.grid.values()) {
        const dx = bucket.sumX / bucket.count - clicked.x, dy = bucket.sumY / bucket.count - clicked.y;
        if (dx * dx + dy * dy < distanceSquared) { nearest = bucket.first; distanceSquared = dx * dx + dy * dy; }
      }
    }
    if (nearest) document.dispatchEvent(new CustomEvent('baidu:select', { detail: nearest.row }));
  });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => state.map.invalidateSize({ debounceMoveend: true }));
    observer.observe(state.map.getContainer());
    state.map.once('unload', () => observer.disconnect());
  }
}
