import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const admin='33333333-3333-4333-8333-333333333333';
const upgrade=readFileSync(new URL('../supabase/migrations/20261026030000_instagram_looter_performance.sql',import.meta.url),'utf8');
async function fixture(beforeUpgrade){
  const db=new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const file of ['20261024000000_init.sql','20261024010000_sdk_operations.sql','20261024015000_sdk_admin.sql',
    '20261024020000_sdk_legacy_import.sql','20261025000000_workspace_transfer.sql','20261026000000_admin_directory.sql',
    '20261026010000_analytics_history.sql','20261026015000_analytics_operations.sql','20261026020000_analytics_transfer.sql']){
    await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  }
  await db.query(`insert into auth.users(id,email) values($1,'one@example.test'),($2,'two@example.test'),($3,'admin@example.test')`,[owner,other,admin]);
  await db.query(`update public.users set user_type='admin' where id=$1`,[admin]);
  if(beforeUpgrade)await beforeUpgrade(db);
  await db.exec(upgrade);
  const service=(name,args=[])=>db.transaction(async tx=>{await tx.exec('set local role service_role');return (await tx.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as result',args)).rows[0].result;});
  const browser=(actor,sql,args=[])=>db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);await tx.exec('set local role authenticated');return tx.query(sql,args);});
  return {db,service,browser,close:()=>db.close()};
}

async function assertUsageMatchesLogs(db){
  const difference=await db.query(`with actual as (
      select date_trunc('month',created_at at time zone 'UTC')::date as month,count(*) as requests,sum(estimated_cost_usd) as cost
      from public.provider_requests where funding='platform' group by 1
    ) select coalesce(a.month,u.month) as month from actual a full join private.provider_monthly_usage u using(month)
      where coalesce(a.requests,0)<>coalesce(u.requests,0) or coalesce(a.cost,0)<>coalesce(u.estimated_cost_usd,0)`);
  assert.deepEqual(difference.rows,[],'transactional counters agree with the actual retained logs');
}

test('Looter migration preserves provider choices and backfills private exact usage without exposing credentials',async()=>{
  const f=await fixture(async db=>{
    await db.exec(`update public.provider_settings set provider_order='{"instagram":["tikhub"],"youtube":["youtube-official"],"tiktok":["lamatok"]}',
      monthly_request_cap=12000,monthly_budget_usd=12,refresh_enabled=true,refresh_interval_hours=48,
      request_costs='{"tikhub":0.003,"youtube-official":0,"lamatok":0.02}';
      insert into public.provider_requests(provider,platform,endpoint,funding,created_at,estimated_cost_usd) values
      ('tikhub','instagram','/profile','platform',now(),0.003),
      ('tikhub','instagram','/profile','workspace',now(),0),
      ('lamatok','tiktok','/profile','platform',now()-interval '2 months',0.02);`);
  });try{
    const settings=(await f.db.query('select * from public.provider_settings')).rows[0];
    assert.deepEqual(settings.provider_order,{instagram:['tikhub'],youtube:['youtube-official'],tiktok:['lamatok']});
    assert.equal(settings.request_costs['instagram-looter'],0.000660);
    assert.equal(settings.request_costs.tikhub,0.003);
    assert.equal(settings.monthly_request_cap,12000);assert.equal(Number(settings.monthly_budget_usd),12);
    assert.equal(settings.refresh_enabled,true);assert.equal(settings.refresh_interval_hours,48);assert.equal(settings.rapidapi_key,'');
    await f.db.exec("update public.provider_settings set rapidapi_key='encrypted-test-value'");
    for(const actor of [owner,admin]){
      await assert.rejects(f.browser(actor,'select rapidapi_key from public.provider_settings'),e=>e.code==='42501');
      await assert.rejects(f.browser(actor,'select * from private.provider_monthly_usage'),e=>e.code==='42501');
      await assert.rejects(f.browser(actor,"update public.provider_settings set rapidapi_key='attack'"),e=>e.code==='42501');
      await assert.rejects(f.browser(actor,'select public.desk_provider_usage()'),e=>e.code==='42501');
    }
    assert.equal((await f.service('desk_provider_usage')).requests,1);
    await assertUsageMatchesLogs(f.db);
    await assert.rejects(f.service('desk_reserve_provider_request',['instagram-looter','instagram','/profile']),/not enabled/);
    await f.db.exec(`update public.provider_settings set provider_order=jsonb_set(provider_order,'{instagram}','["instagram-looter","tikhub"]')`);
    assert.equal(typeof await f.service('desk_reserve_provider_request',['instagram-looter','instagram','/profile']),'string');
    await assertUsageMatchesLogs(f.db);
    assert.equal(JSON.stringify(await f.service('desk_admin_provider_report',[admin])).includes('encrypted-test-value'),false);
  }finally{await f.close();}
});

test('monthly counters handle funding, cost, UTC month corrections, deletions, retention and rolled-back writes',async()=>{
  const f=await fixture(db=>db.exec(`update public.provider_settings set request_costs=request_costs||'{"instagram-looter":0.001}'::jsonb`));try{
    assert.equal((await f.db.query('select request_costs from public.provider_settings')).rows[0].request_costs['instagram-looter'],0.001,'migration preserves an existing operator cost estimate');
    const first=(await f.db.query(`insert into public.provider_requests(provider,platform,endpoint,created_at,estimated_cost_usd)
      values('tikhub','instagram','/profile','2026-01-31T23:30:00-02:00',0.003) returning id`)).rows[0].id;
    assert.equal((await f.db.query('select month::text from private.provider_monthly_usage')).rows[0].month,'2026-02-01');
    await assertUsageMatchesLogs(f.db);
    await f.db.query("update public.provider_requests set estimated_cost_usd=0.012,success=false where id=$1",[first]);
    await assertUsageMatchesLogs(f.db);
    await f.db.query("update public.provider_requests set funding='workspace' where id=$1",[first]);
    await assertUsageMatchesLogs(f.db);
    await f.db.query("update public.provider_requests set funding='platform',created_at='2026-03-01T02:00:00+05:30' where id=$1",[first]);
    await assertUsageMatchesLogs(f.db);
    await f.db.query("update public.provider_requests set created_at='2026-04-01T00:00:00Z',estimated_cost_usd=0.02 where id=$1",[first]);
    await assertUsageMatchesLogs(f.db);
    await f.db.query("update public.provider_requests set created_at=now()-interval '8 days',raw_response='{\"debug\":true}' where id=$1",[first]);
    const before=await f.db.query('select * from private.provider_monthly_usage order by month');
    assert.equal(await f.service('desk_cleanup_provider_logs'),1);
    assert.deepEqual((await f.db.query('select * from private.provider_monthly_usage order by month')).rows,before.rows,'retention does not refund requests');
    await assert.rejects(f.db.transaction(async tx=>{
      await tx.query("insert into public.provider_requests(provider,platform,endpoint,estimated_cost_usd) values('tikhub','instagram','/rollback',1)");
      throw new Error('rollback test');
    }),/rollback test/);
    await assertUsageMatchesLogs(f.db);
    await f.db.query('delete from public.provider_requests where id=$1',[first]);
    await assertUsageMatchesLogs(f.db);
    assert.equal((await f.service('desk_provider_usage')).requests,0);
    assert.equal((await f.service('desk_provider_usage')).estimatedCostUsd,0);
  }finally{await f.close();}
});

test('provider reservations still count failures, apply both caps, and serialize competing requests',async()=>{
  const f=await fixture();try{
    await f.db.exec(`update public.provider_settings set monthly_request_cap=2,monthly_budget_usd=0.03`);
    const paid=await f.service('desk_reserve_provider_request',['lamatok','tiktok','/profile']);
    await f.db.query('update public.provider_requests set success=false where id=$1',[paid]);
    assert.equal(await f.service('desk_reserve_provider_request',['lamatok','tiktok','/profile']),null);
    assert.equal(typeof await f.service('desk_reserve_provider_request',['youtube-official','youtube','/channels']),'string');
    assert.equal(await f.service('desk_reserve_provider_request',['youtube-official','youtube','/channels']),null);
    await f.db.exec('delete from public.provider_requests;update public.provider_settings set monthly_request_cap=3,monthly_budget_usd=25');
    const requests=await Promise.all(Array.from({length:8},()=>f.service('desk_reserve_provider_request',['lamatok','tiktok','/profile'])));
    assert.equal(requests.filter(Boolean).length,3);
    const usage=await f.service('desk_provider_usage');assert.equal(usage.requests,3);assert.equal(usage.estimatedCostUsd,0.06);
    await assert.rejects(f.service('desk_reserve_provider_request',['lamatok','instagram','/profile']),/DD400/);
    await assert.rejects(f.service('desk_reserve_provider_request',['lamatok','tiktok','/profile?api_key=secret']),/DD400/);
    await assertUsageMatchesLogs(f.db);
  }finally{await f.close();}
});

test('history, queue and retention queries use bounded ordered index scans on a populated workspace',async t=>{
  const f=await fixture();try{
    await f.db.exec(`
      insert into auth.users(id,email) select md5('perf-owner-'||i)::uuid,'perf'||i||'@example.test' from generate_series(1,20) i;
      insert into public.pages(id,owner,platform,handle,url,name,sync_error,last_synced_at)
      select md5('perf-page-'||i||'-'||j)::uuid,md5('perf-owner-'||i)::uuid,'instagram','perf_'||i||'_'||j,
        'https://instagram.com/perf_'||i||'_'||j,'Perf page',case when j=1 then 'retry' else null end,null
        from generate_series(1,20) i cross join generate_series(1,20) j;
      insert into public.page_posts(owner,page_id,post_id,payload,created_at)
        select p.owner,p.id,lpad(n::text,4,'0'),'{}','2026-01-01T00:00:00Z'
        from public.pages p cross join generate_series(1,40) n;
      insert into public.account_snapshots(owner,page_id,observed_at,followers)
        select p.owner,p.id,'2026-01-01T00:00:00Z'::timestamptz+n*interval '1 day',n
        from public.pages p cross join generate_series(1,60) n;
      insert into public.post_snapshots(owner,page_id,post_id,observed_at,views)
        select p.owner,p.id,lpad(n::text,4,'0'),'2026-01-01T00:00:00Z'::timestamptz+d*interval '1 day',n*d
        from public.pages p cross join generate_series(1,40) n cross join generate_series(1,3) d;
      insert into public.alerts(owner,page_id,type,level,title,created_at,resolved_at)
        select p.owner,p.id,'performance','amber','Check','2026-01-01T00:00:00Z'::timestamptz+n*interval '1 day',now()
        from public.pages p cross join generate_series(1,5) n;
      insert into public.collections(id,owner,name)
        select md5('perf-collection-'||i||'-'||j)::uuid,md5('perf-owner-'||i)::uuid,'Group'
        from generate_series(1,20) i cross join generate_series(1,4) j;
      insert into public.memberships(owner,page_id,collection_id)
        select p.owner,p.id,c.id from public.pages p join public.collections c on c.owner=p.owner;
      insert into public.tracked_accounts(platform,handle,last_attempt_at)
        select 'instagram','queue_'||i,now()-i*interval '1 minute' from generate_series(1,5000) i;
      insert into public.provider_requests(provider,platform,endpoint,funding,created_at,raw_response)
        select 'tikhub','instagram','/profile','workspace',now()-interval '8 days',case when i<=10 then '{}'::jsonb else null end
        from generate_series(1,15000) i;
      analyze;`);
    const tenant=(await f.db.query("select md5('perf-owner-1')::uuid id")).rows[0].id;
    const checks=[
      ['page_posts_owner_page_post_idx',`select * from public.page_posts where owner=$1 and created_at<='2026-04-01' order by page_id,post_id limit 20`,[tenant]],
      ['account_snapshots_owner_page_time_idx',`select * from public.account_snapshots where owner=$1 and observed_at between '2026-01-01' and '2026-04-01' order by page_id,observed_at limit 20`,[tenant]],
      ['post_snapshots_owner_page_time_post_idx',`select * from public.post_snapshots where owner=$1 and observed_at between '2026-01-01' and '2026-04-01' order by page_id,observed_at,post_id limit 20`,[tenant]],
      ['alerts_owner_created_id_idx',`select * from public.alerts where owner=$1 and created_at<='2026-04-01' order by created_at,id limit 20`,[tenant]],
      ['memberships_owner_collection_page_idx',`select collection_id,page_id from public.memberships where owner=$1 order by collection_id,page_id limit 20`,[tenant]],
      ['tracked_accounts_attempt_id_idx',`select id,last_attempt_at from public.tracked_accounts order by last_attempt_at nulls first,id limit 20`,[]],
      ['provider_requests_raw_retention_idx',`select id from public.provider_requests where raw_response is not null and created_at<now()-interval '7 days'`,[]],
      ['pages_failed_sync_idx',`select id,owner,sync_error,last_synced_at from public.pages where sync_error is not null and sync_error<>'' order by last_synced_at nulls first limit 100`,[]],
    ];
    for(const [index,sql,args] of checks){
      const result=await f.db.query('explain (analyze,format json) '+sql,args);
      const plan=result.rows[0]['QUERY PLAN'][0].Plan,serialized=JSON.stringify(plan);
      assert.ok(serialized.includes(index),index+' selected: '+serialized);
      assert.ok(!serialized.includes('"Node Type":"Sort"'),index+' avoids a full result sort');
      t.diagnostic(index+': '+plan['Node Type']+', '+plan['Actual Rows']+' rows returned');
    }
    const row=(await f.db.query('select id,tracked_account_id from public.pages where owner=$1 limit 1',[tenant])).rows[0];
    const subscribers=(await f.db.query('explain (format json) select id,owner,last_synced_at from public.pages where tracked_account_id=$1 and active=true order by id limit 20',[row.tracked_account_id])).rows[0]['QUERY PLAN'][0].Plan;
    assert.match(JSON.stringify(subscribers),/pages_active_tracked_id_idx/);
    for(const [table,ownRows,allRows] of [['page_posts',800,16000],['account_snapshots',1200,24000],['post_snapshots',2400,48000],['alerts',100,2000],['memberships',80,1600]]){
      assert.equal(Number((await f.browser(tenant,'select count(*) as total from public.'+table)).rows[0].total),ownRows,'normal users retain owner-only '+table+' access');
      assert.equal(Number((await f.browser(admin,'select count(*) as total from public.'+table)).rows[0].total),allRows,'database-admin access remains intact for '+table);
    }
    await assertUsageMatchesLogs(f.db);
  }finally{await f.close();}
});
