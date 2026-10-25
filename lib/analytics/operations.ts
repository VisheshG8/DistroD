import 'server-only';
import {ApiError,database,query} from '@/lib/server';
import {pageInput,pageMetadata,validId} from './input';
import {refreshWorkspacePage} from '@/lib/refresh-service';
export async function addManagedPage(actor:string,ownerId:string,data:Record<string,unknown>) {
  let parsed,metadata,collection;
  try { parsed=pageInput(data);metadata=pageMetadata(data);collection=data.collectionId?validId(data.collectionId):null; }
  catch(e){throw new ApiError(e instanceof Error?e.message:'Check these page details.');}
  let pageId=String(await query(database().rpc('desk_add_managed_page',{p_actor:actor,p_owner:ownerId,p_page:parsed,p_metadata:metadata,p_collection:collection})));
  let warning:string|undefined;
  try {const result=await refreshWorkspacePage(ownerId,pageId,{mode:'posts',postLimit:100,from:null,to:null});pageId=String(result.page.id);}
  catch(e){warning=e instanceof ApiError?e.message:'The page is saved. Its first refresh could not finish; retry from Pages.';}
  return {ok:true,pageId,warning};
}
