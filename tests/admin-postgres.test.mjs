import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Script } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const collection='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherCollection='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const page='cccccccc-cccc-4ccc-8ccc-cccccccccccc',otherPage='dddddddd-dddd-4ddd-8ddd-dddddddddddd',emptyPage='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
class ApiError extends Error{constructor(message,status=400){super(message);this.status=status;}}
async function fixture(){
  const sql=new PGlite();
  await sql.exec(`CREATE TABLE public.users(id uuid PRIMARY KEY,email text,name text,user_type text NOT NULL DEFAULT 'user',created_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL);
    CREATE TABLE public.collections(id uuid PRIMARY KEY,owner uuid NOT NULL,name text NOT NULL,created_at timestamptz NOT NULL);
    CREATE TABLE public.pages(id uuid PRIMARY KEY,owner uuid NOT NULL,platform text,handle text,url text,name text,followers bigint,posts jsonb NOT NULL DEFAULT '[]',coverage jsonb NOT NULL DEFAULT '{}',overall jsonb,last_synced_at timestamptz,sync_error text);
    CREATE TABLE public.memberships(collection_id uuid,page_id uuid,owner uuid,PRIMARY KEY(collection_id,page_id));
    CREATE TABLE public.settings(owner uuid,api_key text,youtube_key text);`);
  await sql.query("INSERT INTO public.users VALUES ($1,'Owner@Example.test','Owner','admin','2026-10-01','2026-10-24'),($2,'other@example.test','Other','user','2026-10-02','2026-10-24')",[owner,other]);
  await sql.query("INSERT INTO public.collections VALUES ($1,$2,'Owner collection','2026-10-01'),($3,$4,'Other collection','2026-10-02')",[collection,owner,otherCollection,other]);
  const posts=[{id:'raw-private-post-identifier',views:100,likes:2,comments:0,shares:null},{views:200,likes:null,comments:1,shares:1},{views:'400',likes:-1,comments:2.5,shares:9007199254740992},true,null];
  await sql.query(`INSERT INTO public.pages(id,owner,platform,handle,url,name,followers,posts,coverage,overall,last_synced_at) VALUES
    ($1,$2,'youtube','owner_handle','https://youtube.com/@owner_handle','Percent % creator',100,$3::jsonb,$4::jsonb,$5::jsonb,'2026-10-24T10:00:00Z'),
    ($6,$7,'instagram','otherhandle','https://instagram.com/otherhandle','Other page',200,'[]'::jsonb,'{}'::jsonb,NULL,'2026-10-24T11:00:00Z'),
    ($8,$2,'tiktok','empty','https://tiktok.com/@empty','Unrefreshed',NULL,'{}'::jsonb,'{}'::jsonb,NULL,NULL)`,
    [page,owner,JSON.stringify(posts),JSON.stringify({requestedMode:'posts',limit:30,complete:true}),JSON.stringify({views:9000,posts:8}),otherPage,other,emptyPage]);
  await sql.query('INSERT INTO public.memberships VALUES ($1,$2,$3),($4,$5,$6),($1,$7,$3)',[collection,page,owner,otherCollection,otherPage,other,emptyPage]);
  await sql.query("INSERT INTO public.settings VALUES ($1,'encrypted-secret-api','encrypted-secret-youtube')",[other]);
  const queries=[],state={admin:true};
  const adapterSource=readFileSync(new URL('../lib/database-core.ts',import.meta.url),'utf8');
  const adapterCode=stripTypeScriptTypes(adapterSource,{mode:'transform'}).replace(/\bexport\s+/g,'');
  const {Database,normalizeDatabaseValue}=new Script(adapterCode+'\n;({Database,normalizeDatabaseValue})').runInNewContext({Date});
  const adapter=new Database(async(text,parameters)=>{
    queries.push(text);const result=await sql.query(text,parameters);
    return {rows:result.rows.map(normalizeDatabaseValue),count:result.affectedRows??result.rows.length};
  });
  const database=()=>adapter;
  const source=readFileSync(new URL('../app/api/admin/route.ts',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  const javascript=stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'');
  const context={ApiError,database,requireAdmin:async()=>{if(!state.admin)throw new ApiError('Administrator access is required.',403);},
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
