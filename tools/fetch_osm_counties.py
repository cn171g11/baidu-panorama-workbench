#!/usr/bin/env python3
"""Serial OSM county boundary fetch via the configured Windows proxy.
Raw Overpass responses stay under dist; conversion is an independent Node step.
"""
import argparse,json,ssl,time,urllib.request,urllib.parse,winreg,sys,re,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--cities',default='all');parser.add_argument('--endpoint',default='https://overpass-api.de/api/interpreter');parser.add_argument('--refresh',action='store_true');parser.add_argument('--parents',default=None)
a=parser.parse_args()
allowed={'https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'}
if a.endpoint not in allowed: raise SystemExit('Use an approved public Overpass endpoint')
key=winreg.OpenKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Internet Settings')
if not winreg.QueryValueEx(key,'ProxyEnable')[0]:raise SystemExit('A configured system proxy is required; no direct fallback')
server=winreg.QueryValueEx(key,'ProxyServer')[0]
parts=dict(x.split('=',1) for x in server.split(';') if '=' in x)
proxy=parts.get('https',parts.get('http',server))
if '://' not in proxy:proxy='http://'+proxy
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'http':proxy,'https':proxy}),urllib.request.HTTPSHandler(context=ssl.create_default_context()))
catalog=json.loads((root/'data/catalog.json').read_text(encoding='utf8'))
selected=json.loads((root/'config/pages-publication.json').read_text(encoding='utf8'))['cities']
if a.cities!='all':selected=a.cities.split(',')
cities=[c for c in catalog['collections'] if c['id'] in selected]
if len(cities)!=len(set(selected)):raise SystemExit('Unknown or duplicate selected cities')
folder=root/'dist/osm-county-raw';folder.mkdir(parents=True,exist_ok=True)
parentIds=json.loads((root/a.parents).read_text(encoding='utf8')) if a.parents else {}
headers={'User-Agent':'BaiduPanoramaWorkbench/1.0 county-boundary publication (github.com/cn171g11/baidu-panorama-workbench)','Content-Type':'application/x-www-form-urlencoded'}
for city in cities:
    output=folder/(city['id']+'.json')
    if output.exists() and not a.refresh:
        doc=json.loads(output.read_text(encoding='utf8'))
        if doc.get('elements') is not None and not doc.get('remark'):
            print(json.dumps({'city':city['id'],'cached':True,'bytes':output.stat().st_size}),flush=True);continue
    name=city['name'].replace('\\','\\\\').replace('"','\\"')
    # Normal prefectures are level 5; direct-admin cities differ. Select the
    # exact name+code relation when available. Spatial area query then retrieves
    # actual level-6 children, not guessed county names.
    prefix='rel["boundary"="administrative"]["admin_level"~"^(4|5|6)$"]'
    if city['id'] in parentIds:
        relation=parentIds[city['id']]
        if not isinstance(relation,int) or relation<=0:raise SystemExit('Invalid OSM parent relation id')
        parent=f'rel({relation})->.city;'
    else:
        parent=f'({prefix}["division_code"="{city["id"]}"];{prefix}["name"="{name}"];{prefix}["name:zh"="{name}"];)->.city;'
    q=f'[out:json][timeout:110][maxsize:33554432];{parent}.city out body bb;.city map_to_area->.area;rel["boundary"="administrative"]["admin_level"="6"](area.area)->.counties;.counties out body geom;'
    req=urllib.request.Request(a.endpoint,data=urllib.parse.urlencode({'data':q}).encode('utf8'),headers=headers)
    try:
        response=None
        for attempt in range(3):
            try:
                response=opener.open(req,timeout=145)
                break
            except urllib.error.HTTPError as error:
                if error.code not in (502,503,504) or attempt==2:raise
                print(json.dumps({'city':city['id'],'retry':attempt+1,'status':error.code}),flush=True)
                time.sleep(15*(attempt+1))
        with response:
            payload=response.read(16*1024*1024+1)
            if len(payload)>16*1024*1024:raise ValueError('Boundary response exceeds 16MB budget')
            doc=json.loads(payload)
            if doc.get('remark') or 'elements' not in doc:raise ValueError('Incomplete Overpass response')
            (folder/(city['id']+'.query.ql')).write_text(q+'\n',encoding='utf8')
            temp=output.with_suffix('.json.tmp');temp.write_bytes(payload);temp.replace(output)
            meta={'city':city['id'],'name':city['name'],'endpoint':a.endpoint,'timestamp':doc.get('osm3s',{}).get('timestamp_osm_base'),'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest(),'relations':len(doc['elements'])}
            (folder/(city['id']+'.fetch.json')).write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
            print(json.dumps(meta,ensure_ascii=True),flush=True)
    except Exception as exc:
        print(json.dumps({'city':city['id'],'error':str(exc)},ensure_ascii=True),flush=True)
        raise SystemExit(1)
    time.sleep(2)
