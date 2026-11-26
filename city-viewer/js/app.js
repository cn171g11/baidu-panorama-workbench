import { loadBlueCityManifest, loadBlueCity, blueCityName, normalizeBluePoint } from './blue-city-data.js';
import { createLoadFeedback } from './load-feedback.js';
import { fetchBytes, fetchJson, nextPaint } from './transfer.js';
import { COUNTY_PARTITION, selectCountyFiles } from './county-data.js';
import { captureInfo, enrichCapturedRow, panoidCaptured } from './panoid-time.js';
import { categoryFor, countCategories } from './classification.js';
import { parseImport, validateRows, filterRows, baiduPanoramaUrl, mergeRows } from './metadata.js';
import { loadCatalog, loadCollection, saveLocalRows, loadLocalRows, clearLocalRows } from './data-store.js';
import { createMap, renderMap, bindMapInteractions, highlightRow, fitRows, setBasemap, openRowPopup, closeRowPopup } from './map.js';

const PAGE_SIZE = 50;
const GLOBAL_COLLECTION_ID = '191001';
const isOverseasCollection = city => city.province === '海外';
// The type filter drives two independent layers: street rows (source labels) and the
// separate 小蓝点 layer. `blue` is a layer scope, never a street category.
const KIND_LABELS = Object.freeze({ all: '全部类型', regular: '常规', hidden: '隐藏 · 源标注', 'time-machine': '时光机 · 源标注', unknown: '未知', blue: '小蓝点' });
const STREET_KINDS = Object.freeze(['regular', 'hidden', 'time-machine', 'unknown']);
const KIND_VALUES = Object.freeze(['all', ...STREET_KINDS, 'blue']);
const $ = (id) => document.getElementById(id);
const elements = {
  summaryCities: $('summary-cities'), summaryRaw: $('summary-raw'), summaryUnique: $('summary-unique'), summaryDuplicates: $('summary-duplicates'),
  source: $('source-state'), province: $('province-filter'), city: $('city-filter'), county:$('county-filter'), shard:$('shard-filter'), search: $('search-input'), road: $('road-filter'), date: $('date-filter'),
  count: $('result-count'), mapCount: $('map-result-count'), mapEmpty: $('map-empty'), empty: $('empty-state'), list: $('record-list'), rows: $('record-rows'), pageSummary: $('page-summary'), pageNumber: $('page-number'),
  prev: $('page-prev'), next: $('page-next'), detail: $('detail-panel'), export: $('export-data'), dialog: $('import-dialog'), importMessage: $('import-message'), importText: $('import-text'), importFile: $('import-file'), format: $('import-format'), coordinate: $('coordinate-system'), confirmBaidu: $('confirm-baidu'), live: $('live-message')
};
const state = { catalog: null, blueManifestTotal: 0, blueOsmManifest: null, blueCountyDirectory: null, publishedRows: [], localRows: [], visibleRows: [], blueRows: [], selected: null, page: 0, mode: 'points', mapModeManual: false, map: null, collectionById: new Map(), loadedCollection: null, totalPublished: 0, ready: false, listOpen: false, loading: false, loadedSelection:null };
const cityCache = new Map();
let activeLoad = null;
let activeController=null;
function cancelActiveLoad(){activeController?.abort();activeController=null;activeLoad=null;loadFeedback.cancel('street');}
const loadFeedback = createLoadFeedback(document, { onChange: feedback => {
  state.loading = feedback.pending.length > 0;
  state.streetLoading = feedback.pending.some(job => job.key === 'street');
  state.blueLoading = feedback.pending.some(job => job.key === 'blue');
  state.loadFeedback = feedback;
  updateStatus(); refreshSnapshot();
} });
function setListOpen(open) {
  state.listOpen = open;
  $('records-panel').hidden = !open;
  $('toggle-list').setAttribute('aria-expanded',String(open));
  $('toggle-list').textContent = open ? '收起列表' : '列表';
}
function resizeToolbar() {
  const height = Math.ceil($('viewer-toolbar').getBoundingClientRect().height);
  document.body.style.setProperty('--toolbar-height',height+'px');
  state.map?.map.invalidateSize({debounceMoveend:true});
}
// One owner for the 匹配点 counter so it always reflects the filtered layers.
function mapMatchText(){
  const kind=currentKind(), blue=blueRowsVisible().length;
  if(kind==='blue')return `${blue.toLocaleString()} 条小蓝点`;
  const parts=[`街景 ${state.visibleRows.length.toLocaleString()}`];
  if(kind==='all')parts.push(`小蓝点 ${blue.toLocaleString()}`);
  return parts.join(' · ');
}
function updateMapCount(){
  const rendered=state.map?.renderedCount||0;
  elements.mapCount.textContent=`视野 ${rendered.toLocaleString()} / 匹配 ${mapMatchText()}`;
}function updateHud() {
  if(!state.map)return;
  $('hud-zoom').textContent='Z '+state.map.map.getZoom()+' · '+(state.map.actualMode==='density-grid'?'密度网格':'散点');
  const coordinateSystem=state.map.basemap.startsWith('amap')?'GCJ-02':'WGS84';
  $('coordinate-label').textContent='元数据 BD-09 · 底图 '+coordinateSystem;
  updateMapCount();
  // 显示当前已加载的点位总数（街景 + 小蓝点）
  const loadedTotal=allRows().length+state.blueRows.length;
  $('hud-loaded-count').textContent=`已加载 ${loadedTotal.toLocaleString()} 条点位`;
  const center=state.map.map.getCenter();
  $('hud-coordinate').textContent=center.lat.toFixed(5)+', '+center.lng.toFixed(5);
}
function updateStatus() {
  if(!state.catalog)return;
  const loaded=state.loadedCollection?state.collectionById.get(state.loadedCollection):null;
  const county=loaded?.counties?.find(item=>item.id===elements.county.value);
  const part=county&&elements.shard.value!=='all'?` · 第${Number(elements.shard.value)+1}/${county.files.length}片`:'';
  const name=loaded?loaded.name+(county?' / '+county.name:'')+part:null;
  const blueTotal=state.blueManifestTotal||0;const combinedTotal=state.totalPublished+blueTotal;
  const waiting = state.loadFeedback?.pending.map(job => job.label).join('、');
  const kindFilter=currentKind()==='all'?'':` · 筛选 ${kindLabel()}`;
  elements.source.querySelector('span:last-child').textContent=waiting?`加载中：${waiting}`:`Pages ${state.catalog.collections.length} 集合 · 街景 ${state.totalPublished.toLocaleString()} · 小蓝点 ${blueTotal.toLocaleString()} · 百度${kindFilter}`;
  $('fit-city').disabled=state.visibleRows.length===0&&blueRowsVisible().length===0;
  const counts=countCategories(state.visibleRows), blueVisible=blueRowsVisible().length, hints=[];
  if(state.visibleRows.length)hints.push(`${state.visibleRows.length.toLocaleString()} 个匹配街景点 · 常规 ${counts.regular.toLocaleString()} / 隐藏 ${counts.hidden.toLocaleString()} / 时光机 ${counts.timeMachine.toLocaleString()}`);
  if(blueVisible)hints.push(`小蓝点 ${blueVisible.toLocaleString()} 个`);
  $('map-hint').textContent=hints.length?`${hints.join(' · ')} · 点击地图查看最近点`:`选择省份、城市或全球集合；选县区可缩小街景范围`;
}
// Keep the legend and its note explicit about which layers the current type filter shows.
function updateKindChrome(){
  const kind=currentKind(), note=$('legend-note'), select=$('kind-filter');
  select?.classList?.toggle?.('blue-kind',kind==='blue');
  if(note)note.textContent=kind==='all'?'类型按源标注 · 同时显示街景与小蓝点':kind==='blue'?'仅显示小蓝点图层 · 街景已隐藏':`仅显示${kindLabel()}街景 · 小蓝点已隐藏`;
  document.querySelectorAll?.('.viewer-legend [data-kind]').forEach(node=>{
    const active=kind==='all'||node.dataset.kind===kind;
    node.classList?.toggle('legend-muted',!active);
    node.setAttribute?.('aria-current',active&&kind!=='all'?'true':'false');
  });
}
let noticeTimer;
function announce(message) {
  clearTimeout(noticeTimer);
  elements.live.textContent = message;
  elements.live.hidden = !message;
  if (message) noticeTimer = setTimeout(() => { elements.live.hidden = true; }, 8000);
}
function safe(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function setMessage(message, kind = '') { elements.importMessage.className = `form-message ${kind}`; elements.importMessage.textContent = message; }
function refreshSnapshot() {
  window.__BAIDU_WORKBENCH__ = Object.freeze({
    provider: 'baidu',
    getState: () => Object.freeze({
      ready: state.ready, rows: state.visibleRows.length, total: state.totalPublished,
      source: 'published-catalog', currentCollection: state.globalSelected ? GLOBAL_COLLECTION_ID : elements.city.value || elements.province.value || null,
      loadedCollection: state.loadedCollection, loadedSelection:state.loadedSelection, county:elements.county.value||null, shard:elements.shard.value, localCount: state.localRows.length,
      visibleCount: state.visibleRows.length, page: state.page + 1, pageSize: PAGE_SIZE,
      selectedPanoid: state.selected?.[0] || null, mapAvailable: Boolean(state.map), mapMode: state.mode,
      mapRenderedCount: state.map?.renderedCount || 0, mapGridCells: state.map?.grid.size || 0, mapBlueGridCells: state.map?.blueGrid?.size || 0,
      blueCount: state.blueRows.length, blueVisibleCount: blueRowsForSelection().length, blueRenderedCount: state.map?.bluePoints?.length || 0, blueProvince: elements.province.value || null,
      basemap:state.map?.basemap, actualMapMode:state.map?.actualMode, drawnSymbols:state.map?.drawnSymbols||0, kind:currentKind(), kindLabel:kindLabel(),
      blueLayerVisible: blueLayerShown(), blueMapCount: blueRowsVisible().length,
      collections: state.catalog?.collections.length || 0, blueTotal:state.blueManifestTotal, combinedTotal:state.totalPublished+state.blueManifestTotal, layout:'fullscreen-map', popupOpen:!!state.map?.popup, listOpen:state.listOpen, loading:state.loading,
      streetLoading: Boolean(state.streetLoading), blueLoading: Boolean(state.blueLoading), blueScope:state.blueScope||null, blueCity:state.blueCity||null, loadFeedback: state.loadFeedback || { pending: [], error: null },
    }),
  });
}
function allRows() { return state.localRows.length ? state.publishedRows.concat(state.localRows) : state.publishedRows; }
function collectionForRow(row) { return state.localRows.includes(row) ? 'local' : (row.__collectionId || ''); }

let collectionRequest = 0;
async function loadPublishedCollections(collections) {
  const cacheKey=collections.map(city=>selectedKey(city)).join(',');
  if(activeLoad?.key===cacheKey)return activeLoad.promise;
  const promise=loadPublishedCollectionsNow(collections);
  activeLoad={key:cacheKey,promise};
  try{return await promise;}finally{if(activeLoad?.promise===promise)activeLoad=null;}
}
function progressMessage(progress, noun) {
  const shard = progress.filesTotal ? `分片 ${Math.min(progress.filesDone + 1, progress.filesTotal)} / ${progress.filesTotal}` : '目录';
  const verified = `已校验 ${(progress.verifiedRows || 0).toLocaleString()}${progress.totalRows ? ' / ' + progress.totalRows.toLocaleString() : ''} 条${noun}`;
  if (progress.phase === 'download') {
    const mb = n => (n / 1048576).toFixed(2) + ' MB';
    return `${shard} · 下载 ${mb(progress.receivedBytes || 0)}${progress.totalBytes ? ' / ' + mb(progress.totalBytes) : ''} · ${verified}`;
  }
  const phase = { manifest: '读取清单', verify: '核对 SHA-256', decompress: '解压数据', validate: '校验记录', validated: '分片校验完成', render: '绘制地图' }[progress.phase] || '准备中';
  return `${shard} · ${phase} · ${verified}`;
}
async function loadPublishedCollectionsNow(collections) {
  const requestId = ++collectionRequest;
  activeController?.abort();const controller=new AbortController();activeController=controller;
  const requests=collections.map(city=>{
    const options={...streetSelection(city),signal:controller.signal};
    return {city,key:selectedKey(city),options,selection:selectedRequest(city,options)};
  });
  const total = requests.reduce((sum, item) => sum + item.selection.count, 0);
  const filesTotal = requests.reduce((sum, item) => sum + item.selection.files.length, 0);
  const label = elements.city.value || state.globalSelected ? collections[0].name : elements.province.value;
  const token = loadFeedback.start('street', `${label} · 街景`, {
    cancel: () => { if(activeController!==controller)return; ++collectionRequest; controller.abort(); activeController=null; activeLoad=null; updateView(); announce('街景加载已取消，可点击载入重试'); },
    retry: () => { void loadPublishedSelection(); },
  });
  elements.empty.hidden=true;
  loadFeedback.update(token, { phase:'preparing', message:`准备读取 ${total.toLocaleString()} 条街景 · ${filesTotal} 个分片` });
  await nextPaint();
  const nextRows = [];
  let completedFiles = 0;
  try {
    for (const request of requests) {
      controller.signal.throwIfAborted();
      const {city:collection,key,options,selection}=request;
      options.onProgress=progress=>{
        const accumulated={...progress,filesTotal,totalRows:total,filesDone:completedFiles+progress.filesDone,verifiedRows:nextRows.length+progress.verifiedRows};
        loadFeedback.update(token,{...accumulated,fraction:accumulated.filesDone/filesTotal,message:progressMessage(accumulated,'街景')});
      };
      let rows=cityCache.get(key);
      if(!rows){rows=await loadCollection(collection,options);if(requestId!==collectionRequest||controller.signal.aborted)return;cityCache.set(key,rows);while(cityCache.size>1)cityCache.delete(cityCache.keys().next().value);}
      if (requestId !== collectionRequest) return;
      for (let offset=0;offset<rows.length;offset+=2000) {
        controller.signal.throwIfAborted();
        for (const row of rows.slice(offset,offset+2000)) nextRows.push(Object.assign(row, { __collectionId: collection.id, __city: collection.name, __province: collection.province, __countyId:selection.county?.id||row[9]?.administrativeArea?.countyId||'unmatched', __county:selection.county?.name||row[9]?.administrativeArea?.countyName||'未匹配' }));
        if(rows.length>2000)await nextPaint();
      }
      completedFiles += selection.files.length;
    }
    if (requestId !== collectionRequest) return;
    loadFeedback.update(token,{phase:'render',filesDone:filesTotal,filesTotal,verifiedRows:nextRows.length,message:`已校验 ${nextRows.length.toLocaleString()} 条街景 · 正在绘制地图`,fraction:0.99});
    await nextPaint(); controller.signal.throwIfAborted();
    state.publishedRows = nextRows;
    state.loadedCollection = collections.length === 1 ? collections[0].id : null;
    state.loadedSelection=requests.length===1?requests[0].key:null;
    updateView();
    await nextPaint();
    if(requestId===collectionRequest){loadFeedback.finish(token);updateView();}
  } catch (error) {
    if (requestId !== collectionRequest) return;
    if(controller.signal.aborted){loadFeedback.finish(token);return;}
    loadFeedback.fail(token, error); updateView();
  } finally {
    if(activeController===controller)activeController=null;
  }
}

const BLUE_DOT_PROVINCES = ['北京市','天津市','河北省','山西省','内蒙古自治区','辽宁省','吉林省','黑龙江省','上海市','江苏省','浙江省','安徽省','福建省','江西省','山东省','河南省','湖北省','湖南省','广东省','广西壮族自治区','海南省','重庆市','四川省','贵州省','云南省','西藏自治区','陕西省','甘肃省','青海省','宁夏回族自治区','新疆维吾尔自治区'];
function populateFilters() {
  const provinces = new Set([...state.catalog.collections.filter(city=>!isOverseasCollection(city)).map(city=>city.province), ...BLUE_DOT_PROVINCES]);
  elements.province.innerHTML = '<option value="">全部省份</option>';
  [...provinces].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach(name => elements.province.add(new Option(name, name)));
  $('load-global').hidden = !globalCollection()?.count;
  syncCities();
}
function syncCities() {
  const previousCity = elements.city.value;
  const province = elements.province.value;
  const cities = province ? provinceCollections(province) : [];
  const blueCities = province ? (state.blueCityManifest
    ? state.blueCityManifest.collections.filter(city=>city.province===province).map(city=>city.name)
    : [...new Set([...state.blueRows.filter(row=>row.__province===province).map(row=>row.__blueCity).filter(Boolean), ...osmBlueCities(province)])]
  ).sort((a,b)=>a.localeCompare(b,'zh-CN')) : [];
  elements.city.innerHTML = `<option value="">${province ? (cities.length || blueCities.length ? '选择城市' : '该省暂未发布街景或蓝点') : '选择省份后载入'}</option>`;
  cities.forEach((c) => elements.city.add(new Option(c.name, c.id)));
  const blueNames=new Set();
  blueCities.filter(name => !cities.some(city => blueCityName(city.name) === blueCityName(name))).forEach(name=>{const key=blueCityName(name);if(!blueNames.has(key)){blueNames.add(key);elements.city.add(new Option(name, `blue:${name}`));}});
  if ([...elements.city.options].some(option => option.value === previousCity)) elements.city.value = previousCity;
  else if(previousCity.startsWith('blue:')) {
    const replacement = [...elements.city.options].find(option=>option.value.startsWith('blue:') && blueCityName(option.value.slice(5))===blueCityName(previousCity.slice(5)));
    if(replacement)elements.city.value=replacement.value;
  }
  elements.city.disabled = !province || (!cities.length && !blueCities.length);
  syncCounties();
}
function syncCounties(){
  const previousCounty = elements.county.value;
  const city=state.collectionById.get(elements.city.value);
  const normalizeCity = name => name.replace(/市$/,'');
  const blueCity=elements.city.value.startsWith('blue:') ? normalizeCity(elements.city.value.slice(5)) : (city?.province===elements.province.value ? normalizeCity(city.name) : '');
  const streetCounties=city?.partition===COUNTY_PARTITION;
  const blueCounties=blueCity?blueCountyOptions(blueCity):[];
  const blueRows=state.blueRows.filter(row=>normalizeCity(row.__blueCity||'')===blueCity);
  const hasUnmatched=blueRows.some(row=>['unmatched','ambiguous','no-boundary'].includes(row[9]?.administrativeArea?.match));
  const hasBlue=blueCounties.length>0||blueRows.length>0;
  const prompt=streetCounties?'选择县 / 区（街景按需载入）':hasBlue?'全部蓝点县区（可筛选）':city?'整市街景数据':state.blueLoading?'蓝点正在加载，可取消或等待':'先选择城市';
  elements.county.replaceChildren(new Option(prompt,''));
  if(streetCounties){
    const allOption=new Option(`全部街景县区 · ${city.count.toLocaleString()}点（较大）`,'all');allOption.disabled=city.count===0;elements.county.add(allOption);
    for(const county of city.counties){const option=new Option(`${county.name} · 街景 ${county.count.toLocaleString()}点`,county.id);option.disabled=county.count===0;elements.county.add(option);}
  }
  for(const name of blueCounties)elements.county.add(new Option(`${name}（OSM蓝点）`,`blue:${name}`));
  if(hasUnmatched)elements.county.add(new Option('未匹配 / 边界歧义（OSM蓝点）','blue:__unmatched__'));
  if ([...elements.county.options].some(option => option.value === previousCounty)) elements.county.value = previousCounty;
  elements.county.disabled=!streetCounties&&!blueCounties.length&&!hasUnmatched;
  syncShards();
}
function syncShards(){
  const previousShard = elements.shard.value;
  const city=state.collectionById.get(elements.city.value),county=city?.counties?.find(item=>item.id===elements.county.value);
  elements.shard.replaceChildren();
  if(county&&county.files.length>1){
    county.files.forEach((file,index)=>elements.shard.add(new Option(`第${index+1}/${county.files.length}片 · ${Math.min(25000,county.count-index*25000).toLocaleString()}点`,String(index))));
    elements.shard.add(new Option(`全部${county.files.length}片（较大）`,'all'));elements.shard.disabled=false;
  }else{elements.shard.add(new Option('全部分片','all'));elements.shard.disabled=true;}
  if ([...elements.shard.options].some(option => option.value === previousShard)) elements.shard.value = previousShard;
  const blueSelection=elements.city.value.startsWith('blue:')||elements.county.value.startsWith('blue:');
  $('load-city').disabled=blueSelection?!elements.province.value:!selectedStreetCollections().length;
  $('load-city').textContent=blueSelection?'重试蓝点':'载入街景';
  $('load-city').title=blueSelection?'只读取当前所选城市的蓝点分片':'载入当前范围的已发布街景分片';
}
function globalCollection(){
  const city=state.collectionById.get(GLOBAL_COLLECTION_ID);
  return city?.scope==='overseas' && isOverseasCollection(city) ? city : null;
}
function provinceCollections(province){
  return state.catalog.collections.filter(city=>!isOverseasCollection(city)&&city.province===province);
}
function selectedStreetCollections(){
  if(elements.city.value.startsWith('blue:')||elements.county.value.startsWith('blue:'))return [];
  if(state.globalSelected)return [globalCollection()].filter(city=>city?.count>0);
  const city=state.collectionById.get(elements.city.value);
  if(city)return city.count>0?[city]:[];
  return elements.province.value ? provinceCollections(elements.province.value).filter(city=>city.count>0) : [];
}
function streetSelection(city){
  const county=city.partition===COUNTY_PARTITION&&elements.city.value===city.id&&!elements.county.value.startsWith('blue:') ? elements.county.value||'all' : 'all';
  return {county,part:county==='all'?'all':elements.shard.value};
}
function selectedKey(city){
  const {county,part}=streetSelection(city);
  return `${city.id}:${county}:${part}`;
}
function selectedRequest(city,{county,part}){
  if(city.partition===COUNTY_PARTITION)return selectCountyFiles(city,county,part);
  return {files:city.files,count:city.count,county:null,part:'all'};
}
async function loadPublishedSelection(){
  const collections=selectedStreetCollections();
  if(collections.length)await loadPublishedCollections(collections);
}

// --- 小蓝点独立图层 ------------------------------------------------------------
// 按选择省份从小蓝点全国目录加载文本JSON gzip子片；只显示在地图，不入普通列表。
const BLUE_DOTS_URL = new URL('../data/blue-dots/', import.meta.url);
const blueDotCache = new Map();
let blueDotController = null;
let blueDotManifestPromise = null;
let blueOsmManifestPromise = null;
let blueNationalCountyPromise = null;
let blueCityManifestPromise = null;
function readBlueCityManifest(){
  if(!blueCityManifestPromise)blueCityManifestPromise=loadBlueCityManifest().catch(error=>{blueCityManifestPromise=null;throw error;});
  return blueCityManifestPromise;
}
function selectedBlueCity(){
  if(elements.city.value.startsWith('blue:'))return elements.city.value.slice(5);
  const city=state.collectionById.get(elements.city.value);
  return city&&city.province===elements.province.value?city.name:'';
}
function loadBlueDotsForSelection(){
  const city=selectedBlueCity();
  return city?loadBlueDotsForCity(elements.province.value||'',city):loadBlueDotsForProvince(elements.province.value||'');
}
function loadNationalCountyDirectory(){if(!blueNationalCountyPromise)blueNationalCountyPromise=fetchJson(new URL('../data/blue-dots-osm/national-county-directory.json',import.meta.url),{fetchOptions:{cache:'force-cache'}}).catch(e=>{blueNationalCountyPromise=null;throw e;});return blueNationalCountyPromise;}
function loadBlueOsmManifest(){
  if(!blueOsmManifestPromise) blueOsmManifestPromise=fetchJson(new URL('../data/blue-dots-osm/county-matched-manifest.json',import.meta.url),{fetchOptions:{cache:'force-cache'}}).then(data=>{if(data.schemaVersion!==1||!Array.isArray(data.parts))throw Error('OSM蓝点县级清单格式错误');return data;}).catch(error=>{blueOsmManifestPromise=null;throw error;});
  return blueOsmManifestPromise;
}
function osmBlueCities(province){
  const prefix=province+'|';return [...new Set((state.blueOsmManifest?.parts||[]).filter(part=>part.key.startsWith(prefix)).map(part=>part.key.split('|')[1]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
}
function normalizeBlueRow(row, manifestPart={}) {
  try { return normalizeBluePoint(row,manifestPart); } catch { return null; }
}
async function blueDotSha256(bytes) {
  if(!globalThis.crypto?.subtle) throw new Error('小蓝点校验需要Web Crypto');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
async function blueDotManifest(signal) {
  if (!blueDotManifestPromise) blueDotManifestPromise = fetchJson(new URL('parts-manifest.json', BLUE_DOTS_URL), { signal }).then(data => { if (data.schemaVersion !== 1 || data.coordinateSystem !== 'BD09MC / BD09LL' || !Array.isArray(data.parts)) throw new Error('小蓝点清单无效'); return data; }).catch(error => { blueDotManifestPromise = null; throw error; });
  return blueDotManifestPromise;
}
async function fetchBlueDots(province, signal, onProgress) {
  onProgress({phase:'manifest',filesDone:0,verifiedRows:0});
  const manifest = await blueDotManifest(signal), parts = manifest.parts.filter(part => part.province === province);
  const osmManifest=state.blueOsmManifest||await loadBlueOsmManifest();
  const osmParts=osmManifest.parts.filter(part=>part.key.startsWith(`${province}|`));
  const filesTotal=parts.length+osmParts.length, totalRows=null;
  const rows = [], enriched = new Map();
  let filesDone=0;
  const report=(detail)=>onProgress({filesTotal,filesDone,totalRows,verifiedRows:enriched.size,...detail});
  for (const part of [...parts, ...osmParts]) {
    signal.throwIfAborted();
    const osm=osmParts.includes(part);
    const url=osm?new URL(`../data/blue-dots-osm/${part.file}`,import.meta.url):new URL(part.file,BLUE_DOTS_URL);
    const bytes=await fetchBytes(url,{signal,expectedBytes:part.bytes,onProgress:progress=>report({phase:'download',...progress})});
    report({phase:'verify'}); await nextPaint(); signal.throwIfAborted();
    if (bytes.length !== part.bytes || await blueDotSha256(bytes) !== part.sha256) throw new Error(`小蓝点分片SHA校验失败：${part.file}`);
    const isGzip = bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    report({phase:'decompress'}); await nextPaint(); signal.throwIfAborted();
    const text = isGzip ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    report({phase:'validate'}); await nextPaint(); signal.throwIfAborted();
    const rawRows = JSON.parse(text);
    if (!Array.isArray(rawRows) || rawRows.length !== part.rows) throw new Error(`小蓝点分片行数错误：${part.file}`);
    for(let offset=0;offset<rawRows.length;offset+=2000){
      signal.throwIfAborted();
      for(const raw of rawRows.slice(offset,offset+2000)){
        const row=normalizeBlueRow(raw,part);
        if(!row)throw Error(`小蓝点记录格式错误：${part.file}`);
        // County enrichment replaces only provenance for the same ID, not base-province coverage.
        enriched.set(row[0],Object.assign(row,{__province:province,__blueDot:true}));
      }
      if(rawRows.length>2000)await nextPaint();
    }
    filesDone++;report({phase:'validated'});
  }
  signal.throwIfAborted();
  for(const value of enriched.values())rows.push(value);
  return rows;
}
export async function loadBlueDotsForProvince(province) {
  return loadBlueDotsScope(province,'');
}
export async function loadBlueDotsForCity(province,city) {
  return loadBlueDotsScope(province,city);
}
async function loadBlueDotsScope(province,city) {
  if (!state.catalog) throw new Error('目录尚未加载');
  // Abort before the first await, including a province transfer still reading its body.
  cancelBlueDotLoad();
  resetBlueScope();
  if (window.__BAIDU_BLUE_DOTS_DISABLED__ || !province || !BLUE_DOT_PROVINCES.includes(province)) { updateView(); return []; }
  state.blueScope=city?'city':'province';state.blueCity=city||null;
  const controller = new AbortController(); blueDotController = controller;
  const key=city?`city:${province}|${blueCityName(city)}`:`province:${province}`;
  const token = loadFeedback.start('blue', `${province}${city?' / '+city:''} · 小蓝点`, {
    cancel: () => { if(blueDotController!==controller)return; controller.abort(); blueDotController=null; syncCounties(); updateView(); announce(`小蓝点加载已取消，可重新选择当前${city?'城市':'省份'}`); },
    retry: () => { void loadBlueDotsForSelection().catch(error=>announce(error.message)); },
  });
  updateView();elements.empty.hidden=true;
  await nextPaint();
  try {
    let next=blueDotCache.get(key);
    if(!next){
      const progress=progress=>loadFeedback.update(token,{...progress,message:progressMessage(progress,'蓝点'),fraction:progress.filesTotal?progress.filesDone/progress.filesTotal:null});
      if(city){
        const manifest=state.blueCityManifest||await readBlueCityManifest();
        controller.signal.throwIfAborted();
        state.blueCityManifest=manifest;
        next=await loadBlueCity(province,city,{manifest,signal:controller.signal,onProgress:progress});
      }else next=await fetchBlueDots(province,controller.signal,progress);
      if(controller.signal.aborted||blueDotController!==controller)return null;
      blueDotCache.set(key,next);while(blueDotCache.size>1)blueDotCache.delete(blueDotCache.keys().next().value);
    }
    if (controller.signal.aborted || blueDotController!==controller || !next) return null;
    loadFeedback.update(token,{phase:'render',message:`已校验 ${next.length.toLocaleString()} 个${city?'市级':''}蓝点 · 正在绘制地图`,fraction:0.99});
    await nextPaint();controller.signal.throwIfAborted();
    state.blueRows = next; syncCities(); updateView();
    window.__BAIDU_BLUE_DOT_LOAD__ = { province, city:city||null, scope:city?'city':'province', rows: next.length, osmMatched: next.filter(row=>row[9]?.administrativeArea?.source==='OpenStreetMap').length };
    await nextPaint();
    if(controller.signal.aborted||blueDotController!==controller)return null;
    loadFeedback.finish(token); updateView();
    return next;
  } catch (error) {
    if (controller.signal.aborted || blueDotController!==controller) return null;
    loadFeedback.fail(token,error);syncCounties();updateView();
    return null;
  } finally {
    if(blueDotController===controller)blueDotController=null;
  }
}
function cancelBlueDotLoad() { blueDotController?.abort(); blueDotController = null; loadFeedback.cancel('blue'); }
function resetBlueScope(){
  state.blueRows=[]; state.blueScope=null; state.blueCity=null;
  delete window.__BAIDU_BLUE_DOT_LOAD__;
}


function filtered(rows) {
  rows = filterRows(rows, { query: elements.search.value.trim(), road: elements.road.value.trim(), date: elements.date.value });
  if (state.globalSelected) rows = rows.filter(row=>row.__collectionId===GLOBAL_COLLECTION_ID);
  if (elements.province.value) rows = rows.filter(row=>row.__province===elements.province.value);
  if (elements.city.value) rows = rows.filter(row=>row.__collectionId===elements.city.value);
  if(elements.county.value&&elements.county.value!=='all')rows=rows.filter(row=>row.__countyId===elements.county.value);
  // The 小蓝点 option is a layer scope: it shows the separate blue layer and hides street rows.
  const kind=currentKind();
  if(kind==='blue')return [];
  // Street rows are classified only by categoryFor(); blue rows never become a street category.
  rows=rows.filter(row=>categoryFor(row)!=='blue');
  if(kind!=='all')rows=rows.filter(row=>categoryFor(row)===kind);
  const seen = new Set();
  return rows.filter((row) => { if (seen.has(row[0])) return false; seen.add(row[0]); return true; });
}
function currentKind(){
  const value=$('kind-filter')?.value||'all';
  return KIND_VALUES.includes(value)?value:'all';
}
function kindLabel(kind=currentKind()){return KIND_LABELS[kind]||KIND_LABELS.all;}
// 全部类型 shows both layers; a street type hides the blue layer; 小蓝点 shows only blue.
function blueLayerShown(){const kind=currentKind();return kind==='all'||kind==='blue';}
function updateMapButtons() {
  document.querySelectorAll('[data-map-mode]').forEach(button => {
    const active = button.dataset.mapMode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
function blueRowsForSelection() {
  let rows = state.blueRows;
  if (elements.province.value) rows = rows.filter(row => row.__province === elements.province.value);
  if (elements.city.value.startsWith('blue:')) {const city=blueCityName(elements.city.value.slice(5));rows=rows.filter(row=>row.__blueDot&&(blueCityName(row[9]?.administrativeArea?.city)===city||blueCityName(row.__blueCity)===city));}
  else if(elements.city.value) {
    const collection=state.collectionById.get(elements.city.value);
    const cityName=blueCityName(collection?.name);
    if(cityName) rows=rows.filter(row=>row.__blueDot && (blueCityName(row[9]?.administrativeArea?.city)===cityName || blueCityName(row.__blueCity)===cityName));
  }
  if (elements.county.value.startsWith('blue:')) {
    const county=elements.county.value.slice(5);
    rows = rows.filter(row => county==='__unmatched__' ? ['unmatched','ambiguous','no-boundary'].includes(row[9]?.administrativeArea?.match) : row[9]?.administrativeArea?.county===county);
  }
  return rows;
}
// Rows that actually reach the map/匹配点 counter: the layer scope must be enabled first.
function blueRowsVisible(){return blueLayerShown()?blueRowsForSelection():[];}
function blueCountyOptions(city) {
  const normalizedCity=name=>String(name||'').replace(/市$/,'');
  const rows = state.blueRows.filter(row => normalizedCity(row.__blueCity) === normalizedCity(city));
  const matched = new Map();
  for (const row of rows) {
    const area = row[9]?.administrativeArea;
    if (area?.source === 'OpenStreetMap' && area.match === 'matched' && area.county) matched.set(area.county, area);
  }
  const manifestNames=(state.blueOsmManifest?.parts||[]).filter(part=>part.key.split('|')[0]===elements.province.value&&normalizedCity(part.key.split('|')[1])===normalizedCity(city)).map(part=>part.key.split('|')[2]).filter(Boolean);
  const directoryNames=(state.blueCountyDirectory?.cities||[]).find(item=>item.province===elements.province.value&&normalizedCity(item.name)===normalizedCity(city))?.counties?.map(item=>item.name)||[];
  return [...new Set([...matched.keys(),...manifestNames,...directoryNames])].sort((a,b)=>a.localeCompare(b,'zh-CN'));
}
function updateView() {
  const rows = allRows();
  const kind=currentKind(), blueScopedRows=blueRowsForSelection(), blueVisibleRows=blueRowsVisible();
  state.blueVisibleCount=blueScopedRows.length;
  state.blueMapCount=blueVisibleRows.length;
  state.visibleRows = filtered(rows);
  state.page = Math.min(state.page, Math.max(0, Math.ceil(state.visibleRows.length / PAGE_SIZE) - 1));
  const count = state.visibleRows.length;
  if (!state.mapModeManual) state.mode = count + blueVisibleRows.length > 20000 ? 'density' : 'points';
  $('load-global').setAttribute('aria-pressed',String(Boolean(state.globalSelected)));
  updateMapButtons();
  elements.count.textContent = String(count);
  elements.export.disabled = count === 0;
  const localError = $('empty-title').dataset.localError;
  const hasBlueLoaded = state.blueRows.length > 0;
  const hasBlueVisible = blueVisibleRows.length > 0;
  const blueHiddenByKind = hasBlueLoaded && !blueLayerShown();
  let title, description;
  if (localError && !rows.length) {
    title = '本地保存数据无法读取';
    description = `${localError}。原缓存未删除，可在导入窗口明确选择“删除本地导入”后重试。`;
  } else if (hasBlueVisible && !count) {
    // 仅有小蓝点（或筛选为小蓝点）：不要用“请选择城市”的遮罩盖住蓝点。
    title = kind==='blue' ? `小蓝点 ${blueVisibleRows.length.toLocaleString()} 个（仅小蓝点图层）` : `小蓝点 ${blueVisibleRows.length.toLocaleString()} 个`;
    description = `${elements.province.value}${state.blueCity?' / '+state.blueCity:''} 当前显示小蓝点。选市会停止省级加载，只下载所选市的完整蓝点分片；街景与蓝点独立显示。`;
  } else if (blueHiddenByKind && !count) {
    title = `当前筛选（${kindLabel()}）隐藏了小蓝点`;
    description = '要查看小蓝点请选择“全部类型”或“小蓝点”。街景类型筛选只作用于街景图层，不影响已加载的蓝点数据。';
  } else if (!rows.length && selectedStreetCollections().length) {
    title = '载入当前范围的街景';
    description = '选择省份或城市后自动载入全部已发布街景分片。选择城市会取消省级加载，选择县区可进一步缩小范围。';
  } else if (!rows.length && (elements.province.value || elements.city.value)) {
    title = '当前范围暂无已发布点位';
    description = '可以选择其他省份或城市查看已发布的街景与小蓝点。';
  } else if (!rows.length && state.totalPublished > 0) {
    title = '选择省份、城市或全球集合';
    description = `网站已发布 ${state.totalPublished.toLocaleString()} 条百度街景元数据。选择范围后自动载入对应分片，不自动下载全国点位。`;
  } else if (rows.length) {
    title = '没有符合条件的记录';
    description = '调整搜索词、省市、日期或类型筛选，或清除条件查看其他记录。';
  } else {
    title = '尚无已发布的百度街景元数据';
    description = '等待用户提供百度元数据。当前真实点位数为 0，不使用示例或其他来源点位填充。';
  }
  $('empty-title').textContent = title;
  $('empty-description').textContent = description;
  elements.empty.hidden = count > 0 || hasBlueVisible || state.loading || Boolean(state.loadFeedback?.error);
  elements.list.hidden = count === 0;
  $('list-empty').hidden=count>0;
  $('list-empty').textContent = kind==='blue' ? '小蓝点只显示在地图上，不进入街景列表；切回“全部类型”或其他类型查看街景记录。' : '没有匹配点位。请选择城市或调整筛选。';
  elements.mapEmpty.hidden = true;
  $('empty-load').hidden=!selectedStreetCollections().length||count>0;
  $('empty-load').disabled=$('load-city').disabled;
  setListOpen(state.listOpen);
  const start = state.page * PAGE_SIZE;
  const pageRows = state.visibleRows.slice(start, start + PAGE_SIZE);
  elements.rows.replaceChildren(...pageRows.map((row) => makeTableRow(row)));
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  elements.pageSummary.textContent = count ? `显示 ${start + 1}–${Math.min(start + PAGE_SIZE, count)} 条，共 ${count} 条` : '0 条记录';
  elements.pageNumber.textContent = `${state.page + 1} / ${totalPages}`;
  elements.prev.disabled = state.page === 0;
  elements.next.disabled = state.page >= totalPages - 1;
  // Street context dots stay off the 小蓝点-only view so that layer really is blue-only.
  const showContext=kind!=='blue'&&!elements.search.value.trim()&&(elements.road.value.trim()||elements.date.value||kind!=='all');
  renderMap(state.map, state.visibleRows, state.mode, showContext?rows:[], blueVisibleRows);
  if (!state.visibleRows.includes(state.selected)) showDetail(null);
  updateStatus(); updateMapCount(); updateHud();
  updateKindChrome();
  refreshSnapshot();
}
function makeTableRow(row) {
  const tr = document.createElement('tr');
  tr.setAttribute('aria-selected', String(row === state.selected));
  const extras = row[9] || {};
  const title = row[3] || row[0] || '未命名百度 panoid';
  const info=captureInfo(row),date=info.value?`${info.value}${info.source==='panoid'?' · 编码解析':''}`:'日期未知';
  tr.innerHTML = `<td><button class="record-link" type="button"><span class="row-primary">${safe(title)}</span><br><span class="row-secondary">${safe(row[0])}</span></button></td><td>${safe(row.__city || '')}</td><td>${safe(date)}</td><td>${safe(Number(row[1]).toFixed(5))}, ${safe(Number(row[2]).toFixed(5))}</td>`;
  tr.querySelector('button').addEventListener('click', () => showDetail(row));
  tr.addEventListener('click', (event) => { if (event.target === tr) showDetail(row); });
  return tr;
}
function showDetail(row, focusMap = true) {
  state.selected = row;
  highlightRow(state.map, row, Boolean(row) && focusMap);
  if (!row) {
    closeRowPopup(state.map);
    elements.detail.hidden=true;
    $('detail-host').append(elements.detail);
    elements.detail.replaceChildren();
    updateSelection(); refreshSnapshot(); return;
  }
  elements.detail.hidden=false;
  const city = row.__city || state.collectionById.get(row.__collectionId)?.name || '本地导入';
  const extras = row[9] || {};
  const url = baiduPanoramaUrl(row[0], {...extras,heading:row[5]});
  const time=captureInfo(row),imageDate=time.value||'日期未知';
  const tags = Array.isArray(extras.tags) ? [...extras.tags] : [];
  if (extras.extra?.manualReview) tags.push('人工检查');
  if (extras.extra?.inheritedCoordinate) tags.push('坐标继承自父全景');
  if (extras.extra?.mobilityReview?.result === 'movement-reported') tags.push('源元数据报告可移动');
  const links = Array.isArray(extras.links) ? extras.links : [];
  const source = extras.source || 'baidu';
  const batchFields = [];
  if (extras.extra?.sourceBatch === 'baidu-crawler-20261125' && extras.originalMetadataOnly === true) {
    batchFields.push(['采集文件标注', extras.extra.originalRecord?.sourceType ?? '未标注'], ['入口审查', '待确认：仅有元数据，未逐条核验地图、日期及道路入口']);
    const a = extras.cityAssignment;
    if (a) {
      const method = ({'inside-polygon':'面内唯一匹配','nearest-boundary':'面外，按最近市界推定','overlap-nearest-boundary':'市界重叠，按最近边界推定'})[a.method] ?? '未提供';
      batchFields.push(['城市归属（边界快照）', `${a.name}（${a.id}） · ${method}`]);
      if (a.method !== 'inside-polygon' && Number.isFinite(a.distance)) batchFields.push(['至采用边界的距离', `${a.distance} 米（近似值）`]);
    }
  }
  const history = row[9]?.history;
  const historyItems = Array.isArray(history) ? history : (history ? Object.entries(history).map(([date, value]) => ({ date, value })) : []);
  const timeline = historyItems.length ? `<section class="timeline" aria-label="街景历史时间线"><h3>历史记录</h3><ol>${historyItems.map((item) => { const entry = typeof item === 'object' && item !== null ? item : { value: item }; return `<li><time>${safe(entry.date || entry.captured || '未注明日期')}</time><span>${safe(entry.description || entry.note || entry.value || '')}</span></li>`; }).join('')}</ol></section>` : '';
  const linkList = links.length ? `<div class="detail-links"><span>百度链接 ID</span><div>${links.map((id) => `<a href="${safe(baiduPanoramaUrl(id))}" target="_blank" rel="noopener noreferrer">${safe(id)}</a>`).join('')}</div></div>` : '';
  const timelineIds=[...new Set((Array.isArray(extras.timeLine)?extras.timeLine:[]).filter(id=>typeof id==='string'&&id.trim()))];
  const timelineLinks=timelineIds.length?`<div class="detail-links"><span>源文件时间线 ID（非拓扑分类证明）</span><div>${timelineIds.map(id=>`<a href="${safe(baiduPanoramaUrl(id))}" target="_blank" rel="noopener noreferrer">${safe(id)}${panoidCaptured(id)?` · ${safe(panoidCaptured(id).slice(0,10))}（编码）`:''}</a>`).join('')}</div></div>`:'';
  const tagList = tags.length ? `<div class="detail-tags">${tags.map((tag) => `<span>${safe(tag)}</span>`).join('')}</div>` : '';
  elements.detail.innerHTML = `<div class="detail-content"><p class="eyebrow">百度街景详情</p><h2>${safe(row[3] || row[0] || '未命名百度 panoid')}</h2><div class="detail-city">${safe(row.__province || '')} ${safe(city)}</div><div class="detail-fields">${[['panoid',row[0]],['来源',source],...batchFields,...(extras.extra?.vehicleId!=null?[['街景车编号',extras.extra.vehicleId]]:[]),['采集日期',imageDate],['日期来源',time.source==='source'?'源文件明确日期':time.source==='panoid'?'panoid 编码解析（未逐条官网认证）':'未知'],['时间说明',time.source==='panoid'?'编码含毫秒字段；不包含时区':time.timeZone||'源文件未标时区'],['县区（OSM空间匹配）',extras.administrativeArea?.countyName||'未匹配 / 未提供'],['县区匹配状态',extras.administrativeArea?.match||'未提供'],['县界来源日期',extras.administrativeArea?.boundaryDate||'未提供'],['坐标（BD-09）',`${row[1]}, ${row[2]}`],['方向',row[5] ?? '未知'],['俯仰角',extras.pitch ?? '未知'],['缩放级别',extras.zoom ?? '未知'],['来源类型（源标注）',({regular:'常规',hidden:'隐藏','time-machine':'时光机',unknown:'未知'})[categoryFor(row)]],['来源影像检查',extras.verification?.imageLoaded===true?'源文件标为成功（非本站复核）':extras.verification?.imageLoaded===false?'源文件标为未成功':'未提供'],['街景元数据标记',row[7] ? '有记录（不保证官网当前可用）' : '未标记']].map(([k,v])=>`<div class="detail-line"><span>${safe(k)}</span><span>${safe(v)}</span></div>`).join('')}</div>${tagList}${linkList}${timelineLinks}${timeline}<p class="official-note">在新标签打开百度官网全景。手机若被百度转到普通地图，可切换浏览器“桌面版网站”。链接不等于影像可用保证。</p><div class="detail-actions"><a class="button button-primary" href="${safe(url)}" target="_blank" rel="noopener noreferrer">在百度地图打开街景 ↗</a><button class="button button-quiet" id="copy-panoid" type="button">复制 panoid</button><button class="button button-quiet" id="copy-url" type="button">复制百度街景链接</button><button class="button button-quiet" id="copy-coordinate" type="button">复制 BD-09 坐标</button>${collectionForRow(row)==='local'?'<button class="button button-quiet" id="remove-local-row" type="button">删除本地记录</button>':''}</div></div>`;
  $('copy-panoid').addEventListener('click', async () => copyText(String(row[0]), '已复制 panoid'));
  $('copy-url').addEventListener('click', async () => copyText(url, '已复制百度街景链接'));
  $('copy-coordinate').addEventListener('click', async () => copyText(`${row[1]}, ${row[2]}`, '已复制 BD-09 坐标'));
  $('remove-local-row')?.addEventListener('click', () => {
    try { const next = state.localRows.filter((r) => r !== row); saveLocalRows('local', next); state.localRows = next; showDetail(null); updateView(); }
    catch (error) { announce(`删除失败，记录未更改：${error.message}`); }
  });
  openRowPopup(state.map,row,elements.detail);
  updateSelection(); refreshSnapshot();
}
async function copyText(value, success) { try { await navigator.clipboard.writeText(value); announce(success); } catch { announce(value); } }
function updateSelection() { [...elements.rows.querySelectorAll('tr')].forEach((tr) => tr.setAttribute('aria-selected', String(tr.querySelector('.row-secondary')?.textContent === String(state.selected?.[0] ?? '\0')))); }

async function loadData() {
  ++collectionRequest;
  cityCache.clear();cancelActiveLoad();cancelBlueDotLoad();loadFeedback.close();
  state.ready = false;
  state.catalog = await loadCatalog();
  state.collectionById.clear();
  state.catalog.collections.forEach((c) => state.collectionById.set(c.id, c));
  const summary = state.catalog.importSummary || {};
  elements.summaryCities.textContent = `${state.catalog.collections.length} 个集合`;
  elements.summaryRaw.textContent = Number.isFinite(summary.rawRecords) ? summary.rawRecords.toLocaleString() : '—';
  elements.summaryUnique.textContent = Number.isFinite(summary.uniquePanoids) ? summary.uniquePanoids.toLocaleString() : '—';
  elements.summaryDuplicates.textContent = Number.isFinite(summary.exactDuplicates) ? summary.exactDuplicates.toLocaleString() : '—';
  elements.source.querySelector('.state-dot').style.background = state.catalog.collections.length ? '#5cc49d' : '#d4a850';
  state.totalPublished = Number(state.catalog.total) || 0;
  state.globalSelected=false;
  state.blueManifestTotal=0;state.blueOsmManifest=null;state.blueCountyDirectory=null;state.blueCityManifest=null;resetBlueScope();
  populateFilters();
  let local = null, localError = '';
  try { local = loadLocalRows('local'); }
  catch (error) { localError = error.message; announce(`本地保存数据无法读取：${error.message}。缓存未删除，可在导入窗口选择“删除本地导入”后重新导入。`); }
  state.localRows = local ? validateRows(local).map((r) => Object.assign(r, { __collectionId: 'local', __city: '本地导入' })) : [];
  $('empty-title').dataset.localError = localError;
  state.publishedRows = [];state.blueRows = [];state.loadedCollection = null;state.loadedSelection = null;
  state.ready = true;
  updateView();
  const catalog=state.catalog;
  if(window.__BAIDU_BLUE_DOTS_DISABLED__)return;
  const apply=(promise,accept)=>{void promise.then(value=>{
    if(state.catalog!==catalog)return;
    accept(value);syncCities();updateView();
  },()=>{});};
  // Don't make city options wait for unrelated province or county metadata.
  apply(readBlueCityManifest(),manifest=>{state.blueCityManifest=manifest;state.blueManifestTotal=manifest.total;});
  apply(blueDotManifest(),manifest=>{if(!state.blueCityManifest)state.blueManifestTotal=Number(manifest.total)||0;});
  apply(loadBlueOsmManifest(),manifest=>{state.blueOsmManifest=manifest;});
  apply(loadNationalCountyDirectory(),directory=>{state.blueCountyDirectory=directory;});
}

function openImport() { setMessage(''); elements.importText.value = ''; elements.importFile.value = ''; elements.dialog.showModal(); }
async function importRows() {
  setMessage('正在验证完整数据批次…');
  try {
    let text = elements.importText.value;
    if (elements.importFile.files[0]) text = await elements.importFile.files[0].text();
    if (!text.trim()) throw new Error('请选择文件或粘贴数据。');
    if ($('empty-title').dataset.localError) throw new Error('本地缓存有误且尚未删除，请先明确清理异常本地导入后再导入新文件。');
    const incoming = parseImport(text, { format: elements.format.value, confirmedBaidu: elements.confirmBaidu.checked, coordinateSystem: elements.coordinate.value });
    if (incoming.length > 10000 && !window.confirm(`即将载入 ${incoming.length.toLocaleString()} 条记录，可能占用较多浏览器内存。继续吗？`)) { setMessage('已取消导入，现有记录未更改。'); return; }
    const publishedIds = new Set(state.publishedRows.map((row) => row[0]));
    const duplicates = incoming.filter((row) => publishedIds.has(row[0])).length;
    const additions = incoming.filter((row) => !publishedIds.has(row[0]));
    const merged = mergeRows(state.localRows, additions);
    saveLocalRows('local', merged);
    state.localRows = merged.map((r) => Object.assign(r, { __collectionId: 'local', __city: '本地导入' }));
    ++collectionRequest;cancelActiveLoad();cancelBlueDotLoad();
    if (additions.length) {
      state.globalSelected=false;resetBlueScope();
      elements.province.value = ''; syncCities();
      elements.search.value = ''; elements.road.value = ''; elements.date.value = '';
      cityCache.clear();state.publishedRows = []; state.loadedCollection = null; state.loadedSelection=null;
    }
    $('empty-title').dataset.localError = '';
    if (duplicates) announce(`跳过 ${duplicates} 条与已发布数据 panoid 重复的本地记录`);
    elements.confirmBaidu.checked = false;
    setMessage(`验证成功，已在本浏览器保存 ${additions.length} 条百度记录${duplicates ? `，跳过 ${duplicates} 条与已发布数据重复的记录` : ''}；没有上传网站。`, 'success');
    announce(`本地导入完成，共 ${merged.length} 条`);
    updateView();
    setTimeout(() => elements.dialog.close(), 800);
  } catch (error) { setMessage(error.message || '数据验证失败，已有记录未更改。', 'error'); }
}
function exportRows() {
  const chunks=['{"provider":"baidu","coordinateSystem":"BD-09","schemaVersion":1,"rows":['];
  let batch='',count=0;
  for(const row of state.visibleRows){
    batch+=(count++?',':'')+JSON.stringify(enrichCapturedRow(row).slice(0,10));
    if(batch.length>=64*1024){chunks.push(batch);batch='';}
  }
  if(batch)chunks.push(batch);
  chunks.push(']}\n');
  const blob = new Blob(chunks, { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'baidu-panorama-local.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

$('open-import').addEventListener('click', openImport);
$('empty-import').addEventListener('click', openImport);
$('cancel-import').addEventListener('click', () => elements.dialog.close());
$('confirm-import').addEventListener('click', importRows);
$('clear-local').addEventListener('click', () => { try { clearLocalRows('local'); state.localRows = []; $('empty-title').dataset.localError = ''; showDetail(null); updateView(); setMessage('本地导入记录已删除；已发布数据未更改。', 'success'); } catch (error) { setMessage(error.message, 'error'); } });
$('export-data').addEventListener('click', exportRows);
$('reload-data').addEventListener('click', async () => { state.ready = false; try { await loadData(); announce('已重新读取目录与本地保存数据'); } catch (error) { announce(error.message); } });
$('toggle-list').addEventListener('click',()=>{setListOpen(!state.listOpen);refreshSnapshot();});
$('close-list').addEventListener('click',()=>{setListOpen(false);refreshSnapshot();});
$('toggle-filters').addEventListener('click',()=>{const open=$('extra-filters').hidden;$('extra-filters').hidden=!open;$('toggle-filters').setAttribute('aria-expanded',String(open));resizeToolbar();});
$('kind-filter').addEventListener('change',()=>{state.page=0;updateView();});
$('clear-filters').addEventListener('click',()=>{elements.search.value='';elements.road.value='';elements.date.value='';$('kind-filter').value='all';state.page=0;updateView();});
// 全览 should frame whatever the current filter actually shows on the map.
$('fit-city').addEventListener('click',()=>{const rows=state.visibleRows.length?state.visibleRows:blueRowsVisible();fitRows(state.map,rows);});
$('basemap-select').addEventListener('change',()=>setBasemap(state.map,$('basemap-select').value));
$('empty-load').addEventListener('click',()=>$('load-city').click());
$('loading-cancel').addEventListener('click',()=>{loadFeedback.cancel();updateView();});
$('loading-retry').addEventListener('click',()=>loadFeedback.retry());
$('loading-close').addEventListener('click',()=>{loadFeedback.close();updateView();});
$('page-prev').addEventListener('click', () => { state.page--; updateView(); });
$('page-next').addEventListener('click', () => { state.page++; updateView(); });
function clearPublishedSelection(){++collectionRequest;cancelActiveLoad();cityCache.clear();state.publishedRows=[];state.loadedCollection=null;state.loadedSelection=null;state.page=0;}
function selectScope({global=false}={}) {
  // Stop both province jobs synchronously before updating the filters or scheduling city I/O.
  cancelBlueDotLoad();
  clearPublishedSelection();
  state.globalSelected=global;
  resetBlueScope();
  $('kind-filter').value='all';
  elements.county.value='';
  elements.shard.value='all';
}
function loadCurrentScope(){
  updateView();
  if(!state.globalSelected)void loadBlueDotsForSelection().catch(error=>announce(`小蓝点无法加载：${error.message}`));
  void loadPublishedSelection();
}
function openGlobalCollection(){
  if(!globalCollection()?.count)return;
  selectScope({global:true});
  elements.province.value='';
  syncCities();
  loadCurrentScope();
}
$('load-global').addEventListener('click',openGlobalCollection);
elements.province.addEventListener('change',()=>{
  selectScope();
  elements.city.value='';
  syncCities();
  loadCurrentScope();
});
elements.city.addEventListener('change',()=>{
  selectScope();
  syncCounties();
  const city=state.collectionById.get(elements.city.value);
  if(city?.count>0&&city.partition===COUNTY_PARTITION){elements.county.value='all';syncShards();}
  loadCurrentScope();
});
elements.county.addEventListener('change',()=>{clearPublishedSelection();syncShards();updateView();void loadPublishedSelection();});
elements.shard.addEventListener('change',()=>{clearPublishedSelection();updateView();void loadPublishedSelection();});
$('load-city').addEventListener('click', async () => {
  if(elements.city.value.startsWith('blue:')||elements.county.value.startsWith('blue:')){await loadBlueDotsForSelection();return;}
  await loadPublishedSelection();
});
let filterTimer;
[elements.search, elements.road, elements.date].forEach((el) => el.addEventListener('input', () => {
  clearTimeout(filterTimer); state.page = 0;
  if (state.publishedRows.length + state.localRows.length > 10000) filterTimer = setTimeout(updateView, 200);
  else updateView();
}));
document.querySelectorAll('[data-map-mode]').forEach((button) => button.addEventListener('click', () => { state.mapModeManual = true; state.mode = button.dataset.mapMode; updateView(); }));
document.addEventListener('baidu:select', (event) => showDetail(event.detail, false));
elements.importFile.addEventListener('change', async () => { const file = elements.importFile.files[0]; if (file) { elements.importText.value = await file.text(); const ext = file.name.split('.').pop().toLowerCase(); elements.format.value = ext === 'jsonl' ? 'jsonl' : ext === 'csv' ? 'csv' : 'json'; setMessage(`已载入文件：${file.name}`); } });
document.addEventListener('baidu:popupclosed',()=>{state.selected=null;highlightRow(state.map,null);elements.detail.hidden=true;$('detail-host').append(elements.detail);updateSelection();refreshSnapshot();});
state.map = createMap($('map'));
bindMapInteractions(state.map);
setBasemap(state.map,$('basemap-select').value);
state.map?.map.on('moveend zoomend',updateHud);
$('map').addEventListener('baidu:maprendered',updateHud);
state.map?.map.on('mousemove',event=>{$('hud-coordinate').textContent=event.latlng.lat.toFixed(5)+', '+event.latlng.lng.toFixed(5);});
if(typeof ResizeObserver==='function')new ResizeObserver(resizeToolbar).observe($('viewer-toolbar'));
window.addEventListener('resize',resizeToolbar);
resizeToolbar();updateHud();
loadData().then(async()=>{
  const params=new URLSearchParams(location.search),id=params.get('city'),requested=params.get('kind');
  // `?kind=` accepts street source types plus the 小蓝点 layer scope; absent/unknown stays 全部类型.
  const kind=KIND_VALUES.includes(requested)?requested:'all';
  if(KIND_VALUES.includes(requested))$('kind-filter').value=kind;
  const collection=state.collectionById.get(id);
  if(collection && collection===globalCollection()){
    openGlobalCollection();
    if(KIND_VALUES.includes(requested))$('kind-filter').value=kind;
  } else if(collection && !isOverseasCollection(collection)){
    elements.province.value=collection.province;syncCities();elements.city.value=collection.id;syncCounties();
    if(collection.partition===COUNTY_PARTITION&&collection.count>0){
      const county=params.get('county');
      elements.county.value=county&&[...elements.county.options].some(option=>option.value===county&&!option.disabled)?county:'all';
      syncShards();
      const shard=params.get('part');if(shard&&[...elements.shard.options].some(option=>option.value===shard))elements.shard.value=shard;
    }
    loadCurrentScope();
  } else if(KIND_VALUES.includes(kind)) {
    // Deep link asked for a type scope only: apply it to the current catalogue view.
    updateView();
  }
}).catch((error) => { elements.source.querySelector('span:last-child').textContent = '百度元数据源：加载失败'; setMessage(error.message, 'error'); elements.empty.hidden = false; });

// 支持作者弹窗：同一浏览器 14 天内只自动出现一次，关闭即记录时间。
// 无头/WebDriver 环境不自动弹出：CI 的浏览器检查会在点位像素上派发真实鼠标事件，
// 模态层会拦截该点击并使既有断言失效。
const SUPPORT_DIALOG_KEY = 'baidu-panorama-workbench:support-dialog:v1';
const SUPPORT_DIALOG_INTERVAL = 14 * 24 * 60 * 60 * 1000;
function supportDialogDue() {
  try { const seen = Number(localStorage.getItem(SUPPORT_DIALOG_KEY) || 0); return !(seen > 0 && Date.now() - seen < SUPPORT_DIALOG_INTERVAL); } catch { return false; }
}
function rememberSupportDialog() { try { localStorage.setItem(SUPPORT_DIALOG_KEY, String(Date.now())); } catch { /* 隐私模式或存储被禁用时忽略 */ } }
function showSupportDialog() {
  const dialog = $('support-dialog');
  if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return false;
  dialog.showModal();
  return true;
}
function initSupportDialog() {
  const dialog = $('support-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  dialog.addEventListener('close', rememberSupportDialog);
  // 点 Star 会打开新标签页：顺手收起弹窗并记录，避免它一直盖在查看器上。
  dialog.querySelector('.support-star')?.addEventListener('click', () => { rememberSupportDialog(); dialog.close(); });
  // 工具栏的“支持项目”按钮可随时重新打开，不受自动弹窗的时间间隔与自动化环境限制。
  $('open-support')?.addEventListener('click', () => { showSupportDialog(); });
  if (navigator.webdriver || /headless/i.test(navigator.userAgent) || !supportDialogDue()) return;
  setTimeout(() => { if (!document.querySelector('dialog[open]')) showSupportDialog(); }, 900);
}
initSupportDialog();

// 对外桥接：主流程可调用 window.__blueDotsBridge.load(province) 触发某省蓝点加载；
// 未提供 manifest 时也能通过 window.__blueDotsBridge.setRows(rows) 直接注入。
window.__blueDotsBridge = {
  load: (province) => province===undefined?loadBlueDotsForSelection():loadBlueDotsForProvince(province??''),
  loadCity: (province,city) => loadBlueDotsForCity(province,city),
  setRows: (rows) => { cancelBlueDotLoad(); resetBlueScope(); state.blueRows = (rows ?? []).map(row=>normalizeBlueRow(row)).filter(Boolean); updateView(); },
  clear: () => { cancelBlueDotLoad(); resetBlueScope(); updateView(); },
  get rows() { return state.blueRows; },
};
