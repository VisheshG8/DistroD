import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',admin='33333333-3333-4333-8333-333333333333';
const page='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherPage='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',target='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const collection='dddddddd-dddd-4ddd-8ddd-dddddddddddd',otherCollection='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const post=(views=0)=>({id:'video-1',pageId:page,publishedAt:'2026-01-01T00:00:00Z',views,likes:null,comments:0,shares:null,saves:null});
const migration=readFileSync(new URL('../supabase/migrations/20261026010000_analytics_history.sql',import.meta.url),'utf8');
async function fixture(){
  const db=new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const file of ['20261024000000_init.sql','20261024010000_sdk_operations.sql','20261024015000_sdk_admin.sql','20261024020000_sdk_legacy_import.sql','20261025000000_workspace_transfer.sql','20261026000000_admin_directory.sql']){
    await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  }
  await db.query(`insert into auth.users(id,email) values($1,'one@example.test'),($2,'two@example.test'),($3,'admin@example.test')`,[owner,other,admin]);
  await db.query(`update public.users set user_type='admin' where id=$1`,[admin]);
  await db.query(`insert into public.collections(id,owner,name) values($1,$2,'One'),($3,$4,'Two')`,[collection,owner,otherCollection,other]);
  await db.query(`insert into public.pages(id,owner,platform,handle,url,name,followers,posts,overall,last_synced_at)
    values($1,$2,'youtube','samehandle','https://youtube.com/@samehandle','One',100,$3::jsonb,'{"posts":1,"following":0}','2026-01-01T10:00:00Z'),
    ($4,$5,'youtube','samehandle','https://youtube.com/@samehandle','Two',200,$3::jsonb,'{"posts":1}','2026-01-01T10:00:00Z')`,[page,owner,JSON.stringify([post()]),otherPage,other]);
  await db.query(`insert into public.memberships(collection_id,page_id,owner) values($1,$2,$3),($4,$5,$6)`,[collection,page,owner,otherCollection,otherPage,other]);
  await db.exec(migration);
  const service=async(name,args=[])=>db.transaction(async tx=>{await tx.exec('set local role service_role');return (await tx.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as result',args)).rows[0].result;});
  const browser=async(actor,sql,args=[])=>db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);await tx.exec('set local role authenticated');return tx.query(sql,args);});
  const refresh=async(time,views)=>db.query('update public.pages set last_synced_at=$1,posts=$2::jsonb,followers=$3 where id=$4',[time,JSON.stringify([post(views)]),100+views,page]);
  return {db,service,browser,refresh,close:()=>db.close()};
}

test('analytics migration backfills real observations, deduplicates shared handles, and enforces tenant isolation',async()=>{
  const f=await fixture();try{
    assert.equal((await f.db.query('select count(*)::int n from public.tracked_accounts')).rows[0].n,1);
    assert.equal((await f.db.query('select count(distinct tracked_account_id)::int n from public.pages')).rows[0].n,1);
    assert.equal((await f.db.query('select latest_payload from public.tracked_accounts')).rows[0].latest_payload,null,'owner records never populate shared cache');
    const stored=(await f.db.query('select observed_at,followers,following from public.account_snapshots where page_id=$1',[page])).rows[0];
    assert.equal(new Date(stored.observed_at).toISOString(),'2026-01-01T10:00:00.000Z');assert.equal(Number(stored.followers),100);assert.equal(Number(stored.following),0);
    for(const table of ['page_posts','account_snapshots','post_snapshots']){
      assert.equal((await f.browser(owner,'select * from public.'+table)).rows.length,1,table);
      assert.equal((await f.browser(admin,'select * from public.'+table)).rows.length,2,table);
      await assert.rejects(f.browser(owner,'delete from public.'+table),e=>e.code==='42501',table);
    }
    for(const table of ['tracked_accounts','provider_settings','provider_requests'])await assert.rejects(f.browser(owner,'select * from public.'+table),e=>e.code==='42501',table);
    await assert.rejects(f.browser(owner,'select * from private.alert_checks'),e=>e.code==='42501');
    await assert.rejects(f.db.query('insert into public.account_snapshots(owner,page_id,observed_at,followers) values($1,$2,now(),1)',[other,page]),e=>e.code==='23503');
    await assert.rejects(f.db.query('insert into public.post_snapshots(owner,page_id,post_id,observed_at,views) values($1,$2,\'bad\',now(),-1)',[owner,page]),e=>e.code==='23514');
    const tables=(await f.db.query(`select relname,relrowsecurity from pg_class where relname in ('tracked_accounts','page_posts','account_snapshots','post_snapshots','alerts','alert_checks','provider_settings','provider_requests') and relkind='r'`)).rows;
    assert.equal(tables.length,8);assert.ok(tables.every(row=>row.relrowsecurity));
  }finally{await f.close();}
});

test('history keeps first daily samples, accumulates posts, and switches from daily to weekly without inventing old counts',async()=>{
  const f=await fixture();try{
    await f.refresh('2026-01-01T20:00:00Z',10);
    assert.equal((await f.db.query('select count(*)::int n from public.post_snapshots where page_id=$1',[page])).rows[0].n,1);
    assert.equal(Number((await f.db.query('select views from public.post_snapshots where page_id=$1',[page])).rows[0].views),0,'first daily sample remains zero');
    assert.equal((await f.db.query('select payload from public.page_posts where page_id=$1',[page])).rows[0].payload.views,10,'latest post still updates');
    await f.refresh('2026-01-02T10:00:00Z',20);
    await f.refresh('2026-01-31T10:00:00Z',30);
    await f.refresh('2026-02-01T10:00:00Z',40);
    assert.equal((await f.db.query('select count(*)::int n from public.post_snapshots where page_id=$1',[page])).rows[0].n,3);
    await f.refresh('2026-02-07T10:00:00Z',50);
    await f.refresh('2026-04-10T10:00:00Z',60);
    assert.equal((await f.db.query('select count(*)::int n from public.post_snapshots where page_id=$1',[page])).rows[0].n,4,'post snapshots stop after 90 days');
    const old={...post(700),id:'older-video',publishedAt:'2025-01-01T00:00:00Z'};
    await f.db.query('update public.pages set last_synced_at=$1,posts=$2::jsonb where id=$3',['2026-04-11T10:00:00Z',JSON.stringify([old]),page]);
    assert.equal((await f.db.query('select count(*)::int n from public.page_posts where page_id=$1',[page])).rows[0].n,2,'a shorter fresh feed cannot remove discovered posts');
    const row=(await f.db.query('select * from public.post_snapshots where page_id=$1 and post_id=$2',[page,'older-video'])).rows[0];
    assert.equal(new Date(row.observed_at).toISOString(),'2026-04-11T10:00:00.000Z');assert.equal(row.likes,null);assert.equal(Number(row.comments),0);
    await f.service('desk_record_page_history',[owner,page]);
    assert.equal((await f.db.query('select count(*)::int n from public.post_snapshots where page_id=$1 and post_id=$2',[page,'older-video'])).rows[0].n,1);
  }finally{await f.close();}
});

test('alias merges retain history atomically and a failed canonical check rolls it all back',async()=>{
  const f=await fixture();try{
    await f.db.query(`insert into public.pages(id,owner,platform,handle,url,name,canonical_id,locked_until)
      values($1,$2,'youtube','alias','https://youtube.com/@alias','Alias','native-one',100)`,[target,owner]);
    await f.db.query('insert into public.memberships(collection_id,page_id,owner) values($1,$2,$3)',[collection,target,owner]);
    await f.db.query("update public.pages set locked_until=100,monthly_pay=500,editor='Editor',notes='Original notes' where id=$1",[page]);
    await f.db.query("insert into public.alerts(owner,page_id,level,type,title) values($1,$2,'red','no-posts','Source alert'),($1,$3,'red','no-posts','Target alert')",[owner,page,target]);
    const snapshot={name:'Canonical',followers:120,posts:[post(99)],coverage:{complete:true,limit:30},overall:{posts:1},provider:'test',last_synced_at:'2026-01-02T10:00:00Z',canonical_id:'wrong'};
    await assert.rejects(f.service('desk_save_refresh',[owner,page,target,100,JSON.stringify(snapshot)]),/DD409/);
    assert.equal((await f.db.query('select count(*)::int n from public.account_snapshots where page_id=$1',[target])).rows[0].n,0);
    assert.equal((await f.db.query('select monthly_pay from public.pages where id=$1',[target])).rows[0].monthly_pay,null);
    snapshot.canonical_id='native-one';
    assert.equal(await f.service('desk_save_refresh',[owner,page,target,100,JSON.stringify(snapshot)]),target);
    assert.equal((await f.db.query('select id from public.pages where id=$1',[page])).rows.length,0);
    assert.equal((await f.db.query('select count(*)::int n from public.account_snapshots where page_id=$1',[target])).rows[0].n,2);
    assert.equal((await f.db.query('select payload from public.page_posts where page_id=$1',[target])).rows[0].payload.pageId,target);
    assert.equal(Number((await f.db.query('select monthly_pay from public.pages where id=$1',[target])).rows[0].monthly_pay),500);
    const alerts=(await f.db.query('select page_id,resolved_at from public.alerts where owner=$1',[owner])).rows;
    assert.equal(alerts.length,2);assert.ok(alerts.every(row=>row.page_id===target));assert.equal(alerts.filter(row=>row.resolved_at===null).length,1);
  }finally{await f.close();}
});

test('provider reservations atomically enforce platform-funded caps and budget, count failures, and sanitize logs',async()=>{
  const f=await fixture();try{
    await f.db.exec("update public.provider_settings set monthly_request_cap=2,monthly_budget_usd=0.03 where id=true");
    const first=await f.service('desk_reserve_provider_request',['lamatok','tiktok','/api/v1/profile']);assert.equal(typeof first,'string');
    await f.db.query('update public.provider_requests set success=false where id=$1',[first]);
    assert.equal(await f.service('desk_reserve_provider_request',['lamatok','tiktok','/api/v1/profile']),null,'failed calls still consume budget');
    await f.db.query("insert into public.provider_requests(provider,platform,endpoint,funding,owner) values('tikhub','youtube','/test','workspace',$1)",[owner]);
    const second=await f.service('desk_reserve_provider_request',['youtube-official','youtube','/youtube/v3/channels']);assert.equal(typeof second,'string');
    assert.equal(await f.service('desk_reserve_provider_request',['youtube-official','youtube','/youtube/v3/channels']),null,'free calls still count toward request cap');
    const usage=await f.service('desk_provider_usage');assert.equal(usage.requests,2);assert.equal(usage.estimatedCostUsd,0.02);
    await assert.rejects(f.service('desk_reserve_provider_request',['lamatok','instagram','/profile']),/DD400/);
    await assert.rejects(f.service('desk_reserve_provider_request',['youtube-official','youtube','/channels?key=secret']),/DD400/);
    await assert.rejects(f.browser(owner,"select public.desk_reserve_provider_request('tikhub','youtube','/test')"),e=>e.code==='42501');
    await f.db.exec("delete from public.provider_requests;update public.provider_settings set monthly_request_cap=3,monthly_budget_usd=25 where id=true");
    const attempts=await Promise.all(Array.from({length:8},()=>f.service('desk_reserve_provider_request',['lamatok','tiktok','/test'])));
    assert.equal(attempts.filter(Boolean).length,3);
    await f.db.exec("insert into public.provider_requests(provider,platform,endpoint,created_at,raw_response) values('lamatok','tiktok','/old',now()-interval '8 days','{\"debug\":true}')");
    assert.equal(await f.service('desk_cleanup_provider_logs'),1);
    assert.equal((await f.db.query("select raw_response from public.provider_requests where endpoint='/old'")).rows[0].raw_response,null);
    assert.equal((await f.db.query('select count(*)::int n from public.provider_requests')).rows[0].n,4,'retention removes raw payload only, keeping cost audit');
  }finally{await f.close();}
});

test('alerts require two daily checks, resolve, respect cooldown, and reject foreign page candidates',async()=>{
  const f=await fixture();try{
    const candidate={pageId:page,type:'no-posts',level:'red',title:'No recent posts',details:'Check the posting plan.'};
    const check=(time,candidates=[candidate])=>f.service('desk_reconcile_alerts',[owner,JSON.stringify(candidates),time]);
    assert.deepEqual(await check('2026-10-10T10:00:00Z'),{opened:0,resolved:0});
    assert.deepEqual(await check('2026-10-10T12:00:00Z'),{opened:0,resolved:0});
    assert.deepEqual(await check('2026-10-11T10:00:00Z'),{opened:1,resolved:0});
    assert.deepEqual(await check('2026-10-11T10:00:00Z'),{opened:0,resolved:0});
    assert.equal((await f.browser(other,'select * from public.alerts')).rows.length,0);
    assert.equal((await f.browser(admin,'select * from public.alerts')).rows.length,1);
    assert.deepEqual(await check('2026-10-11T12:00:00Z',[]),{opened:0,resolved:1});
    assert.deepEqual(await check('2026-10-12T10:00:00Z'),{opened:0,resolved:0});
    assert.deepEqual(await check('2026-10-13T10:00:00Z'),{opened:0,resolved:0});
    assert.deepEqual(await check('2026-10-14T10:00:00Z'),{opened:1,resolved:0});
    await assert.rejects(check('2026-10-15T10:00:00Z',[{...candidate,pageId:otherPage}]),/DD404/);
    assert.equal((await f.db.query('select count(*)::int n from public.alerts where resolved_at is null')).rows[0].n,1,'failed reconciliation does not resolve existing alerts');
    await assert.rejects(f.browser(owner,'select public.desk_reconcile_alerts($1,$2::jsonb,now())',[owner,'[]']),e=>e.code==='42501');
  }finally{await f.close();}
});
