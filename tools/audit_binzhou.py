import json,sys
from pathlib import Path
p=Path(r'D:\Downloads\百度滨州.json')
data=json.loads(p.read_text(encoding='utf-8'))
rows=[]
for r in data:
    if not isinstance(r,dict):continue
    pid=r.get('panoId') or r.get('id') or r.get('sid')
    if not isinstance(pid,str) or not pid:continue
    rows.append({k:r.get(k) for k in ('panoId','sourceType','isHidden','movementCount','roadName','capture','timeLine','verification','lng','lat','heading','pitch','zoom','x','y','source')})
report={'file':p.name,'rawRecords':len(data),'validPanoids':len(rows),'hiddenRecords':sum(bool(r.get('isHidden')) or r.get('sourceType')=='hidden' for r in rows),'timelineRecords':sum(bool(r.get('timeLine')) for r in rows),'verifiedImageRecords':sum(bool((r.get('verification') or {}).get('imageLoaded')) for r in rows),'sources':{},'sample':rows[:3]}
for r in rows:report['sources'][r.get('sourceType') or 'unknown']=report['sources'].get(r.get('sourceType') or 'unknown',0)+1
Path('dist/binzhou-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
