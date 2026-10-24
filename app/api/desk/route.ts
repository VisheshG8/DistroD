import { ApiError, body, database, encrypt, fail, guard, json, owner, pageRecord, preferences, query, queryRows } from '@/lib/server';
import { parsePage, type Platform } from '@/lib/pages';
export const dynamic='force-dynamic';
export const runtime='nodejs';
function name(value:unknown){if(typeof value!=='string'||!value.trim()||value.trim().length>100)throw new ApiError('Use a collection name between 1 and 100 characters.');return value.trim();}
function identifier(value:unknown){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new ApiError('Invalid item.');return value;}

export async function GET(){try{
 const user=await owner(),db=database(),s=await preferences(user),month=new Date().toISOString().slice(0,7);
 const [collections,memberships,usage]=await Promise.all([
  query(db.from('collections').select('id,name,created_at').eq('owner',user).order('created_at').order('id')),
  queryRows((from,to)=>db.from('memberships').select('collection_id,page_id').eq('owner',user).order('collection_id').order('page_id').range(from,to)),
  query(db.from('usage').select('requests').eq('owner',user).eq('month',month).maybeSingle<Record<string,unknown>>()),
 ]);
 const pageIds=new Set((memberships||[]).map(row=>String(row.page_id)));
 // A workspace has at most 500 pages. Avoid putting hundreds of UUIDs in a URL.
 const allPages=pageIds.size?await query(db.from('pages').select('*').eq('owner',user).order('name')):[];
 const pages=(allPages||[]).filter(row=>pageIds.has(String(row.id)));
 return json({collections:(collections||[]).map(row=>({id:row.id,name:row.name,createdAt:row.created_at})),
  memberships:(memberships||[]).map(row=>({collectionId:row.collection_id,pageId:row.page_id})),
  pages:(pages||[]).map(pageRecord),settings:{provider:s.provider,hasApiKey:!!s.api_key,hasYoutubeKey:!!s.youtube_key,postLimit:s.post_limit,requestLimit:s.request_limit,requestsUsed:usage?.requests||0,requestMonth:month}});
 }catch(e){return fail(e);}}

export async function POST(request:Request){try{
 guard(request);const user=await owner(),data=await body(request),db=database();
 const collection=async(id:unknown)=>{const found=await query(db.from('collections').select('id,name').eq('id',identifier(id)).eq('owner',user).maybeSingle<Record<string,unknown>>());if(!found)throw new ApiError('Collection not found.',404);return found;};
 if(data.action==='createCollection'){
  const id=crypto.randomUUID();await query(db.rpc('desk_create_collection',{p_owner:user,p_name:name(data.name),p_id:id}));return json({ok:true,id});
 }
 if(data.action==='renameCollection'){
  await collection(data.id);
  const updated=await query(db.from('collections').update({name:name(data.name)}).eq('id',data.id).eq('owner',user).select('id'));
  if(!updated?.length)throw new ApiError('Collection not found.',404);return json({ok:true});
 }
 if(data.action==='deleteCollection'){
  await query(db.rpc('desk_delete_collection',{p_owner:user,p_collection:identifier(data.id)}));return json({ok:true});
 }
 if(data.action==='duplicateCollection'){
  const original=await collection(data.id),id=crypto.randomUUID();
  await query(db.rpc('desk_duplicate_collection',{p_owner:user,p_collection:identifier(data.id),p_name:name(data.name||(original.name+' copy').slice(0,100)),p_id:id}));return json({ok:true,id});
 }
 if(data.action==='removePage'){
  await query(db.rpc('desk_remove_page',{p_owner:user,p_collection:identifier(data.collectionId),p_page:identifier(data.pageId)}));return json({ok:true});
 }
 if(data.action==='addPages'){
  await collection(data.collectionId);if(!Array.isArray(data.inputs)||!data.inputs.length||data.inputs.length>100)throw new ApiError('Add between 1 and 100 pages at a time.');
  const platform:Platform=['instagram','tiktok','youtube'].includes(data.platform)?data.platform:'instagram';
  const errors:string[]=[];let added=0;const seen=new Set<string>();
  for(const input of data.inputs){try{
   if(typeof input!=='string'||input.length>300)throw new ApiError('Invalid page input.');
   let page:ReturnType<typeof parsePage>;try{page=parsePage(input,platform);}catch(error){throw new ApiError(error instanceof Error?error.message:'Invalid page input.');}
   const key=page.platform+':'+page.handle;if(seen.has(key))continue;seen.add(key);
   added+=Number(await query(db.rpc('desk_add_page',{p_owner:user,p_collection:data.collectionId,p_platform:page.platform,p_handle:page.handle,p_url:page.url})));
  }catch(e){errors.push(String(input).slice(0,100)+': '+(e instanceof ApiError?e.message:'Could not add this page. Please reload and retry.'));}}
  return json({ok:true,added,errors});
 }
 if(data.action==='saveSettings'){
  const current=await preferences(user);if(!['tikhub','scrapecreators'].includes(data.provider))throw new ApiError('Choose a supported data provider.');
  const limit=Number(data.postLimit),cap=Number(data.requestLimit);if(![30,100].includes(limit)||!Number.isInteger(cap)||cap<10||cap>2500)throw new ApiError('Choose 30 or 100 posts and a monthly request cap between 10 and 2,500.');
  const cleanKey=(value:unknown)=>{if(typeof value!=='string'||value.length>2000||/[\r\n]/.test(value))throw new ApiError('Enter a valid API key.');return value.trim();};
  let apiKey=current.api_key,ytKey=current.youtube_key;
  if(data.clearApiKey||data.provider!==current.provider)apiKey=null;
  if(data.clearYoutubeKey)ytKey=null;
  if(data.apiKey)apiKey=await encrypt(cleanKey(data.apiKey));if(data.youtubeKey)ytKey=await encrypt(cleanKey(data.youtubeKey));
  await query(db.from('settings').update({provider:data.provider,api_key:apiKey,youtube_key:ytKey,post_limit:limit,request_limit:cap}).eq('owner',user));return json({ok:true});
 }
 throw new ApiError('Unknown action.');
 }catch(e){return fail(e);}}
