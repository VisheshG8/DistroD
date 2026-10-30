import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';

const generatedAt='2026-10-26T00:00:00Z';
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function loader(fetch){
  const source=readFileSync(new URL('../lib/analytics/client.ts',import.meta.url),'utf8').replace(/^import[^;]*;\r?\n/gm,'');
  const code=stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'');
  return new Script(code+'\nloadAnalyticsDataset').runInNewContext({fetch,URLSearchParams,AbortController,DOMException,Error});
}
function responses(parallel=true){
  const ids=['posts','accounts','snapshots','alerts','memberships'];
  const result=new Map([['initial',{pages:[{id:'page',posts:[]}],collections:[{id:'group',name:'Saved'}],nextCursor:'posts',...(parallel?{parallelCursors:ids}:{})}]]);
  ids.forEach((id,i)=>result.set(id,{nextCursor:ids[i+1]||null,nextStageCursor:null}));
  result.get('posts').posts=Array.from({length:1000},(_,i)=>({id:String(i),pageId:'page',publishedAt:'2026-10-01T00:00:00Z'}));
  Object.assign(result.get('posts'),{nextCursor:'posts-2',nextStageCursor:'posts-2'});
  result.set('posts-2',{posts:[{id:'last',pageId:'page',publishedAt:'2026-10-02T00:00:00Z'}],nextCursor:'accounts',nextStageCursor:null});
  result.get('accounts').accountSnapshots=[{pageId:'page',followers:100,observedAt:generatedAt}];
  result.get('snapshots').postSnapshots=[{pageId:'page',postId:'last',views:30,observedAt:generatedAt}];
  result.get('alerts').alerts=[{id:'alert',pageId:'page'}];
  result.get('memberships').memberships=[{pageId:'page',collectionId:'group'}];
  for(const chunk of result.values())chunk.generatedAt=generatedAt;
  return result;
}
async function runLoading(parallel){
  const chunks=responses(parallel),pending=[];
  let maxConcurrent=0,waves=0,settled=false;
  const load=loader((url,{signal,cache})=>{
    assert.equal(cache,'no-store');assert.equal(signal.aborted,false);
    const query=new URL(url,'https://example.test').searchParams;
    assert.equal(query.get('pageId'),'page');assert.equal(query.get('from'),'2026-10-01');
    return new Promise(resolve=>{pending.push({resolve,chunk:chunks.get(query.get('cursor')||'initial')});maxConcurrent=Math.max(maxConcurrent,pending.length);});
  });
  const result=load(new URLSearchParams({pageId:'page',from:'2026-10-01',to:'2026-10-25'}));
  result.finally(()=>{settled=true;});
  while(!settled){
    await flush();
    if(!pending.length)continue;
    waves++;
    for(const {resolve,chunk} of pending.splice(0))resolve({ok:true,json:async()=>structuredClone(chunk)});
  }
  return {dataset:plain(await result),maxConcurrent,waves};
}

test('parallel history preserves all records and order with three bounded requests instead of seven serialized waits',async()=>{
  const parallel=await runLoading(true),legacy=await runLoading(false);
  assert.deepEqual(parallel.dataset,legacy.dataset);
  assert.equal(parallel.dataset.pages[0].posts.length,1001);
  assert.equal(parallel.dataset.pages[0].posts[0].id,'last');
  assert.equal(parallel.dataset.memberships.length,1);
  assert.equal(parallel.maxConcurrent,3);assert.equal(legacy.maxConcurrent,1);
  assert.equal(parallel.waves,3);assert.equal(legacy.waves,7);
});

test('a failed stream cancels its siblings and never returns a partial dataset',async()=>{
  const chunks=responses(),signals=[];
  const load=loader(async(url,{signal})=>{
    const cursor=new URL(url,'https://example.test').searchParams.get('cursor')||'initial';
    if(cursor==='initial')return {ok:true,json:async()=>chunks.get(cursor)};
    signals.push(signal);
    if(cursor==='accounts')return {ok:false,json:async()=>({error:'History failed'})};
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  });
  await assert.rejects(load(new URLSearchParams()),/History failed/);
  assert.equal(signals.length,3);assert.ok(signals.every(signal=>signal.aborted));
});

test('external cancellation aborts every active history request',async()=>{
  const chunks=responses(),signals=[],controller=new AbortController();
  const load=loader(async(url,{signal})=>{
    const cursor=new URL(url,'https://example.test').searchParams.get('cursor');
    if(!cursor)return {ok:true,json:async()=>chunks.get('initial')};
    signals.push(signal);
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  });
  const pending=load(new URLSearchParams(),controller.signal);
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await flush();controller.abort();await rejected;
  assert.equal(signals.length,3);assert.ok(signals.every(signal=>signal.aborted));
});

test('missing continuation, cursor loops, and mixed observation cutoffs fail closed',async()=>{
  for(const mode of ['missing','loop','cutoff']){
    const chunks=responses();
    if(mode==='missing')delete chunks.get('accounts').nextStageCursor;
    if(mode==='loop')chunks.get('accounts').nextStageCursor='accounts';
    if(mode==='cutoff')chunks.get('accounts').generatedAt='2026-10-27T00:00:00Z';
    const load=loader(async url=>({ok:true,json:async()=>structuredClone(chunks.get(new URL(url,'https://example.test').searchParams.get('cursor')||'initial'))}));
    await assert.rejects(load(new URLSearchParams()),mode==='missing'?/fully loaded/:mode==='loop'?/too large/:/changed while loading/);
  }
});

test('saved posts keep fractional durations while counters stay whole',()=>{
  const source=readFileSync(new URL('../lib/analytics/server.ts',import.meta.url),'utf8').replace(/^import[^;]*;\r?\n/gm,'');
  const analyticsPost=new Script(stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'')+'\nanalyticsPost').runInNewContext({Error});
  const post=analyticsPost({post_id:'p',page_id:'page',payload:{durationSeconds:12.4,views:10.5,likes:3}});
  assert.equal(post.durationSeconds,12.4);assert.equal(post.views,null);assert.equal(post.likes,3);
  assert.equal(analyticsPost({payload:{durationSeconds:1.23456}}).durationSeconds,1.235);
  assert.equal(post.audioId,null);assert.equal(analyticsPost({payload:{type:'reel',audioId:'1789'}}).audioId,'1789');assert.equal(analyticsPost({payload:{type:'reel'}}).type,'reel');
  for(const durationSeconds of [-1,Infinity,'12',90000])assert.equal(analyticsPost({payload:{durationSeconds}}).durationSeconds,null);
});
