import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The production computation uses only Python's standard library. Use -B: these tests do not write project files.
const cwd = fileURLToPath(new URL('..', import.meta.url));
function verify(script) {
  const head = String.raw`import sys, math, io, random
sys.path.insert(0, 'tools')
import crawler_city_plan as g
from crawler_city_plan import Area, Atlas, JsonReader

def area(code, rings):
    return Area({'properties':{'adcode':code, 'name':code},'geometry':{'type':'MultiPolygon','coordinates':rings}}, {'province':'test','url':'fixture'})

def box(x,y,w=1,h=1): return [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]
`;
  const r = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-c', head + '\n' + script], { cwd, encoding: 'utf8' });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr || r.stdout);
}

test('national plan: holes, islands, overlaps and shared boundaries are explicit; no fallback bucket or hard cutoff', () => verify(String.raw`
a=area('100001',[[box(0,0,3,3),box(.5,.5,.25,.25)],[box(8,8)]])
b=area('100002',[[box(2,0,2,2)]])
c=area('100003',[[box(5,0)]])
d=area('100004',[[box(6,0)]])
s=Atlas([d,b,c,a]); assert s.assign(8.4,8.4)[0]==a
assert s.assign(.6,.6)[1]=='nearest-boundary' # in the hole, not in the polygon
assert s.assign(.5,.6)[1]=='inside-polygon' # edge of hole covered by area
city,method,dist,candidates=s.assign(2.1,1)
assert city==b and method=='overlap-nearest-boundary' and {v['id'] for v in candidates}=={a.code,b.code}
city,method,dist,candidates=s.assign(6,.5)
assert city==c and method=='overlap-nearest-boundary' and dist==0 and len(candidates)==2
city,method,dist,candidates=s.assign(30,30)
assert method=='nearest-boundary' and dist>50000 and len(candidates)==3 and candidates[0]['id']==city.code
assert s.assign(.1,.1)[1:] == ('inside-polygon',0,None)
`));

test('national plan: pruning preserves exact nearest segment order in the declared metric', () => verify(String.raw`
r=random.Random(17); areas=[area(str(100000+i),[[box(i*1.1,30+i*.5,.8,2)]]) for i in range(12)]
s=Atlas(areas)
for _ in range(80):
    x,y=r.uniform(-2,14),r.uniform(24,29.9); kx=111320*math.cos(math.radians(y))
    def reference(a):
        pts=a.polys[0][0].pts; return min(g.seg2(x,y,kx,u,v)**.5 for u,v in zip(pts,pts[1:]))
    expected=sorted((reference(a),a.code) for a in areas)
    city,m,d,candidates=s.assign(x,y)
    assert m=='nearest-boundary' and city.code==expected[0][1] and d==round(expected[0][0],2)
    assert [c['id'] for c in candidates]==[e[1] for e in expected[:3]]
`));

test('national plan: incremental decoder handles split UTF-8 text tokens and rejects malformed/trailing records', () => verify(String.raw`
g.CHUNK=5
assert list(JsonReader(io.StringIO('[{"name":"中文","q":"a]b}\\\""},{"v":-12345.6789e-08},null]')).array_doc())[1]=={'v':-12345.6789e-08}
assert list(JsonReader(io.StringIO('{"assignments": [{"id":"example"}], "summary":{"n":1}}')).array_doc(True))==[{'id':'example'}]
assert list(JsonReader(io.StringIO('{"one":{"name":"珠海"},"two":{}}')).members())==[('one',{'name':'珠海'}),('two',{})]
for doc in ['[],1', '[{},', '[1 2]','[{"a":"b"]']:
    try: list(JsonReader(io.StringIO(doc)).array_doc())
    except ValueError: pass
    else: assert False,doc
`));
