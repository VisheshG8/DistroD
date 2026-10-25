#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const providerKeys = ['HIKERAPI_KEY', 'LAMATOK_KEY', 'YOUTUBE_API_KEY', 'TIKHUB_KEY', 'SCRAPECREATORS_KEY'];
const optionalServerSecrets = ['CRON_SECRET', ...providerKeys];

function legacyRole(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return null;
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role || null; }
  catch { return null; }
}
export function isPrivilegedSupabaseKey(key) { return typeof key === 'string' && (key.startsWith('sb_secret_') || legacyRole(key) === 'service_role'); }
export function isSupabaseServiceKey(key) { return typeof key === 'string' && (/^sb_secret_[A-Za-z0-9_-]+$/.test(key) || legacyRole(key) === 'service_role'); }
export function validatePublicSecrets(env) {
  const errors = Object.entries(env).filter(([name, value]) => name.startsWith('NEXT_PUBLIC_') && isPrivilegedSupabaseKey(typeof value === 'string' ? value.trim() : value)).map(([name]) => `${name} must never contain a Supabase secret/service_role key.`);
  for (const name of optionalServerSecrets) if (env['NEXT_PUBLIC_' + name]?.trim()) errors.push(`${name} must remain server-only; remove NEXT_PUBLIC_${name}.`);
  return errors;
}

/** The importer and server use the HTTPS SDK; no SQL connection credentials are needed. */
export function validateSupabaseBackend(env) {
  const errors = [];
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';
  try {
    const parsed = new URL(url);
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
  }
  catch { errors.push('NEXT_PUBLIC_SUPABASE_URL must be the Supabase project API origin.'); }
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
  if (!key) errors.push('SUPABASE_SECRET_KEY is required (legacy SUPABASE_SERVICE_ROLE_KEY is also supported).');
  else if (!isSupabaseServiceKey(key)) errors.push('SUPABASE_SECRET_KEY must be a Supabase secret key or legacy service_role JWT; publishable/anon keys cannot authorize backend operations.');
  return { errors, url, key };
}

/** Validate configuration without printing secrets or contacting external services. */
export function validateEnvironment(env, { production = false } = {}) {
  const errors = [...validatePublicSecrets(env)], warnings = [];
  const required = name => {
    const value = env[name]?.trim();
    if (!value || /^(?:your[-_ ]|replace[-_ ]|<)|YOUR_PROJECT|YOUR_PASSWORD|YOUR_REGION|BASE64_ENCODED_32/i.test(value)) errors.push(`${name} is required.`);
    return value || '';
  };
  const origin = (value, name, httpsOnly) => {
    if (!value) return;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (httpsOnly && url.protocol !== 'https:')) throw new Error();
    } catch { errors.push(`${name} must be an ${httpsOnly ? 'HTTPS ' : ''}origin without a path, query, or credentials.`); }
  };
  const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL');
  origin(supabaseUrl, 'NEXT_PUBLIC_SUPABASE_URL', production);
  const publicKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || '';
  if (!publicKey || /^(?:your[-_ ]|replace[-_ ]|<)/i.test(publicKey)) errors.push('Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY).');
  if (publicKey && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey) && legacyRole(publicKey) !== 'anon') errors.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key or legacy anon JWT.');
  errors.push(...validateSupabaseBackend(env).errors);
  const encryptionKey = required('APP_ENCRYPTION_KEY');
  if (encryptionKey && (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32)) errors.push('APP_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64.');
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (production && !appUrl) errors.push('NEXT_PUBLIC_APP_URL is required in production.');
  origin(appUrl, 'NEXT_PUBLIC_APP_URL', production);
  const google = env.NEXT_PUBLIC_ENABLE_GOOGLE_AUTH;
  if (google !== undefined && !['true', 'false'].includes(google)) errors.push('NEXT_PUBLIC_ENABLE_GOOGLE_AUTH must be true or false.');
  if (google === 'true') warnings.push('Enable Google in Supabase Auth and configure its redirect URI before testing Google sign-in.');
  for (const name of providerKeys) {
    const value = env[name]?.trim();
    if (value && /^(?:your[-_ ]|replace[-_ ]|<)/i.test(value)) errors.push(`${name} contains a placeholder; configure a real server key or leave it unset.`);
  }
  if (!providerKeys.some(name => env[name]?.trim())) warnings.push('No shared provider keys are configured. Scheduled data refresh cannot fetch accounts; manual refresh can use saved workspace keys.');
  const cronSecret = env.CRON_SECRET;
  if (cronSecret?.trim()) {
    if (cronSecret.length < 32 || cronSecret !== cronSecret.trim() || /^(?:your[-_ ]|replace[-_ ]|<)/i.test(cronSecret)) errors.push('CRON_SECRET must contain at least 32 random characters without surrounding whitespace.');
  } else warnings.push('CRON_SECRET is unset. The scheduled refresh endpoint is disabled.');
  return { errors: [...new Set(errors)], warnings };
}

async function main() {
  const unknown = process.argv.slice(2).filter(arg => arg !== '--production');
  if (unknown.length) { console.error('Usage: npm run check:env -- [--production]'); process.exitCode = 1; return; }
  const result = validateEnvironment(process.env, { production: process.argv.includes('--production') || process.env.NODE_ENV === 'production' });
  for (const warning of result.warnings) console.warn(`Note: ${warning}`);
  if (result.errors.length) {
    console.error('Configuration needs attention:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log('Required environment variables are valid. No secret values were printed. This check does not verify database connectivity or Auth provider settings.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
