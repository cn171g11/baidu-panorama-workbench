import { readFile, writeFile, mkdir, lstat, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { validateCatalog } from '../validate_data.mjs';
import { fileFingerprint } from '../stream_rows.mjs';
import { auditXinjiangSource, normalizeXinjiangRecord } from './xinjiang-source.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function inside(parent,file){const relative=path.relative(parent,file);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
async function absent(file){try{await lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function safeExisting(file){if(!(await lstat(file)).isFile()||await realpath(file)!==file)throw Error('Unsafe existing migration file: '+file);}
async function atomic(file,bytes){const temp=file+'.tmp-'+randomUUID();await writeFile(temp,bytes,{flag:'wx'});try{await rename(temp,file);}finally{if(!(await absent(temp))){if(await realpath(temp)!==temp)throw Error('Unsafe migration temporary path');await rm(temp);}}}
function boundsFor(rows){const b=[Infinity,Infinity,-Infinity,-Infinity];for(const row of rows){b[0]=Math.min(b[0],row[1]);b[1]=Math.min(b[1],row[2]);b[2]=Math.max(b[2],row[1]);b[3]=Math.max(b[3],row[2]);}return rows.length?b:null;}

/** Add only a verified previously absent batch, using an explicitly reviewed
 * spatial assignment plan. A duplicate aborts rather than silently losing the
 * incoming metadata. Existing city point files are never rewritten.
 */
export async function prepareXinjiangImport({root,sourceDirectory,assignment,output}){
 root=await realpath(path.resolve(root));sourceDirectory=path.resolve(root,sourceDirectory);output=path.resolve(root,output);
 if(sourceDirectory!==path.join(root,'sources/baidu-xinjiang-20261025')||!inside(path.join(root,'dist'),output)||await realpath(sourceDirectory)!==sourceDirectory)throw Error('Invalid migration paths');
 if(!(await absent(output)))throw Error('Use fresh migration output');
 const sourcePath=path.join(sourceDirectory,'points.json'),manifestPath=path.join(sourceDirectory,'manifest.json');await safeExisting(sourcePath);await safeExisting(manifestPath);
 const sourceBytes=await readFile(sourcePath),audit=auditXinjiangSource(sourceBytes,JSON.parse(await readFile(manifestPath,'utf8')));
  if(!assignment||assignment.sourceSha256!==audit.sha256||assignment.sourceCount!==audit.count||!Array.isArray(assignment.entries)||assignment.entries.length!==audit.count||!Array.isArray(assignment.collections))throw Error('Spatial assignment/source mismatch');
 const mapping=new Map();for(const city of assignment.collections){if(!city||!/^65\d{4}$/.test(city.id)||city.id!==city.adcode||typeof city.name!=='string'||!city.name.trim()||city.province!=='新疆维吾尔自治区'||mapping.has(city.id)||(city.id==='659900'&&city.collectionKind!=='unmatched-region'))throw Error('Invalid Xinjiang collection identity');mapping.set(city.id,city);}
 const base=await validateCatalog(path.join(root,'data'));
 const catalogue=structuredClone(base.catalog),existing=new Set(catalogue.collections.map(c=>c.id));
 for(const id of mapping.keys())if(existing.has(id))throw Error('This batch importer only creates new collections; existing city '+id);
 const grouped=new Map([...mapping.keys()].map(id=>[id,[]])),seen=new Set();
 const db=new DatabaseSync(base.indexPath,{readOnly:true});db.exec('PRAGMA cache_size=-16384; PRAGMA mmap_size=0;');
 try{const lookup=db.prepare('SELECT city FROM owners WHERE panoid=?');for(let i=0;i<audit.records.length;i++){
   const point=audit.records[i],where=assignment.entries[i];
   if(!where||where.panoid!==point.panoId||!mapping.has(where.cityId)||seen.has(point.panoId))throw Error('Assignment does not preserve source identity/order');seen.add(point.panoId);
   if(!['matched','unmatched','ambiguous'].includes(where.match))throw Error('Invalid assignment match');
   if(where.match==='matched'){if(where.cityId==='659900'||typeof where.osmRelationId!=='string'||!/^[1-9]\d{0,15}$/.test(where.osmRelationId)||!Number.isSafeInteger(Number(where.osmRelationId))||typeof where.boundarySha256!=='string'||!/^[a-f0-9]{64}$/.test(where.boundarySha256))throw Error('Invalid matched boundary proof');}
   else if(where.cityId!=='659900'||mapping.get(where.cityId).collectionKind!=='unmatched-region'||where.osmRelationId!=null||where.boundarySha256!=null)throw Error('Unmatched assignment requires explicit regional holding collection without boundary proof');
   if(lookup.get(point.panoId))throw Error('Existing panoid found; preserve source and review merge before import');
   const row=normalizeXinjiangRecord(point,{sourceFile:'baidu-xinjiang-20261025/points.json',sourceSha256:audit.sha256});
   row[9].extra.cityAssignment={source:'OpenStreetMap',match:where.match,cityId:where.cityId,osmRelationId:where.osmRelationId||null,boundarySha256:where.boundarySha256||null};grouped.get(where.cityId).push(row);
 }}finally{db.close();}
 await mkdir(output,{recursive:true});if(await realpath(output)!==output)throw Error('Symlinked migration output');
 const files=[],collections=[];const sourceSummary={name:'baidu-xinjiang-20261025/points.json',bytes:audit.bytes,sha256:audit.sha256,inputCoordinateSystem:'WGS84'};
 for(const [id,rows]of grouped){if(!rows.length)continue;const identity=mapping.get(id),logical=`baidu/${id}/points-001.json`,text=JSON.stringify(rows)+'\n';
   if(rows.length>180000||Buffer.byteLength(text)>=100000000)throw Error('Unexpected migration shard size');
   const file=path.join(output,logical);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text,{flag:'wx'});
   files.push({path:logical,count:rows.length,bytes:Buffer.byteLength(text),sha256:digest(text)});
   collections.push({id,adcode:id,name:identity.name,province:identity.province,coordinateSystem:'BD-09',count:rows.length,bounds:boundsFor(rows),files:[logical],sources:[sourceSummary.name],...(identity.collectionKind?{collectionKind:identity.collectionKind}:{}),summary:{sourceFiles:1,rawRecords:rows.length,uniquePanoids:rows.length,exactDuplicates:0,differingDuplicates:0}});
 }
 if(collections.reduce((n,c)=>n+c.count,0)!==audit.count)throw Error('Migration output count mismatch');
 catalogue.collections.push(...collections);catalogue.collections.sort((a,b)=>a.id.localeCompare(b.id));catalogue.total+=audit.count;catalogue.updatedAt=new Date().toISOString();
 const prior=catalogue.importSummary;if(!prior)throw Error('Expected existing import summary');
 // Upstream 36 duplicates were removed before this source existed: they are
 // provenance only, not 36 newly imported or proven-identical records.
 prior.sourceFiles+=1;prior.rawRecords+=audit.count;prior.uniquePanoids=catalogue.total;
 const oldCrs=prior.inputCoordinateSystem;prior.inputCoordinateSystem='mixed';prior.inputCoordinateSystems=[...new Set([...(prior.inputCoordinateSystems||[oldCrs]),'WGS84'])].filter(c=>c&&c!=='mixed');
 for(const city of collections)prior.files.push({...sourceSummary,city:city.id,rawRecords:city.count,uniquePanoids:city.count,exactDuplicates:0,differingDuplicates:0,sourceRecordSubset:true});
 const catalogBytes=JSON.stringify(catalogue,null,2)+'\n';await writeFile(path.join(output,'catalog.json'),catalogBytes,{flag:'wx'});
 const summaryBytes=JSON.stringify({schemaVersion:1,provider:'baidu',...prior},null,2)+'\n';await mkdir(path.join(output,'imports'),{recursive:true});await writeFile(path.join(output,'imports/source-summary.json'),summaryBytes,{flag:'wx'});
 const report={schemaVersion:1,batch:'baidu-xinjiang-20261025',provider:'baidu',source:sourceSummary,sourceRecords:audit.count,upstreamRawRecords:audit.sourceRawCount,upstreamDuplicatesRemoved:audit.upstreamDuplicates,upstreamDuplicateEquivalence:'not provided',newPanoids:audit.count,existingDuplicates:0,baseTotal:base.catalog.total,nextTotal:catalogue.total,baseSignature:base.signature,baseFiles:base.files.map(({path,bytes,sha256,count})=>({path,bytes,sha256,count})),nextCatalogSha256:digest(catalogBytes),sourceSummaryAfterSha256:digest(summaryBytes),baseCatalogSha256:digest(await readFile(path.join(root,'data/catalog.json'))),sourceSummaryBeforeSha256:digest(await readFile(path.join(root,'data/imports/source-summary.json'))),files,collections:collections.map(({id,name,count,collectionKind})=>({id,name,count,...(collectionKind?{collectionKind}:{})}))};
 await writeFile(path.join(output,'migration.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}

/** Install prepared NEW city folders, catalog and source summary with rollback.
 * The previously verified source catalogue and every existing city shard remain
 * protected; validation is serial and the migration records are not re-generated.
 */
export async function applyXinjiangImport({root,prepared}){
 root=await realpath(path.resolve(root));prepared=path.resolve(root,prepared);if(!inside(path.join(root,'dist'),prepared)||await realpath(prepared)!==prepared)throw Error('Unsafe prepared migration');
 const reportPath=path.join(prepared,'migration.json');await safeExisting(reportPath);const report=JSON.parse(await readFile(reportPath,'utf8'));
 if(report.batch!=='baidu-xinjiang-20261025'||report.provider!=='baidu'||!Array.isArray(report.files)||!Array.isArray(report.baseFiles))throw Error('Wrong migration plan');
 const sourcePath=path.join(root,'sources/baidu-xinjiang-20261025/points.json');await safeExisting(sourcePath);const currentSource=await readFile(sourcePath);if(currentSource.length!==report.source.bytes||digest(currentSource)!==report.source.sha256)throw Error('Source changed after preparation');
 const data=path.join(root,'data'),catalogFile=path.join(data,'catalog.json'),summaryFile=path.join(data,'imports/source-summary.json');await safeExisting(catalogFile);await safeExisting(summaryFile);
 const originalCatalog=await readFile(catalogFile),originalSummary=await readFile(summaryFile);
 if(digest(originalCatalog)!==report.baseCatalogSha256||digest(originalSummary)!==report.sourceSummaryBeforeSha256)throw Error('Dataset changed after preparation');
 for(const file of report.baseFiles){if(!/^baidu\/\d{6}\/points-\d{3,}\.json$/.test(file.path))throw Error('Unsafe baseline shard');const target=path.join(data,file.path);await safeExisting(target);const actual=await fileFingerprint(target);if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw Error('Baseline shard changed after preparation');}
 const preparedCatalog=path.join(prepared,'catalog.json'),preparedSummary=path.join(prepared,'imports/source-summary.json');await safeExisting(preparedCatalog);await safeExisting(preparedSummary);
 const nextCatalog=await readFile(preparedCatalog),nextSummary=await readFile(preparedSummary);
 if(digest(nextCatalog)!==report.nextCatalogSha256||digest(nextSummary)!==report.sourceSummaryAfterSha256)throw Error('Prepared metadata changed');
 const plannedPaths=new Set();for(const file of report.files){if(plannedPaths.has(file.path))throw Error('Repeated planned shard');plannedPaths.add(file.path);}
 for(const file of report.files){if(!/^baidu\/65\d{4}\/points-001\.json$/.test(file.path))throw Error('Unsafe planned shard');const from=path.join(prepared,file.path);await safeExisting(from);const bytes=await readFile(from);if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw Error('Prepared shard changed');const to=path.join(data,file.path);if(!(await absent(path.dirname(to))))throw Error('Refusing existing city directory');}
 const installed=[];let changed=false;
 try{
   for(const file of report.files){const fromDir=path.dirname(path.join(prepared,file.path)),toDir=path.dirname(path.join(data,file.path));if(await realpath(fromDir)!==fromDir||!(await absent(toDir)))throw Error('Unsafe source/destination city directory');await rename(fromDir,toDir);installed.push({fromDir,toDir});}
   changed=true;await atomic(summaryFile,nextSummary);await atomic(catalogFile,nextCatalog);
   const validated=await validateCatalog(data);if(validated.catalog.total!==report.nextTotal)throw Error('Post-import count differs');
   return {...report,validated:true,validationSignature:validated.signature};
 }catch(error){
   if(changed){await atomic(catalogFile,originalCatalog);await atomic(summaryFile,originalSummary);}
   for(const {fromDir,toDir}of installed.reverse()){if(await realpath(toDir)!==toDir||!(await absent(fromDir)))throw Error('Unsafe rollback directory');await rename(toDir,fromDir);}
   throw error;
 }
}
