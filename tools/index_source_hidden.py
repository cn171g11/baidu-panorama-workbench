"""Offline, SHA-gated audit of registered original uploads. Never reads public flags.
Usage: python -B tools/index_source_hidden.py (stdlib only, Python 3.11+).
All outputs are private dist files. No row cache, SQLite holds only explicit flags.
"""
from __future__ import annotations
import argparse, collections, contextlib, gzip, hashlib, io, json, os, re, sqlite3, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist/source-hidden-20261127/inputs'
REG = ROOT / 'data/imports/source-summary.json'
KINDS = ('true', 'false', 'missing', 'nonboolean')
CHUNK = 65536
MAX = 1024 * 1024
ABSENT = object()
WRAPPERS = {'points', 'customCoordinates', 'rows', 'records', 'data', 'entries'}


def strict(pairs):
    obj = dict(pairs)
    if len(obj) != len(pairs): raise ValueError('duplicate JSON key')
    return obj


class Reader:
    """Incremental JSON grammar for top-level array or single record-array wrapper."""
    def __init__(self, stream):
        self.f = io.TextIOWrapper(stream, encoding='utf-8-sig', newline='')
        self.buf = ''; self.i = 0; self.decoder = json.JSONDecoder(object_pairs_hook=strict)

    def refill(self):
        chunk = self.f.read(CHUNK)
        self.buf = self.buf[self.i:] + chunk; self.i = 0
        return bool(chunk)

    def peek(self):
        while True:
            while self.i < len(self.buf):
                c = self.buf[self.i]
                if c not in ' \r\n\t': return c
                self.i += 1
            if not self.refill(): return ''

    def eat(self, ch):
        if self.peek() != ch: raise ValueError(f'expected {ch!r}')
        self.i += 1

    def value(self):
        self.peek()
        while True:
            try: x, end = self.decoder.raw_decode(self.buf, self.i)
            except json.JSONDecodeError:
                if len(self.buf) - self.i > MAX or not self.refill(): raise
                continue
            if end == len(self.buf) and self.refill(): continue
            if end-self.i > MAX: raise ValueError('record exceeds bound')
            self.i = end
            return x

    def array(self):
        self.eat('[')
        if self.peek() != ']':
            while True:
                yield self.value()
                if self.peek() != ',': break
                self.eat(',')
        self.eat(']')

    def rows(self, js_city=None):
        if js_city:
            prefix = f'window.PANO_CITY=window.PANO_CITY||{{}};window.PANO_CITY["{js_city}"]='
            self.refill()
            if not self.buf.startswith(prefix): raise ValueError('unexpected JS wrapper')
            self.i = len(prefix)
        if self.peek() == '[': yield from self.array()
        else:
            self.eat('{'); used = False; keys=set()
            while True:
                k = self.value(); self.eat(':')
                if type(k) is not str or k in keys: raise ValueError('invalid/duplicate wrapper key')
                keys.add(k)
                if k in WRAPPERS:
                    if used: raise ValueError('ambiguous record arrays')
                    yield from self.array(); used = True
                else: self.value()
                if self.peek() != ',': break
                self.eat(',')
            self.eat('}')
            if not used: raise ValueError('missing record array')
        if js_city and self.peek() == ';': self.eat(';')
        if self.peek(): raise ValueError('trailing data')


def hashfile(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def fingerprint(opener, scan=False):
    """Prove absence even across block boundaries; escaped keys or non-UTF8-shaped bytes force parse."""
    h = hashlib.sha256(); size=0; tail=b''; safe=True; tokens=0
    with opener() as f:
        while block := f.read(1024*1024):
            h.update(block); size+=len(block)
            if scan:
                probe=tail+block
                if any(key in probe for key in (b'isHidden', b'sourceType', b'\\u', b'\x00')): safe=False
                token=b'"panoId":'; tokens += probe.count(token)-tail.count(token)
                tail=probe[-12:]
    return {'sha256':h.hexdigest(),'bytes':size,'safeAbsent':safe,'pidKeyTokens':tokens}


def tag(value):
    if value is ABSENT: return '<missing>'
    return json.dumps(value, ensure_ascii=False, separators=(',',':'),sort_keys=True)


def fields(row):
    if isinstance(row,list):
        if len(row)!=9 or row[8] not in ('baidu','baidu_pano','baidu_road_member'): raise ValueError('not a dedicated nine-field Baidu row')
        pid=row[0]; typ=flag=ABSENT
    else:
        if not isinstance(row,dict): raise ValueError('record must be an object')
        ids=[row[k] for k in ('panoId','panoid','id','sid','pid') if k in row]
        if not ids or any(p != ids[0] for p in ids): raise ValueError('missing or conflicting primary ID aliases')
        pid=ids[0]; typ=row.get('sourceType',ABSENT); flag=row.get('isHidden',ABSENT)
    if type(pid) is not str or not pid or pid.strip()!=pid: raise ValueError('invalid primary panoid')
    kind='missing' if flag is ABSENT else 'true' if flag is True else 'false' if flag is False else 'nonboolean'
    return pid,kind,typ,flag


def blank(): return {k:0 for k in KINDS}


def add(d,kind,typ,n=1):
    d['counts'][kind]+=n
    key=tag(typ); d['bySourceType'].setdefault(key,blank())[kind]+=n


def record(db,d,row):
    pid,kind,typ,flag=fields(row); add(d,kind,typ)
    if kind in ('true','false'):
        db.execute('INSERT INTO flags VALUES(?,?,?,?)',(pid,int(flag),d['source'],d['sha256']))
    elif kind=='nonboolean':
        db.execute('INSERT INTO nonboolean VALUES(?,?,?,?)',(pid,tag(flag),d['source'],d['sha256']))


def dump(path,obj):
    path.write_text(json.dumps(obj,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')


def run(downloads,registry=REG,out=OUT):
    regbytes=registry.read_bytes(); regsha=hashlib.sha256(regbytes).hexdigest(); registry_obj=json.loads(regbytes)
    fs=registry_obj['files']; names=collections.Counter(x['name'] for x in fs)
    assert len(fs)==registry_obj['sourceFiles']==403
    out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out,prefix='.build-') as td, contextlib.ExitStack() as stack:
        tmp=Path(td); dbfile=tmp/'source-flags.sqlite'; db=sqlite3.connect(dbfile)
        stack.callback(db.close)
        db.executescript('PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; CREATE TABLE flags(pid TEXT NOT NULL,flag INTEGER NOT NULL CHECK(flag IN (0,1)),source TEXT NOT NULL,sha TEXT NOT NULL); CREATE TABLE nonboolean(pid TEXT,value_json TEXT,source TEXT,sha TEXT); CREATE TABLE files(idx INTEGER PRIMARY KEY,source TEXT UNIQUE,sha TEXT,name TEXT,city TEXT,ledger_json TEXT);')
        docs=[]
        for i,f in enumerate(fs):
            name=f['name']; identity=name if names[name]==1 else name+'#city='+f['city']
            docs.append({'descriptorIndex':i,'source':identity,'registered':f,'sourceName':name,'counts':blank(),'bySourceType':{},'status':'pending'})
        ars={}; archive_notes=[]
        for n in ('百度11.23.zip','11.24.zip','11.25.zip'):
            p=downloads/n
            if not p.is_file(): continue
            z=stack.enter_context(zipfile.ZipFile(p)); digest=hashfile(p)
            if len(z.namelist())!=len(set(z.namelist())): raise ValueError('ambiguous ZIP member')
            ars[n]=(p,z,digest); archive_notes.append({'path':str(p),'sha256':digest,'membersNotRegistered':[m for m in z.namelist() if m not in names]})
        xjgroups={d['registered']['city']:d for d in docs if names[d['sourceName']]>1}; xjdone=False
        def stamp(d,fp,loc,method):
            f=d['registered']
            if fp['sha256']!=f['sha256'] or fp['bytes']!=f['bytes']: raise ValueError('source fingerprint mismatch: '+f['name'])
            d.update(sha256=fp['sha256'],bytes=fp['bytes'],location=loc,method=method,status='verified')
        # First parse flagged files; scan nationwide originals last. SHA, not the batch, gates each body.
        order=sorted(range(len(docs)),key=lambda i:(0 if i in (272,286,289,401,402) else 1 if 'crawler-results' in fs[i]['name'] or fs[i].get('vehicleId')=='border-v1' else 3 if '位置' in fs[i]['name'] or 'locations' in fs[i]['name'] else 2,i))
        for i in order:
            d=docs[i]; f=fs[i]; n=f['name']; path=None; z=None; arc=None; opener=None
            if n=='baidu-xinjiang-20261025/points.json':
                if xjdone: continue
                xjdone=True; path=ROOT/'sources'/n
            elif f.get('sourceFormat')=='overseas-converted-json': path=ROOT/'dist/overseas-batches'/n
            elif '位置' in n or ' locations)' in n: path=downloads/'baidu china json/baidu china json'/n
            else:
                possible=[(k,v) for k,v in ars.items() if n in v[1].namelist()]
                if len(possible)>1: raise ValueError('ambiguous archive source')
                if possible:
                    arc,(path,z,digest)=possible[0]; loc=str(path)+'!/'+n; opener=lambda z=z,n=n:z.open(n)
                    if f.get('sourceZipSha256',digest)!=digest: raise ValueError('ZIP fingerprint mismatch')
                    d['containerSha256']=digest
                else: path=downloads/n
            if opener is None:
                loc=str(path); opener=lambda p=path:p.open('rb')
                if not path.is_file():
                    for entry in (xjgroups.values() if names[n]>1 else [d]): entry.update(status='unavailable',attempted=loc)
                    continue
            nationwide=path.parent.name=='baidu china json'
            fp=fingerprint(opener,scan=nationwide)
            if (fp['sha256'],fp['bytes'])!=(f['sha256'],f['bytes']):
                d['rejectedCandidate']={'location':loc,'sha256':fp['sha256'],'bytes':fp['bytes']}
                alt=downloads/n
                if not z or not alt.is_file() or f.get('sourceZipSha256'):
                    d.update(status='fingerprint-mismatch',attempted=loc); continue
                path=alt; loc=str(path); opener=lambda p=path:p.open('rb'); fp=fingerprint(opener); d.pop('containerSha256',None)
            stamp(d,fp,loc,'stream-parse-own-fields')
            if names[n]>1:
                # The original has one row per ID, while the ledger splits it into 13 descriptors.
                mapping=ROOT/'dist/xinjiang-migration/assignment.json'; db.execute('CREATE TEMP TABLE assignments(pid TEXT PRIMARY KEY,city TEXT,seen INTEGER DEFAULT 0)')
                with mapping.open('rb') as inp:
                    for a in Reader(inp).rows(): db.execute('INSERT INTO assignments(pid,city) VALUES(?,?)',(a['panoid'],a['cityId']))
                for entry in xjgroups.values():
                    stamp(entry,fp,loc,'shared-original + verified ID assignment'); entry['assignmentSha256']=hashfile(mapping); entry['assignment']=str(mapping)
                with opener() as inp:
                    for r in Reader(inp).rows():
                        pid=fields(r)[0]; city=db.execute('UPDATE assignments SET seen=1 WHERE pid=? AND seen=0 RETURNING city',(pid,)).fetchone()
                        if not city: raise ValueError('unmapped/duplicate Xinjiang primary ID')
                        record(db,xjgroups[city[0]],r)
                if db.execute('SELECT COUNT(*) FROM assignments WHERE seen=0').fetchone()[0]: raise ValueError('unseen Xinjiang assignments')
            elif n=='baidu-supplement-20261123.zip':
                d['members']=[]; d['method']='city point shards + separate historical_reference JSONL; vehicle mirrors and embedded timelines excluded'
                with zipfile.ZipFile(path) as z:
                    raw_names=z.namelist(); manifest=json.loads(z.read('supplement-manifest.json')); expected=set()
                    if len(raw_names)!=len(set(raw_names)): raise ValueError('duplicate member')
                    for city in manifest['cities']:
                        base='cities/'+city['adcode']+'/'
                        for kind,partnames,count in [('primary',[base+f'points-{part:04d}.json.gz' for part in range(1,city['parts']+1)],city['primary']),('historical_reference',[base+'time-machine.jsonl.gz'] if city['historicalReferences'] else [],city['historicalReferences'])]:
                            total=0
                            for name in partnames:
                                expected.add(name); keyhash=fingerprint(lambda:z.open(name)); countpart=0
                                with z.open(name) as zipped,gzip.GzipFile(fileobj=zipped) as raw:
                                    if kind=='primary': rows=Reader(raw).rows()
                                    else:
                                        def lines():
                                            while line:=raw.readline(MAX+1):
                                                if len(line)>MAX: raise ValueError('oversized history record')
                                                r=json.loads(line,object_pairs_hook=strict)
                                                if r.get('kind')!='historical_reference': raise ValueError('unexpected history shape')
                                                yield r
                                        rows=lines()
                                    for r in rows: record(db,d,r); countpart+=1
                                total+=countpart; d['members'].append(dict(member=name,sha256=keyhash['sha256'],bytes=keyhash['bytes'],rows=countpart,role=kind))
                            if total!=count: raise ValueError('member primary/history count mismatch')
                    if expected!={a for a in raw_names if re.fullmatch(r'cities/\d{6}/(?:points-\d+\.json|time-machine\.jsonl)\.gz',a)}: raise ValueError('unaccounted source shards')
            elif nationwide and fp['safeAbsent'] and n!='珠海市（100000 个位置）.json' and fp['pidKeyTokens']==f['rawRecords']:
                d['method']='matched SHA; entire bytes lack isHidden, sourceType, Unicode escapes and NUL; exact panoId key token count agrees with registration'
                add(d,'missing',ABSENT,fp['pidKeyTokens'])
            else:
                js=f.get('sourceFormat')=='PANO_CITY-json-array'; total=0
                with opener() as inp:
                    for r in Reader(inp).rows(js_city=f['city'] if js else None):
                        total+=1
                        if n=='data_820000.js' and not fields(r)[0].startswith('090107'):
                            if not fields(r)[0].startswith('090063') or fields(r)[1]!='missing': raise ValueError('unexpected Macau excluded row')
                            continue
                        record(db,d,r)
                if n=='data_820000.js':
                    if total!=f['sourceRawRecords'] or total-sum(d['counts'].values())!=f['excludedRecords']: raise ValueError('Macau subgroup mismatch')
                    d.update(physicalRows=total,excludedOriginalRows=f['excludedRecords'],subsetEvidence='docs/macau-import-20261117.md:5-15; retained 090107, excluded 090063')
                if n=='珠海市（100000 个位置）.json':
                    if (total,f['rawRecords'])!=(100000,102720): raise ValueError('unrecognized Zhuhai reconciliation')
                    d.update(physicalRows=total,registeredRowsNotInThisOriginal=2720,subsetEvidence='docs/macau-import-20261117.md:5-15; 2720 transferred from Macau; not original rows of this city JSON')
            db.commit()
            if i in (272,402,331) or (nationwide and i%50==0): print('verified',i,n,d['counts'],flush=True)
        # Project provenance explicitly names an upstream source for all overseas derived files. Verify separately and do not duplicate its flags.
        upstream=downloads/'overseas_metadata_full_v2.json'; up={'path':str(upstream),'status':'unavailable'}
        if upstream.is_file():
            sha=hashfile(upstream); expected={f['upstreamSha256'] for f in fs if 'upstreamSha256' in f}; assert expected=={sha}
            dist=blank(); upstream_ids=set()
            with upstream.open('rb') as raw:
                for row in Reader(raw).rows():
                    pid,k,_,_=fields(row); dist[k]+=1; upstream_ids.add(pid)
            if sum(dist.values())!=len(upstream_ids) or dist['missing']!=len(upstream_ids): raise ValueError('overseas upstream needs ID-scoped review')
            # The upstream is small; prove exact ID identity across the registered converted partitions.
            registered_ids=set()
            for d in docs:
                if 'upstreamSha256' not in d['registered'] or d['status']!='verified': continue
                with Path(d['location']).open('rb') as raw:
                    for row in Reader(raw).rows():
                        pid=fields(row)[0]
                        if pid in registered_ids: raise ValueError('duplicate overseas PID')
                        registered_ids.add(pid)
            if not registered_ids<=upstream_ids: raise ValueError('overseas primary IDs not in true upstream')
            up.update(status='verified',sha256=sha,counts=dist,matchedRegisteredIds=len(registered_ids),upstreamOnlyIds=len(upstream_ids-registered_ids))
        absent=[]; exceptions=[]; totals=blank(); combinations={}
        for d in docs:
            f=d['registered']; idx=d['descriptorIndex']; rowcount=sum(d['counts'].values()); declared=f['rawRecords']
            if d['status']!='verified':
                absent.append(d['source']); d['counts']=None; d['bySourceType']=None
            else:
                if rowcount+d.get('registeredRowsNotInThisOriginal',0)!=declared: raise ValueError(f'row count mismatch #{idx}: {rowcount} vs {declared}, {d["source"]}')
                for k in KINDS: totals[k]+=d['counts'][k]
                for t,c in d['bySourceType'].items():
                    accum=combinations.setdefault(t,blank())
                    for k in KINDS: accum[k]+=c[k]
                if f.get('sourceRecordSubset') or d.get('registeredRowsNotInThisOriginal'): exceptions.append(d['source'])
            db.execute('INSERT INTO files VALUES(?,?,?,?,?,?)',(idx,d['source'],d.get('sha256'),f['name'],f.get('city'),json.dumps(d,ensure_ascii=False)))
        db.executescript('CREATE INDEX flags_pid ON flags(pid,flag); CREATE INDEX flags_source ON flags(source,sha); CREATE INDEX nonboolean_pid ON nonboolean(pid);')
        conflictrows=[]
        for pid, in db.execute('SELECT pid FROM flags GROUP BY pid HAVING min(flag)<>max(flag) ORDER BY pid'):
            values=[dict(source=s,sha=h,flag=k,rows=c) for s,h,k,c in db.execute('SELECT source,sha,flag,count(*) FROM flags WHERE pid=? GROUP BY source,sha,flag ORDER BY source,flag',(pid,))]; conflictrows.append(dict(pid=pid,evidence=values))
        verified=len(docs)-len(absent); distinct={str(k):n for k,n in db.execute('SELECT flag,count(DISTINCT pid) FROM flags GROUP BY flag')}; sql_counts=dict(db.execute('SELECT flag,count(*) FROM flags GROUP BY flag'))
        if sql_counts.get(1,0)!=totals['true'] or sql_counts.get(0,0)!=totals['false']: raise ValueError('flags totals differ from source ledger')
        if db.execute('SELECT count(*) FROM nonboolean').fetchone()[0]!=totals['nonboolean'] or db.execute('PRAGMA integrity_check').fetchone()!=('ok',): raise ValueError('database integrity/count mismatch')
        db.commit(); db.close()
        filespath=tmp/'files-ledger.json'; conflicts=tmp/'conflicts.json'; receipt=tmp/'source-flags-receipt.json'; dump(filespath,docs); dump(conflicts,conflictrows)
        final=dict(schemaVersion=1,complete=not absent,registeredDescriptors=len(fs),verifiedDescriptors=verified,registeredDistinctSourceNames=len(names),sourceSummarySha256=regsha,databaseSha256=hashfile(dbfile),filesLedgerSha256=hashfile(filespath),conflictsSha256=hashfile(conflicts),counts=totals,bySourceType=combinations,registeredRawRecords=sum(f['rawRecords'] for f in fs),registeredOriginalRowsAudited=sum(totals.values()),conflictIds=len(conflictrows),distinctTrueIds=distinct.get('1',0),distinctFalseIds=distinct.get('0',0),unavailableSources=absent,subsetExceptions=exceptions,zipContainers=archive_notes,overseasUpstream=up,scope='Exact registered input rows only. Original object own isHidden boolean; no array slots, tags, inferred classifications, vehicle mirrors or nested IDs. sourceType labels use JSON literal encoding; <missing> is absence. Nonboolean values in separate table. Original rows differ from register by the 2720 cross-source transfers documented in files ledger.')
        dump(receipt,final)
        if hashfile(registry)!=regsha: raise ValueError('registration changed during audit')
        if absent:
            for p in (filespath,receipt): os.replace(p,out/('incomplete-'+p.name))
            raise FileNotFoundError(f'{len(absent)} unverified descriptors (see incomplete receipt)')
        for p in (dbfile,filespath,conflicts,receipt): os.replace(p,out/p.name)
        return final


if __name__=='__main__':
    args=argparse.ArgumentParser(); args.add_argument('--downloads',type=Path,default=Path('D:/Downloads'))
    result=run(args.parse_args().downloads); print(json.dumps({k:result[k] for k in ('complete','verifiedDescriptors','counts','conflictIds','databaseSha256')},ensure_ascii=False))
