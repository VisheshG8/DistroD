import 'server-only';
import { ApiError, database, query } from '@/lib/server';
import { scopeFromDates } from '@/lib/scope';
import { alertCheck, rangeForPreset } from './metrics';
import { validId, validRange } from './input';
import type { AnalyticsDataset, AnalyticsPage, AnalyticsPost, AnalyticsAlert } from './types';

const BATCH = 1000;
const stages = ['posts','accounts','snapshots','alerts','memberships'] as const;
type Stage = typeof stages[number];
type Cursor = {stage:Stage;offset:number;at:string;range:string};
type Row = Record<string, unknown>;
const counter = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
// Durations are fractional seconds (Instagram 12.4, TikTok ms ÷ 1000), so they are not counters.
const seconds = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 86400 ? Math.round(value * 1000) / 1000 : null;
const string = (value: unknown, max = 2000) => typeof value === 'string' ? value.slice(0,max) : '';
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const url = (value: unknown) => typeof value === 'string' && /^https:\/\//i.test(value) ? value.slice(0,1000) : '';
export function analyticsPost(row: Row): AnalyticsPost {
  const p = row.payload && typeof row.payload === 'object' ? row.payload as Row : row;
  return {id:string(row.post_id || p.id,300),pageId:string(row.page_id || p.pageId,100),platform:string(p.platform,20),url:url(p.url),title:string(p.title || p.caption,1000),publishedAt:date(p.publishedAt),thumbnail:url(p.thumbnail) || null,durationSeconds:seconds(p.durationSeconds),views:counter(p.views),likes:counter(p.likes),comments:counter(p.comments),shares:counter(p.shares),saves:counter(p.saves),type:string(p.type,50) || null,audioId:string(p.audioId,200) || null,sourceAssetId:string(row.source_asset_id,300) || null,observedAt:date(row.observed_at)};
}
function bounds(params: URLSearchParams) {
  const fallback = rangeForPreset('30d');
  const range = validRange(params.get('from') || fallback.from,params.get('to') || fallback.to);
  const comparison = params.has('compareFrom') || params.has('compareTo') ? validRange(params.get('compareFrom'),params.get('compareTo')) : null;
  const pageId = params.get('pageId') ? validId(params.get('pageId')) : null;
  const start = Math.min(Date.parse(scopeFromDates(range.from,range.to).from!), comparison ? Date.parse(scopeFromDates(comparison.from,comparison.to).from!) : Infinity) - 100 * 86400000;
  return {start:new Date(start).toISOString(),key:JSON.stringify([range,comparison,pageId]),pageId};
}
function decodeCursor(value: string | null, key: string): Cursor | null {
  if (!value) return null;
  try {
    if (value.length>1500) throw new Error();
    const c = JSON.parse(Buffer.from(value,'base64url').toString()) as Cursor;
    if (!stages.includes(c.stage) || !Number.isSafeInteger(c.offset) || c.offset<0 || c.offset>5000000 || !date(c.at) || Date.parse(c.at)>Date.now()+60000 || c.range!==key) throw new Error();
    return c;
  } catch { throw new ApiError('This history page is invalid. Reload the dashboard.'); }
}
export async function analyticsChunk(ownerId:string, params:URLSearchParams) {
  let window;try { window=bounds(params); } catch(e) { throw new ApiError(e instanceof Error?e.message:'Choose a valid range.'); }
  const cursor=decodeCursor(params.get('cursor'),window.key),at=cursor?.at || new Date().toISOString(),db=database();
  const encode=(stage:Stage,offset:number)=>Buffer.from(JSON.stringify({stage,offset,at,range:window.key})).toString('base64url');
  if (!cursor) {
    let select=db.from('pages').select('id,platform,handle,url,name,followers,last_synced_at,sync_error,monthly_pay,editor,start_date,active,notes,coverage,display_name,end_date,alert_quiet_days').eq('owner',ownerId).order('id');
    if(window.pageId)select=select.eq('id',window.pageId);
    // Existing workspace limits bound this metadata to 500 pages and 100 collections.
    // A scoped page needs only its own groups; never infer ownership from the URL.
    const [rows,collectionRows,pageMemberships]=await Promise.all([
      query(select) as Promise<Row[]>,
      query(db.from('collections').select('id,name').eq('owner',ownerId).order('id')) as Promise<Row[]>,
      window.pageId ? query(db.from('memberships').select('collection_id').eq('owner',ownerId).eq('page_id',window.pageId)) as Promise<Row[]> : Promise.resolve(null),
    ]);
    const collectionIds=pageMemberships ? new Set(pageMemberships.map(r=>String(r.collection_id))) : null;
    const collections=(collectionRows || []).filter(r=>!collectionIds || collectionIds.has(String(r.id))).map(r=>({id:string(r.id,100),name:string(r.name,100)}));
    const pages:AnalyticsPage[]=(rows || []).map(r=>({id:string(r.id),platform:r.platform as AnalyticsPage['platform'],handle:string(r.handle,100),url:url(r.url),name:string(r.name,300),followers:counter(r.followers),lastSyncedAt:date(r.last_synced_at),syncError:string(r.sync_error,500)||null,posts:[],monthlyPay:r.monthly_pay==null?null:Number(r.monthly_pay),editor:string(r.editor,150),startDate:typeof r.start_date==='string'?r.start_date.slice(0,10):null,active:r.active!==false,notes:string(r.notes),displayName:string(r.display_name,150),endDate:typeof r.end_date==='string'?r.end_date.slice(0,10):null,alertQuietDays:Number.isInteger(r.alert_quiet_days)?Number(r.alert_quiet_days):null,coverage:r.coverage&&typeof r.coverage==='object'?r.coverage as AnalyticsPage['coverage']:undefined}));
    return {pages,collections,generatedAt:at,nextCursor:pages.length?encode('posts',0):null,parallelCursors:pages.length?stages.map(stage=>encode(stage,0)):[]};
  }
  const {stage,offset}=cursor;
  if(stage==='memberships'){
    // Group membership is current workspace metadata, separate from historical observations.
    let select=db.from('memberships').select('collection_id,page_id').eq('owner',ownerId).order('collection_id').order('page_id');
    if(window.pageId)select=select.eq('page_id',window.pageId);
    const rows=await query(select.range(offset,offset+BATCH-1)) as Row[];
    const nextStageCursor=rows.length===BATCH?encode(stage,offset+BATCH):null;
    return {generatedAt:at,memberships:rows.map(r=>({collectionId:string(r.collection_id,100),pageId:string(r.page_id,100)})),nextCursor:nextStageCursor,nextStageCursor};
  }
  const table=stage==='posts'?'page_posts':stage==='accounts'?'account_snapshots':stage==='snapshots'?'post_snapshots':'alerts';
  const columns:string=stage==='posts'?'post_id,page_id,payload,source_asset_id,observed_at':stage==='accounts'?'page_id,observed_at,followers,following,post_count':stage==='snapshots'?'page_id,post_id,observed_at,views,likes,comments,shares,saves':'id,page_id,level,type,title,details,created_at,resolved_at,post_id';
  let select=db.from(table).select(columns).eq('owner',ownerId);
  if(window.pageId)select=select.eq('page_id',window.pageId);
  if(stage==='posts')select=select.lte('created_at',at).order('page_id').order('post_id');
  else if(stage==='alerts')select=select.lte('created_at',at).order('created_at').order('id');
  else select=select.gte('observed_at',window.start).lte('observed_at',at).order('page_id').order('observed_at');
  if(stage==='snapshots')select=select.order('post_id');
  const rows=await query(select.range(offset,offset+BATCH-1).returns<Row[]>());
  const next=stages[stages.indexOf(stage)+1];
  const nextStageCursor=rows.length===BATCH?encode(stage,offset+BATCH):null;
  const base={generatedAt:at,nextCursor:nextStageCursor || (next?encode(next,0):null),nextStageCursor};
  if(stage==='posts')return {...base,posts:rows.map(analyticsPost)};
  if(stage==='accounts')return {...base,accountSnapshots:rows.map(r=>({pageId:string(r.page_id),observedAt:date(r.observed_at)!,followers:counter(r.followers),following:counter(r.following),postCount:counter(r.post_count)}))};
  if(stage==='snapshots')return {...base,postSnapshots:rows.map(r=>({pageId:string(r.page_id),postId:string(r.post_id,300),observedAt:date(r.observed_at)!,views:counter(r.views),likes:counter(r.likes),comments:counter(r.comments),shares:counter(r.shares),saves:counter(r.saves)}))};
  return {...base,alerts:rows.map(r=>({id:string(r.id),pageId:string(r.page_id),level:r.level as AnalyticsAlert['level'],type:string(r.type,64),title:string(r.title,200),details:string(r.details),createdAt:date(r.created_at)!,resolvedAt:date(r.resolved_at),postId:string(r.post_id,300)||null}))};
}
export type AlertReconciliation = {opened:number;resolved:number;unchecked:number};
/** Pages the engine could not check now keep their open alerts; null means the history was too large to check. */
export async function reconcileWorkspaceAlerts(ownerId:string, now=new Date()):Promise<AlertReconciliation|null> {
  const range=rangeForPreset('90d',now),params=new URLSearchParams(range);
  const dataset:AnalyticsDataset={pages:[],accountSnapshots:[],postSnapshots:[],alerts:[],generatedAt:now.toISOString()};
  const posts:AnalyticsPost[]=[];
  let chunks=0;
  do {
    const chunk=await analyticsChunk(ownerId,params);
    if('pages' in chunk)dataset.pages.push(...(chunk.pages || []));
    if('posts' in chunk)posts.push(...(chunk.posts || []));
    if('accountSnapshots' in chunk)dataset.accountSnapshots.push(...(chunk.accountSnapshots || []));
    if('postSnapshots' in chunk)dataset.postSnapshots.push(...(chunk.postSnapshots || []));
    if('alerts' in chunk)dataset.alerts.push(...(chunk.alerts || []));
    if(!chunk.nextCursor)break;
    // An incomplete history must never generate misleading alerts.
    if(++chunks>200)return null;
    params.set('cursor',chunk.nextCursor);
  } while(true);
  const grouped=new Map<string,AnalyticsPost[]>();
  for(const post of posts){const list=grouped.get(post.pageId)||[];list.push(post);grouped.set(post.pageId,list);}
  for(const page of dataset.pages)page.posts=grouped.get(page.id)||[];
  const check=alertCheck(dataset,now),skip=[...new Set(check.unchecked.map(item=>item.pageId))];
  const result=await query(database().rpc('desk_reconcile_alerts',{p_owner:ownerId,p_candidates:check.candidates,p_observed_at:now.toISOString(),p_skip_pages:skip})) as {opened:number;resolved:number};
  return {opened:Number(result?.opened)||0,resolved:Number(result?.resolved)||0,unchecked:skip.length};
}
