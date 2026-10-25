import 'server-only';
import { getCurrentUser } from '@/lib/auth';
import { database as connectDatabase } from '@/lib/database';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import { postDates, scopeKey, storedScope } from '@/lib/scope';

export class ApiError extends Error {constructor(message:string,public status=400){super(message);}}
export function database(){
  try{return connectDatabase();}
  catch(error){throw new ApiError(error instanceof Error?error.message:'Database configuration is unavailable.',503);}
}
type DataResult<T>={data:T|null;error:{code?:string;message:string}|null};
/** Unwrap SDK responses while preserving safe database error codes. */
export async function query<T>(operation:PromiseLike<DataResult<T>>):Promise<T>{
  const result=await operation;
  if(result.error){
    const known=result.error.message.match(/^DD(400|403|404|409):\s*(.{1,350})$/);
    if(known)throw new ApiError(known[2],Number(known[1]));
    if(['PGRST202','PGRST205','42883','42P01'].includes(result.error.code||''))throw new ApiError('Database setup is incomplete. Apply all Supabase migrations for this release, then retry.',503);
    throw result.error;
  }
  return result.data as T;
}
/** PostgREST caps ordinary selects at 1,000 rows; page through full memberships. */
export async function queryRows<T>(page:(from:number,to:number)=>PromiseLike<DataResult<T[]>>):Promise<T[]>{
  const rows:T[]=[];
  for(let from=0;from<50000;from+=1000){
    const batch=await query(page(from,from+999));rows.push(...(batch||[]));
    if(!batch||batch.length<1000)return rows;
  }
  return rows;
}
export type Account={id:string;email:string|null;name:string|null;userType:'admin'|'user';createdAt:string;lastSeenAt:string};
export async function currentAccount():Promise<Account>{
  const user=await getCurrentUser();if(!user)throw new ApiError('Sign in to open your workspace.',401);
  const now=new Date().toISOString(),db=database();
  const email=user.email.trim().toLowerCase(),name=(user.fullName?.trim()||(user.displayName!==user.email?user.displayName.trim():null))?.slice(0,200);
  // Auth's default-user trigger normally creates this row. This repair path never changes roles.
  const existing=await query(db.from('users').select('id,name').eq('id',user.userId).maybeSingle<Record<string,unknown>>());
  // Never include user_type in a user-derived payload; the database default is user.
  await query(db.from('users').upsert({id:user.userId,email,name:name||existing?.name||null,last_seen_at:now}, {onConflict:'id'}));
  const row=await query(db.from('users').select('id,email,name,user_type,created_at,last_seen_at').eq('id',user.userId).maybeSingle<Record<string,unknown>>());
  if(!row)throw new ApiError('Your account could not be opened. Please retry.',503);
  return {id:String(row.id),email:typeof row.email==='string'?row.email:null,name:typeof row.name==='string'?row.name:null,
    userType:row.user_type==='admin'?'admin':'user',createdAt:String(row.created_at),lastSeenAt:String(row.last_seen_at)};
}
export async function owner(){return (await currentAccount()).id;}
export async function requireAdmin(){const user=await currentAccount();if(user.userType!=='admin')throw new ApiError('Administrator access is required.',403);return user;}
export function guard(request:Request){
  const origin=request.headers.get('origin');
  if((origin&&origin!==new URL(request.url).origin)||request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError('This request must come from your workspace.',403);
}
export async function body(request:Request,maxBytes=40000):Promise<Record<string,any>>{
  const length=Number(request.headers.get('content-length')||0);if(length>maxBytes)throw new ApiError('This request is too large.',413);
  // Bound the stream as well as Content-Length, which may be absent or forged.
  if(!request.body)throw new ApiError('Invalid request.');
  const reader=request.body.getReader();const parts:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new ApiError('This request is too large.',413);}parts.push(value);}}
  finally{reader.releaseLock();}
  const raw=new TextDecoder().decode(Buffer.concat(parts));
  try{const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,any>;}
  catch{throw new ApiError('Invalid request.');}
}
export function json(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
export function fail(error:unknown){
  if(error instanceof ApiError)return json({error:error.message},error.status);
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  if(code==='23505')return json({error:'This item already exists. Reload your workspace and retry.'},409);
  if(['22P02','22023','22003','22007','22008','22P05','23514','23503'].includes(code))return json({error:'That change contains invalid or unavailable data.'},400);
  // Do not return SQL, connection strings, provider keys, or database error details.
  return json({error:'Something went wrong. Your saved data is safe; please retry.'},500);
}
export async function encrypt(value:string){try{return encryptSecret(value);}catch(error){throw new ApiError(error instanceof Error?error.message:'Secure key storage is unavailable.',503);}}
export async function decrypt(value:unknown){try{return decryptSecret(value);}catch(error){throw new ApiError(error instanceof Error?error.message:'The saved provider key could not be read.',503);}}
export async function preferences(user:string){
  const db=database();await query(db.from('settings').upsert({owner:user},{onConflict:'owner',ignoreDuplicates:true}));
  const row=await query(db.from('settings').select('*').eq('owner',user).maybeSingle<Record<string,unknown>>());
  if(!row)throw new ApiError('Workspace settings are unavailable.',503);return row;
}
function object(value:unknown):Record<string,any>{
  if(typeof value==='string'){try{return object(JSON.parse(value));}catch{return {};}}
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
}
function array(value:unknown):Record<string,any>[] {
  if(typeof value==='string'){try{return array(JSON.parse(value));}catch{return [];}}
  return Array.isArray(value)?value.filter(item=>!!item&&typeof item==='object'&&!Array.isArray(item)):[];
}
export function pageRecord(row:Record<string,unknown>){
  const posts=array(row.posts),coverage=object(row.coverage);
  if(row.last_synced_at){const dates=postDates(posts as {publishedAt:string|null}[]);coverage.oldest??=dates.oldest;coverage.newest??=dates.newest;coverage.unknownDates??=dates.unknownDates;coverage.scopeKey||=scopeKey(storedScope(coverage));coverage.complete??=(!coverage.hasMore||posts.length>=Number(coverage.limit||30));}
  return {id:row.id,platform:row.platform,handle:row.handle,url:row.url,name:row.name,followers:row.followers,posts,lastSyncedAt:row.last_synced_at??null,syncError:row.sync_error??null,coverage,provider:row.provider,overall:row.overall?object(row.overall):null};
}
