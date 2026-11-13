import { loadCatalog } from './data-store.js';
import { newCaptureSummary } from './panoid-time.js';
function sumCapture(collections){
  const result=newCaptureSummary();
  for(const item of collections){const summary=item.captureSummary;if(!summary)continue;
    if(summary.total!==item.count||summary.source+summary.panoid+summary.unknown!==summary.total)throw Error('时间摘要与城市点位不符');
    for(const key of ['source','panoid','unknown','total'])result[key]+=summary[key];
    if(summary.earliest&&(!result.earliest||summary.earliest<result.earliest))result.earliest=summary.earliest;
    if(summary.latest&&(!result.latest||summary.latest>result.latest))result.latest=summary.latest;
  }
  return result;
}

const text=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number(value||0).toLocaleString('zh-CN');
const empty=()=>({regular:0,hidden:0,timeMachine:0,unknown:0,total:0});
function countFor(item){
  if(!item.displayCounts)return {...empty(),regular:item.count||0,total:item.count||0};
  const values={...empty(),...item.displayCounts};
  if(Object.values(values).some(n=>!Number.isSafeInteger(n)||n<0)||values.total!==(item.count??values.total)||values.regular+values.hidden+values.timeMachine+values.unknown!==values.total)throw Error('分类统计与城市总数不符');
  return values;
}
function aggregate(collections){
  const map=new Map(),total=empty();
  for(const item of collections){const counts=countFor(item),name=item.province||'未标注';if(!map.has(name))map.set(name,{name,counts:empty(),cities:[]});const group=map.get(name);group.cities.push({item,counts});for(const key of Object.keys(total)){total[key]+=counts[key];group.counts[key]+=counts[key];}}
  return {provinces:[...map.values()],total};
}
function filterGroups(groups,needle='',onlyHidden=false){
  needle=needle.trim().toLocaleLowerCase();
  return groups.map(group=>{
    const cities=group.cities.filter(({item,counts})=>(!needle||`${group.name} ${item.name} ${item.adcode}`.toLocaleLowerCase().includes(needle))&&(!onlyHidden||counts.hidden>0));
    const counts=empty();for(const city of cities)for(const key of Object.keys(counts))counts[key]+=city.counts[key];
    return {...group,cities,counts};
  }).filter(group=>group.cities.length);
}
function bar(counts){const total=counts.total||1;return `<div class="ratio-bar" role="img" aria-label="常规${counts.regular}、隐藏${counts.hidden}、时光机${counts.timeMachine}、未知${counts.unknown}">${[['regular','regular'],['hidden','hidden'],['time-machine','timeMachine'],['unknown','unknown']].map(([cls,key])=>`<i class="${cls}" style="width:${100*counts[key]/total}%"></i>`).join('')}</div>`;}
if(typeof document!=='undefined')try{
  const catalog=await loadCatalog(),groups=aggregate(catalog.collections),container=document.getElementById('province-groups');
  if(groups.total.total!==catalog.total || (catalog.importSummary?.uniquePanoids!==undefined && catalog.importSummary.uniquePanoids!==catalog.total))throw Error('已发布分类与唯一点位总数不符');
  const search=document.getElementById('report-search'),hiddenOnly=document.getElementById('report-hidden-only'),open=new Set();let sortKey='total',descending=true;
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
        const {item,counts}=city,summary=item.summary||{},base=`./?city=${encodeURIComponent(item.id)}`,tr=document.createElement('tr');tr.dataset.city=item.id;
        tr.innerHTML=`<td><a href="${base}">${text(item.name)}</a> <small>${text(item.adcode)}</small></td><td>${number(counts.regular)}</td><td class="legend-hidden">${counts.hidden?`<a href="${base}&kind=hidden">${number(counts.hidden)}</a>`:'0'}</td><td>${counts.timeMachine?`<a href="${base}&kind=time-machine">${number(counts.timeMachine)}</a>`:'0'}</td><td>${number(counts.unknown)}</td><td>${number(counts.total)}</td><td>${(100*counts.hidden/(counts.total||1)).toFixed(2)}%</td><td>${number(summary.rawRecords??counts.total)} / ${number(summary.exactDuplicates)} / ${number(summary.differingDuplicates)}</td><td>${number(item.captureSummary?.source)} / ${number(item.captureSummary?.panoid)} / ${number(item.captureSummary?.unknown)}</td><td>${text(item.captureSummary?.earliest||'—')} – ${text(item.captureSummary?.latest||'—')}</td>`;tbody.append(tr);
      }
      table.append(tbody);body.append(table);details.append(heading,body);return details;
    }));
    document.getElementById('report-empty').hidden=provinces.length>0;
    document.getElementById('filter-summary').textContent=`筛选后 ${provinces.length} 省级行政区 · ${provinces.reduce((n,p)=>n+p.cities.length,0)} 城市 · ${number(provinces.reduce((n,p)=>n+p.counts.total,0))} 点位`;
    for(const button of document.querySelectorAll('.report-sort')){const active=button.dataset.sort===sortKey;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));button.dataset.direction=active?(descending?'desc':'asc'):'';}
  }
  search.addEventListener('input',render);hiddenOnly.addEventListener('change',render);
  for(const button of document.querySelectorAll('.report-sort'))button.addEventListener('click',()=>{if(sortKey===button.dataset.sort)descending=!descending;else{sortKey=button.dataset.sort;descending=sortKey!=='province';}render();});
  document.getElementById('report-expand').addEventListener('click',()=>{for(const group of groups.provinces)open.add(group.name);render();});
  document.getElementById('report-collapse').addEventListener('click',()=>{open.clear();search.value='';hiddenOnly.checked=false;render();});
  for(const key of ['total','regular','hidden','timeMachine','unknown'])document.getElementById(`summary-${key==='timeMachine'?'time-machine':key}`).textContent=number(groups.total[key]);
  const dates=sumCapture(catalog.collections);
  document.getElementById('report-time-summary').textContent=`时间覆盖：源文件明确 ${number(dates.source)} · panoid 编码解析 ${number(dates.panoid)} · 未知 ${number(dates.unknown)} · ${dates.earliest||'—'} 至 ${dates.latest||'—'}。编码包含时分秒/毫秒字段但不包含时区；不是逐条官网认证。`;
  document.getElementById('overall-bar').innerHTML=bar(groups.total);
  document.getElementById('report-coverage').textContent=catalog.publication?`本报告仅含Pages已发布 ${catalog.collections.length} 城；完整源目录 ${catalog.publication.sourceCities} 城，另 ${catalog.publication.remainingCities} 城尚未发布。`:`本报告仅统计目录内 ${catalog.collections.length} 城。`;
  const summary=catalog.importSummary||{},total=document.getElementById('report-total');total.textContent=`${number(summary.rawRecords??catalog.total)} 原始 · ${number(catalog.total)} 唯一 · ${number(summary.exactDuplicates)} 完全重复 · ${number(summary.differingDuplicates)} 差异版本`;total.dataset.ready = 'true';
  document.querySelector('#report-source span:last-child').textContent=`已发布 ${catalog.collections.length} 城 · ${groups.provinces.length} 省级行政区`;
  render();window.__BAIDU_WORKBENCH__=Object.freeze({provider:'baidu',ready:true,total:catalog.total,collections:catalog.collections.length,counts:groups.total,captureSummary:dates,source:'published-catalog-summary'});
}catch(error){document.getElementById('report-total').textContent='目录暂不可用';document.getElementById('report-error').textContent=error.message;window.__BAIDU_WORKBENCH__=Object.freeze({provider:'baidu',ready:false,error:error.message});}
export {aggregate,countFor,filterGroups,sumCapture};
