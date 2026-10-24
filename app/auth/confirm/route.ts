import {NextResponse} from 'next/server';
import type {EmailOtpType} from '@supabase/supabase-js';
import {createClient} from '@/lib/supabase/server';
import {configuredAppOrigin, safeNextPath} from '@/lib/auth-urls';

export const dynamic = 'force-dynamic';
const types = new Set(['signup','invite','magiclink','recovery','email_change','email']);

export async function GET(request: Request) {
  let origin: string;
  try { origin = configuredAppOrigin(); } catch (error) { return NextResponse.json({error:error instanceof Error ? error.message : 'Authentication is not configured.'},{status:503,headers:{'Cache-Control':'no-store'}}); }
  const params = new URL(request.url).searchParams;
  const tokenHash = params.get('token_hash'), type = params.get('type');
  const next = type === 'recovery' ? '/reset-password' : safeNextPath(params.get('next'));
  if (tokenHash && tokenHash.length < 4096 && type && types.has(type)) {
    try {
      const supabase = await createClient();
      const {error} = await supabase.auth.verifyOtp({token_hash:tokenHash,type:type as EmailOtpType});
      if (!error) return NextResponse.redirect(new URL(next,origin),{status:303,headers:{'Cache-Control':'private, no-store'}});
    } catch { /* Confirmation links can expire or already have been used. */ }
  }
  const target = new URL('/login',origin); target.searchParams.set('error','confirmation');
  return NextResponse.redirect(target,{status:303,headers:{'Cache-Control':'private, no-store'}});
}
