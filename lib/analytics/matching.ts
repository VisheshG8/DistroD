import type { AnalyticsPage, AnalyticsPlatform, AnalyticsPost, AnalyzedPost, PageAnalysis } from './types';

const DAY = 86_400_000;
/** Page × Content matching. Nothing here links posts: suggestions wait in a review queue until the owner confirms them.
 * windowDays and the duration gate are hard limits; a post without usable caption text needs a near-exact duration (or the same audio) within blindDays. */
export const MATCH_RULES = { windowDays: 21, blindDays: 7, durationGate: 1.5, durationShare: 0.03, blindDuration: 0.1, minText: 0.5, minTokens: 3, maxTokens: 60, audioBonus: 0.1, blindCap: 0.7, likely: 0.85, possible: 0.65 } as const;
export type MatchBand = 'likely' | 'possible';
export type MatchMember = { pageId: string; postId: string; post: AnalyticsPost; linked: boolean };
export type MatchSuggestion = { key: string; groupId: string | null; members: MatchMember[]; score: number; band: MatchBand; reasons: string[] };
export type MatrixMeasure = 'gained' | 'published' | 'day7';
export type MatrixCell = { post: AnalyzedPost; value: number | null; lagDays: number | null };
export type MatrixRow = { groupId: string; title: string; first: AnalyzedPost; thumbnail: string | null; cells: Map<string, MatrixCell>; total: number | null; known: number; best: string | null; platforms: AnalyticsPlatform[] };
export type ContentMatrix = { rows: MatrixRow[]; pageIds: string[]; pageTotals: Map<string, number | null>; wins: Map<string, number>; total: number | null; mixedPlatforms: boolean };
type Item = { post: AnalyticsPost; pageId: string; at: number; tokens: string[]; set: Set<string>; duration: number | null; kind: string | null; anchor: string | null };
type Edge = { a: number; b: number; score: number; reasons: string[] };

/** ca_ ids are confirmed content groups; solo_ marks a post the owner said is unique; null is unreviewed. */
export const isContentGroup = (id: string | null | undefined): id is string => typeof id === 'string' && id.startsWith('ca_');
export const linkKey = (pageId: string, postId: string) => pageId + '\u0000' + postId;
const time = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
// English and common Hinglish filler words carry no signal about which video it is.
const stopWords = new Set('a an the and or but of to in on at for with by from is are was were be been this that these those it its your you my our i we me us so as if not no do does did how what why when who which just about into out up than then there here very can will hai ka ki ke ko se me mein aur ye yeh wo woh kya bhi toh na'.split(' '));
const altText = /^(photo|video) (by|shared by) |may be an? (image|video|graphic)/i;
const ctaLine = /^(follow|credit|credits|cc|dm|link in bio|tag|subscribe|like and|save this|share this)\b/;

/** Lowercase caption text without URLs, hashtags, mentions, emoji, punctuation, call-to-action lines or Instagram's generated alt text. */
export function normalizeCaption(text: string | null | undefined) {
  if (!text || altText.test(text)) return '';
  return text.normalize('NFKC').toLowerCase().split(/\r?\n/).map(line => line.trim()).filter((line, index) => line && (index === 0 || !ctaLine.test(line))).join(' ')
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ').replace(/[#@][\p{L}\p{N}_.]+/gu, ' ').replace(/['’]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
/** Distinct meaningful words, in caption order. */
export const captionTokens = (text: string | null | undefined) => [...new Set(normalizeCaption(text).split(' ').filter(token => token && !stopWords.has(token)))].slice(0, MATCH_RULES.maxTokens);
/** Mean of token Jaccard and containment, so a repost that adds a sentence still scores well. Null when a caption is too short to tell. */
export const textSimilarity = (a: string[], b: string[]) => overlap(a, new Set(a), b);
function overlap(a: string[], set: Set<string>, b: string[]) {
  if (Math.min(a.length, b.length) < MATCH_RULES.minTokens) return null;
  let shared = 0; for (const token of b) if (set.has(token)) shared++;
  return (shared / (a.length + b.length - shared) + shared / Math.min(a.length, b.length)) / 2;
}
// Carousels and photos only match the same format; reels, shorts and videos are one kind. Unknown types match anything.
const kindOf = (type: string | null | undefined) => !type ? null : type === 'carousel' || type === 'image' ? type : 'video';
const seconds = (value: number) => (Math.round(value * 100) / 100) + ' s';
const days = (value: number) => value < 1 ? 'same day' : (Math.round(value * 10) / 10) + (value < 1.05 ? ' day' : ' days') + ' apart';
const round = (value: number) => Math.round(value * 1000) / 1000;

const durationGate = (a: Item, b: Item) => Math.max(MATCH_RULES.durationGate, MATCH_RULES.durationShare * Math.max(a.duration ?? 0, b.duration ?? 0));
/** The cheap hard gates, checked before any caption work: different pages, compatible format, publish window and length. */
const gated = (a: Item, b: Item) => a.pageId !== b.pageId && !(a.kind && b.kind && a.kind !== b.kind) && Math.abs(a.at - b.at) <= MATCH_RULES.windowDays * DAY && (a.duration === null || b.duration === null || Math.abs(a.duration - b.duration) <= durationGate(a, b));
/** Confidence that two posts on different pages are the same content, with plain-language reasons, or null when a hard gate fails or it is below a possible match. */
function pairScore(a: Item, b: Item): { score: number; reasons: string[] } | null {
  if (!gated(a, b)) return null;
  const gap = Math.abs(a.at - b.at) / DAY, delta = a.duration !== null && b.duration !== null ? Math.abs(a.duration - b.duration) : null, gate = durationGate(a, b);
  const audio = !!a.post.audioId && a.post.audioId === b.post.audioId, text = overlap(a.tokens, a.set, b.tokens), timeSim = 1 - gap / MATCH_RULES.windowDays;
  const reasons = () => [text === null ? 'Caption too short to compare' : `Caption ${Math.round(text * 100)}% match`, ...(delta !== null ? [`${seconds(a.duration!)} vs ${seconds(b.duration!)}`] : []), days(gap), ...(audio ? ['Same audio'] : [])];
  if (text === null) {
    // Without words to compare, only a near-identical length (or the same audio) shortly after counts, and never as a likely match.
    if (gap > MATCH_RULES.blindDays || !(audio || (delta !== null && delta <= MATCH_RULES.blindDuration))) return null;
    const score = round(Math.min(MATCH_RULES.blindCap, 0.45 + (delta !== null ? 0.15 * (1 - delta / gate) : 0) + 0.1 * (1 - gap / MATCH_RULES.blindDays) + (audio ? MATCH_RULES.audioBonus : 0)));
    return score >= MATCH_RULES.possible ? { score, reasons: reasons() } : null;
  }
  if (text < MATCH_RULES.minText) return null;
  const weight = 0.6 + 0.15 + (delta !== null ? 0.25 : 0), score = (0.6 * text + 0.15 * timeSim + (delta !== null ? 0.25 * (1 - delta / gate) : 0)) / weight;
  const total = round(Math.min(1, score + (audio ? MATCH_RULES.audioBonus : 0)));
  return total >= MATCH_RULES.possible ? { score: total, reasons: reasons() } : null;
}

/** Candidate groups of the same content on different pages, best first. Unreviewed posts can form new groups or join a confirmed
 * (ca_) group; solo_ posts never come back. Pairs are only scored within shared caption words, 0.1 s duration buckets or audio ids
 * inside the publish window, so the work grows with the posts per bucket instead of every pair of posts. */
export function suggestMatches(pages: AnalyticsPage[]): MatchSuggestion[] {
  const items: Item[] = [], anchorPages = new Map<string, Set<string>>();
  for (const page of pages) for (const post of page.posts) {
    const id = post.sourceAssetId ?? null, at = time(post.publishedAt);
    if (isContentGroup(id)) { const set = anchorPages.get(id) || new Set<string>(); set.add(page.id); anchorPages.set(id, set); }
    if ((id !== null && !isContentGroup(id)) || !Number.isFinite(at)) continue;
    const tokens = captionTokens(post.title);
    items.push({ post, pageId: page.id, at, tokens, set: new Set(tokens), duration: known(post.durationSeconds) && post.durationSeconds > 0 ? post.durationSeconds : null, kind: kindOf(post.type), anchor: id });
  }
  if (!items.some(item => !item.anchor)) return [];
  // Words used by many posts (a page's sign-off, a series name) are not blocking keys; each caption still keeps its two rarest words.
  const frequency = new Map<string, number>();
  items.forEach(item => item.tokens.forEach(token => frequency.set(token, (frequency.get(token) || 0) + 1)));
  const common = Math.max(50, items.length * 0.02), buckets = new Map<string, number[]>(), captioned = new Map<string, number[]>();
  const add = (key: string, index: number, map = buckets) => { const list = map.get(key); if (list) list.push(index); else map.set(key, [index]); };
  items.forEach((item, index) => {
    const tenth = item.duration === null ? null : Math.round(item.duration * 10);
    if (item.tokens.length >= MATCH_RULES.minTokens) { const rarest = [...item.tokens].sort((a, b) => frequency.get(a)! - frequency.get(b)! || a.localeCompare(b)).slice(0, 2); new Set([...item.tokens.filter(token => frequency.get(token)! <= common), ...rarest]).forEach(token => add('t:' + token, index)); if (tenth !== null) add('d:' + tenth, index, captioned); }
    else if (tenth !== null) [tenth - 1, tenth, tenth + 1].forEach(key => add('d:' + key, index));
    if (item.post.audioId) add('a:' + item.post.audioId, index);
  });
  const seen = new Set<number>(), edges: Edge[] = [];
  const consider = (x: number, y: number) => {
    const a = Math.min(x, y), b = Math.max(x, y), pair = a * items.length + b;
    if ((items[a].anchor && items[b].anchor) || !gated(items[a], items[b]) || seen.has(pair)) return;
    seen.add(pair); const result = pairScore(items[a], items[b]);
    if (result) edges.push({ a, b, ...result });
  };
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => items[a].at - items[b].at);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && items[list[j]].at - items[list[i]].at <= MATCH_RULES.windowDays * DAY; j++) consider(list[i], list[j]);
  }
  // A post without caption words is also compared with captioned posts of nearly the same length (a repost whose caption was dropped).
  for (const [key, list] of buckets) {
    const others = key.startsWith('d:') ? captioned.get(key) : undefined;
    if (others) for (const x of list) for (const y of others) if (Math.abs(items[x].at - items[y].at) <= MATCH_RULES.blindDays * DAY) consider(x, y);
  }
  // Greedy clustering, strongest pairs first. A group never holds two posts from one page, two confirmed groups never merge, and a
  // possible pair never extends a likely group (one weak link would hide a strong match); once that group is confirmed it can join it.
  const parent = items.map((_, index) => index), find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const groups = new Map<number, { members: number[]; pages: Set<string>; anchor: string | null; weakest: Edge | null }>(), anchorRoot = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.anchor && anchorRoot.has(item.anchor)) { const root = anchorRoot.get(item.anchor)!; parent[index] = root; groups.get(root)!.members.push(index); return; }
    if (item.anchor) anchorRoot.set(item.anchor, index);
    groups.set(index, { members: [index], pages: item.anchor ? new Set(anchorPages.get(item.anchor)) : new Set([item.pageId]), anchor: item.anchor, weakest: null });
  });
  edges.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  for (const edge of edges) {
    const ra = find(edge.a), rb = find(edge.b), a = groups.get(ra)!, b = groups.get(rb)!;
    if (ra === rb || (a.anchor && b.anchor) || [...b.pages].some(page => a.pages.has(page)) || (edge.score < MATCH_RULES.likely && [a.weakest, b.weakest].some(value => value && value.score >= MATCH_RULES.likely))) continue;
    parent[rb] = ra; groups.delete(rb);
    groups.set(ra, { members: [...a.members, ...b.members], pages: new Set([...a.pages, ...b.pages]), anchor: a.anchor || b.anchor, weakest: [a.weakest, b.weakest, edge].filter((value): value is Edge => !!value).sort((x, y) => x.score - y.score)[0] });
  }
  const suggestions: MatchSuggestion[] = [];
  for (const group of groups.values()) {
    if (!group.weakest || !group.members.some(index => !items[index].anchor)) continue;
    const members = group.members.map(index => items[index]).sort((a, b) => a.at - b.at || a.pageId.localeCompare(b.pageId)).map(item => ({ pageId: item.pageId, postId: item.post.id, post: item.post, linked: !!item.anchor }));
    const score = group.weakest.score;
    suggestions.push({ key: members.map(member => linkKey(member.pageId, member.postId)).join('\u0001'), groupId: group.anchor, members, score, band: score >= MATCH_RULES.likely ? 'likely' : 'possible', reasons: group.weakest.reasons });
  }
  return suggestions.sort((a, b) => b.score - a.score || time(a.members[0].post.publishedAt) - time(b.members[0].post.publishedAt) || a.key.localeCompare(b.key));
}

/** Local link changes (confirmed in the review queue, or demo-only) laid over the loaded history without refetching it. */
export function applyContentLinks<T extends { pages: AnalyticsPage[] }>(dataset: T | null, links: Record<string, string | null>): T | null {
  if (!dataset || !Object.keys(links).length) return dataset;
  return { ...dataset, pages: dataset.pages.map(page => page.posts.some(post => linkKey(page.id, post.id) in links) ? { ...page, posts: page.posts.map(post => { const key = linkKey(page.id, post.id); return key in links ? { ...post, sourceAssetId: links[key] } : post; }) } : page) };
}

/** First line of a caption without hashtags, mentions or emoji, for a readable row title. */
export const contentTitle = (title: string | null | undefined) => { const line = (title || '').split(/\r?\n/)[0].replace(/[#@][\p{L}\p{N}_.]+|\p{Extended_Pictographic}|[\u200d\ufe0f]/gu, '').replace(/\s+/g, ' ').trim(); return line || (title || '').trim(); };
const measured = (post: AnalyzedPost, measure: MatrixMeasure) => { const value = measure === 'gained' ? post.viewsGained : measure === 'published' ? post.views : post.fixedAgeViews; return known(value) ? value : null; };

/** The spec's Page × Content table: one row per confirmed content group with a post in the dates (or views gained in them),
 * one column per page that carries any of them, a Total per row and per page. Unknown cells stay null, never zero. */
export function contentMatrix(pages: PageAnalysis[], measure: MatrixMeasure): ContentMatrix {
  const grouped = new Map<string, AnalyzedPost[]>();
  for (const row of pages) for (const post of row.posts) if (isContentGroup(post.sourceAssetId)) { const list = grouped.get(post.sourceAssetId) || []; list.push(post); grouped.set(post.sourceAssetId, list); }
  const rows: MatrixRow[] = [];
  for (const [groupId, posts] of grouped) {
    if (posts.length < 2 || !posts.some(post => post.inRange || (measure === 'gained' && (post.viewsGained ?? 0) > 0))) continue;
    const ordered = [...posts].sort((a, b) => (time(a.publishedAt) || Infinity) - (time(b.publishedAt) || Infinity) || a.pageId.localeCompare(b.pageId)), first = ordered[0], start = time(first.publishedAt);
    const cells = new Map<string, MatrixCell>(ordered.map(post => [post.pageId, { post, value: measured(post, measure), lagDays: Number.isFinite(start) && Number.isFinite(time(post.publishedAt)) ? (time(post.publishedAt) - start) / DAY : null }]));
    const values = [...cells.values()].filter(cell => cell.value !== null), best = values.length > 1 ? values.reduce((top, cell) => cell.value! > top.value! ? cell : top) : null;
    rows.push({ groupId, title: contentTitle(first.title), first, thumbnail: ordered.find(post => post.thumbnail && /^https:\/\//i.test(post.thumbnail))?.thumbnail || null, cells,
      total: values.length ? values.reduce((sum, cell) => sum + cell.value!, 0) : null, known: values.length, best: best?.post.pageId ?? null, platforms: [...new Set(ordered.map(post => post.pagePlatform))] });
  }
  rows.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.title.localeCompare(b.title) || a.groupId.localeCompare(b.groupId));
  const used = new Set(rows.flatMap(row => [...row.cells.keys()])), pageIds = pages.map(row => row.page.id).filter(id => used.has(id));
  const pageTotals = new Map<string, number | null>(), wins = new Map<string, number>();
  for (const id of pageIds) { const values = rows.map(row => row.cells.get(id)?.value).filter(known); pageTotals.set(id, values.length ? values.reduce((a, b) => a + b, 0) : null); wins.set(id, rows.filter(row => row.best === id).length); }
  const totals = rows.map(row => row.total).filter(known);
  return { rows, pageIds, pageTotals, wins, total: totals.length ? totals.reduce((a, b) => a + b, 0) : null, mixedPlatforms: new Set(rows.flatMap(row => row.platforms)).size > 1 };
}
