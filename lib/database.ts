import 'server-only';
import postgres from 'postgres';
import { Database, normalizeDatabaseValue, type QueryExecutor, type DatabaseRow } from './database-core';

let cached: Database|undefined;
export function database():Database {
  if(cached)return cached;
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('DATABASE_URL is missing. Add your Supabase transaction-pooler connection string to the server environment.');
  const parsed=new URL(url);
  if(!['postgres:','postgresql:'].includes(parsed.protocol))throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  const local=['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname);
  const sql=postgres(url,{prepare:false,max:1,connect_timeout:10,idle_timeout:20,max_lifetime:60*15,ssl:local?false:'require',
    types:{safe_bigint:{to:20,from:[20],serialize:(value:unknown)=>String(value),parse:(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new Error('Database integer exceeds JavaScript precision.');return n;}}},
    onnotice:()=>{},
  });
  const executor=(connection:{unsafe:Function}):QueryExecutor=>async(query,parameters)=>{
    const result=await connection.unsafe(query,parameters);
    return {rows:normalizeDatabaseValue(Array.from(result)) as DatabaseRow[],count:Number(result.count??result.length)};
  };
  cached=new Database(executor(sql),async callback=>sql.begin(async transaction=>callback(new Database(executor(transaction)))) as Promise<ReturnType<typeof callback> extends Promise<infer T>?T:never>);
  return cached;
}
