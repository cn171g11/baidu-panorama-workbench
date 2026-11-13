import { baiduPanoramaUrl } from '../city-viewer/js/metadata.js';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
// Public website integration test: exercise the real official page, not just a URL assertion.
// Does not export auth tokens, cookies, private profiles, or downloaded imagery.
const out=path.resolve(process.argv[2]||'dist/official-links-'+Date.now());
if(!out.startsWith(path.resolve('dist')+path.sep))throw Error('Output must be a dist child');
await mkdir(out,{recursive:true});const profile=await mkdtemp(path.join(out,'profile-'));
let browser,socket,n=0;const pending=new Map(),events=[];let current='';const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function send(method,params={}){const id=++n;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},45000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}
const rows=JSON.parse(await readFile('data/baidu/371600/points-001.json','utf8'));
const regular=JSON.parse(await readFile('data/baidu/440300/points-001.json','utf8'))[0];
const hidden=rows.find(r=>r[9]?.sourceType==='hidden');
const cases=[{name:'ordinary-no-mercator',row:regular,metadata:{heading:regular[5]}},{name:'hidden',row:hidden,metadata:{...hidden[9],heading:hidden[5]}},{name:'neighbor-id-only',row:[hidden[9].timeLine.find(id=>id!==hidden[0])],metadata:{}}];
const results=[];
try{
 browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];break;}catch{await sleep(100);}}if(!port)throw Error('Browser did not start');
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 socket.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Network.responseReceived'){const r=m.params.response,u=new URL(r.url);if(u.hostname.endsWith('.bdimg.com')&&['sdata','pdata'].includes(u.searchParams.get('qt')))events.push({case:current,kind:u.searchParams.get('qt'),sid:u.searchParams.get('sid'),status:r.status,mime:r.mimeType});}});
 await send('Page.enable');await send('Network.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 for(const item of cases){current=item.name;const pid=item.row[0],url=baiduPanoramaUrl(pid,item.metadata);await send('Page.navigate',{url});let state;
   const deadline=Date.now()+65000;
   do {await sleep(600);state=await evaluate(`(()=>{const el=document.querySelector('#pano-container');const r=el?.getBoundingClientRect();return {href:location.href,panoVisible:!!r&&r.width>300&&r.height>300,hasReturn:!!document.body?.innerText.includes('返回地图'),canvases:[...document.querySelectorAll('#pano-container canvas')].filter(e=>e.width>0&&e.height>0).length};})()`);
   }while(Date.now()<deadline&&!(state.panoVisible&&state.hasReturn&&state.canvases>0&&new URLSearchParams(new URL(state.href).hash.slice(1)).get('panoid')===pid&&events.some(e=>e.case===current&&e.sid===pid&&e.kind==='pdata'&&e.status===200)));
   const panoid=new URLSearchParams(new URL(state.href).hash.slice(1)).get('panoid');
   const observations=events.filter(e=>e.case===current&&e.sid===pid);
   const passed=state.panoVisible&&state.hasReturn&&state.canvases>0&&panoid===pid&&observations.some(e=>e.kind==='pdata'&&e.status===200);
   const result={name:current,pid,url,state,responses:observations,passed};results.push(result);console.log(JSON.stringify(result,null,2));
   const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,current+'.png'),Buffer.from(screenshot.data,'base64'));
 }
 const report={verified:results.every(r=>r.passed),scope:'Desktop Edge official Baidu website; not mobile app or all panoids',results};await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));if(!report.verified)process.exitCode=1;
}finally{socket?.close();browser?.kill();for(const p of pending.values())clearTimeout(p.timer);}
