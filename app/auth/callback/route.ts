import {NextResponse} from 'next/server';
import {createClient} from '@/lib/supabase/server';
import {configuredAppOrigin, safeNextPath} from '@/lib/auth-urls';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let origin: string;
  try { origin = configuredAppOrigin(); } catch (error) { return NextResponse.json({error:error instanceof Error ? error.message : 'Authentication is not configured.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
  const url = new URL(request.url), code = url.searchParams.get('code');
  const next = safeNextPath(url.searchParams.get('next'));
  if (code && code.length < 4096 && !url.searchParams.has('error')) {
    try {
      const supabase = await createClient();
      const {error} = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL(next,origin),{status:303,headers:{'Cache-Control':'private, no-store'}});
    } catch { /* Invalid, expired, or unavailable auth returns to a usable sign-in page. */ }
  }
  const target = new URL('/login',origin); target.searchParams.set('error','callback'); target.searchParams.set('next',next);
  return NextResponse.redirect(target,{status:303,headers:{'Cache-Control':'private, no-store'}});
}
