#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Validate configuration without printing secrets or contacting external services. */
export function validateEnvironment(env, { production = false } = {}) {
  const errors = [], warnings = [];
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
  if (publicKey.startsWith('sb_secret_')) errors.push('A Supabase secret key must never be used as a NEXT_PUBLIC key. Use the publishable key.');
  if (publicKey.split('.').length === 3) {
    try { if (JSON.parse(Buffer.from(publicKey.split('.')[1], 'base64url').toString()).role === 'service_role') errors.push('A service_role key must never be exposed through NEXT_PUBLIC configuration.'); }
    catch { errors.push('The legacy Supabase anon key is malformed.'); }
  }
  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl) try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error();
    if (production && url.searchParams.get('sslmode') === 'disable') errors.push('DATABASE_URL cannot disable TLS in production.');
    if (production && !(url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543')) warnings.push('For Vercel, use Supabase’s transaction-pooler connection string (port 6543). Other connection types need their own connectivity and pooling checks.');
  } catch { errors.push('DATABASE_URL must be a PostgreSQL connection string containing a database user and password.'); }
  const encryptionKey = required('APP_ENCRYPTION_KEY');
  if (encryptionKey && (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32)) errors.push('APP_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64.');
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (production && !appUrl) errors.push('NEXT_PUBLIC_APP_URL is required in production.');
  origin(appUrl, 'NEXT_PUBLIC_APP_URL', production);
  const google = env.NEXT_PUBLIC_ENABLE_GOOGLE_AUTH;
  if (google !== undefined && !['true', 'false'].includes(google)) errors.push('NEXT_PUBLIC_ENABLE_GOOGLE_AUTH must be true or false.');
  if (google === 'true') warnings.push('Enable Google in Supabase Auth and configure its redirect URI before testing Google sign-in.');
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
