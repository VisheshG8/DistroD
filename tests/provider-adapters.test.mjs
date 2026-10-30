import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Transpile the unchanged production entry point; Node's strip-types loader cannot resolve TS bundler imports.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();
function load(relative) {
  const file = path.isAbsolute(relative) ? relative : path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const localRequire = spec => spec === 'server-only' ? {} : spec.startsWith('.')
    ? load(path.resolve(path.dirname(file), spec + (path.extname(spec) ? '' : '.ts'))) : require(spec);
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports);
  return module.exports;
}
const { fetchSocialPage, createProviderRequest, getConfiguredKeys, DEFAULT_PROVIDER_ORDER, ProviderError } = load('lib/social-provider.ts');
const { redactProviderResponse } = load('lib/providers/request.ts');
const scope = { mode: 'posts', postLimit: 2, from: null, to: null };
const page = platform => ({ id: 'page-1', platform, handle: 'sample', url: `https://${platform}.com/sample` });
const hikerProfile = { user: { pk: '80117947544', username: 'sample', full_name: 'Sample', follower_count: 0,
  following_count: 4, media_count: 5, profile_pic_url: 'https://images.example.com/avatar.jpg', is_verified: false, is_private: false }, status: 'ok' };
// Redacted public-schema fixtures from vendor documentation/OpenAPI. They are not claimed as live paid calls.
// https://api.hikerapi.com/openapi.json: /g2/user/medias response.items + TOP LEVEL next_page_id.
const hikerMedia = (id, extra = {}) => ({ id: `${id}_80117947544`, code: `CODE${id}`, media_type: 2,
  taken_at: 1790200000, caption: { text: 'Sample caption' }, play_count: 5041, ig_play_count: 2427,
  fb_play_count: 2614, like_count: 0, comment_count: 1, image_versions2: { candidates: [{ url: 'https://images.example.com/post.jpg' }] }, ...extra });
// https://api.lamatok.com/openapi.json: v1 profile and v2 media endpoints; TikTok native web/app field variants.
const lamaProfile = { userInfo: { user: { id: '7470000000000000001', uniqueId: 'sample', nickname: 'Sample', secUid: 'MS4wPUBLICID', verified: true,
  avatarLarger: 'https://images.example.com/tiktok.jpg' }, stats: { followerCount: 0, followingCount: 2, videoCount: 3 } } };
const lamaMedia = (id, extra = {}) => ({ aweme_id: id, desc: 'Sample post', create_time: 1790200000,
  statistics: { play_count: 0, digg_count: 0, comment_count: 0, share_count: 0, collect_count: 0 },
  video: { duration: 12000, cover: { url_list: ['https://images.example.com/cover.jpg'] } }, ...extra });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('HikerAPI uses current g2 cursor, keeps zero, and does not expose Instagram saves or combined Facebook views', async () => {
  const calls = [];
  const result = await fetchSocialPage(page('instagram'), { scope, keys: { hikerapi: 'fixture-secret' }, request: async (provider, raw, headers) => {
    const url = new URL(raw); calls.push(url);
    assert.equal(provider, 'hikerapi'); assert.equal(headers['x-access-key'], 'fixture-secret');
    if (url.pathname === '/v2/user/by/username') { assert.equal(url.searchParams.get('safe_int'), 'true'); return hikerProfile; }
    assert.equal(url.pathname, '/g2/user/medias'); assert.equal(url.searchParams.get('user_id'), '80117947544');
    if (!url.searchParams.has('next_page_id')) return { response: { items: [hikerMedia('3894831928272017840', { save_count: 400 })], more_available: true, next_max_id: 'not-a-provider-cursor' }, next_page_id: 'opaque-token' };
    assert.equal(url.searchParams.get('next_page_id'), 'opaque-token');
    return { response: { items: [hikerMedia('3894831928272017841', { like_count: undefined, ig_play_count: undefined, play_count: undefined })], more_available: false }, next_page_id: null };
  } });
  assert.equal(calls.length, 3); assert.equal(result.profile.followers, 0); assert.equal(result.profile.following, 4);
  assert.equal(result.profile.isVerified, false); assert.equal(result.posts[0].likes, 0);
  assert.equal(result.posts[0].views, 2427); assert.equal(result.posts[0].saves, null); assert.equal(result.posts[0].shares, null);
  assert.equal(result.posts[1].likes, null); assert.equal(result.posts[1].views, null);
  assert.equal(result.posts[0].sourceAssetId, null); assert.equal(result.posts[0].type, 'video'); assert.equal(result.coverage.complete, true);
});

test('LamaTok resolves secUid once then paginates the documented v2 endpoint', async () => {
  const calls = [];
  const result = await fetchSocialPage(page('tiktok'), { scope, keys: { lamatok: 'lama-secret' }, request: async (provider, raw, headers) => {
    const url = new URL(raw); calls.push(url); assert.equal(provider, 'lamatok'); assert.equal(headers['x-access-key'], 'lama-secret');
    if (url.pathname === '/v1/user/by/username') return lamaProfile;
    assert.equal(url.pathname, '/v2/user/medias/by/secUid'); assert.equal(url.searchParams.get('secUid'), 'MS4wPUBLICID');
    assert.equal(url.searchParams.get('count'), '2');
    return url.searchParams.get('max_cursor') === '0'
      ? { data: { aweme_list: [lamaMedia('7470000000000000002')], max_cursor: 1790200000, has_more: 1 } }
      : { data: { aweme_list: [lamaMedia('7470000000000000003', { statistics: { play_count: 42 } })], max_cursor: 0, has_more: 0 } };
  } });
  assert.equal(calls.length, 3); assert.equal(result.canonicalId, '7470000000000000001');
  assert.equal(result.followers, 0); assert.equal(result.posts[0].durationSeconds, 12);
  assert.equal(result.posts[0].shares, 0); assert.equal(result.posts[0].saves, 0);
  assert.equal(result.posts[1].shares, null); assert.equal(result.profile.isVerified, true);
  assert.equal(result.posts[0].type, 'video'); assert.equal(result.posts[0].audioId, null);
});

test('missing profile or unrecognized media shape fails instead of replacing data with an empty success', async () => {
  await assert.rejects(fetchSocialPage(page('instagram'), { scope, keys: { hikerapi: 'key' }, request: async () => ({}) }), /unrecognized profile/);
  await assert.rejects(fetchSocialPage(page('tiktok'), { scope, keys: { lamatok: 'key' }, request: async (_, raw) => raw.includes('/user/by/') ? lamaProfile : { data: { unknown: [] } } }), /unrecognized post/);
});

test('private accounts do not trigger a second vendor', async () => {
  const calls = [];
  await assert.rejects(fetchSocialPage(page('instagram'), { scope, keys: { hikerapi: 'key', tikhub: 'fallback' }, request: async provider => {
    calls.push(provider); return { user: { ...hikerProfile.user, is_private: true } };
  } }), error => error.code === 'PRIVATE');
  assert.deepEqual(calls, ['hikerapi']);
});

test('transient adapter failure tries the next configured keyed provider only once', async () => {
  const calls = [];
  await assert.rejects(fetchSocialPage(page('instagram'), { scope, keys: { hikerapi: 'key', tikhub: 'fallback' },
    providerOrder: ['hikerapi', 'hikerapi', 'lamatok', 'tikhub'], request: async provider => { calls.push(provider); throw new Error('network with secret'); } }), /configured data providers/);
  assert.deepEqual(calls, ['hikerapi', 'tikhub']);
});

test('a configured legacy fallback can satisfy the same standard contract after the primary fails', async () => {
  const calls = [];
  const result = await fetchSocialPage(page('instagram'), { scope, keys: { hikerapi: 'key', tikhub: 'fallback' }, request: async (provider, raw) => {
    calls.push(provider);
    if (provider === 'hikerapi') throw new ProviderError('Temporary error', 'PROVIDER', 503, true);
    return raw.includes('user_info') ? { data: { user: hikerProfile.user } }
      : { data: { items: [hikerMedia('123')], more_available: false } };
  } });
  assert.deepEqual(calls, ['hikerapi', 'tikhub', 'tikhub']);
  assert.equal(result.provider, 'tikhub'); assert.equal(result.profile.followers, 0); assert.equal(result.profile.following, 4);
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].saves, null);
});

test('legacy partial-result handling cannot swallow a request cap and continue to another provider', async () => {
  const calls = [];
  await assert.rejects(fetchSocialPage(page('instagram'), { scope: { ...scope, postLimit: 10 }, providerOrder: ['tikhub', 'scrapecreators'],
    keys: { tikhub: 'key', scrapecreators: 'fallback' }, request: async (provider, raw) => {
      calls.push(provider);
      if (raw.includes('user_info')) return { data: { user: hikerProfile.user } };
      if (calls.length === 2) return { data: { items: [hikerMedia('123')], more_available: true, next_max_id: 'next' } };
      throw new ProviderError('Cap reached', 'BUDGET_LIMIT', 429);
    } }), error => error.code === 'BUDGET_LIMIT');
  assert.deepEqual(calls, ['tikhub', 'tikhub', 'tikhub']);
});

test('date coverage excludes undated posts and reports the uncertainty explicitly', async () => {
  const result = await fetchSocialPage(page('instagram'), { scope: { mode: 'date', postLimit: 30, from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
    keys: { hikerapi: 'key' }, request: async (_, raw) => raw.includes('/user/by/') ? hikerProfile
      : { response: { items: [hikerMedia('123'), hikerMedia('124', { taken_at: undefined })], more_available: false }, next_page_id: null } });
  assert.equal(result.posts.length, 1); assert.equal(result.coverage.unknownDates, 1); assert.equal(result.coverage.complete, false);
});

test('oversized final feeds cannot claim full date coverage after the scan cap', async () => {
  const result = await fetchSocialPage(page('instagram'), { scope: { mode: 'date', postLimit: 30, from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
    keys: { hikerapi: 'key' }, request: async (_, raw) => raw.includes('/user/by/') ? hikerProfile
      : { response: { items: Array.from({ length: 1001 }, (_, i) => hikerMedia(String(i))), more_available: false }, next_page_id: null } });
  assert.equal(result.posts.length, 1000); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.stopReason, 'scan-limit');
});

test('partial useful results stop fallback; repeated cursors are marked incomplete', async () => {
  const calls = [];
  const result = await fetchSocialPage(page('instagram'), { scope: { ...scope, postLimit: 10 }, keys: { hikerapi: 'key', tikhub: 'fallback' }, request: async (provider, raw) => {
    calls.push(provider);
    if (raw.includes('/user/by/')) return hikerProfile;
    return { response: { items: [hikerMedia('123')], more_available: true }, next_page_id: 'repeated' };
  } });
  assert.deepEqual(calls, ['hikerapi', 'hikerapi', 'hikerapi']); assert.equal(result.posts.length, 1);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.stopReason, 'missing-cursor');
});

test('request allowance errors are terminal and cannot be bypassed by fallback or partial results', async () => {
  const calls = [];
  await assert.rejects(fetchSocialPage(page('instagram'), { scope, keys: { hikerapi: 'key', tikhub: 'fallback' }, request: async (provider, raw) => {
    calls.push(provider); if (raw.includes('/user/by/')) return hikerProfile;
    throw new ProviderError('Cap reached', 'BUDGET_LIMIT', 429);
  } }), error => error.code === 'BUDGET_LIMIT');
  assert.deepEqual(calls, ['hikerapi', 'hikerapi']);
});

test('official YouTube adapter never uses a paid provider and keeps unavailable metrics null', async () => {
  const calls = [];
  const result = await fetchSocialPage(page('youtube'), { scope, keys: { 'youtube-official': 'google-key', tikhub: 'paid-key' }, request: async (provider, raw) => {
    const url = new URL(raw); calls.push(url.pathname); assert.equal(provider, 'youtube-official'); assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(url.searchParams.get('key'), 'google-key');
    if (url.pathname.endsWith('/channels')) return { items: [{ id: 'UCabcdefghijklmnopqrstuv', snippet: { title: 'Channel', thumbnails: { high: { url: 'https://images.example.com/avatar.jpg' } } }, statistics: { viewCount: '100', videoCount: '1', hiddenSubscriberCount: true }, contentDetails: { relatedPlaylists: { uploads: 'UUuploads' } } }] };
    if (url.pathname.endsWith('/playlistItems')) return { items: [{ contentDetails: { videoId: 'video123' } }] };
    return { items: [{ id: 'video123', snippet: { title: 'Video', publishedAt: '2026-09-20T00:00:00Z' }, statistics: { viewCount: '0', likeCount: '0' }, contentDetails: { duration: 'PT15S' } }] };
  } });
  assert.equal(calls.length, 3); assert.equal(result.profile.followers, null); assert.equal(result.profile.postCount, 1);
  assert.equal(result.posts[0].views, 0); assert.equal(result.posts[0].shares, null); assert.equal(result.posts[0].type, 'video');
});

function fakeDb(reservations = ['request-1', 'request-2']) {
  const rpc = [], updates = [], inserts = [], cleanupCalls = [];
  return { rpcCalls: rpc, updates, inserts, cleanupCalls,
    async rpc(name, values) {
      if (name === 'desk_cleanup_provider_logs') { cleanupCalls.push(name); return { data: 0, error: null }; }
      rpc.push({ name, values }); return { data: reservations.shift() ?? null, error: null };
    },
    from(table) { assert.equal(table, 'provider_requests'); return {
      update(values) { return { async eq(column, id) { updates.push({ values, column, id }); return { error: null }; } }; },
      insert(values) { inserts.push(values); return { select() { return { async single() { return { data: { id: 'workspace-log' }, error: null }; } }; } }; },
    }; },
  };
}

test('HTTP helper reserves and logs every retry, strips query keys, redacts raw response, and spaces calls', async () => {
  const db = fakeDb(); let clock = 1000; let calls = 0; const delays = [];
  const request = createProviderRequest({ db, platform: 'instagram', now: () => clock, deadline: 5000, minIntervalMs: 200,
    sleep: async ms => { delays.push(ms); clock += ms; }, fetcher: async (_, options) => {
      calls++; assert.equal(options.redirect, 'error'); clock += 10;
      return calls === 1 ? jsonResponse({ error: 'Busy' }, 503) : jsonResponse({ count: 0, api_key: 'top-secret', nested: { access_token: 'also-secret', message: 'top-secret', url: 'https://cdn.example.com/a?signature=secret' } });
    } });
  const result = await request('hikerapi', 'https://api.hikerapi.com/v2/user/by/username?username=sample&api_key=top-secret', { 'x-access-key': 'top-secret' });
  assert.equal(result.count, 0); assert.equal(calls, 2); assert.equal(db.rpcCalls.length, 2); assert.equal(db.updates.length, 2);
  assert.equal(db.cleanupCalls.length, 1);
  assert.equal(db.rpcCalls[0].values.p_endpoint, '/v2/user/by/username'); assert.equal(db.updates[0].values.success, false);
  assert.equal(db.updates[1].values.success, true); assert.equal(db.updates[1].values.latency_ms, 10);
  const log = JSON.stringify(db.updates[1]); assert.ok(!log.includes('top-secret')); assert.ok(!log.includes('also-secret')); assert.ok(!log.includes('signature='));
  assert.ok(delays.includes(500));
});

test('budget cap blocks before network, deadline and HTTP host checks also prevent a request', async () => {
  let calls = 0; const fetcher = async () => { calls++; return jsonResponse({}); };
  await assert.rejects(createProviderRequest({ db: fakeDb([]), platform: 'instagram', fetcher })('hikerapi', 'https://api.hikerapi.com/v2/user/by/username', {}), error => error.code === 'BUDGET_LIMIT');
  await assert.rejects(createProviderRequest({ platform: 'instagram', deadline: 1, fetcher })('hikerapi', 'https://api.hikerapi.com/', {}), error => error.code === 'DEADLINE');
  for (const url of ['http://api.hikerapi.com/', 'https://api.hikerapi.com.evil.test/', 'https://user:password@api.hikerapi.com/', 'https://api.hikerapi.com:9000/']) {
    await assert.rejects(createProviderRequest({ platform: 'instagram', fetcher })('hikerapi', url, {}), /not allowed/);
  }
  assert.equal(calls, 0);
});

test('database allowance failures are terminal and sanitized even when the client throws', async () => {
  const request = createProviderRequest({ platform: 'instagram', db: { rpc: async () => { throw new Error('DB password=secret'); } },
    fetcher: async () => assert.fail('No network allowed') });
  await assert.rejects(request('hikerapi', 'https://api.hikerapi.com/', {}), error => error.code === 'LOGGING' && !error.message.includes('secret'));
});

test('deadline expiry during budget reservation logs a failed attempt without spending credits', async () => {
  let clock = 1000; const db = fakeDb(); const reserve = db.rpc.bind(db);
  db.rpc = async (...args) => { const result = await reserve(...args); if (args[0] === 'desk_reserve_provider_request') clock = 5000; return result; };
  const request = createProviderRequest({ platform: 'instagram', db, now: () => clock, deadline: 4000,
    fetcher: async () => assert.fail('No network allowed') });
  await assert.rejects(request('hikerapi', 'https://api.hikerapi.com/', {}), error => error.code === 'DEADLINE');
  assert.equal(db.updates.length, 1); assert.equal(db.updates[0].values.success, false);
});

test('large upstream bodies are rejected before parsing and authentication errors are not retried', async () => {
  let calls = 0;
  const huge = createProviderRequest({ platform: 'instagram', fetcher: async () => { calls++; return new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }); } });
  await assert.rejects(huge('hikerapi', 'https://api.hikerapi.com/', {}), /allowed size/); assert.equal(calls, 1);
  const denied = createProviderRequest({ platform: 'instagram', fetcher: async () => { calls++; return jsonResponse({ message: 'api_key=secret' }, 401); } });
  await assert.rejects(denied('hikerapi', 'https://api.hikerapi.com/', {}), error => error.status === 401 && !error.message.includes('secret'));
  assert.equal(calls, 2);
});

test('HTTP 200 vendor error envelopes are logged as failed requests', async () => {
  const db = fakeDb();
  const request = createProviderRequest({ db, platform: 'instagram', fetcher: async () => jsonResponse({ code: 500, success: false, message: 'api_key=secret' }) });
  await assert.rejects(request('tikhub', 'https://api.tikhub.io/api/v1/profile', {}), /could not return/);
  assert.equal(db.updates[0].values.success, false); assert.equal(db.updates[0].values.error.includes('secret'), false);
  assert.ok(!JSON.stringify(db.updates[0].values.raw_response).includes('api_key=secret'));
});

test('RapidAPI HTTP 200 status:false envelopes fail inside the request boundary and are safely logged', async () => {
  for (const wrap of [body => body, body => ({ data: body }), body => ({ response: body })]) {
    const db = fakeDb(); let calls = 0;
    const request = createProviderRequest({ db, platform: 'instagram', minIntervalMs: 0, fetcher: async () => {
      calls++;
      return jsonResponse(wrap({ status: false, message: 'Upstream rejected api_key=rapid-fixture-secret',
        details: { 'x-rapidapi-key': 'rapid-fixture-secret' } }));
    } });
    await assert.rejects(request('instagram-looter', 'https://instagram-looter2.p.rapidapi.com/web-profile?username=sample',
      { 'x-rapidapi-key': 'rapid-fixture-secret', 'x-rapidapi-host': 'instagram-looter2.p.rapidapi.com' }), error =>
      error.code === 'PROVIDER' && error.message === 'The data provider could not return this account.');
    assert.equal(calls, 1, 'an explicit vendor rejection must not be silently retried');
    assert.equal(db.rpcCalls.length, 1); assert.equal(db.updates.length, 1);
    assert.equal(db.updates[0].values.success, false);
    assert.equal(db.updates[0].values.error, 'The data provider could not return this account.');
    assert.equal(JSON.stringify(db.updates).includes('rapid-fixture-secret'), false);
  }
});

test('Looter errorMessage failures classify missing and private accounts without echoing vendor details', async () => {
  for (const [body, code, status, message] of [
    [{ status: false, errorMessage: 'This account does not exist.' }, 'NOT_FOUND', 404, 'This account does not exist. Check the profile handle.'],
    [{ status: false, errorMessage: 'This account is private.' }, 'PRIVATE', 422, 'This account is private. Only public accounts can be refreshed.'],
    [{ status: false, is_private: true }, 'PRIVATE', 422, 'This account is private. Only public accounts can be refreshed.'],
    [{ status: false, errorMessage: 'Unrecognized vendor failure api_key=rapid-error-secret' }, 'PROVIDER', 502, 'The data provider could not return this account.'],
  ]) {
    const db = fakeDb();
    const request = createProviderRequest({ db, platform: 'instagram', minIntervalMs: 0,
      fetcher: async () => jsonResponse({ data: body }) });
    await assert.rejects(request('instagram-looter', 'https://instagram-looter2.p.rapidapi.com/web-profile?username=sample',
      { 'x-rapidapi-key': 'rapid-error-secret' }), error => error.code === code && error.status === status && error.message === message);
    assert.equal(db.updates.length, 1); assert.equal(db.updates[0].values.success, false);
    assert.equal(db.updates[0].values.error, message);
    assert.equal(JSON.stringify(db.updates).includes('rapid-error-secret'), false);
  }
});

test('legacy requests reserve owner quota and log workspace funding without consuming global budget', async () => {
  const db = fakeDb(); let reserved = 0;
  const request = createProviderRequest({ db, platform: 'tiktok', owner: 'owner-1', reserveGlobal: false,
    beforeRequest: async () => { reserved++; }, fetcher: async () => jsonResponse({ ok: true }) });
  await request('lamatok', 'https://api.lamatok.com/v1/user/by/username?username=sample', {});
  assert.equal(reserved, 1); assert.equal(db.rpcCalls.length, 0); assert.equal(db.inserts[0].funding, 'workspace');
  assert.equal(db.inserts[0].owner, 'owner-1'); assert.equal(db.inserts[0].estimated_cost_usd, 0);
  const blocked = createProviderRequest({ platform: 'tiktok', beforeRequest: async () => { throw new Error('private quota internals'); }, fetcher: async () => assert.fail('No network allowed') });
  await assert.rejects(blocked('lamatok', 'https://api.lamatok.com/', {}), error => error.code === 'REQUEST_BLOCKED' && !error.message.includes('private'));
});

test('retry budget is finite, individual request cap is terminal, and network secrets are never emitted', async () => {
  let calls = 0;
  const request = createProviderRequest({ platform: 'instagram', sleep: async () => {}, minIntervalMs: 0, maxCalls: 1,
    fetcher: async () => { calls++; throw new Error('Error fetching https://api.hikerapi.com/?key=SUPERSECRET'); } });
  await assert.rejects(request('hikerapi', 'https://api.hikerapi.com/', {}), error => error.code === 'REQUEST_LIMIT' && !error.message.includes('SUPERSECRET'));
  assert.equal(calls, 1);
});

test('large debug payloads are bounded and credentials cannot escape in nested fields', () => {
  const raw = { authorization: 'Bearer SECRET', nested: [{ accessToken: 'SECRET', password: 'SECRET', contact_email: 'user@example.com' }], data: 'x'.repeat(100000) };
  const redacted = redactProviderResponse(raw, ['SECRET']);
  assert.ok(Buffer.byteLength(JSON.stringify(redacted)) <= 32 * 1024); assert.ok(!JSON.stringify(redacted).includes('SECRET'));
  assert.ok(!JSON.stringify(redacted).includes('user@example.com'));
});

test('server environment key mapping and per-platform defaults are explicit', () => {
  assert.deepEqual(getConfiguredKeys({ HIKERAPI_KEY: ' h ', LAMATOK_KEY: 'l', YOUTUBE_API_KEY: 'y', TIKHUB_KEY: 't', SCRAPECREATORS_KEY: 's' }),
    { hikerapi: 'h', lamatok: 'l', 'youtube-official': 'y', tikhub: 't', scrapecreators: 's' });
  assert.deepEqual(DEFAULT_PROVIDER_ORDER.tiktok, ['lamatok', 'tikhub', 'scrapecreators']);
});
