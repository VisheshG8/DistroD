import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | undefined;

/** Privileged Data API client. Only verified server routes may use this client. */
export function database(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Database access is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY on the server.');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be your Supabase project origin.');
  }
  let privileged = /^sb_secret_[A-Za-z0-9_-]+$/.test(key);
  if (key.split('.').length === 3) {
    try { privileged = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'service_role'; } catch { /* rejected below */ }
  }
  if (!privileged) throw new Error('SUPABASE_SECRET_KEY must contain a backend secret key, or use SUPABASE_SERVICE_ROLE_KEY for a legacy service-role key.');
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', signal: init?.signal ?? AbortSignal.timeout(30000) }) },
  });
  return cached;
}
