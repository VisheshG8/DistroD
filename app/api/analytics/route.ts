import {ApiError,body,database,fail,guard,json,owner,query} from '@/lib/server';
import {analyticsChunk} from '@/lib/analytics/server';
import {pageMetadata,validId} from '@/lib/analytics/input';
import {addManagedPage} from '@/lib/analytics/operations';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=300;
function validated<T>(fn:()=>T):T{try{return fn();}catch(e){throw new ApiError(e instanceof Error?e.message:'Check these details.');}}
export async function GET(request:Request){try{return json(await analyticsChunk(await owner(),new URL(request.url).searchParams));}catch(e){return fail(e);}}
export async function POST(request:Request){try{
  guard(request);const user=await owner(),data=await body(request),db=database();
  if(data.action==='savePage'){
    const id=validated(()=>validId(data.pageId)),metadata=validated(()=>pageMetadata(data));
    const rows=await query(db.from('pages').update(metadata).eq('id',id).eq('owner',user).select('id'));
    if(!rows?.length)throw new ApiError('Page not found.',404);return json({ok:true});
  }
  if(data.action==='removePage'){
    const id=validated(()=>validId(data.pageId));
    const rows=await query(db.from('pages').delete().eq('id',id).eq('owner',user).select('id'));
    if(!rows?.length)throw new ApiError('Page not found.',404);return json({ok:true});
  }
  if(data.action==='resolveAlert'){
    const id=validated(()=>validId(data.id));
    const rows=await query(db.from('alerts').update({resolved_at:new Date().toISOString()}).eq('id',id).eq('owner',user).select('id'));
    if(!rows?.length)throw new ApiError('Alert not found.',404);return json({ok:true});
  }
  if(data.action==='addPage'){
    return json(await addManagedPage(user,user,data));
  }
  throw new ApiError('Unknown action.');
}catch(e){return fail(e);}}
