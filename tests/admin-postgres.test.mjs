import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Script } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import {testSupabase} from './helpers/supabase-fixture.mjs';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const collection='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherCollection='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const page='cccccccc-cccc-4ccc-8ccc-cccccccccccc',otherPage='dddddddd-dddd-4ddd-8ddd-dddddddddddd',emptyPage='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
class ApiError extends Error{constructor(message,status=400){super(message);this.status=status;}}
async function fixture(){
  const sql=new PGlite();
  await sql.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;`);
  for(const migration of ['20261024000000_init.sql','20261024010000_sdk_operations.sql','20261024015000_sdk_admin.sql'])
    await sql.exec(readFileSync(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  await sql.query("INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ($1,'Owner@Example.test','{\"name\":\"Owner\"}'),($2,'other@example.test','{\"name\":\"Other\"}')",[owner,other]);
  await sql.query("UPDATE public.users SET user_type=CASE WHEN id=$1 THEN 'admin' ELSE 'user' END, created_at=CASE WHEN id=$1 THEN '2026-10-01'::timestamptz ELSE '2026-10-02'::timestamptz END,last_seen_at='2026-10-24'",[owner]);
  await sql.query("INSERT INTO public.collections VALUES ($1,$2,'Owner collection','2026-10-01'),($3,$4,'Other collection','2026-10-02')",[collection,owner,otherCollection,other]);
  const posts=[{id:'raw-private-post-identifier',views:100,likes:2,comments:0,shares:null},{views:200,likes:null,comments:1,shares:1},{views:'400',likes:-1,comments:2.5,shares:9007199254740992},true,null];
  await sql.query(`INSERT INTO public.pages(id,owner,platform,handle,url,name,followers,posts,coverage,overall,last_synced_at) VALUES
    ($1,$2,'youtube','owner_handle','https://youtube.com/@owner_handle','Percent % creator',100,$3::jsonb,$4::jsonb,$5::jsonb,'2026-10-24T10:00:00Z'),
    ($6,$7,'instagram','otherhandle','https://instagram.com/otherhandle','Other page',200,'[]'::jsonb,'{}'::jsonb,NULL,'2026-10-24T11:00:00Z'),
    ($8,$2,'tiktok','empty','https://tiktok.com/@empty','Unrefreshed',NULL,'[]'::jsonb,'{}'::jsonb,NULL,NULL)`,
    [page,owner,JSON.stringify(posts),JSON.stringify({requestedMode:'posts',limit:30,complete:true}),JSON.stringify({views:9000,posts:8}),otherPage,other,emptyPage]);
  await sql.query('INSERT INTO public.memberships VALUES ($1,$2,$3),($4,$5,$6),($1,$7,$3)',[collection,page,owner,otherCollection,otherPage,other,emptyPage]);
  await sql.query("INSERT INTO public.settings(owner,api_key,youtube_key) VALUES ($1,'encrypted-secret-api','encrypted-secret-youtube')",[other]);
  const {client,calls:queries}=testSupabase(sql),state={admin:true};
  const database=()=>client;
  const query=async operation=>{const {data,error}=await operation;if(error){const known=error.message.match(/^DD(400|403|404|409):\s*(.+)$/);if(known)throw new ApiError(known[2],Number(known[1]));throw error;}return data;};
  const source=readFileSync(new URL('../app/api/admin/route.ts',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  const javascript=stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'');
  const context={ApiError,database,query,requireAdmin:async()=>{if(!state.admin)throw new ApiError('Administrator access is required.',403);return {id:owner};},
    fail:error=>Response.json({error:error instanceof ApiError?error.message:String(error)},{status:error instanceof ApiError?error.status:500}),
    json:(data,status=200)=>Response.json(data,{status}),Response,Request,URL,Date,JSON,Number,Set};
  const {GET}=new Script(javascript+'\n;({GET})').runInNewContext(context);
  async function get(query=''){const response=await GET(new Request('https://app.test/api/admin?'+query));return {response,data:await response.json()};}
  return {sql,state,queries,get,async close(){await sql.close();}};
}

test('PostgreSQL admin summaries and user/collection owner joins return numeric counts',async()=>{
  const f=await fixture();try{
    let {response,data}=await f.get();assert.equal(response.status,200,JSON.stringify(data));
    assert.deepEqual(data.summary,{users:2,admins:1,collections:2,pages:3,memberships:3});
    ({response,data}=await f.get('section=users'));assert.equal(response.status,200,JSON.stringify(data));
    assert.equal(data.total,2);assert.equal(data.items.find(item=>item.id===owner).pageCount,2);assert.equal(data.items.find(item=>item.id===other).userType,'user');
    ({response,data}=await f.get('section=collections'));assert.equal(response.status,200,JSON.stringify(data));
    const owned=data.items.find(item=>item.id===collection);assert.equal(owned.pageCount,2);assert.equal(owned.ownerEmail,'Owner@Example.test');assert.equal(typeof owned.createdAt,'string');
  }finally{await f.close();}
});

test('PostgreSQL JSONB metrics reject invalid counters, order null refreshes last, and redact raw data',async()=>{
  const f=await fixture();try{
    const {response,data}=await f.get('section=pages');assert.equal(response.status,200,JSON.stringify(data));
    assert.equal(data.items.at(-1).id,emptyPage,'never-refreshed pages sort last');
    const selected=data.items.find(item=>item.id===page);assert.equal(selected.views,300);assert.equal(selected.likes,2);assert.equal(selected.comments,1);assert.equal(selected.shares,1);assert.equal(selected.selectedPostCount,5);
    assert.equal(selected.lifetimeViews,9000);assert.equal(selected.lifetimePosts,8);assert.equal(selected.collectionCount,1);assert.equal(selected.coverage.complete,true);assert.equal(selected.coverage.limit,30);
    const empty=data.items.find(item=>item.id===emptyPage);assert.equal(empty.views,null);assert.equal(empty.selectedPostCount,0);
    const text=JSON.stringify(data);for(const secret of ['raw-private-post-identifier','encrypted-secret-api','encrypted-secret-youtube','api_key','youtube_key'])assert.equal(text.includes(secret),false);
    assert.equal(Object.hasOwn(selected,'posts'),false);assert.equal(Object.hasOwn(selected,'settings'),false);
  }finally{await f.close();}
});

test('PostgreSQL admin filters validate UUIDs, bind literal searches, and paginate collection pages',async()=>{
  const f=await fixture();try{
    let {response,data}=await f.get('section=pages&collectionId='+collection+'&limit=1');assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.total,2);assert.equal(data.hasMore,true);assert.equal(data.collection.ownerId,owner);assert.equal(data.items[0].id,page);
    ({response,data}=await f.get('section=pages&collectionId='+collection+'&limit=1&offset=1'));assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.hasMore,false);assert.equal(data.items[0].id,emptyPage);
    ({response,data}=await f.get('section=pages&ownerId='+other));assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.total,1);assert.equal(data.items[0].id,otherPage);
    ({response,data}=await f.get('section=pages&search=%25'));assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.total,1,'percent is searched literally');
    ({response,data}=await f.get('section=users&search=owner%40example.test'));assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.total,1,'search is case-insensitive');
    ({response,data}=await f.get('section=pages&search='+encodeURIComponent("' OR 1=1 --")));assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.total,0);
    for(const query of ['section=pages&ownerId=invalid','section=pages&collectionId=invalid','limit=0','limit=101','offset=-1','offset=1.5','section=settings'])assert.equal((await f.get(query)).response.status,400,query);
    assert.equal((await f.get('section=pages&collectionId=ffffffff-ffff-4fff-8fff-ffffffffffff')).response.status,404);
  }finally{await f.close();}
});

test('admin access is checked before any PostgreSQL queries run',async()=>{
  const f=await fixture();try{f.state.admin=false;f.queries.length=0;assert.equal((await f.get('section=pages')).response.status,403);assert.equal(f.queries.length,0);}finally{await f.close();}
});

test('admin report RPC independently checks the stored role after API authorization',async()=>{
  const f=await fixture();try{
    await f.sql.query("UPDATE public.users SET user_type='user' WHERE id=$1",[owner]);
    const {response,data}=await f.get('section=pages');
    assert.equal(response.status,403);assert.match(data.error,/Administrator access/);
    assert.equal(f.queries.length,1,'the database rejects a formerly authorized administrator');
  }finally{await f.close();}
});

test('browser roles cannot call the privileged report even with an administrator actor ID',async()=>{
  const f=await fixture();try{
    for(const role of ['anon','authenticated']){
      await assert.rejects(f.sql.transaction(async tx=>{
        await tx.exec('SET LOCAL ROLE '+role);
        await tx.query('SELECT public.desk_admin_report($1)',[owner]);
      }),error=>error.code==='42501');
    }
    const privileges=(await f.sql.query("SELECT has_function_privilege('service_role','public.desk_admin_report(uuid,text,integer,integer,text,uuid,uuid)','EXECUTE') AS allowed")).rows[0];
    assert.equal(privileges.allowed,true);
  }finally{await f.close();}
});

test('report RPC validates its own parameters and returns null when a metric sum exceeds safe precision',async()=>{
  const f=await fixture();try{
    for(const args of [[owner,'settings',25,0,'',null,null],[owner,'pages',101,0,'',null,null],[owner,'users',25,0,'',null,collection]]){
      await assert.rejects(f.sql.query('SELECT public.desk_admin_report($1,$2,$3,$4,$5,$6,$7)',args),error=>error.message.startsWith('DD400:'));
    }
    await f.sql.query('UPDATE public.pages SET posts=$1::jsonb,overall=$2::jsonb WHERE id=$3',[
      JSON.stringify([{views:9007199254740991},{views:1}]),JSON.stringify({views:'9'.repeat(1000),posts:'8'}),page,
    ]);
    const {response,data}=await f.get('section=pages&ownerId='+owner);assert.equal(response.status,200);
    const item=data.items.find(item=>item.id===page);assert.equal(item.views,null);assert.equal(item.lifetimeViews,null);assert.equal(item.lifetimePosts,8);
    const empty=await f.get('section=users&offset=100');assert.equal(empty.data.total,2);assert.deepEqual(empty.data.items,[]);
  }finally{await f.close();}
});
