import type { AccountSnapshot, AlertCandidate, AnalyticsDataset, AnalyticsPage, AnalyticsPost, AnalyzedPost, ComparisonMetrics, DailyPoint, DateRange, HealthComponent, HealthScore, MetricChange, MetricCoverage, MonthlyRow, PageAnalysis, PageMetrics, PlatformAnalysis, PostSnapshot, RangePreset, WorkspaceAnalysis, WorkspaceTotals } from './types';

const DAY = 86_400_000;
const INDIA = 330 * 60_000;
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
    reason: complete ? 'Recorded at both range boundaries.' : 'Observed changes only; missing boundaries or posts are not estimated.',
    adjustments: items.reduce((n, c) => n + c.adjustments, 0) };
}

type Observation = { at: number; value: number };
type Delta = { value: number | null; coverage: MetricCoverage; points: { at: number; value: number }[] };
function measuredDelta(observations: Observation[], start: number, end: number, published?: number): Delta {
  const relevant = observations.filter(o => o.at >= start && o.at <= end).sort((a, b) => a.at - b.at);
  const unique = relevant.filter((o, i) => i === relevant.length - 1 || o.at !== relevant[i + 1].at);
  // A post born in the range has a real zero baseline at publication. An old post does not.
  const newPost = published !== undefined && Number.isFinite(published) && published >= start && published <= end;
  const usable = unique.filter(o => !newPost || o.at >= published!);
  if ((!newPost && usable.length < 2) || !usable.length) return { value: null, coverage: unavailable(1, 'Not enough snapshots inside this range. History starts when tracking begins.'), points: [] };
  const first = newPost ? { at: published!, value: 0 } : usable[0], last = usable[usable.length - 1];
  const pairs = newPost ? usable : usable.slice(1);
  let previous = first;
  const points = pairs.map(current => { const value = current.value - previous.value; previous = current; return { at: current.at, value }; });
  const value = last.value - first.value;
  const adjustments = points.filter(point => point.value < 0).length;
  const complete = (newPost || first.at === start) && last.at === end;
  return { value, points, coverage: { status: complete ? 'complete' : 'partial', known: 1, total: 1,
    from: new Date(first.at).toISOString(), to: new Date(last.at).toISOString(), adjustments,
    reason: adjustments ? 'Recorded counter decreases are included as corrections.' : complete ? 'Recorded at both range boundaries.' : 'Change between available snapshots only; the uncovered part of the range is not estimated.' } };
}

/** Current monthly rates are prorated by each calendar month, never a fixed 30 days. */
export function proratedPay(monthlyPay: number | null, range: DateRange, startDate: string | null = null, now?: string | Date): number | null {
  if (monthlyPay === null || !Number.isFinite(monthlyPay) || monthlyPay < 0) return null;
  normalizeRange(range);
  const last = Math.min(dayTime(range.to) + DAY, dayTime(indiaDay(new Date(asNow(now)))) + DAY);
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
type SnapshotIndex = { posts: Map<string, Map<string, PostSnapshot[]>>; accounts: Map<string, AccountSnapshot[]> };
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
  return { posts, accounts };
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

function pageAnalysis(page: AnalyticsPage, dataset: AnalyticsDataset, range: DateRange, now: number, includeTimeline = true, index = indexSnapshots(dataset)): PageAnalysis {
  const start = dayTime(range.from), requestedEnd = dayTime(range.to) + DAY, end = Math.min(requestedEnd, now);
  const days = Math.max(0, (dayTime(range.to) - start) / DAY + 1);
  const seen = new Set<string>();
  const sourcePosts = page.posts.filter(post => { if (seen.has(post.id)) return false; seen.add(post.id); return true; });
  const snapshots = index.posts.get(page.id);
  const fixed = new Map<string, PostSnapshot>();
  const deltas = new Map<string, Delta>();
  for (const post of sourcePosts) {
    const samples = snapshotsFor(post, snapshots?.get(post.id) || [], page, now), age = fixedAge(post, samples, now);
    if (age) fixed.set(post.id, age);
    const published = time(post.publishedAt);
    if (!Number.isFinite(published) || published < requestedEnd && published <= now) deltas.set(post.id, measuredDelta(samples.filter(s => counter(s.views)).map(s => ({ at: time(s.observedAt), value: s.views! })), start, end, published));
  }
  const publishedPosts = sourcePosts.filter(post => { const value = time(post.publishedAt); return value >= start && value < requestedEnd && value <= now; });
  const comparable = publishedPosts.filter(post => fixed.has(post.id));
  const matured = publishedPosts.filter(post => Number.isFinite(time(post.publishedAt)) && now - time(post.publishedAt) >= 7 * DAY);
  const baseline90 = sourcePosts.filter(post => { const at = time(post.publishedAt); return at >= end - 90 * DAY && at <= end - 7 * DAY && fixed.has(post.id); }).map(post => fixed.get(post.id)!.views!);
  const baseline30 = sourcePosts.filter(post => { const at = time(post.publishedAt); return at >= start - 30 * DAY && at < start && fixed.has(post.id); }).map(post => fixed.get(post.id)!.views!);
  const comparableViews = comparable.map(post => fixed.get(post.id)!.views!);
  const middle = median(comparableViews), base90 = median(baseline90), base30 = median(baseline30);
  const observations = (index.accounts.get(page.id) || []).filter(s => counter(s.followers) && time(s.observedAt) <= now).map(s => ({ at: time(s.observedAt), value: s.followers! }));
  if (counter(page.followers) && page.lastSyncedAt && time(page.lastSyncedAt) <= now && !observations.some(o => o.at === time(page.lastSyncedAt))) observations.push({ at: time(page.lastSyncedAt), value: page.followers });
  observations.sort((a, b) => a.at - b.at);
  const growth = measuredDelta(observations, start, end);
  const firstFollowers = observations.find(o => o.at >= start && o.at <= end);
  const endFollowers = observations.filter(o => o.at <= end).at(-1);
  const pay = proratedPay(page.monthlyPay, range, page.startDate, new Date(now));
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
  };
  const posts: AnalyzedPost[] = sourcePosts.map(post => {
    const published = time(post.publishedAt), sample = fixed.get(post.id), delta = deltas.get(post.id);
    const ageDays = Number.isFinite(published) && published <= now ? (now - published) / DAY : null;
    return { ...post, pageName: page.name || page.handle, pageHandle: page.handle, pagePlatform: page.platform,
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
  return { page, metrics, posts, timeline, health: { score: null, reason: 'Insufficient comparable data.', peerCount: 0, components: [] } };
}

const componentDefinitions = [
  { key: 'trend', label: 'Views trend', weight: 30, metric: 'viewsTrend', invert: false },
  { key: 'median', label: 'Typical views', weight: 20, metric: 'medianViews', invert: false },
  { key: 'engagement', label: 'Engagement', weight: 15, metric: 'engagementRate', invert: false },
  { key: 'growth', label: 'Follower growth', weight: 15, metric: 'followerGrowthRate', invert: false },
  { key: 'consistency', label: 'Consistency', weight: 10, metric: 'iqrSpread', invert: true },
  { key: 'activity', label: 'Posting activity', weight: 10, metric: 'maturedPostsPerDay', invert: false },
] as const;
function scorePages(pages: PageAnalysis[]): void {
  for (const page of pages) {
    const peers = pages.filter(peer => peer.page.platform === page.page.platform && peer.metrics.comparablePosts >= 8);
    const eligible = page.metrics.comparablePosts >= 8;
    const components: HealthComponent[] = componentDefinitions.map(definition => {
      const value = page.metrics[definition.metric];
      const values = peers.map(peer => peer.metrics[definition.metric]).filter(finite);
      let percentile: number | null = null;
      if (eligible && value !== null && values.length >= 2) {
        const less = values.filter(other => other < value).length, equal = values.filter(other => other === value).length;
        percentile = (less + (equal - 1) / 2) / (values.length - 1) * 100;
        if (definition.invert) percentile = 100 - percentile;
      }
      return { key: definition.key, label: definition.label, weight: definition.weight, value, percentile, points: percentile === null ? null : percentile * definition.weight / 100 };
    });
    const missing = components.filter(component => component.points === null);
    page.health = { score: eligible && !missing.length ? Math.round(components.reduce((value, component) => value + component.points!, 0)) : null,
      reason: !eligible ? 'At least 8 posts observed at 7–8 days old are needed in this range.' : peers.length < 2 ? 'At least two comparable pages on this platform are needed.' : missing.length ? 'Not enough history for: ' + missing.map(c => c.label.toLowerCase()).join(', ') + '.' : 'Percentile score among your comparable pages on this platform.',
      peerCount: peers.length, components };
  }
}

function totalsFor(pages: PageAnalysis[], alerts: AnalyticsDataset['alerts']): WorkspaceTotals {
  const platforms = new Set(pages.map(page => page.page.platform));
  const allFixed = pages.flatMap(page => page.posts.filter(post => post.inRange && post.fixedAgeViews !== null));
  const gains = sum(pages.map(page => page.metrics.viewsGained)), pay = sum(pages.map(page => page.metrics.pay));
  const posts = pages.reduce((n, page) => n + page.metrics.postsPublished, 0);
  const comparableCounts = pages.reduce((n, page) => n + page.metrics.comparablePosts, 0);
  const engagementPosts = allFixed.filter(post => post.fixedAgeInteractions !== null && post.fixedAgeViews! > 0);
  const attention = new Set(alerts.filter(alert => !alert.resolvedAt && alert.level !== 'green').map(alert => alert.pageId));
  return { pages: pages.length, activePages: pages.filter(page => page.page.active).length, attentionPages: pages.filter(page => attention.has(page.page.id) || !!page.page.syncError).length,
    viewsGained: gains, viewsCoverage: coverageOf(pages.map(page => page.metrics.viewsCoverage)), publishedViews: sum(pages.map(page => page.metrics.publishedViews)), postsPublished: posts,
    maturedPosts: pages.reduce((n, page) => n + page.metrics.maturedPosts, 0), comparablePosts: comparableCounts,
    medianViews: platforms.size === 1 ? median(allFixed.map(post => post.fixedAgeViews!)) : null,
    averageViews: platforms.size === 1 && allFixed.length ? allFixed.reduce((n, post) => n + post.fixedAgeViews!, 0) / allFixed.length : null,
    engagementRate: platforms.size === 1 && engagementPosts.length ? engagementPosts.reduce((n, post) => n + post.fixedAgeInteractions!, 0) / engagementPosts.reduce((n, post) => n + post.fixedAgeViews!, 0) : null,
    shares: sum(pages.map(page => page.metrics.shares)), followers: sum(pages.map(page => page.metrics.followers)), followerGrowth: sum(pages.map(page => page.metrics.followerGrowth)), followerCoverage: coverageOf(pages.map(page => page.metrics.followerCoverage)),
    monthlyPay: sum(pages.filter(page => page.page.active).map(page => page.metrics.monthlyPay)), pay, payKnownPages: pages.filter(page => page.metrics.pay !== null).length,
    costPerMillion: pay !== null && gains !== null && gains > 0 && pages.every(page => page.metrics.pay !== null) ? pay / gains * 1_000_000 : null,
    costPerPost: pages.every(page => page.metrics.pay !== null) ? ratio(pay, posts) : null,
    viewsPerThousand: pay !== null && pay > 0 && gains !== null && gains >= 0 && pages.every(page => page.metrics.pay !== null) ? gains / pay * 1_000 : null,
    mixedPlatforms: platforms.size > 1 };
}

function changes(current: PageMetrics | WorkspaceTotals, previous: PageMetrics | WorkspaceTotals): ComparisonMetrics {
  const change = (a: number | null, b: number | null): MetricChange => ({ current: a, previous: b, difference: a !== null && b !== null ? a - b : null, percent: a !== null && b !== null && b !== 0 ? (a - b) / Math.abs(b) : null });
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
  scorePages(pages);
  return Object.fromEntries(pages.map(page => [page.page.id, page.health]));
}

export function calculateWorkspace(dataset: AnalyticsDataset, input: DateRange, comparisonRange?: DateRange | null, nowInput?: string | Date, peerScores?: Record<string, HealthScore>): WorkspaceAnalysis {
  const range = normalizeRange(input), now = asNow(nowInput || dataset.generatedAt), compareRange = comparisonRange ? normalizeRange(comparisonRange) : null;
  const seen = new Set<string>();
  const source = dataset.pages.filter(page => { if (seen.has(page.id)) return false; seen.add(page.id); return true; });
  const index = indexSnapshots(dataset);
  const pages = source.map(page => pageAnalysis(page, dataset, range, now, true, index));
  scorePages(pages);
  if (peerScores) for (const page of pages) if (Object.hasOwn(peerScores, page.page.id)) page.health = peerScores[page.page.id];
  const alerts = dataset.alerts.filter(alert => !alert.resolvedAt && source.some(page => page.id === alert.pageId));
  const totals = totalsFor(pages, alerts);
  const platforms: PlatformAnalysis[] = (['instagram', 'tiktok', 'youtube'] as const).filter(platform => pages.some(page => page.page.platform === platform)).map(platform => {
    const peers = pages.filter(page => page.page.platform === platform);
    const rankings = [...peers].sort((a, b) => (b.health.score ?? -1) - (a.health.score ?? -1) || (b.metrics.medianViews ?? -1) - (a.metrics.medianViews ?? -1) || a.page.id.localeCompare(b.page.id));
    const bestPost = peers.flatMap(page => page.posts).filter(post => post.fixedAgeViews !== null && time(post.publishedAt) >= dayTime(range.from) && time(post.publishedAt) < dayTime(range.to) + DAY).sort((a, b) => b.fixedAgeViews! - a.fixedAgeViews! || a.id.localeCompare(b.id))[0] || null;
    return { platform, totals: totalsFor(peers, alerts), rankings, bestPageId: rankings.find(page => page.health.score !== null || page.metrics.medianViews !== null)?.page.id || null, bestPost };
  });
  const timeline = dayRows(range, now).map(day => {
    const points = pages.map(page => page.timeline.find(point => point.date === day.date)).filter((point): point is DailyPoint => !!point);
    return { date: day.date, viewsGained: sum(points.map(p => p.viewsGained)), publishedViews: sum(points.map(p => p.publishedViews)), followers: sum(points.map(p => p.followers)), followerGrowth: sum(points.map(p => p.followerGrowth)), postsPublished: points.reduce((n, p) => n + p.postsPublished, 0), coverage: points.some(p => p.viewsGained !== null) ? 'partial' as const : 'unavailable' as const };
  });
  const monthly: MonthlyRow[] = monthRanges(range).map(month => {
    const rows = source.map(page => pageAnalysis(page, dataset, month, now, false, index));
    return { month: month.from.slice(0, 7), range: month, totals: totalsFor(rows, alerts), pages: rows.map(page => ({ pageId: page.page.id, metrics: page.metrics })) };
  });
  let comparison: WorkspaceAnalysis['comparison'] = null;
  if (compareRange) {
    const previous = source.map(page => pageAnalysis(page, dataset, compareRange, now, false, index)), previousTotals = totalsFor(previous, alerts);
    comparison = { range: compareRange, totals: previousTotals, metrics: changes(totals, previousTotals), pages: pages.map(page => ({ pageId: page.page.id, metrics: changes(page.metrics, previous.find(item => item.page.id === page.page.id)!.metrics) })), verdict: verdict(totals, previousTotals) };
  }
  const warnings = ['Growth uses recorded snapshot changes only; tracking cannot recover earlier follower counts.', 'Typical views, engagement, hit rate and health use snapshots captured at 7–8 days of post age.', 'Daily growth points show changes between observations ending on that date, not continuously measured daily views.', 'Costs use the current monthly rate, prorated by calendar days; past rate changes are not reconstructed.'];
  if (totals.mixedPlatforms) warnings.push('Rankings, typical views and engagement are separated by platform. Combined view totals are counts, not cross-platform rankings.');
  if (dataset.historyTruncated) warnings.push('Some history could not be loaded. These totals are partial.');
  if ((dayTime(range.to) - dayTime(range.from)) / DAY > 366) warnings.push('The trend chart is grouped by month for this long range.');
  if (pages.some(page => !page.page.lastSyncedAt)) warnings.push('Unrefreshed pages have no observed metrics; post counts include saved posts only.');
  return { range, compareRange, days: (dayTime(range.to) - dayTime(range.from)) / DAY + 1, generatedAt: new Date(now).toISOString(), pages, totals, platforms, timeline, monthly, comparison, alerts, warnings };
}

/** Candidates only. Persistence across two separate checks and cooldown belong to the database job. */
export function alertCandidates(dataset: AnalyticsDataset, nowInput?: string | Date): AlertCandidate[] {
  const now = asNow(nowInput || dataset.generatedAt), result: AlertCandidate[] = [];
  const index = indexSnapshots(dataset);
  for (const page of dataset.pages.filter(page => page.active)) {
    const add = (level: AlertCandidate['level'], type: string, title: string, details: string, suffix = '') => result.push({ pageId: page.id, level, type, title, details, fingerprint: page.id + ':' + type + (suffix ? ':' + suffix : '') });
    if (page.syncError) { add('red', 'data-health', 'Refresh needs attention', 'The latest refresh failed. Retry this page and check its public availability.'); continue; }
    const refreshed = time(page.lastSyncedAt), coverage = page.coverage;
    if (!Number.isFinite(refreshed) || refreshed > now || now - refreshed > 2 * DAY) continue;
    // A historical-only refresh does not prove that the current publishing feed
    // is quiet. Require a complete recent feed or a complete date scope that
    // includes the relevant matured weeks through the current observation.
    const currentFeed = coverage?.complete === true && (coverage.requestedMode === 'posts' || coverage.requestedMode === 'date' && time(coverage.from) <= now - 21 * DAY && time(coverage.to) >= now);
    if (!currentFeed) continue;
    const all = page.posts.filter(post => Number.isFinite(time(post.publishedAt)) && time(post.publishedAt) <= now);
    const latest = all.map(post => time(post.publishedAt)).sort((a, b) => b - a)[0];
    const firstObservation = (index.accounts.get(page.id) || []).map(s => time(s.observedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    // Recent immature posts prevent a false inactivity alert; their metrics never enter performance alerts.
    if ((latest !== undefined && now - latest >= 7 * DAY) || (latest === undefined && firstObservation !== undefined && now - firstObservation >= 7 * DAY)) add('red', 'no-posts', 'No post in at least 7 days', 'Review the publishing schedule for this page.');
    const samples = all.map(post => ({ post, fixed: fixedAge(post, snapshotsFor(post, index.posts.get(page.id)?.get(post.id) || [], page, now), now) })).filter(item => !!item.fixed);
    const recent = samples.filter(item => time(item.post.publishedAt) > now - 14 * DAY && time(item.post.publishedAt) <= now - 7 * DAY);
    const previous = samples.filter(item => time(item.post.publishedAt) > now - 21 * DAY && time(item.post.publishedAt) <= now - 14 * DAY);
    const baseline = samples.filter(item => time(item.post.publishedAt) > now - 44 * DAY && time(item.post.publishedAt) <= now - 14 * DAY);
    const baseline90 = samples.filter(item => time(item.post.publishedAt) >= now - 90 * DAY && time(item.post.publishedAt) <= now - 7 * DAY);
    const recentMedian = median(recent.map(item => item.fixed!.views!)), previousMedian = median(previous.map(item => item.fixed!.views!));
    const base30 = median(baseline.map(item => item.fixed!.views!)), base90 = median(baseline90.map(item => item.fixed!.views!));
    if (recentMedian !== null && previousMedian !== null && previousMedian > 0 && recentMedian < 0.7 * previousMedian) add('red', 'median-drop', 'Typical views dropped', 'The latest matured week is below 70% of the previous matured week at the same post age.');
    const recentPosts = all.filter(post => time(post.publishedAt) > now - 14 * DAY && time(post.publishedAt) <= now - 7 * DAY).length;
    const previousPosts = all.filter(post => time(post.publishedAt) > now - 21 * DAY && time(post.publishedAt) <= now - 14 * DAY).length;
    if (previousPosts && recentPosts <= 0.6 * previousPosts) add('amber', 'posting-drop', 'Publishing has slowed', 'The latest matured week has at most 60% as many posts as the previous week.');
    if (recentMedian !== null && base30 !== null && base30 > 0 && recentMedian < 0.75 * base30) add('amber', 'below-baseline', 'Below the recent baseline', 'Typical fixed-age views are more than 25% below the preceding 30-day baseline.');
    if (recentMedian !== null && base30 !== null && base30 > 0 && recentMedian > 1.4 * base30) add('green', 'upward-trend', 'Strong upward trend', 'Typical fixed-age views are above 1.4 times the preceding 30-day baseline.');
    if (base90 !== null && base90 > 0) for (const item of recent) if (item.fixed!.views! > 5 * base90) add('green', 'viral-post', 'A post outperformed its baseline', 'This post reached more than five times the page\'s 90-day median at the same age.', item.post.id);
  }
  return result;
}
