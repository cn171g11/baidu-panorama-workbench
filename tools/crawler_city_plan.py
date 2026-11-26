"""Stream the 11.25 real upload into an auditable, private geographical plan. Stdlib only."""
import argparse
import collections
import contextlib
import datetime as dt
import hashlib
import heapq
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist/crawler-1125-geoplan'
BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/'
MANIFEST = 'boundary-manifest.json'
PROVINCES = set('11 12 13 14 15 21 22 23 31 32 33 34 35 36 37 41 42 43 44 45 46 50 51 52 53 54 61 62 63 64 65 71 81 82'.split())
SINGLE = {'11','12','31','50','71','81','82'}
EXTRA = ['baidu-020-0000-6A-crawler-results.json', 'baidu-020-0000-5C-crawler-results.json']
DOC = 'https://help.aliyun.com/zh/datav/datav-6-0/user-guide/map-data-format'
CHUNK = 64 * 1024

def require(ok, msg):
    if not ok:
        raise ValueError(msg)

def packed(ob):
    return json.dumps(ob, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

def write_json(p, ob):
    p.write_text(json.dumps(ob, indent=2, ensure_ascii=False, allow_nan=False)+'\n', encoding='utf-8')

def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

def digest(stream):
    h = hashlib.sha256()
    for b in iter(lambda: stream.read(CHUNK), b''):
        h.update(b)
    return h.hexdigest()

def sha(p):
    with p.open('rb') as f: return digest(f)

def features(doc):
    return doc['features'] if doc['type']=='FeatureCollection' else [doc]

def fetch(out):
    """Only the manifest is a deliverable. Private transient bytes verify exact replay."""
    private = out / '_private'; private.mkdir(parents=True, exist_ok=True)
    sources = []
    def get(key):
        name = key+'.json'; dest = private/name; url = BASE+name
        infofile=private/(key+'.receipt'); info=None
        if dest.exists() and infofile.exists():
            info=json.loads(infofile.read_bytes()); require(info['sha256']==sha(dest) and info['url']==url, 'corrupt private snapshot')
        else:
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(url, timeout=25) as r:
                        require(r.status==200 and r.geturl()==url, 'unexpected response')
                        b=r.read(8_000_001); require(len(b)<8_000_001, 'unexpectedly large boundary response')
                        doc=json.loads(b); require(len(features(doc))>0, 'no features')
                        info={'url':url,'file':name,'retrievedUtc':utc(),'httpLastModified':r.headers.get('Last-Modified'),'etag':r.headers.get('ETag'),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
                    dest.write_bytes(b); write_json(infofile,info); break
                except OSError:
                    if attempt==2: raise
        doc=json.loads(dest.read_bytes()); sources.append(info); return features(doc),info
    national, rootinfo = get('100000_full'); provinces={str(f['properties']['adcode']):f['properties'] for f in national if str(f['properties']['adcode']).isdigit()}
    require(set(provinces)=={p+'0000' for p in PROVINCES},'province roster mismatch')
    rootinfo['use']='province roster (not used as city polygons)'; rootinfo['excludedNonAdministrativeFeatures']=[f['properties'].get('adcode') for f in national if not str(f['properties']['adcode']).isdigit()]
    codes=set()
    for code, p in sorted(provinces.items()):
        special=code[:2] in SINGLE; fs, info=get(code+('' if special else '_full')); info.update(provinceId=code,province=p['name'],use='province-equivalent' if special else 'all immediate administrative children',rosterChildrenNum=p['childrenNum']); items=[]
        for f in fs:
            pr=f['properties']; ad=str(pr['adcode']); require(re.fullmatch(r'\d{6}',ad) and ad.startswith(code[:2]) and ad not in codes and bool(pr['name']),f'bad/repeated id {ad}'); codes.add(ad)
            require(ad==code if special else str(pr['parent']['adcode'])==code, f'parent mismatch {ad}')
            require(f['geometry']['type'] in {'Polygon','MultiPolygon'} and f['geometry']['coordinates'],f'no polygon {ad}')
            items.append({'id':ad,'name':pr['name'],'level':pr.get('level')})
        require(len(items)==(1 if special else p['childrenNum']),f'incomplete {code}, got {len(items)} expected {p["childrenNum"]}')
        info['areas']=items
        print('snapshot',code,len(fs),info['sha256'],flush=True)
    manifest={'version':1,'snapshotCompletedUtc':utc(),'provider':'Alibaba Cloud DataV.GeoAtlas areas_v3','crs':'GCJ-02 (working interpretation, not a per-response CRS declaration)','crsDocumentation':DOC,'crsEvidence':'DataV states its map components primarily use GCJ-02 and recommends GeoAtlas for administrative boundaries; provider does not specifically certify every vertex in these files.','coverage':'All 34 province-level units in this version of the provider roster; all immediate children for 27 provinces/autonomous regions. Four municipalities and Hong Kong/Macao use their own province polygon; Taiwan has no subregions in this snapshot and is province-only. Includes province-administered county-equivalent units as their own codes; not a contemporary official code register.','snapshotLimit':'For example, the Xinjiang file includes 659001–659010; 659011 and 659012 are not separate units here. Simplification, vintage, coastal gaps, overlaps, sovereignty and border interpretations limit precision. Geometry is not redistributed.','areas':len(codes),'sources':sources}
    write_json(out/MANIFEST,manifest)

def chunks_of_edges(coords):
    # Handle closed GeoJSON rings (including shared edges), repeated zero-length segments, and holes.
    require(len(coords)>=4 and coords[0]==coords[-1], 'open or short polygon ring')
    return tuple((float(p[0]),float(p[1])) for p in coords)

def bounds(points):
    xs,ys=zip(*points); return min(xs),min(ys),max(xs),max(ys)

def union(boxes):
    boxes=list(boxes); return min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)

def hits(b,x,y): return b[0]<=x<=b[2] and b[1]<=y<=b[3]

def lower2(b,x,y,kx):
    dx=max(b[0]-x,0,x-b[2])*kx; dy=max(b[1]-y,0,y-b[3])*110540
    return dx*dx+dy*dy

def seg2(x,y,kx,a,b):
    ax=(a[0]-x)*kx; ay=(a[1]-y)*110540; vx=(b[0]-a[0])*kx; vy=(b[1]-a[1])*110540; norm=vx*vx+vy*vy
    t=max(0,min(1,-(ax*vx+ay*vy)/norm)) if norm else 0
    return (ax+t*vx)**2+(ay+t*vy)**2

class Ring:
    def __init__(self,coords):
        self.pts=chunks_of_edges(coords); self.box=bounds(self.pts)
        self.blocks=[(bounds(self.pts[i:i+17]),i,min(i+16,len(self.pts)-1)) for i in range(0,len(self.pts)-1,16)]
        self.bins=collections.defaultdict(list)
        for b,i,k in self.blocks:
            for j in range(math.floor(b[1]*4), math.floor(b[3]*4)+1): self.bins[j].append((b,i,k))
    def loc(self,x,y):
        if not hits(self.box,x,y): return 0
        inside=False
        for b,i,end in self.bins[math.floor(y*4)]:
            if b[1]>y or b[3]<y or b[2]<x: continue
            for j in range(i,end):
                ax,ay=self.pts[j]; bx,by=self.pts[j+1]
                if min(ax,bx)<=x<=max(ax,bx) and min(ay,by)<=y<=max(ay,by) and abs((bx-ax)*(y-ay)-(by-ay)*(x-ax))<=1e-14: return 2
                if (ay>y)!=(by>y) and x<ax+(bx-ax)*(y-ay)/(by-ay): inside=not inside
        return int(inside)

class Area:
    def __init__(self,f,info):
        p=f['properties']; self.code=str(p['adcode']); self.name=p['name']; self.province=info['province']; self.url=info['url']; g=f['geometry']; self.polys=[[Ring(r) for r in poly] for poly in ([g['coordinates']] if g['type']=='Polygon' else g['coordinates'])]; self.box=union(rs[0].box for rs in self.polys)
    def inside(self,x,y):
        for rings in self.polys:
            loc=rings[0].loc(x,y)
            if loc==2: return True
            if loc!=1: continue
            h=[r.loc(x,y) for r in rings[1:]]
            if 2 in h or 1 not in h: return True
        return False
    def dist(self,x,y,kx):
        best=math.inf
        # Exact branch-and-bound in the documented query-latitude projected metric.
        for ring in (r for rs in self.polys for r in rs):
            if lower2(ring.box,x,y,kx)>best: continue
            for box,start,end in ring.blocks:
                if lower2(box,x,y,kx)>best: continue
                for j in range(start,end): best=min(best,seg2(x,y,kx,ring.pts[j],ring.pts[j+1]))
        return math.sqrt(best)

class Atlas:
    def __init__(self,areas):
        self.areas=areas; self.bins=collections.defaultdict(list)
        for a in areas:
            b=a.box
            for ix in range(math.floor(b[0]),math.floor(b[2])+1):
                for iy in range(math.floor(b[1]),math.floor(b[3])+1): self.bins[ix,iy].append(a)
    def assign(self,x,y):
        inside=[a for a in self.bins.get((math.floor(x),math.floor(y)),()) if hits(a.box,x,y) and a.inside(x,y)]
        if len(inside)==1: return inside[0],'inside-polygon',0,None
        kx=111320*math.cos(math.radians(y)); scored=[]
        if inside:
            scored=sorted((a.dist(x,y,kx),a.code,a) for a in inside); method='overlap-nearest-boundary'
        else:
            ordered=sorted((lower2(a.box,x,y,kx),a.code,a) for a in self.areas); method='nearest-boundary'
            for low,code,a in ordered:
                # Keep the top three *distinct cities* and every tie at the third distance.
                if len(scored)>=3 and low>(scored[2][0]+1e-6)**2: break
                scored.append((a.dist(x,y,kx),code,a)); scored.sort()
            scored=[s for s in scored if s[0]<=scored[min(2,len(scored)-1)][0]+1e-6]
        # 1 micrometre tie tolerance; shared segments traversed in opposite order can differ by roundoff.
        best=min((s for s in scored if s[0]<=scored[0][0]+1e-6),key=lambda s:s[1]); d,code,a=best
        cand=[{'id':s[1],'name':s[2].name,'distance':round(s[0],2)} for s in [best]+[s for s in scored if s!=best]]
        return a,method,round(d,2),cand

def atlas(out):
    m=json.loads((out/MANIFEST).read_bytes()); areas=[]
    for info in m['sources']:
        if 'areas' not in info: continue
        p=out/'_private'/info['file']; require(sha(p)==info['sha256'],'snapshot hash drift'); areas.extend(Area(f,info) for f in features(json.loads(p.read_bytes())))
    require(len(areas)==len({a.code for a in areas})==m['areas'],'atlas code count'); return Atlas(areas)

# Incremental JSON grammar for actual upload arrays, legacy wrapped arrays and legacy mapping objects.
class JsonReader:
    def __init__(self,f): self.f=f; self.buf=''; self.pos=0; self.end=False; self.dec=json.JSONDecoder()
    def more(self):
        b=self.f.read(CHUNK); self.buf=self.buf[self.pos:]+b; self.pos=0; self.end=not b
        require(len(self.buf)<2*1024*1024,'single JSON value exceeds bound')
    def peek(self):
        while True:
            while self.pos<len(self.buf) and self.buf[self.pos] in ' \r\t\n': self.pos+=1
            if self.pos<len(self.buf): return self.buf[self.pos]
            if self.end: return None
            self.more()
    def token(self,c):
        require(self.peek()==c,'expected JSON '+c); self.pos+=1
    def value(self):
        require(self.peek() is not None,'truncated value')
        while True:
            try: ob,n=self.dec.raw_decode(self.buf,self.pos)
            except json.JSONDecodeError:
                if self.end: raise
                self.more(); continue
            if n==len(self.buf) and not self.end:
                self.more(); continue
            self.pos=n; return ob
    def array(self):
        self.token('[')
        if self.peek()!=']':
            yield self.value()
            while self.peek()==',': self.token(','); yield self.value()
        self.token(']')
    def array_doc(self,wrapped=False):
        if wrapped: self.token('{'); require(self.value()=='assignments','not legacy assignment file'); self.token(':')
        yield from self.array()
        if wrapped:
            while self.peek()==',': self.token(','); self.value(); self.token(':'); self.value()
            self.token('}')
        require(self.peek() is None,'trailing content')
    def members(self):
        self.token('{')
        if self.peek()!='}':
            while True:
                key=self.value(); self.token(':'); yield key,self.value()
                if self.peek()!=',': break
                self.token(',')
        self.token('}'); require(self.peek() is None,'trailing content')

def bd_gcj(lng,lat):
    x=lng-.0065; y=lat-.006; t=math.pi*3000/180; z=math.hypot(x,y)-.00002*math.sin(y*t); a=math.atan2(y,x)-.000003*math.cos(x*t); return z*math.cos(a),z*math.sin(a)

def projection_tables():
    # This public, source-referenced coefficient table is shared with the independent parity gate.
    tables=json.loads((ROOT/'tools/bd09mc-coefficients.json').read_bytes())
    return list(zip(tables['MC_BANDS'], tables['MC_TO_LL']))

def crs_error(raw,tables):
    x,y,lng,lat=(raw[k] for k in ('x','y','lng','lat'))
    require(all(isinstance(v,(float,int)) and math.isfinite(v) for v in (x,y,lng,lat)) and -180<=lng<=180 and -90<=lat<=90,'invalid coordinate')
    f=next(f for b,f in tables if abs(y)>=b); q=abs(y)/f[9]; l=math.copysign(f[0]+f[1]*abs(x),x); a=math.copysign(sum(f[2+i]*q**i for i in range(7)),y)
    return max(abs(l-lng),abs(a-lat))

def verify_upload(downloads):
    dist=ROOT/'dist'; extracted=dist/'external-upload-audit-20261126'; zpath=downloads/'11.25.zip'; out=[]
    ziphash=sha(zpath); require(ziphash=='e3a92c991aece353e6a8863142eca0e7f7ec5edf2b87ddef7f71b9fbfaaf2be9','different ZIP batch')
    with zipfile.ZipFile(zpath) as z:
        members=z.infolist(); require(len(members)==69 and all(re.fullmatch(r'baidu-\d{3}-0000-[A-Z0-9]{2}-crawler-results\.json',m.filename) for m in members),'unexpected ZIP members')
        names={m.filename for m in members}; require(len(names)==69 and names.isdisjoint(EXTRA),'ZIP member set differs')
        for m in sorted(members,key=lambda v:v.filename):
            p=extracted/m.filename
            with z.open(m) as f: h=digest(f)
            require(m.file_size==p.stat().st_size and h==sha(p),'ZIP/extracted hash mismatch: '+m.filename)
            out.append((p,{'file':m.filename,'container':'11.25.zip','bytes':m.file_size,'sha256':h,'zipCRC32':f'{m.CRC:08x}','extractedBytesVerified':True}))
    for name in EXTRA:
        p=downloads/name;out.append((p,{'file':name,'container':None,'bytes':p.stat().st_size,'sha256':sha(p)}))
    ledgerp=dist/'crawler-1125-input-ledger.json'; ref=json.loads(ledgerp.read_bytes()) if ledgerp.exists() else None
    if ref:
        require({p.name for p,_ in out}==ref['expected'].keys(),'ledger roster')
        for p,entry in out: require(entry['sha256']==ref['expected'][p.name]['sha256'],'source hash differs from ledger: '+p.name)
    return out,ref,{'zipSha256':ziphash,'zipBytes':zpath.stat().st_size,'members':69,'legacyLedgerSha256':sha(ledgerp) if ref else None}

def owner_index():
    data=(ROOT/'data').resolve(); p=ROOT/'dist/validation-cache'/hashlib.sha256(str(data).encode()).hexdigest()[:20]; v=json.loads((p/'validation.json').read_bytes()); cat=sha(data/'catalog.json'); sig=hashlib.sha256(packed([cat,[[x['path'],x['bytes'],x['sha256']] for x in v['files']]]).encode()).hexdigest(); require(sig==v['signature'],'current catalog differs from cached validation'); db=sqlite3.connect((p/'owners.sqlite').as_uri()+'?mode=ro',uri=True); db.execute('pragma cache_size=-4096'); require(db.execute("select value from metadata where key='signature'").fetchone()==(sig,),'owner DB metadata mismatch'); return db,{'cachedValidationSignature':sig,'catalogSha256':cat,'baselineTotal':v['total'],'note':'Lookup-only comparison against cached validator index matching current catalog SHA and cached file signatures, not an independent rescan of stored rows. Archive owner does not overrule the geometric plan.'}

LEGACY=[('osm','crawler-1125-osm-assignments-v3.json',249457),('osm','crawler-1125-extra-assignments-v3.json',5965),('datav','crawler-1125-datav-assignments.json',249457),('datav','crawler-1125-extra-datav-assignments.json',5965),('extra632','crawler-1125-two-unassigned-632-match/assignments.json',7116),('priorPlan','crawler-1125-import-mapping-v2.json',None)]

def legacy_comparison(db,out):
    # All large files are read serially. Prior results are competing evidence, never used to select a new city.
    db.execute('create table old(pid text, family text, code text, method text, meters real, primary key (pid,family)) without rowid')
    stats=[]
    for family,rel,expected in LEGACY:
        p=ROOT/'dist'/rel
        if not p.is_file(): continue  # optional local historical audit, never an assignment source
        n=0; methods=collections.Counter(); disagree=0; missing=0
        with p.open(encoding='utf-8-sig') as f:
            reader=JsonReader(f); rows=reader.members() if family=='priorPlan' else ((r['id'],r) for r in reader.array_doc(True))
            for pid,r in rows:
                code=r['id'] if family=='priorPlan' else r['city']; method=r['method']; methods[method]+=1; n+=1
                db.execute('insert into old values(?,?,?,?,?)',(pid,family,code,method,r.get('distance')))
                city=db.execute('select city from plan where pid=?',(pid,)).fetchone(); require(city,'unknown ID in legacy file')
                if not code: missing+=1
                elif city[0]!=code: disagree+=1
        if expected is not None: require(n==expected,'wrong historical comparison count: '+rel)
        stats.append({'family':family,'artifact':'dist/'+rel,'sha256':sha(p),'rows':n,'scopeExpected':expected if expected is not None else 255422,'historicalMissingIds':(expected if expected is not None else 255422)-n,'methods':methods,'noDecision':missing,'assignedDifferentFromNew':disagree}); print('compared',rel,n,disagree,flush=True)
    db.commit()
    disagreements={}; i=0; sqlite_filter='(p.owner is not null and p.city!=p.owner) or exists(select 1 from old o where o.pid=p.pid and o.code is not null and o.code!=p.city)'
    pair=collections.Counter()
    with (out/'conflicts.jsonl').open('w',encoding='utf-8',newline='\n') as f:
        for pid,src,city,method,meters,owner in db.execute('select pid,input,city,method,distance,owner from plan p where '+sqlite_filter+' order by pid'):
            old={k:{'id':val,'method':met,'distance':dist} for k,val,met,dist in db.execute('select family,code,method,meters from old where pid=? order by family',(pid,))}; obs={'panoid':pid,'input':src,'new':{'id':city,'method':method,'distance':meters},'legacy':old}
            if owner: obs['archiveOwner']=owner
            if old.get('osm',{}).get('id') and old.get('datav',{}).get('id') and old['osm']['id']!=old['datav']['id']: pair[(old['osm']['method'],old['datav']['method'])]+=1
            f.write(packed(obs)+'\n'); i+=1
    disagreements['uniqueIdsWithAnyDifferences']=i; disagreements['partialOsmVsPartialDatavAssignedConflict']=sum(pair.values()); disagreements['partialOsmVsPartialDatavMethods']=[{'osmMethod':a,'datavMethod':b,'count':n} for (a,b),n in sorted(pair.items())]; disagreements['artifacts']=stats
    return disagreements

def build(downloads):
    out=OUT; inputs,ref,source=verify_upload(downloads); index,ownerInfo=owner_index(); a=atlas(out); tables=projection_tables(); seen=0; maxerr=0.0; bymethod=collections.Counter(); bycity=collections.Counter(); oldcities=collections.Counter(); top=[]; datahash=hashlib.sha256(); total_bytes=0
    # Do not leave a stale COMPLETE report claiming the newly-started output is finished.
    require(not (out/'quality.json').exists() and not (out/'mapping.jsonl').exists(),'completed output exists: use a fresh run'); tstart=time.monotonic()
    with tempfile.TemporaryDirectory(dir=out,prefix='_work-') as tmp,contextlib.closing(index),contextlib.closing(sqlite3.connect(Path(tmp)/'points.sqlite')) as db:
        db.executescript('pragma journal_mode=off; pragma synchronous=off; pragma cache_size=-8192; pragma temp_store=file; create table plan(pid text primary key,input text not null,city text not null,method text not null,distance real not null,owner text) without rowid;')
        with (Path(tmp)/'mapping.jsonl').open('wb') as dest:
            for p,entry in inputs:
                n=0; methods=collections.Counter(); er=0; ownercount=0; mismatches=0
                with p.open(encoding='utf-8-sig') as f:
                    for r in JsonReader(f).array_doc():
                        pid=r['panoId']; require(pid==r['sid']==r['id'] and isinstance(pid,str) and re.fullmatch(r'[a-zA-Z0-9]{27}',pid) and r['source']=='baidu','invalid canonical/provider identity'); err=crs_error(r,tables); require(err<1e-6,'BD09MC disagrees with input: '+pid); er=max(er,err); x,y=bd_gcj(r['lng'],r['lat']); city,m,d,candidates=a.assign(x,y)
                        require(city.code!='659900','nonadministrative bucket'); ob={'panoid':pid,'id':city.code,'adcode':city.code,'name':city.name,'province':city.province,'method':m,'distance':d,'source':city.url}
                        if candidates: ob['candidates']=candidates
                        hit=index.execute('select city from owners where panoid=?',(pid,)).fetchone(); owner=hit[0] if hit else None
                        if owner: ownercount+=1; oldcities[owner]+=1; mismatches+=int(owner!=city.code)
                        db.execute('insert into plan values(?,?,?,?,?,?)',(pid,p.name,city.code,m,d,owner)); line=(packed(ob)+'\n').encode(); dest.write(line); datahash.update(line); total_bytes+=len(line); n+=1; seen+=1; bycity[city.code]+=1; bymethod[m]+=1; methods[m]+=1
                        if m!='inside-polygon':
                            item=(d,pid,p.name,city.code,m); heapq.heappush(top,item)
                            if len(top)>30: heapq.heappop(top)
                require(not ref or n==ref['expected'][p.name]['rows'],'per-file input count mismatch: '+p.name); maxerr=max(maxerr,er); entry.update(rows=n,methods=methods,bd09InverseMaxErrorDegrees=er,existingOwnerHits=ownercount,ownerDisagreements=mismatches)
                db.commit(); print('mapped',p.name,n,seen,flush=True)
        require(seen==255422==db.execute('select count(*) from plan').fetchone()[0] and (not ref or (seen==ref['raw'] and oldcities==ref['oldCities'])),'total, uniqueness or archive owner mismatch'); require(sum(e['rows'] for _,e in inputs if e['container'])==249457,'ZIP row total'); source['files']=[e for _,e in inputs]; source['inputCrs']='BD-09; every recorded x/y is inverse-projected with the project BD09MC polynomial and compared to the supplied longitude/latitude, not inferred from filename.'; source['maxInverseResidualDegrees']=maxerr
        # Independently check the on-disk JSONL transport checksum before handoff.
        require(datahash.hexdigest()==sha(Path(tmp)/'mapping.jsonl'),'transport checksum mismatch')
        print('legacy comparisons starting',flush=True); disagreements=legacy_comparison(db,out)
        ownerInfo.update(hits=sum(oldcities.values()),byOwner=oldcities,conflicts=db.execute('select count(*) from plan where city!=owner').fetchone()[0]); ownerInfo['details']='existing-owners.jsonl'; ownerInfo['mismatchPairs']=[{'owner':o,'new':c,'rows':n} for o,c,n in db.execute('select owner,city,count(*) from plan where owner!=city group by owner,city order by count(*) desc,owner,city')]
        with (out/'existing-owners.jsonl').open('w',encoding='utf-8',newline='\n') as f:
            for pid,src,c,m,d,o in db.execute('select * from plan where owner is not null order by pid'): f.write(packed(dict(panoid=pid,input=src,id=c,method=m,distance=d,archiveOwner=o,conflicts=o!=c))+'\n')
        tail={}; bins={}
        for method in bymethod:
            if method=='inside-polygon': continue
            n=bymethod[method]; q={}
            for percentile in [0,50,90,95,99,100]:
                idx=max(0,math.ceil(n*percentile/100)-1); q['p'+str(percentile)]=db.execute('select distance from plan where method=? order by distance limit 1 offset ?',(method,idx)).fetchone()[0]
            tail[method]=q; bins[method]={str(th):db.execute('select count(*) from plan where method=? and distance>?',(method,th)).fetchone()[0] for th in [100,1000,5000,20000,50000]}
        report={'version':1,'completedUtc':utc(),'mapping':{'rows':seen,'uniquePanoids':seen,'missing':0,'duplicatePanoids':0,'idEqualsAdcode':True,'synthetic659900':0,'sha256':datahash.hexdigest(),'bytes':total_bytes,'codesReceivingPoints':len(bycity),'byMethod':bymethod,'byCity':dict(sorted(bycity.items()))},'methodology':{'scope':'Geometric administrative attribution only, not official jurisdiction, entrance, imagery, navigation or classification confirmation. No polygon originals are published.','metric':'BD-09 to GCJ-02; ray crossing on unsimplified source rings (including holes, MultiPolygons). Distance in metres to the actual closest ring segment, including ends, using query-latitude equirectangular kx=111320*cos(lat), ky=110540. Inside distance=0 (to area, not to its edge). Approximate local metres, not geodesic cadastral accuracy.','order':'Unique covering city; overlapping polygons: nearest edge among all covering cities; no covering city: nearest edge among all 370. No distance cutoff. Overlap lists every containing area; exterior lists the closest three distinct codes plus ties. Equal within 1 micrometre breaks by lowest adcode. Candidate distances rounded to 0.01 m after selection.','historicalConflict':'Legacy limited-coverage decisions and existing archive owner are audit evidence only, not authoritative; conflicts.jsonl references each competing artifact family, method and distance.','verification':'Exact input SHA, ZIP member set, and per-file counts vs original bytes and independent prior ledger; SQLite primary key fails on any repeated panoid. One mapping line is written from each successfully inserted input record, with post-write SHA crosscheck. One province body or input row at a time; nationwide derived geometry only, no national archive rescan.'},'inputs':source,'boundaryManifest':{'file':MANIFEST,'sha256':sha(out/MANIFEST),'areas':len(a.areas),'coverageProvinceLevelUnits':34},'existingArchive':ownerInfo,'historicalComparisons':disagreements,'distanceMeters':{'quantilesNearestRank':tail,'strictlyOverThresholdCounts':bins,'largest30':[dict(distance=d,panoid=pid,input=s,id=c,method=m) for d,pid,s,c,m in sorted(top,reverse=True)]},'seconds':round(time.monotonic()-tstart,3)}
        write_json(Path(tmp)/'quality.json',report); (Path(tmp)/'mapping.jsonl').replace(out/'mapping.jsonl'); (Path(tmp)/'quality.json').replace(out/'quality.json')
    print('complete',seen,datahash.hexdigest(),flush=True)

def verify(downloads, *, purge=False):
    """Transport/identity audit, no second geometry calculation or archive scan."""
    import itertools
    out=OUT; report=json.loads((out/'quality.json').read_bytes()); m=json.loads((out/MANIFEST).read_bytes()); ids={a['id']:(a['name'],s['province'],s['url']) for s in m['sources'] for a in s.get('areas',[])}; catalog=json.loads((ROOT/'data/catalog.json').read_bytes()); absent=[c for c in catalog['collections'] if c['id'] in {'659011','659012'} and c['id'] not in ids]; flagged=collections.defaultdict(list); count=0; methods=collections.Counter(); h=hashlib.sha256(); nnear=0; namb=0; zero=0; schema={'panoid','id','adcode','name','province','method','distance','source'}
    with (out/'mapping.jsonl').open('rb') as mapping:
        for entry in report['inputs']['files']:
            p=(ROOT/'dist/external-upload-audit-20261126' if entry['container'] else downloads)/entry['file']; require(sha(p)==entry['sha256'],'verified input changed'); n=0
            with p.open(encoding='utf-8-sig') as f:
                for source in JsonReader(f).array_doc():
                    line=mapping.readline(16385); require(len(line)<=16384 and line.endswith(b'\n'),'missing, truncated, or oversized mapping row'); h.update(line); row=json.loads(line); code=row['id']; met=row['method']; d=row['distance']; require(row['panoid']==source['panoId'] and code==row['adcode'] and code!='659900' and ids[code]==(row['name'],row['province'],row['source']),'mapping identity/area mismatch'); require(met in {'inside-polygon','overlap-nearest-boundary','nearest-boundary'} and math.isfinite(d) and d>=0,'invalid method/distance'); n+=1; count+=1; methods[met]+=1
                    if met=='inside-polygon': require(set(row)==schema and d==0,'inside schema')
                    else:
                        require(set(row)==schema|{'candidates'},'candidate schema'); cs=row['candidates']; require(cs[0]['id']==code and cs[0]['distance']==d and len(cs)==len({c['id'] for c in cs}) and all(ids[c['id']][0]==c['name'] and c['distance']>=d for c in cs),'invalid candidates')
                        if met=='nearest-boundary': require(len(cs)>=3,'exterior lacks alternatives'); nnear+=1
                        else: require(len(cs)>=2,'overlap lacks alternatives'); namb+=1
                    for c in absent:
                        if hits(c['bounds'],source['lng'],source['lat']): flagged[c['id']].append({'panoid':row['panoid'],'id':code})
            require(n==entry['rows'],'file count mismatch'); zero+=int(n==0)
        require(not mapping.read(1),'trailing mapping rows')
    require(methods==report['mapping']['byMethod'] and count==report['mapping']['uniquePanoids']==255422 and h.hexdigest()==report['mapping']['sha256'],'final mapping mismatch')
    note={'snapshotMissingCodes':['659011','659012'],'note':'DataV 650000_full has no separate shapes for XinXing or BaiYang. Searched project config/osm-counties, dist/osm-counties-direct, dist/boundary-fetch-isolated-20261126/config/osm-counties, config/scanner-boundaries and dist/refsite/boundaries: no separately coded traceable shape found for either. The archived 659012 point envelope is not a city polygon; absent a jurisdiction boundary, matching nearby upload points to 659012 would not be justified. The envelope check cannot establish absence of all affected points. No later legal-boundary or nationwide currency claim.','catalogSnapshotSha256':report['existingArchive']['catalogSha256'],'archivedMissingAreaEnvelopes':[{'id':c['id'],'name':c['name'],'archivedCount':c['count'],'boundsBD09':c['bounds'],'incomingPointsInsideArchivalPointEnvelope':len(flagged[c['id']]),'examples':flagged[c['id']][:10]} for c in absent]}
    summ={'verifiedUtc':utc(),'checkedRows':count,'checkedFiles':len(report['inputs']['files']),'zeroRowFiles':zero,'mappingSha256':h.hexdigest(),'rowOrderAndPanoidEqualToOriginal':True,'newPlanSourceURLsAndCodesVerified':True,'nearestRowsWithAtLeastThreeCandidates':nnear,'overlapsWithAllCandidatesAtLeastTwo':namb,'boundaryManifestSha256':sha(out/MANIFEST),'conflictFileSha256':sha(out/'conflicts.jsonl'),'existingOwnersFileSha256':sha(out/'existing-owners.jsonl'),'note':'Rows compared in original source order; every serialized source id matches, with unique primary key already checked at generation. Geometry not recomputed.'}
    report['snapshotMissingAreas']=note; report['finalTransportVerification']=summ; write_json(out/'quality.json',report)
    if purge:
        private=(out/'_private').resolve(); require(private==OUT.resolve()/'_private' and not private.is_symlink(),'unexpected private cache path'); allowed={s['file'] for s in m['sources']}|{s['file'][:-5]+'.receipt' for s in m['sources']}
        if private.exists():
            require({p.name for p in private.iterdir()}==allowed,'refusing to purge unfamiliar files');
            for name in sorted(allowed):
                target=private/name; require(target.resolve()==private/name and target.is_file() and not target.is_symlink(),'unexpected purge target'); target.unlink()
            private.rmdir()
    print(packed(summ),flush=True)

if __name__ == '__main__':
    ap=argparse.ArgumentParser(description=__doc__); ap.add_argument('command',choices=['fetch','build','verify']); ap.add_argument('--downloads',type=Path,default=Path('D:/Downloads')); ap.add_argument('--purge',action='store_true',help='after verify, delete only the 35 attested private geometry snapshots and receipts'); args=ap.parse_args()
    if args.command=='fetch':
        require(not (OUT/'quality.json').exists(),'cannot replace snapshot for a completed deliverable'); fetch(OUT)
    elif args.command=='build': build(args.downloads)
    else: verify(args.downloads,purge=args.purge)
