import { ApiError, body, database, encrypt, fail, guard, json, owner, pageRecord, preferences } from '@/lib/server';
import { parsePage, type Platform } from '@/lib/pages';
export const dynamic='force-dynamic';
export const runtime='nodejs';
function name(value:unknown){if(typeof value!=='string'||!value.trim()||value.trim().length>100)throw new ApiError('Use a collection name between 1 and 100 characters.');return value.trim();}
function identifier(value:unknown){if(typeof value!=='string'||!/^\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b$/i.test(value))throw new ApiError('Invalid item.');return value;}

export async function GET(){try{
 const user=await owner(),db=database(),s=await preferences(user),month=new Date().toISOString().slice(0,7);
 const [c,m,p,u]=await Promise.all([
  db.prepare('SELECT id,name,created_at AS "createdAt" FROM collections WHERE owner=? ORDER BY created_at,id').bind(user).all(),
  db.prepare('SELECT collection_id AS "collectionId",page_id AS "pageId" FROM memberships WHERE owner=?').bind(user).all(),
  db.prepare('SELECT * FROM pages WHERE owner=? AND EXISTS (SELECT 1 FROM memberships m WHERE m.page_id=pages.id AND m.owner=?) ORDER BY name').bind(user,user).all(),
  db.prepare('SELECT requests FROM usage WHERE owner=? AND month=?').bind(user,month).first(),
 ]);
 return json({collections:c.results,memberships:m.results,pages:p.results.map(pageRecord),settings:{provider:s.provider,hasApiKey:!!s.api_key,hasYoutubeKey:!!s.youtube_key,postLimit:s.post_limit,requestLimit:s.request_limit,requestsUsed:u?.requests||0,requestMonth:month}});
 }catch(e){return fail(e);}}

export async function POST(request:Request){try{
 guard(request);const user=await owner(),data=await body(request),db=database();
 const collection=async(id:unknown)=>{const found=await db.prepare('SELECT * FROM collections WHERE id=? AND owner=?').bind(identifier(id),user).first();if(!found)throw new ApiError('Collection not found.',404);return found;};
 if(data.action==='createCollection'){
  const count=await db.prepare('SELECT COUNT(*) AS n FROM collections WHERE owner=?').bind(user).first();if(Number(count?.n)>=100)throw new ApiError('You can save up to 100 collections.');
  const id=crypto.randomUUID();await db.prepare('INSERT INTO collections (id,owner,name,created_at) VALUES (?,?,?,?)').bind(id,user,name(data.name),new Date().toISOString()).run();return json({ok:true,id});
 }
 if(data.action==='renameCollection'){await collection(data.id);await db.prepare('UPDATE collections SET name=? WHERE id=? AND owner=?').bind(name(data.name),data.id,user).run();return json({ok:true});}
 if(data.action==='deleteCollection'){await collection(data.id);await db.batch([db.prepare('DELETE FROM memberships WHERE collection_id=? AND owner=?').bind(data.id,user),db.prepare('DELETE FROM collections WHERE id=? AND owner=?').bind(data.id,user),db.prepare('DELETE FROM pages WHERE owner=? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.page_id=pages.id AND m.owner=?)').bind(user,user)]);return json({ok:true});}
 if(data.action==='duplicateCollection'){
  const original=await collection(data.id);const count=await db.prepare('SELECT COUNT(*) AS n FROM collections WHERE owner=?').bind(user).first();if(Number(count?.n)>=100)throw new ApiError('You can save up to 100 collections.');
  const id=crypto.randomUUID();await db.batch([db.prepare('INSERT INTO collections (id,owner,name,created_at) VALUES (?,?,?,?)').bind(id,user,name(data.name||`${original.name} copy`.slice(0,100)),new Date().toISOString()),db.prepare('INSERT INTO memberships (collection_id,page_id,owner) SELECT ?,page_id,owner FROM memberships WHERE collection_id=? AND owner=?').bind(id,data.id,user)]);return json({ok:true,id});
 }
 if(data.action==='removePage'){await collection(data.collectionId);const pageId=identifier(data.pageId);await db.batch([db.prepare('DELETE FROM memberships WHERE collection_id=? AND page_id=? AND owner=?').bind(data.collectionId,pageId,user),db.prepare('DELETE FROM pages WHERE id=? AND owner=? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.page_id=pages.id AND m.owner=?)').bind(pageId,user,user)]);return json({ok:true});}
 if(data.action==='addPages'){
  await collection(data.collectionId);if(!Array.isArray(data.inputs)||!data.inputs.length||data.inputs.length>100)throw new ApiError('Add between 1 and 100 pages at a time.');
  const platform:Platform=['instagram','tiktok','youtube'].includes(data.platform)?data.platform:'instagram';
  const errors:string[]=[];let added=0;const seen=new Set<string>();
  for(const input of data.inputs){try{
   if(typeof input!=='string'||input.length>300)throw new ApiError('Invalid page input.');
   let page:ReturnType<typeof parsePage>;try{page=parsePage(input,platform);}catch(error){throw new ApiError(error instanceof Error?error.message:'Invalid page input.');}
   const key=`${page.platform}:${page.handle}`;if(seen.has(key))continue;seen.add(key);
   added+=await db.transaction(async tx=>{
    let saved=await tx.prepare('SELECT id FROM pages WHERE owner=? AND platform=? AND handle=?').bind(user,page.platform,page.handle).first();
    if(!saved){const count=await tx.prepare('SELECT COUNT(*) AS n FROM pages WHERE owner=?').bind(user).first();if(Number(count?.n)>=500)throw new ApiError('This workspace can track up to 500 unique pages.');const id=crypto.randomUUID();await tx.prepare('INSERT INTO pages (id,owner,platform,handle,url,name) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(id,user,page.platform,page.handle,page.url,`@${page.handle}`).run();saved=await tx.prepare('SELECT id FROM pages WHERE owner=? AND platform=? AND handle=?').bind(user,page.platform,page.handle).first();}
    if(!saved)throw new ApiError('This page changed while it was being added. Please retry.',409);
    const result=await tx.prepare('INSERT INTO memberships (collection_id,page_id,owner) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(data.collectionId,saved.id,user).run();return result.meta.changes;
   });
  }catch(e){errors.push(`${String(input).slice(0,100)}: ${e instanceof ApiError?e.message:'Could not add this page. Please reload and retry.'}`);}}
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
  await db.prepare('UPDATE settings SET provider=?,api_key=?,youtube_key=?,post_limit=?,request_limit=? WHERE owner=?').bind(data.provider,apiKey,ytKey,limit,cap,user).run();return json({ok:true});
 }
 throw new ApiError('Unknown action.');
 }catch(e){return fail(e);}}
