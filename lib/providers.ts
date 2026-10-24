/** Public-data adapters. Pagination is bounded; unavailable counters stay null. */
export type Platform = 'instagram' | 'tiktok' | 'youtube';
export type PageInput = { id: string; platform: string; handle: string; url: string };
export type ProviderSettings = {
  provider: 'tikhub' | 'scrapecreators'; postLimit: number; apiKey: string; youtubeKey: string;
  scope?: { mode: 'posts' | 'date'; postLimit: number; from: string | null; to: string | null };
};
export type Post = {
  id: string; pageId: string; platform: string; url: string; title: string;
  publishedAt: string | null; thumbnail: string | null;
  views: number | null; likes: number | null; comments: number | null;
  shares: number | null; saves: number | null; durationSeconds: number | null;
  likesReason?: 'hidden' | 'not-returned' | null;
  isPinned?: boolean;
};
export type Overall = { views: number | null; posts: number | null; followers: number | null;
  likes: number | null; comments: number | null; shares: number | null; note: string };
export type PageFetchResult = {
  name: string; followers: number | null; canonicalId: string | null; posts: Post[];
  coverage: { limit: number; fetched: number; hasMore: boolean; incomplete: boolean; note: string;
    requestedMode: 'posts' | 'date'; from: string | null; to: string | null; scanned: number;
    oldest: string | null; newest: string | null; unknownDates: number; complete: boolean; stopReason: string;
    unavailableLikes: number; hiddenLikes: number; unavailableViews: number };
  overall: Overall;
  provider: string;
};
type Json = Record<string, any>;
type Request = (url: string, headers: Record<string, string>) => Promise<any>;
type Context = {
  page: PageInput; settings: ProviderSettings; limit: number; calls: number; rounded: boolean;
  mode: 'posts' | 'date'; from: string | null; to: string | null; scanLimit: number;
  stopReason: string; overall: Overall | null; scanTruncated: boolean;
  notes: Set<string>; call: (path: string, params?: Json, official?: boolean) => Promise<Json>;
};

const MAX_CALLS = 50;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (...values: unknown[]): string => {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

/** Accept only recognizable counters. The caller must surface rounded=true. */
export function parseCounter(value: unknown): { value: number | null; rounded: boolean } {
  if (typeof value === 'number') return { value: Number.isSafeInteger(value) && value >= 0 ? value : null, rounded: false };
  if (typeof value !== 'string' || !value.trim()) return { value: null, rounded: false };
  const input = value.trim().replace(/,/g, '').replace(/\u00a0/g, ' ');
  const exact = input.match(/^(\d+)(?:\s*(?:views?|plays?|subscribers?|followers?|likes?|comments?|videos?|\u6b21\u89c2\u770b|\u4f4d\u8ba2\u9605\u8005|\u4e2a\u89c6\u9891))?$/i);
  if (exact) {
    const n = Number(exact[1]);
    return { value: Number.isSafeInteger(n) ? n : null, rounded: false };
  }
  const abbreviated = input.match(/^(\d+(?:\.\d+)?)\s*([KMBT\u4e07\u4ebf])(?:\s*(?:views?|plays?|subscribers?|followers?|likes?|comments?|videos?|\u6b21\u89c2\u770b|\u4f4d\u8ba2\u9605\u8005|\u4e2a\u89c6\u9891))?$/i);
  if (abbreviated) {
    const factors: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, '\u4e07': 1e4, '\u4ebf': 1e8 };
    const n = Number(abbreviated[1]) * factors[abbreviated[2].toUpperCase()];
    return { value: Number.isSafeInteger(Math.round(n)) ? Math.round(n) : null, rounded: true };
  }
  return { value: null, rounded: false };
}

function counter(ctx: Context, ...values: unknown[]): number | null {
  for (const raw of values) {
    const result = parseCounter(raw);
    if (result.value !== null) { ctx.rounded ||= result.rounded; return result.value; }
  }
  return null;
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  // Do not invent an upload time from relative labels or date-only values.
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function layers(body: unknown): Json[] {
  const result: Json[] = [];
  let current = object(body);
  for (let i = 0; i < 5 && Object.keys(current).length; i++) {
    result.push(current);
    const next = object(current.data);
    if (!Object.keys(next).length || next === current) break;
    current = next;
  }
  return result;
}

function pick(body: unknown, ...keys: string[]): Json {
  const candidates = layers(body);
  return candidates.find(item => keys.some(key => Object.prototype.hasOwnProperty.call(item, key))) || candidates.at(-1) || {};
}

function payloadError(body: unknown): void {
  for (const item of layers(body)) {
    const message = string(item.message, typeof item.error === 'string' ? item.error : '', item.error?.message);
    const badCode = item.code !== undefined && ![0, 200, '0', '200', 'ok'].includes(item.code);
    if (item.success === false || badCode || item.error || item.errorStatus >= 400) {
      if (/private|restrict|age.?gate|unavailable|not.?found|doesn.?t exist/i.test(message)) {
        throw new Error('This profile is private, restricted, unavailable, or could not be found by the provider. Check the public profile link.');
      }
      if (/credit|balance|payment|fund/i.test(message)) throw new Error('The data provider needs a paid balance or more credits. Top up the selected provider and try again.');
      if (/auth|token|key|subscri/i.test(message)) throw new Error('The data provider rejected the API key. Check the key and provider selection in Settings.');
      throw new Error('The data provider could not return this profile. Try again later or switch providers in Settings.');
    }
    if (item.is_private === true || /^(profile is private|profile is restricted|account doesn.t exist)$/i.test(message)) {
      throw new Error('This profile is private or unavailable. Only public pages can be tracked.');
    }
  }
}

function image(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
    if (Array.isArray(value)) {
      const found = image(...value);
      if (found) return found;
    }
    const item = object(value);
    if (typeof item.url === 'string' && /^https?:\/\//.test(item.url)) return item.url;
    if (item.url_list || item.candidates) {
      const found = image(item.url_list, item.candidates);
      if (found) return found;
    }
  }
  return null;
}

function duration(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  if (/^\d+(?::\d{2}){1,2}$/.test(value)) return value.split(':').reduce((n, part) => n * 60 + Number(part), 0);
  const iso = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  return iso ? Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0) : null;
}

function basePost(ctx: Context, id: string): Post {
  return { id, pageId: ctx.page.id, platform: ctx.page.platform, url: '', title: '', publishedAt: null,
    thumbnail: null, views: null, likes: null, comments: null, shares: null, saves: null, durationSeconds: null };
}

function instagramPost(ctx: Context, input: Json): Post | null {
  const item = object(input.node || input.media || input);
  const id = string(item.pk, item.id, item.code, item.shortcode);
  if (!id) return null;
  const code = string(item.code, item.shortcode);
  const hidden = item.like_and_view_counts_disabled === true;
  const post = basePost(ctx, /^\d+_\d+$/.test(id) ? id.split('_')[0] : id);
  post.url = string(item.url, item.permalink) || (code ? `https://www.instagram.com/p/${encodeURIComponent(code)}/` : ctx.page.url);
  post.title = string(item.caption?.text, item.caption, item.edge_media_to_caption?.edges?.[0]?.node?.text, item.accessibility_caption);
  post.publishedAt = normalizeDate(item.created_at) || normalizeDate(item.taken_at) || normalizeDate(item.taken_at_timestamp);
  post.thumbnail = image(item.display_url, item.display_uri, item.thumbnail_src, item.image_versions2?.candidates);
  // A presentation flag must not erase numeric counters the provider actually returned.
  // Instagram commonly uses negative/missing counters for hidden values; counter() keeps those null.
  post.views = counter(ctx, item.play_count, item.ig_play_count, item.video_play_count, item.video_view_count, item.view_count);
  post.likes = counter(ctx, item.like_count, item.edge_media_preview_like?.count, item.edge_liked_by?.count);
  post.likesReason = post.likes === null ? hidden ? 'hidden' : 'not-returned' : null;
  post.isPinned = item.is_pinned === true || item.is_pinned === 1 || (Array.isArray(item.pinned_for_users) && item.pinned_for_users.length > 0);
  post.comments = counter(ctx, item.comment_count, item.edge_media_to_comment?.count, item.edge_media_to_parent_comment?.count);
  post.shares = counter(ctx, item.share_count, item.reshare_count);
  post.saves = counter(ctx, item.save_count);
  post.durationSeconds = duration(item.video_duration);
  return post;
}

function tiktokPost(ctx: Context, input: Json): Post | null {
  const item = object(input);
  const id = string(item.aweme_id, item.id);
  if (!id) return null;
  const stats = object(item.statistics || item.stats || item.statsV2);
  const post = basePost(ctx, id);
  post.url = string(item.share_url, item.share_info?.share_url, item.webVideoUrl) || `https://www.tiktok.com/@${encodeURIComponent(ctx.page.handle.replace(/^@/, ''))}/video/${encodeURIComponent(id)}`;
  post.title = string(item.desc, item.description, item.text);
  post.publishedAt = normalizeDate(item.create_time) || normalizeDate(item.createTime) || normalizeDate(item.createTimeISO);
  post.thumbnail = image(item.video?.cover, item.video?.originCover, item.video?.dynamic_cover, item.video?.cover?.url_list);
  post.views = counter(ctx, stats.play_count, stats.playCount, item.playCount);
  post.likes = counter(ctx, stats.digg_count, stats.diggCount, item.diggCount);
  post.comments = counter(ctx, stats.comment_count, stats.commentCount, item.commentCount);
  post.shares = counter(ctx, stats.share_count, stats.shareCount, item.shareCount);
  post.saves = counter(ctx, stats.collect_count, stats.collectCount, item.collectCount);
  post.isPinned = item.isPinned === true || item.isTop === true || item.is_top === 1;
  // TikTok's app payload uses milliseconds; its web payload uses seconds.
  post.durationSeconds = item.aweme_id && typeof item.video?.duration === 'number'
    ? duration(item.video.duration / 1000) : duration(item.video?.duration);
  return post;
}

function youtubePost(ctx: Context, input: Json): Post | null {
  const item = object(input);
  const id = string(item.video_id, item.videoId, typeof item.id === 'string' ? item.id : '', item.id?.videoId);
  if (!id) return null;
  const stats = object(item.statistics);
  const snippet = object(item.snippet);
  const post = basePost(ctx, id);
  post.url = string(item.url, item.video_url, item.videoUrl) || `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  post.title = string(snippet.title, item.title);
  post.publishedAt = normalizeDate(snippet.publishedAt) || normalizeDate(item.publishDate) || normalizeDate(item.publishedTime) || normalizeDate(item.published_at);
  post.thumbnail = image(snippet.thumbnails?.high, snippet.thumbnails?.medium, item.thumbnail, item.thumbnails);
  post.views = counter(ctx, stats.viewCount, item.viewCountInt, item.view_count, item.viewCount, item.view_count_text, item.viewCountText);
  post.likes = counter(ctx, stats.likeCount, item.likeCountInt, item.like_count, item.likeCount);
  post.comments = counter(ctx, stats.commentCount, item.commentCountInt, item.comment_count, item.commentCount);
  // YouTube does not expose public share/save counts. Never synthesize them.
  post.durationSeconds = duration(item.contentDetails?.duration) ?? duration(item.lengthSeconds) ?? duration(item.lengthInSeconds) ?? duration(item.duration) ?? (typeof item.durationMs === 'number' ? item.durationMs / 1000 : null);
  return post;
}

export function normalizeInstagramPost(item: Json, page: PageInput): Post | null {
  return instagramPost(normalizationContext(page), item);
}
export function normalizeTikTokPost(item: Json, page: PageInput): Post | null {
  return tiktokPost(normalizationContext(page), item);
}
export function normalizeYouTubePost(item: Json, page: PageInput): Post | null {
  return youtubePost(normalizationContext(page), item);
}
function normalizationContext(page: PageInput): Context {
  return { page, settings: { provider: 'tikhub', postLimit: 30, apiKey: '', youtubeKey: '' }, limit: 30,
    mode: 'posts', from: null, to: null, scanLimit: 1000, stopReason: '', overall: null, scanTruncated: false,
    calls: 0, rounded: false, notes: new Set(), call: async () => ({}) };
}

function append(target: Map<string, Post>, ctx: Context, items: unknown[], normalize: (ctx: Context, item: Json) => Post | null): Post[] {
  const normalized: Post[] = [];
  for (const raw of items) {
    const post = normalize(ctx, object(raw));
    if (post && !target.has(post.id)) normalized.push(post);
    if (post && !target.has(post.id)) {
      if (target.size < ctx.scanLimit) target.set(post.id, post);
      else ctx.scanTruncated = true;
    }
  }
  return normalized;
}

function needsMore(ctx: Context, posts: Map<string, Post>): boolean {
  return posts.size < (ctx.mode === 'date' ? ctx.scanLimit : ctx.limit);
}

/** Two full older pages are required: a pinned old post in an otherwise recent feed is not a boundary. */
function olderPage(ctx: Context, posts: Post[]): boolean {
  const unpinned = posts.filter(post => !post.isPinned);
  return ctx.mode === 'date' && !!ctx.from && unpinned.length > 0 && unpinned.every(post => !!post.publishedAt && post.publishedAt < ctx.from!);
}

function emptyOverall(followers: number | null, note: string): Overall {
  return { views: null, posts: null, followers, likes: null, comments: null, shares: null, note };
}

function finish(ctx: Context, name: string, followers: number | null, canonicalId: string | null,
  posts: Map<string, Post>, hasMore: boolean, incomplete: boolean, provider?: string): PageFetchResult {
  const ordered = [...posts.values()].sort((a, b) => {
    // Known dates sort first; undated records preserve their relative provider order.
    if (!a.publishedAt) return b.publishedAt ? 1 : 0;
    if (!b.publishedAt) return -1;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
  const unknownDates = ordered.filter(post => !post.publishedAt).length;
  const matching = ctx.mode === 'date' ? ordered.filter(post => post.publishedAt && (!ctx.from || post.publishedAt >= ctx.from) && (!ctx.to || post.publishedAt < ctx.to)) : ordered;
  const selected = matching.slice(0, ctx.limit);
  hasMore ||= ctx.mode === 'posts' && ordered.length > ctx.limit;
  let complete = !incomplete && !ctx.scanTruncated && (!hasMore || (ctx.mode === 'posts' && selected.length >= ctx.limit) || ctx.stopReason === 'date-boundary');
  if (ctx.scanTruncated) ctx.stopReason = 'post-scan-limit';
  if (!ctx.stopReason) ctx.stopReason = !hasMore ? 'feed-end' : selected.length >= ctx.limit && ctx.mode === 'posts' ? 'post-limit' : ctx.calls >= MAX_CALLS ? 'request-limit' : ordered.length >= ctx.scanLimit ? 'post-scan-limit' : 'partial';
  if (ctx.mode === 'date' && ctx.stopReason !== 'date-boundary' && hasMore) complete = false;
  if (selected.some(post => post.views === null)) ctx.notes.add('Some fetched posts have no public view count; unavailable metrics are not counted as zero.');
  if (unknownDates) ctx.notes.add(ctx.mode === 'date' ? `${unknownDates} scanned posts have no publish date and are excluded from the selected period.` : 'Some publish dates are unavailable.');
  if (selected.some(post => post.likes === null)) ctx.notes.add('Some like counts were hidden or not returned by the source; only known likes are included.');
  if (ctx.page.platform === 'youtube' && selected.some(post => post.likes === null)) ctx.notes.add(`YouTube did not return public like counts for ${selected.filter(post => post.likes === null).length}/${selected.length} selected posts.`);
  if (ctx.rounded) ctx.notes.add('Some provider counters are rounded public labels; their totals are approximate.');
  if (ctx.mode === 'posts' && hasMore) ctx.notes.add(`Selected up to ${ctx.limit} recent posts; these metrics cover those posts.`);
  if (ctx.mode === 'posts' && !hasMore && ctx.overall?.posts != null && ctx.overall.posts > ordered.length) ctx.notes.add(`The profile reports ${ctx.overall.posts} public posts; ${ordered.length} were retrievable in the completed feed. Unavailable items can cause these counts to differ.`);
  if (ctx.mode === 'date') ctx.notes.add('The period selects publication dates. Counters are current lifetime totals on posts published in that period, not views gained during the period.');
  if (!complete) ctx.notes.add('Coverage is partial: the provider, request limit or scan limit stopped the refresh before the selection was fully covered.');
  if (!ctx.notes.size) ctx.notes.add('Public counters on fetched posts at the time of refresh.');
  const dated = selected.map(post => post.publishedAt).filter((v): v is string => !!v).sort();
  return { name: name || ctx.page.handle, followers, canonicalId, posts: selected,
    coverage: { limit: ctx.limit, fetched: selected.length, hasMore,
      incomplete: !complete || selected.some(post => post.views === null || post.likes === null || post.comments === null) || (ctx.mode === 'date' && unknownDates > 0), note: [...ctx.notes].join(' '),
      requestedMode: ctx.mode, from: ctx.from, to: ctx.to, scanned: ordered.length,
      oldest: dated[0] || null, newest: dated.at(-1) || null, unknownDates, complete, stopReason: ctx.stopReason,
      unavailableLikes: selected.filter(post => post.likes === null).length, hiddenLikes: selected.filter(post => post.likesReason === 'hidden').length,
      unavailableViews: selected.filter(post => post.views === null).length },
    overall: ctx.overall || emptyOverall(followers, 'Public lifetime view, like, comment and share totals are not returned for this platform. Selected-post totals are shown separately.'),
    provider: provider || ctx.settings.provider };
}

async function instagram(ctx: Context): Promise<PageFetchResult> {
  const sc = ctx.settings.provider === 'scrapecreators';
  const profileBody = await ctx.call(sc ? '/v1/instagram/profile' : '/api/v1/instagram/v1/fetch_user_info_by_username_v2',
    sc ? { handle: ctx.page.handle } : { username: ctx.page.handle });
  const holder = pick(profileBody, 'user');
  const user = object(holder.user || pick(profileBody, 'username', 'id', 'pk'));
  if (user.is_private === true) throw new Error('This Instagram account is private. Only public pages can be tracked.');
  const canonicalId = string(user.pk, user.id) || null;
  if (!sc && !canonicalId) throw new Error('TikHub could not resolve the Instagram user ID. Check the username or switch providers.');
  const name = string(user.full_name, user.username, ctx.page.handle);
  const followers = counter(ctx, user.follower_count, user.edge_followed_by?.count, user.followers);
  ctx.overall = { ...emptyOverall(followers, 'Instagram does not return a public account lifetime view total. Post totals below cover the selected posts.'),
    posts: counter(ctx, user.media_count, user.edge_owner_to_timeline_media?.count, user.posts_count) };
  const posts = new Map<string, Post>();
  let cursor = ''; let more = true; let incomplete = false; let olderPages = 0;
  const cursors = new Set<string>();
  while (more && needsMore(ctx, posts) && ctx.calls < MAX_CALLS) {
    try {
      const body = await ctx.call(sc ? '/v2/instagram/user/posts' : '/api/v1/instagram/v1/fetch_user_posts',
        sc ? { handle: ctx.page.handle, require_play_counts: true, next_max_id: cursor || undefined }
          : { user_id: canonicalId, count: 12, max_id: cursor || undefined });
      const feed = pick(body, 'items', 'edge_owner_to_timeline_media');
      const graph = object(feed.edge_owner_to_timeline_media);
      const items = Array.isArray(feed.items) ? feed.items : Array.isArray(graph.edges) ? graph.edges : null;
      if (!items) throw new Error('Unexpected Instagram feed response.');
      const added = append(posts, ctx, items, instagramPost);
      olderPages = olderPage(ctx, added) ? olderPages + 1 : 0;
      const next = string(feed.next_max_id, feed.paging_info?.max_id, graph.page_info?.end_cursor);
      more = Boolean(feed.more_available ?? feed.paging_info?.more_available ?? graph.page_info?.has_next_page ?? next);
      if (!more) break;
      if (olderPages >= 2) { ctx.stopReason = 'date-boundary'; break; }
      if (!next || next === cursor || cursors.has(next)) {
        incomplete = true; ctx.stopReason = 'cursor-stalled'; ctx.notes.add('The provider stopped advancing its pagination cursor.'); break;
      }
      cursors.add(next); cursor = next;
    } catch (error) {
      if (!posts.size) throw error;
      incomplete = true; ctx.stopReason = 'provider-error'; ctx.notes.add('Refresh stopped before all requested posts could be fetched. Refresh again later.'); break;
    }
  }
  if (more && needsMore(ctx, posts) && ctx.stopReason !== 'date-boundary' && ctx.calls >= MAX_CALLS) { incomplete = true; ctx.stopReason = 'request-limit'; ctx.notes.add('The refresh request limit was reached.'); }
  // When an entire selected batch lacks non-hidden likes, probe at most three public post details.
  // This is bounded enrichment, never a claim that absent likes are zero.
  const selected = [...posts.values()].filter(post => ctx.mode === 'posts' || (post.publishedAt && (!ctx.from || post.publishedAt >= ctx.from) && (!ctx.to || post.publishedAt < ctx.to)));
  if (sc && selected.length && selected.every(post => post.likes === null)) {
    for (const post of selected.filter(post => post.likesReason !== 'hidden' && /instagram\.com\/(p|reel)\//.test(post.url)).slice(0, 3)) {
      if (ctx.calls >= MAX_CALLS) break;
      try {
        const detail = await ctx.call('/v1/instagram/post', { url: post.url, include_play_count: false });
        const holder = pick(detail, 'xdt_shortcode_media', 'shortcode_media', 'media');
        const media = object(holder.xdt_shortcode_media || holder.shortcode_media || holder.media || holder);
        post.likes = counter(ctx, media.like_count, media.edge_media_preview_like?.count, media.edge_liked_by?.count);
        if (post.likes !== null) post.likesReason = null;
        post.comments ??= counter(ctx, media.comment_count, media.edge_media_to_parent_comment?.count);
      } catch { ctx.notes.add('Some public like-count lookups were unavailable.'); }
    }
  }
  ctx.notes.add('Instagram public views can exclude Facebook cross-post views.');
  return finish(ctx, name, followers, canonicalId, posts, more, incomplete);
}

async function tiktok(ctx: Context): Promise<PageFetchResult> {
  const sc = ctx.settings.provider === 'scrapecreators';
  const body = await ctx.call(sc ? '/v1/tiktok/profile' : '/api/v1/tiktok/web/fetch_user_profile',
    sc ? { handle: ctx.page.handle } : { uniqueId: ctx.page.handle });
  const holder = pick(body, 'userInfo', 'user', 'user_info');
  const info = object(holder.userInfo || holder.user_info || holder);
  const user = object(info.user || holder.user || info);
  if (user.privateAccount === true || user.is_private === true || user.secret === 1) {
    throw new Error('This TikTok account is private. Only public pages can be tracked.');
  }
  const stats = object(info.stats || holder.stats || user.stats);
  const secUid = string(user.secUid, user.sec_uid, info.secUid);
  const canonicalId = string(user.id, user.uid, user.user_id) || null;
  if (!sc && !secUid) throw new Error('TikHub could not resolve this TikTok profile. Check that the profile is public or switch providers.');
  const name = string(user.nickname, user.nickName, user.uniqueId, ctx.page.handle);
  const followers = counter(ctx, stats.followerCount, stats.follower_count, user.follower_count);
  ctx.overall = { ...emptyOverall(followers, 'TikTok does not return a public account lifetime view total. Selected-post totals are shown separately.'),
    posts: counter(ctx, stats.videoCount, stats.video_count, user.aweme_count),
    likes: counter(ctx, stats.heartCount, stats.heart, stats.digg_count, user.total_favorited) };
  const posts = new Map<string, Post>();
  let cursor = ''; let more = true; let incomplete = false; let olderPages = 0;
  const cursors = new Set<string>();
  while (more && needsMore(ctx, posts) && ctx.calls < MAX_CALLS) {
    try {
      const response = await ctx.call(sc ? '/v3/tiktok/profile/videos' : '/api/v1/tiktok/web/fetch_user_post',
        sc ? { handle: ctx.page.handle, sort_by: 'latest', region: 'US', include_pinned: true, max_cursor: cursor || undefined }
          : { secUid, count: 15, cursor: cursor || '0', coverFormat: 2 });
      const feed = pick(response, 'aweme_list', 'itemList', 'item_list');
      const items = feed.aweme_list ?? feed.itemList ?? feed.item_list;
      if (!Array.isArray(items)) throw new Error('Unexpected TikTok feed response.');
      const added = append(posts, ctx, items, tiktokPost);
      olderPages = olderPage(ctx, added) ? olderPages + 1 : 0;
      const next = string(feed.max_cursor, feed.cursor);
      const moreValue = feed.has_more ?? feed.hasMore;
      more = moreValue === undefined ? Boolean(next && next !== '0') : moreValue === true || moreValue === 1 || moreValue === '1';
      if (!more) break;
      if (olderPages >= 2) { ctx.stopReason = 'date-boundary'; break; }
      if (!next || next === cursor || cursors.has(next)) {
        incomplete = true; ctx.stopReason = 'cursor-stalled'; ctx.notes.add('The provider stopped advancing its pagination cursor.'); break;
      }
      cursors.add(next); cursor = next;
    } catch (error) {
      if (!posts.size) throw error;
      incomplete = true; ctx.stopReason = 'provider-error'; ctx.notes.add('Refresh stopped before all requested posts could be fetched. Refresh again later.'); break;
    }
  }
  if (more && needsMore(ctx, posts) && ctx.stopReason !== 'date-boundary' && ctx.calls >= MAX_CALLS) { incomplete = true; ctx.stopReason = 'request-limit'; ctx.notes.add('The refresh request limit was reached.'); }
  ctx.notes.add('TikTok public feeds may omit posts, even after pagination.');
  return finish(ctx, name, followers, canonicalId, posts, more, incomplete);
}

function channelId(page: PageInput): string {
  const match = `${page.handle} ${page.url}`.match(/(?:^|[\/\s])(UC[A-Za-z0-9_-]{22})(?:[\/\s?#]|$)/);
  return match?.[1] || '';
}

async function officialYouTube(ctx: Context): Promise<PageFetchResult> {
  const id = channelId(ctx.page);
  const channels = await ctx.call('/channels', { part: 'snippet,statistics,contentDetails',
    ...(id ? { id } : { forHandle: ctx.page.handle.replace(/^@/, '') }) }, true);
  const channel = object(channels.items?.[0]);
  if (!channel.id) throw new Error('YouTube could not find this channel. Use its public @handle or /channel/UC\u2026 link.');
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('YouTube did not return a public uploads playlist for this channel.');
  const followers = channel.statistics?.hiddenSubscriberCount === true ? null : counter(ctx, channel.statistics?.subscriberCount);
  ctx.overall = { views: counter(ctx, channel.statistics?.viewCount), posts: counter(ctx, channel.statistics?.videoCount), followers,
    likes: null, comments: null, shares: null, note: 'Lifetime channel views and public upload count returned by YouTube. These are separate from the selected-post totals.' };
  const posts = new Map<string, Post>();
  let token = ''; let more = true; let incomplete = false; let olderPages = 0;
  const seen = new Set<string>();
  while (more && needsMore(ctx, posts) && ctx.calls < MAX_CALLS - 1) {
    try {
      const playlist = await ctx.call('/playlistItems', { part: 'contentDetails', playlistId: uploads,
        maxResults: Math.min(50, (ctx.mode === 'date' ? ctx.scanLimit : ctx.limit) - posts.size), pageToken: token || undefined }, true);
      if (!Array.isArray(playlist.items)) throw new Error('Unexpected YouTube upload response.');
      const ids = playlist.items.map((item: Json) => string(item.contentDetails?.videoId)).filter(Boolean);
      if (ids.length) {
        const details = await ctx.call('/videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') }, true);
        if (!Array.isArray(details.items)) throw new Error('Unexpected YouTube statistics response.');
        const added = append(posts, ctx, details.items, youtubePost);
        olderPages = olderPage(ctx, added) ? olderPages + 1 : 0;
        if (details.items.length < ids.length) { incomplete = true; ctx.notes.add('Some uploads were unavailable from YouTube.'); }
      }
      const next = string(playlist.nextPageToken);
      more = Boolean(next);
      if (!more) break;
      if (olderPages >= 2) { ctx.stopReason = 'date-boundary'; break; }
      if (seen.has(next) || next === token) { incomplete = true; ctx.stopReason = 'cursor-stalled'; ctx.notes.add('YouTube stopped advancing its pagination cursor.'); break; }
      seen.add(next); token = next;
    } catch (error) {
      if (!posts.size) throw error;
      incomplete = true; ctx.stopReason = 'provider-error'; ctx.notes.add('Some YouTube uploads could not be refreshed.'); break;
    }
  }
  if (more && needsMore(ctx, posts) && ctx.stopReason !== 'date-boundary' && ctx.calls >= MAX_CALLS - 1) { incomplete = true; ctx.stopReason = 'request-limit'; }
  ctx.notes.add('Includes public uploads of all types. YouTube does not expose public share counts.');
  return finish(ctx, string(channel.snippet?.title, ctx.page.handle), followers,
    string(channel.id), posts, more, incomplete, 'youtube-official');
}

async function unofficialYouTube(ctx: Context): Promise<PageFetchResult> {
  const sc = ctx.settings.provider === 'scrapecreators';
  const id = channelId(ctx.page);
  if (!sc && !id) throw new Error('For YouTube @handles, add a free YouTube Data API key in Settings. With TikHub alone, paste the channel\u2019s /channel/UC\u2026 link.');
  const profileBody = await ctx.call(sc ? '/v1/youtube/channel' : '/api/v1/youtube/web_v2/get_channel_description',
    sc ? { ...(id ? { channelId: id } : { handle: ctx.page.handle }) }
      : { channel_id: id, language_code: 'en-US', country_code: 'US', need_format: true });
  const profile = pick(profileBody, 'name', 'subscriberCount', 'title', 'subscriber_count', 'channel');
  const channel = object(profile.channel && typeof profile.channel === 'object' ? profile.channel : profile);
  const name = string(channel.name, channel.title, ctx.page.handle);
  const followers = counter(ctx, channel.subscriberCount, channel.subscriber_count, channel.subscriberCountText);
  ctx.overall = { views: counter(ctx, channel.viewCountInt, channel.viewCount, channel.viewCountText, channel.view_count, channel.view_count_text),
    posts: counter(ctx, channel.videoCount, channel.videoCountText, channel.video_count), followers,
    likes: null, comments: null, shares: null, note: 'Public channel lifetime totals returned by the provider. Abbreviated public labels may be rounded. Selected-post totals are separate.' };
  const canonicalId = string(channel.channelId, channel.channel_id, channel.id, id) || null;
  const posts = new Map<string, Post>();
  const feeds = [{ kind: 'videos', token: '', more: true, seen: new Set<string>(), count: 0, olderPages: 0, boundary: false },
    { kind: 'shorts', token: '', more: true, seen: new Set<string>(), count: 0, olderPages: 0, boundary: false }];
  let incomplete = false;
  // Inspect each tab so a Shorts-only or long-form-only account still works.
  while (ctx.calls < MAX_CALLS && posts.size < ctx.scanLimit && feeds.some(feed => feed.more && (ctx.mode === 'date' || feed.count < ctx.limit))) {
    for (const feed of feeds) {
      if (!feed.more || (ctx.mode === 'posts' && feed.count >= ctx.limit) || ctx.calls >= MAX_CALLS || posts.size >= ctx.scanLimit) continue;
      try {
        const body = await ctx.call(sc
          ? feed.kind === 'shorts' ? '/v1/youtube/channel/shorts' : '/v1/youtube/channel-videos'
          : feed.kind === 'shorts' ? '/api/v1/youtube/web_v2/get_channel_shorts' : '/api/v1/youtube/web_v2/get_channel_videos',
          sc ? { ...(canonicalId ? { channelId: canonicalId } : { handle: ctx.page.handle }),
            sort: feed.kind === 'shorts' ? 'newest' : 'latest', continuationToken: feed.token || undefined }
            : { channel_id: id, language_code: 'en-US', country_code: 'US', need_format: true,
              continuation_token: feed.token || undefined });
        const data = pick(body, feed.kind);
        const items = data[feed.kind];
        if (!Array.isArray(items)) throw new Error('Unexpected YouTube feed response.');
        const before = posts.size;
        const added = append(posts, ctx, items, youtubePost);
        feed.olderPages = olderPage(ctx, added) ? feed.olderPages + 1 : 0;
        feed.count += items.length;
        const next = string(data.continuationToken, data.continuation_token);
        feed.more = Boolean(data.has_more ?? next);
        if (feed.more && feed.olderPages >= 2) { feed.boundary = true; feed.more = false; }
        if (feed.more && (!next || next === feed.token || feed.seen.has(next))) {
          incomplete = true; ctx.stopReason = 'cursor-stalled'; feed.more = false; ctx.notes.add('A YouTube tab stopped advancing its pagination cursor.');
        }
        if (next) feed.seen.add(next);
        feed.token = next;
        if (posts.size === before && !items.length && !feed.more) feed.count = ctx.limit;
      } catch {
        // A failed tab is different from an empty tab; never advertise complete coverage.
        incomplete = true; ctx.stopReason = 'provider-error'; feed.more = false;
        ctx.notes.add(`The YouTube ${feed.kind} tab could not be fetched. Refresh later or add a free YouTube API key.`);
      }
    }
  }
  if (!posts.size && incomplete) throw new Error('The provider could not return this channel\u2019s videos. Add a free YouTube Data API key in Settings or try again later.');
  const more = feeds.some(feed => feed.more);
  if (ctx.mode === 'date' && !more && !incomplete && feeds.some(feed => feed.boundary)) ctx.stopReason = 'date-boundary';
  if (ctx.calls >= MAX_CALLS && more) { incomplete = true; ctx.notes.add('The refresh request limit was reached.'); }
  if ([...posts.values()].some(post => !post.publishedAt) && posts.size > ctx.limit) {
    ctx.notes.add('Both YouTube tabs were sampled; unavailable dates prevent a precise newest-first merge.');
  }
  ctx.notes.add('Both videos and Shorts are fetched. Listing responses may omit likes/comments; add a free YouTube API key for fuller metrics.');
  return finish(ctx, name, followers, canonicalId, posts, more, incomplete);
}

export async function fetchPage(page: PageInput, settings: ProviderSettings, request: Request): Promise<PageFetchResult> {
  const ctx = normalizationContext({ ...page, handle: page.handle.replace(/^@/, '').trim() });
  ctx.settings = settings;
  ctx.mode = settings.scope?.mode === 'date' ? 'date' : 'posts';
  ctx.limit = ctx.mode === 'date' ? 1000 : Math.min(1000, Math.max(1, Math.floor(Number(settings.scope?.postLimit ?? settings.postLimit) || 30)));
  ctx.from = ctx.mode === 'date' ? normalizeDate(settings.scope?.from) : null;
  ctx.to = ctx.mode === 'date' ? normalizeDate(settings.scope?.to) : null;
  if (ctx.mode === 'date' && (!ctx.from || !ctx.to || ctx.from >= ctx.to)) throw new Error('Choose a valid publication date range before refreshing.');
  ctx.call = async (path, params = {}, official = false) => {
    if (ctx.calls >= MAX_CALLS) throw new Error('The refresh request limit was reached.');
    const key = official ? settings.youtubeKey : settings.apiKey;
    if (!key?.trim()) throw new Error(`Add your ${official ? 'YouTube Data API' : settings.provider === 'tikhub' ? 'TikHub' : 'ScrapeCreators'} key in Settings before refreshing.`);
    const url = new URL(path, official ? 'https://www.googleapis.com/youtube/v3/'
      : settings.provider === 'tikhub' ? 'https://api.tikhub.io' : 'https://api.scrapecreators.com');
    // Leading slashes are deliberate on vendor routes; Google uses its v3 base path.
    if (official) url.pathname = `/youtube/v3${path}`;
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    if (official) url.searchParams.set('key', key.trim());
    const headers: Record<string, string> = official ? {} : settings.provider === 'tikhub'
      ? { Authorization: `Bearer ${key.trim()}` } : { 'x-api-key': key.trim() };
    ctx.calls++;
    const body = await request(url.toString(), headers);
    payloadError(body);
    return object(body);
  };
  if (page.platform === 'instagram') return instagram(ctx);
  if (page.platform === 'tiktok') return tiktok(ctx);
  if (page.platform === 'youtube') return settings.youtubeKey?.trim() ? officialYouTube(ctx) : unofficialYouTube(ctx);
  throw new Error('This platform is not supported. Add an Instagram, TikTok, or YouTube page.');
}
