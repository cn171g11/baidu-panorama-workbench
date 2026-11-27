import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceRecordIsHidden } from '../city-viewer/js/hidden-flag.js';

export function normalizeBinzhouRecord(raw) {
  const panoid=raw.panoId??raw.id??raw.sid??raw.panoid;
  if(typeof panoid!=='string'||!panoid||!Number.isFinite(raw.lng)||!Number.isFinite(raw.lat))throw Error('滨州记录缺少有效panoid或坐标');
  if(['panoId','id','sid','panoid','streetViewId'].some(k=>Object.hasOwn(raw,k)&&raw[k]!==panoid))throw Error('滨州记录 panoid 不一致');
  if(raw.source!=='baidu'&&raw.source!=='baidu_pano')throw Error('滨州记录存在非百度来源');
  const marked=sourceRecordIsHidden(raw,panoid);
  const extras={source:raw.source,sourceType:marked?'hidden':(['regular','time-machine'].includes(raw.sourceType)?raw.sourceType:'unknown'),isHidden:marked,movementCount:Number(raw.movementCount)||0,gapId:raw.gapId||'',x:raw.x,y:raw.y,timeLine:Array.isArray(raw.timeLine)?raw.timeLine:[],verification:raw.verification||{},links:Array.isArray(raw.links)?raw.links:[],extra:{originalRecord:raw}};
  // `capture` is encoded, not an explicit ISO date. Time-line members are not road links.
  return [panoid,raw.lng,raw.lat,raw.roadName||'','',Number.isFinite(raw.heading)?raw.heading:null,false,true,'baidu',extras];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const source='D:/Downloads/百度滨州.json',target=path.resolve('dist/binzhou-import.json');
  const rows=JSON.parse(await fs.readFile(source,'utf8')).map(normalizeBinzhouRecord);
  await fs.writeFile(target,JSON.stringify({provider:'baidu',coordinateSystem:'BD-09',rows})+'\n');
  console.log(JSON.stringify({target,rows:rows.length,hidden:rows.filter(row=>row[9].isHidden).length,timeMachine:rows.filter(row=>row[9].sourceType==='time-machine').length},null,2));
}
