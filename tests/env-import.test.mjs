import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { validateEnvironment, validateSupabaseBackend, validatePublicSecrets } from '../scripts/verify-env.mjs';
import { validateLegacyExport, importRows } from '../scripts/import-legacy.mjs';

const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const collection = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', page = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nextCollection = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nextPage = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const jwt = role => `e30.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.test-signature`;
const environment = () => ({ NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example', SUPABASE_SECRET_KEY: 'sb_secret_example', APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), NEXT_PUBLIC_APP_URL: 'https://desk.example.com', NEXT_PUBLIC_ENABLE_GOOGLE_AUTH: 'false' });
function legacy() {
  return { owner: 'old-owner', collections: [{ id: collection, name: 'Original', createdAt: '2026-10-24T00:00:00Z' }], pages: [{ id: page, platform: 'instagram', handle: 'example', url: 'https://www.instagram.com/example/', name: 'Example', followers: 0, posts: [{ id: 'post', views: 0, likes: null }], coverage: {}, overall: { views: 0, posts: 1 }, locked_until: 999 }], memberships: [{ collectionId: collection, pageId: page }] };
}
const validated = () => validateLegacyExport(legacy(), { 'old-owner': owner });

test('SDK environment accepts server secrets and legacy service-role fallback without SQL credentials', () => {
  assert.deepEqual(validateEnvironment(environment(), { production: true }).errors, []);
  const env = environment(); delete env.SUPABASE_SECRET_KEY; env.SUPABASE_SERVICE_ROLE_KEY = jwt('service_role');
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = jwt('anon');
  assert.deepEqual(validateEnvironment(env, { production: true }).errors, []);
  for (const key of ['sb_publishable_example', jwt('anon'), 'sb_secret_', 'malformed']) {
    assert.match(validateSupabaseBackend({ ...environment(), SUPABASE_SECRET_KEY: key }).errors.join(' '), /service_role|backend/);
  }
  assert.match(validateEnvironment({ ...environment(), SUPABASE_SECRET_KEY: '' }).errors.join(' '), /SUPABASE_SECRET_KEY/);
  assert.match(validateEnvironment({ ...environment(), APP_ENCRYPTION_KEY: 'invalid' }).errors.join(' '), /32 random bytes/);
  assert.match(validateEnvironment({ ...environment(), NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }, { production: true }).errors.join(' '), /HTTPS/);
});

test('public guard checks every public variable and never prints secret values', () => {
  const secret = 'sb_secret_do_not_print_this_value';
  for (const value of [secret, jwt('service_role')]) {
    const env = { ...environment(), NEXT_PUBLIC_SUPABASE_ANON_KEY: value };
    assert.equal(validatePublicSecrets(env).length, 1);
    const result = spawnSync(process.execPath, ['scripts/guard-public-env.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal((result.stderr + result.stdout).includes(value), false);
  }
});

test('legacy validation preserves mappings, zero metrics and reset leases while rejecting malformed exports', () => {
  const data = validated();
  assert.equal(data.pages[0].owner, owner); assert.equal(data.pages[0].followers, 0);
  assert.equal(data.pages[0].posts[0].pageId, page); assert.equal(data.pages[0].locked_until, 0);
  assert.throws(() => validateLegacyExport(legacy(), {}), /owner map/);
  for (const change of [row => { row.pages[0].followers = -1; }, row => { row.pages[0].posts[0].views = '1'; }, row => { row.pages[0].url = 'https://evil.example/'; }, row => { row.memberships[0].pageId = nextPage; }, row => { row.pages.push(row.pages[0]); }]) {
    const value = legacy(); change(value); assert.throws(() => validateLegacyExport(value, { 'old-owner': owner }));
  }
});

test('SDK importer calls only its named atomic RPC and redacts remote errors', async () => {
  const calls = [], data = validated();
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: { collectionsToAdd: 1 }, error: null }; } };
  assert.deepEqual(await importRows(client, data), { collectionsToAdd: 1 });
  assert.equal(calls[0].name, 'desk_import_legacy'); assert.equal(calls[0].args.p_apply, false);
  await importRows(client, data, true); assert.equal(calls[1].args.p_apply, true);
  await assert.rejects(importRows({ rpc: async () => ({ error: { code: '23505', message: 'secret-private-value' } }) }, data), error => error.message.includes('23505') && !error.message.includes('secret-private-value'));
});

test('legacy SDK RPC enforces transactions, owner isolation, limits and service-role-only access', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    await db.exec(await readFile(new URL('../supabase/migrations/20261024000000_init.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261024020000_sdk_legacy_import.sql', import.meta.url), 'utf8'));
    await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)', [owner, 'owner@example.test', other, 'other@example.test']);
    const rpc = async (data = validated(), apply = false) => {
      await db.exec('set role service_role');
      try { return (await db.query('select public.desk_import_legacy($1::jsonb,$2::boolean) as summary', [JSON.stringify(data), apply])).rows[0].summary; }
      finally { await db.exec('reset role'); }
    };
    await t.test('dry run writes nothing, apply preserves snapshots, repeats never overwrite', async () => {
      const result = await rpc(); assert.equal(result.collectionsToAdd, 1); assert.equal(result.pagesToAdd, 1);
      assert.equal((await db.query('select count(*) from public.collections')).rows[0].count, 0);
      await rpc(validated(), true);
      const saved = (await db.query('select followers,posts,locked_until from public.pages')).rows[0];
      assert.equal(saved.followers, 0); assert.equal(saved.posts[0].views, 0); assert.equal(saved.locked_until, 0);
      const changed = validated(); changed.collections[0].name = 'Overwrite attempt'; changed.pages[0].followers = 99;
      assert.equal((await rpc(changed, true)).pagesToAdd, 0);
      assert.equal((await db.query('select name from public.collections')).rows[0].name, 'Original');
      assert.equal((await db.query('select followers from public.pages')).rows[0].followers, 0);
    });
    await t.test('foreign IDs, duplicate handles, missing accounts and broken references reject atomically', async () => {
      let data = validated(); data.collections[0].owner = other; data.pages[0].owner = other; data.memberships[0].owner = other;
      await assert.rejects(rpc(data, true), /conflicts/);
      data = validated(); data.collections[0].id = nextCollection; data.memberships[0].collection_id = nextCollection; data.pages[0].id = nextPage; data.memberships[0].page_id = nextPage; data.pages[0].posts[0].pageId = nextPage;
      await assert.rejects(rpc(data, true), /conflicts/);
      assert.equal((await db.query('select count(*) from public.collections')).rows[0].count, 1);
      data = validated(); data.memberships[0].owner = other; await assert.rejects(rpc(data, true), /memberships/);
      data = validated(); data.pages[0].posts[0].views = -1; await assert.rejects(rpc(data, true), /counters/);
      data = { collections: [{ ...validated().collections[0], id: nextCollection, owner: '33333333-3333-4333-8333-333333333333' }], pages: [], memberships: [] };
      await assert.rejects(rpc(data, true), /users must already exist/);
    });
    await t.test('workspace limits include existing records', async () => {
      await db.query(`insert into public.collections(id,owner,name) select ('90000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,$1,'Existing' from generate_series(1,99) as i`, [owner]);
      const data = { collections: [{ ...validated().collections[0], id: nextCollection }], pages: [], memberships: [] };
      await assert.rejects(rpc(data, true), /limits/);
      await db.query('delete from public.collections where id <> $1', [collection]);
      await db.query(`insert into public.pages(id,owner,platform,handle,name,url) select ('90000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,$1,'instagram','existing' || i,'Existing','https://instagram.com/existing' || i from generate_series(1,499) as i`, [owner]);
      const pageData = validated(); pageData.pages[0].id = nextPage; pageData.pages[0].handle = 'next'; pageData.pages[0].posts[0].pageId = nextPage; pageData.memberships[0].page_id = nextPage;
      await assert.rejects(rpc(pageData, true), /limits/);
      await db.query('delete from public.pages where id <> $1', [page]);
    });
    await t.test('failure after collection/page inserts rolls back every new row', async () => {
      await db.exec(`create function private.reject_import_membership() returns trigger language plpgsql as $$begin raise exception 'Deliberate membership failure'; end$$;
        create trigger reject_import before insert on public.memberships for each row execute function private.reject_import_membership();`);
      const data = validated(); data.collections[0].id = nextCollection; data.pages[0].id = nextPage; data.pages[0].handle = 'newpage'; data.pages[0].posts[0].pageId = nextPage; data.memberships[0].collection_id = nextCollection; data.memberships[0].page_id = nextPage;
      await assert.rejects(rpc(data, true), /Deliberate membership failure/);
      assert.equal((await db.query('select count(*) from public.collections where id=$1', [nextCollection])).rows[0].count, 0);
      assert.equal((await db.query('select count(*) from public.pages where id=$1', [nextPage])).rows[0].count, 0);
      await db.exec('drop trigger reject_import on public.memberships; drop function private.reject_import_membership()');
    });
    await t.test('browser roles cannot execute and RPC uses caller privileges with empty search path', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        try { await assert.rejects(db.query('select public.desk_import_legacy($1::jsonb)', [JSON.stringify(validated())]), /permission denied/); }
        finally { await db.exec('reset role'); }
      }
      const fn = (await db.query("select prosecdef,proconfig from pg_proc where oid='public.desk_import_legacy(jsonb,boolean)'::regprocedure")).rows[0];
      assert.equal(fn.prosecdef, false); assert.equal(fn.proconfig.some(value => value.startsWith('search_path=')), true);
    });
  } finally { await db.close(); }
});
