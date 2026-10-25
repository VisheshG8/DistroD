import { timingSafeEqual } from 'node:crypto';
import { ApiError, database, fail, json, query, queryRows } from '@/lib/server';
import { providerConfiguration, refreshWorkspacePage } from '@/lib/refresh-service';
import { reconcileWorkspaceAlerts } from '@/lib/analytics/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** No cookies, query-string tokens, or editable user metadata authorize a job. */
function authorizeCron(request: Request, secret = process.env.CRON_SECRET): void {
  if (!secret || secret.length < 32) throw new ApiError('Scheduled refresh is not configured.', 503);
  const expected = Buffer.from('Bearer ' + secret), supplied = Buffer.from(request.headers.get('authorization') || '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new ApiError('Unauthorized.', 401);
}

type Row = Record<string, unknown>;
const scheduledScope = { mode: 'posts' as const, postLimit: 100, from: null, to: null };

/** Oldest attempts run first, so work beyond one invocation resumes naturally. */
async function runScheduledRefresh() {
  const started = Date.now(), deadline = started + 220000, db = database();
  const settings = await providerConfiguration();
  if (!settings) throw new ApiError('Apply all database migrations before enabling scheduled refresh.', 503);
  // Retention is independent of the owner's refresh switch or remaining budget.
  await query(db.rpc('desk_cleanup_provider_logs'));
  if (settings.refresh_enabled !== true) return { enabled: false, refreshedPages: 0, message: 'Scheduled refresh is paused.' };
  const usage = await query(db.rpc('desk_provider_usage')) as { requests: number; estimatedCostUsd: number; month: string };
  const cap = Number(settings.monthly_request_cap), budget = Number(settings.monthly_budget_usd);
  const pressure = Math.max(cap > 0 ? Number(usage.requests) / cap : 1, budget > 0 ? Number(usage.estimatedCostUsd) / budget : 0);
  const intervalHours = Math.max(1, Number(settings.refresh_interval_hours) || 24) * (pressure >= .9 ? 4 : pressure >= .75 ? 2 : 1);
  const interval = intervalHours * 3600000;
  if (pressure >= 1) return { enabled: true, refreshedPages: 0, budgetLimited: true, intervalHours, message: 'The monthly request or estimated cost cap has been reached.' };

  const accounts = await query(db.from('tracked_accounts').select('*').order('last_attempt_at', { ascending: true, nullsFirst: true }).order('id').limit(500));
  const changedOwners = new Map<string, string>();
  let attemptedAccounts = 0, refreshedPages = 0, cachedPages = 0, failedPages = 0, deferredAccounts = 0;
  for (const account of accounts || []) {
    if (Date.now() >= deadline - 10000 || attemptedAccounts >= 50) { deferredAccounts++; break; }
    if (Number(account.locked_until) >= Date.now()) continue;
    const fetchedAt = Date.parse(String(account.fetched_at || ''));
    const cacheFresh = Number.isFinite(fetchedAt) && Date.now() - fetchedAt < interval;
    const lastAttempt = Date.parse(String(account.last_attempt_at || ''));
    if (!cacheFresh && account.status === 'error' && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 3600000) continue;
    const pages = await queryRows<Row>((from, to) => db.from('pages').select('id,owner,last_synced_at').eq('tracked_account_id', account.id).eq('active', true).order('id').range(from, to));
    if (!pages.length) {
      // Inactive/orphan cache entries must not hold the oldest-first queue forever.
      await query(db.from('tracked_accounts').update({ last_attempt_at: new Date().toISOString(), status: 'idle' }).eq('id', account.id).lt('locked_until', Date.now()));
      continue;
    }
    const due = pages.filter(page => !cacheFresh || !page.last_synced_at || Date.parse(String(page.last_synced_at)) < fetchedAt);
    if (!due.length) continue;
    attemptedAccounts++;
    for (const page of due) {
      if (Date.now() >= deadline - 8000) { deferredAccounts++; break; }
      try {
        const result = await refreshWorkspacePage(String(page.owner), String(page.id), scheduledScope,
          { scheduled: true, deadline: Math.min(deadline - 5000, Date.now() + 150000), cacheMaxAgeMs: interval });
        refreshedPages++; if (result.cached) cachedPages++;
        const at = result.page.lastSyncedAt;
        if (typeof at === 'string' && at !== page.last_synced_at) {
          const previous = changedOwners.get(String(page.owner));
          if (!previous || at > previous) changedOwners.set(String(page.owner), at);
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) {
          failedPages++;
          const message = error instanceof ApiError ? error.message : 'Scheduled refresh failed. The previous snapshot is still saved.';
          await query(db.from('pages').update({ sync_error: message }).eq('tracked_account_id', account.id).eq('active', true));
          await query(db.from('tracked_accounts').update({ status: 'error', error: message.slice(0, 500), last_attempt_at: new Date().toISOString() }).eq('id', account.id).lt('locked_until', Date.now()));
          for (const affected of pages) changedOwners.set(String(affected.owner), new Date().toISOString());
        }
        // The shared account failed; retrying every subscribing owner would waste requests.
        break;
      }
    }
  }
  let alertsChecked = 0;
  for (const [user, observedAt] of changedOwners) {
    if (Date.now() >= deadline) break;
    try { await reconcileWorkspaceAlerts(user, new Date(observedAt)); alertsChecked++; }
    catch { /* A later successful refresh retries alert reconciliation without losing snapshots. */ }
  }
  return { enabled: true, attemptedAccounts, refreshedPages, cachedPages, failedPages, deferredAccounts,
    alertsChecked, intervalHours, budgetPressure: Math.round(pressure * 100), durationMs: Date.now() - started };
}

export async function GET(request: Request) {
  try { authorizeCron(request); return json(await runScheduledRefresh()); }
  catch (error) { return fail(error); }
}
