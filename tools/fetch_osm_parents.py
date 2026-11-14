#!/usr/bin/env python3
"""Fetch exact OSM parent relations, serially via configured Windows proxy."""
import json,ssl,time,urllib.request,urllib.parse,urllib.error,winreg,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
key=winreg.OpenKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\CurrentVersion\Internet Settings')
if not winreg.QueryValueEx(key,'ProxyEnable')[0]:raise SystemExit('Configured proxy is required')
server=winreg.QueryValueEx(key,'ProxyServer')[0]
parts=dict(p.split('=',1) for p in server.split(';') if '=' in p)
proxy=parts.get('https',parts.get('http',server))
if '://' not in proxy:proxy='http://'+proxy
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'http':proxy,'https':proxy}),urllib.request.HTTPSHandler(context=ssl.create_default_context()))
folder=root/'dist/osm-county-raw'
selected=json.loads((root/'config/pages-publication.json').read_text(encoding='utf8'))['cities']
cities=[c for c in json.loads((root/'data/catalog.json').read_text(encoding='utf8'))['collections'] if c['id'] in selected]
endpoint='https://overpass-api.de/api/interpreter'
for city in cities:
    raw=json.loads((folder/(city['id']+'.json')).read_text(encoding='utf8'))
    relations={str(e['id']):e for e in raw['elements'] if e['type']=='relation'}
    named=[e for e in relations.values() if e.get('tags',{}).get('name:zh',e.get('tags',{}).get('name'))==city['name'] or e.get('tags',{}).get('name')==city['name']]
    if not named:raise SystemExit('No named OSM city parent: '+city['id'])
    level=min(int(e['tags']['admin_level']) for e in named)
    named=[e for e in named if int(e['tags']['admin_level'])==level]
    if len(named)!=1:raise SystemExit('Ambiguous named OSM city parent: '+city['id'])
    relation=named[0]['id'];out=folder/(city['id']+'.parent.json')
    if out.exists():
        data=json.loads(out.read_text(encoding='utf8'))
        if any(e.get('id')==relation and e.get('members') for e in data.get('elements',[])):
            print(json.dumps({'city':city['id'],'parent':relation,'cached':True}),flush=True);continue
    q=f'[out:json][timeout:110][maxsize:33554432];rel({relation});out body geom;'
    req=urllib.request.Request(endpoint,data=urllib.parse.urlencode({'data':q}).encode(),headers={'User-Agent':'BaiduPanoramaWorkbench/1.0 OSM parent boundary (github.com/cn171g11/baidu-panorama-workbench)','Content-Type':'application/x-www-form-urlencoded'})
    for attempt in range(3):
        try:
            with opener.open(req,timeout=145) as r:
                payload=r.read(16*1024*1024+1)
                if len(payload)>16*1024*1024:raise ValueError('Parent geometry exceeds 16MiB')
                data=json.loads(payload)
                if data.get('remark') or not data.get('elements'):raise ValueError('Incomplete parent geometry')
                temp=out.with_suffix('.tmp');temp.write_bytes(payload);temp.replace(out)
                print(json.dumps({'city':city['id'],'parent':relation,'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}),flush=True)
                break
        except urllib.error.HTTPError as e:
            if e.code not in (502,503,504) or attempt==2:raise
            print(json.dumps({'city':city['id'],'retry':attempt+1,'status':e.code}),flush=True);time.sleep(15*(attempt+1))
    time.sleep(2)
