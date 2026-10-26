import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {testSupabase} from './helpers/supabase-fixture.mjs';
import {ProviderError} from '../lib/providers/types.ts';
import {parsePage} from '../lib/pages.ts';
import * as scopeFunctions from '../lib/scope.ts';

const one='00000000-0000-4000-8000-000000000001',two='00000000-0000-4000-8000-000000000002';
const pageOne='10000000-0000-4000-8000-000000000001',pageTwo='10000000-0000-4000-8000-000000000002';
const collectionOne='20000000-0000-4000-8000-000000000001',collectionTwo='20000000-0000-4000-8000-000000000002';
const scope={mode:'posts',postLimit:100,from:null,to:null};
function load(file,names,context){
  const text=readFileSync(new URL(file,import.meta.url),'utf8').replace(/^import[^;]*;\r?\n/gm,'');
  const code=stripTypeScriptTypes(text,{mode:'transform'}).replace(/\bexport\s+/g,'');
  return new Script(code+'\n;({'+names.join(',')+'})',{filename:file}).runInNewContext(context);
}
async function fixture(){
  const pg=new PGlite();
  await pg.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const file of ['20261024000000_init.sql','20261024010000_sdk_operations.sql','20261024015000_sdk_admin.sql','20261024020000_sdk_legacy_import.sql','20261025000000_workspace_transfer.sql','20261026000000_admin_directory.sql','20261026010000_analytics_history.sql','20261026015000_analytics_operations.sql','20261026020000_analytics_transfer.sql','20261026030000_instagram_looter_performance.sql'])
    await pg.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await pg.query(`insert into auth.users(id,email) values($1,'one@example.test'),($2,'two@example.test')`,[one,two]);
  await pg.query(`insert into public.collections(id,owner,name) values($1,$2,'One'),($3,$4,'Two')`,[collectionOne,one,collectionTwo,two]);
  await pg.query(`insert into public.pages(id,owner,platform,handle,url,name) values($1,$2,'youtube','shared','https://youtube.com/@shared','Shared'),($3,$4,'youtube','shared','https://youtube.com/@shared','Shared')`,[pageOne,one,pageTwo,two]);
  await pg.query('insert into public.memberships(collection_id,page_id,owner) values($1,$2,$3),($4,$5,$6)',[collectionOne,pageOne,one,collectionTwo,pageTwo,two]);
  const {client:db,calls}=testSupabase(pg);
  const state={now:Date.now(),requests:0,globalKeys:true,sharedKeys:{},complete:true,hold:null,alerts:[],fetchFailure:false,providerInputs:[],outbound:[],beforeGlobalLease:null};
  const originalFrom=db.from.bind(db);
  db.from=table=>{
    const builder=originalFrom(table);
    if(table==='tracked_accounts'){
      const update=builder.update.bind(builder);
      builder.update=value=>{
        const request=update(value);
        if(value.status==='refreshing'){
          const then=request.then.bind(request);
          request.then=(...args)=>Promise.resolve(state.beforeGlobalLease?.()).then(()=>then(...args));
        }
        return request;
      };
    }
    return builder;
  };
  class Clock extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
  const secrets=load('../lib/crypto.ts',['encryptSecret','decryptSecret'],{createCipheriv,createDecipheriv,randomBytes,Buffer,process:{env:{APP_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')}}});
  const base={Date:Clock,URL,URLSearchParams,Request,Response,JSON,Number,Math,Buffer,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,ProviderError,parsePage,timingSafeEqual,process:{env:{}},...scopeFunctions,...secrets,
    connectDatabase:()=>db,getCurrentUser:async()=>({userId:one,email:'one@example.test',displayName:'One'}),
    crypto:{randomUUID},fetch:async(url,options)=>{state.requests++;state.outbound.push({url,headers:options.headers});if(state.hold)await state.hold;return Response.json({items:[],echo:options.headers['x-rapidapi-key']||''},{status:state.fetchFailure?503:200});}};
  const server=load('../lib/server.ts',['ApiError','database','query','queryRows','decrypt','pageRecord','preferences','json','fail'],base);
  const payload=load('../lib/providers/shared.ts',['checkPayload'],{...base});
  const transport=load('../lib/providers/request.ts',['createProviderRequest'],{...base,...server,...payload});
  const context={...base,...server,...transport,
    DEFAULT_PROVIDER_ORDER:{youtube:['youtube-official','tikhub'],instagram:['hikerapi','tikhub','instagram-looter'],tiktok:['lamatok','tikhub']},
    getConfiguredKeys:()=>({...state.sharedKeys,...(state.globalKeys?{'youtube-official':'fake-test-key'}:{})}),
    fetchSocialPage:async(page,options)=>{state.providerInputs.push(page);
      const provider=options.providerOrder.find(id=>options.keys[id]);
      if(!provider)throw new ProviderError('No configured data provider.', 'CONFIGURATION',503);
      const endpoint=provider==='instagram-looter'?'https://instagram-looter2.p.rapidapi.com/web-profile?username=shared':provider==='tikhub'?'https://api.tikhub.io/api/v1/instagram/web/fetch_user_info_by_username':provider==='hikerapi'?'https://api.hikerapi.com/v2/user/by/username':'https://www.googleapis.com/youtube/v3/channels';
      await options.request(provider,endpoint,provider==='instagram-looter'?{'x-rapidapi-host':'instagram-looter2.p.rapidapi.com','x-rapidapi-key':options.keys[provider]}:{authorization:options.keys[provider]});return {
      name:'Shared public page',followers:500,canonicalId:'native-shared',provider,
      profile:{following:null,avatar:null,isVerified:null,postCount:1},
      posts:[{id:'video-1',pageId:page.id,platform:page.platform,url:page.platform==='instagram'?'https://www.instagram.com/p/CODE1/':'https://youtube.com/watch?v=video1',title:'A post',publishedAt:new Date(state.now-8*86400000).toISOString(),views:100,likes:0,comments:0,shares:null,saves:null,thumbnail:null,durationSeconds:30}],
      coverage:{complete:state.complete,incomplete:!state.complete,hasMore:!state.complete,limit:100,fetched:1},
      overall:{views:1000,posts:1,followers:500,likes:null,comments:null,shares:null,note:''}};},
    reconcileWorkspaceAlerts:async(owner,at)=>{state.alerts.push({owner,at});},
  };
  const service=load('../lib/refresh-service.ts',['refreshWorkspacePage','providerConfiguration'],context);
  const cron=load('../app/api/cron/refresh/route.ts',['authorizeCron','runScheduledRefresh','GET'],{...context,...service});
  const reset=async()=>{
    state.requests=0;state.complete=true;state.hold=null;state.globalKeys=true;state.sharedKeys={};state.alerts.length=0;state.fetchFailure=false;state.now+=600000;state.providerInputs.length=0;state.outbound.length=0;state.beforeGlobalLease=null;
    await pg.exec("update public.pages set posts='[]',coverage='{}',last_synced_at=null,overall=null,locked_until=0,sync_error=null;update public.tracked_accounts set fetched_at=null,last_attempt_at=null,latest_payload=null,locked_until=0,status='pending',error=null;delete from public.provider_requests;update public.provider_settings set monthly_request_cap=25000,monthly_budget_usd=25,refresh_enabled=false");
  };
  return {pg,db,calls,state,server,service,cron,secrets,reset,close:()=>pg.close()};
}

test('shared refresh service preserves owner histories and bounds scheduled work',async t=>{
  const f=await fixture();try{
    await t.test('two owners of one handle use one request and the same observation timestamp',async()=>{
      const first=await f.service.refreshWorkspacePage(one,pageOne,scope);
      const second=await f.service.refreshWorkspacePage(two,pageTwo,scope);
      assert.equal(first.cached,false);assert.equal(second.cached,true);assert.equal(f.state.requests,1);
      assert.equal(first.page.lastSyncedAt,second.page.lastSyncedAt);assert.equal(second.page.posts[0].pageId,pageTwo);
      assert.equal((await f.pg.query('select count(*)::int n from public.provider_requests')).rows[0].n,1);
      assert.equal((await f.pg.query('select count(*)::int n from public.account_snapshots')).rows[0].n,2);
      assert.equal((await f.pg.query('select count(*)::int n from public.usage')).rows[0].n,0,'centrally funded calls do not consume legacy owner quota');
    });
    await t.test('a concurrent subscriber cannot make a second paid request during the shared lease',async()=>{
      await f.reset();let release;f.state.hold=new Promise(resolve=>{release=resolve;});
      const first=f.service.refreshWorkspacePage(one,pageOne,scope);
      while(f.state.requests===0)await new Promise(resolve=>setImmediate(resolve));
      await assert.rejects(f.service.refreshWorkspacePage(two,pageTwo,scope),error=>error.status===409);
      assert.equal(f.state.requests,1);release();await first;
      assert.equal((await f.service.refreshWorkspacePage(two,pageTwo,scope)).cached,true);
    });
    await t.test('partial results can be shared without pretending coverage is complete',async()=>{
      await f.reset();f.state.complete=false;
      await f.service.refreshWorkspacePage(one,pageOne,scope);
      const second=await f.service.refreshWorkspacePage(two,pageTwo,scope);
      assert.equal(second.cached,true);assert.equal(second.page.coverage.complete,false);assert.equal(f.state.requests,1);
    });
    await t.test('a completed concurrent fetch is rechecked after obtaining the shared lease',async()=>{
      await f.reset();let release,entered;
      const blocked=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
      let first=true;f.state.beforeGlobalLease=()=>{if(first){first=false;entered();return blocked;}};
      const delayed=f.service.refreshWorkspacePage(one,pageOne,scope);await ready;
      const second=await f.service.refreshWorkspacePage(two,pageTwo,scope);release();
      assert.equal(second.cached,false);assert.equal((await delayed).cached,true);assert.equal(f.state.requests,1);
    });
    await t.test('imported identity fields and a conflicting URL cannot redirect the shared cache',async()=>{
      await f.reset();
      const victim=(await f.pg.query("insert into public.tracked_accounts(platform,handle,canonical_id,latest_payload)values('youtube','victim','native-victim','{\"protected\":true}') returning id")).rows[0].id;
      await f.pg.query("update public.pages set canonical_id='native-victim',tracked_account_id=$1,url='https://youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' where id=$2",[victim,pageOne]);
      await f.service.refreshWorkspacePage(one,pageOne,scope);
      const protectedAccount=(await f.pg.query('select canonical_id,latest_payload from public.tracked_accounts where id=$1',[victim])).rows[0];
      assert.equal(protectedAccount.canonical_id,'native-victim');assert.deepEqual(protectedAccount.latest_payload,{protected:true});
      assert.equal(f.state.providerInputs[0].handle,'shared');assert.equal(f.state.providerInputs[0].url,'https://www.youtube.com/@shared');
      assert.notEqual((await f.pg.query('select tracked_account_id from public.pages where id=$1',[pageOne])).rows[0].tracked_account_id,victim);
      await f.pg.query('delete from public.tracked_accounts where id=$1',[victim]);
    });
    await t.test('owner checks and the central hard cap prevent outbound calls',async()=>{
      await f.reset();await assert.rejects(f.service.refreshWorkspacePage(two,pageOne,scope),error=>error.status===404);assert.equal(f.state.requests,0);
      await f.pg.exec('update public.provider_settings set monthly_request_cap=1');
      await f.service.refreshWorkspacePage(one,pageOne,scope);
      f.state.now+=600000;await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope),error=>error.status===400&&/monthly/i.test(error.message));
      assert.equal(f.state.requests,1);
    });
    await t.test('background refresh never spends a customer personal key without shared configuration',async()=>{
      await f.reset();f.state.globalKeys=false;
      await f.pg.query("insert into public.settings(owner,youtube_key)values($1,'personal-key') on conflict(owner)do update set youtube_key='personal-key'",[one]);
      await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope,{scheduled:true}),error=>error.status===503);
      assert.equal(f.state.requests,0);
    });
    await t.test('log retention runs while refreshing is paused',async()=>{
      await f.reset();await f.pg.exec("insert into public.provider_requests(provider,platform,endpoint,created_at,raw_response)values('youtube-official','youtube','/youtube/v3/channels',now()-interval '8 days','{\"debug\":true}')");
      const result=await f.cron.runScheduledRefresh();assert.equal(result.enabled,false);assert.equal(f.state.requests,0);
      assert.equal((await f.pg.query('select raw_response from public.provider_requests')).rows[0].raw_response,null);
    });
    await t.test('scheduled refresh shares a fetch across owners and checks alerts for both',async()=>{
      await f.reset();await f.pg.exec('update public.provider_settings set refresh_enabled=true');
      const result=await f.cron.runScheduledRefresh();assert.equal(result.attemptedAccounts,1);assert.equal(result.refreshedPages,2);assert.equal(result.cachedPages,1);
      assert.equal(f.state.requests,1);assert.deepEqual(f.state.alerts.map(x=>x.owner).sort(),[one,two]);
    });
    await t.test('approaching the shared cap increases the scheduled interval',async()=>{
      await f.reset();await f.pg.exec("update public.provider_settings set refresh_enabled=true,monthly_request_cap=4;insert into public.provider_requests(provider,platform,endpoint)select 'youtube-official','youtube','/youtube/v3/channels' from generate_series(1,3)");
      const result=await f.cron.runScheduledRefresh();assert.equal(result.intervalHours,48);assert.equal(result.budgetPressure,75);assert.equal(f.state.requests,1);
    });
    await t.test('one failed shared fetch marks both owners and runs their data-health checks',async()=>{
      await f.reset();f.state.fetchFailure=true;await f.pg.exec('update public.provider_settings set refresh_enabled=true');
      const result=await f.cron.runScheduledRefresh();assert.equal(result.failedPages,1);assert.equal(f.state.requests,2,'one bounded retry, not another fetch for every subscriber');
      assert.deepEqual(f.state.alerts.map(x=>x.owner).sort(),[one,two]);
      assert.ok((await f.pg.query('select sync_error from public.pages')).rows.every(row=>row.sync_error));
    });
    await t.test('cron authorization fails closed and only accepts the exact bearer secret',async()=>{
      const secret='test-secret-'.repeat(4);
      for(const headers of [{},{authorization:'Bearer wrong'},{authorization:'bearer '+secret}])assert.throws(()=>f.cron.authorizeCron(new Request('https://app.test/api/cron/refresh',{headers}),secret),error=>error.status===401);
      assert.throws(()=>f.cron.authorizeCron(new Request('https://app.test/api/cron/refresh'),'short'),error=>error.status===503);
      assert.doesNotThrow(()=>f.cron.authorizeCron(new Request('https://app.test/api/cron/refresh',{headers:{authorization:'Bearer '+secret}}),secret));
    });
  }finally{await f.close();}
});

test('dashboard RapidAPI key funds manual and scheduled Instagram refreshes without leaking or bypassing budgets',async()=>{
  const f=await fixture();try{
    const key='dashboard-rapidapi-fixture-key',cipher=f.secrets.encryptSecret(key);
    f.state.globalKeys=false;
    await f.pg.exec("update public.pages set platform='instagram',url='https://www.instagram.com/shared/';update public.provider_settings set provider_order=jsonb_set(provider_order,'{instagram}','[\"instagram-looter\"]')");
    await f.pg.query('update public.provider_settings set rapidapi_key=$1',[cipher]);
    await assert.rejects(f.service.refreshWorkspacePage(two,pageOne,scope),error=>error.status===404);
    assert.equal(f.state.requests,0);

    const manual=await f.service.refreshWorkspacePage(one,pageOne,scope);
    const other=await f.service.refreshWorkspacePage(two,pageTwo,scope);
    assert.equal(manual.cached,false);assert.equal(other.cached,true);assert.equal(f.state.requests,1);
    assert.equal(f.state.outbound[0].headers['x-rapidapi-key'],key);
    assert.equal(f.state.outbound[0].headers['x-rapidapi-host'],'instagram-looter2.p.rapidapi.com');
    assert.equal(new URL(f.state.outbound[0].url).hostname,'instagram-looter2.p.rapidapi.com');
    assert.equal(other.page.posts[0].pageId,pageTwo);
    assert.equal((await f.pg.query('select count(*)::int n from public.usage')).rows[0].n,0);
    let logs=(await f.pg.query('select provider,funding,owner,endpoint,estimated_cost_usd,raw_response from public.provider_requests')).rows;
    assert.equal(logs[0].provider,'instagram-looter');assert.equal(logs[0].funding,'platform');assert.equal(logs[0].owner,null);
    assert.equal(logs[0].endpoint,'/web-profile');assert.equal(Number(logs[0].estimated_cost_usd),0.00066);
    assert.equal(logs[0].raw_response.echo,'[redacted]');
    assert.equal(JSON.stringify([manual,other,logs]).includes(key),false);
    assert.equal(JSON.stringify([manual,other,logs]).includes(cipher),false);

    f.state.now+=25*3600000;
    await f.pg.exec('update public.provider_settings set refresh_enabled=true');
    const scheduled=await f.cron.runScheduledRefresh();
    assert.equal(scheduled.attemptedAccounts,1);assert.equal(scheduled.refreshedPages,2);assert.equal(scheduled.cachedPages,1);
    assert.equal(f.state.requests,2);assert.equal(f.state.outbound[1].headers['x-rapidapi-key'],key);
    assert.deepEqual(f.state.alerts.map(x=>x.owner).sort(),[one,two]);

    f.state.now+=600000;
    await f.pg.exec('update public.provider_settings set monthly_request_cap=2');
    await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope),error=>error.status===400&&/monthly/i.test(error.message));
    assert.equal((await f.cron.runScheduledRefresh()).budgetLimited,true);assert.equal(f.state.requests,2);
    await f.pg.exec('update public.provider_settings set monthly_request_cap=25000,monthly_budget_usd=0.001320');
    await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope),error=>error.status===400&&/monthly/i.test(error.message));
    assert.equal((await f.cron.runScheduledRefresh()).budgetLimited,true);assert.equal(f.state.requests,2);

    await f.pg.exec("update public.provider_settings set monthly_budget_usd=25,rapidapi_key=''");
    await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope),error=>error.status===400);
    await assert.rejects(f.service.refreshWorkspacePage(two,pageTwo,scope,{scheduled:true}),error=>error.status===503);
    assert.equal(f.state.requests,2,'clearing the dashboard key stops further paid requests');
    const damaged='damaged-ciphertext-never-expose';
    await f.pg.query('update public.provider_settings set rapidapi_key=$1',[damaged]);
    await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope),error=>error.status===503&&!error.message.includes(damaged));
    assert.equal(f.state.requests,2);
    assert.equal((await f.pg.query('select jsonb_array_length(posts) n from public.pages where id=$1',[pageOne])).rows[0].n,1,'configuration errors keep the saved snapshot');

    // Saving a shared key does not switch users away from an existing personal provider.
    await f.pg.exec("update public.provider_settings set provider_order=jsonb_set(provider_order,'{instagram}','[\"tikhub\"]')");
    await f.pg.query("insert into public.settings(owner,provider,api_key)values($1,'tikhub',$2) on conflict(owner)do update set provider='tikhub',api_key=excluded.api_key",[one,f.secrets.encryptSecret('personal-tikhub-fixture')]);
    const personal=await f.service.refreshWorkspacePage(one,pageOne,scope);
    assert.equal(personal.cached,false);assert.equal(f.state.requests,3);
    logs=(await f.pg.query("select provider,funding,owner from public.provider_requests where funding='workspace'")).rows;
    assert.equal(logs.length,1);assert.equal(logs[0].provider,'tikhub');assert.equal(logs[0].owner,one);
    assert.equal((await f.pg.query('select count(*)::int n from public.usage where owner=$1',[one])).rows[0].n,1);
    f.state.now+=600000;
    await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope,{scheduled:true}),error=>error.status===503);
    assert.equal(f.state.requests,3,'cron cannot fall back to a personal key');
  }finally{await f.close();}
});

test('a damaged Looter fallback key does not block a healthy shared provider or spend a personal key',async()=>{
  const f=await fixture();try{
    f.state.globalKeys=false;f.state.sharedKeys={hikerapi:'healthy-shared-hiker-key'};
    await f.pg.exec("update public.pages set platform='instagram',url='https://www.instagram.com/shared/';update public.provider_settings set rapidapi_key='corrupt-saved-rapidapi-ciphertext',provider_order=jsonb_set(provider_order,'{instagram}','[\"hikerapi\",\"instagram-looter\"]')");
    await f.pg.query("insert into public.settings(owner,provider,api_key)values($1,'tikhub',$2) on conflict(owner)do update set provider='tikhub',api_key=excluded.api_key",[one,f.secrets.encryptSecret('personal-key-must-not-be-spent')]);
    const result=await f.service.refreshWorkspacePage(one,pageOne,scope);
    assert.equal(result.cached,false);assert.equal(f.state.requests,1);
    assert.equal(new URL(f.state.outbound[0].url).hostname,'api.hikerapi.com');
    const logs=(await f.pg.query('select provider,funding,owner from public.provider_requests')).rows;
    assert.deepEqual(logs,[{provider:'hikerapi',funding:'platform',owner:null}]);
    assert.equal((await f.pg.query('select count(*)::int n from public.usage')).rows[0].n,0);

    // If the shared alternative disappears, a broken saved Looter key remains
    // an actionable configuration failure even when a personal key is present.
    f.state.now+=600000;f.state.sharedKeys={};
    await assert.rejects(f.service.refreshWorkspacePage(one,pageOne,scope),error=>error.status===503&&!error.message.includes('corrupt-saved-rapidapi-ciphertext'));
    await assert.rejects(f.service.refreshWorkspacePage(two,pageTwo,scope,{scheduled:true}),error=>error.status===503);
    assert.equal(f.state.requests,1);
    assert.equal((await f.pg.query('select count(*)::int n from public.usage')).rows[0].n,0);
  }finally{await f.close();}
});
