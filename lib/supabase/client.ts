"use client";

import { createBrowserClient } from '@supabase/ssr';
import { AUTH_CONFIGURATION_MESSAGE, publicSupabaseConfig } from './config';

export function createClient() {
  const config = publicSupabaseConfig();
  if (!config) throw new Error(AUTH_CONFIGURATION_MESSAGE);
  return createBrowserClient(config.url, config.key);
}
