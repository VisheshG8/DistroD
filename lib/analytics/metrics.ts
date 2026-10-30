import type { AccountSnapshot, AlertCandidate, AlertCheck, AnalyticsDataset, AnalyticsPage, AnalyticsPost, AnalyzedPost, ComparisonMetrics, ContentStandout, DailyPoint, DateRange, HealthBand, HealthComponent, HealthScore, MetricChange, MetricCoverage, MonthlyChange, MonthlyChangeKey, MonthlyRow, PageAnalysis, PageMetrics, PlatformAnalysis, PostPick, PostSnapshot, RangePreset, StandoutKey, WorkspaceAnalysis, WorkspaceTotals } from './types';

const DAY = 86_400_000;
const INDIA = 330 * 60_000;
/** A snapshot this close to a range boundary counts as recorded at it; cron snapshots never land exactly on IST midnight. */
const EDGE = 36 * 3_600_000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const counter = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const time = (value: string | null | undefined): number => value ? Date.parse(value) : NaN;
const sum = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter(finite);
  if (!known.length) return null;
  const result = known.reduce((a, b) => a + b, 0);
  return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : null;
};
const ratio = (numerator: number | null, denominator: number | null) => numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const clamp = (value: number) => Math.min(100, Math.max(0, value));
const round1 = (value: number) => Math.round(value * 10) / 10;
const asNow = (value?: string | Date) => {
  const result = value instanceof Date ? value.getTime() : value ? Date.parse(value) : Date.now();
  if (!Number.isFinite(result)) throw new Error('Choose a valid observation time.');
  return result;
};

export function indiaDay(value: string | Date = new Date()): string { return new Date(asNow(value) + INDIA).toISOString().slice(0, 10); }
function dayTime(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Choose dates in YYYY-MM-DD format.');
  const value = Date.parse(day + 'T00:00:00.000Z');
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== day) throw new Error('Choose valid calendar dates.');
  return value - INDIA;
}
const dayAt = (value: number) => new Date(value + INDIA).toISOString().slice(0, 10);
const shiftDay = (day: string, days: number) => dayAt(dayTime(day) + days * DAY);
export function normalizeRange(range: DateRange): DateRange {
  if (!range || typeof range.from !== 'string' || typeof range.to !== 'string') throw new Error('Choose a start and end date.');
  if (dayTime(range.from) > dayTime(range.to)) throw new Error('The end date must be on or after the start date.');
  return { from: range.from, to: range.to };
}
export function rangeForPreset(preset: RangePreset, now?: string | Date): DateRange {
  const today = indiaDay(new Date(asNow(now))), first = today.slice(0, 7) + '-01';
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'this-month') return { from: first, to: today };
  if (preset === 'last-month') { const last = shiftDay(first, -1); return { from: last.slice(0, 7) + '-01', to: last }; }
  const days = { '7d': 7, '30d': 30, '90d': 90 }[preset];
  if (!days) throw new Error('Choose a supported date range.');
  return { from: shiftDay(today, 1 - days), to: today };
}
export function previousRange(input: DateRange): DateRange {
  const range = normalizeRange(input), days = (dayTime(range.to) - dayTime(range.from)) / DAY + 1;
  return { from: shiftDay(range.from, -days), to: shiftDay(range.from, -1) };
}
export function median(values: number[]): number | null { return quantile(values, 0.5); }
export function quantile(values: number[], probability: number): number | null {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  const index = (sorted.length - 1) * probability, low = Math.floor(index), fraction = index - low;
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * fraction;
}
export function consistency(values: number[]): number | null {
  const middle = median(values);
  if (middle === null || middle <= 0 || values.length < 2) return null;
  return (quantile(values, 0.75)! - quantile(values, 0.25)!) / middle;
}
/** Predictability 0-100 from the interquartile spread around the median: one viral post moves
 * neither quartile, so it cannot inflate the score (100,110,95,105,102 → 97; 10,20,15,800,12 → 68). */
export function predictability(values: number[]): number | null { const spread = consistency(values); return spread === null ? null : round1(clamp(100 - 60 * spread)); }

function unavailable(total: number, reason: string): MetricCoverage { return { status: 'unavailable', known: 0, total, from: null, to: null, reason, adjustments: 0 }; }
function coverageOf(items: MetricCoverage[], emptyReason = 'No observations are available.'): MetricCoverage {
  if (!items.length) return unavailable(0, emptyReason);
  const known = items.reduce((n, c) => n + c.known, 0), total = items.reduce((n, c) => n + c.total, 0);
  const available = items.filter(c => c.known > 0);
  if (!available.length) return unavailable(total, items[0]?.reason || emptyReason);
  const starts = available.map(c => time(c.from)).filter(Number.isFinite), ends = available.map(c => time(c.to)).filter(Number.isFinite);
  const complete = items.every(c => c.status === 'complete');
  return { status: complete ? 'complete' : 'partial', known, total,
    from: starts.length ? new Date(Math.min(...starts)).toISOString() : null, to: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    reason: complete ? 'Recorded at or near both range boundaries.' : 'Observed changes only; missing boundaries or posts are not estimated.',
    adjustments: items.reduce((n, c) => n + c.adjustments, 0) };
}

type Observation = { at: number; value: number };
type Delta = { value: number | null; coverage: MetricCoverage; points: { at: number; value: number }[] };
/** anchor < start measures one slice (a month) of a wider range: the last observation at or before start,
 * not earlier than anchor, is the slice baseline, so slices of one range add up to the range-wide change. */
function measuredDelta(observations: Observation[], start: number, end: number, published?: number, anchor = start): Delta {
  const relevant = observations.filter(o => o.at >= anchor && o.at <= end).sort((a, b) => a.at - b.at);
  const unique = relevant.filter((o, i) => i === relevant.length - 1 || o.at !== relevant[i + 1].at);
  // A post born in the range has a real zero baseline at publication. An old post does not.
  const born = published !== undefined && Number.isFinite(published) && published >= anchor && published <= end;
  const newPost = born && published! >= start;
  const usable = unique.filter(o => !born || o.at >= published!);
  const sliced = anchor < start, inside = sliced ? usable.filter(o => o.at > start) : usable;
  const before = sliced ? usable.filter(o => o.at <= start).at(-1) ?? (born ? { at: published!, value: 0 } : null) : null;
  if ((!newPost && !before && inside.length < 2) || !inside.length) return { value: null, coverage: unavailable(1, 'Not enough snapshots inside this range. History starts when tracking begins.'), points: [] };
  const first = newPost ? { at: published!, value: 0 } : before || inside[0], last = inside[inside.length - 1];
  const pairs = newPost || before ? inside : inside.slice(1);
  let previous = first;
  const points = pairs.map(current => { const value = current.value - previous.value; previous = current; return { at: current.at, value }; });
  const value = last.value - first.value;
  const adjustments = points.filter(point => point.value < 0).length;
  const complete = (newPost || Math.abs(first.at - start) <= EDGE) && end - last.at <= EDGE;
  return { value, points, coverage: { status: complete ? 'complete' : 'partial', known: 1, total: 1,
    from: new Date(first.at).toISOString(), to: new Date(last.at).toISOString(), adjustments,
    reason: adjustments ? 'Recorded counter decreases are included as corrections.' : complete ? 'Recorded at or near both range boundaries.' : 'Change between available snapshots only; the uncovered part of the range is not estimated.' } };
}

/** Current monthly rates are prorated by each calendar month, never a fixed 30 days. */
export function proratedPay(monthlyPay: number | null, range: DateRange, startDate: string | null = null, now?: string | Date, endDate: string | null = null): number | null {
  if (monthlyPay === null || !Number.isFinite(monthlyPay) || monthlyPay < 0) return null;
  normalizeRange(range);
  const last = Math.min(dayTime(range.to) + DAY, dayTime(indiaDay(new Date(asNow(now)))) + DAY, endDate ? dayTime(endDate) + DAY : Infinity);
  let first = Math.max(dayTime(range.from), startDate ? dayTime(startDate) : -Infinity), result = 0;
  if (first >= last) return 0;
  while (first < last) {
    const calendar = new Date(first + INDIA), year = calendar.getUTCFullYear(), month = calendar.getUTCMonth();
    const next = Date.UTC(year, month + 1, 1) - INDIA;
    const monthDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const days = (Math.min(last, next) - first) / DAY;
    result += monthlyPay * days / monthDays; first = next;
  }
  return roundMoney(result);
}

function engagement(values: Pick<PostSnapshot, 'views' | 'likes' | 'comments' | 'shares'>[]): number | null {
  let numerator = 0, denominator = 0, known = 0;
  for (const item of values) {
    if (!counter(item.views) || item.views <= 0) continue;
    const fields = [item.likes, item.comments, item.shares].filter(counter);
    if (!fields.length) continue;
    numerator += fields.reduce((a, b) => a + b, 0); denominator += item.views; known++;
  }
  return known && denominator > 0 ? numerator / denominator : null;
}
function snapshotsFor(post: AnalyticsPost, snapshots: PostSnapshot[], page: AnalyticsPage, now: number): PostSnapshot[] {
  const list = snapshots.filter(s => s.pageId === page.id && s.postId === post.id && Number.isFinite(time(s.observedAt)) && time(s.observedAt) <= now);
  // Cumulative saved posts may be older than the page refresh. Only a post's own
  // observation timestamp can supply a current observation after snapshot retention.
  if (post.observedAt && time(post.observedAt) <= now && !list.some(s => s.observedAt === post.observedAt)) list.push({ pageId: page.id, postId: post.id, observedAt: post.observedAt, views: post.views, likes: post.likes, comments: post.comments, shares: post.shares, saves: post.saves });
  return list.sort((a, b) => time(a.observedAt) - time(b.observedAt));
}
function fixedAge(post: AnalyticsPost, snapshots: PostSnapshot[], now: number): PostSnapshot | null {
  const published = time(post.publishedAt);
  if (!Number.isFinite(published) || now - published < 7 * DAY) return null;
  return snapshots.find(s => { const age = time(s.observedAt) - published; return age >= 7 * DAY && age <= 8 * DAY && counter(s.views); }) || null;
}
type PreparedPage = { now: number; sourcePosts: AnalyticsPost[]; fixed: Map<string, PostSnapshot>; views: Map<string, Observation[]>; observations: Observation[] };
type SnapshotIndex = { posts: Map<string, Map<string, PostSnapshot[]>>; accounts: Map<string, AccountSnapshot[]>; prepared: Map<AnalyticsPage, PreparedPage> };
function indexSnapshots(dataset: AnalyticsDataset): SnapshotIndex {
  const posts = new Map<string, Map<string, PostSnapshot[]>>(), accounts = new Map<string, AccountSnapshot[]>();
  for (const snapshot of dataset.postSnapshots) {
    if (!posts.has(snapshot.pageId)) posts.set(snapshot.pageId, new Map());
    const page = posts.get(snapshot.pageId)!;
    if (!page.has(snapshot.postId)) page.set(snapshot.postId, []);
    page.get(snapshot.postId)!.push(snapshot);
  }
  for (const snapshot of dataset.accountSnapshots) {
    if (!accounts.has(snapshot.pageId)) accounts.set(snapshot.pageId, []);
    accounts.get(snapshot.pageId)!.push(snapshot);
  }
  return { posts, accounts, prepared: new Map() };
}
function preparePage(page: AnalyticsPage, index: SnapshotIndex, now: number): PreparedPage {
  const cached = index.prepared.get(page);
  if (cached?.now === now) return cached;
  const seen = new Set<string>();
  const sourcePosts = page.posts.filter(post => { if (seen.has(post.id)) return false; seen.add(post.id); return true; });
  const snapshots = index.posts.get(page.id), fixed = new Map<string, PostSnapshot>(), views = new Map<string, Observation[]>();
  for (const post of sourcePosts) {
    const samples = snapshotsFor(post, snapshots?.get(post.id) || [], page, now), age = fixedAge(post, samples, now);
    if (age) fixed.set(post.id, age);
    views.set(post.id, samples.filter(s => counter(s.views)).map(s => ({ at: time(s.observedAt), value: s.views! })));
  }
  const observations = (index.accounts.get(page.id) || []).filter(s => counter(s.followers) && time(s.observedAt) <= now).map(s => ({ at: time(s.observedAt), value: s.followers! }));
  if (counter(page.followers) && page.lastSyncedAt && time(page.lastSyncedAt) <= now && !observations.some(o => o.at === time(page.lastSyncedAt))) observations.push({ at: time(page.lastSyncedAt), value: page.followers });
  observations.sort((a, b) => a.at - b.at);
  const prepared = { now, sourcePosts, fixed, views, observations };
  index.prepared.set(page, prepared);
  return prepared;
}
function dayRows(range: DateRange, now: number): { date: string; from: number; to: number }[] {
  const start = dayTime(range.from), end = Math.min(dayTime(range.to) + DAY, now);
  const monthly = (end - start) / DAY > 366;
  const result = [];
  for (let cursor = start; cursor <= end && cursor < dayTime(range.to) + DAY;) {
    const next = monthly ? Date.UTC(new Date(cursor + INDIA).getUTCFullYear(), new Date(cursor + INDIA).getUTCMonth() + 1, 1) - INDIA : cursor + DAY;
    result.push({ date: dayAt(cursor), from: cursor, to: Math.min(next, end) }); cursor = next;
  }
  return result;
}

/** Inactive pages are paid only through their end date; with no end date they count no pay at all. */
function pagePay(page: AnalyticsPage, range: DateRange, now: number): number | null {
  if (page.monthlyPay === null || page.monthlyPay === undefined) return null;
  if (!page.active && !page.endDate) return proratedPay(page.monthlyPay, range, page.startDate, new Date(now)) === null ? null : 0;
  return proratedPay(page.monthlyPay, range, page.startDate, new Date(now), page.active ? null : page.endDate);
}
const interactions = (item: Pick<AnalyticsPost, 'likes' | 'comments' | 'shares' | 'saves'>) => sum([item.likes, item.comments, item.shares, item.saves].filter(counter));
const rateOf = (part: number | null | undefined, views: number | null | undefined) => counter(part) && counter(views) && views > 0 ? part / views : null;
/** Highest or lowest post on one metric: day-7 values first, else latest counters (maturing posts never count as weakest). */
function pickPost(posts: AnalyzedPost[], fixedValue: (post: AnalyzedPost) => number | null, latestValue: ((post: AnalyzedPost) => number | null) | null, lowest: boolean): PostPick | null {
  const order = (a: { post: AnalyzedPost; value: number }, b: { post: AnalyzedPost; value: number }) => (lowest ? a.value - b.value : b.value - a.value) || a.post.id.localeCompare(b.post.id);
  const fixedRows = posts.map(post => ({ post, value: fixedValue(post) })).filter((row): row is { post: AnalyzedPost; value: number } => finite(row.value)).sort(order);
  if (fixedRows.length) return { ...fixedRows[0], basis: 'day-7' };
  if (!latestValue) return null;
  const latestRows = posts.filter(post => !lowest || post.ageDays !== null && !post.maturing).map(post => ({ post, value: latestValue(post) })).filter((row): row is { post: AnalyzedPost; value: number } => finite(row.value)).sort(order);
  return latestRows.length ? { ...latestRows[0], basis: 'latest' } : null;
}
const latestViews = (post: AnalyzedPost) => counter(post.views) ? post.views : null;

function pageAnalysis(page: AnalyticsPage, dataset: AnalyticsDataset, range: DateRange, now: number, includeTimeline = true, index = indexSnapshots(dataset), anchorDay?: string): PageAnalysis {
  const start = dayTime(range.from), requestedEnd = dayTime(range.to) + DAY, end = Math.min(requestedEnd, now);
  const anchor = anchorDay ? Math.min(dayTime(anchorDay), start) : start;
  const days = Math.max(0, (dayTime(range.to) - start) / DAY + 1);
  const { sourcePosts, fixed, views, observations } = preparePage(page, index, now);
  const deltas = new Map<string, Delta>();
  for (const post of sourcePosts) {
    const published = time(post.publishedAt);
    if (!Number.isFinite(published) || published < requestedEnd && published <= now) deltas.set(post.id, measuredDelta(views.get(post.id)!, start, end, published, anchor));
  }
  const publishedPosts = sourcePosts.filter(post => { const value = time(post.publishedAt); return value >= start && value < requestedEnd && value <= now; });
  const comparable = publishedPosts.filter(post => fixed.has(post.id));
  const matured = publishedPosts.filter(post => Number.isFinite(time(post.publishedAt)) && now - time(post.publishedAt) >= 7 * DAY);
  const baseline90 = sourcePosts.filter(post => { const at = time(post.publishedAt); return at >= end - 90 * DAY && at <= end - 7 * DAY && fixed.has(post.id); }).map(post => fixed.get(post.id)!.views!);
  const baseline30 = sourcePosts.filter(post => { const at = time(post.publishedAt); return at >= start - 30 * DAY && at < start && fixed.has(post.id); }).map(post => fixed.get(post.id)!.views!);
  const comparableViews = comparable.map(post => fixed.get(post.id)!.views!);
  const middle = median(comparableViews), base90 = median(baseline90), base30 = median(baseline30);
  const growth = measuredDelta(observations, start, end, undefined, anchor);
  const firstFollowers = observations.find(o => o.at >= start && o.at <= end);
  const endFollowers = observations.filter(o => o.at <= end).at(-1);
  const pay = pagePay(page, range, now);
  const shareViews = publishedPosts.filter(post => counter(post.shares) && counter(post.views) && post.views > 0);
  const engaged = publishedPosts.map(interactions).filter(finite);
  const gains = sum([...deltas.values()].map(d => d.value));
  const viewsCoverage = coverageOf([...deltas.values()].map(d => d.coverage), 'No saved post snapshots are available.');
  if (dataset.historyTruncated && viewsCoverage.status === 'complete') { viewsCoverage.status = 'partial'; viewsCoverage.reason = 'The history response was limited; totals cover only loaded observations.'; }
  const metrics: PageMetrics = {
    viewsGained: gains, viewsCoverage, publishedViews: sum(publishedPosts.map(post => counter(post.views) ? post.views : null)),
    postsPublished: publishedPosts.length, maturedPosts: matured.length, comparablePosts: comparable.length,
    medianViews: middle, averageViews: comparableViews.length ? comparableViews.reduce((a, b) => a + b, 0) / comparableViews.length : null,
    baselineMedian90d: base90, baselineMedian30d: base30, viewsTrend: ratio(middle, base30), iqrSpread: consistency(comparableViews),
    hitRate: base90 !== null && base90 > 0 && comparableViews.length ? comparableViews.filter(value => value >= 0.7 * base90).length / comparableViews.length : null,
    engagementRate: engagement(comparable.map(post => fixed.get(post.id)!)), shares: sum(publishedPosts.map(post => counter(post.shares) ? post.shares : null)),
    followers: endFollowers?.value ?? null, followerGrowth: growth.value, followerGrowthRate: ratio(growth.value, firstFollowers?.value ?? null), followerCoverage: growth.coverage,
    postsPerDay: days ? publishedPosts.length / days : 0, maturedPostsPerDay: days ? matured.length / days : 0, monthlyPay: page.monthlyPay, pay,
    costPerPost: ratio(pay, publishedPosts.length), costPerMillion: gains !== null && gains > 0 && pay !== null ? pay / gains * 1_000_000 : null,
    viewsPerThousand: pay !== null && pay > 0 && gains !== null && gains >= 0 ? gains / pay * 1_000 : null,
    saves: sum(publishedPosts.map(post => counter(post.saves) ? post.saves : null)),
    shareRate: shareViews.length ? shareViews.reduce((n, post) => n + post.shares!, 0) / shareViews.reduce((n, post) => n + post.views!, 0) : null,
    engagementPerPost: engaged.length ? engaged.reduce((a, b) => a + b, 0) / engaged.length : null,
    consistencyScore: predictability(comparableViews), viewsPerPost: ratio(gains, publishedPosts.length),
    costPerThousand: gains !== null && gains > 0 && pay !== null ? pay / gains * 1_000 : null,
  };
  const posts: AnalyzedPost[] = sourcePosts.map(post => {
    const published = time(post.publishedAt), sample = fixed.get(post.id), delta = deltas.get(post.id);
    const ageDays = Number.isFinite(published) && published <= now ? (now - published) / DAY : null;
    return { ...post, pageName: page.name || page.handle, pageHandle: page.handle, pagePlatform: page.platform, pageEditor: page.editor || '',
      typeLabel: contentTypeLabel(page.platform, post.type, post.durationSeconds), fixedAgeShares: counter(sample?.shares) ? sample.shares : null,
      fixedAgeSaves: counter(sample?.saves) ? sample.saves : null, shareRate: sample ? rateOf(sample.shares, sample.views) : null,
      ageDays, maturing: ageDays !== null && ageDays < 7, inRange: published >= start && published < requestedEnd && published <= now,
      fixedAgeViews: sample?.views ?? null, fixedAgeObservedAt: sample?.observedAt ?? null,
      fixedAgeInteractions: sample ? sum([sample.likes, sample.comments, sample.shares].filter(counter)) : null,
      engagementRate: sample ? engagement([sample]) : null, baselineRatio: ratio(sample?.views ?? null, base90),
      viral: !!sample && base90 !== null && base90 > 0 && sample.views! > 5 * base90,
      viewsGained: delta?.value ?? null, viewsCoverage: delta?.coverage ?? unavailable(1, 'This post has no observations in the selected range.') };
  });
  const timeline: DailyPoint[] = [];
  if (includeTimeline) {
    const rows = dayRows(range, now), monthly = (end - start) / DAY > 366;
    const monthKeys = new Map(rows.map(row => [row.date.slice(0, 7), row.date]));
    const buckets = new Map(rows.map(row => [row.date, { views: [] as number[], growth: [] as number[], published: [] as AnalyticsPost[] }]));
    const keyFor = (observed: number) => {
      if (!rows.length || observed < start || observed > end) return null;
      if (observed === end) return rows[rows.length - 1].date;
      const key = dayAt(observed);
      return monthly ? monthKeys.get(key.slice(0, 7)) || null : key;
    };
    for (const delta of deltas.values()) for (const point of delta.points) { const key = keyFor(point.at); if (key) buckets.get(key)?.views.push(point.value); }
    for (const point of growth.points) { const key = keyFor(point.at); if (key) buckets.get(key)?.growth.push(point.value); }
    for (const post of publishedPosts) { const key = keyFor(time(post.publishedAt)); if (key) buckets.get(key)?.published.push(post); }
    let followerIndex = 0, followers: number | null = null;
    for (const row of rows) {
      while (followerIndex < observations.length && observations[followerIndex].at <= row.to) followers = observations[followerIndex++].value;
      const bucket = buckets.get(row.date)!;
      timeline.push({ date: row.date, viewsGained: sum(bucket.views), publishedViews: sum(bucket.published.map(post => counter(post.views) ? post.views : null)), followers, followerGrowth: sum(bucket.growth), postsPublished: bucket.published.length, coverage: bucket.views.length ? 'partial' : 'unavailable' });
    }
  }
  const inRange = posts.filter(post => post.inRange), bestPost = pickPost(inRange, post => post.fixedAgeViews, latestViews, false);
  // The weakest post is only shown when it is a different post from the strongest one.
  const lowest = inRange.length > 1 ? pickPost(inRange, post => post.fixedAgeViews, latestViews, true) : null, worstPost = lowest && lowest.post.id !== bestPost?.post.id ? lowest : null;
  return { page, metrics, posts, timeline, health: { score: null, reason: 'Insufficient comparable data.', peerCount: 0, components: [], band: 'pending', code: 'few-posts', provisional: false, basis: null, window: null },
    bestPost, worstPost, costEfficiency: null, distributionScore: null };
}

/** Page health 0-100 with the spec weights 30/20/15/15/10/10. Each component has an absolute scale on which 70 is a
 * healthy page: views trend against the page's own prior 30 days (1.0x → 70, ±6 per 0.1x), day-7 median views
 * (20·log10: 1K → 60, 10K → 80, 100K → 100), engagement (4% → 70), follower growth per 30 recorded days (0% → 50, +1% → 70;
 * needs 3+ days between follower snapshots), consistency (predictability) and posts published (4 a week → 70); ratio
 * scales move 30 points per doubling.
 * With two or more active same-platform peers each component is the mean of its absolute score and a peer score
 * (70 at the peer median), so a lone page still scores and two peers never split into 85/15. Health needs
 * 5 posts observed at day 7; short or young ranges use a trailing matured window of at least 30 days. A missing
 * component is dropped and the rest rescaled (provisional) while at least half of the weight remains.
 * Bands: 80+ good (green), 50-79 watch (yellow), below 50 low (red). */
const HEALTH_POSTS = 5;
const ladder = (value: number, reference: number): number | null => !(reference > 0) ? null : value > 0 ? 70 + 30 * Math.log2(value / reference) : 0;
type ScoreBasis = { metrics: PageMetrics; basis: 'range' | 'matured-window'; window: DateRange };
const componentDefinitions: { key: HealthComponent['key']; label: string; weight: number; read: (metrics: PageMetrics) => number | null; absolute: (value: number) => number | null; peer: (value: number, reference: number) => number | null }[] = [
  { key: 'trend', label: 'Views performance (vs prior 30 days)', weight: 30, read: m => m.viewsTrend, absolute: v => 70 + 60 * (v - 1), peer: (v, ref) => 70 + 60 * (v - ref) },
  { key: 'median', label: 'Views per post (day-7 median)', weight: 20, read: m => m.medianViews, absolute: v => v > 0 ? 20 * Math.log10(v) : 0, peer: ladder },
  { key: 'engagement', label: 'Engagement', weight: 15, read: m => m.engagementRate, absolute: v => ladder(v, 0.04), peer: ladder },
  { key: 'growth', label: 'Follower growth', weight: 15, read: m => { const span = (time(m.followerCoverage.to) - time(m.followerCoverage.from)) / DAY; return m.followerGrowthRate === null || !(span >= 3) ? null : m.followerGrowthRate * 30 / span; }, absolute: v => 50 + 2000 * v, peer: (v, ref) => 70 + 2000 * (v - ref) },
  { key: 'consistency', label: 'Consistency', weight: 10, read: m => m.consistencyScore, absolute: v => v, peer: (v, ref) => 70 + v - ref },
  { key: 'activity', label: 'Posting activity', weight: 10, read: m => m.postsPerDay, absolute: v => ladder(v, 4 / 7), peer: ladder },
];
export function healthBand(score: number | null | undefined): HealthBand { return typeof score !== 'number' || !Number.isFinite(score) ? 'pending' : score >= 80 ? 'good' : score >= 50 ? 'watch' : 'low'; }
const rangeDays = (range: DateRange) => (dayTime(range.to) - dayTime(range.from)) / DAY + 1;
function healthBasis(row: PageAnalysis, dataset: AnalyticsDataset, range: DateRange, now: number, index: SnapshotIndex): ScoreBasis {
  const days = rangeDays(range);
  if (row.metrics.comparablePosts >= HEALTH_POSTS) return { metrics: row.metrics, basis: 'range', window: range };
  // Posts need seven days to mature, so Today and 7-day ranges are scored on the latest matured weeks instead.
  const matured = indiaDay(new Date(now - 7 * DAY)), to = range.to < matured ? range.to : matured, length = Math.max(days, 30);
  const window = { from: shiftDay(to, 1 - length), to };
  if (window.from === range.from && window.to === range.to) return { metrics: row.metrics, basis: 'range', window: range };
  return { metrics: pageAnalysis(row.page, dataset, window, now, false, index).metrics, basis: 'matured-window', window };
}
function scorePages(pages: PageAnalysis[], dataset: AnalyticsDataset, range: DateRange, now: number, index: SnapshotIndex): void {
  const bases = new Map(pages.map(row => [row, healthBasis(row, dataset, range, now, index)]));
  for (const row of pages) {
    const own = bases.get(row)!, eligible = own.metrics.comparablePosts >= HEALTH_POSTS;
    // Inactive pages are scored but never set the bar for active pages.
    const peers = pages.filter(peer => peer.page.active && peer.page.platform === row.page.platform && bases.get(peer)!.metrics.comparablePosts >= HEALTH_POSTS);
    const included = peers.includes(row);
    const components: HealthComponent[] = componentDefinitions.map(definition => {
      const value = definition.read(own.metrics);
      const values = peers.map(peer => definition.read(bases.get(peer)!.metrics)).filter(finite);
      let percentile: number | null = null, score: number | null = null;
      if (eligible && value !== null) {
        const absolute = definition.absolute(value), relative = values.length >= 2 ? definition.peer(value, median(values)!) : null;
        score = absolute === null || !Number.isFinite(absolute) ? null : round1(clamp(relative === null || !Number.isFinite(relative) ? absolute : (absolute + relative) / 2));
        if (values.length >= 2) {
          const less = values.filter(other => other < value).length, equal = values.filter(other => other === value).length;
          percentile = included ? (less + (equal - 1) / 2) / (values.length - 1) * 100 : (less + equal / 2) / values.length * 100;
        }
      }
      return { key: definition.key, label: definition.label, weight: definition.weight, value, score, percentile, points: score === null ? null : score * definition.weight / 100 };
    });
    const missing = components.filter(component => component.points === null), weight = components.reduce((n, component) => n + (component.points === null ? 0 : component.weight), 0);
    const score = eligible && weight >= 50 ? Math.round(components.reduce((n, component) => n + (component.points ?? 0), 0) * 100 / weight) : null;
    const provisional = score !== null && missing.length > 0, gaps = missing.map(c => c.label.toLowerCase()).join(', ');
    const window = own.basis === 'matured-window' ? ` Based on posts published ${own.window.from} to ${own.window.to}.` : '';
    row.health = { score, band: healthBand(score), code: !eligible ? 'few-posts' : score === null ? 'missing' : provisional ? 'provisional' : 'scored', provisional,
      basis: eligible ? own.basis : null, window: eligible ? own.window : null, peerCount: peers.length, components,
      reason: !eligible ? `Needs ${HEALTH_POSTS} matured posts: at least ${HEALTH_POSTS} posts observed at 7–8 days old in this range or its trailing matured window.`
        : score === null ? 'Not enough history for: ' + gaps + '.'
        : (provisional ? 'Provisional; not enough history for ' + gaps + ', so the other weights are rescaled. ' : '') + (peers.length >= 2 ? `Absolute scale blended with ${peers.length} active pages on this platform.` : 'Absolute scale; no active peers on this platform to compare with.') + window };
  }
}
/** Distribution score ranks pages: 75% health + 25% cost efficiency. Cost efficiency puts views per ₹1,000 on the
 * health scale (200,000 views per ₹1,000, i.e. ₹5 per 1K views → 70, +30 per doubling), blended with the active
 * same-platform median when two or more pages have it. Without pay or recorded views the score is health alone. */
function distributionScores(pages: PageAnalysis[]): void {
  for (const row of pages) {
    const value = row.metrics.viewsPerThousand;
    const values = pages.filter(peer => peer.page.active && peer.page.platform === row.page.platform).map(peer => peer.metrics.viewsPerThousand).filter(finite);
    const absolute = value === null ? null : ladder(value, 200_000), relative = value !== null && values.length >= 2 ? ladder(value, median(values)!) : null;
    row.costEfficiency = absolute === null ? null : round1(clamp(relative === null ? absolute : (absolute + relative) / 2));
    row.distributionScore = row.health.score === null ? null : row.costEfficiency === null ? row.health.score : Math.round(0.75 * row.health.score + 0.25 * row.costEfficiency);
  }
}

function totalsFor(pages: PageAnalysis[], alerts: AnalyticsDataset['alerts']): WorkspaceTotals {
  const platforms = new Set(pages.map(page => page.page.platform));
  const allFixed = pages.flatMap(page => page.posts.filter(post => post.inRange && post.fixedAgeViews !== null));
  const gains = sum(pages.map(page => page.metrics.viewsGained)), pay = sum(pages.map(page => page.metrics.pay));
  const posts = pages.reduce((n, page) => n + page.metrics.postsPublished, 0);
  const comparableCounts = pages.reduce((n, page) => n + page.metrics.comparablePosts, 0);
  const engagementPosts = allFixed.filter(post => post.fixedAgeInteractions !== null && post.fixedAgeViews! > 0);
  // Cost ratios use only pages that are paid in these dates, so one page without pay never blanks the workspace.
  // A page set to ₹0 a month counts as free; one with pay that has not started (or has ended) in these dates is left out.
  const paid = pages.filter(page => page.metrics.pay !== null && (page.metrics.pay > 0 || page.page.active && page.page.monthlyPay === 0)), viewPaid = paid.filter(page => page.metrics.viewsGained !== null);
  const paidPay = sum(paid.map(page => page.metrics.pay)), viewPay = sum(viewPaid.map(page => page.metrics.pay)), paidViews = sum(viewPaid.map(page => page.metrics.viewsGained));
  const paidPosts = paid.reduce((n, page) => n + page.metrics.postsPublished, 0);
  const shared = pages.flatMap(page => page.posts.filter(post => post.inRange && counter(post.shares) && counter(post.views) && post.views > 0));
  const attention = new Set(alerts.filter(alert => !alert.resolvedAt && alert.level !== 'green').map(alert => alert.pageId));
  return { pages: pages.length, activePages: pages.filter(page => page.page.active).length, attentionPages: pages.filter(page => attention.has(page.page.id) || !!page.page.syncError).length,
    viewsGained: gains, viewsCoverage: coverageOf(pages.map(page => page.metrics.viewsCoverage)), publishedViews: sum(pages.map(page => page.metrics.publishedViews)), postsPublished: posts,
    maturedPosts: pages.reduce((n, page) => n + page.metrics.maturedPosts, 0), comparablePosts: comparableCounts,
    medianViews: platforms.size === 1 ? median(allFixed.map(post => post.fixedAgeViews!)) : null,
    averageViews: platforms.size === 1 && allFixed.length ? allFixed.reduce((n, post) => n + post.fixedAgeViews!, 0) / allFixed.length : null,
    engagementRate: platforms.size === 1 && engagementPosts.length ? engagementPosts.reduce((n, post) => n + post.fixedAgeInteractions!, 0) / engagementPosts.reduce((n, post) => n + post.fixedAgeViews!, 0) : null,
    shares: sum(pages.map(page => page.metrics.shares)), followers: sum(pages.map(page => page.metrics.followers)), followerGrowth: sum(pages.map(page => page.metrics.followerGrowth)), followerCoverage: coverageOf(pages.map(page => page.metrics.followerCoverage)),
    monthlyPay: sum(pages.filter(page => page.page.active).map(page => page.metrics.monthlyPay)), pay, payKnownPages: pages.filter(page => page.metrics.pay !== null).length,
    costPerMillion: viewPay !== null && paidViews !== null && paidViews > 0 ? viewPay / paidViews * 1_000_000 : null,
    costPerThousand: viewPay !== null && paidViews !== null && paidViews > 0 ? viewPay / paidViews * 1_000 : null,
    costPerPost: ratio(paidPay, paidPosts),
    viewsPerThousand: viewPay !== null && viewPay > 0 && paidViews !== null && paidViews >= 0 ? paidViews / viewPay * 1_000 : null,
    costPages: paid.length, costViewPages: viewPaid.length, inactivePages: pages.filter(page => !page.page.active).length,
    saves: sum(pages.map(page => page.metrics.saves)), shareRate: shared.length ? shared.reduce((n, post) => n + post.shares!, 0) / shared.reduce((n, post) => n + post.views!, 0) : null, viewsPerPost: ratio(gains, posts),
    mixedPlatforms: platforms.size > 1 };
}

const change = (a: number | null, b: number | null): MetricChange => ({ current: a, previous: b, difference: a !== null && b !== null ? a - b : null, percent: a !== null && b !== null && b !== 0 ? (a - b) / Math.abs(b) : null });
function changes(current: PageMetrics | WorkspaceTotals, previous: PageMetrics | WorkspaceTotals): ComparisonMetrics {
  return { viewsGained: change(current.viewsGained, previous.viewsGained), pay: change(current.pay, previous.pay), postsPublished: change(current.postsPublished, previous.postsPublished), costPerMillion: change(current.costPerMillion, previous.costPerMillion), medianViews: change(current.medianViews, previous.medianViews), engagementRate: change(current.engagementRate, previous.engagementRate), followerGrowth: change(current.followerGrowth, previous.followerGrowth) };
}
function verdict(current: WorkspaceTotals, previous: WorkspaceTotals): string {
  if (current.viewsCoverage.status !== 'complete' || previous.viewsCoverage.status !== 'complete' || current.payKnownPages !== current.pages || previous.payKnownPages !== previous.pages) return 'A reliable spend-versus-growth verdict needs complete observation boundaries and pay for every page in both ranges.';
  if (current.pay === null || previous.pay === null || previous.pay <= 0 || current.viewsGained === null || previous.viewsGained === null || previous.viewsGained <= 0) return 'There is not enough comparable spend and view history for a verdict.';
  const spend = current.pay / previous.pay, views = current.viewsGained / previous.viewsGained;
  if (spend > 1) return views > spend ? 'Views grew faster than spend.' : views < spend ? 'Spend grew faster than views.' : 'Views and spend grew at the same rate.';
  if (current.costPerMillion !== null && previous.costPerMillion !== null) return current.costPerMillion < previous.costPerMillion ? 'Cost per million views improved.' : current.costPerMillion > previous.costPerMillion ? 'Cost per million views increased.' : 'Cost per million views stayed the same.';
  return 'Compare the recorded ranges after more observations are available.';
}
const monthEnd = (day: string) => { const date = new Date(dayTime(day) + INDIA); return dayAt(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - INDIA - DAY); };
const fullMonth = (range: DateRange) => range.from.endsWith('-01') && range.to === monthEnd(range.from);
/** The same day span one month earlier, for a fair month-to-date comparison (1-29 Oct → 1-29 Sep, 1-31 Mar → 1-28 Feb). */
export function sameDaysPreviousMonth(input: DateRange): DateRange {
  const range = normalizeRange(input), first = shiftDay(range.from.slice(0, 7) + '-01', -1).slice(0, 7) + '-01', last = monthEnd(first);
  const same = (value: string) => { const day = shiftDay(first, Number(value.slice(8)) - 1); return day < last ? day : last; };
  return { from: same(range.from), to: range.to.slice(0, 7) === range.from.slice(0, 7) ? same(range.to) : last };
}
const monthlyKeys: MonthlyChangeKey[] = ['pay', 'views', 'posts', 'costPerThousand', 'viewsPerPost'];
const monthlyValue = (totals: WorkspaceTotals, key: MonthlyChangeKey) => key === 'views' ? totals.viewsGained : key === 'posts' ? totals.postsPublished : totals[key];
/** Month-over-month change for Total Pay, Total Views, Total Posts, Cost per 1K views and Avg views per post
 * (views gained ÷ posts). A month-to-date row compares with the same days of the previous month when available. */
export function monthlyChanges(rows: MonthlyRow[]): (MonthlyChange | null)[] {
  return rows.map((row, i) => {
    const previous = row.sameDays ? { range: row.sameDays.range, totals: row.sameDays.totals, partial: false } : i ? { range: rows[i - 1].range, totals: rows[i - 1].totals, partial: !fullMonth(rows[i - 1].range) } : null;
    if (!previous) return null;
    return { month: row.month, against: row.sameDays ? 'same-days' : 'previous-month', range: previous.range, partial: previous.partial || !row.sameDays && !fullMonth(row.range),
      metrics: Object.fromEntries(monthlyKeys.map(key => [key, change(monthlyValue(row.totals, key), monthlyValue(previous.totals, key))])) as Record<MonthlyChangeKey, MetricChange> };
  });
}
function monthRanges(range: DateRange): DateRange[] {
  const result: DateRange[] = [];
  let cursor = range.from;
  while (cursor <= range.to) {
    const date = new Date(dayTime(cursor) + INDIA), next = dayAt(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - INDIA);
    result.push({ from: cursor, to: shiftDay(next, -1) < range.to ? shiftDay(next, -1) : range.to }); cursor = next;
  }
  return result;
}

/** Compute peer scores once for the full owner workspace, independently of UI filters. */
export function calculateHealthScores(dataset: AnalyticsDataset, input: DateRange, nowInput?: string | Date): Record<string, HealthScore> {
  const range = normalizeRange(input), now = asNow(nowInput || dataset.generatedAt), index = indexSnapshots(dataset);
  const unique = new Map(dataset.pages.map(page => [page.id, page]));
  const pages = [...unique.values()].map(page => pageAnalysis(page, dataset, range, now, false, index));
  scorePages(pages, dataset, range, now, index);
  return Object.fromEntries(pages.map(page => [page.page.id, page.health]));
}

export function calculateWorkspace(dataset: AnalyticsDataset, input: DateRange, comparisonRange?: DateRange | null, nowInput?: string | Date, peerScores?: Record<string, HealthScore>): WorkspaceAnalysis {
  return calculateWithIndex(dataset, input, comparisonRange, nowInput, peerScores, indexSnapshots(dataset));
}

/** Reuse prepared history while filtering one immutable, fully loaded owner dataset.
 * Create a new calculator whenever the dataset is replaced after a load or edit. */
export function createWorkspaceCalculator(dataset: AnalyticsDataset) {
  const index = indexSnapshots(dataset);
  return (input: DateRange, comparisonRange?: DateRange | null, nowInput?: string | Date, peerScores?: Record<string, HealthScore>, pageIds?: ReadonlySet<string>): WorkspaceAnalysis =>
    calculateWithIndex(pageIds ? { ...dataset, pages: dataset.pages.filter(page => pageIds.has(page.id)) } : dataset, input, comparisonRange, nowInput, peerScores, index);
}

function calculateWithIndex(dataset: AnalyticsDataset, input: DateRange, comparisonRange: DateRange | null | undefined, nowInput: string | Date | undefined, peerScores: Record<string, HealthScore> | undefined, index: SnapshotIndex): WorkspaceAnalysis {
  const range = normalizeRange(input), now = asNow(nowInput || dataset.generatedAt), compareRange = comparisonRange ? normalizeRange(comparisonRange) : null;
  const seen = new Set<string>();
  const source = dataset.pages.filter(page => { if (seen.has(page.id)) return false; seen.add(page.id); return true; });
  const pages = source.map(page => pageAnalysis(page, dataset, range, now, true, index));
  scorePages(pages, dataset, range, now, index);
  if (peerScores) for (const page of pages) if (Object.hasOwn(peerScores, page.page.id)) page.health = peerScores[page.page.id];
  distributionScores(pages);
  const alerts = dataset.alerts.filter(alert => !alert.resolvedAt && seen.has(alert.pageId));
  const totals = totalsFor(pages, alerts);
  const platforms: PlatformAnalysis[] = (['instagram', 'tiktok', 'youtube'] as const).filter(platform => pages.some(page => page.page.platform === platform)).map(platform => {
    const peers = pages.filter(page => page.page.platform === platform);
    const rankings = [...peers].sort((a, b) => (b.distributionScore ?? -1) - (a.distributionScore ?? -1) || (b.health.score ?? -1) - (a.health.score ?? -1) || (b.metrics.medianViews ?? -1) - (a.metrics.medianViews ?? -1) || a.page.id.localeCompare(b.page.id));
    // Before any post reaches day 7 (Today, 7 days) the best post falls back to its latest views, labelled by basis.
    const best = pickPost(peers.flatMap(page => page.posts).filter(post => post.inRange), post => post.fixedAgeViews, latestViews, false);
    return { platform, totals: totalsFor(peers, alerts), rankings, bestPageId: rankings.find(page => page.health.score !== null || page.metrics.medianViews !== null)?.page.id || null, bestPost: best?.post || null, bestPostBasis: best?.basis || null };
  });
  const timeline = dayRows(range, now).map((day, dayIndex) => {
    // Every page uses the same range and clock, so its timeline has identical day positions.
    const points = pages.map(page => page.timeline[dayIndex]);
    return { date: day.date, viewsGained: sum(points.map(p => p.viewsGained)), publishedViews: sum(points.map(p => p.publishedViews)), followers: sum(points.map(p => p.followers)), followerGrowth: sum(points.map(p => p.followerGrowth)), postsPublished: points.reduce((n, p) => n + p.postsPublished, 0), coverage: points.some(p => p.viewsGained !== null) ? 'partial' as const : 'unavailable' as const };
  });
  // Months share the range-wide history: each month starts from the previous month's last snapshot, so months add up.
  const months = monthRanges(range);
  const monthly: MonthlyRow[] = months.map((month, i) => {
    const rows = source.map(page => pageAnalysis(page, dataset, month, now, false, index, range.from));
    const toDate = i === months.length - 1 && month.from.endsWith('-01') && !fullMonth(month), sameRange = toDate ? sameDaysPreviousMonth(month) : null;
    const sameDays = sameRange ? { range: sameRange, totals: totalsFor(source.map(page => pageAnalysis(page, dataset, sameRange, now, false, index)), alerts) } : null;
    return { month: month.from.slice(0, 7), range: month, totals: totalsFor(rows, alerts), pages: rows.map(page => ({ pageId: page.page.id, metrics: page.metrics })), partial: !fullMonth(month), sameDays, change: null };
  });
  monthlyChanges(monthly).forEach((value, i) => { monthly[i].change = value; });
  let comparison: WorkspaceAnalysis['comparison'] = null;
  if (compareRange) {
    const previous = source.map(page => pageAnalysis(page, dataset, compareRange, now, false, index)), previousTotals = totalsFor(previous, alerts);
    const previousById = new Map(previous.map(page => [page.page.id, page]));
    comparison = { range: compareRange, totals: previousTotals, metrics: changes(totals, previousTotals), pages: pages.map(page => ({ pageId: page.page.id, metrics: changes(page.metrics, previousById.get(page.page.id)!.metrics) })), verdict: verdict(totals, previousTotals) };
  }
  const warnings = ['Growth uses recorded snapshot changes only; tracking cannot recover earlier follower counts.', 'Typical views, engagement, hit rate and health use snapshots captured at 7–8 days of post age.', 'Daily growth points show changes between observations ending on that date, not continuously measured daily views.', 'Costs use the current monthly rate, prorated by calendar days; past rate changes are not reconstructed.', 'Cost ratios use only pages with pay in these dates; inactive pages count pay only through their end date.'];
  if (totals.mixedPlatforms) warnings.push('Rankings, typical views and engagement are separated by platform. Combined view totals are counts, not cross-platform rankings.');
  if (dataset.historyTruncated) warnings.push('Some history could not be loaded. These totals are partial.');
  if ((dayTime(range.to) - dayTime(range.from)) / DAY > 366) warnings.push('The trend chart is grouped by month for this long range.');
  if (pages.some(page => !page.page.lastSyncedAt)) warnings.push('Unrefreshed pages have no observed metrics; post counts include saved posts only.');
  return { range, compareRange, days: (dayTime(range.to) - dayTime(range.from)) / DAY + 1, generatedAt: new Date(now).toISOString(), pages, totals, platforms, timeline, monthly, comparison, alerts, warnings };
}

/** Spec content type names. Providers report video/image/carousel (and short/reel when known); YouTube videos up to 60 s are Shorts. */
export function contentTypeLabel(platform: string | null | undefined, type: string | null | undefined, durationSeconds?: number | null): string {
  const kind = (type || '').toLowerCase();
  if (kind === 'carousel' || kind === 'album' || kind === 'sidecar') return 'Carousel';
  if (kind === 'short' || kind === 'shorts') return 'Short';
  if (kind === 'reel' || kind === 'clips') return 'Reel';
  if (kind === 'image' || kind === 'photo' || kind === 'post') return 'Post';
  if (kind === 'video') return platform === 'instagram' ? 'Reel' : platform === 'youtube' && finite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 60 ? 'Short' : 'Video';
  return platform === 'tiktok' && !kind ? 'Video' : 'Unknown type';
}

// Same definition as day-7 engagement (likes, comments and shares per view), so both bases rank alike.
const latestRate = (post: AnalyzedPost) => engagement([post]);
const standoutDefinitions: { key: StandoutKey; direction: 'highest' | 'lowest'; label: string; fixed: ((post: AnalyzedPost) => number | null) | null; latest: ((post: AnalyzedPost) => number | null) | null; missing: string }[] = [
  { key: 'most-viewed', direction: 'highest', label: 'Highest viewed', fixed: post => post.fixedAgeViews, latest: latestViews, missing: 'No post has views yet.' },
  { key: 'most-shared', direction: 'highest', label: 'Highest shared', fixed: post => post.fixedAgeShares, latest: post => counter(post.shares) ? post.shares : null, missing: 'Shares are not provided publicly for these posts.' },
  { key: 'most-saved', direction: 'highest', label: 'Highest saved', fixed: post => post.fixedAgeSaves, latest: post => counter(post.saves) ? post.saves : null, missing: 'Saves are not provided publicly by Instagram or YouTube.' },
  { key: 'most-engaging', direction: 'highest', label: 'Highest engagement', fixed: post => post.engagementRate, latest: latestRate, missing: 'No post has likes, comments or shares with views.' },
  { key: 'most-followers', direction: 'highest', label: 'Highest follower-gaining', fixed: null, latest: null, missing: 'Public data does not attribute follower gains to individual posts.' },
  { key: 'least-viewed', direction: 'lowest', label: 'Lowest views', fixed: post => post.fixedAgeViews, latest: latestViews, missing: 'No post older than seven days has views yet.' },
  { key: 'least-engaging', direction: 'lowest', label: 'Lowest engagement', fixed: post => post.engagementRate, latest: latestRate, missing: 'No post older than seven days has engagement yet.' },
  { key: 'lowest-share-rate', direction: 'lowest', label: 'Lowest share rate', fixed: post => post.shareRate, latest: post => rateOf(post.shares, post.views), missing: 'Shares are not provided publicly for these posts.' },
  { key: 'below-baseline', direction: 'lowest', label: 'Lowest vs page baseline', fixed: post => post.baselineRatio, latest: null, missing: 'A page baseline needs posts observed at day 7.' },
];
/** Best and worst content on each spec metric. Day-7 values keep posts of different ages fair; when no post has
 * one (Today, 7 days, imported history) the latest counters are used and labelled, and the weakest never includes a maturing post. */
export function contentStandouts(posts: AnalyzedPost[]): ContentStandout[] {
  return standoutDefinitions.map(definition => {
    const pick = definition.fixed ? pickPost(posts, definition.fixed, definition.latest, definition.direction === 'lowest') : null;
    return { key: definition.key, direction: definition.direction, label: definition.label, post: pick?.post || null, value: pick?.value ?? null, basis: pick?.basis || null,
      note: !pick ? definition.missing : pick.basis === 'latest' ? 'No post has reached day 7; latest counts shown.' : 'Measured at 7–8 days old.' };
  });
}

/** Alert thresholds. quietDays is the default for "no post in X days"; a page's alertQuietDays overrides it. */
export const ALERT_RULES = { quietDays: 7, staleDays: 2, weekDrop: 0.7, averageDrop: 0.75, engagementDrop: 0.75, postingDrop: 0.6, belowBaseline: 0.75, upwardTrend: 1.4, viral: 5, minSamples: 3, followerLossShare: 0.005, followerLossCount: 100 } as const;
const quietDaysFor = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 60 ? value : null;
const whole = (value: number) => Math.round(value).toLocaleString('en-IN');
const pct = (value: number) => Math.round(value * 100) + '%';
const shortDay = (value: number) => dayAt(value);

/** Candidates only. Persistence across two separate checks and cooldown belong to the database job. */
export function alertCandidates(dataset: AnalyticsDataset, nowInput?: string | Date, options: { quietDays?: number } = {}): AlertCandidate[] { return alertCheck(dataset, nowInput, options).candidates; }

/** Candidates plus the active pages that could not be checked now (stale, failed or partial refresh): their open alerts must stay open. */
export function alertCheck(dataset: AnalyticsDataset, nowInput?: string | Date, options: { quietDays?: number } = {}): AlertCheck {
  const now = asNow(nowInput || dataset.generatedAt), result: AlertCandidate[] = [], unchecked: AlertCheck['unchecked'] = [];
  const index = indexSnapshots(dataset), defaultQuiet = quietDaysFor(options.quietDays) ?? ALERT_RULES.quietDays;
  for (const page of dataset.pages.filter(page => page.active)) {
    const add = (level: AlertCandidate['level'], type: string, title: string, details: string, suffix = '') => result.push({ pageId: page.id, level, type, title, details, fingerprint: page.id + ':' + type + (suffix ? ':' + suffix : ''), ...(suffix ? { postId: suffix } : {}) });
    if (page.syncError) { add('red', 'data-health', 'Refresh needs attention', 'The latest refresh failed. Retry this page and check its public availability.'); unchecked.push({ pageId: page.id, reason: 'The latest refresh failed.' }); continue; }
    const refreshed = time(page.lastSyncedAt), coverage = page.coverage;
    if (!Number.isFinite(refreshed) || refreshed > now || now - refreshed > ALERT_RULES.staleDays * DAY) { unchecked.push({ pageId: page.id, reason: `Not refreshed in the last ${ALERT_RULES.staleDays} days.` }); continue; }
    // Follower counts need only account snapshots, so they are checked even when the post feed is partial.
    const followers = preparePage(page, index, now).observations, latestCount = followers.at(-1);
    const earlier = latestCount ? followers.filter(o => o.at <= latestCount.at - 7 * DAY).at(-1) : undefined;
    if (latestCount && earlier && latestCount.value < earlier.value) {
      const lost = earlier.value - latestCount.value, share = earlier.value > 0 ? lost / earlier.value : 1;
      if (lost >= ALERT_RULES.followerLossCount || share >= ALERT_RULES.followerLossShare) add('red', 'follower-loss', 'Followers are falling', `Followers fell from ${whole(earlier.value)} to ${whole(latestCount.value)} (−${whole(lost)}, −${(share * 100).toFixed(1)}%) over ${Math.round((latestCount.at - earlier.at) / DAY)} days.`);
    }
    // A historical-only refresh does not prove that the current publishing feed
    // is quiet. Require a complete recent feed or a complete date scope that
    // includes the relevant matured weeks through the current observation.
    const currentFeed = coverage?.complete === true && (coverage.requestedMode === 'posts' || coverage.requestedMode === 'date' && time(coverage.from) <= now - 21 * DAY && time(coverage.to) >= now);
    if (!currentFeed) { unchecked.push({ pageId: page.id, reason: 'The latest refresh did not load a complete recent feed.' }); continue; }
    const all = page.posts.filter(post => Number.isFinite(time(post.publishedAt)) && time(post.publishedAt) <= now);
    const latest = all.map(post => time(post.publishedAt)).sort((a, b) => b - a)[0];
    const firstObservation = (index.accounts.get(page.id) || []).map(s => time(s.observedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const quiet = quietDaysFor(page.alertQuietDays) ?? defaultQuiet;
    // Recent immature posts prevent a false inactivity alert; their metrics never enter performance alerts.
    if (latest !== undefined && now - latest >= quiet * DAY) add('red', 'no-posts', `No post in ${quiet} days`, `The latest post was published ${Math.floor((now - latest) / DAY)} days ago (${shortDay(latest)}). Review the publishing schedule for this page.`);
    else if (latest === undefined && firstObservation !== undefined && now - firstObservation >= quiet * DAY) add('red', 'no-posts', `No post in ${quiet} days`, `No post has been seen since tracking began ${Math.floor((now - firstObservation) / DAY)} days ago. Review the publishing schedule for this page.`);
    const samples = all.map(post => ({ post, fixed: fixedAge(post, snapshotsFor(post, index.posts.get(page.id)?.get(post.id) || [], page, now), now) })).filter(item => !!item.fixed);
    const recent = samples.filter(item => time(item.post.publishedAt) > now - 14 * DAY && time(item.post.publishedAt) <= now - 7 * DAY);
    const previous = samples.filter(item => time(item.post.publishedAt) > now - 21 * DAY && time(item.post.publishedAt) <= now - 14 * DAY);
    const baseline = samples.filter(item => time(item.post.publishedAt) > now - 44 * DAY && time(item.post.publishedAt) <= now - 14 * DAY);
    const baseline90 = samples.filter(item => time(item.post.publishedAt) >= now - 90 * DAY && time(item.post.publishedAt) <= now - 7 * DAY);
    const viewsOf = (items: typeof samples) => items.map(item => item.fixed!.views!), mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const recentMedian = median(viewsOf(recent)), previousMedian = median(viewsOf(previous));
    const base30 = median(viewsOf(baseline)), base90 = median(viewsOf(baseline90));
    if (recentMedian !== null && previousMedian !== null && previousMedian > 0 && recentMedian < ALERT_RULES.weekDrop * previousMedian) add('red', 'median-drop', 'Typical views dropped', `Typical day-7 views fell ${pct(1 - recentMedian / previousMedian)} week over week (${whole(previousMedian)} → ${whole(recentMedian)}), comparing the latest matured week with the week before at the same post age.`);
    const enough = recent.length >= ALERT_RULES.minSamples && baseline.length >= ALERT_RULES.minSamples;
    const recentMean = mean(viewsOf(recent)), baseMean = mean(viewsOf(baseline));
    if (enough && recentMean !== null && baseMean !== null && baseMean > 0 && recentMean < ALERT_RULES.averageDrop * baseMean) add('red', 'average-drop', 'Average views down', `Average day-7 views fell ${pct(1 - recentMean / baseMean)} (${whole(baseMean)} → ${whole(recentMean)}) against the preceding 30-day average.`);
    const recentEngagement = engagement(recent.map(item => item.fixed!)), baseEngagement = engagement(baseline.map(item => item.fixed!));
    if (enough && recentEngagement !== null && baseEngagement !== null && baseEngagement > 0 && recentEngagement < ALERT_RULES.engagementDrop * baseEngagement) add('red', 'engagement-drop', 'Engagement declining', `Day-7 engagement fell from ${(baseEngagement * 100).toFixed(1)}% to ${(recentEngagement * 100).toFixed(1)}% against the preceding 30 days.`);
    const recentPosts = all.filter(post => time(post.publishedAt) > now - 14 * DAY && time(post.publishedAt) <= now - 7 * DAY).length;
    const previousPosts = all.filter(post => time(post.publishedAt) > now - 21 * DAY && time(post.publishedAt) <= now - 14 * DAY).length;
    if (previousPosts && recentPosts <= ALERT_RULES.postingDrop * previousPosts) add('amber', 'posting-drop', 'Publishing has slowed', `${recentPosts} ${recentPosts === 1 ? 'post' : 'posts'} in the latest matured week against ${previousPosts} the week before.`);
    if (recentMedian !== null && base30 !== null && base30 > 0 && recentMedian < ALERT_RULES.belowBaseline * base30) add('amber', 'below-baseline', 'Below the recent baseline', `Typical day-7 views are ${pct(1 - recentMedian / base30)} below the preceding 30-day baseline (${whole(base30)} → ${whole(recentMedian)}).`);
    if (recentMedian !== null && base30 !== null && base30 > 0 && recentMedian > ALERT_RULES.upwardTrend * base30) add('green', 'upward-trend', 'Strong upward trend', `Typical day-7 views are ${(recentMedian / base30).toFixed(1)}× the preceding 30-day baseline (${whole(base30)} → ${whole(recentMedian)}).`);
    // One alert per page is stored, so keep the strongest viral post and name it.
    const viral = base90 !== null && base90 > 0 ? recent.filter(item => item.fixed!.views! > ALERT_RULES.viral * base90).sort((a, b) => b.fixed!.views! - a.fixed!.views! || a.post.id.localeCompare(b.post.id))[0] : undefined;
    if (viral && base90) { const title = viral.post.title.replace(/\s+/g, ' ').trim(); add('green', 'viral-post', 'Viral content detected', `${title ? '“' + (title.length > 60 ? title.slice(0, 57) + '…' : title) + '”, ' : ''}published ${shortDay(time(viral.post.publishedAt))}, reached ${whole(viral.fixed!.views!)} views at day 7: ${(viral.fixed!.views! / base90).toFixed(1)}× the page's 90-day median of ${whole(base90)}.`, viral.post.id); }
  }
  return { candidates: result, unchecked };
}
