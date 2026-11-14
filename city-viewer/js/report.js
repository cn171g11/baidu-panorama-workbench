import { loadCatalog } from './data-store.js';
import { newCaptureSummary } from './panoid-time.js';
function sumCapture(collections){
  const result=newCaptureSummary();
  for(const item of collections){const summary=item.captureSummary;if(!summary)continue;
    if(['source','panoid','unknown','total'].some(key=>!Number.isSafeInteger(summary[key])||summary[key]<0)||summary.total!==item.count||summary.source+summary.panoid+summary.unknown!==summary.total)throw Error('时间摘要与城市/分区点位不符');
    for(const key of ['source','panoid','unknown','total']){result[key]+=summary[key];if(!Number.isSafeInteger(result[key]))throw Error('时间摘要总数超出安全范围');}
    if(summary.earliest&&(!result.earliest||summary.earliest<result.earliest))result.earliest=summary.earliest;
    if(summary.latest&&(!result.latest||summary.latest>result.latest))result.latest=summary.latest;
  }
  return result;
}

const text=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number(value||0).toLocaleString('zh-CN');
const empty=()=>({regular:0,hidden:0,timeMachine:0,unknown:0,total:0});
function countFor(item){
  if(item.count!==undefined&&(!Number.isSafeInteger(item.count)||item.count<0))throw Error('分类统计与城市/分区总数不符');
  if(!item.displayCounts)return {...empty(),regular:item.count||0,total:item.count||0};
  const values={...empty(),...item.displayCounts};
  if(Object.values(values).some(n=>!Number.isSafeInteger(n)||n<0)||values.total!==(item.count??values.total)||values.regular+values.hidden+values.timeMachine+values.unknown!==values.total)throw Error('分类统计与城市/分区总数不符');
  return values;
}
// County descriptors are subsets, not additional collections. Validate them before
// rendering, but aggregate the city exactly once for cards and province totals.
function countySummary(item,cityCounts=countFor(item)){
  if(item.counties===undefined){if(item.partitionSummary)throw Error('县级分区目录缺失');return null;}
  if(!Array.isArray(item.counties))throw Error('县级分区目录不符');
  const ids=new Set(),files=new Set(),counts=empty(),counties=[];let countyCount=0,matched=0,unassigned=0;
  for(const county of item.counties){
    if(!county||typeof county.id!=='string'||!county.id||ids.has(county.id)||county.cityId!==item.id||typeof county.name!=='string'||!county.name.trim()||!['county','unmatched'].includes(county.kind)||(county.id==='unmatched')!==(county.kind==='unmatched'))throw Error('县级分区标识不符');
    ids.add(county.id);
    if(!Number.isSafeInteger(county.count)||county.count<0||!county.displayCounts||!county.captureSummary||!Array.isArray(county.files)||(county.count>0&&!county.files.length)||(county.count===0&&county.files.length))throw Error('县级分区摘要不符');
    for(const file of county.files){if(typeof file!=='string'||!file||files.has(file))throw Error('县级分区分片重复或不符');files.add(file);}
    const values=countFor(county);counties.push({item:county,counts:values});
    for(const key of Object.keys(counts)){counts[key]+=values[key];if(!Number.isSafeInteger(counts[key]))throw Error('县级分区总数超出安全范围');}
    if(county.kind==='county'){countyCount++;matched+=county.count;}else unassigned+=county.count;
  }
  if(Object.keys(counts).some(key=>counts[key]!==cityCounts[key]))throw Error('县级分区分类合计与城市不符');
  const partition=item.partitionSummary;
  if(!partition||['matched','unmatched','ambiguous','total'].some(key=>!Number.isSafeInteger(partition[key])||partition[key]<0)||partition.total!==item.count||partition.matched+partition.unmatched+partition.ambiguous!==partition.total||partition.matched!==matched||partition.unmatched+partition.ambiguous!==unassigned)throw Error('空间匹配统计与城市/未归属分区不符');
  const captureSummary=sumCapture(item.counties);
  if(item.captureSummary){const cityCapture=sumCapture([item]);if(['source','panoid','unknown','total','earliest','latest'].some(key=>captureSummary[key]!==cityCapture[key]))throw Error('县级分区时间摘要合计与城市不符');}
  return {counties,countyCount,partition,captureSummary};
}
function aggregate(collections){
  const map=new Map(),total=empty();
  for(const item of collections){const counts=countFor(item),countyReport=countySummary(item,counts),name=item.province||'未标注';if(!map.has(name))map.set(name,{name,counts:empty(),cities:[]});const group=map.get(name);group.cities.push({item,counts,...(countyReport?{countyReport}:{})});for(const key of Object.keys(total)){total[key]+=counts[key];group.counts[key]+=counts[key];if(!Number.isSafeInteger(total[key]))throw Error('城市总数超出安全范围');}}
  return {provinces:[...map.values()],total};
}
function filterGroups(groups,needle='',onlyHidden=false){
  needle=needle.trim().toLocaleLowerCase();
  return groups.map(group=>{
    const cities=group.cities.filter(({item,counts})=>(!needle||`${group.name} ${item.name} ${item.adcode} ${(item.counties||[]).map(county=>`${county.name} ${county.id} ${county.adcode||''}`).join(' ')}`.toLocaleLowerCase().includes(needle))&&(!onlyHidden||counts.hidden>0));
    const counts=empty();for(const city of cities)for(const key of Object.keys(counts))counts[key]+=city.counts[key];
    return {...group,cities,counts};
  }).filter(group=>group.cities.length);
}
function bar(counts){const total=counts.total||1;return `<div class="ratio-bar" role="img" aria-label="常规${counts.regular}、隐藏${counts.hidden}、时光机${counts.timeMachine}、未知${counts.unknown}">${[['regular','regular'],['hidden','hidden'],['time-machine','timeMachine'],['unknown','unknown']].map(([cls,key])=>`<i class="${cls}" style="width:${100*counts[key]/total}%"></i>`).join('')}</div>`;}
function countyHref(cityId,countyId,kind=''){
  return `./?city=${encodeURIComponent(cityId)}&county=${encodeURIComponent(countyId)}${kind?`&kind=${encodeURIComponent(kind)}`:''}`;
}
function boundaryNote(item){
  const info=item.boundaryInfo||{},rejected=Array.isArray(info.rejected)?info.rejected.length:null;
  return `边界来源：${info.source||'OpenStreetMap'}（OSM） · ${info.license||info.licence||'ODbL-1.0'} · 边界快照：${info.timestamp||'未提供'} · 不可用/拒绝边界：${rejected===null?'未提供':number(rejected)}。${info.matchBasis?`匹配依据：${info.matchBasis}。`:''}坐标转换后的空间匹配，不等于官方行政归属；OSM代码可能与现行行政代码不同。`;
}
function countyTableMarkup(item,report=countySummary(item)){
  if(!report)return '';
  const p=report.partition;
  const rows=report.counties.map(({item:county,counts})=>{
    const base=countyHref(item.id,county.id),capture=county.captureSummary;
    const relation=/^[1-9]\d*$/.test(String(county.osmRelationId||''))?`<a href="https://www.openstreetmap.org/relation/${text(county.osmRelationId)}" target="_blank" rel="noopener noreferrer">OSM关系 ${text(county.osmRelationId)}</a>`:'';
    const identity=[county.adcode?`OSM代码 ${text(county.adcode)}`:'',relation].filter(Boolean).join(' · ');
    const label=county.kind==='unmatched'?'未归属 / 歧义分区（非县区）':text(county.name);
    return `<tr class="report-county-row${county.kind==='unmatched'?' report-county-unmatched':''}" data-county="${text(county.id)}"><th scope="row"><a href="${text(base)}">${label}</a>${identity?`<small>${identity}</small>`:''}</th><td>${number(counts.regular)}</td><td class="legend-hidden">${counts.hidden?`<a href="${text(countyHref(item.id,county.id,'hidden'))}">${number(counts.hidden)}</a>`:'0'}</td><td>${counts.timeMachine?`<a href="${text(countyHref(item.id,county.id,'time-machine'))}">${number(counts.timeMachine)}</a>`:'0'}</td><td>${number(counts.unknown)}</td><td>${number(counts.total)}</td><td>${number(county.files.length)} 片</td><td>${number(capture.source)} / ${number(capture.panoid)} / ${number(capture.unknown)}</td><td>${text(capture.earliest||'—')} – ${text(capture.latest||'—')}</td></tr>`;
  }).join('');
  return `<p class="report-county-note">${text(boundaryNote(item))}</p><p class="report-county-note">单一匹配 ${number(p.matched)} · 未匹配 ${number(p.unmatched)} · 歧义 ${number(p.ambiguous)} · 合计 ${number(p.total)}。三项互斥；未匹配与歧义均保留在非县区分区，不重复计入总点位。展开仅展示目录；点击县/区后才按所选分区加载点位。</p><div class="report-county-scroll"><table class="report-county-table"><caption>${text(item.name)}的 ${number(report.countyCount)} 个县/区及非县区分区（完整城市分类统计）</caption><thead><tr><th>县 / 区 / 非县区分区</th><th>常规</th><th>隐藏</th><th>时光机</th><th>未知</th><th>合计</th><th>目录分片</th><th>时间：源日期 / 编码 / 未知</th><th>日期范围</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
if(typeof document!=='undefined')try{
  const catalog=await loadCatalog(),groups=aggregate(catalog.collections),container=document.getElementById('province-groups');
  if(groups.total.total!==catalog.total || (catalog.importSummary?.uniquePanoids!==undefined && catalog.importSummary.uniquePanoids!==catalog.total))throw Error('已发布分类与唯一点位总数不符');
  const search=document.getElementById('report-search'),hiddenOnly=document.getElementById('report-hidden-only'),open=new Set(),countyOpen=new Set();let sortKey='total',descending=true;
  const compare=(a,b)=>{const result=sortKey==='province'?a.name.localeCompare(b.name,'zh-CN'):a.counts[sortKey]-b.counts[sortKey];return descending?-result:result;};
  function render(){
    const provinces=filterGroups(groups.provinces,search.value,hiddenOnly.checked).sort(compare);
    container.replaceChildren(...provinces.map(group=>{
      const details=document.createElement('details');details.className='province-card';details.dataset.province=group.name;details.open=open.has(group.name)||!!search.value||hiddenOnly.checked;
      details.addEventListener('toggle',()=>{if(details.open)open.add(group.name);else open.delete(group.name);});
      const heading=document.createElement('summary');heading.innerHTML=`<span class="province-name">${text(group.name)}</span><span class="province-total">${group.cities.length} 城 · 常规 ${number(group.counts.regular)} · <b class="legend-hidden">隐藏 ${number(group.counts.hidden)}</b> · 时光机 ${number(group.counts.timeMachine)} · 合计 ${number(group.counts.total)}</span>`;
      const body=document.createElement('div');body.className='province-body';body.innerHTML=bar(group.counts);
      const table=document.createElement('table');table.innerHTML='<thead><tr><th>地级行政区</th><th>常规</th><th>隐藏</th><th>时光机</th><th>未知</th><th>合计</th><th>隐藏占比</th><th>原始 / 完全重复 / 差异</th><th>时间：源日期 / 编码 / 未知</th><th>日期范围</th></tr></thead>';
      const tbody=document.createElement('tbody');
      for(const city of [...group.cities].sort((a,b)=>compare({name:a.item.name,counts:a.counts},{name:b.item.name,counts:b.counts}))){
        const {item,counts,countyReport}=city,summary=item.summary||{},base=`./?city=${encodeURIComponent(item.id)}`,tr=document.createElement('tr');tr.dataset.city=item.id;
        tr.innerHTML=`<td><a href="${base}">${text(item.name)}</a> <small>${text(item.adcode)}</small>${countyReport?'<small class="report-city-select-note">选择县/区，不自动加载全城</small>':''}</td><td>${number(counts.regular)}</td><td class="legend-hidden">${counts.hidden?`<a href="${base}&kind=hidden">${number(counts.hidden)}</a>`:'0'}</td><td>${counts.timeMachine?`<a href="${base}&kind=time-machine">${number(counts.timeMachine)}</a>`:'0'}</td><td>${number(counts.unknown)}</td><td>${number(counts.total)}</td><td>${(100*counts.hidden/(counts.total||1)).toFixed(2)}%</td><td>${number(summary.rawRecords??counts.total)} / ${number(summary.exactDuplicates)} / ${number(summary.differingDuplicates)}</td><td>${number(item.captureSummary?.source)} / ${number(item.captureSummary?.panoid)} / ${number(item.captureSummary?.unknown)}</td><td>${text(item.captureSummary?.earliest||'—')} – ${text(item.captureSummary?.latest||'—')}</td>`;tbody.append(tr);
        if(countyReport){
          const row=document.createElement('tr');row.className='report-county-container';
          const cell=document.createElement('td');cell.colSpan=10;
          const countyDetails=document.createElement('details');countyDetails.className='report-county-details';countyDetails.dataset.city=item.id;countyDetails.open=countyOpen.has(item.id)||!!search.value.trim();
          countyDetails.addEventListener('toggle',()=>{if(countyDetails.open)countyOpen.add(item.id);else countyOpen.delete(item.id);});
          const countyHeading=document.createElement('summary');countyHeading.innerHTML=`<span>${text(item.name)} · ${number(countyReport.countyCount)} 个县/区</span><span class="report-county-status">未匹配 ${number(countyReport.partition.unmatched)} · 歧义 ${number(countyReport.partition.ambiguous)} · 仅目录统计</span>`;
          const countyBody=document.createElement('div');countyBody.className='report-county-body';countyBody.innerHTML=countyTableMarkup(item,countyReport);
          countyDetails.append(countyHeading,countyBody);cell.append(countyDetails);row.append(cell);tbody.append(row);
        }
      }
      table.append(tbody);body.append(table);details.append(heading,body);return details;
    }));
    document.getElementById('report-empty').hidden=provinces.length>0;
    document.getElementById('filter-summary').textContent=`筛选后 ${provinces.length} 省级行政区 · ${provinces.reduce((n,p)=>n+p.cities.length,0)} 城市 · ${number(provinces.reduce((n,p)=>n+p.counts.total,0))} 点位${hiddenOnly.checked?'（含隐藏点位城市的完整分类）':''}；顶部汇总不受筛选影响`;
    for(const button of document.querySelectorAll('.report-sort')){const active=button.dataset.sort===sortKey;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));button.dataset.direction=active?(descending?'desc':'asc'):'';}
  }
  search.addEventListener('input',render);hiddenOnly.addEventListener('change',render);
  for(const button of document.querySelectorAll('.report-sort'))button.addEventListener('click',()=>{if(sortKey===button.dataset.sort)descending=!descending;else{sortKey=button.dataset.sort;descending=sortKey!=='province';}render();});
  document.getElementById('report-expand').addEventListener('click',()=>{for(const group of groups.provinces){open.add(group.name);for(const city of group.cities)if(city.countyReport)countyOpen.add(city.item.id);}render();});
  document.getElementById('report-collapse').addEventListener('click',()=>{open.clear();countyOpen.clear();search.value='';hiddenOnly.checked=false;render();});
  for(const key of ['total','regular','hidden','timeMachine','unknown'])document.getElementById(`summary-${key==='timeMachine'?'time-machine':key}`).textContent=number(groups.total[key]);
  const dates=sumCapture(catalog.collections);
  document.getElementById('report-time-summary').textContent=`时间覆盖：源文件明确 ${number(dates.source)} · panoid 编码解析 ${number(dates.panoid)} · 未知 ${number(dates.unknown)} · ${dates.earliest||'—'} 至 ${dates.latest||'—'}。编码包含时分秒/毫秒字段但不包含时区；不是逐条官网认证。`;
  document.getElementById('overall-bar').innerHTML=bar(groups.total);
  document.getElementById('report-coverage').textContent=catalog.publication?`本报告仅含Pages已发布 ${catalog.collections.length} 城；完整源目录 ${catalog.publication.sourceCities} 城，另 ${catalog.publication.remainingCities} 城尚未发布。`:`本报告仅统计目录内 ${catalog.collections.length} 城。`;
  const countyReports=groups.provinces.flatMap(group=>group.cities).filter(city=>city.countyReport),partitionTotals={matched:0,unmatched:0,ambiguous:0,total:0};let countyCount=0;
  for(const city of countyReports){countyCount+=city.countyReport.countyCount;for(const key of Object.keys(partitionTotals))partitionTotals[key]+=city.countyReport.partition[key];}
  document.getElementById('report-county-summary').textContent=countyReports.length?`县级分区覆盖 ${countyReports.length} 城 · ${number(countyCount)} 个OSM县/区（不含非县区分区） · 单一匹配 ${number(partitionTotals.matched)} · 未匹配 ${number(partitionTotals.unmatched)} · 歧义 ${number(partitionTotals.ambiguous)} · 分区合计 ${number(partitionTotals.total)}。分区是城市点位子集，不额外计入顶部汇总；点击城市仅进入县/区选择。`:'本目录尚未发布县级分区；仅显示城市目录统计。';
  const summary=catalog.importSummary||{},total=document.getElementById('report-total');total.textContent=`${number(summary.rawRecords??catalog.total)} 原始 · ${number(catalog.total)} 唯一 · ${number(summary.exactDuplicates)} 完全重复 · ${number(summary.differingDuplicates)} 差异版本`;total.dataset.ready = 'true';
  document.querySelector('#report-source span:last-child').textContent=`已发布 ${catalog.collections.length} 城 · ${groups.provinces.length} 省级行政区`;
  render();window.__BAIDU_WORKBENCH__=Object.freeze({provider:'baidu',ready:true,total:catalog.total,collections:catalog.collections.length,counts:groups.total,captureSummary:dates,source:'published-catalog-summary'});
}catch(error){document.getElementById('report-total').textContent='目录暂不可用';document.getElementById('report-error').textContent=error.message;window.__BAIDU_WORKBENCH__=Object.freeze({provider:'baidu',ready:false,error:error.message});}
export {aggregate,countFor,filterGroups,sumCapture,countySummary,countyHref,boundaryNote,countyTableMarkup};
