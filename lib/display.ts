import type { Scope } from './scope';

export type MetricKey = 'followers' | 'views' | 'likes' | 'comments' | 'shares' | 'posts' | 'lifetimeViews' | 'lifetimePosts';
export const DEFAULT_HEADERS = {
  page: 'Page', followers: 'Followers / subscribers', views: 'Views', likes: 'Likes',
  comments: 'Comments', shares: 'Shares', posts: 'Selected posts',
  lifetimeViews: 'Lifetime views', lifetimePosts: 'Lifetime posts',
  coverage: 'Coverage', refreshed: 'Last refresh',
} as const;
export type HeaderKey = keyof typeof DEFAULT_HEADERS;
export type HeaderMap = Record<HeaderKey, string>;
export type Overrides = Record<string, number>;
export type OverrideMap = Overrides;
export type DisplayValue = { value: number | null; manual: boolean; known: number; total: number };
type CounterPost = { views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null };
type DisplayPage = { id: string; followers?: number | null; overall?: { followers?: number | null; views?: number | null; posts?: number | null } | null };
type Selection = { posts: CounterPost[]; usable: boolean; complete: boolean };
const METRICS = new Set<MetricKey>(['followers', 'views', 'likes', 'comments', 'shares', 'posts', 'lifetimeViews', 'lifetimePosts']);
const profileMetric = (metric: MetricKey) => metric === 'followers' || metric === 'lifetimeViews' || metric === 'lifetimePosts';

/** Zero is a real count; null and invalid counters remain unavailable. */
export function isSafeCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Manual entries require exact whole counts, with optional comma grouping. */
export function parseManualValue(input: unknown): number | null {
  if (typeof input === 'number') return isSafeCounter(input) ? input : null;
  if (typeof input !== 'string') return null;
  const value = input.trim();
  // Accept common international and Indian grouping without accepting malformed commas.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})$/.test(value)) return null;
  const number = Number(value.replace(/,/g, ''));
  return isSafeCounter(number) ? number : null;
}

export function overrideKey(pageId: string, scope: Scope, metric: MetricKey): string {
  const selectionKey = scope.mode === 'posts' ? `posts:${scope.postLimit}` : `date:${scope.from}:${scope.to}`;
  return JSON.stringify([pageId, profileMetric(metric) ? 'profile' : selectionKey, metric]);
}

/** Only recognized labels are restored; unknown or blank labels use the defaults. */
export function normalizeHeaders(input: unknown): HeaderMap {
  const result: HeaderMap = { ...DEFAULT_HEADERS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const key of Object.keys(DEFAULT_HEADERS) as HeaderKey[]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) result[key] = value.trim().slice(0, 60);
  }
  return result;
}

/** Local storage is untrusted and may contain obsolete keys or malformed values. */
export function normalizeOverrides(input: unknown): Overrides {
  const result: Overrides = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    if (!isSafeCounter(value)) continue;
    try {
      const parts: unknown = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== 3) continue;
      const [pageId, scope, metric] = parts;
      if (typeof pageId !== 'string' || !pageId || typeof scope !== 'string' || !METRICS.has(metric)) continue;
      if (profileMetric(metric) ? scope !== 'profile' : !/^(?:posts:[1-9]\d*|date:.+:.+)$/.test(scope)) continue;
      result[JSON.stringify(parts)] = value;
    } catch { /* Ignore corrupted keys without losing valid local edits. */ }
  }
  return result;
}

function one(value: unknown): DisplayValue {
  return { value: isSafeCounter(value) ? value : null, manual: false, known: isSafeCounter(value) ? 1 : 0, total: 1 };
}

function counterSum(values: number[]): number | null {
  const value = values.reduce((total, current) => total + current, 0);
  return isSafeCounter(value) ? value : null;
}

/** Display overrides never mutate the stored provider response. */
export function displayMetric(page: DisplayPage, selection: Selection, scope: Scope, overrides: Overrides, metric: MetricKey): DisplayValue {
  const key = overrideKey(page.id, scope, metric);
  if (Object.prototype.hasOwnProperty.call(overrides, key) && isSafeCounter(overrides[key])) {
    return { value: overrides[key], manual: true, known: 1, total: 1 };
  }
  if (metric === 'followers') return one(isSafeCounter(page.followers) ? page.followers : page.overall?.followers);
  if (metric === 'lifetimeViews') return one(page.overall?.views);
  if (metric === 'lifetimePosts') return one(page.overall?.posts);
  if (!selection.usable) return { value: null, manual: false, known: 0, total: metric === 'posts' ? 1 : 0 };
  if (metric === 'posts') return one(selection.posts.length);
  const values = selection.posts.map(post => post[metric]).filter(isSafeCounter);
  const emptyComplete = selection.complete && selection.posts.length === 0;
  return {
    value: values.length ? counterSum(values) : emptyComplete ? 0 : null,
    manual: false, known: values.length, total: selection.posts.length,
  };
}

/** Each available page contributes independently, even when another platform lacks this metric. */
export function sumDisplay(values: DisplayValue[]): DisplayValue {
  const available = values.filter(value => isSafeCounter(value.value));
  return {
    value: available.length ? counterSum(available.map(item => item.value!)) : null,
    manual: available.some(item => item.manual), known: available.length, total: values.length,
  };
}

export const TABLE_COLUMNS = ['page','followers','views','likes','comments','shares','posts','coverage','lifetimeViews','lifetimePosts','refreshed'] as const;
export type ColumnVisibility = Record<HeaderKey, boolean>;
export const DEFAULT_COLUMNS: ColumnVisibility = {page:true,followers:true,views:true,likes:true,comments:true,shares:false,posts:true,coverage:true,lifetimeViews:false,lifetimePosts:false,refreshed:true};
export function normalizeColumns(input: unknown): ColumnVisibility {
  const result = {...DEFAULT_COLUMNS};
  if (input && typeof input === 'object' && !Array.isArray(input)) for (const key of TABLE_COLUMNS) {
    const value=(input as Record<string,unknown>)[key]; if(typeof value==='boolean')result[key]=value;
  }
  if(!TABLE_COLUMNS.some(key=>result[key]))result.page=true;
  return result;
}
