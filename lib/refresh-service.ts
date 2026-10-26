import 'server-only';
import { ApiError, database, decrypt, pageRecord, preferences, query } from '@/lib/server';
import type { PageFetchResult, PageInput } from '@/lib/providers';
import { parsePage, type Platform } from '@/lib/pages';
import { createProviderRequest, DEFAULT_PROVIDER_ORDER, fetchSocialPage, getConfiguredKeys } from '@/lib/social-provider';
import { normalizeScope, postDates, scopeKey, selectPosts, snapshotCovers, snapshotMatches, type Scope } from '@/lib/scope';

type Row = Record<string, unknown>;
export type RefreshOptions = { scheduled?: boolean; deadline?: number; cacheMaxAgeMs?: number };
export type RefreshOutcome = { ok: true; page: ReturnType<typeof pageRecord>; cached: boolean };
const missingSetup = new Set(['42P01', '42883', 'PGRST202', 'PGRST205']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Old workspaces continue to refresh with their saved key while upgrading. */
export async function providerConfiguration(): Promise<Row | null> {
  const { data, error } = await database().from('provider_settings').select('*').eq('id', true).maybeSingle<Row>();
  if (error && missingSetup.has(error.code || '')) return null;
  if (error) throw error;
  return data;
}

function providerFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'DEADLINE' || code === 'REQUEST_LIMIT') return new ApiError('Refresh reached its safety limit. Try a smaller post count or narrower date range.');
  if (code === 'BUDGET_LIMIT') return new ApiError('The monthly data request or estimated cost limit has been reached. Your saved data is still available.');
  if (code === 'REQUEST_BLOCKED') return new ApiError('Monthly request cap reached or could not be checked. You can review it in Settings.');
  if (code === 'CONFIGURATION') return new ApiError('No configured data provider is available for this platform. Ask the administrator to check the provider keys.', 503);
  return new ApiError(error instanceof Error ? error.message.slice(0, 350) : 'The provider could not refresh this page.', 502);
}

function cachedResult(cache: Row, scope: Scope, maximumAge: number): { result: PageFetchResult; at: string } | null {
  const at = typeof cache.fetched_at === 'string' ? cache.fetched_at : '';
  const age = Date.now() - Date.parse(at);
  if (!Number.isFinite(age) || age < 0 || age >= maximumAge) return null;
  const payload = cache.latest_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const result = (payload as { result?: PageFetchResult }).result;
  if (!result || !Array.isArray(result.posts) || !result.coverage) return null;
  const complete = snapshotCovers(result.coverage, scope);
  if (!complete && !snapshotMatches(result.coverage, scope)) return null;
  const posts = selectPosts(result.posts, scope), dates = postDates(posts);
  return { at, result: { ...result, posts, coverage: { ...result.coverage, ...dates, limit: scope.postLimit, fetched: posts.length,
    requestedMode: scope.mode, from: scope.from, to: scope.to, complete, incomplete: !complete } } };
}

/** Shared public-data cache. Owner-specific metadata and imported history never enter it. */
async function accountCache(db: ReturnType<typeof database>, page: Row): Promise<Row> {
  // Imported native IDs and cache pointers are owner data, not proof of a public identity.
  await query(db.from('tracked_accounts').upsert({ platform: page.platform, handle: page.handle }, { onConflict: 'platform,handle', ignoreDuplicates: true }));
  const account = await query(db.from('tracked_accounts').select('*').eq('platform', page.platform).eq('handle', page.handle).maybeSingle<Row>());
  if (!account) throw new ApiError('This page could not be queued for refresh. Please retry.', 503);
  if (page.tracked_account_id !== account.id) await query(db.from('pages').update({ tracked_account_id: account.id }).eq('id', page.id).eq('owner', page.owner));
  return account;
}

/** All interactive, first-fetch and scheduled refreshes use this owner-bound service. */
export async function refreshWorkspacePage(user: string, pageId: unknown, scopeInput?: unknown, options: RefreshOptions = {}): Promise<RefreshOutcome> {
  if (typeof pageId !== 'string' || !uuid.test(pageId)) throw new ApiError('Choose a valid page to refresh.');
  const db = database();
  let lockedId: string | null = null, mergedLockId: string | null = null, cacheLockId: string | null = null, lease = 0;
  try {
    const [page, membership] = await Promise.all([
      query(db.from('pages').select('*').eq('id', pageId).eq('owner', user).maybeSingle<Row>()),
      query(db.from('memberships').select('page_id').eq('page_id', pageId).eq('owner', user).limit(1).maybeSingle<Row>()),
    ]);
    if (!page || !membership) throw new ApiError('Page not found.', 404);
    if (options.scheduled && page.active === false) throw new ApiError('This page is paused.', 409);
    let identity: ReturnType<typeof parsePage>;
    try {
      if (!['instagram', 'tiktok', 'youtube'].includes(String(page.platform))) throw new Error();
      identity = parsePage(String(page.handle), page.platform as Platform);
      if (identity.platform !== page.platform) throw new Error();
    } catch { throw new ApiError('This saved profile handle is invalid. Correct it before refreshing.'); }
    const settings = await preferences(user);
    let scope: Scope;
    try { scope = normalizeScope(scopeInput, Number(settings.post_limit)); }
    catch (error) { throw new ApiError(error instanceof Error ? error.message : 'Choose a valid data range.'); }
    const current = pageRecord(page), oldCoverage = current.coverage;
    if (page.last_synced_at && page.overall && Date.now() - Date.parse(String(page.last_synced_at)) < 300000 && snapshotCovers(oldCoverage, scope)) return { ok: true, page: current, cached: true };

    const config = await providerConfiguration();
    const keys = getConfiguredKeys();
    const configuredOrder = (config?.provider_order as Record<string, unknown> | undefined)?.[String(page.platform)];
    const providerOrder = Array.isArray(configuredOrder) ? configuredOrder.filter((value): value is string => typeof value === 'string') : DEFAULT_PROVIDER_ORDER[String(page.platform) as keyof typeof DEFAULT_PROVIDER_ORDER] || [];
    // Only decrypt a shared key for its selected platform; an unused or damaged
    // credential must not interfere with another platform's refresh.
    if (page.platform === 'instagram' && providerOrder.includes('instagram-looter') && config?.rapidapi_key) {
      try { keys['instagram-looter'] = await decrypt(config.rapidapi_key); }
      catch (error) {
        // A damaged fallback credential must not disable a healthy shared
        // provider. With no shared alternative, fail instead of spending an
        // owner's personal key in response to an administrator's broken key.
        if (!providerOrder.some(id => id !== 'instagram-looter' && Boolean(keys[id]?.trim()))) throw error;
      }
    }
    const centrallyFunded = providerOrder.some(id => Boolean(keys[id]));
    if (centrallyFunded && !config) throw new ApiError('Apply the analytics history migration before using the configured shared providers.', 503);
    let order = providerOrder;
    if (!centrallyFunded) {
      if (options.scheduled) throw new ApiError('No shared data provider is configured for this platform. Scheduled refresh uses administrator-configured providers.', 503);
      const apiKey = await decrypt(settings.api_key), youtubeKey = await decrypt(settings.youtube_key);
      const provider = String(settings.provider);
      if (page.platform === 'youtube' ? !youtubeKey && !apiKey : !apiKey) throw new ApiError('No data provider is configured for this page. Add your API key in Collections & backups, or ask the administrator to configure a shared provider.');
      keys[provider] = apiKey; keys['youtube-official'] = youtubeKey;
      order = page.platform === 'youtube' && youtubeKey ? ['youtube-official', provider] : [provider];
    }

    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 180000);
    if (deadline <= Date.now()) throw new ApiError('Refresh reached its safety limit. Please retry.');
    lease = Date.now() + 300000;
    const locked = await query(db.from('pages').update({ locked_until: lease }).eq('id', page.id).eq('owner', user).lt('locked_until', Date.now()).select('id'));
    if (!locked?.length) throw new ApiError('This page is already refreshing. Try again in a moment.', 409);
    lockedId = String(page.id);
    let result: PageFetchResult, observedAt: string, cached = false;
    let cache = config ? await accountCache(db, { ...page, ...identity }) : null;
    let available = cache && (!page.last_synced_at || Date.parse(String(page.last_synced_at)) <= Date.parse(String(cache.fetched_at)))
      ? cachedResult(cache, scope, options.cacheMaxAgeMs ?? 300000) : null;
    if (!available && cache) {
      const acquired = await query(db.from('tracked_accounts').update({ locked_until: lease, last_attempt_at: new Date().toISOString(), status: 'refreshing' })
        .eq('id', cache.id).lt('locked_until', Date.now()).select('id'));
      if (!acquired?.length) throw new ApiError('This public page is already refreshing. Try again in a moment.', 409);
      cacheLockId = String(cache.id);
      // A concurrent fetch can finish between the first cache read and our lease acquisition.
      cache = await query(db.from('tracked_accounts').select('*').eq('id', cache.id).maybeSingle<Row>()) || cache;
      available = !page.last_synced_at || Date.parse(String(page.last_synced_at)) <= Date.parse(String(cache.fetched_at))
        ? cachedResult(cache, scope, options.cacheMaxAgeMs ?? 300000) : null;
      if (available) {
        await query(db.from('tracked_accounts').update({ locked_until: 0, status: 'ready', error: null }).eq('id', cache.id).eq('locked_until', lease));
        cacheLockId = null;
      }
    }
    if (available) { result = available.result; observedAt = available.at; cached = true; }
    else {
      const month = new Date().toISOString().slice(0, 7), requestLimit = Number(settings.request_limit);
      if (!Number.isSafeInteger(requestLimit) || requestLimit < 1) throw new ApiError('Choose a valid monthly request cap in Settings.');
      const request = createProviderRequest({ db: config ? db : undefined, platform: String(page.platform) as 'instagram' | 'youtube' | 'tiktok', deadline, maxCalls: 70, reserveGlobal: centrallyFunded, owner: centrallyFunded ? undefined : user,
        beforeRequest: centrallyFunded ? undefined : async () => {
          if (!await query(db.rpc('desk_reserve_usage', { p_owner: user, p_month: month, p_limit: requestLimit }))) throw new ApiError('Monthly request cap reached. You can adjust it in Settings.');
        },
      });
      try { result = await fetchSocialPage({ id: String(page.id), ...identity } as PageInput,
        { scope, providerOrder: order, keys, request }); }
      catch (error) { throw providerFailure(error); }
      if (page.last_synced_at && snapshotMatches(oldCoverage, scope) && result.coverage.complete === false && result.posts.length < current.posts.length) throw new ApiError('The provider returned an incomplete refresh. Your previous snapshot has been kept. Please retry later.', 502);
      const previousShared = (cache?.latest_payload as { result?: PageFetchResult } | null)?.result;
      if (previousShared && result.coverage.complete === false && snapshotMatches(previousShared.coverage, scope) && result.posts.length < previousShared.posts.length) throw new ApiError('The provider returned fewer posts than the saved shared snapshot. Please retry later.', 502);
      observedAt = new Date().toISOString();
      if (cache) {
        const resultCoverage = { ...result.coverage, scopeKey: scopeKey(scope), requestedMode: scope.mode, from: scope.from, to: scope.to };
        await query(db.from('tracked_accounts').update({ name: result.name, canonical_id: result.canonicalId || null,
          latest_payload: { result: { ...result, coverage: resultCoverage } }, fetched_at: observedAt, status: 'ready', error: null, locked_until: 0 })
          .eq('id', cache.id).eq('locked_until', lease));
        cacheLockId = null;
      }
    }
    if (page.last_synced_at && snapshotMatches(oldCoverage, scope) && result.coverage.complete === false && result.posts.length < current.posts.length) throw new ApiError('The provider returned an incomplete refresh. Your previous snapshot has been kept. Please retry later.', 502);
    let targetId = String(page.id);
    const existing = result.canonicalId ? await query(db.from('pages').select('*').eq('owner', user).eq('platform', page.platform).eq('canonical_id', result.canonicalId).neq('id', page.id)
      .order('last_synced_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle<Row>()) : null;
    if (existing) {
      if (existing.last_synced_at && snapshotMatches(pageRecord(existing).coverage, scope) && result.coverage.complete === false && result.posts.length < pageRecord(existing).posts.length) throw new ApiError('The provider returned incomplete data for an already tracked page. Its previous snapshot has been kept.', 502);
      const locked = await query(db.from('pages').update({ locked_until: lease }).eq('id', existing.id).eq('owner', user).lt('locked_until', Date.now()).select('id'));
      if (!locked?.length) throw new ApiError('Another collection is refreshing this same page. Try again in a moment.', 409);
      targetId = String(existing.id); mergedLockId = targetId;
    }
    const posts = result.posts.map(post => ({ ...post, pageId: targetId }));
    const coverage = { ...result.coverage, scopeKey: scopeKey(scope), requestedMode: scope.mode, from: scope.from, to: scope.to };
    const profile = (result as PageFetchResult & { profile?: { following?: number | null; avatar?: string | null; isVerified?: boolean | null; postCount?: number | null } }).profile;
    const overall = { ...result.overall, posts: result.overall.posts ?? profile?.postCount ?? null,
      following: profile?.following ?? null, avatar: profile?.avatar ?? null, isVerified: profile?.isVerified ?? null };
    await query(db.rpc('desk_save_refresh', { p_owner: user, p_source: page.id, p_target: targetId, p_lease: lease,
      p_snapshot: { name: result.name, followers: result.followers, posts, coverage, overall, provider: result.provider, last_synced_at: observedAt, canonical_id: result.canonicalId || null } }));
    lockedId = null; mergedLockId = null;
    if (cache) await query(db.from('pages').update({ tracked_account_id: cache.id }).eq('id', targetId).eq('owner', user));
    const saved = await query(db.from('pages').select('*').eq('id', targetId).eq('owner', user).maybeSingle<Row>());
    if (!saved) throw new ApiError('The page was removed during refresh.', 409);
    return { ok: true, page: pageRecord(saved), cached };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'Refresh failed. Please try again.';
    for (const id of [lockedId, mergedLockId]) if (id) {
      try { await query(db.from('pages').update({ locked_until: 0, sync_error: message }).eq('id', id).eq('owner', user).eq('locked_until', lease)); } catch { /* The lease expires if cleanup cannot reach the database. */ }
    }
    if (cacheLockId) try { await query(db.from('tracked_accounts').update({ locked_until: 0, status: 'error', error: message.slice(0, 500) }).eq('id', cacheLockId).eq('locked_until', lease)); } catch { /* Keep the original failure. */ }
    throw error;
  }
}
