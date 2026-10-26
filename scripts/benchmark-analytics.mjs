import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {performance} from 'node:perf_hooks';
import {calculateWorkspace,createWorkspaceCalculator} from '../lib/analytics/metrics.ts';
import {analyticsPerformanceFixture,performanceRange,performanceComparison} from '../tests/helpers/analytics-performance-fixture.mjs';

// Optional first argument: a saved earlier metrics.ts, for before/after parity and timing.
// Uses synthetic data only. Wall times are evidence, not a machine-dependent test threshold.
const dataset=analyticsPerformanceFixture(48,180);
const measure=(label,fn)=>{
  const values=[];let result;
  for(let i=0;i<3;i++){const start=performance.now();result=fn();values.push(performance.now()-start);}
  values.sort((a,b)=>a-b);
  console.log(label+': median '+values[1].toFixed(1)+' ms (3 runs)');
  return result;
};
console.log(JSON.stringify({pages:dataset.pages.length,posts:dataset.pages.reduce((n,page)=>n+page.posts.length,0),postSnapshots:dataset.postSnapshots.length,accountSnapshots:dataset.accountSnapshots.length}));
let baseline;
let measuredCalculate=calculateWorkspace,measuredCreate=createWorkspaceCalculator;
if(process.argv[2]){
  const load=async path=>{
    const source=readFileSync(path,'utf8').replace(/^import[^;]*;\r?\n/gm,'');
    const code=stripTypeScriptTypes(source,{mode:'transform'});
    return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  };
  // Load both revisions as native modules with identical type stripping.
  const before=(await load(process.argv[2])).calculateWorkspace;
  const after=await load(new URL('../lib/analytics/metrics.ts',import.meta.url));
  measuredCalculate=after.calculateWorkspace;measuredCreate=after.createWorkspaceCalculator;
  baseline=measure('Before: full workspace with monthly reports and comparison',()=>before(dataset,performanceRange,performanceComparison));
}
const result=measure('After: full workspace with monthly reports and comparison',()=>measuredCalculate(dataset,performanceRange,performanceComparison));
if(baseline){assert.deepEqual(JSON.parse(JSON.stringify(result)),JSON.parse(JSON.stringify(baseline)));console.log('Before/after report parity: exact');}
const calculate=measuredCreate(dataset);
calculate(performanceRange,performanceComparison);
const pageIds=new Set(dataset.pages.filter((_,i)=>i%2===0).map(page=>page.id));
measure('After: filter to 24 pages using already prepared history',()=>calculate(performanceRange,performanceComparison,undefined,undefined,pageIds));
