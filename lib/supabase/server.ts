import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { AUTH_CONFIGURATION_MESSAGE, publicSupabaseConfig } from './config';

export async function createClient() {
  const config = publicSupabaseConfig();
  if (!config) throw new Error(AUTH_CONFIGURATION_MESSAGE);
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll() { return store.getAll(); },
      setAll(items) {
        try { for (const {name, value, options} of items) store.set(name, value, options); }
        catch { /* Server Components cannot write cookies; proxy.ts refreshes them before render. */ }
      },
    },
  });
}
