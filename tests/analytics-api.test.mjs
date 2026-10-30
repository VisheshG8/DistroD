import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parsePage} from '../lib/pages.ts';
import {postDates,scopeKey,storedScope,scopeFromDates} from '../lib/scope.ts';
import {testSupabase} from './helpers/supabase-fixture.mjs';

const user='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',admin='33333333-3333-4333-8333-333333333333',empty='44444444-4444-4444-8444-444444444444';
const page='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherPage='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const collection='dddddddd-dddd-4ddd-8ddd-dddddddddddd',otherCollection='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const alert='a1111111-1111-4111-8111-111111111111',otherAlert='b2222222-2222-4222-8222-222222222222';
const range={from:'2026-10-01',to:'2026-10-25'};
const plain=value=>JSON.parse(JSON.stringify(value));
function loadTs(file,exports,context={}){
  const source=readFileSync(new URL(file,import.meta.url),'utf8').replace(/^import[^;]*;\r?\n/gm,'');
  const code=stripTypeScriptTypes(source,{mode:'transform'}).replace(/\bexport\s+/g,'');
  return new Script(code+'\n;({'+exports.join(',')+'})',{filename:file}).runInNewContext({Error,...context});
}
const input=loadTs('../lib/analytics/input.ts',['pageMetadata','validId','validRange','pageInput','activeInput','contentLink'],{parsePage,scopeFromDates});
async function fixture(){
  const pg=new PGlite();
  try{
    await pg.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const file of ['20261024000000_init.sql','20261024010000_sdk_operations.sql','20261024015000_sdk_admin.sql','20261024020000_sdk_legacy_import.sql','20261025000000_workspace_transfer.sql','20261026000000_admin_directory.sql','20261026010000_analytics_history.sql','20261026015000_analytics_operations.sql','20261026020000_analytics_transfer.sql','20261026030000_instagram_looter_performance.sql','20261029000000_content_dashboard.sql']){
      await pg.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    }
    await pg.query(`insert into auth.users(id,email)values($1,'user@example.test'),($2,'other@example.test'),($3,'admin@example.test'),($4,'empty@example.test')`,[user,other,admin,empty]);
    await pg.query(`update public.users set user_type='admin' where id=$1`,[admin]);
    await pg.query(`insert into public.collections(id,owner,name)values($1,$2,'Mine'),($3,$4,'Private other collection')`,[collection,user,otherCollection,other]);
    await pg.query(`insert into public.pages(id,owner,platform,handle,url,name)values
      ($1,$2,'youtube','mine','https://youtube.com/@mine','Mine'),($3,$4,'youtube','private','https://youtube.com/@private','Private other page')`,[page,user,otherPage,other]);
    await pg.query(`insert into public.memberships(collection_id,page_id,owner)values($1,$2,$3),($4,$5,$6)`,[collection,page,user,otherCollection,otherPage,other]);
    await pg.query(`insert into public.alerts(id,owner,page_id,level,type,title,details,created_at,last_seen_at)values
      ($1,$2,$3,'amber','needs_attention','Own alert','Own details','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z'),
      ($4,$5,$6,'red','needs_attention','Private other alert','Private other details','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z')`,[alert,user,page,otherAlert,other,otherPage]);
    const state={now:Date.parse('2026-10-25T12:00:00Z'),authUser:{userId:user,email:'user@example.test',displayName:'user@example.test'},refreshes:[],refreshError:null,clientUrls:[],failMembershipOffset:null};
    const {client:db,calls}=testSupabase(pg);
    class ClockDate extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
    const secrets=loadTs('../lib/crypto.ts',['encryptSecret','decryptSecret'],{createCipheriv,createDecipheriv,randomBytes,Buffer,process:{env:{APP_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')}}});
    const base={Date:ClockDate,URL,URLSearchParams,Response,Request,Buffer,TextDecoder,Uint8Array,AbortController,DOMException,postDates,scopeKey,storedScope,scopeFromDates,
      connectDatabase:()=>db,getCurrentUser:async()=>state.authUser,...secrets};
    const server=loadTs('../lib/server.ts',['ApiError','body','database','query','fail','guard','json','owner','currentAccount','requireAdmin','encrypt','decrypt'],base);
    const metrics=loadTs('../lib/analytics/metrics.ts',['alertCandidates','alertCheck','rangeForPreset'],base);
    const analytics=loadTs('../lib/analytics/server.ts',['analyticsChunk','analyticsPost','reconcileWorkspaceAlerts'],{...base,...server,...metrics,...input});
    const refreshWorkspacePage=async(ownerId,pageId,scope)=>{state.refreshes.push({ownerId,pageId,scope:plain(scope)});if(state.refreshError)throw state.refreshError;return {page:{id:pageId}};};
    const operations=loadTs('../lib/analytics/operations.ts',['addManagedPage'],{...base,...server,...input,refreshWorkspacePage});
    const context={...base,...server,...input,...analytics,...operations,refreshWorkspacePage,process:{env:{HIKERAPI_KEY:'private-test-provider-key',CRON_SECRET:'test-cron-secret-longer-than-thirty-two'}}};
    const route=loadTs('../app/api/analytics/route.ts',['GET','POST','runtime','maxDuration'],context);
    const adminRoute=loadTs('../app/api/admin/operations/route.ts',['GET','POST'],context);
    const client=loadTs('../lib/analytics/client.ts',['loadAnalyticsDataset'],{...base,DOMException,fetch:async path=>{
      const url=new URL(path,'https://app.test');state.clientUrls.push(url);
      const encoded=url.searchParams.get('cursor'),cursor=encoded?JSON.parse(Buffer.from(encoded,'base64url').toString()):null;
      if(cursor?.stage==='memberships'&&cursor.offset===state.failMembershipOffset)return Response.json({error:'Membership page unavailable.'},{status:503});
      return route.GET(new Request(url));
    }});
    const request=async(endpoint,method='GET',data={},params={},headers={})=>{
      const url=new URL(endpoint===adminRoute?'https://app.test/api/admin/operations':'https://app.test/api/analytics');
      url.search=new URLSearchParams(params).toString();
      const response=await endpoint[method](new Request(url,{method,headers:{'Content-Type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(data)})}));
      return {response,body:await response.json()};
    };
    const get=params=>request(route,'GET',{},params||range);
    const mutate=(data,headers)=>request(route,'POST',data,{},headers);
    const adminGet=params=>request(adminRoute,'GET',{},params);
    const adminMutate=(data,headers)=>request(adminRoute,'POST',data,{},headers);
    const signIn=(id=user)=>{state.authUser={userId:id,email:(id===admin?'admin':id===other?'other':id===empty?'empty':'user')+'@example.test',displayName:(id===admin?'admin':id===other?'other':id===empty?'empty':'user')+'@example.test'};};
    const rpc=(name,args)=>server.query(db.rpc(name,args));
    const load=params=>client.loadAnalyticsDataset(new URLSearchParams(params||range));
    return {pg,db,calls,state,server,analytics,route,adminRoute,get,mutate,adminGet,adminMutate,signIn,rpc,load,close:()=>pg.close()};
  }catch(error){await pg.close();throw error;}
}

test('analytics inputs distinguish zero from missing pay and reject invalid dates, precision and metadata',()=>{
  assert.deepEqual(plain(input.pageMetadata({monthlyPay:0,editor:' Editor ',startDate:'2024-02-29',active:false,notes:' Notes '})),{monthly_pay:0,editor:'Editor',start_date:'2024-02-29',active:false,notes:'Notes'});
  for(const monthlyPay of [undefined,null,''])assert.equal(input.pageMetadata({monthlyPay,startDate:''}).monthly_pay,null);
  for(const monthlyPay of [0.01,1.01,12.34,'12.34',' 12.34 ',999999999999.99])assert.equal(input.pageMetadata({monthlyPay}).monthly_pay,Number(monthlyPay));
  for(const monthlyPay of [-1,Infinity,NaN,12.34001,0.001,'1.001','1e2','1,000',true,{},1e12])assert.throws(()=>input.pageMetadata({monthlyPay}),/monthly pay/);
  for(const startDate of ['2025-02-29','2026-02-30','2026-13-01','01/02/2026','2026-01-01T00:00:00Z'])assert.throws(()=>input.pageMetadata({startDate}));
  for(const metadata of [{editor:'x'.repeat(151)},{notes:'x'.repeat(2001)},{active:'false'},{editor:17}])assert.throws(()=>input.pageMetadata(metadata));
  assert.throws(()=>input.validRange('2026-10-25','2026-10-01'));
  assert.throws(()=>input.validId('not-an-id'));
  assert.equal(input.pageInput({input:'@MyPage',platform:'instagram'}).handle,'mypage');
  assert.throws(()=>input.pageInput({input:'https://localhost/private',platform:'instagram'}));
});

test('analytics endpoint authenticates unnamed registered users and ignores forged owners in queries and cursors',async()=>{
  const f=await fixture();try{
    assert.equal(f.route.runtime,'nodejs');assert.equal(f.route.maxDuration,300);
    let result=await f.get({...range,ownerId:other});assert.equal(result.response.status,200,JSON.stringify(result.body));
    assert.deepEqual(result.body.pages.map(p=>p.id),[page]);
    assert.deepEqual(result.body.collections,[{id:collection,name:'Mine'}]);
    assert.equal((await f.server.currentAccount()).name,null,'a name is optional for a registered user');
    await f.pg.query(`insert into public.page_posts(owner,page_id,post_id,payload,created_at)values($1,$2,'mine','{"title":"Own post"}','2026-10-24'),($3,$4,'private','{"title":"Private other post"}','2026-10-24')`,[user,page,other,otherPage]);
    const forged=JSON.parse(Buffer.from(result.body.nextCursor,'base64url').toString());forged.ownerId=other;forged.owner=other;
    result=await f.get({...range,ownerId:other,cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')});
    assert.equal(result.response.status,200);assert.deepEqual(result.body.posts.map(p=>p.pageId),[page]);assert.equal(JSON.stringify(result.body).includes('Private'),false);
    result=await f.get({...range,pageId:otherPage,ownerId:other});assert.equal(result.response.status,200);assert.deepEqual(result.body.pages,[]);assert.deepEqual(result.body.collections,[]);assert.equal(result.body.nextCursor,null);
    for(const change of [{stage:'users'},{offset:-1},{offset:1.5},{offset:5000001},{at:'2026-10-26T12:00:00Z'},{range:'forged'}]){
      result=await f.get({...range,cursor:Buffer.from(JSON.stringify({...forged,...change})).toString('base64url')});assert.equal(result.response.status,400,JSON.stringify(change));
    }
    result=await f.get({...range,compareFrom:'2026-09-01'});assert.equal(result.response.status,400);
    f.signIn(admin);result=await f.get({...range,ownerId:other});assert.equal(result.response.status,200);assert.deepEqual(result.body.pages,[],'the normal endpoint always remains the signed-in workspace');assert.deepEqual(result.body.collections,[]);
    f.state.authUser=null;result=await f.get();assert.equal(result.response.status,401);
  }finally{await f.close();}
});

test('analytics history paginates beyond the SDK cap, fixes the watermark and filters every stage by owner',async()=>{
  const f=await fixture();try{
    await f.pg.query(`insert into public.page_posts(owner,page_id,post_id,payload,created_at,observed_at)
      select $1,$2,'post-'||lpad(n::text,4,'0'),jsonb_build_object('id','wrong-id','pageId',$3::text,'title','Post '||n,'views',0,'likes',null,'url','javascript:alert(1)','thumbnail','http://unsafe.test','privateToken','never-return'),
      '2026-10-24T12:00:00Z','2026-10-24T12:00:00Z' from generate_series(1,1005) n`,[user,page,otherPage]);
    await f.pg.query(`insert into public.page_posts(owner,page_id,post_id,payload,created_at)values($1,$2,'private','{"title":"Private other post"}','2026-10-24')`,[other,otherPage]);
    for(const [ownerId,pageId] of [[user,page],[other,otherPage]]){
      await f.pg.query(`insert into public.account_snapshots(owner,page_id,observed_at,followers,following,post_count)values($1,$2,'2026-10-24T12:00:00Z',100,0,null),($1,$2,'2026-10-26T12:00:00Z',200,0,2)`,[ownerId,pageId]);
      await f.pg.query(`insert into public.post_snapshots(owner,page_id,post_id,observed_at,views,likes,comments)values($1,$2,'post-0001','2026-10-24T12:00:00Z',0,null,0),($1,$2,'post-0001','2026-10-26T12:00:00Z',10,1,0)`,[ownerId,pageId]);
    }
    await f.pg.query(`insert into public.alerts(owner,page_id,level,type,title,created_at,last_seen_at)values($1,$2,'amber','future','Future alert','2026-10-26T12:00:00Z','2026-10-26T12:00:00Z')`,[user,page]);
    let result=await f.get(),at=result.body.generatedAt,cursor=result.body.nextCursor;
    result=await f.get({...range,cursor});assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.posts.length,1000);
    const posts=[...result.body.posts];assert.equal(posts[0].id,'post-0001');assert.equal(posts[0].pageId,page);assert.equal(posts[0].views,0);assert.equal(posts[0].likes,null);assert.equal(posts[0].url,'');assert.equal(posts[0].thumbnail,null);assert.equal(Object.hasOwn(posts[0],'privateToken'),false);
    cursor=result.body.nextCursor;
    await f.pg.query(`insert into public.page_posts(owner,page_id,post_id,payload,created_at)values($1,$2,'000-inserted-during-pagination','{}','2026-10-25T12:00:01Z')`,[user,page]);
    f.state.now+=5000;
    result=await f.get({...range,cursor});assert.equal(result.body.posts.length,5);posts.push(...result.body.posts);assert.equal(result.body.generatedAt,at);assert.equal(new Set(posts.map(p=>p.id)).size,1005);assert.ok(posts.every(p=>p.pageId===page));
    const chunks={};cursor=result.body.nextCursor;
    while(cursor){result=await f.get({...range,cursor});assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.generatedAt,at);Object.assign(chunks,result.body);cursor=result.body.nextCursor;}
    assert.equal(chunks.accountSnapshots.length,1);assert.equal(chunks.accountSnapshots[0].pageId,page);assert.equal(chunks.accountSnapshots[0].following,0);assert.equal(chunks.accountSnapshots[0].postCount,null);
    assert.equal(chunks.postSnapshots.length,1);assert.equal(chunks.postSnapshots[0].pageId,page);assert.equal(chunks.postSnapshots[0].views,0);assert.equal(chunks.postSnapshots[0].likes,null);
    assert.deepEqual(chunks.alerts.map(a=>a.id),[alert]);
    for(const call of f.calls.filter(c=>['page_posts','account_snapshots','post_snapshots','alerts'].some(t=>c.path==='/rest/v1/'+t))){
      const search=new URLSearchParams(call.search);assert.equal(search.get('owner'),'eq.'+user);assert.ok(search.has('created_at')||search.has('observed_at'));
    }
  }finally{await f.close();}
});

test('real analytics collections and all membership pages merge only after the complete owned dataset loads',async()=>{
  const f=await fixture();try{
    await f.pg.query(`insert into public.collections(owner,name)values($1,'Group two'),($1,'Group three'),($1,'Empty group')`,[user]);
    await f.pg.query(`insert into public.pages(owner,platform,handle,url,name)
      select $1,'youtube','grouped-'||n,'https://youtube.com/@grouped-'||n,'Grouped '||n from generate_series(1,399)n`,[user]);
    await f.pg.query(`insert into public.memberships(collection_id,page_id,owner)
      select c.id,p.id,p.owner from public.collections c join public.pages p on c.owner=p.owner
      where p.owner=$1 and c.name<>'Empty group' on conflict do nothing`,[user]);
    const dataset=await f.load({...range,ownerId:other});
    assert.equal(dataset.pages.length,400);assert.equal(dataset.collections.length,4);assert.equal(dataset.memberships.length,1200);
    assert.equal(new Set(dataset.memberships.map(m=>m.collectionId+':'+m.pageId)).size,1200,'the second membership response is appended, not substituted or omitted');
    const pageIds=new Set(dataset.pages.map(p=>p.id)),collectionIds=new Set(dataset.collections.map(c=>c.id));
    assert.ok(dataset.memberships.every(m=>pageIds.has(m.pageId)&&collectionIds.has(m.collectionId)));assert.equal(JSON.stringify(dataset).includes('Private other'),false);
    assert.ok(dataset.collections.every(c=>Object.keys(c).sort().join(',')==='id,name'));assert.ok(dataset.memberships.every(m=>Object.keys(m).sort().join(',')==='collectionId,pageId'));
    const membershipCursors=f.state.clientUrls.map(url=>url.searchParams.get('cursor')).filter(Boolean).map(encoded=>JSON.parse(Buffer.from(encoded,'base64url').toString())).filter(c=>c.stage==='memberships');
    assert.deepEqual(membershipCursors.map(c=>c.offset),[0,1000]);assert.ok(membershipCursors.every(c=>c.at===dataset.generatedAt));
    for(const call of f.calls.filter(c=>c.path==='/rest/v1/collections'||c.path==='/rest/v1/memberships'))assert.equal(new URLSearchParams(call.search).get('owner'),'eq.'+user);
    const scoped=await f.load({...range,pageId:page});assert.deepEqual(plain(scoped.pages.map(p=>p.id)),[page]);assert.equal(scoped.collections.length,3);assert.equal(scoped.memberships.length,3);assert.ok(scoped.memberships.every(m=>m.pageId===page));assert.equal(scoped.collections.some(c=>c.name==='Empty group'),false);
    const unavailable=await f.load({...range,pageId:otherPage,ownerId:other});assert.equal(unavailable.pages.length,0);assert.equal(unavailable.collections.length,0);assert.equal(unavailable.memberships.length,0);
    const forged={...membershipCursors[0],owner:other,ownerId:other};
    let result=await f.get({...range,ownerId:other,cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')});assert.equal(result.response.status,200);assert.equal(result.body.memberships.length,1000);assert.ok(result.body.memberships.every(m=>pageIds.has(m.pageId)));
    f.signIn(admin);result=await f.get({...range,cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')});assert.equal(result.response.status,200);assert.deepEqual(result.body.memberships,[],'a saved cursor cannot carry another actor\'s membership access');
    f.signIn(user);f.state.failMembershipOffset=1000;
    await assert.rejects(f.load(range),/Membership page unavailable/,'the client rejects a late chunk failure instead of publishing partial groups or totals');
  }finally{await f.close();}
});

test('normal mutations cannot use forged target owners to edit, delete or resolve another workspace',async()=>{
  const f=await fixture();try{
    for(const data of [{action:'savePage',pageId:otherPage,monthlyPay:99,notes:'forged'},{action:'removePage',pageId:otherPage},{action:'resolveAlert',id:otherAlert}]){
      const result=await f.mutate({...data,ownerId:other,userType:'admin'});assert.equal(result.response.status,404,data.action+': '+JSON.stringify(result.body));
    }
    let saved=(await f.pg.query('select monthly_pay,notes from public.pages where id=$1',[otherPage])).rows[0];assert.equal(saved.monthly_pay,null);assert.equal(saved.notes,'');
    assert.equal((await f.pg.query('select resolved_at from public.alerts where id=$1',[otherAlert])).rows[0].resolved_at,null);
    let result=await f.mutate({action:'savePage',pageId:page,ownerId:other,monthlyPay:0,startDate:'2024-02-29',active:false,editor:' Own editor ',notes:'Own note'});assert.equal(result.response.status,200,JSON.stringify(result.body));
    saved=(await f.pg.query('select monthly_pay,start_date,active,editor from public.pages where id=$1',[page])).rows[0];assert.equal(Number(saved.monthly_pay),0);assert.equal(saved.active,false);assert.equal(saved.editor,'Own editor');assert.equal(new Date(saved.start_date).toISOString().slice(0,10),'2024-02-29');
    for(const metadata of [{monthlyPay:12.34001},{startDate:'2026-02-30'},{active:'false'}]){result=await f.mutate({action:'savePage',pageId:page,...metadata});assert.equal(result.response.status,400);}
    assert.equal(Number((await f.pg.query('select monthly_pay from public.pages where id=$1',[page])).rows[0].monthly_pay),0,'invalid changes leave metadata intact');
    result=await f.mutate({action:'resolveAlert',id:alert,ownerId:other});assert.equal(result.response.status,200);assert.ok((await f.pg.query('select resolved_at from public.alerts where id=$1',[alert])).rows[0].resolved_at);
    const before=f.calls.length;result=await f.mutate({action:'removePage',pageId:page},{origin:'https://evil.test'});assert.equal(result.response.status,403);assert.equal(f.calls.length,before,'cross-site rejection precedes database work');
    result=await f.mutate({action:'removePage',pageId:page,ownerId:other});assert.equal(result.response.status,200);assert.equal((await f.pg.query('select id from public.pages where id=$1',[page])).rows.length,0);assert.equal((await f.pg.query('select id from public.pages where id=$1',[otherPage])).rows.length,1);
    result=await f.mutate({action:'removePage',pageId:'invalid'});assert.equal(result.response.status,400);
    f.state.authUser=null;result=await f.mutate({action:'savePage',pageId:otherPage});assert.equal(result.response.status,401);
  }finally{await f.close();}
});

test('managed page creation saves metadata atomically and the normal endpoint always assigns to its actor',async()=>{
  const f=await fixture();try{
    f.state.refreshError=new f.server.ApiError('Provider not configured.',503);
    let result=await f.mutate({action:'addPage',ownerId:other,input:'@new_channel',platform:'youtube',monthlyPay:12.34,editor:'Editor',startDate:'2026-10-01',active:false,notes:'Keep me'});
    assert.equal(result.response.status,200,JSON.stringify(result.body));assert.match(result.body.warning,/Provider not configured/);
    const created=result.body.pageId;let saved=(await f.pg.query('select * from public.pages where id=$1',[created])).rows[0];assert.equal(saved.owner,user);assert.equal(Number(saved.monthly_pay),12.34);assert.equal(saved.notes,'Keep me');assert.equal(saved.active,false);
    assert.equal(f.state.refreshes[0].ownerId,user);assert.equal(f.state.refreshes[0].scope.postLimit,100);
    result=await f.mutate({action:'addPage',input:'@new_channel',platform:'youtube',monthlyPay:0,notes:'Do not overwrite'});assert.equal(result.response.status,200);assert.equal(result.body.pageId,created);
    saved=(await f.pg.query('select monthly_pay,notes from public.pages where id=$1',[created])).rows[0];assert.equal(Number(saved.monthly_pay),12.34);assert.equal(saved.notes,'Keep me','adding an existing page preserves its saved metadata');
    const callsBefore=f.state.refreshes.length;
    result=await f.mutate({action:'addPage',input:'@another_channel',platform:'youtube',collectionId:otherCollection});assert.equal(result.response.status,404);assert.equal(f.state.refreshes.length,callsBefore);
    assert.equal((await f.pg.query("select id from public.pages where owner=$1 and handle='another_channel'",[user])).rows.length,0);
    f.signIn(empty);f.state.refreshError=null;result=await f.mutate({action:'addPage',input:'@first_channel',platform:'youtube',monthlyPay:0});assert.equal(result.response.status,200,JSON.stringify(result.body));
    const memberships=(await f.pg.query('select c.name,m.page_id from public.collections c join public.memberships m on c.id=m.collection_id where c.owner=$1',[empty])).rows;
    assert.deepEqual(memberships.map(r=>[r.name,r.page_id]),[['My pages',result.body.pageId]]);
  }finally{await f.close();}
});

test('admin endpoints rely on the stored role, assign across owners, redact logs and validate provider limits',async()=>{
  const f=await fixture();try{
    let result=await f.adminGet();assert.equal(result.response.status,403);
    result=await f.adminMutate({action:'assignPage',ownerId:other,input:'@assigned',platform:'youtube',userType:'admin'});assert.equal(result.response.status,403);
    assert.equal(f.state.refreshes.length,0);assert.equal(f.calls.some(c=>c.path.includes('provider_settings')||c.path.includes('provider_requests')||c.path.endsWith('desk_add_managed_page')),false);
    f.signIn(admin);
    result=await f.adminMutate({action:'assignPage',ownerId:other,input:'@assigned',platform:'youtube',monthlyPay:25,editor:'Assigned editor'});assert.equal(result.response.status,200,JSON.stringify(result.body));
    const assigned=result.body.pageId,saved=(await f.pg.query('select owner,monthly_pay,editor from public.pages where id=$1',[assigned])).rows[0];assert.equal(saved.owner,other);assert.equal(Number(saved.monthly_pay),25);assert.equal(saved.editor,'Assigned editor');assert.equal(f.state.refreshes[0].ownerId,other);
    result=await f.adminGet({section:'page',ownerId:other,pageId:assigned});assert.equal(result.response.status,200);assert.equal(result.body.page.id,assigned);
    result=await f.adminGet({section:'page',ownerId:user,pageId:assigned});assert.equal(result.response.status,404);
    result=await f.adminMutate({action:'savePage',ownerId:user,pageId:assigned,monthlyPay:0});assert.equal(result.response.status,404);
    result=await f.adminMutate({action:'savePage',ownerId:other,pageId:assigned,monthlyPay:0,notes:'Updated'});assert.equal(result.response.status,200);
    await f.pg.query(`insert into public.provider_requests(provider,platform,endpoint,funding,owner,success,latency_ms,estimated_cost_usd,raw_response,error)
      values('hikerapi','instagram','/profile','platform',$1,false,150,0.02,'{"secret":"private-provider-payload"}','private-provider-error'),
      ('tikhub','youtube','/profile','workspace',$2,true,100,0,'{"secret":"private-workspace-payload"}',null)`,[admin,other]);
    result=await f.adminGet();assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.requests.length,2);assert.equal(result.body.usage.totals.requests,1);assert.equal(result.body.keys.hikerapi,true);assert.equal(result.body.keys.lamatok,false);assert.equal(result.body.schedulerConfigured,true);
    assert.equal(JSON.stringify(result.body).includes('private-'),false,'admin response exposes key presence and safe log metadata only');assert.ok(result.body.requests.every(r=>!Object.hasOwn(r,'raw_response')&&!Object.hasOwn(r,'error')&&!Object.hasOwn(r,'owner')));
    const settings={action:'saveProviderSettings',providerOrder:{instagram:['instagram-looter','hikerapi','tikhub'],youtube:['youtube-official'],tiktok:['lamatok','tikhub']},monthlyRequestCap:25000,monthlyBudgetUsd:25,refreshIntervalHours:24,refreshEnabled:true,requestCosts:{'youtube-official':0,hikerapi:0.02,lamatok:0.02,tikhub:0.001,scrapecreators:0.001,'instagram-looter':0.00066}};
    result=await f.adminMutate(settings);assert.equal(result.response.status,200,JSON.stringify(result.body));
    for(const bad of [{monthlyBudgetUsd:25.01},{monthlyRequestCap:0},{refreshIntervalHours:0},{refreshEnabled:'true'},{providerOrder:{...settings.providerOrder,instagram:['hikerapi','hikerapi']}},{providerOrder:{...settings.providerOrder,youtube:['instagram-looter']}},{providerOrder:{...settings.providerOrder,tiktok:['instagram-looter']}},{requestCosts:{...settings.requestCosts,'instagram-looter':0}},{requestCosts:{...settings.requestCosts,lamatok:0}},{requestCosts:{...settings.requestCosts,hikerapi:0.00000001}}]){
      result=await f.adminMutate({...settings,...bad});assert.equal(result.response.status,400,JSON.stringify(bad));
    }
    const config=(await f.pg.query('select monthly_request_cap,monthly_budget_usd,refresh_enabled from public.provider_settings')).rows[0];assert.equal(config.monthly_request_cap,25000);assert.equal(Number(config.monthly_budget_usd),25);assert.equal(config.refresh_enabled,true);
    result=await f.adminMutate({action:'removePage',ownerId:other,pageId:assigned});assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal((await f.pg.query('select id from public.pages where id=$1',[assigned])).rows.length,0);
    await f.pg.query("update public.users set user_type='user' where id=$1",[admin]);result=await f.adminGet();assert.equal(result.response.status,403,'revoking the database role takes effect on the next request');
    assert.equal((await f.pg.query('select user_type from public.users where id=$1',[admin])).rows[0].user_type,'user','auth profile repair never restores privileges');
  }finally{await f.close();}
});

test('shared RapidAPI credentials are admin-only, encrypted, replaceable and never returned',async()=>{
  const f=await fixture();try{
    const key='synthetic-rapidapi-key-for-integration-test';
    let result=await f.adminMutate({action:'saveRapidApiKey',rapidApiKey:key,userType:'admin'});
    assert.equal(result.response.status,403);assert.equal(f.calls.some(c=>c.path.endsWith('/provider_settings')),false);
    f.state.authUser=null;result=await f.adminMutate({action:'saveRapidApiKey',rapidApiKey:key});assert.equal(result.response.status,401);
    f.signIn(admin);
    const before=(await f.pg.query('select provider_order,refresh_enabled from public.provider_settings')).rows[0];
    result=await f.adminMutate({action:'saveRapidApiKey',rapidApiKey:'  '+key+'  '});
    assert.equal(result.response.status,200,JSON.stringify(result.body));assert.deepEqual(result.body,{ok:true,hasRapidApiKey:true});
    const stored=(await f.pg.query('select rapidapi_key,provider_order,refresh_enabled from public.provider_settings')).rows[0];
    assert.match(stored.rapidapi_key,/^v1\./);assert.notEqual(stored.rapidapi_key,key);assert.equal(stored.rapidapi_key.includes(key),false);
    assert.equal(await f.server.decrypt(stored.rapidapi_key),key);assert.deepEqual(stored.provider_order,before.provider_order);assert.equal(stored.refresh_enabled,before.refresh_enabled);
    result=await f.adminGet();assert.equal(result.response.status,200);assert.equal(result.body.keys['instagram-looter'],true);
    assert.equal(Object.hasOwn(result.body.settings,'rapidapi_key'),false);assert.equal(JSON.stringify(result.body).includes(key),false);assert.equal(JSON.stringify(result.body).includes(stored.rapidapi_key),false);
    assert.ok(f.calls.filter(c=>c.path.endsWith('/provider_settings')&&c.method==='GET').every(c=>new URLSearchParams(c.search).get('select')!=='*'),'settings responses use explicit projections');
    result=await f.adminMutate({action:'saveRapidApiKey',rapidApiKey:''});assert.equal(result.response.status,200);assert.equal(result.body.hasRapidApiKey,true);
    assert.equal((await f.pg.query('select rapidapi_key from public.provider_settings')).rows[0].rapidapi_key,stored.rapidapi_key,'blank preserves the exact saved encrypted key');
    for(const bad of [{rapidApiKey:23},{rapidApiKey:'bad\nkey'},{rapidApiKey:'x'.repeat(2001)},{rapidApiKey:key,clearRapidApiKey:true},{clearRapidApiKey:'true'}]){
      result=await f.adminMutate({action:'saveRapidApiKey',...bad});assert.equal(result.response.status,400,JSON.stringify(bad));
    }
    result=await f.adminMutate({action:'saveRapidApiKey',rapidApiKey:'replacement-synthetic-key'});assert.equal(result.response.status,200);
    assert.equal(await f.server.decrypt((await f.pg.query('select rapidapi_key from public.provider_settings')).rows[0].rapidapi_key),'replacement-synthetic-key');
    const calls=f.calls.length;result=await f.adminMutate({action:'saveRapidApiKey',clearRapidApiKey:true},{origin:'https://evil.test'});
    assert.equal(result.response.status,403);assert.equal(f.calls.length,calls,'cross-site writes are rejected before database work');
    await f.pg.query("update public.users set user_type='user' where id=$1",[admin]);
    result=await f.adminMutate({action:'saveRapidApiKey',clearRapidApiKey:true});assert.equal(result.response.status,403,'revoked administrators cannot remove a saved key');
    await f.pg.query("update public.users set user_type='admin' where id=$1",[admin]);
    result=await f.adminMutate({action:'saveRapidApiKey',clearRapidApiKey:true});assert.equal(result.response.status,200);assert.equal(result.body.hasRapidApiKey,false);
    assert.equal((await f.pg.query('select rapidapi_key from public.provider_settings')).rows[0].rapidapi_key,'');
    result=await f.adminGet();assert.equal(result.body.keys['instagram-looter'],false);
  }finally{await f.close();}
});

test('managed page RPC independently authorizes actors and rolls back collection creation when caps or metadata fail',async()=>{
  const f=await fixture();try{
    const args={p_actor:user,p_owner:user,p_page:parsePage('@rpc_channel','youtube'),p_metadata:input.pageMetadata({monthlyPay:0}),p_collection:null};
    await assert.rejects(f.rpc('desk_add_managed_page',{...args,p_owner:other}),e=>e.status===403);
    await assert.rejects(f.rpc('desk_add_managed_page',{...args,p_actor:'99999999-9999-4999-8999-999999999999'}),e=>e.status===403);
    await assert.rejects(f.rpc('desk_admin_provider_report',{p_actor:user}),e=>e.status===403);
    for(const p_metadata of [{monthly_pay:1.001},{monthly_pay:'25'},{active:'false'},{editor:'x'.repeat(151)}])await assert.rejects(f.rpc('desk_add_managed_page',{...args,p_metadata}),e=>e.status===400);
    assert.equal((await f.pg.query("select id from public.pages where handle='rpc_channel'")).rows.length,0);
    await assert.rejects(f.pg.transaction(async tx=>{await tx.exec('set local role authenticated');return tx.query('select public.desk_add_managed_page($1,$1,$2::jsonb,$3::jsonb,null)',[user,JSON.stringify(args.p_page),'{}']);}),e=>e.code==='42501');
    await f.pg.exec(`create function public.test_reject_metadata() returns trigger language plpgsql as $$begin
      if new.notes='force rollback' then raise exception 'Deliberate metadata failure'; end if;return new;end$$;
      create trigger test_reject_metadata before update on public.pages for each row execute function public.test_reject_metadata();`);
    await assert.rejects(f.rpc('desk_add_managed_page',{...args,p_actor:admin,p_owner:empty,p_metadata:{monthly_pay:0,notes:'force rollback'}}),e=>/Deliberate metadata failure/.test(e.message));
    assert.equal((await f.pg.query('select count(*)::int n from public.collections where owner=$1',[empty])).rows[0].n,0);
    assert.equal((await f.pg.query('select count(*)::int n from public.pages where owner=$1',[empty])).rows[0].n,0,'failure saving metadata rolls back the inserted page and membership');
    assert.equal((await f.pg.query("select count(*)::int n from public.tracked_accounts where handle='rpc_channel'")).rows[0].n,0,'a failed assignment leaves no global cache shell');
    await f.pg.exec('drop trigger test_reject_metadata on public.pages;drop function public.test_reject_metadata();');
    await f.pg.query(`insert into public.pages(owner,platform,handle,url,name)
      select $1,'youtube','cap-'||n,'https://youtube.com/@cap-'||n,'Cap '||n from generate_series(1,500)n`,[empty]);
    const capped={...args,p_actor:admin,p_owner:empty};
    await assert.rejects(f.rpc('desk_add_managed_page',capped),e=>e.status===400&&/500/.test(e.message));
    assert.equal((await f.pg.query('select count(*)::int n from public.collections where owner=$1',[empty])).rows[0].n,0,'auto-created collection rolls back with the rejected page');
    assert.equal((await f.pg.query('select count(*)::int n from public.pages where owner=$1',[empty])).rows[0].n,500);
    await f.pg.query("delete from public.pages where owner=$1 and handle='cap-500'",[empty]);
    const responses=await Promise.allSettled([
      f.rpc('desk_add_managed_page',{...capped,p_page:parsePage('@concurrent_one','youtube')}),
      f.rpc('desk_add_managed_page',{...capped,p_page:parsePage('@concurrent_two','youtube')}),
    ]);
    assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);assert.equal(responses.filter(r=>r.status==='rejected'&&r.reason.status===400).length,1);
    assert.equal((await f.pg.query('select count(*)::int n from public.pages where owner=$1',[empty])).rows[0].n,500);assert.equal((await f.pg.query('select count(*)::int n from public.collections where owner=$1',[empty])).rows[0].n,1);
    await f.pg.query("update public.users set user_type='user' where id=$1",[admin]);await assert.rejects(f.rpc('desk_add_managed_page',capped),e=>e.status===403);
  }finally{await f.close();}
});

test('Page Master inputs change newer fields only when sent and validate status and content links',()=>{
  assert.deepEqual(Object.keys(input.pageMetadata({monthlyPay:1})).sort(),['active','editor','monthly_pay','notes','start_date'],'an older form never clears the newer fields');
  assert.deepEqual(plain(input.pageMetadata({displayName:' Page A ',alertQuietDays:'3',endDate:'2026-10-05',startDate:'2026-10-01'})),{monthly_pay:null,editor:'',start_date:'2026-10-01',active:true,notes:'',display_name:'Page A',alert_quiet_days:3,end_date:'2026-10-05'});
  assert.deepEqual(plain(input.pageMetadata({displayName:null,alertQuietDays:'',endDate:''})),{monthly_pay:null,editor:'',start_date:null,active:true,notes:'',display_name:'',alert_quiet_days:null,end_date:null});
  for(const metadata of [{displayName:'x'.repeat(151)},{alertQuietDays:0},{alertQuietDays:61},{alertQuietDays:2.5},{alertQuietDays:'1e1'},{endDate:'2026-02-30'},{startDate:'2026-10-02',endDate:'2026-10-01'}])assert.throws(()=>input.pageMetadata(metadata),undefined,JSON.stringify(metadata));
  assert.deepEqual(plain(input.activeInput({pageId:page.toUpperCase(),active:false})),{pageId:page.toUpperCase(),active:false});
  for(const value of [{pageId:page},{pageId:page,active:'false'},{pageId:'x',active:true}])assert.throws(()=>input.activeInput(value));
  const posts=[{pageId:page.toUpperCase(),postId:'one'},{pageId:otherPage,postId:'two'}];
  assert.deepEqual(plain(input.contentLink({mode:'group',posts})),{posts:[{pageId:page,postId:'one'},{pageId:otherPage,postId:'two'}],mode:'group',groupId:null});
  assert.equal(input.contentLink({mode:'group',posts,groupId:'ca_12345678-1234-4123-8123-123456789abc'}).groupId,'ca_12345678-1234-4123-8123-123456789abc');
  for(const value of [{mode:'merge',posts},{mode:'group',posts:[]},{mode:'group',posts:Array.from({length:51},(_,i)=>({pageId:page,postId:'p'+i}))},{mode:'group',posts:[posts[0],{...posts[0],pageId:page}]},
    {mode:'group',posts:[{pageId:page,postId:''}]},{mode:'group',posts:[{pageId:page}]},{mode:'group',posts:['x']},{mode:'unlink',posts,groupId:'ca_12345678-1234-4123-8123-123456789abc'},{mode:'group',posts,groupId:'ca_demo-1'}])
    assert.throws(()=>input.contentLink(value),undefined,JSON.stringify(value).slice(0,80));
});

test('status toggles, display names, content links and alert checks are owner-scoped actions',async()=>{
  const f=await fixture();try{
    const indiaToday=new Date(Date.now()+5.5*3600000).toISOString().slice(0,10);
    let result=await f.mutate({action:'savePage',pageId:page,monthlyPay:500,displayName:'Page A',alertQuietDays:4});assert.equal(result.response.status,200,JSON.stringify(result.body));
    result=await f.mutate({action:'savePage',pageId:page,monthlyPay:600,editor:'Asha'});assert.equal(result.response.status,200);
    let saved=(await f.pg.query('select display_name,alert_quiet_days,monthly_pay from public.pages where id=$1',[page])).rows[0];assert.equal(saved.display_name,'Page A');assert.equal(saved.alert_quiet_days,4);assert.equal(Number(saved.monthly_pay),600);
    result=await f.mutate({action:'setActive',pageId:page,active:false,ownerId:other});assert.equal(result.response.status,200,JSON.stringify(result.body));assert.deepEqual(result.body,{ok:true,active:false,endDate:indiaToday});
    let pages=(await f.get()).body.pages;assert.equal(pages[0].displayName,'Page A');assert.equal(pages[0].alertQuietDays,4);assert.equal(pages[0].endDate,indiaToday);assert.equal(pages[0].active,false);
    result=await f.mutate({action:'setActive',pageId:page,active:true});assert.deepEqual(result.body,{ok:true,active:true,endDate:null});
    for(const data of [{action:'setActive',pageId:otherPage,active:false},{action:'linkContent',mode:'unlink',posts:[{pageId:otherPage,postId:'theirs'}]}]){
      result=await f.mutate({...data,ownerId:other});assert.equal(result.response.status,404,data.action);
    }
    assert.equal((await f.pg.query('select active from public.pages where id=$1',[otherPage])).rows[0].active,true);
    for(const data of [{action:'setActive',pageId:page,active:'false'},{action:'linkContent',mode:'group',posts:[]},{action:'linkContent',mode:'group',posts:[{pageId:page,postId:'x'}],groupId:'ca_forged'}]){
      result=await f.mutate(data);assert.equal(result.response.status,400,JSON.stringify(data));
    }
    const second=(await f.pg.query(`insert into public.pages(owner,platform,handle,url,name)values($1,'tiktok','second','https://www.tiktok.com/@second','Second') returning id`,[user])).rows[0].id;
    await f.pg.query(`insert into public.page_posts(owner,page_id,post_id,payload,created_at)values($1,$2,'a','{"title":"Same"}','2026-10-24'),($1,$3,'b','{"title":"Same"}','2026-10-24'),($4,$5,'theirs','{}','2026-10-24')`,[user,page,second,other,otherPage]);
    result=await f.mutate({action:'linkContent',mode:'group',posts:[{pageId:page,postId:'a'},{pageId:second,postId:'b'}]});assert.equal(result.response.status,200,JSON.stringify(result.body));
    const groupId=result.body.groupId;assert.match(groupId,/^ca_/);assert.equal(result.body.linked,2);
    const chunks={};let cursor=(await f.get()).body.nextCursor;while(cursor){const next=await f.get({...range,cursor});for(const [key,value] of Object.entries(next.body))if(Array.isArray(value))(chunks[key]||=[]).push(...value);cursor=next.body.nextCursor;}
    assert.deepEqual(chunks.posts.map(p=>p.sourceAssetId),[groupId,groupId]);
    result=await f.mutate({action:'linkContent',mode:'group',groupId,posts:[{pageId:otherPage,postId:'theirs'}]});assert.equal(result.response.status,404);
    assert.equal((await f.pg.query("select source_asset_id from public.page_posts where post_id='theirs'")).rows[0].source_asset_id,null);
    result=await f.mutate({action:'linkContent',mode:'unlink',posts:[{pageId:second,postId:'b'}]});assert.deepEqual(result.body,{ok:true,groupId:null,linked:1});
    // The user's page has never refreshed, so it cannot be checked and its open alert stays open.
    result=await f.mutate({action:'reconcileAlerts',ownerId:other});assert.equal(result.response.status,200,JSON.stringify(result.body));assert.deepEqual(result.body,{ok:true,opened:0,resolved:0,unchecked:2});
    assert.equal((await f.pg.query('select resolved_at from public.alerts where id=$1',[alert])).rows[0].resolved_at,null);
    assert.equal((await f.pg.query('select resolved_at from public.alerts where id=$1',[otherAlert])).rows[0].resolved_at,null);
    assert.ok(f.calls.some(c=>c.path==='/rest/v1/rpc/desk_reconcile_alerts'&&Array.isArray(c.body.p_skip_pages)&&c.body.p_owner===user));
    f.state.authUser=null;result=await f.mutate({action:'reconcileAlerts'});assert.equal(result.response.status,401);
  }finally{await f.close();}
});

test('adding a page that is already tracked reports it, fills blank details and skips a recent refresh',async()=>{
  const f=await fixture();try{
    const indiaToday=new Date(Date.now()+5.5*3600000).toISOString().slice(0,10);
    let result=await f.mutate({action:'addPage',input:'@fresh_channel',platform:'youtube',displayName:'Page B'});
    assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.existed,false);assert.equal(result.body.refreshed,true);
    let saved=(await f.pg.query('select display_name,start_date from public.pages where id=$1',[result.body.pageId])).rows[0];assert.equal(saved.display_name,'Page B');assert.equal(new Date(saved.start_date).toISOString().slice(0,10),indiaToday,'start date defaults to the day the page was added');
    const refreshes=f.state.refreshes.length;
    await f.pg.query("update public.pages set last_synced_at='2026-10-25T10:00:00Z' where id=$1",[page]);
    result=await f.mutate({action:'addPage',input:'@mine',platform:'youtube',editor:'Typed editor',monthlyPay:300,displayName:'Page A'});
    assert.equal(result.response.status,200,JSON.stringify(result.body));assert.deepEqual(result.body,{ok:true,pageId:page,existed:true,refreshed:false});assert.equal(f.state.refreshes.length,refreshes,'a page refreshed two hours ago is not fetched again');
    saved=(await f.pg.query('select editor,monthly_pay,display_name from public.pages where id=$1',[page])).rows[0];assert.equal(saved.editor,'Typed editor');assert.equal(Number(saved.monthly_pay),300);assert.equal(saved.display_name,'Page A');
    await f.pg.query("update public.pages set last_synced_at='2026-10-24T10:00:00Z' where id=$1",[page]);
    result=await f.mutate({action:'addPage',input:'@mine',platform:'youtube',editor:'Ignored'});assert.equal(result.body.existed,true);assert.equal(result.body.refreshed,true);assert.equal(f.state.refreshes.length,refreshes+1);
    assert.equal((await f.pg.query('select editor from public.pages where id=$1',[page])).rows[0].editor,'Typed editor','typed details never overwrite saved ones');
  }finally{await f.close();}
});
