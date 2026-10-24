import { ApiError, database, fail, json, requireAdmin } from '@/lib/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';

type Row=Record<string,unknown>;
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
const literalLike=(value:string)=>'%'+value.replace(/[!%_]/g,'!$&')+'%';
function parsedObject(value:unknown):Row{
  if(value&&typeof value==='object'&&!Array.isArray(value))return value as Row;
  if(typeof value!=='string')return {};
  try{const parsed:unknown=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Row:{};}catch{return {};}
}
function count(value:unknown){
  if(typeof value==='string'&&/^\d+$/.test(value))value=Number(value);
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
}
function timestamp(value:unknown){return value instanceof Date?(Number.isFinite(value.getTime())?value.toISOString():null):typeof value==='string'?value:null;}
function summaryRecord(row:Row|null){return Object.fromEntries(['users','admins','collections','pages','memberships'].map(key=>[key,count(row?.[key])??0]));}
function ownerDetails(row:Row){return {ownerId:String(row.owner),ownerEmail:typeof row.owner_email==='string'?row.owner_email:null,ownerName:typeof row.owner_name==='string'?row.owner_name:null};}
const collectionColumns=`c.id,c.owner,c.name,c.created_at,u.email AS owner_email,u.name AS owner_name,
  (SELECT COUNT(*) FROM public.memberships m JOIN public.pages p ON p.id=m.page_id AND p.owner=c.owner WHERE m.collection_id=c.id AND m.owner=c.owner) AS page_count`;
function collectionRecord(row:Row){return {id:row.id,name:row.name,createdAt:timestamp(row.created_at),pageCount:count(row.page_count)??0,...ownerDetails(row)};}
function postSum(key:'views'|'likes'|'comments'|'shares'){
  const value=`(post.value->>'${key}')::numeric`;
  // Nested CASE keeps casts away from missing, string, boolean or object counters.
  return `SUM(CASE WHEN jsonb_typeof(post.value->'${key}')='number' THEN
    CASE WHEN ${value} BETWEEN 0 AND 9007199254740991 AND trunc(${value})=${value} THEN ${value} ELSE NULL END
    ELSE NULL END)`;
}
/** Return summaries only. API keys, settings and individual post payloads are never selected into the response. */
function pageRecord(row:Row){
  const coverage=parsedObject(row.coverage),metrics=parsedObject(row.metrics),overall=parsedObject(row.overall);
  return {id:row.id,platform:row.platform,handle:row.handle,name:row.name,url:row.url,followers:count(row.followers),
    lastSyncedAt:timestamp(row.last_synced_at),hasSyncError:row.has_sync_error===true||Number(row.has_sync_error)===1,selectedPostCount:count(metrics.posts)??0,
    views:count(metrics.views),likes:count(metrics.likes),comments:count(metrics.comments),shares:count(metrics.shares),
    lifetimeViews:count(overall.views),lifetimePosts:count(overall.posts),collectionCount:count(row.collection_count)??0,...ownerDetails(row),
    coverage:{mode:coverage.requestedMode==='date'?'date':'posts',limit:count(coverage.limit),
      from:typeof coverage.from==='string'?coverage.from:null,to:typeof coverage.to==='string'?coverage.to:null,complete:coverage.complete===true}};
}

export async function GET(request:Request){try{
  // Check the stored role on every request, before reading any cross-workspace records.
  await requireAdmin();
  const db=database(),url=new URL(request.url),section=url.searchParams.get('section')||'overview';
  if(!sections.has(section))throw new ApiError('Choose users, pages, collections, or overview.');
  const limit=integer(url.searchParams.get('limit'),25,100),offset=integer(url.searchParams.get('offset'),0,1000000);
  if(limit<1)throw new ApiError('Choose a page size between 1 and 100.');
  const search=(url.searchParams.get('search')||'').trim();
  if(search.length>200)throw new ApiError('Search must be 200 characters or fewer.');
  const ownerId=identifier(url.searchParams.get('ownerId')),collectionId=identifier(url.searchParams.get('collectionId'));
  if(collectionId&&section!=='pages')throw new ApiError('Collection filtering is available in the pages section.');
  const summaryPromise=db.prepare(`SELECT
    (SELECT COUNT(*) FROM public.users) AS users,(SELECT COUNT(*) FROM public.users WHERE user_type='admin') AS admins,
    (SELECT COUNT(*) FROM public.collections) AS collections,(SELECT COUNT(*) FROM public.pages) AS pages,
    (SELECT COUNT(*) FROM public.memberships) AS memberships`).first<Row>();
  if(section==='overview')return json({section,items:[],total:0,limit,offset,hasMore:false,summary:summaryRecord(await summaryPromise)});
  const conditions:string[]=[],bindings:(string|number)[]=[];
  let table='',columns='',order='',record:(row:Row)=>unknown;
  let collection:ReturnType<typeof collectionRecord>|undefined;
  if(section==='users'){
    table='public.users u';
    columns=`u.id,u.email,u.name,u.user_type,u.created_at,u.last_seen_at,
      (SELECT COUNT(*) FROM public.collections c WHERE c.owner=u.id) AS collection_count,
      (SELECT COUNT(*) FROM public.pages p WHERE p.owner=u.id) AS page_count`;
    order='u.created_at DESC,u.id';
    if(ownerId){conditions.push('u.id=?');bindings.push(ownerId);}
    if(search){conditions.push("(u.email ILIKE ? ESCAPE '!' OR u.name ILIKE ? ESCAPE '!' OR u.id::text ILIKE ? ESCAPE '!')");bindings.push(...Array(3).fill(literalLike(search)));}
    record=row=>({id:row.id,email:row.email??null,name:row.name??null,userType:row.user_type==='admin'?'admin':'user',
      createdAt:timestamp(row.created_at),lastSeenAt:timestamp(row.last_seen_at),collectionCount:count(row.collection_count)??0,pageCount:count(row.page_count)??0});
  }else if(section==='collections'){
    table='public.collections c LEFT JOIN public.users u ON u.id=c.owner';columns=collectionColumns;order='c.created_at DESC,c.id';
    if(ownerId){conditions.push('c.owner=?');bindings.push(ownerId);}
    if(search){conditions.push("(c.name ILIKE ? ESCAPE '!' OR u.email ILIKE ? ESCAPE '!' OR u.name ILIKE ? ESCAPE '!' OR c.owner::text ILIKE ? ESCAPE '!')");bindings.push(...Array(4).fill(literalLike(search)));}
    record=collectionRecord;
  }else{
    table='public.pages p LEFT JOIN public.users u ON u.id=p.owner';
    columns=`p.id,p.owner,p.platform,p.handle,p.name,p.url,p.followers,p.last_synced_at,p.coverage,p.overall,
      CASE WHEN p.sync_error IS NOT NULL AND p.sync_error<>'' THEN 1 ELSE 0 END AS has_sync_error,
      u.email AS owner_email,u.name AS owner_name,
      (SELECT COUNT(*) FROM public.memberships m JOIN public.collections c ON c.id=m.collection_id AND c.owner=p.owner WHERE m.page_id=p.id AND m.owner=p.owner) AS collection_count,
      (SELECT jsonb_build_object('posts',COUNT(*),'views',${postSum('views')},'likes',${postSum('likes')},'comments',${postSum('comments')},'shares',${postSum('shares')})
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.posts)='array' THEN p.posts ELSE '[]'::jsonb END) AS post(value)) AS metrics`;
    order='p.last_synced_at DESC NULLS LAST,p.name,p.id';
    if(ownerId){conditions.push('p.owner=?');bindings.push(ownerId);}
    if(collectionId){
      const row=await db.prepare(`SELECT ${collectionColumns} FROM public.collections c LEFT JOIN public.users u ON u.id=c.owner WHERE c.id=?`).bind(collectionId).first<Row>();
      if(!row)throw new ApiError('Collection not found.',404);
      collection=collectionRecord(row);
      conditions.push('EXISTS (SELECT 1 FROM public.memberships m WHERE m.page_id=p.id AND m.collection_id=? AND m.owner=p.owner)');bindings.push(collectionId);
    }
    if(search){conditions.push("(p.name ILIKE ? ESCAPE '!' OR p.handle ILIKE ? ESCAPE '!' OR p.url ILIKE ? ESCAPE '!' OR u.email ILIKE ? ESCAPE '!' OR u.name ILIKE ? ESCAPE '!' OR p.owner::text ILIKE ? ESCAPE '!')");bindings.push(...Array(6).fill(literalLike(search)));}
    record=pageRecord;
  }
  const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
  const [summary,totalResult,result]=await Promise.all([
    summaryPromise,db.prepare(`SELECT COUNT(*) AS total FROM ${table}${where}`).bind(...bindings).first<Row>(),
    db.prepare(`SELECT ${columns} FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...bindings,limit,offset).all<Row>(),
  ]);
  const total=count(totalResult?.total)??0;
  return json({section,items:result.results.map(record),total,limit,offset,hasMore:offset+result.results.length<total,summary:summaryRecord(summary),...(collection?{collection}:{})});
}catch(error){return fail(error);}}
