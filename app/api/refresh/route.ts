import { ApiError, body, database, decrypt, fail, guard, json, owner, pageRecord, preferences, query } from '@/lib/server';
import { fetchPage } from '@/lib/providers';
import { normalizeScope, scopeKey, snapshotCovers, snapshotMatches } from '@/lib/scope';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=300;

export async function POST(request:Request){let lockedId:string|null=null,mergedLockId:string|null=null,lockValue=0,user='';try{
 guard(request);user=await owner();const data=await body(request),db=database();
 if(typeof data.pageId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.pageId))throw new ApiError('Choose a valid page to refresh.');
 const [page,membership]=await Promise.all([
  query(db.from('pages').select('*').eq('id',data.pageId).eq('owner',user).maybeSingle<Record<string,unknown>>()),
  query(db.from('memberships').select('page_id').eq('page_id',data.pageId).eq('owner',user).limit(1).maybeSingle<Record<string,unknown>>()),
 ]);
 if(!page||!membership)throw new ApiError('Page not found.',404);
 const s=await preferences(user),apiKey=await decrypt(s.api_key),youtubeKey=await decrypt(s.youtube_key);
 let scope;try{scope=normalizeScope(data.scope,Number(s.post_limit));}catch(e){throw new ApiError(e instanceof Error?e.message:'Choose a valid data range.');}
 const oldCoverage=pageRecord(page).coverage;
 if(page.platform==='youtube'?!youtubeKey&&!apiKey:!apiKey)throw new ApiError('Add your API key in Settings, then refresh this page.');
 if(page.last_synced_at && page.overall && Date.now()-Date.parse(String(page.last_synced_at))<5*60*1000 && snapshotCovers(oldCoverage,scope)) return json({ok:true,page:pageRecord(page),cached:true});
 lockValue=Date.now()+300000;
 const lock=await query(db.from('pages').update({locked_until:lockValue}).eq('id',page.id).eq('owner',user).lt('locked_until',Date.now()).select('id'));
 if(!lock?.length)throw new ApiError('This page is already refreshing. Try again in a moment.',409);lockedId=String(page.id);
 let calls=0;const deadline=Date.now()+180000,month=new Date().toISOString().slice(0,7),requestLimit=Number(s.request_limit);
 if(!Number.isSafeInteger(requestLimit)||requestLimit<1)throw new ApiError('Choose a valid monthly request cap in Settings.');
 const deadlineError=()=>new ApiError('Refresh reached its safety limit. Try a smaller post count or narrower date range.');
 const providerRequest=async(url:string,headers:Record<string,string>)=>{
  const parsed=new URL(url);if(parsed.protocol!=='https:'||!['api.tikhub.io','api.scrapecreators.com','www.googleapis.com'].includes(parsed.hostname))throw new ApiError('Unsupported data source.',500);
  for(let attempt=0;attempt<2;attempt++){
   if(++calls>70||Date.now()>=deadline)throw deadlineError();
   // A single database RPC reserves quota atomically across concurrent refreshes.
   const reserved=await query(db.rpc('desk_reserve_usage',{p_owner:user,p_month:month,p_limit:requestLimit}));
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
 // Resolve aliases only from a provider's native ID, never from display names.
 const existing=result.canonicalId?await query(db.from('pages').select('*').eq('owner',user).eq('platform',page.platform).eq('canonical_id',result.canonicalId).neq('id',page.id).order('last_synced_at',{ascending:false,nullsFirst:false}).limit(1).maybeSingle<Record<string,unknown>>()):null;
 if(existing){
  if(existing.last_synced_at && snapshotMatches(pageRecord(existing).coverage,scope) && result.coverage.complete===false && result.posts.length<pageRecord(existing).posts.length)throw new ApiError('The provider returned incomplete data for an already tracked page. Its previous snapshot has been kept.',502);
  const aliasLock=await query(db.from('pages').update({locked_until:lockValue}).eq('id',existing.id).eq('owner',user).lt('locked_until',Date.now()).select('id'));
  if(!aliasLock?.length)throw new ApiError('Another collection is refreshing this same page. Try again in a moment.',409);
  targetId=String(existing.id);mergedLockId=targetId;
 }
 const posts=result.posts.map(post=>({...post,pageId:targetId}));
 const coverage={...result.coverage,scopeKey:scopeKey(scope),requestedMode:scope.mode,from:scope.from,to:scope.to};
 await query(db.rpc('desk_save_refresh',{p_owner:user,p_source:page.id,p_target:targetId,p_lease:lockValue,
  p_snapshot:{name:result.name,followers:result.followers,posts,coverage,overall:result.overall,provider:result.provider,last_synced_at:now,canonical_id:result.canonicalId||null}}));
 lockedId=null;mergedLockId=null;
 const saved=await query(db.from('pages').select('*').eq('id',targetId).eq('owner',user).maybeSingle<Record<string,unknown>>());
 if(!saved)throw new ApiError('The page was removed during refresh.',409);return json({ok:true,page:pageRecord(saved)});
 }catch(e){
  for(const id of [lockedId,mergedLockId])if(id&&user){
   try{await query(database().from('pages').update({locked_until:0,sync_error:e instanceof ApiError?e.message:'Refresh failed. Please try again.'}).eq('id',id).eq('owner',user).eq('locked_until',lockValue));}catch{/* Preserve the original error; an abandoned lease expires automatically. */}
  }
  return fail(e);
 }}
