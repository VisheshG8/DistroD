import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { Script } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { testSupabase } from './helpers/supabase-fixture.mjs';
import { normalizeColumns, normalizeOverrides } from '../lib/display.ts';
import { normalizeScope } from '../lib/scope.ts';

const CHUNK = 524288;
function loadTs(file, names, context) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import[^;]*;\r?\n/gm, '');
  return new Script(stripTypeScriptTypes(source, { mode: 'transform' }).replace(/\bexport\s+/g, '') + '\n;({' + names.join(',') + '})').runInNewContext(context);
}

test('portable workspace transfers through the Supabase SDK and actual PostgreSQL migrations', async t => {
  const pg = new PGlite();
  try {
    await pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    for (const file of ['20261024000000_init.sql', '20261024010000_sdk_operations.sql', '20261024015000_sdk_admin.sql', '20261024020000_sdk_legacy_import.sql', '20261025000000_workspace_transfer.sql']) {
      await pg.exec(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
    const { client } = testSupabase(pg);
    const call = async (owner, action, job = null, data = {}) => {
      const result = await client.rpc('desk_workspace_transfer', { p_owner: owner, p_action: action, p_job: job, p_data: data });
      if (result.error) throw Object.assign(new Error(result.error.message), result.error);
      return result.data;
    };
    const user = async () => { const id = randomUUID(); await pg.query('insert into auth.users(id,email) values($1,$2)', [id, id + '@example.test']); return id; };
    const source = await user(), destination = await user(), stranger = await user();
    const collection = randomUUID(), secondCollection = randomUUID(), page = randomUUID();
    const posts = [{ id: 'one', pageId: page, title: 'A real snapshot', url: 'https://www.youtube.com/watch?v=one', publishedAt: '2026-10-24T12:00:00Z', views: 0, likes: 25, comments: null, shares: null, saves: null }];
    await pg.query(`insert into public.collections(id,owner,name,created_at) values($1,$2,'Creator · all pages','2026-10-01T00:00:00Z'),($3,$2,'Fan pages','2026-10-02T00:00:00Z')`, [collection, source, secondCollection]);
    await pg.query(`insert into public.pages(id,owner,platform,handle,url,name,followers,posts,coverage,overall,last_synced_at,provider,canonical_id)
      values($1,$2,'youtube','example','https://www.youtube.com/@example','Example',123,$3,$4,$5,'2026-10-24T13:00:00Z','youtube-official','native-example')`, [page, source, JSON.stringify(posts), JSON.stringify({ complete: true, limit: 30, fetched: 1, hasMore: false }), JSON.stringify({ views: 10000, posts: 1, followers: 123 })]);
    await pg.query('insert into public.memberships values($1,$2,$3),($4,$2,$3)', [collection, page, source, secondCollection]);
    await pg.query(`insert into public.settings(owner,provider,api_key,youtube_key,post_limit,request_limit) values($1,'scrapecreators','SECRET-SOCIAL','SECRET-YOUTUBE',100,900)`, [source]);
    let archive;
    const upload = async (owner, value, { missingLast = false } = {}) => {
      const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const start = await call(owner, 'begin_import', null, { bytes: bytes.length });
      for (let index = 0; index < start.total - (missingLast ? 1 : 0); index++) await call(owner, 'upload', start.job, { index, chunk: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString('base64') });
      return start.job;
    };

    await t.test('export is a consistent full snapshot without credentials, roles, owners or usage', async () => {
      const start = await call(source, 'begin_export'), chunks = [];
      for (let index = 0; index < start.total; index++) chunks.push(Buffer.from((await call(source, 'read_export', start.job, { index })).chunk, 'base64'));
      archive = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(archive.format, 'distribution-desk.workspace'); assert.equal(archive.workspace.collections.length, 2);
      assert.equal(archive.workspace.pages.length, 1); assert.equal(archive.workspace.memberships.length, 2);
      assert.deepEqual(archive.workspace.pages[0].posts, posts); assert.equal(archive.workspace.pages[0].followers, 123);
      const raw = JSON.stringify(archive); for (const secret of ['SECRET-SOCIAL', 'SECRET-YOUTUBE', 'locked_until', 'user_type', '"owner"', 'requestsUsed']) assert.ok(!raw.includes(secret), secret);
      archive.preferences = { columns: { views: true }, overrides: { [JSON.stringify([page, 'profile', 'followers'])]: 999 }, scopes: { [collection]: { mode: 'posts', postLimit: 100, from: null, to: null } } };
      await call(source, 'cancel', start.job);
    });
    await t.test('preview writes no workspace data; cross-account apply remaps all records and post references', async () => {
      const job = await upload(destination, archive);
      const preview = await call(destination, 'preview', job);
      assert.equal(preview.summary.collectionsToAdd, 2); assert.equal(preview.summary.pagesToAdd, 1); assert.equal(preview.summary.posts, 1);
      assert.equal(Number((await pg.query('select count(*) as n from public.pages where owner=$1', [destination])).rows[0].n), 0);
      await assert.rejects(call(stranger, 'preview', job), /unavailable/);
      const result = await call(destination, 'apply', job, { restoreSettings: true });
      const targetPage = result.pageMap[0].target; assert.notEqual(targetPage, page);
      const row = (await pg.query('select * from public.pages where id=$1 and owner=$2', [targetPage, destination])).rows[0];
      assert.deepEqual(row.posts, [{ ...posts[0], pageId: targetPage }]); assert.equal(Number(row.followers), 123);
      assert.equal(row.transfer_id, archive.workspace.pages[0].transfer_id); assert.equal(row.canonical_id, 'native-example');
      assert.equal(Number((await pg.query('select count(*) as n from public.memberships where owner=$1 and page_id=$2', [destination, targetPage])).rows[0].n), 2);
      const settings = (await pg.query('select * from public.settings where owner=$1', [destination])).rows[0];
      assert.equal(settings.provider, 'scrapecreators'); assert.equal(settings.api_key, null); assert.equal(settings.request_limit, 900);
      assert.deepEqual(await call(destination, 'apply', job), result, 'retry after a lost response is idempotent');
    });
    await t.test('reimporting deduplicates; keep and overwrite modes preserve their promised data', async () => {
      const edited = structuredClone(archive); edited.workspace.pages[0].followers = 888; edited.workspace.collections[0].name = 'Renamed from backup';
      const job = await upload(destination, edited), preview = await call(destination, 'preview', job);
      assert.equal(preview.summary.collectionsToAdd, 0); assert.equal(preview.summary.pagesToAdd, 0); assert.equal(preview.summary.existingPages, 1);
      await call(destination, 'apply', job);
      assert.equal(Number((await pg.query('select followers from public.pages where owner=$1', [destination])).rows[0].followers), 123);
      const again = await upload(destination, edited); await call(destination, 'preview', again); await call(destination, 'apply', again, { overwrite: true });
      assert.equal(Number((await pg.query('select followers from public.pages where owner=$1', [destination])).rows[0].followers), 888);
      assert.equal(Number((await pg.query('select count(*) as n from public.collections where owner=$1', [destination])).rows[0].n), 2);
    });
    await t.test('large Unicode backups use multiple bounded chunks and preserve their complete content', async () => {
      const owner = await user(), large = structuredClone(archive);
      large.workspace.pages[0].posts = Array.from({ length: 800 }, (_, index) => ({ ...posts[0], id: String(index), title: 'संग्रह 🎬 '.repeat(70) }));
      const job = await upload(owner, large), preview = await call(owner, 'preview', job); assert.equal(preview.summary.posts, 800);
      await call(owner, 'apply', job);
      const row = (await pg.query('select posts from public.pages where owner=$1', [owner])).rows[0]; assert.equal(row.posts.length, 800); assert.equal(row.posts[799].title, large.workspace.pages[0].posts[799].title);
    });
    await t.test('malformed and incomplete backups fail without partial writes or foreign ownership changes', async () => {
      const owner = await user();
      for (const invalid of [{ ...archive, version: 99 }, { ...archive, workspace: { ...archive.workspace, memberships: [{ collection_id: randomUUID(), page_id: page }] } }, { ...archive, workspace: { ...archive.workspace, pages: [{ ...archive.workspace.pages[0], followers: -1 }] } }]) {
        const job = await upload(owner, invalid); await assert.rejects(call(owner, 'preview', job)); await call(owner, 'cancel', job);
      }
      const incomplete = await upload(owner, archive, { missingLast: true }); await assert.rejects(call(owner, 'preview', incomplete), /incomplete/); await call(owner, 'cancel', incomplete);
      assert.equal(Number((await pg.query('select count(*) as n from public.pages where owner=$1', [owner])).rows[0].n), 0);
      assert.equal(Number((await pg.query('select followers from public.pages where owner=$1', [source])).rows[0].followers), 123);
    });
    await t.test('apply rechecks page refresh locks and quota history is never reset by a restore', async () => {
      await pg.query(`insert into public.usage(owner,month,requests) values($1,'2026-10',55)`, [destination]);
      const job = await upload(destination, archive); await call(destination, 'preview', job);
      await pg.query('update public.pages set locked_until=$1 where owner=$2', [Date.now() + 300000, destination]);
      await assert.rejects(call(destination, 'apply', job, { overwrite: true }), /active page refreshes/);
      await pg.query('update public.pages set locked_until=0 where owner=$1', [destination]);
      await call(destination, 'apply', job, { overwrite: true, restoreSettings: true });
      assert.equal(Number((await pg.query('select requests from public.usage where owner=$1', [destination])).rows[0].requests), 55);
    });
    await t.test('native platform IDs merge aliases into existing pages without duplicating their snapshots', async () => {
      const owner = await user(), ownCollection = randomUUID(), ownPage = randomUUID();
      await pg.query(`insert into public.collections(id,owner,name) values($1,$2,'Existing group')`, [ownCollection, owner]);
      await pg.query(`insert into public.pages(id,owner,platform,handle,url,name,canonical_id,followers) values($1,$2,'youtube','UC-native-channel','https://www.youtube.com/channel/UC-native-channel','Existing','native-example',77)`, [ownPage, owner]);
      await pg.query('insert into public.memberships values($1,$2,$3)', [ownCollection, ownPage, owner]);
      const job = await upload(owner, archive), preview = await call(owner, 'preview', job);
      assert.equal(preview.summary.pagesToAdd, 0); await call(owner, 'apply', job);
      const row = (await pg.query('select handle,followers from public.pages where owner=$1', [owner])).rows[0];
      assert.equal(row.handle, 'UC-native-channel'); assert.equal(Number(row.followers), 77);
      assert.equal(Number((await pg.query('select count(*) as n from public.memberships where owner=$1', [owner])).rows[0].n), 3);
    });
    await t.test('a workspace change after preview is revalidated and a failed commit rolls back every imported row', async () => {
      const owner = await user(), job = await upload(owner, archive); await call(owner, 'preview', job);
      await pg.query(`insert into public.collections(owner,name) select $1,'Group ' || n from generate_series(1,100) n`, [owner]);
      await assert.rejects(call(owner, 'apply', job));
      assert.equal(Number((await pg.query('select count(*) as n from public.pages where owner=$1', [owner])).rows[0].n), 0);
      assert.equal(Number((await pg.query('select count(*) as n from public.collections where owner=$1', [owner])).rows[0].n), 100);
    });
    await t.test('browser roles cannot access staging or invoke transfer RPCs', async () => {
      const staging = await pg.query(`select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='private' and c.relname in ('workspace_transfers','workspace_transfer_chunks')`);
      assert.equal(staging.rows.length, 2); assert.ok(staging.rows.every(row => row.relrowsecurity));
      for (const role of ['anon', 'authenticated']) {
        await assert.rejects(pg.transaction(async tx => { await tx.exec('set local role ' + role); await tx.query('select public.desk_workspace_transfer($1,$2)', [source, 'begin_export']); }), /permission denied/);
        await assert.rejects(pg.transaction(async tx => { await tx.exec('set local role ' + role); await tx.query('select * from private.workspace_transfers'); }), /permission denied/);
      }
    });
  } finally { await pg.close(); }
});

test('backup preferences remap manual metrics and saved scopes while respecting keep/overwrite modes', () => {
  const { collectWorkspacePreferences, restoreWorkspacePreferences, bytesToBase64, base64ToBytes } = loadTs('../lib/workspace-transfer.ts', ['collectWorkspacePreferences', 'restoreWorkspacePreferences', 'bytesToBase64', 'base64ToBytes'], {
    normalizeColumns, normalizeOverrides, normalizeScope, JSON, Map, Object, String, Uint8Array, btoa, atob, Number,
  });
  const values = new Map(), storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), key: index => [...values.keys()][index] || null, get length() { return values.size; } };
  const from = 'source', to = 'target', p1 = randomUUID(), p2 = randomUUID(), c1 = randomUUID(), c2 = randomUUID();
  const key1 = JSON.stringify([p1, 'profile', 'followers']), key2 = JSON.stringify([p2, 'profile', 'followers']);
  storage.setItem(`distribution-desk:presentation:v1:${from}`, JSON.stringify({ columns: { likes: false }, overrides: { [key1]: 456 } }));
  storage.setItem(`distribution-desk:scope:${from}:${c1}`, JSON.stringify({ mode: 'posts', postLimit: 72, from: null, to: null }));
  const preferences = collectWorkspacePreferences(storage, from), result = { preferences, pageMap: [{ source: p1, target: p2 }], collectionMap: [{ source: c1, target: c2 }] };
  restoreWorkspacePreferences(storage, to, result, false);
  let target = JSON.parse(storage.getItem(`distribution-desk:presentation:v1:${to}`));
  assert.equal(target.columns.likes, false); assert.equal(target.overrides[key2], 456); assert.equal(target.overrides[key1], undefined);
  assert.equal(JSON.parse(storage.getItem(`distribution-desk:scope:${to}:${c2}`)).postLimit, 72);
  target.overrides[key2] = 999; storage.setItem(`distribution-desk:presentation:v1:${to}`, JSON.stringify(target));
  restoreWorkspacePreferences(storage, to, result, false); assert.equal(JSON.parse(storage.getItem(`distribution-desk:presentation:v1:${to}`)).overrides[key2], 999);
  restoreWorkspacePreferences(storage, to, result, true); assert.equal(JSON.parse(storage.getItem(`distribution-desk:presentation:v1:${to}`)).overrides[key2], 456);
  const bytes = new TextEncoder().encode('हिन्दी 🎬 portable accounts'); assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test('transfer route enforces authentication, same-origin requests and bounded uploads', async () => {
  class ApiError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const state = { signedIn: true, called: false };
  const route = loadTs('../app/api/transfer/route.ts', ['POST'], {
    ApiError, Number, JSON,
    guard: request => { if (request.headers.get('origin') === 'https://evil.test') throw new ApiError('Wrong origin', 403); },
    owner: async () => { if (!state.signedIn) throw new ApiError('Sign in', 401); return 'verified-owner'; },
    body: async (request, max) => { assert.equal(max, 750000); return request.json(); },
    database: () => ({ rpc: (_name, args) => { state.called = args; return { data: { ok: true } }; } }),
    query: async value => value.data, json: value => Response.json(value), fail: error => Response.json({ error: error.message }, { status: error.status || 500 }),
  });
  const request = (body, origin) => new Request('https://app.test/api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await route.POST(request({ action: 'begin_export', owner: 'attacker-selected-owner' }))).status, 200);
  assert.equal(state.called.p_owner, 'verified-owner');
  assert.equal((await route.POST(request({ action: 'begin_export' }, 'https://evil.test'))).status, 403);
  state.signedIn = false; assert.equal((await route.POST(request({ action: 'begin_export' }))).status, 401); state.signedIn = true;
  assert.equal((await route.POST(request({ action: 'begin_import', bytes: 104857601 }))).status, 400);
  assert.equal((await route.POST(request({ action: 'upload', job: randomUUID(), index: 0, chunk: '*invalid*' }))).status, 400);
});

test('the real request reader bounds transfer streams even when Content-Length is missing or forged', async () => {
  const { body } = loadTs('../lib/server.ts', ['body'], { Buffer, TextDecoder, Uint8Array, Number, JSON, Error });
  const value = JSON.stringify({ chunk: 'a'.repeat(699052) });
  const request = (payload, headers = {}) => new Request('https://app.test/api/transfer', { method: 'POST', headers, body: payload });
  assert.equal((await body(request(value), 750000)).chunk.length, 699052);
  await assert.rejects(body(request(value)), error => error.status === 413);
  await assert.rejects(body(request(JSON.stringify({ chunk: 'a'.repeat(750001) }), { 'Content-Length': '1' }), 750000), error => error.status === 413);
});
