import {ApiError,body,database,fail,guard,json,owner,query} from '@/lib/server';
import {analyticsChunk,reconcileWorkspaceAlerts} from '@/lib/analytics/server';
import {activeInput,contentLink,pageMetadata,validId} from '@/lib/analytics/input';
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
  if(data.action==='setActive'){
    // Only the status changes; the database ends pay today on deactivation and clears the end date on reactivation.
    const {pageId,active}=validated(()=>activeInput(data));
    const rows=await query(db.from('pages').update({active}).eq('id',pageId).eq('owner',user).select('id,active,end_date')) as {active:boolean;end_date:string|null}[];
    if(!rows?.length)throw new ApiError('Page not found.',404);return json({ok:true,active:rows[0].active,endDate:typeof rows[0].end_date==='string'?rows[0].end_date.slice(0,10):null});
  }
  if(data.action==='linkContent'){
    const link=validated(()=>contentLink(data));
    const result=await query(db.rpc('desk_link_content',{p_owner:user,p_posts:link.posts,p_mode:link.mode,p_group:link.groupId})) as {groupId:string|null;linked:number};
    return json({ok:true,groupId:result.groupId??null,linked:result.linked});
  }
  if(data.action==='reconcileAlerts'){
    const result=await reconcileWorkspaceAlerts(user);
    if(!result)throw new ApiError('This workspace history is too large to check alerts in one pass.',409);return json({ok:true,...result});
  }
  if(data.action==='addPage'){
    return json(await addManagedPage(user,user,data));
  }
  throw new ApiError('Unknown action.');
}catch(e){return fail(e);}}
