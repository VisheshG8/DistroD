import { ApiError, body, database, decrypt, fail, guard, json, owner, pageRecord, preferences } from '@/lib/server';
import { fetchPage } from '@/lib/providers';
import { normalizeScope, scopeKey, snapshotCovers, snapshotMatches } from '@/lib/scope';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=300;

export async function POST(request:Request){let lockedId:string|null=null,mergedLockId:string|null=null,lockValue=0,user='';try{
 guard(request);user=await owner();const data=await body(request),db=database();
 if(typeof data.pageId!=='string'||!/^\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b$/i.test(data.pageId))throw new ApiError('Choose a valid page to refresh.');
 const page=await db.prepare('SELECT * FROM pages WHERE id=? AND owner=? AND EXISTS(SELECT 1 FROM memberships WHERE page_id=pages.id AND owner=?)').bind(data.pageId,user,user).first();if(!page)throw new ApiError('Page not found.',404);
 const s=await preferences(user),apiKey=await decrypt(s.api_key),youtubeKey=await decrypt(s.youtube_key);
 let scope;try{scope=normalizeScope(data.scope,Number(s.post_limit));}catch(e){throw new ApiError(e instanceof Error?e.message:'Choose a valid data range.');}
 const oldCoverage=pageRecord(page).coverage;
 if(page.platform==='youtube'?!youtubeKey&&!apiKey:!apiKey)throw new ApiError('Add your API key in Settings, then refresh this page.');
 if(page.last_synced_at && page.overall && Date.now()-Date.parse(String(page.last_synced_at))<5*60*1000 && snapshotCovers(oldCoverage,scope)) return json({ok:true,page:pageRecord(page),cached:true});
 lockValue=Date.now()+300000;
 const lock=await db.prepare('UPDATE pages SET locked_until=? WHERE id=? AND owner=? AND locked_until<?').bind(lockValue,page.id,user,Date.now()).run();if(!lock.meta.changes)throw new ApiError('This page is already refreshing. Try again in a moment.',409);lockedId=String(page.id);
 let calls=0;const deadline=Date.now()+180000,month=new Date().toISOString().slice(0,7),requestLimit=Number(s.request_limit);
 if(!Number.isSafeInteger(requestLimit)||requestLimit<1)throw new ApiError('Choose a valid monthly request cap in Settings.');
 const deadlineError=()=>new ApiError('Refresh reached its safety limit. Try a smaller post count or narrower date range.');
 const providerRequest=async(url:string,headers:Record<string,string>)=>{
  const parsed=new URL(url);if(parsed.protocol!=='https:'||!['api.tikhub.io','api.scrapecreators.com','www.googleapis.com'].includes(parsed.hostname))throw new ApiError('Unsupported data source.',500);
  for(let attempt=0;attempt<2;attempt++){
   if(++calls>70||Date.now()>=deadline)throw deadlineError();
   // A single PostgreSQL upsert reserves quota atomically across concurrent refreshes.
   const reserved=await db.prepare(`INSERT INTO usage (owner,month,requests) VALUES (?,?,1)
     ON CONFLICT(owner,month) DO UPDATE SET requests=usage.requests+1 WHERE usage.requests<? RETURNING requests`)
     .bind(user,month,requestLimit).first();
   if(!reserved)throw new ApiError('Monthly request cap reached. You can adjust it in Settings.');
   const remaining=deadline-Date.now();if(remaining<=0)throw deadlineError();
   let response:Response;
   try{response=await fetch(url,{headers,signal:AbortSignal.timeout(Math.max(1,Math.min(20000,remaining)))});}catch{if(Date.now()>=deadline)throw deadlineError();if(attempt===0)continue;throw new ApiError('The provider timed out. Your previous data is still saved.',502);}
   if(response.ok){let result;try{result=await response.json();}catch{throw new ApiError('The provider returned an unreadable response.',502);}return result;}
   if(attempt===0&&(response.status===429||response.status>=500)){const wait=Math.min(800,deadline-Date.now());if(wait<=0)throw deadlineError();await new Promise(r=>setTimeout(r,wait));continue;}
   if([401,403].includes(response.status))throw new ApiError('The provider rejected this key or endpoint. Check the key and balance in Settings.',502);
   if(response.status===402)throw new ApiError('Provider credits are exhausted. Add credits in your provider account.',502);
   if(response.status===404)throw new ApiError('The public page was not found by the provider.',502);
   throw new ApiError(response.status===429?'Provider rate limit reached. Wait a moment and retry.':'The provider could not refresh this page. Your previous data is still saved.',502);
  }throw new ApiError('Refresh failed.',502);
 };
 let result;
 try{result=await fetchPage({id:String(page.id),platform:page.platform as 'instagram'|'tiktok'|'youtube',handle:String(page.handle),url:String(page.url)},{provider:s.provider as 'tikhub'|'scrapecreators',postLimit:scope.postLimit,apiKey,youtubeKey,scope},providerRequest);}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(e instanceof Error?e.message.slice(0,350):'The provider could not read this page.',502);}
 const oldPosts=pageRecord(page).posts;
 if(page.last_synced_at && snapshotMatches(oldCoverage,scope) && result.coverage.complete===false && result.posts.length<oldPosts.length)throw new ApiError('The provider returned an incomplete refresh. Your previous snapshot has been kept. Please retry later.',502);
 const now=new Date().toISOString();let targetId=String(page.id);
 // Resolve aliases only from a provider's native ID, never from matching display names.
 const existing=result.canonicalId?await db.prepare('SELECT * FROM pages WHERE owner=? AND platform=? AND canonical_id=? AND id<>? ORDER BY last_synced_at DESC NULLS LAST LIMIT 1').bind(user,page.platform,result.canonicalId,page.id).first():null;
 if(existing){
  if(existing.last_synced_at && snapshotMatches(pageRecord(existing).coverage,scope) && result.coverage.complete===false && result.posts.length<pageRecord(existing).posts.length)throw new ApiError('The provider returned incomplete data for an already tracked page. Its previous snapshot has been kept.',502);
  const aliasLock=await db.prepare('UPDATE pages SET locked_until=? WHERE id=? AND owner=? AND locked_until<?').bind(lockValue,existing.id,user,Date.now()).run();
  if(!aliasLock.meta.changes)throw new ApiError('Another collection is refreshing this same page. Try again in a moment.',409);
  targetId=String(existing.id);mergedLockId=targetId;
 }
 const posts=result.posts.map(post=>({...post,pageId:targetId}));
 const coverage={...result.coverage,scopeKey:scopeKey(scope),requestedMode:scope.mode,from:scope.from,to:scope.to};
 const saveSql='UPDATE pages SET name=?,followers=?,posts=?::jsonb,coverage=?::jsonb,overall=?::jsonb,provider=?,last_synced_at=?,sync_error=NULL,locked_until=0,canonical_id=? WHERE id=? AND owner=? AND locked_until=?';
 const saveValues=[result.name,result.followers,JSON.stringify(posts),JSON.stringify(coverage),JSON.stringify(result.overall),result.provider,now,result.canonicalId||null,targetId,user,lockValue];
 if(existing){
  await db.transaction(async tx=>{
   // Lock both rows and prove both leases before changing any memberships.
   const leases=await tx.prepare('SELECT id FROM pages WHERE id IN (?,?) AND owner=? AND locked_until=? FOR UPDATE').bind(targetId,page.id,user,lockValue).all();
   if(leases.results.length!==2)throw new ApiError('This page changed during refresh. Please try again.',409);
   const saved=await tx.prepare(saveSql).bind(...saveValues).run();
   if(saved.meta.changes!==1)throw new ApiError('This page changed during refresh. Please try again.',409);
   await tx.prepare('INSERT INTO memberships (collection_id,page_id,owner) SELECT collection_id,?,owner FROM memberships WHERE page_id=? AND owner=? ON CONFLICT DO NOTHING').bind(targetId,page.id,user).run();
   await tx.prepare('DELETE FROM memberships WHERE page_id=? AND owner=?').bind(page.id,user).run();
   const removed=await tx.prepare('DELETE FROM pages WHERE id=? AND owner=? AND locked_until=?').bind(page.id,user,lockValue).run();
   if(removed.meta.changes!==1)throw new ApiError('This page changed during refresh. Please try again.',409);
  });
 }else{const saved=await db.prepare(saveSql).bind(...saveValues).run();if(saved.meta.changes!==1)throw new ApiError('This page changed during refresh. Please try again.',409);}
 lockedId=null;mergedLockId=null;
 const saved=await db.prepare('SELECT * FROM pages WHERE id=? AND owner=?').bind(targetId,user).first();if(!saved)throw new ApiError('The page was removed during refresh.',409);return json({ok:true,page:pageRecord(saved)});
 }catch(e){for(const id of [lockedId,mergedLockId])if(id&&user){await database().prepare('UPDATE pages SET locked_until=0,sync_error=? WHERE id=? AND owner=? AND locked_until=?').bind(e instanceof ApiError?e.message:'Refresh failed. Please try again.',id,user,lockValue).run().catch(()=>{});}return fail(e);}}
