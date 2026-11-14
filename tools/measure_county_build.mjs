import {publishPages} from './publish_pages.mjs';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const args=process.argv.slice(2);
const i=args.indexOf('--output'),output=i<0?'dist/pages-county-release':args[i+1];
const start=performance.now();let peakRss=0;
const sample=()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);};sample();
const timer=setInterval(sample,250);timer.unref();
try{
 const result=await publishPages({output,commit:process.env.GITHUB_SHA});sample();
 const report={elapsedMs:Math.round(performance.now()-start),peakRssBytes:peakRss,nodeHeapLimitMiB:128,build:result};
 await writeFile('dist/county-build-performance.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{clearInterval(timer);}
