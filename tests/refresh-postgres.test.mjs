import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {normalizeScope,scopeKey,snapshotCovers,snapshotMatches,selectPosts,postDates,storedScope} from '../lib/scope.ts';
import {ProviderError} from '../lib/providers/types.ts';
import {parsePage} from '../lib/pages.ts';
import {randomUUID} from 'node:crypto';
import {testSupabase} from './helpers/supabase-fixture.mjs';

const user='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000099';
const sourceId='10000000-0000-4000-8000-000000000001',targetId='10000000-0000-4000-8000-000000000002';
const c1='20000000-0000-4000-8000-000000000001',c2='20000000-0000-4000-8000-000000000002';
const scope={mode:'posts',postLimit:30,from:null,to:null};
function loadTs(file,exports,context){
  const source=readFileSync(new URL(file,import.meta.url),'utf8').replace(/^import[^;]*;\r?\n/gm,'');
  const code=stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'');
  return new Script(code+'\n;({'+exports.join(',')+'})',{filename:file}).runInNewContext({...context});
}
async function fixture(){
  const pg=new PGlite();
  try{
  await pg.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const file of ['20261024000000_init.sql','20261024010000_sdk_operations.sql'])await pg.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await pg.exec(`insert into auth.users(id,email)values('${user}','user@example.test'),('${other}','other@example.test');
    insert into public.collections(id,owner,name)values('${c1}','${user}','One'),('${c2}','${user}','Two');
    insert into public.pages(id,owner,platform,handle,url,name,posts,coverage)values('${sourceId}','${user}','youtube','source','https://youtube.com/@source','Source','[{"views":10}]','{}');
    insert into public.memberships values('${c1}','${sourceId}','${user}');
    insert into public.settings(owner,provider,api_key,youtube_key,request_limit)values('${user}','scrapecreators','provider-key','youtube-key',10);`);
  const state={now:Date.parse('2026-10-24T12:00:00Z'),requestLimit:10,requests:0,timeouts:[],loseLease:false,alias:false,providerMode:'success',beforeRequestMs:0,authUser:{userId:user,email:'user@example.test',displayName:'User',fullName:'User'}};
  const {client:db,calls}=testSupabase(pg);
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
  const base={Date:ClockDate,URL,Response,Request,JSON,Number,Math,AbortController,clearTimeout,setTimeout:(fn,ms)=>{if(ms>=1000)state.timeouts.push(ms);return setTimeout(fn,ms);},crypto:{randomUUID},Buffer,TextDecoder,Uint8Array,
    postDates,scopeKey,storedScope,connectDatabase:()=>db,getCurrentUser:async()=>state.authUser,encryptSecret:value=>'encrypted:'+value,decryptSecret:value=>value||''};
  const server=loadTs('../lib/server.ts',['ApiError','body','database','query','queryRows','encrypt','decrypt','fail','guard','json','owner','pageRecord','preferences','currentAccount','requireAdmin'],base);
  const context={...base,...server,ProviderError,normalizeScope,scopeKey,snapshotCovers,snapshotMatches,selectPosts,parsePage,
    preferences:async owner=>({...await server.preferences(owner),request_limit:state.requestLimit}),
    AbortSignal:{timeout:milliseconds=>{state.timeouts.push(milliseconds);return undefined;}},
    fetch:async()=>{state.requests++;if(state.providerMode==='timeout'){state.now+=180001;throw new Error('Timed out');}return Response.json({ok:true});},
    getConfiguredKeys:()=>({}),DEFAULT_PROVIDER_ORDER:{youtube:['youtube-official','tikhub'],instagram:['tikhub'],tiktok:['tikhub']},
    fetchSocialPage:async(page,settings)=>{state.now+=state.beforeRequestMs;await settings.request('youtube-official','https://www.googleapis.com/youtube/v3/channels',{});if(state.loseLease)await pg.query('update public.pages set locked_until=0 where id=$1',[page.id]);return {name:'Refreshed',followers:50,canonicalId:state.alias?'canonical-one':null,
      posts:[{id:'post-one',pageId:page.id,platform:'youtube',publishedAt:'2026-10-23T12:00:00Z',views:100,likes:20,comments:3,shares:null}],
      coverage:{complete:true,hasMore:false,limit:30,fetched:1},overall:{views:1000,posts:1,followers:50},provider:'test'};}};
  const payload=loadTs('../lib/providers/shared.ts',['checkPayload'],context);
  const transport=loadTs('../lib/providers/request.ts',['createProviderRequest'],{...context,...payload});
  const service=loadTs('../lib/refresh-service.ts',['refreshWorkspacePage'],{...context,...transport});
  const route=loadTs('../app/api/refresh/route.ts',['POST','maxDuration','runtime'],{...context,...service});
  const desk=loadTs('../app/api/desk/route.ts',['GET','POST'],context);
  const post=(pageId=sourceId)=>route.POST(new Request('https://app.test/api/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageId,scope})}));
  const mutate=async body=>{const response=await desk.POST(new Request('https://app.test/api/desk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {response,body:await response.json()};};
  const addAlias=async()=>{state.alias=true;await pg.query(`insert into public.pages(id,owner,platform,handle,url,name,posts,coverage,canonical_id)values($1,$2,'youtube','target','https://youtube.com/@target','Target','[{"views":7}]','{}','canonical-one')`,[targetId,user]);await pg.query('insert into public.memberships values($1,$2,$3)',[c2,targetId,user]);};
  return {pg,state,db,calls,server,route,desk,post,mutate,addAlias,close:()=>pg.close()};
  }catch(error){await pg.close();throw error;}
}

test('SDK refresh saves JSONB snapshots and releases its lease through the named RPC',async()=>{
  const f=await fixture();try{
    assert.equal(f.route.runtime,'nodejs');assert.equal(f.route.maxDuration,300);
    const response=await f.post();assert.equal(response.status,200,await response.clone().text());
    const body=await response.json();assert.equal(body.page.posts[0].views,100);assert.equal(body.page.posts[0].pageId,sourceId);assert.equal(body.page.posts[0].shares,null);
    assert.equal(Number((await f.pg.query('select locked_until from public.pages where id=$1',[sourceId])).rows[0].locked_until),0);
    assert.equal(Number((await f.pg.query('select requests from public.usage')).rows[0].requests),1);assert.equal(f.state.requests,1);
    assert.ok(f.calls.some(call=>call.path==='/rest/v1/rpc/desk_save_refresh'));
    assert.ok(f.calls.some(call=>call.path==='/rest/v1/rpc/desk_reserve_usage'));
  }finally{await f.close();}
});
test('SDK quota reservation is atomic across refreshes and never spends beyond the cap',async()=>{
  const f=await fixture();try{
    await f.pg.query(`insert into public.pages(id,owner,platform,handle,url,name)values($1,$2,'youtube','second','https://youtube.com/@second','Second')`,[targetId,user]);
    await f.pg.query('insert into public.memberships values($1,$2,$3)',[c2,targetId,user]);f.state.requestLimit=1;
    const responses=await Promise.all([f.post(sourceId),f.post(targetId)]);assert.deepEqual(responses.map(response=>response.status).sort(),[200,400]);
    assert.equal(Number((await f.pg.query('select requests from public.usage')).rows[0].requests),1);assert.equal(f.state.requests,1);
  }finally{await f.close();}
});
test('provider timeout respects the remaining refresh deadline and preserves previous data',async()=>{
  const f=await fixture();try{
    f.state.beforeRequestMs=175000;
    let response=await f.post();assert.equal(response.status,200,await response.clone().text());assert.equal(f.state.timeouts[0],5000);
    await f.pg.query('update public.pages set last_synced_at=null,posts=$1::jsonb where id=$2',[JSON.stringify([{views:25}]),sourceId]);
    f.state.beforeRequestMs=0;f.state.providerMode='timeout';response=await f.post();assert.equal(response.status,400);
    const saved=(await f.pg.query('select posts,locked_until,sync_error from public.pages where id=$1',[sourceId])).rows[0];
    assert.equal(saved.posts[0].views,25);assert.equal(Number(saved.locked_until),0);assert.match(saved.sync_error,/safety limit/);
  }finally{await f.close();}
});
test('SDK alias merge moves memberships and saves the canonical page in one transaction',async()=>{
  const f=await fixture();try{
    await f.addAlias();const response=await f.post();assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).page.id,targetId);assert.equal((await f.pg.query('select id from public.pages where id=$1',[sourceId])).rows.length,0);
    const members=(await f.pg.query('select page_id from public.memberships order by collection_id')).rows;assert.equal(members.length,2);assert.equal(members.every(row=>row.page_id===targetId),true);
  }finally{await f.close();}
});
test('failed alias deletion rolls back saved counters and all membership changes',async()=>{
  const f=await fixture();try{
    await f.addAlias();await f.pg.exec(`create function public.block_alias_delete() returns trigger language plpgsql as $$begin return null;end$$;
      create trigger block_alias_delete before delete on public.pages for each row execute function public.block_alias_delete();`);
    const response=await f.post();assert.equal(response.status,409,await response.clone().text());
    const pages=(await f.pg.query('select id,posts,locked_until from public.pages order by id')).rows;assert.equal(pages.length,2);assert.equal(pages[1].posts[0].views,7);assert.equal(pages.every(row=>Number(row.locked_until)===0),true);
    const members=(await f.pg.query('select collection_id,page_id from public.memberships order by collection_id')).rows;assert.equal(members[0].page_id,sourceId);assert.equal(members[1].page_id,targetId);
  }finally{await f.close();}
});
test('a lost source lease blocks an SDK alias merge before any membership moves',async()=>{
  const f=await fixture();try{
    await f.addAlias();f.state.loseLease=true;const response=await f.post();assert.equal(response.status,409,await response.clone().text());
    const members=(await f.pg.query('select collection_id,page_id from public.memberships order by collection_id')).rows;assert.equal(members[0].page_id,sourceId);assert.equal(members[1].page_id,targetId);
    const pages=(await f.pg.query('select id,posts from public.pages order by id')).rows;assert.equal(pages.length,2);assert.equal(pages[1].posts[0].views,7);
  }finally{await f.close();}
});
test('SDK workspace reads preserve camelCase response fields and isolate tenant records',async()=>{
  const f=await fixture();try{
    const otherCollection='20000000-0000-4000-8000-000000000099',otherPage='10000000-0000-4000-8000-000000000099';
    await f.pg.query('insert into public.collections(id,owner,name)values($1,$2,$3)',[otherCollection,other,'Other owner']);
    await f.pg.query("insert into public.pages(id,owner,platform,handle,url,name)values($1,$2,'youtube','private-other','https://youtube.com/@private-other','Other private page')",[otherPage,other]);
    await f.pg.query('insert into public.memberships values($1,$2,$3)',[otherCollection,otherPage,other]);
    const response=await f.desk.GET();assert.equal(response.status,200,await response.clone().text());const data=await response.json();
    assert.equal(data.collections.length,2);assert.ok(data.collections.every(collection=>Object.hasOwn(collection,'createdAt')));
    assert.equal(data.memberships[0].collectionId,c1);assert.equal(data.memberships[0].pageId,sourceId);assert.equal(data.pages[0].posts[0].views,10);
    assert.equal(data.collections.some(collection=>collection.name==='Other owner'),false);
    assert.equal(data.pages.length,1);assert.equal(data.memberships.length,1);
    assert.equal(JSON.stringify(data).includes('provider-key'),false);assert.equal(JSON.stringify(data).includes('youtube-key'),false);
  }finally{await f.close();}
});
test('SDK collection duplication and membership removal remain independent',async()=>{
  const f=await fixture();try{
    const created=await f.mutate({action:'createCollection',name:'New'});assert.equal(created.response.status,200,JSON.stringify(created.body));const id=created.body.id;
    let change=await f.mutate({action:'addPages',collectionId:id,inputs:['https://instagram.com/test_page/','https://www.instagram.com/TEST_PAGE/','https://youtube.com/@testchannel'],platform:'instagram'});assert.equal(change.response.status,200);assert.equal(change.body.added,2,JSON.stringify(change.body));assert.equal(change.body.errors.length,0);
    const copied=await f.mutate({action:'duplicateCollection',id,name:'Copy'});assert.equal(copied.response.status,200,JSON.stringify(copied.body));
    const member=(await f.pg.query('select page_id from public.memberships where collection_id=$1',[id])).rows[0].page_id;
    change=await f.mutate({action:'removePage',collectionId:copied.body.id,pageId:member});assert.equal(change.response.status,200);
    assert.equal(Number((await f.pg.query('select count(*) from public.memberships where collection_id=$1',[id])).rows[0].count),2);
    assert.equal(Number((await f.pg.query('select count(*) from public.memberships where collection_id=$1',[copied.body.id])).rows[0].count),1);
    change=await f.mutate({action:'renameCollection',id:'not-a-uuid',name:'Bad'});assert.equal(change.response.status,400);
    const otherCollection='20000000-0000-4000-8000-000000000099';await f.pg.query('insert into public.collections(id,owner,name)values($1,$2,$3)',[otherCollection,other,'Other owner']);
    change=await f.mutate({action:'renameCollection',id:otherCollection,name:'Wrong owner'});assert.equal(change.response.status,404);
  }finally{await f.close();}
});
test('SDK workspace loads all memberships beyond the Data API row cap',async()=>{
  const f=await fixture();try{
    await f.pg.exec(`insert into public.collections(owner,name)values('${user}','Three');
      insert into public.pages(owner,platform,handle,url,name)
        select '${user}','instagram','bulk'||n,'https://instagram.com/bulk'||n,'Bulk '||n from generate_series(1,400)as n;
      insert into public.memberships(collection_id,page_id,owner)
        select c.id,p.id,'${user}' from public.collections c cross join public.pages p where c.owner='${user}' and p.owner='${user}' and p.handle like 'bulk%';`);
    const response=await f.desk.GET();assert.equal(response.status,200,await response.clone().text());const data=await response.json();
    assert.equal(data.memberships.length,1201);assert.equal(data.pages.length,401);
    assert.ok(f.calls.some(call=>call.path==='/rest/v1/memberships'&&new URLSearchParams(call.search).get('offset')==='1000'));
  }finally{await f.close();}
});
test('SDK settings store encrypted provider credentials and return only key-presence flags',async()=>{
  const f=await fixture();try{
    let result=await f.mutate({action:'saveSettings',provider:'tikhub',postLimit:100,requestLimit:20,apiKey:'new-provider-key',youtubeKey:'new-youtube-key'});
    assert.equal(result.response.status,200,JSON.stringify(result.body));
    let settings=(await f.pg.query('select * from public.settings where owner=$1',[user])).rows[0];
    assert.equal(settings.api_key,'encrypted:new-provider-key');assert.equal(settings.youtube_key,'encrypted:new-youtube-key');assert.equal(Number(settings.post_limit),100);
    const visible=await(await f.desk.GET()).json();assert.equal(visible.settings.hasApiKey,true);assert.equal(visible.settings.hasYoutubeKey,true);
    assert.equal(JSON.stringify(visible).includes('new-provider-key'),false);assert.equal(JSON.stringify(visible).includes('new-youtube-key'),false);
    result=await f.mutate({action:'saveSettings',provider:'tikhub',postLimit:30,requestLimit:20,clearApiKey:true});assert.equal(result.response.status,200);
    settings=(await f.pg.query('select * from public.settings where owner=$1',[user])).rows[0];assert.equal(settings.api_key,null);assert.equal(settings.youtube_key,'encrypted:new-youtube-key');
  }finally{await f.close();}
});
test('refresh refuses another owner page before requesting provider data',async()=>{
  const f=await fixture();try{
    f.state.authUser={userId:other,email:'other@example.test',displayName:'Other'};
    const response=await f.post();assert.equal(response.status,404,await response.clone().text());assert.equal(f.state.requests,0);
    assert.equal(Number((await f.pg.query('select locked_until from public.pages where id=$1',[sourceId])).rows[0].locked_until),0);
  }finally{await f.close();}
});
test('account repair keeps manually assigned admin roles and rejects anonymous callers',async()=>{
  const f=await fixture();try{
    await f.pg.query("update public.users set user_type='admin' where id=$1",[user]);const account=await f.server.currentAccount();assert.equal(account.userType,'admin');
    assert.equal((await f.pg.query('select user_type from public.users where id=$1',[user])).rows[0].user_type,'admin');
    f.state.authUser=null;const response=await f.desk.GET();assert.equal(response.status,401);
  }finally{await f.close();}
});
