import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Supabase migration enforces tenant isolation, default roles, browser grants and cross-owner constraints',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create schema auth;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;`);
    await db.exec(await readFile(new URL('../supabase/migrations/20261024000000_init.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/tests/rls.sql',import.meta.url),'utf8'));
  } finally {await db.close();}
});
