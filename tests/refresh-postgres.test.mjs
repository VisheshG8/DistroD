import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {normalizeScope,scopeKey,snapshotCovers,snapshotMatches} from '../lib/scope.ts';
import {parsePage} from '../lib/pages.ts';
import {randomUUID} from 'node:crypto';

const user='00000000-0000-4000-8000-000000000001',sourceId='10000000-0000-4000-8000-000000000001',targetId='10000000-0000-4000-8000-000000000002';
const c1='20000000-0000-4000-8000-000000000001',c2='20000000-0000-4000-8000-000000000002';
const scope={mode:'posts',postLimit:30,from:null,to:null};
class ApiError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const databaseSource=stripTypeScriptTypes(readFileSync(new URL('../lib/database-core.ts',import.meta.url),'utf8'),{mode:'transform'}).replace(/\bexport\s+/g,'');
const {Database,normalizeDatabaseValue}=new Script(databaseSource+'\n;({Database,normalizeDatabaseValue})').runInNewContext({Date,Number,Array,Object,Error});
function adapter(client,state){
  const executor=connection=>async(sql,parameters)=>{
    if(state.failAliasDelete&&/^DELETE FROM pages WHERE id=\$1 AND owner=\$2 AND locked_until=\$3/.test(sql))return {rows:[],count:0};
    const result=await connection.query(sql,parameters);
    return {rows:normalizeDatabaseValue(result.rows),count:result.affectedRows??result.rows.length};
  };
  return new Database(executor(client),callback=>client.transaction(tx=>callback(new Database(executor(tx)))));
}
async function fixture(){
  const pg=new PGlite();await pg.exec(`
    CREATE TABLE collections(id uuid PRIMARY KEY,owner uuid NOT NULL,name text,created_at timestamptz DEFAULT now());
    CREATE TABLE pages(id uuid PRIMARY KEY,owner uuid NOT NULL,platform text,handle text,url text,name text,followers bigint,posts jsonb DEFAULT '[]',coverage jsonb DEFAULT '{}',overall jsonb,last_synced_at timestamptz,sync_error text,provider text,canonical_id text,locked_until bigint DEFAULT 0,UNIQUE(owner,platform,handle));
    CREATE TABLE memberships(collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,page_id uuid REFERENCES pages(id) ON DELETE CASCADE,owner uuid NOT NULL,PRIMARY KEY(collection_id,page_id));
    CREATE TABLE usage(owner uuid NOT NULL,month text NOT NULL,requests integer NOT NULL DEFAULT 0,PRIMARY KEY(owner,month));
    INSERT INTO collections(id,owner,name)VALUES('${c1}','${user}','One'),('${c2}','${user}','Two');
    INSERT INTO pages(id,owner,platform,handle,url,name,posts,coverage)VALUES('${sourceId}','${user}','youtube','source','https://youtube.com/@source','Source','[{"views":10}]','{}');
    INSERT INTO memberships VALUES('${c1}','${sourceId}','${user}');`);
  const state={now:Date.parse('2026-10-24T12:00:00Z'),requestLimit:10,requests:0,timeouts:[],failAliasDelete:false,loseLease:false,alias:false,providerMode:'success',beforeRequestMs:0};
  const db=adapter(pg,state);
  const record=row=>({...row,posts:Array.isArray(row.posts)?row.posts:JSON.parse(row.posts||'[]'),coverage:row.coverage||{},overall:row.overall||null,lastSyncedAt:row.last_synced_at instanceof Date?row.last_synced_at.toISOString():row.last_synced_at,syncError:row.sync_error});
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
  const context={ApiError,body:async request=>request.json(),database:()=>db,decrypt:async value=>value||'',guard:()=>{},json:Response.json,
    fail:error=>Response.json({error:error instanceof ApiError?error.message:'Unexpected error'},{status:error instanceof ApiError?error.status:500}),owner:async()=>user,pageRecord:record,
    preferences:async()=>({api_key:'test-provider-key',youtube_key:'test-youtube-key',provider:'scrapecreators',post_limit:30,request_limit:state.requestLimit}),
    normalizeScope,scopeKey,snapshotCovers,snapshotMatches,Date:ClockDate,URL,Response,Request,JSON,Number,Math,setTimeout,crypto:{randomUUID},parsePage,encrypt:async value=>'encrypted:'+value,
    AbortSignal:{timeout:milliseconds=>{state.timeouts.push(milliseconds);return undefined;}},
    fetch:async()=>{state.requests++;if(state.providerMode==='timeout'){state.now+=180001;throw new Error('Timed out');}return Response.json({ok:true});},
    fetchPage:async(page,settings,request)=>{state.now+=state.beforeRequestMs;await request('https://www.googleapis.com/youtube/v3/channels',{});if(state.loseLease)await db.prepare('UPDATE pages SET locked_until=0 WHERE id=?').bind(page.id).run();return {name:'Refreshed',followers:50,canonicalId:state.alias?'canonical-one':null,
      posts:[{id:'post-one',pageId:page.id,platform:'youtube',publishedAt:'2026-10-23T12:00:00Z',views:100,likes:20,comments:3,shares:null}],
      coverage:{complete:true,hasMore:false,limit:30,fetched:1},overall:{views:1000,posts:1,followers:50},provider:'test'};}};
  const source=readFileSync(new URL('../app/api/refresh/route.ts',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  const code=stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'');
  const route=new Script(code+'\n;({POST,maxDuration,runtime})').runInNewContext({...context});
  const deskSource=readFileSync(new URL('../app/api/desk/route.ts',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  const deskCode=stripTypeScriptTypes(deskSource,{mode:'transform'}).replace(/\bexport\s+/g,'');
  const desk=new Script(deskCode+'\n;({GET,POST})').runInNewContext({...context});
  const post=(pageId=sourceId)=>route.POST(new Request('https://app.test/api/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageId,scope})}));
  const addAlias=async()=>{state.alias=true;await pg.query(`INSERT INTO pages(id,owner,platform,handle,url,name,posts,coverage,canonical_id)VALUES($1,$2,'youtube','target','https://youtube.com/@target','Target','[{"views":7}]','{}','canonical-one')`,[targetId,user]);await pg.query('INSERT INTO memberships VALUES($1,$2,$3)',[c2,targetId,user]);};
  return {pg,state,db,route,desk,post,addAlias,close:()=>pg.close()};
}

test('refresh uses JSONB snapshots, returns saved metrics and releases its lease',async()=>{
  const f=await fixture();try{
    assert.equal(f.route.runtime,'nodejs');assert.equal(f.route.maxDuration,300);
    const response=await f.post();assert.equal(response.status,200,await response.clone().text());
    const body=await response.json();assert.equal(body.page.posts[0].views,100);assert.equal(body.page.posts[0].pageId,sourceId);
    assert.equal(Number((await f.pg.query('SELECT locked_until FROM pages WHERE id=$1',[sourceId])).rows[0].locked_until),0);
    assert.equal((await f.pg.query('SELECT requests FROM usage')).rows[0].requests,1);assert.equal(f.state.requests,1);
  }finally{await f.close();}
});

test('quota reservation is atomic across refreshes and never spends beyond the cap',async()=>{
  const f=await fixture();try{
    await f.pg.query(`INSERT INTO pages(id,owner,platform,handle,url,name)VALUES($1,$2,'youtube','second','https://youtube.com/@second','Second')`,[targetId,user]);
    await f.pg.query('INSERT INTO memberships VALUES($1,$2,$3)',[c2,targetId,user]);f.state.requestLimit=1;
    const responses=await Promise.all([f.post(sourceId),f.post(targetId)]);assert.deepEqual(responses.map(response=>response.status).sort(),[200,400]);
    assert.equal((await f.pg.query('SELECT requests FROM usage')).rows[0].requests,1);assert.equal(f.state.requests,1);
  }finally{await f.close();}
});

test('provider timeout respects the remaining refresh deadline and preserves previous data',async()=>{
  const f=await fixture();try{
    f.state.beforeRequestMs=175000;
    let response=await f.post();assert.equal(response.status,200);assert.equal(f.state.timeouts[0],5000);
    await f.pg.query('UPDATE pages SET last_synced_at=NULL,posts=$1::jsonb WHERE id=$2',[JSON.stringify([{views:25}]),sourceId]);
    f.state.beforeRequestMs=0;f.state.providerMode='timeout';response=await f.post();assert.equal(response.status,400);
    const saved=(await f.pg.query('SELECT posts,locked_until,sync_error FROM pages WHERE id=$1',[sourceId])).rows[0];
    assert.equal(saved.posts[0].views,25);assert.equal(Number(saved.locked_until),0);assert.match(saved.sync_error,/safety limit/);
  }finally{await f.close();}
});

test('alias merge moves memberships and saves the canonical page in one transaction',async()=>{
  const f=await fixture();try{
    await f.addAlias();const response=await f.post();assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).page.id,targetId);
    assert.equal((await f.pg.query('SELECT id FROM pages WHERE id=$1',[sourceId])).rows.length,0);
    const members=(await f.pg.query('SELECT page_id FROM memberships ORDER BY collection_id')).rows;assert.equal(members.length,2);assert.equal(members.every(row=>row.page_id===targetId),true);
  }finally{await f.close();}
});

test('failed alias deletion rolls back saved counters and all membership changes',async()=>{
  const f=await fixture();try{
    await f.addAlias();f.state.failAliasDelete=true;
    const response=await f.post();assert.equal(response.status,409,await response.clone().text());
    const pages=(await f.pg.query('SELECT id,posts,locked_until FROM pages ORDER BY id')).rows;assert.equal(pages.length,2);assert.equal(pages[1].posts[0].views,7);assert.equal(pages.every(row=>Number(row.locked_until)===0),true);
    const members=(await f.pg.query('SELECT collection_id,page_id FROM memberships ORDER BY collection_id')).rows;assert.equal(members[0].page_id,sourceId);assert.equal(members[1].page_id,targetId);
  }finally{await f.close();}
});

test('a lost source lease blocks an alias merge before any membership moves',async()=>{
  const f=await fixture();try{
    await f.addAlias();f.state.loseLease=true;const response=await f.post();assert.equal(response.status,409);
    const members=(await f.pg.query('SELECT collection_id,page_id FROM memberships ORDER BY collection_id')).rows;
    assert.equal(members[0].page_id,sourceId);assert.equal(members[1].page_id,targetId);
    const pages=(await f.pg.query('SELECT id,posts FROM pages ORDER BY id')).rows;assert.equal(pages.length,2);assert.equal(pages[1].posts[0].views,7);
  }finally{await f.close();}
});

test('desk PostgreSQL responses preserve camelCase aliases and isolate tenant records',async()=>{
  const f=await fixture();try{
    const other='00000000-0000-4000-8000-000000000099';
    await f.pg.query('INSERT INTO collections(id,owner,name)VALUES($1,$2,$3)',['20000000-0000-4000-8000-000000000099',other,'Other owner']);
    const response=await f.desk.GET();assert.equal(response.status,200,await response.clone().text());const data=await response.json();
    assert.equal(data.collections.length,2);assert.ok(data.collections.every(collection=>Object.hasOwn(collection,'createdAt')));
    assert.equal(data.memberships[0].collectionId,c1);assert.equal(data.memberships[0].pageId,sourceId);assert.equal(data.pages[0].posts[0].views,10);
    assert.equal(data.collections.some(collection=>collection.name==='Other owner'),false);
  }finally{await f.close();}
});

test('desk PostgreSQL collection duplication and removal remain independent',async()=>{
  const f=await fixture();try{
    const mutate=async body=>{const response=await f.desk.POST(new Request('https://app.test/api/desk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {response,body:await response.json()};};
    const created=await mutate({action:'createCollection',name:'New'});assert.equal(created.response.status,200);
    const id=created.body.id;
    let change=await mutate({action:'addPages',collectionId:id,inputs:['https://instagram.com/test_page/','https://www.instagram.com/TEST_PAGE/','https://youtube.com/@testchannel'],platform:'instagram'});assert.equal(change.response.status,200);assert.equal(change.body.added,2);assert.equal(change.body.errors.length,0);
    const copied=await mutate({action:'duplicateCollection',id,name:'Copy'});assert.equal(copied.response.status,200);
    const member=(await f.pg.query('SELECT page_id FROM memberships WHERE collection_id=$1',[id])).rows[0].page_id;
    change=await mutate({action:'removePage',collectionId:copied.body.id,pageId:member});assert.equal(change.response.status,200);
    assert.equal(Number((await f.pg.query('SELECT count(*) FROM memberships WHERE collection_id=$1',[id])).rows[0].count),2);
    assert.equal(Number((await f.pg.query('SELECT count(*) FROM memberships WHERE collection_id=$1',[copied.body.id])).rows[0].count),1);
    change=await mutate({action:'renameCollection',id:'not-a-uuid',name:'Bad'});assert.equal(change.response.status,400);
    const other='00000000-0000-4000-8000-000000000099',otherCollection='20000000-0000-4000-8000-000000000099';
    await f.pg.query('INSERT INTO collections(id,owner,name)VALUES($1,$2,$3)',[otherCollection,other,'Other owner']);
    change=await mutate({action:'renameCollection',id:otherCollection,name:'Wrong owner'});assert.equal(change.response.status,404);
  }finally{await f.close();}
});
