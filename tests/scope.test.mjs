import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCOPE, normalizeScope, scopeFromDates, scopeKey, selectPosts,
  snapshotMatches, snapshotCovers, snapshotCanDisplay, postDates, dateInput,
} from '../lib/scope.ts';

const postsScope = n => ({ mode:'posts', postLimit:n, from:null, to:null });
const range = scopeFromDates('2026-10-01', '2026-10-24');

test('post count accepts custom integer limits and rejects invalid limits', () => {
  for (const n of [1, 30, 75, 500, 1000]) assert.deepEqual(normalizeScope(postsScope(n)), postsScope(n));
  for (const n of [0, -1, 1.5, 1001, NaN, 'invalid']) assert.throws(() => normalizeScope(postsScope(n)));
  assert.deepEqual(normalizeScope(undefined), DEFAULT_SCOPE);
  assert.deepEqual(normalizeScope(null, 100), postsScope(100));
  assert.notEqual(normalizeScope(undefined), DEFAULT_SCOPE, 'a caller must not mutate the shared default');
});

test('India calendar days become an inclusive start and exclusive next-day end', () => {
  assert.deepEqual(scopeFromDates('2026-10-24', '2026-10-24'), {
    mode:'date', postLimit:1000,
    from:'2026-10-23T18:30:00.000Z', to:'2026-10-24T18:30:00.000Z',
  });
  assert.deepEqual(scopeFromDates('2024-02-29', '2024-03-01'), {
    mode:'date', postLimit:1000,
    from:'2024-02-28T18:30:00.000Z', to:'2024-03-01T18:30:00.000Z',
  });
  assert.equal(dateInput('2026-10-23T18:30:00.000Z'), '2026-10-24');
  assert.equal(dateInput('2026-10-24T18:29:59.000Z'), '2026-10-24');
});

test('invalid dates and reversed or empty intervals are rejected', () => {
  for (const day of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-01', '']) {
    assert.throws(() => scopeFromDates(day, '2026-10-24'), day);
  }
  assert.throws(() => scopeFromDates('2026-10-25', '2026-10-24'));
  assert.throws(() => normalizeScope({ mode:'date', from:range.from, to:range.from }));
  assert.throws(() => normalizeScope({ mode:'date', from:'not a date', to:range.to }));
  assert.throws(() => normalizeScope({ mode:'date', from:'2026-02-30T00:00:00Z', to:'2026-03-10T00:00:00Z' }));
});

test('date selection includes the starting instant, excludes the ending instant and excludes undated posts', () => {
  const scope = scopeFromDates('2026-10-24', '2026-10-24');
  const posts = [
    { id:'before', publishedAt:'2026-10-23T18:29:59.999Z' },
    { id:'from', publishedAt:scope.from },
    { id:'middle', publishedAt:'2026-10-24T09:00:00.000Z' },
    { id:'last', publishedAt:'2026-10-24T18:29:59.999Z' },
    { id:'to', publishedAt:scope.to },
    { id:'unknown', publishedAt:null },
    { id:'invalid', publishedAt:'not a date' },
  ];
  assert.deepEqual(selectPosts(posts, scope).map(p => p.id), ['from', 'middle', 'last']);
  assert.equal(posts.length, 7, 'selection does not mutate the stored snapshot');
});

test('post-count selection preserves provider order and cannot silently exceed the chosen count', () => {
  const posts = [{ id:'a', publishedAt:null }, { id:'b', publishedAt:'2026-10-01T00:00:00Z' }, { id:'c', publishedAt:'2026-10-02T00:00:00Z' }];
  assert.deepEqual(selectPosts(posts, postsScope(2)).map(p => p.id), ['a', 'b']);
  assert.deepEqual(selectPosts(posts, postsScope(30)), posts);
});

test('legacy 30-post snapshots match their original request and cover smaller post selections', () => {
  const coverage = { limit:30, fetched:30, hasMore:true, incomplete:false };
  assert.equal(snapshotMatches(coverage, DEFAULT_SCOPE), true);
  assert.equal(snapshotCovers(coverage, postsScope(10)), true);
  assert.equal(snapshotCovers(coverage, postsScope(100)), false);
  assert.equal(snapshotCanDisplay(coverage, postsScope(100)), false);
  assert.equal(snapshotMatches(coverage, range), false);
});

test('a fully exhausted feed can satisfy a larger count even when the account has few posts', () => {
  const coverage = { limit:30, fetched:4, hasMore:false, complete:true };
  assert.equal(snapshotCovers(coverage, postsScope(1000)), true);
  assert.equal(snapshotCovers({ ...coverage, incomplete:true }, postsScope(1000)), true, 'missing counters do not imply missing posts');
});

test('a complete wider date traversal covers a narrower range but never a wider requested range', () => {
  const coverage = { requestedMode:'date', from:range.from, to:range.to, limit:1000, fetched:20, complete:true, hasMore:true, unknownDates:0 };
  assert.equal(snapshotMatches(coverage, range), true);
  assert.equal(snapshotCovers(coverage, scopeFromDates('2026-10-05', '2026-10-10')), true);
  assert.equal(snapshotCovers(coverage, scopeFromDates('2026-09-30', '2026-10-10')), false);
  assert.equal(snapshotCovers(coverage, scopeFromDates('2026-10-05', '2026-10-25')), false);
  assert.equal(snapshotCovers(coverage, postsScope(10)), false, 'date-selected posts cannot stand in for newest channel posts');
});

test('incomplete exact-date snapshots remain displayable as partial but do not claim full coverage', () => {
  const coverage = { requestedMode:'date', from:range.from, to:range.to, limit:1000, fetched:20, complete:false, incomplete:true, unknownDates:0 };
  assert.equal(snapshotMatches(coverage, range), true);
  assert.equal(snapshotCanDisplay(coverage, range), true);
  assert.equal(snapshotCovers(coverage, range), false);
  assert.equal(snapshotCanDisplay(coverage, scopeFromDates('2026-09-01', '2026-09-30')), false);
  assert.equal(snapshotCovers({ ...coverage, complete:true, unknownDates:1 }, range), false);
});

test('a newest-post snapshot needs a strictly older known boundary to cover a date interval', () => {
  const coverage = { limit:100, fetched:100, complete:true, hasMore:true, unknownDates:0, oldest:'2026-09-30T18:29:59.999Z' };
  assert.equal(snapshotCovers(coverage, range), true);
  assert.equal(snapshotCovers({ ...coverage, oldest:range.from }, range), false, 'a tied boundary could have omitted posts');
  assert.equal(snapshotCovers({ ...coverage, unknownDates:1 }, range), false);
});

test('unfetched coverage is never mistaken for a complete or displayable snapshot', () => {
  assert.equal(snapshotMatches({}, DEFAULT_SCOPE), false);
  assert.equal(snapshotCovers({}, DEFAULT_SCOPE), false);
  assert.equal(snapshotCovers({}, range), false);
  assert.equal(snapshotCanDisplay({}, DEFAULT_SCOPE), false);
});

test('coverage date summaries reflect actual dated posts and count unknown publication dates', () => {
  const result = postDates([
    { publishedAt:'2026-10-24T12:00:00.000Z' },
    { publishedAt:null },
    { publishedAt:'2026-09-20T12:00:00.000Z' },
    { publishedAt:'invalid' },
  ]);
  assert.deepEqual(result, { oldest:'2026-09-20T12:00:00.000Z', newest:'2026-10-24T12:00:00.000Z', unknownDates:2 });
  assert.deepEqual(postDates([]), { oldest:null, newest:null, unknownDates:0 });
  assert.equal(scopeKey(postsScope(75)), 'posts:75');
  assert.notEqual(scopeKey(postsScope(30)), scopeKey(range));
});

const recentDateSnapshot = {
  requestedMode:'date', from:'2026-06-01T00:00:00.000Z', to:'2026-10-24T18:30:00.000Z',
  snapshotAt:'2026-10-24T13:30:00.000Z', snapshotPosts:110, profilePostCount:180,
  fetched:110, complete:true, hasMore:true, unknownDates:0,
};

test('current date snapshots can serve recent post selections without a second refresh', () => {
  assert.equal(snapshotMatches(recentDateSnapshot, postsScope(30)), false);
  assert.equal(snapshotCovers(recentDateSnapshot, postsScope(30)), true);
  assert.equal(snapshotCanDisplay(recentDateSnapshot, postsScope(30)), true);
  assert.equal(snapshotCovers(recentDateSnapshot, postsScope(110)), true);
  assert.equal(snapshotCovers(recentDateSnapshot, postsScope(150)), false);
  assert.equal(snapshotCanDisplay(recentDateSnapshot, postsScope(150)), true, 'fewer cached posts remain useful as partial data');
});

test('historical date windows never masquerade as the latest posts', () => {
  const historical = { ...recentDateSnapshot, to:'2026-09-30T18:30:00.000Z', hasMore:false };
  assert.equal(snapshotCovers(historical, postsScope(30)), false);
  assert.equal(snapshotCanDisplay(historical, postsScope(30)), false);
  for(const patch of [{snapshotAt:null},{snapshotAt:'invalid'},{to:'invalid'},{from:'invalid'},{from:'2026-10-25T00:00:00.000Z'}]){
    assert.equal(snapshotCovers({...recentDateSnapshot,...patch}, postsScope(30)), false);
    assert.equal(snapshotCanDisplay({...recentDateSnapshot,...patch}, postsScope(30)), false);
  }
});

test('exhausting a filtered date feed is insufficient unless its snapshot accounts for the whole profile', () => {
  const few = {...recentDateSnapshot,snapshotPosts:4,fetched:4,hasMore:false,profilePostCount:4};
  assert.equal(snapshotCovers(few, postsScope(30)), true);
  assert.equal(snapshotCanDisplay(few, postsScope(30)), true);
  for(const profilePostCount of [8,null,undefined,-1,4.5,NaN]){
    const partial={...few,profilePostCount};
    assert.equal(snapshotCovers(partial, postsScope(30)), false);
    assert.equal(snapshotCanDisplay(partial, postsScope(30)), true);
  }
  assert.equal(snapshotCovers({...few,hasMore:true}, postsScope(30)), false);
});

test('incomplete or undated current snapshots are displayable as partial recent-post data', () => {
  for(const patch of [{complete:false},{unknownDates:1}]){
    assert.equal(snapshotCovers({...recentDateSnapshot,...patch}, postsScope(30)), false);
    assert.equal(snapshotCanDisplay({...recentDateSnapshot,...patch}, postsScope(30)), true);
  }
  for(const snapshotPosts of [undefined,-1,NaN,Infinity,1.5]){
    const invalid={...recentDateSnapshot,snapshotPosts};
    assert.equal(snapshotCovers(invalid, postsScope(30)), false);
    assert.equal(snapshotCanDisplay(invalid, postsScope(30)), false);
  }
});

test('only a proven empty profile supplies a complete empty recent-post selection', () => {
  const empty={...recentDateSnapshot,snapshotPosts:0,fetched:0,hasMore:false,profilePostCount:0};
  assert.equal(snapshotCovers(empty, postsScope(30)), true);
  assert.equal(snapshotCanDisplay(empty, postsScope(30)), true);
  for(const patch of [{profilePostCount:null},{profilePostCount:8},{complete:false},{hasMore:true}]){
    assert.equal(snapshotCovers({...empty,...patch}, postsScope(30)), false);
    assert.equal(snapshotCanDisplay({...empty,...patch}, postsScope(30)), false);
  }
});
