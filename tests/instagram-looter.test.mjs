import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
  new Function('require', 'module', 'exports', output)(spec => spec === 'server-only' ? {} : spec.startsWith('.')
    ? load(path.resolve(path.dirname(file), spec + (path.extname(spec) ? '' : '.ts'))) : require(spec), module, module.exports);
  return module.exports;
}
const { fetchSocialPage, createProviderRequest, ProviderError } = load('lib/social-provider.ts');
const { instagramLooter } = load('lib/providers/instagram-looter.ts');
const page = { id: 'page-1', platform: 'instagram', handle: 'sample', url: 'https://www.instagram.com/sample/' };
const scope = { mode: 'posts', postLimit: 2, from: null, to: null };
// Synthetic native Instagram payloads. URLs/parameters checked in RapidAPI's public
// playground; it supplies no response examples. These do not represent live API calls.
const profile = { data: { user: { id: '80117947544', username: 'sample', full_name: 'Sample',
  edge_followed_by: { count: 0 }, edge_follow: { count: 4 }, edge_owner_to_timeline_media: { count: 8 },
  profile_pic_url: 'https://images.example.com/profile.jpg', is_private: false, is_verified: false } }, status: 'ok' };
const media = (id, extra = {}) => ({ pk: id, code: `CODE${id}`, media_type: 2, taken_at: 1790200000,
  caption: { text: 'Example' }, ig_play_count: 24, play_count: 40, fb_play_count: 16,
  like_count: 0, comment_count: 0, video_duration: 12.4,
  image_versions2: { candidates: [{ url: 'https://images.example.com/cover.jpg' }] }, ...extra });
const options = request => ({ key: 'fixture-rapidapi-secret', scope, request });
const feed = items => ({ items, more_available: false, next_max_id: null });

test('Looter is selectable for Instagram and sends only the documented host and header credentials', async () => {
  const calls = [];
  const result = await fetchSocialPage(page, { scope, keys: { 'instagram-looter': 'fixture-rapidapi-secret' }, providerOrder: ['instagram-looter'],
    request: async (provider, raw, headers) => {
      const url = new URL(raw); calls.push(url);
      assert.equal(provider, 'instagram-looter'); assert.equal(url.origin, 'https://instagram-looter2.p.rapidapi.com');
      assert.equal(headers['x-rapidapi-key'], 'fixture-rapidapi-secret');
      assert.equal(headers['x-rapidapi-host'], 'instagram-looter2.p.rapidapi.com');
      assert.equal(raw.includes('fixture-rapidapi-secret'), false);
      if (url.pathname === '/web-profile') { assert.equal(url.searchParams.get('username'), 'sample'); return profile; }
      assert.equal(url.pathname, '/user-feeds'); assert.equal(url.searchParams.get('id'), '80117947544');
      assert.equal(url.searchParams.get('allow_restricted_media'), 'false');
      assert.equal(url.searchParams.get('count'), '12');
      if (!url.searchParams.has('max_id')) return { data: { items: [media('3894831928272017840')], more_available: true, next_max_id: 'opaque+/token==' } };
      assert.equal(url.searchParams.get('max_id'), 'opaque+/token==');
      return feed([media('3894831928272017841', { taken_at: 1790300000, like_count: undefined, ig_play_count: undefined })]);
    } });
  assert.equal(calls.length, 3); assert.equal(result.profile.id, '80117947544'); assert.equal(result.profile.followers, 0);
  assert.equal(result.profile.following, 4); assert.equal(result.profile.isVerified, false);
  assert.deepEqual(result.posts.map(p => p.id), ['3894831928272017841', '3894831928272017840']);
  assert.equal(result.posts[0].views, null); assert.equal(result.posts[1].views, 24);
  assert.equal(result.posts[0].likes, null); assert.equal(result.posts[1].likes, 0); assert.equal(result.posts[1].comments, 0);
  assert.equal(result.posts[1].saves, null); assert.equal(result.posts[1].shares, null);
  assert.equal(result.coverage.complete, true);
  assert.equal(JSON.stringify(result).includes('fixture-rapidapi-secret'), false);
});

test('old pinned posts cannot displace newer posts from the next feed page', async () => {
  let feeds = 0;
  const result = await instagramLooter.fetchPage(page, options(async (_, raw) => {
    if (raw.includes('/web-profile')) return profile;
    return ++feeds === 1 ? { items: [media('1', { is_pinned: true, taken_at: 1690200000 }), media('2')], more_available: true, next_max_id: 'next' }
      : { items: [media('3', { taken_at: 1790100000 })], more_available: true, next_max_id: 'older' };
  }));
  assert.equal(feeds, 2); assert.deepEqual(result.posts.map(p => p.id), ['2', '3']);
  assert.equal(result.coverage.stopReason, 'post-limit'); assert.equal(result.coverage.complete, true);
});

test('Looter leaves missing/rounded/hidden counters null and normalizes carousel and compound identifiers', async () => {
  const result = await instagramLooter.fetchPage(page, options(async (_, raw) => raw.includes('/web-profile') ? profile : feed([
    media('3894831928272017840_80117947544', { media_type: 8, like_count: '1.2K', like_and_view_counts_disabled: true, comment_count: undefined, save_count: 99, share_count: 80 }),
    media('3894831928272017841', { media_type: 1, is_pinned: 1, taken_at: 1790300000 }),
  ])));
  const post = result.posts.find(p => p.type === 'carousel');
  assert.equal(post.id, '3894831928272017840'); assert.equal(post.likes, null); assert.equal(post.likesReason, 'hidden');
  assert.equal(post.comments, null); assert.equal(post.views, null); assert.equal(post.shares, null); assert.equal(post.saves, null);
  assert.equal(result.posts[0].type, 'image'); assert.equal(result.posts[0].views, null); assert.equal(result.posts[0].isPinned, true);
});

test('private, wrong-identity, unsafe identifiers and unexpected/empty responses never become empty successes', async () => {
  for (const user of [ { ...profile.data.user, is_private: true }, { ...profile.data.user, username: 'somebody_else' },
    { ...profile.data.user, id: 99999999999999999999 } ]) {
    await assert.rejects(instagramLooter.fetchPage(page, options(async () => ({ user }))));
  }
  for (const payload of [{}, { items: [] }, { status: false, items: [] }, feed([media(99999999999999999999)])]) {
    await assert.rejects(instagramLooter.fetchPage(page, options(async (_, raw) => raw.includes('/web-profile') ? profile : payload)));
  }
  const empty = await instagramLooter.fetchPage(page, options(async (_, raw) => raw.includes('/web-profile') ? profile : feed([])));
  assert.equal(empty.posts.length, 0); assert.equal(empty.coverage.complete, true);
});

test('missing, repeated cursors and partial vendor failures retain fetched posts but disclose incomplete coverage', async () => {
  for (const mode of ['missing', 'repeated', 'failure']) {
    let calls = 0;
    const result = await instagramLooter.fetchPage(page, { ...options(async (_, raw) => {
      if (raw.includes('/web-profile')) return profile;
      if (++calls > 1 && mode === 'failure') throw new ProviderError('Temporary provider failure');
      return { items: [media('1')], more_available: true, next_max_id: mode === 'missing' ? null : 'same' };
    }), scope: { ...scope, postLimit: 10 } });
    assert.equal(result.posts.length, 1); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.incomplete, true);
    assert.ok(calls <= 2);
  }
});

test('date mode uses publication time and excludes undated posts without claiming complete coverage', async () => {
  const result = await instagramLooter.fetchPage(page, { ...options(async (_, raw) => raw.includes('/web-profile') ? profile : feed([
    media('1', { taken_at: 1790200000 }), media('2', { taken_at: null }), media('3', { taken_at: 1690200000, is_pinned: true }),
  ])), scope: { mode: 'date', postLimit: 1000, from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } });
  assert.deepEqual(result.posts.map(p => p.id), ['1']); assert.equal(result.coverage.unknownDates, 1); assert.equal(result.coverage.complete, false);
});

test('RapidAPI facade rejects lookalikes, insecure URLs, userinfo and ports before any network call', async () => {
  let calls = 0;
  const request = createProviderRequest({ platform: 'instagram', minIntervalMs: 0, fetcher: async (_, init) => {
    calls++; assert.equal(init.redirect, 'error');
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  } });
  for (const url of ['http://instagram-looter2.p.rapidapi.com/web-profile', 'https://instagram-looter2.p.rapidapi.com.evil.example/web-profile',
    'https://key@instagram-looter2.p.rapidapi.com/web-profile', 'https://instagram-looter2.p.rapidapi.com:444/web-profile']) {
    await assert.rejects(request('instagram-looter', url, {}), error => error.code === 'CONFIGURATION');
  }
  assert.equal(calls, 0);
  await request('instagram-looter', 'https://instagram-looter2.p.rapidapi.com/web-profile', {});
  assert.equal(calls, 1);
});

test('a missing timestamp schema stops partial after one feed instead of spending on 49 pages', async () => {
  let feeds = 0;
  const result = await instagramLooter.fetchPage(page, options(async (_, raw) => {
    if (raw.includes('/web-profile')) return profile;
    feeds++;
    return { items: [media('1', { taken_at: null })], more_available: true, next_max_id: 'next' };
  }));
  assert.equal(feeds, 1); assert.equal(result.posts.length, 1);
  assert.equal(result.coverage.stopReason, 'unknown-dates'); assert.equal(result.coverage.complete, false);
});
