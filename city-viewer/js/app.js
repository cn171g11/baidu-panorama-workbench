import { categoryFor, countCategories } from './classification.js';
import { parseImport, validateRows, filterRows, baiduPanoramaUrl, mergeRows } from './metadata.js';
import { loadCatalog, loadCollection, saveLocalRows, loadLocalRows, clearLocalRows } from './data-store.js';
import { createMap, renderMap, bindMapInteractions, highlightRow, fitRows, setBasemap, openRowPopup, closeRowPopup } from './map.js';

const PAGE_SIZE = 50;
const $ = (id) => document.getElementById(id);
const elements = {
  summaryCities: $('summary-cities'), summaryRaw: $('summary-raw'), summaryUnique: $('summary-unique'), summaryDuplicates: $('summary-duplicates'),
  source: $('source-state'), province: $('province-filter'), city: $('city-filter'), search: $('search-input'), road: $('road-filter'), date: $('date-filter'),
  count: $('result-count'), mapCount: $('map-result-count'), mapEmpty: $('map-empty'), empty: $('empty-state'), list: $('record-list'), rows: $('record-rows'), pageSummary: $('page-summary'), pageNumber: $('page-number'),
  prev: $('page-prev'), next: $('page-next'), detail: $('detail-panel'), export: $('export-data'), dialog: $('import-dialog'), importMessage: $('import-message'), importText: $('import-text'), importFile: $('import-file'), format: $('import-format'), coordinate: $('coordinate-system'), confirmBaidu: $('confirm-baidu'), live: $('live-message')
};
const state = { catalog: null, publishedRows: [], localRows: [], visibleRows: [], selected: null, page: 0, mode: 'points', mapModeManual: false, map: null, collectionById: new Map(), loadedCollection: null, totalPublished: 0, ready: false, listOpen: false, loading: false };
const cityCache = new Map();
let activeLoad = null;
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
function updateHud() {
  if(!state.map)return;
  $('hud-zoom').textContent='Z '+state.map.map.getZoom()+' · '+(state.map.actualMode==='density-grid'?'密度网格':'散点');
  const coordinateSystem=state.map.basemap.startsWith('amap')?'GCJ-02':'WGS84';
  $('coordinate-label').textContent='元数据 BD-09 · 底图 '+coordinateSystem;
  elements.mapCount.textContent=`视野 ${state.map.renderedCount.toLocaleString()} / 匹配 ${state.visibleRows.length.toLocaleString()}`;
  const center=state.map.map.getCenter();
  $('hud-coordinate').textContent=center.lat.toFixed(5)+', '+center.lng.toFixed(5);
}
function updateStatus() {
  if(!state.catalog)return;
  const name=state.loadedCollection?state.collectionById.get(state.loadedCollection)?.name:null;
  elements.source.querySelector('span:last-child').textContent=state.loading?'正在载入百度城市数据…':`Pages ${state.catalog.collections.length} 城 · ${state.totalPublished.toLocaleString()} 条${name?' · '+name+' '+state.visibleRows.length.toLocaleString()+' 点':''} · 仅百度`;
  $('fit-city').disabled=state.visibleRows.length===0;
  const counts=countCategories(state.visibleRows);
  $('map-hint').textContent=state.visibleRows.length?`${state.visibleRows.length.toLocaleString()} 个匹配点 · 常规 ${counts.regular.toLocaleString()} / 隐藏 ${counts.hidden.toLocaleString()} / 时光机 ${counts.timeMachine.toLocaleString()} · 点击地图查看最近点`:'请选择顶部省份与城市；不会自动下载全国点位';
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
      source: 'published-catalog', currentCollection: elements.city.value || elements.province.value || null,
      loadedCollection: state.loadedCollection, localCount: state.localRows.length,
      visibleCount: state.visibleRows.length, page: state.page + 1, pageSize: PAGE_SIZE,
      selectedPanoid: state.selected?.[0] || null, mapAvailable: Boolean(state.map), mapMode: state.mode,
      mapRenderedCount: state.map?.renderedCount || 0, mapGridCells: state.map?.grid.size || 0,
      basemap:state.map?.basemap, actualMapMode:state.map?.actualMode, drawnSymbols:state.map?.drawnSymbols||0, kind:$('kind-filter').value,
      collections: state.catalog?.collections.length || 0, layout:'fullscreen-map', popupOpen:!!state.map?.popup, listOpen:state.listOpen, loading:state.loading,
    }),
  });
}
function allRows() { return state.publishedRows.concat(state.localRows); }
function collectionForRow(row) { return state.localRows.includes(row) ? 'local' : (row.__collectionId || ''); }

let collectionRequest = 0;
async function loadPublishedCollections(collections) {
  const cacheKey=collections.map(city=>city.id).join(',');
  if(activeLoad?.key===cacheKey)return activeLoad.promise;
  const promise=loadPublishedCollectionsNow(collections);
  activeLoad={key:cacheKey,promise};
  try{return await promise;}finally{if(activeLoad?.promise===promise)activeLoad=null;}
}
async function loadPublishedCollectionsNow(collections) {
  const requestId = ++collectionRequest;
  const priorRows = state.publishedRows;
  const total = collections.reduce((sum, item) => sum + item.count, 0);
  const threshold=window.matchMedia('(max-width:680px)').matches?10000:200000;
  if (total > threshold && !cityCache.has(collections[0]?.id) && !window.confirm(`即将读取 ${total.toLocaleString()} 条已发布记录，可能占用较多内存。继续吗？`)) {
    announce('已取消载入大型城市集合；本地记录仍可使用');
    state.publishedRows = priorRows;
    updateView();
    return;
  }
  state.loading=true; updateStatus();
  const nextRows = [];
  try {
    for (const collection of collections) {
      let rows=cityCache.get(collection.id);
      if(!rows){rows=await loadCollection(collection);cityCache.set(collection.id,rows);while(cityCache.size>2)cityCache.delete(cityCache.keys().next().value);}
      if (requestId !== collectionRequest) return;
      for (const row of rows) nextRows.push(Object.assign(row, { __collectionId: collection.id, __city: collection.name, __province: collection.province }));
    }
  } catch (error) {
    if (requestId !== collectionRequest) return;
    state.loading=false;
    announce(`城市数据无法完整读取：${error.message}。已保留先前记录。`);
    updateView();
    return;
  }
  if (requestId !== collectionRequest) return;
  state.loading=false;
  state.publishedRows = nextRows;
  state.loadedCollection = collections.length === 1 ? collections[0].id : null;
  updateView();
}

function populateFilters() {
  const provinces = new Set(state.catalog.collections.map((c) => c.province));
  elements.province.innerHTML = '<option value="">全部省份</option>';
  [...provinces].sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach((name) => elements.province.add(new Option(name, name)));
  syncCities();
}
function syncCities() {
  const province = elements.province.value;
  elements.city.innerHTML = `<option value="">${province ? '选择城市' : '选择省份后载入'}</option>`;
  state.catalog.collections.filter((c) => !province || c.province === province).forEach((c) => elements.city.add(new Option(c.name, c.id)));
  elements.city.disabled = !province;
  $('load-city').disabled = !elements.city.value;
}

function filtered(rows) {
  rows = filterRows(rows, { query: elements.search.value.trim(), road: elements.road.value.trim(), date: elements.date.value });
  if (elements.province.value) rows = rows.filter((r) => r.__province === elements.province.value || (r.__collectionId && state.collectionById.get(r.__collectionId)?.province === elements.province.value));
  if (elements.city.value) rows = rows.filter((r) => r.__collectionId === elements.city.value);
  const kind=$('kind-filter').value;
  if(kind!=='all') rows=rows.filter(row=>categoryFor(row)===kind);
  const seen = new Set();
  return rows.filter((row) => { if (seen.has(row[0])) return false; seen.add(row[0]); return true; });
}
function updateMapButtons() {
  document.querySelectorAll('[data-map-mode]').forEach(button => {
    const active = button.dataset.mapMode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
function updateView() {
  const rows = allRows();
  state.visibleRows = filtered(rows);
  state.page = Math.min(state.page, Math.max(0, Math.ceil(state.visibleRows.length / PAGE_SIZE) - 1));
  const count = state.visibleRows.length;
  if (!state.mapModeManual) state.mode = count > 20000 ? 'density' : 'points';
  updateMapButtons();
  elements.count.textContent = String(count);
  elements.mapCount.textContent = `${count} 条`;
  elements.export.disabled = count === 0;
  const localError = $('empty-title').dataset.localError;
  let title, description;
  if (localError && !rows.length) {
    title = '本地保存数据无法读取';
    description = `${localError}。原缓存未删除，可在导入窗口明确选择“删除本地导入”后重试。`;
  } else if (elements.city.value && state.loadedCollection !== elements.city.value) {
    title = '请载入所选城市';
    description = '点击顶部“载入”读取所选百度城市。首页不会自动下载全部点位。';
  } else if (!rows.length && state.totalPublished > 0) {
    title = '从目录选择一个城市';
    description = state.catalog.publication?.mode === 'pages-gzip'
      ? `Pages当前已发布 ${state.catalog.publication.hostedCities} 个城市、${state.totalPublished.toLocaleString()} 条。完整源目录 ${state.catalog.publication.sourceCities} 城市保留在仓库，其他城市将逐批补充。请选择省份、城市后载入本站分片。`
      : `网站已收录 ${state.totalPublished.toLocaleString()} 条百度元数据，请选择省份、城市后按需载入。`;
  } else if (rows.length) {
    title = '没有符合条件的记录';
    description = '调整搜索词、省市或日期筛选，或清除条件查看其他记录。';
  } else {
    title = '尚无已发布的百度街景元数据';
    description = '等待用户提供百度元数据。当前真实点位数为 0，不使用示例或其他来源点位填充。';
  }
  $('empty-title').textContent = title;
  $('empty-description').textContent = description;
  elements.empty.hidden = count > 0;
  elements.list.hidden = count === 0;
  $('list-empty').hidden=count>0;
  elements.mapEmpty.hidden = true;
  $('empty-load').hidden=!elements.city.value||count>0;
  setListOpen(state.listOpen);
  const start = state.page * PAGE_SIZE;
  const pageRows = state.visibleRows.slice(start, start + PAGE_SIZE);
  elements.rows.replaceChildren(...pageRows.map((row) => makeTableRow(row)));
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  elements.pageSummary.textContent = count ? `显示 ${start + 1}–${Math.min(start + PAGE_SIZE, count)} 条，共 ${count} 条` : '0 条记录';
  elements.pageNumber.textContent = `${state.page + 1} / ${totalPages}`;
  elements.prev.disabled = state.page === 0;
  elements.next.disabled = state.page >= totalPages - 1;
  const showContext=!elements.search.value.trim()&&(elements.road.value.trim()||elements.date.value||$('kind-filter').value!=='all');
  renderMap(state.map, state.visibleRows, state.mode, showContext?rows:[]);
  if (!state.visibleRows.includes(state.selected)) showDetail(null);
  updateStatus(); updateHud();
  refreshSnapshot();
}
function makeTableRow(row) {
  const tr = document.createElement('tr');
  tr.setAttribute('aria-selected', String(row === state.selected));
  const extras = row[9] || {};
  const title = row[3] || row[0] || '未命名百度 panoid';
  const date = row[4] || extras.imageDate || extras.extra?.imageDate || extras.observations?.imageDate || '日期未知';
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
  const imageDate = row[4] || extras.imageDate || extras.extra?.imageDate || extras.observations?.imageDate || '日期未知';
  const tags = Array.isArray(extras.tags) ? extras.tags : [];
  const links = Array.isArray(extras.links) ? extras.links : [];
  const source = extras.source || 'baidu';
  const history = row[9]?.history;
  const historyItems = Array.isArray(history) ? history : (history ? Object.entries(history).map(([date, value]) => ({ date, value })) : []);
  const timeline = historyItems.length ? `<section class="timeline" aria-label="街景历史时间线"><h3>历史记录</h3><ol>${historyItems.map((item) => { const entry = typeof item === 'object' && item !== null ? item : { value: item }; return `<li><time>${safe(entry.date || entry.captured || '未注明日期')}</time><span>${safe(entry.description || entry.note || entry.value || '')}</span></li>`; }).join('')}</ol></section>` : '';
  const linkList = links.length ? `<div class="detail-links"><span>百度链接 ID</span><div>${links.map((id) => `<a href="${safe(baiduPanoramaUrl(id))}" target="_blank" rel="noopener noreferrer">${safe(id)}</a>`).join('')}</div></div>` : '';
  const timelineIds=[...new Set((Array.isArray(extras.timeLine)?extras.timeLine:[]).filter(id=>typeof id==='string'&&id.trim()))];
  const timelineLinks=timelineIds.length?`<div class="detail-links"><span>源文件时间线 ID（非拓扑分类证明）</span><div>${timelineIds.map(id=>`<a href="${safe(baiduPanoramaUrl(id))}" target="_blank" rel="noopener noreferrer">${safe(id)}</a>`).join('')}</div></div>`:'';
  const tagList = tags.length ? `<div class="detail-tags">${tags.map((tag) => `<span>${safe(tag)}</span>`).join('')}</div>` : '';
  elements.detail.innerHTML = `<div class="detail-content"><p class="eyebrow">百度街景详情</p><h2>${safe(row[3] || row[0] || '未命名百度 panoid')}</h2><div class="detail-city">${safe(row.__province || '')} ${safe(city)}</div><div class="detail-fields">${[['panoid',row[0]],['来源',source],['采集日期',imageDate],['坐标（BD-09）',`${row[1]}, ${row[2]}`],['方向',row[5] ?? '未知'],['俯仰角',extras.pitch ?? '未知'],['缩放级别',extras.zoom ?? '未知'],['来源类型（源标注）',({regular:'常规',hidden:'隐藏','time-machine':'时光机',unknown:'未知'})[categoryFor(row)]],['来源影像检查',extras.verification?.imageLoaded===true?'源文件标为成功（非本站复核）':extras.verification?.imageLoaded===false?'源文件标为未成功':'未提供'],['街景元数据标记',row[7] ? '有记录（不保证官网当前可用）' : '未标记']].map(([k,v])=>`<div class="detail-line"><span>${safe(k)}</span><span>${safe(v)}</span></div>`).join('')}</div>${tagList}${linkList}${timelineLinks}${timeline}<p class="official-note">在新标签打开百度官网全景。手机若被百度转到普通地图，可切换浏览器“桌面版网站”。链接不等于影像可用保证。</p><div class="detail-actions"><a class="button button-primary" href="${safe(url)}" target="_blank" rel="noopener noreferrer">在百度地图打开街景 ↗</a><button class="button button-quiet" id="copy-panoid" type="button">复制 panoid</button><button class="button button-quiet" id="copy-url" type="button">复制百度街景链接</button><button class="button button-quiet" id="copy-coordinate" type="button">复制 BD-09 坐标</button>${collectionForRow(row)==='local'?'<button class="button button-quiet" id="remove-local-row" type="button">删除本地记录</button>':''}</div></div>`;
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
  cityCache.clear();activeLoad=null;state.loading=false;
  state.ready = false;
  state.catalog = await loadCatalog();
  state.collectionById.clear();
  state.catalog.collections.forEach((c) => state.collectionById.set(c.id, c));
  const summary = state.catalog.importSummary || {};
  elements.summaryCities.textContent = `${state.catalog.collections.length} 个城市`;
  elements.summaryRaw.textContent = Number.isFinite(summary.rawRecords) ? summary.rawRecords.toLocaleString() : '—';
  elements.summaryUnique.textContent = Number.isFinite(summary.uniquePanoids) ? summary.uniquePanoids.toLocaleString() : '—';
  elements.summaryDuplicates.textContent = Number.isFinite(summary.exactDuplicates) ? summary.exactDuplicates.toLocaleString() : '—';
  elements.source.querySelector('span:last-child').textContent = state.catalog.collections.length ? `百度目录：${state.catalog.collections.length} 个城市（统计集合）` : '百度元数据源：目录已连接，尚无已发布记录';
  elements.source.querySelector('.state-dot').style.background = state.catalog.collections.length ? '#5cc49d' : '#d4a850';
  state.totalPublished = Number(state.catalog.total) || 0;
  populateFilters();
  let local = null, localError = '';
  try { local = loadLocalRows('local'); }
  catch (error) { localError = error.message; announce(`本地保存数据无法读取：${error.message}。缓存未删除，可在导入窗口选择“删除本地导入”后重新导入。`); }
  state.localRows = local ? validateRows(local).map((r) => Object.assign(r, { __collectionId: 'local', __city: '本地导入' })) : [];
  $('empty-title').dataset.localError = localError;
  state.publishedRows = [];
  state.loadedCollection = null;
  state.ready = true;
  updateView();
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
    ++collectionRequest;
    if (additions.length) {
      elements.province.value = ''; syncCities();
      elements.search.value = ''; elements.road.value = ''; elements.date.value = '';
      state.publishedRows = []; state.loadedCollection = null;
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
  const envelope = { provider: 'baidu', coordinateSystem: 'BD-09', schemaVersion: 1, rows: state.visibleRows.map((r) => Array.from(r).slice(0, 10)) };
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
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
$('fit-city').addEventListener('click',()=>fitRows(state.map,state.visibleRows));
$('basemap-select').addEventListener('change',()=>setBasemap(state.map,$('basemap-select').value));
$('empty-load').addEventListener('click',()=>$('load-city').click());
$('page-prev').addEventListener('click', () => { state.page--; updateView(); });
$('page-next').addEventListener('click', () => { state.page++; updateView(); });
elements.province.addEventListener('change', () => { ++collectionRequest;activeLoad=null;state.loading=false; syncCities(); state.publishedRows = []; state.loadedCollection = null; state.page = 0; updateView(); });
elements.city.addEventListener('change', () => { ++collectionRequest;activeLoad=null;state.loading=false; $('load-city').disabled = !elements.city.value; state.page = 0; updateView();const collection=state.catalog.collections.find(city=>city.id===elements.city.value);if(collection)void loadPublishedCollections([collection]); });
$('load-city').addEventListener('click', async () => { const collection = state.catalog.collections.find((c) => c.id === elements.city.value); if (collection) await loadPublishedCollections([collection]); });
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
  const params=new URLSearchParams(location.search),id=params.get('city'),kind=params.get('kind')||'all';
  if(['all','regular','hidden','time-machine','unknown'].includes(kind))$('kind-filter').value=kind;
  const collection=state.collectionById.get(id);
  if(collection){elements.province.value=collection.province;syncCities();elements.city.value=collection.id;$('load-city').disabled=false;await loadPublishedCollections([collection]);}
}).catch((error) => { elements.source.querySelector('span:last-child').textContent = '百度元数据源：加载失败'; setMessage(error.message, 'error'); elements.empty.hidden = false; });
