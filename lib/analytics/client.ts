import type { AnalyticsCollection, AnalyticsDataset, AnalyticsMembership, AnalyticsPost } from './types';

type Chunk = Partial<AnalyticsDataset> & {posts?: AnalyticsPost[]; nextCursor: string | null; nextStageCursor?: string | null; parallelCursors?: string[]; generatedAt: string; error?: string};
/** Small responses stay below hosting limits; never display half-loaded history as a complete total. */
export async function loadAnalyticsDataset(params: URLSearchParams, signal?: AbortSignal): Promise<AnalyticsDataset> {
  const collections: AnalyticsCollection[] = [], memberships: AnalyticsMembership[] = [];
  const dataset: AnalyticsDataset = {pages:[],collections,memberships,accountSnapshots:[],postSnapshots:[],alerts:[],generatedAt:''};
  const posts: AnalyticsPost[] = [];
  const seen = new Set<string>();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) controller.abort();
  async function load(cursor: string | null): Promise<Chunk> {
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 5000) throw new Error('This history is too large for one view. Choose a shorter range or a single page.');
      seen.add(cursor);
    }
    const query = new URLSearchParams(params);
    query.delete('cursor');
    if (cursor) query.set('cursor', cursor);
    const response = await fetch('/api/analytics?' + query, {signal: controller.signal, cache:'no-store'});
    const chunk = await response.json() as Chunk;
    if (!response.ok) throw new Error(chunk.error || 'Your saved history could not be loaded.');
    if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (!chunk.generatedAt || dataset.generatedAt && chunk.generatedAt !== dataset.generatedAt) throw new Error('Your saved history changed while loading. Reload the dashboard.');
    if (chunk.pages) dataset.pages.push(...chunk.pages);
    if (chunk.collections) collections.push(...chunk.collections);
    if (chunk.memberships) memberships.push(...chunk.memberships);
    if (chunk.accountSnapshots) dataset.accountSnapshots.push(...chunk.accountSnapshots);
    if (chunk.postSnapshots) dataset.postSnapshots.push(...chunk.postSnapshots);
    if (chunk.alerts) dataset.alerts.push(...chunk.alerts);
    if (chunk.posts) posts.push(...chunk.posts);
    dataset.generatedAt ||= chunk.generatedAt;
    dataset.historyTruncated ||= chunk.historyTruncated;
    return chunk;
  }
  try {
    const first = await load(null);
    if (first.parallelCursors) {
      // Each stream retains ordered pagination and the same observation cutoff.
      // Limit concurrent requests so large workspaces do not flood the server.
      const queue = [...first.parallelCursors];
      async function worker() {
        let cursor: string | undefined;
        while ((cursor = queue.shift()) !== undefined) {
          let next: string | null = cursor;
          while (next) {
            const chunk = await load(next);
            if (chunk.nextStageCursor === undefined) throw new Error('Your saved history could not be fully loaded. Reload the dashboard.');
            next = chunk.nextStageCursor;
          }
        }
      }
      await Promise.all(Array.from({length: Math.min(3, queue.length)}, worker));
    } else {
      // Compatible with an older server during a rolling deployment.
      let cursor = first.nextCursor;
      while (cursor) cursor = (await load(cursor)).nextCursor;
    }
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  const grouped = new Map<string, AnalyticsPost[]>();
  for (const post of posts) { const list = grouped.get(post.pageId) || []; list.push(post); grouped.set(post.pageId, list); }
  for (const page of dataset.pages) page.posts = (grouped.get(page.id) || page.posts).sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id));
  return dataset;
}
