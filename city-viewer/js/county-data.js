// Small manifest-only checks shared by county-aware loaders. No boundary geometry
// is downloaded in the browser; the build already assigned points in WGS84.
export const COUNTY_PARTITION = 'osm-county-wgs84-v1';
export const COUNTY_MAX_ROWS = 25000;
export function safeCountyId(id) { return typeof id==='string' && /^(?:\d{6}|osm-r[1-9]\d{0,15}|unmatched)$/.test(id); }
export function validateCountyCatalog(city) {
  if(city.partition!==COUNTY_PARTITION)throw Error('Unsupported county partition');
  if(!/^\d{6}$/.test(city.id)||!Array.isArray(city.counties)||city.counties.length>513)throw Error('Invalid county directory');
  const countyIds=new Set(),flat=[];let total=0;
  for(const county of city.counties){
    if(!county||!safeCountyId(county.id)||countyIds.has(county.id)||county.cityId!==city.id||county.coordinateSystem!=='BD-09')throw Error('Invalid county identity');
    countyIds.add(county.id);
    if(!['county','unmatched'].includes(county.kind)||((county.id==='unmatched')!==(county.kind==='unmatched')))throw Error('Invalid unmatched partition');
    if(typeof county.name!=='string'||!county.name.trim()||!Number.isSafeInteger(county.count)||county.count<0||!Array.isArray(county.files))throw Error('Invalid county metadata');
    if(county.files.length!==Math.ceil(county.count/COUNTY_MAX_ROWS))throw Error('Invalid county shard count');
    if(county.bounds!==null&&(!Array.isArray(county.bounds)||county.bounds.length!==4||county.bounds.some(n=>!Number.isFinite(n))))throw Error('Invalid county bounds');
    for(let i=0;i<county.files.length;i++){
      const expected=`baidu/${city.id}/counties/${county.id}/points-${String(i+1).padStart(3,'0')}.json`;
      if(county.files[i]!==expected)throw Error('Unsafe county shard path');flat.push(expected);
    }
    total+=county.count;
  }
  if(total!==city.count||flat.length!==city.files.length||flat.some((file,i)=>file!==city.files[i]))throw Error('County totals do not reconcile with city');
  const p=city.partitionSummary;
  if(!p||['matched','unmatched','ambiguous','total'].some(k=>!Number.isSafeInteger(p[k])||p[k]<0)||p.total!==city.count||p.matched+p.unmatched+p.ambiguous!==p.total)throw Error('County assignment summary mismatch');
  const unmatched=city.counties.find(county=>county.id==='unmatched');
  if((unmatched?.count||0)!==p.unmatched+p.ambiguous)throw Error('Unmatched rows are not preserved');
  return city;
}
export function selectCountyFiles(city,id,part='all') {
  validateCountyCatalog(city);
  if(id==='all')return {files:city.files,count:city.count,maxRows:COUNTY_MAX_ROWS,county:null,part:'all'};
  if(!safeCountyId(id))throw Error('Invalid county id');
  const county=city.counties.find(item=>item.id===id);if(!county)throw Error('County is not registered in city');
  if(part==='all')return {files:county.files,count:county.count,maxRows:COUNTY_MAX_ROWS,county,part:'all'};
  const index=Number(part);
  if(!Number.isInteger(index)||index<0||index>=county.files.length||String(index)!==String(part))throw Error('Invalid county shard selection');
  return {files:[county.files[index]],count:Math.min(COUNTY_MAX_ROWS,county.count-index*COUNTY_MAX_ROWS),maxRows:COUNTY_MAX_ROWS,county,part:String(index)};
}
