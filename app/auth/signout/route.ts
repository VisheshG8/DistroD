import {NextResponse} from 'next/server';
import {createClient} from '@/lib/supabase/server';
import {configuredAppOrigin} from '@/lib/auth-urls';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let origin: string;
  try { origin = configuredAppOrigin(); } catch (error) { return NextResponse.json({error:error instanceof Error ? error.message : 'Authentication is not configured.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
  // Sign-out is a mutation. Reject cross-site forms and require a same-origin POST.
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') return NextResponse.json({error:'This request must come from your workspace.'},{status:403,headers:{'Cache-Control':'no-store'}});
  try {
    const supabase = await createClient();
    const {error} = await supabase.auth.signOut({scope:'local'});
    if (error) return NextResponse.json({error:'Could not sign out. Please try again.'},{status:503,headers:{'Cache-Control':'no-store'}});
    return NextResponse.redirect(new URL('/login',origin),{status:303,headers:{'Cache-Control':'private, no-store'}});
  } catch { return NextResponse.json({error:'Could not sign out. Please try again.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
}
