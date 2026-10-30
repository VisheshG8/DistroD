import 'server-only';
import {ApiError,database,query} from '@/lib/server';
import {pageInput,pageMetadata,validId} from './input';
import {refreshWorkspacePage} from '@/lib/refresh-service';
const RECENT_REFRESH_MS=6*3600000;
export async function addManagedPage(actor:string,ownerId:string,data:Record<string,unknown>) {
  let parsed,metadata,collection;
  try { parsed=pageInput(data);metadata=pageMetadata(data);collection=data.collectionId?validId(data.collectionId):null; }
  catch(e){throw new ApiError(e instanceof Error?e.message:'Check these page details.');}
  const added=await query(database().rpc('desk_add_managed_page',{p_actor:actor,p_owner:ownerId,p_page:parsed,p_metadata:metadata,p_collection:collection,p_details:true})) as {pageId:string;existed:boolean;lastSyncedAt:string|null};
  let pageId=String(added.pageId),warning:string|undefined;const existed=added.existed===true,synced=Date.parse(String(added.lastSyncedAt||''));
  // A page already tracked and refreshed recently keeps its snapshot instead of spending provider requests again.
  if(existed&&Number.isFinite(synced)&&Date.now()-synced<RECENT_REFRESH_MS)return {ok:true,pageId,existed,refreshed:false};
  try {const result=await refreshWorkspacePage(ownerId,pageId,{mode:'posts',postLimit:100,from:null,to:null});pageId=String(result.page.id);}
  catch(e){warning=e instanceof ApiError?e.message:'The page is saved. Its first refresh could not finish; retry from Pages.';}
  return {ok:true,pageId,existed,refreshed:!warning,warning};
}
