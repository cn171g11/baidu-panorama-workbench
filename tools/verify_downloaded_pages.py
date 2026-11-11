"""Validate already-downloaded live Pages gzip files against the live manifest."""
import sys,json,gzip,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
folder=(root/sys.argv[1]).resolve()
if root/'dist' not in folder.parents: raise SystemExit('Reports must be in project/dist')
manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8-sig'))
catalog=json.loads((folder/'catalog.json').read_text(encoding='utf-8-sig'))
checks=[];total=0
for city in catalog['collections']:
    count=0
    for logical in city['files']:
        asset=manifest['assets'][logical]
        source=folder/(city['id']+'-'+Path(asset['url']).name)
        zipped=source.read_bytes()
        assert len(zipped)==asset['compressedBytes'] and hashlib.sha256(zipped).hexdigest()==asset['compressedSha256']
        raw=gzip.decompress(zipped)
        assert len(raw)==asset['bytes'] and hashlib.sha256(raw).hexdigest()==asset['sha256']
        rows=json.loads(raw)
        assert all(row[8]=='baidu' for row in rows)
        count+=len(rows);total+=len(rows)
        checks.append({'id':city['id'],'name':city['name'],'count':len(rows),'compressedSHA256':asset['compressedSha256'],'sourceSHA256':asset['sha256'],'verified':True})
    assert count==city['count']
assert total==catalog['total']
report={'verified':True,'revision':manifest['revision'],'source':manifest['source'],'hostedCities':len(catalog['collections']),'hostedPanoids':total,'nationalSourceCities':catalog['publication']['sourceCities'],'nationalSourcePanoids':catalog['publication']['sourcePanoids'],'cities':checks}
(folder/'full-integrity.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
