import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const c1='10000000-0000-4000-8000-000000000001',c2='10000000-0000-4000-8000-000000000002',c3='10000000-0000-4000-8000-000000000003';
const source='20000000-0000-4000-8000-000000000001',target='20000000-0000-4000-8000-000000000002',foreign='20000000-0000-4000-8000-000000000003';
const lease=1792843500000;
const snapshot={name:'Refreshed',followers:null,posts:[{id:'post',pageId:source,views:0,likes:4,comments:null,shares:null}],coverage:{complete:true,limit:30},overall:null,provider:'test',last_synced_at:'2026-10-24T12:00:00Z',canonical_id:'native-id'};
async function fixture(){
  const db=new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;`);
  for(const migration of ['20261024000000_init.sql','20261024010000_sdk_operations.sql'])
    await db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  await db.query(`insert into auth.users(id,email) values($1,'one@example.test'),($2,'two@example.test')`,[a,b]);
  await db.query(`insert into public.collections(id,owner,name) values($1,$4,'One'),($2,$4,'Two'),($3,$5,'Other')`,[c1,c2,c3,a,b]);
  await db.query(`insert into public.pages(id,owner,platform,handle,url,name,posts,locked_until)
    values($1,$3,'youtube','source','https://youtube.com/@source','Source','[{"views":11}]',$5),
    ($2,$4,'youtube','foreign','https://youtube.com/@foreign','Foreign','[{"views":99}]',$5)`,[source,foreign,a,b,lease]);
  await db.query('insert into public.memberships(collection_id,page_id,owner) values($1,$3,$5),($2,$4,$6)',[c1,c3,source,foreign,a,b]);
  await db.exec('set role service_role');
  const count=async table=>Number((await db.query(`select count(*) as n from public.${table}`)).rows[0].n);
  const call=async(name,values)=>{
    const result=await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) as result`,values);
    return result.rows[0].result;
  };
  const alias=async()=>{
    await db.query(`insert into public.pages(id,owner,platform,handle,url,name,posts,canonical_id,locked_until)
      values($1,$2,'youtube','target','https://youtube.com/@target','Target','[{"views":7}]','native-id',$3)`,[target,a,lease]);
    await db.query('insert into public.memberships(collection_id,page_id,owner) values($1,$2,$3)',[c2,target,a]);
  };
  return {db,call,count,alias,close:()=>db.close()};
}

test('SDK operations are granted only to the backend role, with invoker privileges and fixed search paths',async()=>{
  const f=await fixture();try{
    const rows=(await f.db.query(`select proname,prosecdef,proconfig,
      has_function_privilege('anon',oid,'execute') as anon,
      has_function_privilege('authenticated',oid,'execute') as authenticated,
      has_function_privilege('service_role',oid,'execute') as backend
      from pg_proc where pronamespace='public'::regnamespace and proname like 'desk_%'`)).rows;
    assert.equal(rows.length,7);
    for(const row of rows){assert.equal(row.anon,false,row.proname);assert.equal(row.authenticated,false,row.proname);assert.equal(row.backend,true,row.proname);assert.equal(row.prosecdef,false,row.proname);assert.ok(row.proconfig.some(value=>value.startsWith('search_path=')),row.proname);}
    for(const role of ['anon','authenticated']){
      await f.db.exec('reset role; set role '+role);
      await assert.rejects(f.call('desk_reserve_usage',[a,'2026-10',1]),error=>error.code==='42501');
      await assert.rejects(f.db.query('select api_key from public.settings'),error=>error.code==='42501');
    }
  }finally{await f.close();}
});

test('collection duplication shares pages and removal deletes only unreferenced owned pages',async()=>{
  const f=await fixture();try{
    const copy='10000000-0000-4000-8000-000000000004';
    assert.equal(await f.call('desk_duplicate_collection',[a,c1,'Copy',copy]),copy);
    assert.equal(await f.count('pages'),2);
    assert.equal((await f.db.query('select count(*) as n from public.memberships where page_id=$1',[source])).rows[0].n,2);
    await f.call('desk_remove_page',[a,c1,source]);
    assert.equal((await f.db.query('select id from public.pages where id=$1',[source])).rows.length,1);
    await f.call('desk_delete_collection',[a,copy]);
    assert.equal((await f.db.query('select id from public.pages where id=$1',[source])).rows.length,0);
    assert.equal((await f.db.query('select id from public.pages where id=$1',[foreign])).rows.length,1);
    assert.equal((await f.db.query('select id from public.collections where id=$1',[c3])).rows.length,1);
  }finally{await f.close();}
});

test('collection and page mutations reject records owned by another workspace',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.call('desk_delete_collection',[a,c3]),/DD404:Collection not found/);
    await assert.rejects(f.call('desk_duplicate_collection',[a,c3,'Copy','10000000-0000-4000-8000-000000000004']),/DD404:Collection not found/);
    await assert.rejects(f.call('desk_remove_page',[a,c1,foreign]),/DD404:Page not found/);
    await assert.rejects(f.call('desk_add_page',[a,c3,'youtube','new','https://youtube.com/@new']),/DD404:Collection not found/);
    assert.equal(await f.count('pages'),2);assert.equal(await f.count('collections'),3);assert.equal(await f.count('memberships'),2);
  }finally{await f.close();}
});

test('create and duplicate enforce the collection limit without partial writes',async()=>{
  const f=await fixture();try{
    await f.db.query(`insert into public.collections(owner,name) select $1,'Extra '||n from generate_series(1,98) n`,[a]);
    const id='10000000-0000-4000-8000-000000000004';
    await assert.rejects(f.call('desk_create_collection',[a,'Overflow',id]),/DD400:You can save up to 100 collections/);
    await assert.rejects(f.call('desk_duplicate_collection',[a,c1,'Overflow',id]),/DD400:You can save up to 100 collections/);
    assert.equal((await f.db.query('select count(*) as n from public.collections where owner=$1',[a])).rows[0].n,100);
    assert.equal((await f.db.query('select count(*) as n from public.memberships where collection_id=$1',[id])).rows[0].n,0);
  }finally{await f.close();}
});

test('adding pages is idempotent across collections and enforces the unique-page cap',async()=>{
  const f=await fixture();try{
    assert.equal(await f.call('desk_add_page',[a,c1,'youtube','source','https://youtube.com/@source']),0);
    assert.equal(await f.call('desk_add_page',[a,c2,'youtube','source','https://youtube.com/@source']),1);
    assert.equal(await f.call('desk_add_page',[a,c2,'youtube','source','https://youtube.com/@source']),0);
    await f.db.query(`insert into public.pages(owner,platform,handle,url,name)
      select $1,'youtube','extra'||n,'https://youtube.com/@extra'||n,'Extra '||n from generate_series(1,499) n`,[a]);
    await assert.rejects(f.call('desk_add_page',[a,c1,'youtube','overflow','https://youtube.com/@overflow']),/DD400:This workspace can track up to 500 unique pages/);
    assert.equal((await f.db.query('select count(*) as n from public.pages where owner=$1',[a])).rows[0].n,500);
    assert.equal(await f.call('desk_add_page',[a,c1,'youtube','source','https://youtube.com/@source']),0);
  }finally{await f.close();}
});

test('quota reservations never exceed the cap and reject invalid months and limits',async()=>{
  const f=await fixture();try{
    const results=await Promise.all(Array.from({length:6},()=>f.call('desk_reserve_usage',[a,'2026-10',3])));
    assert.equal(results.filter(Boolean).length,3);
    assert.equal(Number((await f.db.query('select requests from public.usage where owner=$1 and month=$2',[a,'2026-10'])).rows[0].requests),3);
    await assert.rejects(f.call('desk_reserve_usage',[a,'2026-11',0]),/DD400/);
    await assert.rejects(f.call('desk_reserve_usage',[a,'2026-13',2]),/DD400/);
    assert.equal(await f.count('usage'),1);
  }finally{await f.close();}
});

test('refresh saves JSON snapshots while preserving manual zero and unavailable counters',async()=>{
  const f=await fixture();try{
    assert.equal(await f.call('desk_save_refresh',[a,source,source,lease,snapshot]),source);
    const row=(await f.db.query('select * from public.pages where id=$1',[source])).rows[0];
    assert.equal(row.name,'Refreshed');assert.equal(row.followers,null);assert.equal(row.posts[0].views,0);assert.equal(row.posts[0].shares,null);assert.equal(row.overall,null);assert.equal(Number(row.locked_until),0);assert.equal(row.canonical_id,'native-id');
    await assert.rejects(f.call('desk_save_refresh',[a,source,source,lease,snapshot]),/DD409/);
  }finally{await f.close();}
});

test('alias refresh saves the canonical page and moves all memberships in one transaction',async()=>{
  const f=await fixture();try{
    await f.alias();
    assert.equal(await f.call('desk_save_refresh',[a,source,target,lease,{...snapshot,posts:[{...snapshot.posts[0],pageId:target}]}]),target);
    assert.equal((await f.db.query('select id from public.pages where id=$1',[source])).rows.length,0);
    const rows=(await f.db.query('select page_id from public.memberships where owner=$1 order by collection_id',[a])).rows;
    assert.equal(rows.length,2);assert.ok(rows.every(row=>row.page_id===target));
    const saved=(await f.db.query('select posts,locked_until from public.pages where id=$1',[target])).rows[0];
    assert.equal(saved.posts[0].pageId,target);assert.equal(Number(saved.locked_until),0);
  }finally{await f.close();}
});

test('lost leases and cross-owner target pages leave snapshots and memberships untouched',async()=>{
  const f=await fixture();try{
    await f.alias();await f.db.query('update public.pages set locked_until=0 where id=$1',[source]);
    await assert.rejects(f.call('desk_save_refresh',[a,source,target,lease,snapshot]),/DD409/);
    await f.db.query('update public.pages set locked_until=$1 where id=$2',[lease,source]);
    await assert.rejects(f.call('desk_save_refresh',[a,source,foreign,lease,snapshot]),/DD409/);
    assert.equal((await f.db.query('select posts from public.pages where id=$1',[target])).rows[0].posts[0].views,7);
    assert.equal((await f.db.query('select posts from public.pages where id=$1',[foreign])).rows[0].posts[0].views,99);
    assert.equal((await f.db.query('select page_id from public.memberships where collection_id=$1',[c1])).rows[0].page_id,source);
  }finally{await f.close();}
});

test('simultaneous alias discoveries cannot save duplicate canonical pages and retry merges safely',async()=>{
  const f=await fixture();try{
    await f.alias();
    // Both route lookups happened before either refresh wrote a canonical ID.
    await f.db.query('update public.pages set canonical_id=null where id=$1',[target]);
    await f.call('desk_save_refresh',[a,source,source,lease,snapshot]);
    await assert.rejects(f.call('desk_save_refresh',[a,target,target,lease,{...snapshot,posts:[{...snapshot.posts[0],pageId:target}]}]),/DD409:Another tracked page/);
    assert.equal((await f.db.query('select count(*) as n from public.pages where owner=$1 and canonical_id=$2',[a,'native-id'])).rows[0].n,1);
    const oldTarget=(await f.db.query('select name,posts,canonical_id,locked_until from public.pages where id=$1',[target])).rows[0];
    assert.equal(oldTarget.name,'Target');assert.equal(oldTarget.posts[0].views,7);assert.equal(oldTarget.canonical_id,null);assert.equal(Number(oldTarget.locked_until),lease);
    assert.equal((await f.db.query('select page_id from public.memberships where collection_id=$1',[c2])).rows[0].page_id,target);
    // A later route invocation finds source as canonical and obtains both leases.
    await f.db.query('update public.pages set locked_until=$1 where owner=$2',[lease+1,a]);
    assert.equal(await f.call('desk_save_refresh',[a,target,source,lease+1,snapshot]),source);
    assert.equal((await f.db.query('select count(*) as n from public.pages where owner=$1',[a])).rows[0].n,1);
    const members=(await f.db.query('select page_id from public.memberships where owner=$1',[a])).rows;
    assert.equal(members.length,2);assert.ok(members.every(row=>row.page_id===source));
  }finally{await f.close();}
});

test('alias saves reject target platform or native ID mismatches without changing data',async()=>{
  const f=await fixture();try{
    await f.alias();
    await assert.rejects(f.call('desk_save_refresh',[a,source,target,lease,{...snapshot,canonical_id:'different-native-id'}]),/DD409/);
    await f.db.query("update public.pages set platform='instagram' where id=$1",[target]);
    await assert.rejects(f.call('desk_save_refresh',[a,source,target,lease,snapshot]),/DD409/);
    assert.equal((await f.db.query('select posts from public.pages where id=$1',[target])).rows[0].posts[0].views,7);
    assert.equal((await f.db.query('select page_id from public.memberships where collection_id=$1',[c1])).rows[0].page_id,source);
  }finally{await f.close();}
});

test('a failed alias deletion rolls back the snapshot and all membership changes',async()=>{
  const f=await fixture();try{
    await f.alias();
    await f.db.exec(`reset role;
      create function private.block_test_delete() returns trigger language plpgsql as $$begin return null; end$$;
      create trigger block_test_delete before delete on public.pages for each row execute function private.block_test_delete();
      set role service_role;`);
    await assert.rejects(f.call('desk_save_refresh',[a,source,target,lease,snapshot]),/DD409/);
    assert.equal((await f.db.query('select posts from public.pages where id=$1',[target])).rows[0].posts[0].views,7);
    assert.equal((await f.db.query('select page_id from public.memberships where collection_id=$1',[c1])).rows[0].page_id,source);
    assert.equal((await f.db.query('select page_id from public.memberships where collection_id=$1',[c2])).rows[0].page_id,target);
    assert.equal(Number((await f.db.query('select locked_until from public.pages where id=$1',[target])).rows[0].locked_until),lease);
  }finally{await f.close();}
});
