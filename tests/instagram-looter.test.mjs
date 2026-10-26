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
// Profile and media envelope shapes match successful User Info V1 and User Media
// V2 responses observed on 2026-10-26. Most values below are synthetic edge cases;
// dedicated regressions also retain minimal public fields from the observed data.
const profile = { status: true, id: '80117947544', username: 'sample', full_name: 'Sample',
  edge_followed_by: { count: 0 }, edge_follow: { count: 4 }, edge_owner_to_timeline_media: { count: 8 },
  profile_pic_url: 'https://images.example.com/profile.jpg', is_private: false, is_verified: false };
const media = (id, extra = {}) => ({ id, shortcode: `CODE${id}`, __typename: 'GraphVideo', is_video: true, taken_at_timestamp: 1790200000,
  edge_media_to_caption: { edges: [{ node: { text: 'Example' } }] }, video_view_count: 24,
  edge_media_preview_like: { count: 0, edges: [] }, edge_media_to_comment: { count: 0 }, video_duration: 12.4,
  display_url: 'https://images.example.com/cover.jpg', pinned_for_users: [], ...extra });
const options = request => ({ key: 'fixture-rapidapi-secret', scope, request });
const feed = (items, hasMore = false, cursor = null) => ({ data: { user: { edge_owner_to_timeline_media: {
  count: null, page_info: { has_next_page: hasMore, end_cursor: cursor }, edges: items.map(node => ({ node })),
} } }, attempts: '526' });

test('Looter is selectable for Instagram and sends only the documented host and header credentials', async () => {
  const calls = [];
  const result = await fetchSocialPage(page, { scope, keys: { 'instagram-looter': 'fixture-rapidapi-secret' }, providerOrder: ['instagram-looter'],
    request: async (provider, raw, headers) => {
      const url = new URL(raw); calls.push(url);
      assert.equal(provider, 'instagram-looter'); assert.equal(url.origin, 'https://instagram-looter2.p.rapidapi.com');
      assert.equal(headers['x-rapidapi-key'], 'fixture-rapidapi-secret');
      assert.equal(headers['x-rapidapi-host'], 'instagram-looter2.p.rapidapi.com');
      assert.equal(raw.includes('fixture-rapidapi-secret'), false);
      if (url.pathname === '/profile') {
        assert.equal(url.searchParams.get('username'), 'sample'); assert.equal(url.searchParams.has('id'), false);
        return profile;
      }
      assert.equal(url.pathname, '/user-feeds2'); assert.equal(url.searchParams.get('id'), '80117947544');
      assert.equal(url.searchParams.has('allow_restricted_media'), false); assert.equal(url.searchParams.has('max_id'), false);
      assert.equal(url.searchParams.get('count'), '12');
      if (!url.searchParams.has('end_cursor')) return feed([media('3894831928272017840')], true, 'opaque+/token==');
      assert.equal(url.searchParams.get('end_cursor'), 'opaque+/token==');
      return feed([media('3894831928272017841', { taken_at_timestamp: 1790300000, edge_media_preview_like: undefined, video_view_count: undefined })]);
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
    if (raw.includes('/profile')) return profile;
    return ++feeds === 1 ? feed([media('1', { pinned_for_users: ['80117947544'], taken_at_timestamp: 1690200000 }), media('2')], true, 'next')
      : feed([media('3', { taken_at_timestamp: 1790100000 })], true, 'older');
  }));
  assert.equal(feeds, 2); assert.deepEqual(result.posts.map(p => p.id), ['2', '3']);
  assert.equal(result.coverage.stopReason, 'post-limit'); assert.equal(result.coverage.complete, true);
});

test('Looter leaves missing/rounded/hidden counters null and normalizes carousel and compound identifiers', async () => {
  const result = await instagramLooter.fetchPage(page, options(async (_, raw) => raw.includes('/profile') ? profile : feed([
    media('3894831928272017840_80117947544', { __typename: 'GraphSidecar', is_video: false, edge_media_preview_like: { count: '1.2K' }, like_and_view_counts_disabled: true, edge_media_to_comment: undefined, save_count: 99, share_count: 80 }),
    media('3894831928272017841', { __typename: 'GraphImage', is_video: false, is_pinned: 1, taken_at_timestamp: 1790300000 }),
  ])));
  const post = result.posts.find(p => p.type === 'carousel');
  assert.equal(post.id, '3894831928272017840'); assert.equal(post.likes, null); assert.equal(post.likesReason, 'hidden');
  assert.equal(post.comments, null); assert.equal(post.views, null); assert.equal(post.shares, null); assert.equal(post.saves, null);
  assert.equal(result.posts[0].type, 'image'); assert.equal(result.posts[0].views, null); assert.equal(result.posts[0].isPinned, true);
});

test('private, wrong-identity, unsafe identifiers and unexpected/empty responses never become empty successes', async () => {
  for (const user of [ { ...profile, is_private: true }, { ...profile, username: 'somebody_else' },
    { ...profile, id: 99999999999999999999 } ]) {
    await assert.rejects(instagramLooter.fetchPage(page, options(async () => user)));
  }
  for (const payload of [{}, { items: [] }, { status: false, items: [] },
    { data: { user: { edge_owner_to_timeline_media: { edges: [] } } } },
    { data: { user: { edge_owner_to_timeline_media: { edges: [], page_info: { has_next_page: 'false', end_cursor: null } } } } },
    feed([media(99999999999999999999)])]) {
    await assert.rejects(instagramLooter.fetchPage(page, options(async (_, raw) => raw.includes('/profile') ? profile : payload)));
  }
  const empty = await instagramLooter.fetchPage(page, options(async (_, raw) => raw.includes('/profile') ? profile : feed([])));
  assert.equal(empty.posts.length, 0); assert.equal(empty.coverage.complete, true);
});

test('missing, repeated cursors and partial vendor failures retain fetched posts but disclose incomplete coverage', async () => {
  for (const mode of ['missing', 'repeated', 'failure']) {
    let calls = 0;
    const result = await instagramLooter.fetchPage(page, { ...options(async (_, raw) => {
      if (raw.includes('/profile')) return profile;
      if (++calls > 1 && mode === 'failure') throw new ProviderError('Temporary provider failure');
      return feed([media('1')], true, mode === 'missing' ? null : 'same');
    }), scope: { ...scope, postLimit: 10 } });
    assert.equal(result.posts.length, 1); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.incomplete, true);
    assert.ok(calls <= 2);
  }
});

test('date mode uses publication time and excludes undated posts without claiming complete coverage', async () => {
  const result = await instagramLooter.fetchPage(page, { ...options(async (_, raw) => raw.includes('/profile') ? profile : feed([
    media('1', { taken_at_timestamp: 1790200000 }), media('2', { taken_at_timestamp: null }), media('3', { taken_at_timestamp: 1690200000, is_pinned: true }),
  ])), scope: { mode: 'date', postLimit: 1000, from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } });
  assert.deepEqual(result.posts.map(p => p.id), ['1']); assert.equal(result.coverage.unknownDates, 1); assert.equal(result.coverage.complete, false);
});

test('RapidAPI facade rejects lookalikes, insecure URLs, userinfo and ports before any network call', async () => {
  let calls = 0;
  const request = createProviderRequest({ platform: 'instagram', minIntervalMs: 0, fetcher: async (_, init) => {
    calls++; assert.equal(init.redirect, 'error');
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  } });
  for (const url of ['http://instagram-looter2.p.rapidapi.com/profile', 'https://instagram-looter2.p.rapidapi.com.evil.example/profile',
    'https://key@instagram-looter2.p.rapidapi.com/profile', 'https://instagram-looter2.p.rapidapi.com:444/profile']) {
    await assert.rejects(request('instagram-looter', url, {}), error => error.code === 'CONFIGURATION');
  }
  assert.equal(calls, 0);
  await request('instagram-looter', 'https://instagram-looter2.p.rapidapi.com/profile', {});
  assert.equal(calls, 1);
});

test('a missing timestamp schema stops partial after one feed instead of spending on 49 pages', async () => {
  let feeds = 0;
  const result = await instagramLooter.fetchPage(page, options(async (_, raw) => {
    if (raw.includes('/profile')) return profile;
    feeds++;
    return feed([media('1', { taken_at_timestamp: null })], true, 'next');
  }));
  assert.equal(feeds, 1); assert.equal(result.posts.length, 1);
  assert.equal(result.coverage.stopReason, 'unknown-dates'); assert.equal(result.coverage.complete, false);
});

test('verified User Media V2 envelope retains returned likes despite its disabled presentation flag', async () => {
  const node = { __typename: 'GraphVideo', id: '4007110762244757234', is_video: true, video_view_count: 4121,
    shortcode: 'DecHgH3Plby', edge_media_to_comment: { count: 0, page_info: { has_next_page: false, end_cursor: null } },
    taken_at_timestamp: 1791904984, edge_media_preview_like: { count: 3, edges: [] }, pinned_for_users: [],
    like_and_view_counts_disabled: true, product_type: 'clips' };
  let calls = 0;
  const result = await instagramLooter.fetchPage(page, options(async (_, raw) => {
    if (raw.includes('/profile')) return profile;
    if (++calls === 1) return feed([node], true, '4001322154833329318_38276910342');
    assert.equal(new URL(raw).searchParams.get('end_cursor'), '4001322154833329318_38276910342');
    return feed([]);
  }));
  assert.equal(calls, 2); assert.equal(result.posts.length, 1); assert.equal(result.coverage.complete, true);
  assert.equal(result.posts[0].id, '4007110762244757234'); assert.equal(result.posts[0].views, 4121);
  assert.equal(result.posts[0].likes, 3); assert.equal(result.posts[0].likesReason, null);
  assert.equal(result.posts[0].comments, 0); assert.equal(result.posts[0].type, 'video');
  assert.equal(result.posts[0].url, 'https://www.instagram.com/p/DecHgH3Plby/');
});

test('a large requested post limit keeps the verified twelve-item upstream page size', async () => {
  let feeds = 0;
  const result = await instagramLooter.fetchPage(page, { ...options(async (_, raw) => {
    if (raw.includes('/profile')) return profile;
    const url = new URL(raw); assert.equal(url.searchParams.get('count'), '12');
    assert.equal(url.searchParams.has('max_id'), false);
    const start = feeds++ * 12;
    const items = Array.from({ length: 12 }, (_, index) => media(String(start + index + 1)));
    return feeds === 1 ? feed(items, true, 'next-twelve') : feed(items);
  }), scope: { ...scope, postLimit: 1000 } });
  assert.equal(feeds, 2); assert.equal(result.posts.length, 24);
  assert.equal(result.coverage.stopReason, 'exhausted'); assert.equal(result.coverage.hasMore, false);
});

test('verified flat User Info V1 profile resolves its exact account ID before the V2 feed request', async () => {
  const account = { ...page, handle: 'theunscripted.bharat', url: 'https://www.instagram.com/theunscripted.bharat/' };
  const observedProfile = { status: true, id: '15629622050', username: 'theunscripted.bharat', full_name: 'The Unscripted Bharat',
    edge_followed_by: { count: 5045 }, edge_follow: { count: 0 },
    edge_owner_to_timeline_media: { count: 0, page_info: { has_next_page: false, end_cursor: null }, edges: [] },
    is_private: false, is_verified: false };
  const paths = [];
  const result = await instagramLooter.fetchPage(account, options(async (_, raw) => {
    const url = new URL(raw); paths.push(url.pathname);
    if (url.pathname === '/profile') {
      assert.equal(url.searchParams.get('username'), 'theunscripted.bharat');
      assert.equal(url.searchParams.has('id'), false);
      return observedProfile;
    }
    assert.equal(url.pathname, '/user-feeds2'); assert.equal(url.searchParams.get('id'), '15629622050');
    return feed([]);
  }));
  assert.deepEqual(paths, ['/profile', '/user-feeds2']);
  assert.equal(result.canonicalId, '15629622050'); assert.equal(result.profile.followers, 5045);
  assert.equal(result.profile.following, 0); assert.equal(result.profile.name, 'The Unscripted Bharat');
});

test('a zero profile total contradicted by fetched posts becomes unavailable without estimating a lifetime total', async () => {
  const zeroProfile = { ...profile, edge_owner_to_timeline_media: { count: 0 } };
  for (const requestedScope of [scope,
    { mode: 'date', postLimit: 1000, from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }]) {
    const result = await instagramLooter.fetchPage(page, { ...options(async (_, raw) =>
      raw.includes('/profile') ? zeroProfile : feed([media('4007110762244757234')])), scope: requestedScope });
    assert.equal(result.coverage.scanned, 1);
    assert.equal(result.posts.length, requestedScope.mode === 'date' ? 0 : 1);
    assert.equal(result.profile.postCount, null); assert.equal(result.overall.posts, null);
    assert.match(result.coverage.note, /did not return a reliable profile post total/);
  }
});

test('a zero profile total remains zero when the exhausted feed is empty', async () => {
  const result = await instagramLooter.fetchPage(page, options(async (_, raw) => raw.includes('/profile')
    ? { ...profile, edge_owner_to_timeline_media: { count: 0 } } : feed([])));
  assert.equal(result.posts.length, 0); assert.equal(result.coverage.scanned, 0);
  assert.equal(result.profile.postCount, 0); assert.equal(result.overall.posts, 0);
  assert.doesNotMatch(result.coverage.note, /did not return a reliable profile post total/);
});
