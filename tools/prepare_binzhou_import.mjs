import fs from 'node:fs/promises';
import path from 'node:path';
const source='D:/Downloads/百度滨州.json';
const target=path.resolve('dist/binzhou-import.json');
const records=JSON.parse(await fs.readFile(source,'utf8'));
const rows=[];
for(const raw of records){
 const panoid=raw.panoId||raw.id||raw.sid;
 if(typeof panoid!=='string'||!Number.isFinite(raw.lng)||!Number.isFinite(raw.lat))throw new Error('滨州记录缺少有效panoid或坐标');
 if(raw.source!=='baidu'&&raw.source!=='baidu_pano')throw new Error('滨州记录存在非百度来源');
 const extras={source:raw.source,sourceType:raw.sourceType||'hidden',isHidden:raw.isHidden===true||raw.sourceType==='hidden',movementCount:Number(raw.movementCount)||0,gapId:raw.gapId||'',x:raw.x,y:raw.y,timeLine:Array.isArray(raw.timeLine)?raw.timeLine:[],verification:raw.verification||{},links:Array.isArray(raw.timeLine)?raw.timeLine:[]};
 // `capture` in this export is an encoded source timestamp, not an ISO date; leave captured empty.
 rows.push([panoid,raw.lng,raw.lat,raw.roadName||'', '', Number.isFinite(raw.heading)?raw.heading:null, false,true,'baidu',extras]);
}
const output={provider:'baidu',coordinateSystem:'BD-09',rows};
await fs.writeFile(target,JSON.stringify(output)+'\n');
console.log(JSON.stringify({target,rows:rows.length,hidden:rows.filter(row=>row[9].isHidden).length,timeMachine:rows.filter(row=>row[9].sourceType==='time-machine').length},null,2));
