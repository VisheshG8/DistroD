import {ApiError,body,database,fail,guard,json,query,requireAdmin} from '@/lib/server';
import {validId,pageMetadata} from '@/lib/analytics/input';
import {addManagedPage} from '@/lib/analytics/operations';
import {refreshWorkspacePage} from '@/lib/refresh-service';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=300;
const allowed:Record<string,string[]>={instagram:['hikerapi','tikhub','scrapecreators'],youtube:['youtube-official','tikhub','scrapecreators'],tiktok:['lamatok','tikhub','scrapecreators']};
const envKeys:Record<string,string>={'youtube-official':'YOUTUBE_API_KEY',hikerapi:'HIKERAPI_KEY',lamatok:'LAMATOK_KEY',tikhub:'TIKHUB_KEY',scrapecreators:'SCRAPECREATORS_KEY'};
function validated<T>(fn:()=>T):T{try{return fn();}catch(e){throw new ApiError(e instanceof Error?e.message:'Check these details.');}}
export async function GET(request:Request){try{
  const actor=await requireAdmin(),db=database(),params=new URL(request.url).searchParams;
  if(params.get('section')==='page'){
    const ownerId=validated(()=>validId(params.get('ownerId'))),pageId=validated(()=>validId(params.get('pageId')));
    const page=await query(db.from('pages').select('id,name,handle,platform,monthly_pay,editor,start_date,active,notes').eq('id',pageId).eq('owner',ownerId).maybeSingle());
    if(!page)throw new ApiError('Page not found.',404);return json({page});
  }
  const [settings,usage,requests,failed]=await Promise.all([
    query(db.from('provider_settings').select('*').eq('id',true).single()),
    query(db.rpc('desk_admin_provider_report',{p_actor:actor.id})),
    query(db.from('provider_requests').select('id,provider,platform,endpoint,funding,success,latency_ms,estimated_cost_usd,created_at').order('created_at',{ascending:false}).limit(100)),
    query(db.from('pages').select('id,owner,name,handle,platform,last_synced_at').not('sync_error','is',null).neq('sync_error','').order('last_synced_at',{ascending:true,nullsFirst:true}).limit(100)),
  ]);
  return json({settings,usage,requests,failed,keys:Object.fromEntries(Object.entries(envKeys).map(([id,key])=>[id,!!process.env[key]?.trim()])),schedulerConfigured:(process.env.CRON_SECRET?.length||0)>=32});
}catch(e){return fail(e);}}
export async function POST(request:Request){try{
  guard(request);const actor=await requireAdmin(),data=await body(request),db=database();
  if(data.action==='saveProviderSettings'){
    const order:Record<string,string[]>={};
    for(const [platform,ids] of Object.entries(allowed)){
      const value=data.providerOrder?.[platform];
      if(!Array.isArray(value)||!value.length||value.length>ids.length||new Set(value).size!==value.length||value.some((id:unknown)=>typeof id!=='string'||!ids.includes(id)))throw new ApiError('Choose an ordered provider list for '+platform+'.');
      order[platform]=value;
    }
    const cap=Number(data.monthlyRequestCap),budget=Number(data.monthlyBudgetUsd),interval=Number(data.refreshIntervalHours);
    if(!Number.isInteger(cap)||cap<1||cap>1000000||!Number.isFinite(budget)||budget<0||budget>25||!Number.isInteger(interval)||interval<1||interval>168||typeof data.refreshEnabled!=='boolean')throw new ApiError('Use a request cap of 1–1,000,000, a budget up to $25, and an interval of 1–168 hours.');
    const costs:Record<string,number>={};
    for(const id of Object.keys(envKeys)){const cost=data.requestCosts?.[id];if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0||cost>25||(id!=='youtube-official'&&cost===0))throw new ApiError('Enter a positive estimated request cost for each paid provider.');costs[id]=Math.round(cost*1000000)/1000000;if(id!=='youtube-official'&&costs[id]===0)throw new ApiError('The minimum paid request estimate is $0.000001.');}
    await query(db.from('provider_settings').update({provider_order:order,monthly_request_cap:cap,monthly_budget_usd:budget,request_costs:costs,refresh_enabled:data.refreshEnabled,refresh_interval_hours:interval}).eq('id',true));
    return json({ok:true});
  }
  const targetOwner=validated(()=>validId(data.ownerId));
  if(data.action==='assignPage')return json(await addManagedPage(actor.id,targetOwner,data));
  const pageId=validated(()=>validId(data.pageId));
  if(data.action==='refreshPage')return json(await refreshWorkspacePage(targetOwner,pageId,{mode:'posts',postLimit:100,from:null,to:null}));
  if(data.action==='savePage'){
    const metadata=validated(()=>pageMetadata(data));
    const rows=await query(db.from('pages').update(metadata).eq('id',pageId).eq('owner',targetOwner).select('id'));
    if(!rows?.length)throw new ApiError('Page not found.',404);return json({ok:true});
  }
  if(data.action==='removePage'){
    const rows=await query(db.from('pages').delete().eq('id',pageId).eq('owner',targetOwner).select('id'));
    if(!rows?.length)throw new ApiError('Page not found.',404);return json({ok:true});
  }
  throw new ApiError('Unknown action.');
}catch(e){return fail(e);}}
