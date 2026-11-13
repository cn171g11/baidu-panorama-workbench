import { convertCoordinate } from './coordinates.js';
import { categoryFor } from './classification.js';

export const CANVAS_THRESHOLD = 1500;
export const GRID_SIZE = 32;
export const BASEMAP_MODES = Object.freeze(['amap-dark', 'amap', 'amap-satellite', 'osm', 'osm-dark', 'none']);
export const POINT_COLORS = Object.freeze({regular:'#FFD400',hidden:'#FF1A1A','time-machine':'#B47AF0',unknown:'#00E5FF'});
const cache = new WeakMap();
const systemFor = mode => mode.startsWith('amap') ? 'GCJ-02' : 'WGS84';
const amap = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
const basemaps = {
  'amap-dark':{url:amap,dark:true,subdomains:'1234',maxNativeZoom:18,attribution:'© 高德地图'},
  amap:{url:amap,subdomains:'1234',maxNativeZoom:18,attribution:'© 高德地图'},
  'amap-satellite':{url:'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',subdomains:'1234',maxNativeZoom:18,attribution:'© 高德地图'},
  osm:{url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',subdomains:'abc',maxNativeZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'},
  'osm-dark':{url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',dark:true,subdomains:'abc',maxNativeZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'},
};
export function displayModeFor(mode,zoom) { return mode==='density'&&zoom<15?'density-grid':'points'; }
export function projectForBasemap(lng,lat,mode='amap-dark') { return convertCoordinate(lng,lat,'BD-09',systemFor(mode)); }
function addToGrid(grid,pixel,size){
  const key=`${Math.floor(pixel.x/size)}:${Math.floor(pixel.y/size)}`;
  let cell=grid.get(key);
  if(!cell){cell={count:0,sumX:0,sumY:0,first:pixel.point,hidden:0,timeMachine:0,left:Math.floor(pixel.x/size)*size,top:Math.floor(pixel.y/size)*size};grid.set(key,cell);}
  cell.count++;cell.sumX+=pixel.x;cell.sumY+=pixel.y;
  if(pixel.point?.category==='hidden')cell.hidden++;
  if(pixel.point?.category==='time-machine')cell.timeMachine++;
}
export function buildPixelGrid(pixels,cellSize=GRID_SIZE){
  if(!Number.isFinite(cellSize)||cellSize<=0)throw Error('Invalid density cell size');
  const grid=new Map();for(const pixel of pixels){if(!Number.isFinite(pixel.x)||!Number.isFinite(pixel.y))throw Error('Invalid projected point');addToGrid(grid,pixel,cellSize);}return grid;
}
function pointFor(row,map){
  let point=cache.get(row);if(point)return point;
  const wgs=projectForBasemap(row[1],row[2],'osm'),gcj=projectForBasemap(row[1],row[2],'amap');
  const a=map.project([wgs[1],wgs[0]],0),b=map.project([gcj[1],gcj[0]],0);
  const category=categoryFor(row);
  point={row,lng:wgs[0],lat:wgs[1],gcjLng:gcj[0],gcjLat:gcj[1],worldX:a.x,worldY:a.y,gcjWorldX:b.x,gcjWorldY:b.y,category,color:category==='regular'&&!row[7]?'unknown':category};
  cache.set(row,point);return point;
}
function latLng(point,state){return systemFor(state.basemap)==='GCJ-02'?[point.gcjLat,point.gcjLng]:[point.lat,point.lng];}
function frameFor(state){
  const map=state.map,size=map.getSize(),topLeft=map.containerPointToLayerPoint([0,0]),origin=map.getPixelOrigin().add(topLeft),scale=map.getZoomScale(map.getZoom(),0);
  return {width:size.x,height:size.y,topLeft,originX:origin.x,originY:origin.y,scale,worldWidth:256*scale,useGcj:systemFor(state.basemap)==='GCJ-02'};
}
function pixelFor(point,frame){let x=(frame.useGcj?point.gcjWorldX:point.worldX)*frame.scale-frame.originX;x+=Math.round((frame.width/2-x)/frame.worldWidth)*frame.worldWidth;return {x,y:(frame.useGcj?point.gcjWorldY:point.worldY)*frame.scale-frame.originY,point};}
function inside(pixel,frame){return pixel.x>=0&&pixel.x<=frame.width&&pixel.y>=0&&pixel.y<=frame.height;}
function drawBatch(ctx,pixels,color,radius,outline=false){
  ctx.fillStyle=color;ctx.beginPath();let count=0;
  for(const pixel of pixels){ctx.moveTo(pixel.x+radius,pixel.y);ctx.arc(pixel.x,pixel.y,radius,0,Math.PI*2);if(++count%20000===0){ctx.fill();if(outline){ctx.strokeStyle='#fff';ctx.lineWidth=1.3;ctx.stroke();}ctx.beginPath();}}
  ctx.fill();if(outline){ctx.strokeStyle='#fff';ctx.lineWidth=1.3;ctx.stroke();}
}
export function createMap(container){
  if(!globalThis.L||!container)return null;
  const L=globalThis.L;
  try{
    const initial=convertCoordinate(104.2,35.8,'WGS84','GCJ-02');
    const map=L.map(container,{zoomControl:true,scrollWheelZoom:true,preferCanvas:true,minZoom:3,maxZoom:20}).setView([initial[1],initial[0]],4);
    const state={map,container,tileLayer:null,popup:null,points:[],background:[],grid:new Map(),mode:'points',actualMode:'points',renderedCount:0,drawnSymbols:0,activeRow:null,canvasLayer:null,bound:false,basemap:'amap-dark'};
    const PointCanvas=L.Layer.extend({
      onAdd(instance){this._map=instance;this._canvas=L.DomUtil.create('canvas','baidu-point-canvas leaflet-zoom-hide');this._canvas.style.cssText='position:absolute;pointer-events:none';instance.getPane('overlayPane').appendChild(this._canvas);instance.on('move moveend zoomend viewreset resize',this.schedule,this);this.draw();},
      onRemove(instance){instance.off('move moveend zoomend viewreset resize',this.schedule,this);if(this._frame)cancelAnimationFrame(this._frame);L.DomUtil.remove(this._canvas);this._map=null;},
      schedule(){if(!this._map||this._frame)return;this._frame=requestAnimationFrame(()=>{this._frame=0;if(this._map)this.draw();});},
      draw(){
        if(!this._map)return;const frame=frameFor(state),canvas=this._canvas,ratio=Math.min(globalThis.devicePixelRatio||1,2);
        L.DomUtil.setPosition(canvas,frame.topLeft);canvas.style.width=frame.width+'px';canvas.style.height=frame.height+'px';canvas.style.display='';
        const width=Math.max(1,Math.round(frame.width*ratio)),height=Math.max(1,Math.round(frame.height*ratio));if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
        const ctx=canvas.getContext('2d');if(!ctx)return;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,frame.width,frame.height);
        state.grid.clear();state.renderedCount=0;state.drawnSymbols=0;state.actualMode=displayModeFor(state.mode,map.getZoom());
        ctx.fillStyle='rgba(150,170,195,.28)';for(const point of state.background){const p=pixelFor(point,frame);if(inside(p,frame))ctx.fillRect(p.x-1,p.y-1,2,2);}
        const groups={regular:[],hidden:[],'time-machine':[],unknown:[]};
        for(const point of state.points){const p=pixelFor(point,frame);if(!inside(p,frame))continue;state.renderedCount++;if(state.mode==='density')addToGrid(state.grid,p,GRID_SIZE);if(state.actualMode==='points')groups[point.color].push(p);}
        if(state.actualMode==='points'){
          for(const key of ['regular','unknown','time-machine','hidden']){drawBatch(ctx,groups[key],POINT_COLORS[key],key==='hidden'?3:2,key==='hidden');state.drawnSymbols+=groups[key].length;}
        }else{
          let max=1;for(const cell of state.grid.values())max=Math.max(max,cell.count);const log=Math.log(max+1);
          for(const cell of state.grid.values()){
            const value=Math.log(cell.count+1)/log;ctx.fillStyle=`rgba(${Math.round(value*255)},${Math.round(229-17*value)},${Math.round(255*(1-value))},.83)`;
            ctx.fillRect(cell.left+1,cell.top+1,GRID_SIZE-2,GRID_SIZE-2);
            // Preserve visibility of rare source-marked hidden/history points in dense ordinary cells.
            if(cell.hidden){ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.strokeRect(cell.left+1,cell.top+1,GRID_SIZE-2,GRID_SIZE-2);ctx.fillStyle=POINT_COLORS.hidden;ctx.fillRect(cell.left+3,cell.top+3,6,6);}
            if(cell.timeMachine){ctx.fillStyle=POINT_COLORS['time-machine'];ctx.fillRect(cell.left+11,cell.top+3,6,6);}state.drawnSymbols++;
          }
        }
        if(state.activeRow){const p=pixelFor(pointFor(state.activeRow,map),frame);ctx.beginPath();ctx.arc(p.x,p.y,9,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}
        state.container.dispatchEvent(new CustomEvent('baidu:maprendered'));
      }
    });
    state.canvasLayer=new PointCanvas().addTo(map);setBasemap(state,'amap-dark');return state;
  }catch(error){console.warn('Baidu metadata map unavailable:',error.message);return null;}
}
export function renderMap(state,rows,mode='points',backgroundRows=[]){
  if(!state)return;if(!['points','density'].includes(mode))throw Error('Unknown map display mode');
  const sameRows=state.points.length===rows.length&&state.points.every((point,i)=>point.row===rows[i]);
  state.points=rows.map(row=>pointFor(row,state.map));state.mode=mode;
  const hits=new Set(rows);state.background=backgroundRows.filter(row=>!hits.has(row)).map(row=>pointFor(row,state.map));
  if(state.activeRow&&!hits.has(state.activeRow))state.activeRow=null;
  if(!sameRows&&rows.length)fitRows(state,rows);state.canvasLayer.schedule();
}
export function fitRows(state,rows){
  if(!state||!rows.length)return;let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(const row of rows){const [lat,lng]=latLng(pointFor(row,state.map),state);west=Math.min(west,lng);south=Math.min(south,lat);east=Math.max(east,lng);north=Math.max(north,lat);}
  if(rows.length===1)state.map.setView([south,west],Math.max(15,state.map.getZoom()),{animate:false});
  else state.map.fitBounds([[south,west],[north,east]],{padding:[30,45],maxZoom:15,animate:false});
}
export function highlightRow(state,row,focus=false){if(!state)return;state.activeRow=row||null;if(row&&focus)state.map.setView(latLng(pointFor(row,state.map),state),Math.max(state.map.getZoom(),16),{animate:false});state.canvasLayer.schedule();}
export function setBasemap(state,mode){
  if(!state||!BASEMAP_MODES.includes(mode))return false;
  const center=state.map.getCenter(),zoom=state.map.getZoom(),from=systemFor(state.basemap),to=systemFor(mode);
  const [lng,lat]=convertCoordinate(center.lng,center.lat,from,to);
  if(state.tileLayer){state.tileLayer.remove();state.tileLayer=null;}
  const definition=basemaps[mode];if(definition)state.tileLayer=globalThis.L.tileLayer(definition.url,{subdomains:definition.subdomains,minZoom:3,maxZoom:20,maxNativeZoom:definition.maxNativeZoom,attribution:definition.attribution}).addTo(state.map);
  state.basemap=mode;state.container.classList.toggle('map-dark',!!definition?.dark);state.container.classList.toggle('map-blank',mode==='none');
  state.map.setView([lat,lng],zoom,{animate:false});
  if(state.popup&&state.activeRow)state.popup.setLatLng(latLng(pointFor(state.activeRow,state.map),state));
  state.canvasLayer.schedule();return true;
}
export function openRowPopup(state,row,element){
  if(!state||!row)return;if(state.popup){state.popup.off('remove');state.popup.remove();}
  const popup=globalThis.L.popup({maxWidth:360,minWidth:220,autoPanPadding:[20,25],closeButton:true}).setLatLng(latLng(pointFor(row,state.map),state)).setContent(element);state.popup=popup;
  popup.on('remove',()=>{if(state.popup===popup){state.popup=null;document.dispatchEvent(new CustomEvent('baidu:popupclosed'));}});popup.openOn(state.map);
}
export function closeRowPopup(state){if(!state?.popup)return;state.popup.off('remove');state.popup.remove();state.popup=null;}
export function bindMapInteractions(state){
  if(!state||state.bound)return;state.bound=true;
  state.map.on('click',event=>{
    const frame=frameFor(state),clicked=event.containerPoint||state.map.latLngToContainerPoint(event.latlng);let nearest=null,best=Infinity;
    for(const point of state.points){const p=pixelFor(point,frame);if(!inside(p,frame))continue;const d=(p.x-clicked.x)**2+(p.y-clicked.y)**2;if(d<best){nearest=point;best=d;}}
    if(nearest)document.dispatchEvent(new CustomEvent('baidu:select',{detail:nearest.row}));
  });
  if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(()=>state.map.invalidateSize({debounceMoveend:true}));observer.observe(state.container);state.map.once('unload',()=>observer.disconnect());}
}
