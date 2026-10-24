import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HEADERS, overrideKey, normalizeHeaders, normalizeOverrides, parseManualValue, displayMetric, sumDisplay } from '../lib/display.ts';
import { DEFAULT_SCOPE, scopeFromDates } from '../lib/scope.ts';

const page = { id: 'youtube:one', followers: 40, overall: { followers: 45, views: 10000, posts: 20 } };
const selection = { usable: true, complete: true, posts: [
  { views: 100, likes: null, comments: 0, shares: null },
  { views: 200, likes: 10, comments: 4, shares: null },
] };
const metric = (name, overrides = {}, source = page, selected = selection, scope = DEFAULT_SCOPE) => displayMetric(source, selected, scope, overrides, name);

test('mixed-platform aggregation sums available counts independently and retains partial coverage', () => {
  const instagram = { id: 'instagram:one', followers: 10, overall: null };
  assert.deepEqual(sumDisplay([metric('views'), metric('views', {}, instagram)]), { value: 600, manual: false, known: 2, total: 2 });
  assert.deepEqual(sumDisplay([metric('lifetimeViews'), metric('lifetimeViews', {}, instagram)]), { value: 10000, manual: false, known: 1, total: 2 });
  assert.deepEqual(sumDisplay([metric('shares'), metric('shares', {}, instagram)]), { value: null, manual: false, known: 0, total: 2 });
  assert.deepEqual(sumDisplay([]), { value: null, manual: false, known: 0, total: 0 });
});

test('selected metrics sum known posts without converting unavailable counters to zero', () => {
  assert.deepEqual(metric('views'), { value: 300, manual: false, known: 2, total: 2 });
  assert.deepEqual(metric('likes'), { value: 10, manual: false, known: 1, total: 2 });
  assert.deepEqual(metric('comments'), { value: 4, manual: false, known: 2, total: 2 });
  assert.equal(metric('shares').value, null);
  assert.equal(metric('posts').value, 2);
  assert.equal(metric('views', {}, page, { posts: [], usable: true, complete: true }).value, 0);
  assert.equal(metric('views', {}, page, { posts: [], usable: true, complete: false }).value, null);
  assert.equal(metric('views', {}, page, { ...selection, usable: false }).value, null);
  assert.equal(metric('posts', {}, page, { ...selection, usable: false }).value, null);
});

test('a manual zero is available, starred, contributes to summary, and never mutates source', () => {
  const overrides = { [overrideKey(page.id, DEFAULT_SCOPE, 'shares')]: 0 };
  assert.deepEqual(metric('shares', overrides), { value: 0, manual: true, known: 1, total: 1 });
  assert.deepEqual(sumDisplay([metric('shares', overrides), metric('shares')]), { value: 0, manual: true, known: 1, total: 2 });
  assert.deepEqual(metric('shares', overrides, page, { posts: [], usable: false, complete: false }), { value: 0, manual: true, known: 1, total: 1 });
  assert.equal(selection.posts[0].shares, null);
});

test('selection overrides are isolated by exact scope while profile overrides survive scope changes', () => {
  const range = scopeFromDates('2026-10-01', '2026-10-24');
  for (const name of ['views', 'likes', 'comments', 'shares', 'posts']) assert.notEqual(overrideKey(page.id, DEFAULT_SCOPE, name), overrideKey(page.id, range, name));
  for (const name of ['followers', 'lifetimeViews', 'lifetimePosts']) assert.equal(overrideKey(page.id, DEFAULT_SCOPE, name), overrideKey(page.id, range, name));
  const overrides = { [overrideKey(page.id, DEFAULT_SCOPE, 'views')]: 999 };
  assert.equal(metric('views', overrides).value, 999);
  assert.equal(metric('views', overrides, page, selection, range).value, 300);
  assert.notEqual(overrideKey(page.id, DEFAULT_SCOPE, 'views'), overrideKey('instagram:one', DEFAULT_SCOPE, 'views'));
});

test('profile metrics preserve exact zero, fall back for followers only, and never substitute selected views', () => {
  assert.equal(metric('followers').value, 40);
  assert.equal(metric('followers', {}, { ...page, followers: 0 }).value, 0);
  assert.equal(metric('followers', {}, { ...page, followers: null }).value, 45);
  assert.equal(metric('lifetimeViews', {}, { ...page, overall: null }).value, null);
  assert.equal(metric('lifetimePosts').value, 20);
});

test('manual parsing accepts exact international/Indian grouped counts and rejects invalid or unsafe entries', () => {
  for (const [input, expected] of [[0, 0], ['0', 0], [' 1,234 ', 1234], ['12,34,567', 1234567], ['123456', 123456], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) assert.equal(parseManualValue(input), expected);
  for (const input of ['', ' ', null, undefined, true, -1, 1.5, '-1', '1.5', '1e3', '1k', '1,', '1,,000', '1,23', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) assert.equal(parseManualValue(input), null, String(input));
});

test('saved overrides keep valid keys/numbers and ignore corrupted or unknown entries', () => {
  const zero = overrideKey(page.id, DEFAULT_SCOPE, 'views');
  const profile = overrideKey(page.id, DEFAULT_SCOPE, 'followers');
  const invalid = [JSON.stringify([page.id, 'profile', 'views']), JSON.stringify([page.id, 'posts:30', 'followers']), JSON.stringify([page.id, 'posts:30', 'unknown']), 'not json'];
  assert.deepEqual(normalizeOverrides({ [zero]: 0, [profile]: 50, ...Object.fromEntries(invalid.map(key => [key, 1])) }), { [zero]: 0, [profile]: 50 });
  assert.deepEqual(normalizeOverrides({ [zero]: -1, [profile]: '50' }), {});
  assert.deepEqual(normalizeOverrides(null), {});
  assert.deepEqual(normalizeOverrides([]), {});
});

test('header normalization restores defaults, trims custom labels, limits length, and drops unknown keys', () => {
  assert.deepEqual(normalizeHeaders(null), DEFAULT_HEADERS);
  const headers = normalizeHeaders({ views: ' Total views ', likes: ' ', page: 'x'.repeat(100), unknown: 'bad', posts: 42 });
  assert.equal(headers.views, 'Total views');
  assert.equal(headers.likes, DEFAULT_HEADERS.likes);
  assert.equal(headers.page.length, 60);
  assert.equal(headers.posts, DEFAULT_HEADERS.posts);
  assert.equal(Object.hasOwn(headers, 'unknown'), false);
  assert.equal(DEFAULT_HEADERS.views, 'Views');
});
