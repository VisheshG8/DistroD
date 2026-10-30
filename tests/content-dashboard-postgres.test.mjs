import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const page='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',paused='cccccccc-cccc-4ccc-8ccc-cccccccccccc',unseen='dddddddd-dddd-4ddd-8ddd-dddddddddddd',otherPage='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const earlier=['20261024000000_init.sql','20261024010000_sdk_operations.sql','20261024015000_sdk_admin.sql','20261024020000_sdk_legacy_import.sql','20261025000000_workspace_transfer.sql',
  '20261026000000_admin_directory.sql','20261026010000_analytics_history.sql','20261026015000_analytics_operations.sql','20261026020000_analytics_transfer.sql','20261026030000_instagram_looter_performance.sql'];
const migration=readFileSync(new URL('../supabase/migrations/20261029000000_content_dashboard.sql',import.meta.url),'utf8');
const indiaToday=()=>new Date(Date.now()+5.5*3600000).toISOString().slice(0,10);
const day=value=>value==null?null:value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
async function fixture(){
  const db=new PGlite();
  try{
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const file of earlier)await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    await db.query(`insert into auth.users(id,email) values($1,'one@example.test'),($2,'two@example.test')`,[owner,other]);
    // Existing rows before the upgrade: a refreshed page with no start date, an inactive page, one never refreshed.
    await db.query(`insert into public.pages(id,owner,platform,handle,url,name,last_synced_at,monthly_pay,active,posts)values
      ($1,$2,'youtube','one','https://youtube.com/@one','One','2026-09-10T20:00:00Z',1000,true,'[{"id":"p1","views":5},{"id":"p2","views":7}]'),
      ($3,$2,'youtube','paused','https://youtube.com/@paused','Paused','2026-10-01T20:00:00Z',2000,false,'[]'),
      ($4,$2,'youtube','unseen','https://youtube.com/@unseen','Unseen',null,null,true,'[]'),
      ($5,$6,'youtube','theirs','https://youtube.com/@theirs','Theirs','2026-09-01T00:00:00Z',null,true,'[{"id":"t1","views":1}]')`,[page,owner,paused,unseen,otherPage,other]);
    await db.query(`insert into public.account_snapshots(owner,page_id,observed_at,followers)values($1,$2,'2026-08-31T19:00:00Z',10)`,[owner,page]);
    await db.exec(migration);
    const service=async(name,args=[])=>db.transaction(async tx=>{await tx.exec('set local role service_role');return (await tx.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as result',args)).rows[0].result;});
    const browser=async(actor,sql,args=[])=>db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);await tx.exec('set local role authenticated');return tx.query(sql,args);});
    const row=async id=>(await db.query('select * from public.pages where id=$1',[id])).rows[0];
    return {db,service,browser,row,close:()=>db.close()};
  }catch(error){await db.close();throw error;}
}

test('content dashboard migration backfills start and end dates, is idempotent and keeps browser access read-only',async()=>{
  const f=await fixture();try{
    let one=await f.row(page);
    assert.equal(day(one.start_date),'2026-09-01','first recorded observation, as an India date');assert.equal(one.display_name,'');assert.equal(one.alert_quiet_days,null);assert.equal(one.end_date,null);
    assert.equal(day((await f.row(paused)).end_date),'2026-10-02','an inactive page ends pay on its last refresh day');
    assert.equal((await f.row(unseen)).start_date,null,'no evidence leaves the start date blank');
    await f.db.exec(migration);
    one=await f.row(page);assert.equal(day(one.start_date),'2026-09-01');assert.equal(day((await f.row(paused)).end_date),'2026-10-02','re-running changes nothing');
    await f.db.query(`insert into public.pages(owner,platform,handle,url,name)values($1,'youtube','fresh','https://youtube.com/@fresh','Fresh')`,[owner]);
    assert.equal(day((await f.db.query("select start_date from public.pages where handle='fresh'")).rows[0].start_date),indiaToday(),'new pages start pay on the day they are added');
    for(const [sql,args] of [[`update public.pages set display_name=$1 where id=$2`,['x'.repeat(151),page]],[`update public.pages set alert_quiet_days=0 where id=$1`,[page]],[`update public.pages set alert_quiet_days=61 where id=$1`,[page]]])
      await assert.rejects(f.db.query(sql,args),e=>e.code==='23514',sql);
    await f.db.query(`insert into public.alerts(owner,page_id,level,type,title)values($1,$2,'green','viral-post','Viral')`,[owner,page]);
    await assert.rejects(f.db.query(`update public.alerts set post_id='' where page_id=$1`,[page]),e=>e.code==='23514');
    assert.equal((await f.browser(owner,'select display_name,end_date,alert_quiet_days from public.pages')).rows.length,4,'owners read the new fields through the existing policy');
    assert.equal((await f.browser(other,'select id from public.pages')).rows.length,1);
    await assert.rejects(f.browser(owner,"update public.pages set display_name='Forged'"),e=>e.code==='42501');
    for(const sql of ["select public.desk_link_content($1,'[]'::jsonb,'unlink')","select public.desk_reconcile_alerts($1,'[]'::jsonb,now(),'[]'::jsonb)","select public.desk_add_managed_page($1,$1,'{}'::jsonb,'{}'::jsonb,null,true)"])
      await assert.rejects(f.browser(owner,sql,[owner]),e=>e.code==='42501',sql);
  }finally{await f.close();}
});

test('deactivating a page ends its pay today, an explicit end date wins and reactivating clears it',async()=>{
  const f=await fixture();try{
    await f.db.query('update public.pages set active=false where id=$1',[page]);
    assert.equal(day((await f.row(page)).end_date),indiaToday());
    await f.db.query("update public.pages set notes='edited',active=false where id=$1",[page]);assert.equal(day((await f.row(page)).end_date),indiaToday(),'saving an inactive page keeps its end date');
    await f.db.query('update public.pages set active=true where id=$1',[page]);assert.equal((await f.row(page)).end_date,null);
    await f.db.query("update public.pages set active=false,end_date='2026-10-05' where id=$1",[page]);assert.equal(day((await f.row(page)).end_date),'2026-10-05');
    await f.db.query("update public.pages set active=true,start_date='2099-01-01' where id=$1",[page]);await f.db.query('update public.pages set active=false where id=$1',[page]);
    assert.equal((await f.row(page)).end_date,null,'a page whose pay has not started yet gets no end date');
  }finally{await f.close();}
});

test('managed page overload reports an existing page and fills only its blank details',async()=>{
  const f=await fixture();try{
    const pageJson=JSON.stringify({platform:'youtube',handle:'one',url:'https://youtube.com/@one'});
    let result=await f.service('desk_add_managed_page',[owner,owner,pageJson,JSON.stringify({monthly_pay:5,editor:'Asha',notes:'typed',display_name:'Page A',alert_quiet_days:3,start_date:'2026-01-01'}),null,true]);
    assert.equal(result.pageId,page);assert.equal(result.existed,true);assert.equal(new Date(result.lastSyncedAt).toISOString(),'2026-09-10T20:00:00.000Z');
    const one=await f.row(page);assert.equal(Number(one.monthly_pay),1000,'saved pay is kept');assert.equal(one.editor,'Asha');assert.equal(one.notes,'typed');assert.equal(one.display_name,'Page A');assert.equal(one.alert_quiet_days,3);assert.equal(day(one.start_date),'2026-09-01');
    result=await f.service('desk_add_managed_page',[owner,owner,pageJson,JSON.stringify({editor:'Other',display_name:'Renamed'}),null,true]);
    assert.equal((await f.row(page)).editor,'Asha');assert.equal((await f.row(page)).display_name,'Page A');
    result=await f.service('desk_add_managed_page',[owner,owner,JSON.stringify({platform:'tiktok',handle:'newbie',url:'https://www.tiktok.com/@newbie'}),JSON.stringify({display_name:'Page B',alert_quiet_days:10,active:false}),null,true]);
    assert.equal(result.existed,false);assert.equal(result.lastSyncedAt,null);
    const created=await f.row(result.pageId);assert.equal(created.display_name,'Page B');assert.equal(created.alert_quiet_days,10);assert.equal(day(created.start_date),indiaToday());assert.equal(created.active,false);
    assert.equal(typeof await f.service('desk_add_managed_page',[owner,owner,pageJson,'{}',null]),'string','the five-argument call still returns the page ID');
    for(const metadata of [{alert_quiet_days:0},{alert_quiet_days:61},{alert_quiet_days:2.5},{alert_quiet_days:'3'},{display_name:'x'.repeat(151)},{display_name:4},{end_date:'2026/10/01'},{start_date:'2026-10-02',end_date:'2026-10-01'}])
      await assert.rejects(f.service('desk_add_managed_page',[owner,owner,pageJson,JSON.stringify(metadata),null,true]),/DD400/,JSON.stringify(metadata));
  }finally{await f.close();}
});

test('alert reconciliation keeps unchecked pages open, stores viral post IDs and keeps the old signature',async()=>{
  const f=await fixture();try{
    const viral={pageId:page,type:'viral-post',level:'green',title:'Viral post',details:'12x',postId:'p2'},quiet={pageId:paused,type:'no-posts',level:'red',title:'No post in 7 days',details:''};
    const check=(time,candidates,skip=[])=>f.service('desk_reconcile_alerts',[owner,JSON.stringify(candidates),time,JSON.stringify(skip)]);
    await check('2026-10-10T10:00:00Z',[viral,quiet]);assert.deepEqual(await check('2026-10-11T10:00:00Z',[viral,quiet]),{opened:2,resolved:0});
    assert.equal((await f.db.query("select post_id from public.alerts where type='viral-post'")).rows[0].post_id,'p2');
    await check('2026-10-11T12:00:00Z',[{...viral,postId:'p1'},quiet]);assert.equal((await f.db.query("select post_id from public.alerts where type='viral-post'")).rows[0].post_id,'p1','an open alert follows the strongest post');
    assert.deepEqual(await check('2026-10-12T10:00:00Z',[],[paused.toUpperCase()]),{opened:0,resolved:1},'only the checked page resolves');
    const open=(await f.db.query('select page_id from public.alerts where resolved_at is null')).rows;assert.deepEqual(open.map(r=>r.page_id),[paused]);
    assert.equal((await f.db.query("select checks from private.alert_checks where page_id=$1",[paused])).rows[0].checks,2,'an unchecked page keeps its check count');
    assert.deepEqual(await f.service('desk_reconcile_alerts',[owner,'[]','2026-10-13T10:00:00Z']),{opened:0,resolved:1},'the three-argument call checks every page');
    for(const skip of [['not-a-page'],[1],'{}'])await assert.rejects(f.service('desk_reconcile_alerts',[owner,'[]','2026-10-14T10:00:00Z',JSON.stringify(skip)]),/DD400/);
    for(const postId of ['',7,'x'.repeat(301)])await assert.rejects(check('2026-10-14T10:00:00Z',[{...viral,postId}]),/DD400/);
  }finally{await f.close();}
});

test('content links group posts across pages, one per page, only inside the owner workspace',async()=>{
  const f=await fixture();try{
    const second=(await f.service('desk_add_managed_page',[owner,owner,JSON.stringify({platform:'tiktok',handle:'two',url:'https://www.tiktok.com/@two'}),'{}',null,true])).pageId;
    await f.db.query(`insert into public.page_posts(owner,page_id,post_id,payload)values($1,$2,'s1','{}'),($1,$2,'s2','{}')`,[owner,second]);
    const link=(posts,mode,group=null,actor=owner)=>f.service('desk_link_content',[actor,JSON.stringify(posts),mode,group]);
    const asset=async(pageId,postId)=>(await f.db.query('select source_asset_id from public.page_posts where page_id=$1 and post_id=$2',[pageId,postId])).rows[0].source_asset_id;
    const made=await link([{pageId:page,postId:'p1'},{pageId:second,postId:'s1'}],'group');
    assert.match(made.groupId,/^ca_[0-9a-f-]{36}$/);assert.equal(made.linked,2);assert.equal(await asset(page,'p1'),made.groupId);assert.equal(await asset(second,'s1'),made.groupId);
    await assert.rejects(link([{pageId:second,postId:'s2'}],'group',made.groupId),/DD409/,'a group holds one post per page');
    assert.deepEqual(await link([{pageId:second,postId:'s2'},{pageId:second,postId:'s1'}],'solo'),{groupId:null,linked:2});
    assert.match(await asset(second,'s2'),/^solo_/);assert.notEqual(await asset(second,'s1'),await asset(second,'s2'));
    assert.equal((await link([{pageId:second,postId:'s1'}],'group',made.groupId)).groupId,made.groupId,'a post joins an existing group');
    await f.db.query("update public.pages set posts='[{\"id\":\"p1\",\"views\":9}]',last_synced_at='2026-10-20T00:00:00Z' where id=$1",[page]);
    assert.equal(await asset(page,'p1'),made.groupId,'a later refresh keeps the confirmed link');
    await link([{pageId:page,postId:'p1'}],'unlink');assert.equal(await asset(page,'p1'),null);
    await assert.rejects(link([{pageId:otherPage,postId:'t1'}],'unlink'),/DD404/,'another workspace post is never found');
    await assert.rejects(link([{pageId:page,postId:'p2'}],'group',made.groupId,other),/DD404/,'another owner cannot join or probe a group');
    await f.db.query("update public.page_posts set source_asset_id='ca_00000000-0000-4000-8000-000000000000' where page_id=$1",[otherPage]);
    await assert.rejects(link([{pageId:page,postId:'p2'}],'group','ca_00000000-0000-4000-8000-000000000000'),/DD404/);
    for(const [posts,mode,group] of [[[],'group'],[[{pageId:page,postId:'p1'}],'merge'],[[{pageId:page,postId:'p1'},{pageId:page,postId:'p1'}],'group'],[[{pageId:'bad',postId:'p1'}],'group'],[[{pageId:page,postId:''}],'group'],[[{pageId:page,postId:'p1'}],'solo',made.groupId],[[{pageId:page,postId:'p1'}],'group','ca_demo-1']])
      await assert.rejects(link(posts,mode,group??null),/DD400/,JSON.stringify([posts,mode,group]));
    assert.equal(await asset(otherPage,'t1'),'ca_00000000-0000-4000-8000-000000000000','failed calls change nothing');
  }finally{await f.close();}
});
