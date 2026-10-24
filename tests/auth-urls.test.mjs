import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNextPath, configuredAppOrigin, authCallbackUrl} from '../lib/auth-urls.ts';
import {publicSupabaseConfig} from '../lib/supabase/config.ts';

test('auth return paths reject external, encoded, control-character and auth-loop destinations',()=>{
  for(const value of ['https://evil.example/','//evil.example/','/\\evil.example','/%5cevil.example','/%2f%2fevil.example','/dashboard\n','/dashboard%0a','/auth/callback','/../auth/confirm','/%61uth/callback','/%6cogin','/login','javascript:alert(1)',null,{}])assert.equal(safeNextPath(value),'/dashboard',String(value));
  assert.equal(safeNextPath('/admin?section=pages'),'/admin?section=pages');
  assert.equal(safeNextPath('/reset-password'),'/reset-password');
  assert.equal(safeNextPath('/dashboard#collections'),'/dashboard#collections');
  assert.equal(safeNextPath('/'),'/');
});

test('auth callbacks use a configured origin and sanitize their next parameter',()=>{
  const target=new URL(authCallbackUrl('https://desk.example.com','//evil.example'));
  assert.equal(target.origin,'https://desk.example.com');
  assert.equal(target.pathname,'/auth/callback');
  assert.equal(target.searchParams.get('next'),'/dashboard');
});

test('production redirects require a safe configured origin and never derive a forwarded host',()=>{
  const previous={app:process.env.NEXT_PUBLIC_APP_URL,node:process.env.NODE_ENV};
  try{
    process.env.NODE_ENV='production';delete process.env.NEXT_PUBLIC_APP_URL;assert.throws(()=>configuredAppOrigin(),/NEXT_PUBLIC_APP_URL/);
    for(const value of ['https://user:password@desk.example.com','javascript:alert(1)','https://desk.example.com/path','https://desk.example.com?evil=true','http://desk.example.com']){process.env.NEXT_PUBLIC_APP_URL=value;assert.throws(()=>configuredAppOrigin());}
    process.env.NEXT_PUBLIC_APP_URL='https://desk.example.com/';assert.equal(configuredAppOrigin(),'https://desk.example.com');
    process.env.NEXT_PUBLIC_APP_URL='http://localhost:3000';assert.equal(configuredAppOrigin(),'http://localhost:3000');
  }finally{for(const [key,value] of [['NEXT_PUBLIC_APP_URL',previous.app],['NODE_ENV',previous.node]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('public auth configuration fails safely when missing or invalid and supports the anon-key fallback',()=>{
  const keys=['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','NEXT_PUBLIC_SUPABASE_ANON_KEY'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    for(const key of keys)delete process.env[key];assert.equal(publicSupabaseConfig(),null);
    process.env.NEXT_PUBLIC_SUPABASE_URL='https://project.supabase.co';assert.equal(publicSupabaseConfig(),null);
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='test-public-key';assert.deepEqual(publicSupabaseConfig(),{url:'https://project.supabase.co',key:'test-public-key'});
    process.env.NEXT_PUBLIC_SUPABASE_URL='http://untrusted.example';assert.equal(publicSupabaseConfig(),null);
    process.env.NEXT_PUBLIC_SUPABASE_URL='https://user:pass@project.supabase.co';assert.equal(publicSupabaseConfig(),null);
  }finally{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});
