import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {testSupabase} from './helpers/supabase-fixture.mjs';

test('analytics workspace backups preserve portable owner-scoped history atomically',async t=>{
  const pg=new PGlite();
  try{
    await pg.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const name of ['20261024000000_init.sql','20261024010000_sdk_operations.sql','20261024015000_sdk_admin.sql','20261024020000_sdk_legacy_import.sql','20261025000000_workspace_transfer.sql','20261026000000_admin_directory.sql','20261026010000_analytics_history.sql','20261026015000_analytics_operations.sql','20261026020000_analytics_transfer.sql','20261026030000_instagram_looter_performance.sql','20261029000000_content_dashboard.sql'])
      await pg.exec(readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    const {client}=testSupabase(pg);
    const call=async(owner,action,job=null,data={})=>{const response=await client.rpc('desk_workspace_transfer',{p_owner:owner,p_action:action,p_job:job,p_data:data});if(response.error)throw Object.assign(new Error(response.error.message),response.error);return response.data;};
    const user=async()=>{const id=randomUUID();await pg.query('insert into auth.users(id,email) values($1,$2)',[id,id+'@example.test']);return id;};
    const source=await user(),destination=await user(),stranger=await user(),page=randomUUID(),collection=randomUUID(),alert=randomUUID();
    const post={id:'video-one',pageId:page,platform:'youtube',title:'A saved post',url:'https://www.youtube.com/watch?v=video-one',publishedAt:'2026-10-10T00:00:00Z',thumbnail:null,views:100,likes:0,comments:null,shares:null,saves:null,durationSeconds:30,type:'video'};
    await pg.query('insert into public.collections(id,owner,name) values($1,$2,$3)',[collection,source,'Historical collection']);
    await pg.query(`insert into public.pages(id,owner,platform,handle,name,url,followers,posts,coverage,overall,last_synced_at,monthly_pay,editor,start_date,active,notes)
      values($1,$2,'youtube','transfer-demo','Transfer demo','https://www.youtube.com/@transfer-demo',100,$3,'{"complete":true,"limit":30,"fetched":1}','{"posts":1,"followers":100}','2026-10-20T00:00:00Z',2500.50,'Editor name','2026-09-03',false,'Keep these notes')`,[page,source,JSON.stringify([post])]);
    await pg.query('insert into public.memberships values($1,$2,$3)',[collection,page,source]);
    await pg.query(`update public.pages set followers=120,posts=$1,last_synced_at='2026-10-20T12:00:00Z' where id=$2`,[JSON.stringify([{...post,views:200}]),page]);
    await pg.query(`insert into public.account_snapshots(owner,page_id,observed_at,followers,following,post_count) values($1,$2,'2026-10-19T00:00:00Z',80,10,1)`,[source,page]);
    await pg.query(`insert into public.post_snapshots(owner,page_id,post_id,observed_at,views,likes,comments,shares,saves) values($1,$2,'video-one','2026-10-19T00:00:00Z',70,0,NULL,NULL,NULL)`,[source,page]);
    await pg.query(`update public.page_posts set source_asset_id='source-video-a' where page_id=$1`,[page]);
    await pg.query(`insert into public.alerts(id,owner,page_id,level,type,title,details,created_at,last_seen_at) values($1,$2,$3,'red','low-views','Views need attention','Two checks confirmed a decline.','2026-10-20T12:00:00Z','2026-10-20T12:00:00Z')`,[alert,source,page]);
    await pg.query(`update public.pages set display_name='Page A',alert_quiet_days=4,end_date='2026-10-15' where id=$1`,[page]);
    await pg.query(`update public.alerts set post_id='video-one' where id=$1`,[alert]);
    const upload=async(owner,value)=>{const bytes=Buffer.from(JSON.stringify(value));const start=await call(owner,'begin_import',null,{bytes:bytes.length});for(let index=0;index<start.total;index++)await call(owner,'upload',start.job,{index,chunk:bytes.subarray(index*524288,(index+1)*524288).toString('base64')});return start.job;};
    const exporting=async owner=>{const start=await call(owner,'begin_export'),chunks=[];for(let index=0;index<start.total;index++)chunks.push(Buffer.from((await call(owner,'read_export',start.job,{index})).chunk,'base64'));await call(owner,'cancel',start.job);return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
    let archive,targetPage;

    await t.test('one archive contains metadata, cumulative posts, actual history and alerts without global configuration',async()=>{
      archive=await exporting(source);
      assert.equal(archive.version,1);assert.equal(archive.workspace.analytics.version,1);
      const p=archive.workspace.pages[0];assert.equal(p.monthly_pay,2500.5);assert.equal(p.editor,'Editor name');assert.equal(p.start_date,'2026-09-03');assert.equal(p.active,false);assert.equal(p.notes,'Keep these notes');
      assert.equal(p.display_name,'Page A');assert.equal(p.alert_quiet_days,4);assert.equal(p.end_date,'2026-10-15');
      const h=archive.workspace.analytics;assert.equal(h.pagePosts.length,1);assert.equal(h.pagePosts[0].source_asset_id,'source-video-a');assert.equal(h.accountSnapshots.length,2);assert.equal(h.postSnapshots.length,2);assert.equal(h.alerts.length,1);assert.equal(h.alerts[0].post_id,'video-one');
      assert.equal(h.accountSnapshots.find(row=>row.observed_at.startsWith('2026-10-20')).followers,100,'same-day first observation remains real');
      const text=JSON.stringify(archive);for(const field of ['"owner"','tracked_account_id','provider_requests','provider_settings','latest_payload','sample_day','api_key','youtube_key'])assert.ok(!text.includes(field),field);
    });
    await t.test('restore remaps all owners and IDs, including the first observation on the latest snapshot day',async()=>{
      const job=await upload(destination,archive),preview=await call(destination,'preview',job);
      assert.equal(preview.summary.historyPosts,1);assert.equal(preview.summary.accountSnapshots,2);assert.equal(preview.summary.postSnapshots,2);assert.equal(preview.summary.alerts,1);
      assert.equal((await pg.query('select id from public.pages where owner=$1',[destination])).rows.length,0);
      await assert.rejects(call(stranger,'apply',job),/unavailable/);
      const result=await call(destination,'apply',job);targetPage=result.pageMap[0].target;
      assert.notEqual(targetPage,page);
      const p=(await pg.query('select * from public.pages where id=$1',[targetPage])).rows[0];assert.equal(Number(p.monthly_pay),2500.5);assert.equal(p.editor,'Editor name');assert.equal(p.active,false);assert.equal(p.notes,'Keep these notes');
      assert.equal(p.display_name,'Page A');assert.equal(p.alert_quiet_days,4);assert.equal(new Date(p.end_date).toISOString().slice(0,10),'2026-10-15','an inactive page keeps its own pay end date, not the import day');
      const stored=(await pg.query('select * from public.page_posts where owner=$1',[destination])).rows[0];assert.equal(stored.page_id,targetPage);assert.equal(stored.payload.pageId,targetPage);assert.equal(stored.source_asset_id,'source-video-a');
      const first=(await pg.query("select * from public.account_snapshots where page_id=$1 and sample_day='2026-10-20'",[targetPage])).rows[0];assert.equal(Number(first.followers),100);assert.equal(new Date(first.observed_at).toISOString(),'2026-10-20T00:00:00.000Z');
      const a=(await pg.query('select * from public.alerts where owner=$1',[destination])).rows[0];assert.notEqual(a.id,alert);assert.equal(a.page_id,targetPage);assert.equal(a.transfer_id,archive.workspace.analytics.alerts[0].transfer_id);assert.equal(a.post_id,'video-one');
      assert.deepEqual(await call(destination,'apply',job),result,'a network retry is idempotent');
      assert.equal((await pg.query('select id from public.alerts where owner=$1',[source])).rows[0].id,alert);
    });
    await t.test('repeated imports keep matching values by default and overwrite only when selected',async()=>{
      const changed=structuredClone(archive);changed.workspace.pages[0].monthly_pay=999;changed.workspace.analytics.accountSnapshots[0].followers=999;changed.workspace.analytics.pagePosts[0].payload.views=999;changed.workspace.analytics.alerts[0].title='Imported replacement';
      let job=await upload(destination,changed);await call(destination,'preview',job);await call(destination,'apply',job);
      assert.equal(Number((await pg.query('select monthly_pay from public.pages where id=$1',[targetPage])).rows[0].monthly_pay),2500.5);
      assert.equal((await pg.query('select payload from public.page_posts where page_id=$1',[targetPage])).rows[0].payload.views,200);
      assert.equal((await pg.query('select title from public.alerts where owner=$1',[destination])).rows[0].title,'Views need attention');
      job=await upload(destination,changed);await call(destination,'preview',job);await call(destination,'apply',job,{overwrite:true});
      assert.equal(Number((await pg.query('select monthly_pay from public.pages where id=$1',[targetPage])).rows[0].monthly_pay),999);
      assert.equal((await pg.query('select payload from public.page_posts where page_id=$1',[targetPage])).rows[0].payload.views,999);
      assert.equal((await pg.query('select title from public.alerts where owner=$1',[destination])).rows[0].title,'Imported replacement');
      assert.equal((await pg.query('select * from public.alerts where owner=$1',[destination])).rows.length,1);
      assert.equal((await pg.query('select * from public.account_snapshots where owner=$1',[destination])).rows.length,2);
    });
    await t.test('old version-1 files still import without resetting newer metadata',async()=>{
      const old=structuredClone(archive);delete old.workspace.analytics;for(const key of ['monthly_pay','editor','start_date','active','notes','display_name','alert_quiet_days','end_date'])delete old.workspace.pages[0][key];
      const job=await upload(destination,old);await call(destination,'preview',job);await call(destination,'apply',job,{overwrite:true});
      assert.equal(Number((await pg.query('select monthly_pay from public.pages where id=$1',[targetPage])).rows[0].monthly_pay),999);
      assert.equal((await pg.query('select display_name,alert_quiet_days from public.pages where id=$1',[targetPage])).rows[0].display_name,'Page A','older backups leave the newer Page Master fields alone');
      for(const [key,value] of [['alert_quiet_days',0],['alert_quiet_days',2.5],['display_name','x'.repeat(151)],['end_date','2026-02-30']]){
        const bad=structuredClone(archive);bad.workspace.pages[0][key]=value;const badJob=await upload(destination,bad);
        await assert.rejects(call(destination,'preview',badJob),/Quiet-day|display names|end date/,key);await call(destination,'cancel',badJob);
      }
      const paused=structuredClone(archive);delete paused.workspace.analytics;delete paused.workspace.pages[0].end_date;
      const pausedJob=await upload(destination,paused);await call(destination,'preview',pausedJob);await call(destination,'apply',pausedJob,{overwrite:true});
      assert.equal(new Date((await pg.query('select end_date from public.pages where id=$1',[targetPage])).rows[0].end_date).toISOString().slice(0,10),'2026-10-15','an older backup keeps the end date of a page that was already paused');
      const fresh=await user(),freshJob=await upload(fresh,old);await call(fresh,'preview',freshJob);await call(fresh,'apply',freshJob);
      assert.equal((await pg.query('select * from public.pages where owner=$1',[fresh])).rows.length,1);
    });
    await t.test('overwriting a matching active alert preserves its imported identity when it later resolves',async()=>{
      const fresh=await user();let job=await upload(fresh,archive);await call(fresh,'preview',job);await call(fresh,'apply',job);
      const existing=(await pg.query('select id from public.alerts where owner=$1',[fresh])).rows[0].id;
      await pg.query('update public.alerts set transfer_id=$1 where id=$2',[randomUUID(),existing]);
      job=await upload(fresh,archive);await call(fresh,'preview',job);await call(fresh,'apply',job,{overwrite:true});
      assert.equal((await pg.query('select transfer_id from public.alerts where id=$1',[existing])).rows[0].transfer_id,archive.workspace.analytics.alerts[0].transfer_id);
      const resolved=structuredClone(archive);resolved.workspace.analytics.alerts[0].resolved_at='2026-10-21T00:00:00Z';
      job=await upload(fresh,resolved);await call(fresh,'preview',job);await call(fresh,'apply',job,{overwrite:true});
      const rows=(await pg.query('select id,resolved_at from public.alerts where owner=$1',[fresh])).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].id,existing);assert.equal(new Date(rows[0].resolved_at).toISOString(),'2026-10-21T00:00:00.000Z');
    });
    await t.test('a matching page removed after preview is restored with its full metadata and history',async()=>{
      const fresh=await user();let job=await upload(fresh,archive);await call(fresh,'preview',job);const initial=await call(fresh,'apply',job),id=initial.pageMap[0].target;
      job=await upload(fresh,archive);await call(fresh,'preview',job);await pg.query('delete from public.pages where owner=$1',[fresh]);
      const restored=await call(fresh,'apply',job);assert.equal(restored.pageMap[0].isNew,true);
      const p=(await pg.query('select * from public.pages where owner=$1',[fresh])).rows[0];assert.equal(p.id,id);assert.equal(Number(p.monthly_pay),2500.5);assert.equal(p.transfer_id,archive.workspace.pages[0].transfer_id);
      assert.equal(Number((await pg.query("select followers from public.account_snapshots where page_id=$1 and sample_day='2026-10-20'",[id])).rows[0].followers),100);
    });
    await t.test('invalid history, duplicate days, forged references and metadata reject during preview',async()=>{
      const fresh=await user();const cases=[];
      let bad=structuredClone(archive);bad.workspace.analytics.accountSnapshots[0].followers=-1;cases.push(bad);
      bad=structuredClone(archive);bad.workspace.analytics.postSnapshots[0].views='42';cases.push(bad);
      bad=structuredClone(archive);bad.workspace.analytics.accountSnapshots[0].observed_at='2026-10-20';cases.push(bad);
      bad=structuredClone(archive);bad.workspace.analytics.pagePosts[0].page_id=randomUUID();cases.push(bad);
      bad=structuredClone(archive);bad.workspace.analytics.accountSnapshots.push(bad.workspace.analytics.accountSnapshots[0]);cases.push(bad);
      bad=structuredClone(archive);bad.workspace.pages[0].monthly_pay=12.345;cases.push(bad);
      bad=structuredClone(archive);bad.workspace.pages[0].active='false';cases.push(bad);
      for(const item of cases){const job=await upload(fresh,item);await assert.rejects(call(fresh,'preview',job),/DD400/);await call(fresh,'cancel',job);}
      assert.equal((await pg.query('select id from public.pages where owner=$1',[fresh])).rows.length,0);
    });
    await t.test('analytics apply failures roll back the entire import and leave global cache untouched',async()=>{
      const fresh=await user(),job=await upload(fresh,archive);await call(fresh,'preview',job);
      const cacheBefore=(await pg.query('select id,latest_payload from public.tracked_accounts order by id')).rows;
      await pg.exec(`create function private.reject_test_alert() returns trigger language plpgsql as $$begin raise exception 'Test alert failure';end$$;
        create trigger reject_test_alert before insert on public.alerts for each row execute function private.reject_test_alert();`);
      await assert.rejects(call(fresh,'apply',job),/Test alert failure/);
      await pg.exec('drop trigger reject_test_alert on public.alerts;drop function private.reject_test_alert();');
      assert.equal((await pg.query('select id from public.pages where owner=$1',[fresh])).rows.length,0);
      assert.equal((await pg.query('select id from public.collections where owner=$1',[fresh])).rows.length,0);
      assert.equal((await pg.query('select * from public.account_snapshots where owner=$1',[fresh])).rows.length,0);
      assert.deepEqual((await pg.query('select id,latest_payload from public.tracked_accounts order by id')).rows,cacheBefore);
      assert.equal((await pg.query('select state from private.workspace_transfers where id=$1',[job])).rows[0].state,'ready');
      await call(fresh,'apply',job);
    });
    await t.test('browser roles cannot invoke transfer internals or promote an owner through a backup',async()=>{
      for(const role of ['anon','authenticated']){
        await assert.rejects(pg.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select public.desk_workspace_transfer($1,'begin_export')",[source]);}),/permission denied/);
        await assert.rejects(pg.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select private.desk_workspace_transfer_v1($1,'begin_export')",[source]);}),/permission denied/);
      }
      const fresh=await user(),forged=structuredClone(archive);forged.workspace.pages[0].owner=source;forged.workspace.pages[0].tracked_account_id=randomUUID();forged.workspace.users=[{id:fresh,user_type:'admin'}];
      const job=await upload(fresh,forged);await call(fresh,'preview',job);await call(fresh,'apply',job);
      assert.equal((await pg.query('select user_type from public.users where id=$1',[fresh])).rows[0].user_type,'user');
      const restored=(await pg.query('select owner,tracked_account_id from public.pages where owner=$1',[fresh])).rows[0];assert.equal(restored.owner,fresh);assert.notEqual(restored.tracked_account_id,forged.workspace.pages[0].tracked_account_id);
    });
  }finally{await pg.close();}
});
