import {createServerClient} from '@supabase/ssr';
import {NextResponse, type NextRequest} from 'next/server';
import {publicSupabaseConfig} from '@/lib/supabase/config';

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({request});
  const config = publicSupabaseConfig();
  if (!config) return response;
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(items) {
        for (const {name,value} of items) request.cookies.set(name,value);
        response = NextResponse.next({request});
        for (const {name,value,options} of items) response.cookies.set(name,value,options);
      },
    },
  });
  try { await supabase.auth.getUser(); } catch { /* Protected routes verify identity again and fail closed. */ }
  response.headers.set('Cache-Control','private, no-store');
  return response;
}

export const config = {matcher:['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff|woff2)$).*)']};
