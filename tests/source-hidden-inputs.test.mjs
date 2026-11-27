import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const prelude=`import io, sqlite3, json, sys\nsys.path.insert(0,'tools')\nimport index_source_hidden as a\n`;
function py(body){
  const result=spawnSync(process.env.PYTHON||'python',['-B','-X','utf8','-c',prelude+body],{cwd:root,encoding:'utf8'});
  if(result.error) throw result.error;
  assert.equal(result.status,0,result.stderr||result.stdout);
}

test('only a primary object’s own literal booleans enter flags; contradictory evidence remains by source',()=>py(String.raw`
db=sqlite3.connect(':memory:'); db.executescript('create table flags(pid,flag,source,sha);create table nonboolean(pid,value_json,source,sha)')
f={'source':'one','sha256':'hash1','counts':a.blank(),'bySourceType':{}}
for flag in (True,False,1,0,'true','false',None,{},[]): a.record(db,f,dict(panoId='a',id='a',sid='a',isHidden=flag))
a.record(db,f,{'id':'b','sourceType':'hidden','timeLine':[{'id':'child','isHidden':True}],'extra':{'isHidden':True}})
a.record(db,f,['c',0,0,'','','',1,True,'baidu_pano'])
assert f['counts']==dict(true=1,false=1,missing=2,nonboolean=7)
g={'source':'two','sha256':'hash2','counts':a.blank(),'bySourceType':{}}
a.record(db,g,{'id':'a','isHidden':False})
assert db.execute('select * from flags order by rowid').fetchall()==[('a',1,'one','hash1'),('a',0,'one','hash1'),('a',0,'two','hash2')]
assert db.execute('select value_json from nonboolean').fetchall()==[(v,) for v in ['1','0','"true"','"false"','null','{}','[]']]
assert f['bySourceType']['"hidden"']['missing']==1
for row in ({'id':'a','sid':'b','isHidden':True},{'timeLine':[{'id':'x'}],'isHidden':True},['a',0,0,'','',0,0,0,'baidu',{'isHidden':True}]):
 try: a.fields(row)
 except ValueError: pass
 else: raise AssertionError(row)
`));

test('detect JSON escapes and chunk-split key bytes; stream and validate wrappers without treating their metadata as records',()=>py(String.raw`
a.CHUNK=7
buf=br'{"ignored":{"isHidden":true,"id":"bad"},"points":[{"panoId":"p","is\u0048idden":true}],"tail":false}'
assert [a.fields(r)[:2] for r in a.Reader(io.BytesIO(buf)).rows()]==[('p','true')]
for token in (b'isHidden',b'sourceType',br'\u',b'\x00'):
 chunk=b' '*(1024*1024-1)+token
 assert not a.fingerprint(lambda:io.BytesIO(chunk),scan=True)['safeAbsent']
assert a.fingerprint(lambda:io.BytesIO(b' '*((1<<20)-3)+b'"panoId":"a","panoId":"b"'),scan=True)['pidKeyTokens']==2
for raw in (b'[{"id":"p","isHidden":false,"isHidden":true}]',b'{"rows":[],"points":[]}',b'[{"id":"p"}]garbage',b'[{"id":"p"},]'):
 try: list(a.Reader(io.BytesIO(raw)).rows())
 except ValueError: pass
 else: raise AssertionError(raw)
`));

test('source SHA gate and clean JSON-only nine-field native wrapper',()=>py(String.raw`
raw=b'window.PANO_CITY=window.PANO_CITY||{};window.PANO_CITY["820000"]=[["p",0,0,"","",0,1,1,"baidu_pano"]];'
assert a.fields(next(a.Reader(io.BytesIO(raw)).rows(js_city='820000')))[:2]==('p','missing')
try: list(a.Reader(io.BytesIO(raw+b'eval(0)')).rows(js_city='820000'))
except ValueError: pass
else: raise AssertionError('accepted executable trailer')
assert a.fingerprint(lambda:io.BytesIO(b'[]'))['sha256']=='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
`));
