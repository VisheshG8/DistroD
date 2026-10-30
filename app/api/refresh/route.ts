import { body, fail, guard, json, owner } from '@/lib/server';
import { refreshWorkspacePage } from '@/lib/refresh-service';
import { reconcileWorkspaceAlerts } from '@/lib/analytics/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    guard(request);
    const user = await owner(), data = await body(request);
    const result = await refreshWorkspacePage(user, data.pageId, data.scope);
    // Alerts follow a manual refresh as they do the scheduled one. A batch sends reconcile:false
    // for all but its last page. A failed check keeps the saved snapshot and is retried next time.
    if (data.reconcile !== false) {
      try { await reconcileWorkspaceAlerts(user); } catch { /* The refresh itself succeeded. */ }
    }
    return json(result);
  } catch (error) { return fail(error); }
}
