import 'server-only';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { publicSupabaseConfig } from '@/lib/supabase/config';
import { safeNextPath } from '@/lib/auth-urls';

export type CurrentUser = { userId: string; displayName: string; email: string; fullName: string | null };

/** Every identity used for database ownership is revalidated by Supabase Auth. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!publicSupabaseConfig()) return null;
  try {
    const supabase = await createClient();
    const {data: {user}, error} = await supabase.auth.getUser();
    if (error || !user || !user.email) return null;
    const candidate = user.user_metadata?.full_name ?? user.user_metadata?.name;
    const fullName = typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0,150) : null;
    return {userId:user.id, email:user.email, displayName:fullName || user.email, fullName};
  } catch { return null; }
}

export async function requireCurrentUser(next = '/dashboard') {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=' + encodeURIComponent(safeNextPath(next)));
  return user;
}

export const requireUser = requireCurrentUser;
