import { body, fail, guard, json, owner } from '@/lib/server';
import { refreshWorkspacePage } from '@/lib/refresh-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    guard(request);
    const user = await owner(), data = await body(request);
    return json(await refreshWorkspacePage(user, data.pageId, data.scope));
  } catch (error) { return fail(error); }
}
