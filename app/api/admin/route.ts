import { ApiError, database, fail, json, query, requireAdmin } from '@/lib/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const sections=new Set(['overview','users','pages','collections']);
function integer(value:string|null,fallback:number,max:number){
  if(value===null)return fallback;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max)throw new ApiError('Invalid pagination.');
  return Number(value);
}
function identifier(value:string|null){
  if(value===null||value==='')return null;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new ApiError('Invalid item.');
  return value;
}
/** The role is checked here and again inside the service-only report RPC. */
export async function GET(request:Request){try{
  const account=await requireAdmin();
  const url=new URL(request.url),section=url.searchParams.get('section')||'overview';
  if(!sections.has(section))throw new ApiError('Choose users, pages, collections, or overview.');
  const limit=integer(url.searchParams.get('limit'),25,100),offset=integer(url.searchParams.get('offset'),0,1000000);
  if(limit<1)throw new ApiError('Choose a page size between 1 and 100.');
  const search=(url.searchParams.get('search')||'').trim();
  if(search.length>200)throw new ApiError('Search must be 200 characters or fewer.');
  const ownerId=identifier(url.searchParams.get('ownerId')),collectionId=identifier(url.searchParams.get('collectionId'));
  if(collectionId&&section!=='pages')throw new ApiError('Collection filtering is available in the pages section.');
  return json(await query(database().rpc('desk_admin_report',{
    p_actor:account.id,p_section:section,p_limit:limit,p_offset:offset,
    p_search:search,p_owner:ownerId,p_collection:collectionId,
  })));
}catch(error){return fail(error);}}
