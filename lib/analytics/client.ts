import type { AnalyticsCollection, AnalyticsDataset, AnalyticsMembership, AnalyticsPost } from './types';

type Chunk = Partial<AnalyticsDataset> & {posts?: AnalyticsPost[]; nextCursor: string | null; generatedAt: string; error?: string};
/** Small responses stay below hosting limits; never display half-loaded history as a complete total. */
export async function loadAnalyticsDataset(params: URLSearchParams, signal?: AbortSignal): Promise<AnalyticsDataset> {
  const collections: AnalyticsCollection[] = [], memberships: AnalyticsMembership[] = [];
  const dataset: AnalyticsDataset = {pages:[],collections,memberships,accountSnapshots:[],postSnapshots:[],alerts:[],generatedAt:''};
  const posts: AnalyticsPost[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams(params);
    if (cursor) query.set('cursor', cursor);
    const response = await fetch('/api/analytics?' + query, {signal, cache:'no-store'});
    const chunk = await response.json() as Chunk;
    if (!response.ok) throw new Error(chunk.error || 'Your saved history could not be loaded.');
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (chunk.pages) dataset.pages.push(...chunk.pages);
    if (chunk.collections) collections.push(...chunk.collections);
    if (chunk.memberships) memberships.push(...chunk.memberships);
    if (chunk.accountSnapshots) dataset.accountSnapshots.push(...chunk.accountSnapshots);
    if (chunk.postSnapshots) dataset.postSnapshots.push(...chunk.postSnapshots);
    if (chunk.alerts) dataset.alerts.push(...chunk.alerts);
    if (chunk.posts) posts.push(...chunk.posts);
    dataset.generatedAt ||= chunk.generatedAt;
    dataset.historyTruncated ||= chunk.historyTruncated;
    cursor = chunk.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size > 5000)) throw new Error('This history is too large for one view. Choose a shorter range or a single page.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  const grouped = new Map<string, AnalyticsPost[]>();
  for (const post of posts) { const list = grouped.get(post.pageId) || []; list.push(post); grouped.set(post.pageId, list); }
  for (const page of dataset.pages) page.posts = (grouped.get(page.id) || page.posts).sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id));
  return dataset;
}
