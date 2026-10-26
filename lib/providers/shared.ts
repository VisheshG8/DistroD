import { normalizeDate, parseCounter } from '../providers';
import type { PageInput } from '../providers';
import { isTerminalProviderError, ProviderError } from './types';
import type { Scope, SocialFetchResult, StandardPost, StandardProfile } from './types';

export type Json = Record<string, any>;
export const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export function text(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  for (const value of values) if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}
export function count(...values: unknown[]): number | null {
  for (const value of values) { const parsed = parseCounter(value); if (parsed.value !== null) return parsed.value; }
  return null;
}
export function boolean(...values: unknown[]): boolean | null {
  for (const value of values) if (typeof value === 'boolean') return value;
  return null;
}
export function image(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.toString(); } catch { /* Try the next field. */ }
    }
    if (Array.isArray(value)) { const found = image(...value); if (found) return found; }
    const item = object(value);
    if (item.url || item.url_list || item.candidates) { const found = image(item.url, item.url_list, item.candidates); if (found) return found; }
  }
  return null;
}
export function envelopes(body: unknown): Json[] {
  const result: Json[] = []; let current = object(body);
  for (let depth = 0; depth < 5 && Object.keys(current).length; depth++) {
    result.push(current);
    const next = object(current.data || current.response);
    if (!Object.keys(next).length || next === current) break;
    current = next;
  }
  return result;
}
export function checkPayload(body: unknown): void {
  for (const item of envelopes(body)) {
    const message = text(item.message, item.detail, item.error?.message, item.error);
    if (item.is_private === true || /private account|account is private|profile is private/i.test(message)) {
      throw new ProviderError('This account is private. Only public accounts can be refreshed.', 'PRIVATE', 422);
    }
    const badCode = item.code !== undefined && /^-?\d+$/.test(String(item.code)) && ![0, 200, '0', '200'].includes(item.code);
    if (item.success === false || item.status === 'fail' || item.error || badCode || (item.status_code !== undefined && ![0, 200, '0', '200'].includes(item.status_code))) {
      throw new ProviderError('The data provider could not return this account.');
    }
  }
}
export function normalizeScope(input: Scope): Scope {
  const scope = { ...input, postLimit: Math.max(1, Math.min(1000, Math.floor(Number(input.postLimit) || 30))) };
  if (scope.mode === 'date') {
    scope.from = normalizeDate(scope.from); scope.to = normalizeDate(scope.to);
    if (!scope.from || !scope.to || scope.from >= scope.to) throw new ProviderError('Choose a valid publication date range.', 'CONFIGURATION', 400);
  } else { scope.mode = 'posts'; scope.from = null; scope.to = null; }
  return scope;
}
type Feed = { items: unknown[]; cursor: string | null; hasMore: boolean };
export async function collectPosts(options: {
  page: PageInput; provider: string; profile: StandardProfile; scope: Scope;
  load: (cursor: string | null) => Promise<Feed>;
  normalize: (raw: Json) => StandardPost | null;
}): Promise<SocialFetchResult> {
  const { page, profile, provider, scope } = options;
  const found = new Map<string, StandardPost>(); const cursors = new Set<string>();
  let cursor: string | null = null; let hasMore = true; let stopReason = 'request-limit'; let olderPages = 0;
  let partial = false; let skippedPosts = 0;
  for (let call = 0; call < 49; call++) {
    let feed: Feed;
    try { feed = await options.load(cursor); }
    catch (error) {
      if (isTerminalProviderError(error) || found.size === 0) throw error;
      partial = true; stopReason = 'provider-error'; break;
    }
    const added: StandardPost[] = [];
    let truncated = false;
    for (const raw of feed.items) {
      const post = options.normalize(object(raw));
      if (!post) { skippedPosts++; continue; }
      if (!found.has(post.id)) {
        if (found.size < 1000) { found.set(post.id, post); added.push(post); }
        else truncated = true;
      }
    }
    if (feed.items.length && !added.length && !found.size) throw new ProviderError('The provider returned posts without recognizable identifiers.');
    hasMore = feed.hasMore;
    if (truncated) { partial = true; stopReason = 'scan-limit'; break; }
    if (!hasMore) { stopReason = 'exhausted'; break; }
    const ordinary = added.filter(post => !post.isPinned);
    // A changed timestamp schema cannot establish chronological coverage. Stop
    // this partial result instead of spending the entire pagination allowance.
    if (ordinary.length > 0 && ordinary.every(post => !post.publishedAt)) { partial = true; stopReason = 'unknown-dates'; break; }
    // Old pinned posts appear before the chronological feed. They must not make
    // us stop before we have seen the requested number of ordinary recent posts.
    if (scope.mode === 'posts' && [...found.values()].filter(post => !post.isPinned && post.publishedAt).length >= scope.postLimit) { stopReason = 'post-limit'; break; }
    if (scope.mode === 'date') {
      olderPages = ordinary.length > 0 && ordinary.every(post => !!post.publishedAt && post.publishedAt < scope.from!) ? olderPages + 1 : 0;
      if (olderPages >= 2) { stopReason = 'range-covered'; break; }
    }
    if (found.size >= 1000) { partial = true; stopReason = 'scan-limit'; break; }
    if (!feed.cursor || cursors.has(feed.cursor)) { partial = true; stopReason = 'missing-cursor'; break; }
    cursors.add(feed.cursor); cursor = feed.cursor;
  }
  if (stopReason === 'request-limit') partial = true;
  const all = [...found.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const unknownDates = all.filter(post => !post.publishedAt).length;
  const posts = scope.mode === 'date'
    ? all.filter(post => post.publishedAt && post.publishedAt >= scope.from! && post.publishedAt < scope.to!)
    : all.slice(0, scope.postLimit);
  const complete = !partial && skippedPosts === 0 && unknownDates === 0;
  hasMore ||= scope.mode === 'posts' && all.length > scope.postLimit;
  const dated = all.flatMap(post => post.publishedAt ? [post.publishedAt] : []);
  const notes = ['Only public counters returned by the provider are shown; missing counters remain unavailable.'];
  if (partial) notes.push('Pagination stopped early. The fetched posts are retained; retry to finish the requested coverage.');
  if (unknownDates) notes.push(`${unknownDates} posts have no reliable publication time.`);
  if (skippedPosts) notes.push(`${skippedPosts} posts could not be read reliably and were excluded.`);
  return {
    profile, name: profile.name || page.handle, followers: profile.followers, canonicalId: profile.id, posts, provider,
    coverage: { limit: scope.mode === 'date' ? 1000 : scope.postLimit, fetched: posts.length, hasMore,
      incomplete: !complete, note: notes.join(' '), requestedMode: scope.mode, from: scope.from, to: scope.to,
      scanned: all.length, oldest: dated.at(-1) || null, newest: dated[0] || null, unknownDates,
      complete, stopReason, unavailableLikes: posts.filter(post => post.likes === null).length,
      hiddenLikes: posts.filter(post => post.likesReason === 'hidden').length,
      unavailableViews: posts.filter(post => post.views === null).length },
    overall: { followers: profile.followers, posts: profile.postCount, views: null, likes: null, comments: null, shares: null,
      note: 'Profile totals are separate from the selected posts. Unavailable lifetime counters are not estimated.' },
  };
}
