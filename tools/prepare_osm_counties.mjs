import { readFile, mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareBoundarySnapshot } from './counties/boundaries.mjs';
import { writeSnapshotFiles } from './counties/snapshot-files.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--cities'||!args[1]))throw Error('Usage: node tools/prepare_osm_counties.mjs [--cities id,id]');
const catalog=JSON.parse(await readFile(path.join(root,'data/catalog.json'),'utf8'));
const selected=args.length?args[1].split(','):JSON.parse(await readFile(path.join(root,'config/pages-publication.json'),'utf8')).cities;
if(new Set(selected).size!==selected.length||selected.some(id=>!catalog.collections.some(city=>city.id===id)))throw Error('Unknown or duplicate city');
const folder=path.join(root,'config/osm-counties');await mkdir(folder,{recursive:true});if(await realpath(folder)!==folder)throw Error('Unsafe snapshot folder');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function readResponse(file){if(await realpath(file)!==file||!(await lstat(file)).isFile())throw Error('Unsafe OSM response');const bytes=await readFile(file);if(bytes.length>16*1024*1024)throw Error('OSM response exceeds16MiB');return {bytes,response:JSON.parse(bytes.toString('utf8'))};}
const results=[];
for(const city of catalog.collections){
 if(!selected.includes(city.id))continue;
 const raw=await readResponse(path.join(root,'dist/osm-county-raw',city.id+'.json'));
 const parent=await readResponse(path.join(root,'dist/osm-county-raw',city.id+'.parent.json'));
 const {geometry,parentGeometry,metaFields}=prepareBoundarySnapshot({city,response:raw.response,parentResponse:parent.response});
 const encoded=JSON.stringify(geometry)+'\n';const entries=[[city.id+'.geojson',encoded]];
 let parentBytes=0,parentSha256=null;
 if(parentGeometry){const text=JSON.stringify(parentGeometry)+'\n';parentBytes=Buffer.byteLength(text);parentSha256=digest(text);entries.push([city.id+'.parent.geojson',text]);}
 const meta={schemaVersion:1,source:'OpenStreetMap',license:'ODbL-1.0',attribution:'© OpenStreetMap contributors',cityId:city.id,cityName:city.name,coordinateSystem:'WGS84',timestamp:raw.response.osm3s?.timestamp_osm_base||null,parentTimestamp:parent.response.osm3s?.timestamp_osm_base||null,endpoint:'https://overpass-api.de/api/interpreter',rawSha256:digest(raw.bytes),parentRawSha256:digest(parent.bytes),sha256:digest(encoded),bytes:Buffer.byteLength(encoded),parentBytes,parentSha256,countyRelations:geometry.features.map(f=>({id:f.properties.id,name:f.properties.name,osmRelationId:f.properties.osmRelationId,adcode:f.properties.adcode||null})),...metaFields,matchBasis:'OSM county admin-centre association + exact county and parent geometry matching WGS84. Historical OSM codes are retained, not official administrative certification.'};
 entries.push([city.id+'.json',JSON.stringify(meta,null,2)+'\n']);await writeSnapshotFiles(folder,entries);
 results.push({city:city.id,features:geometry.features.length,parentUsable:metaFields.parentUsable,rejected:metaFields.rejected.length,excluded:metaFields.excluded.length,bytes:meta.bytes});console.log(JSON.stringify(results.at(-1)));
}
console.log(JSON.stringify({converted:results.length,results},null,2));
