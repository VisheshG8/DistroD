#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSupabaseBackend, validatePublicSecrets } from './verify-env.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const PLATFORM_HOSTS = { instagram: 'instagram.com', youtube: 'youtube.com', tiktok: 'tiktok.com' };
class ImportError extends Error {}
const fail = message => { throw new ImportError(message); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
function string(value, label, max = 300, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) fail(`${label} is invalid.`);
  return value.trim();
}
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`); return value.toLowerCase(); }
function time(value, label, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} must be a valid timestamp.`);
  return new Date(value).toISOString();
}
function counter(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE) fail(`${label} must be a non-negative safe integer or null.`);
  return value;
}
function jsonValue(value, label, fallback, maxBytes) {
  if (value === undefined || value === null || value === '') return fallback;
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { fail(`${label} is not valid JSON.`); } }
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > maxBytes) fail(`${label} is too large.`);
  return parsed;
}
function profileUrl(value, platform, label) {
  let url;
  try { url = new URL(string(value, label, 500)); } catch { fail(`${label} is invalid.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname.replace(/^(?:www|m)\./, '').toLowerCase() !== PLATFORM_HOSTS[platform]) fail(`${label} must be an HTTPS profile URL on the selected platform.`);
  return url.toString();
}

/** Accept raw database rows or camelCase workspace exports; never import accounts, roles, keys, or usage. */
export function validateLegacyExport(payload, ownerMap) {
  if (!plain(payload) || !plain(ownerMap)) fail('The export and owner map must be JSON objects.');
  const mapping = new Map(Object.entries(ownerMap).map(([oldOwner, target]) => [string(oldOwner, 'Legacy owner ID', 200), uuid(target, 'Mapped Supabase user ID')]));
  const owner = (value, label) => { const original = string(value, label, 200); const target = mapping.get(original); if (!target) fail(`A legacy owner is missing from the owner map (${label}).`); return target; };
  for (const key of ['collections', 'pages', 'memberships']) if (!Array.isArray(payload[key]) || payload[key].length > 50000) fail(`${key} must be an array with at most 50,000 entries.`);
  const collectionIds = new Map(), pageIds = new Map(), handles = new Set(), memberKeys = new Set();
  const perOwner = new Map();
  const bump = (id, key) => { const counts = perOwner.get(id) || { collections: 0, pages: 0 }; counts[key]++; perOwner.set(id, counts); if (counts.collections > 100 || counts.pages > 500) fail('The export exceeds the workspace limit of 100 collections or 500 pages per target user.'); };
  const collections = payload.collections.map((row, i) => {
    if (!plain(row)) fail(`collections[${i}] must be an object.`);
    const id = uuid(row.id, `collections[${i}].id`), targetOwner = owner(row.owner ?? row.ownerId ?? payload.owner, `collections[${i}].owner`);
    if (collectionIds.has(id)) fail('Duplicate collection ID in export.');
    collectionIds.set(id, targetOwner); bump(targetOwner, 'collections');
    return { id, owner: targetOwner, name: string(row.name, `collections[${i}].name`, 100), created_at: time(row.created_at ?? row.createdAt, `collections[${i}].createdAt`) };
  });
  const pages = payload.pages.map((row, i) => {
    if (!plain(row)) fail(`pages[${i}] must be an object.`);
    const id = uuid(row.id, `pages[${i}].id`), targetOwner = owner(row.owner ?? row.ownerId ?? payload.owner, `pages[${i}].owner`);
    if (pageIds.has(id)) fail('Duplicate page ID in export.');
    const platform = row.platform;
    if (!Object.hasOwn(PLATFORM_HOSTS, platform)) fail(`pages[${i}].platform is unsupported.`);
    let handle = string(row.handle, `pages[${i}].handle`, platform === 'youtube' ? 100 : 30);
    if (!(platform === 'youtube' ? /^[\p{L}\p{N}_.-]{3,100}$/u : /^[\w.]{1,30}$/).test(handle)) fail(`pages[${i}].handle is invalid.`);
    if (!(platform === 'youtube' && /^UC[\w-]{22}$/.test(handle))) handle = handle.toLowerCase();
    const handleKey = JSON.stringify([targetOwner, platform, handle]);
    if (handles.has(handleKey)) fail('Two imported pages have the same target owner, platform, and handle.');
    handles.add(handleKey); pageIds.set(id, targetOwner); bump(targetOwner, 'pages');
    const posts = jsonValue(row.posts, `pages[${i}].posts`, [], 8 * 1024 * 1024);
    if (!Array.isArray(posts) || posts.length > 1000) fail(`pages[${i}].posts must contain at most 1,000 posts.`);
    const postIds = new Set();
    for (const [j, post] of posts.entries()) {
      if (!plain(post)) fail(`pages[${i}].posts[${j}] must be an object.`);
      string(post.id, `pages[${i}].posts[${j}].id`, 200);
      if (postIds.has(post.id)) fail(`pages[${i}] contains duplicate post IDs.`);
      postIds.add(post.id);
      for (const metric of ['views', 'likes', 'comments', 'shares', 'saves']) counter(post[metric], `pages[${i}].posts[${j}].${metric}`);
      if (post.publishedAt != null) time(post.publishedAt, `pages[${i}].posts[${j}].publishedAt`);
      // Preserve page references while keeping source IDs stable under the new owner mapping.
      post.pageId = id;
    }
    const coverage = jsonValue(row.coverage, `pages[${i}].coverage`, {}, 65536);
    const overall = jsonValue(row.overall, `pages[${i}].overall`, null, 65536);
    if (!plain(coverage) || (overall !== null && !plain(overall))) fail(`pages[${i}] has invalid coverage or overall metrics.`);
    if (overall) for (const metric of ['views', 'posts', 'followers', 'likes', 'comments', 'shares']) counter(overall[metric], `pages[${i}].overall.${metric}`);
    return { id, owner: targetOwner, platform, handle, url: profileUrl(row.url, platform, `pages[${i}].url`), name: string(row.name || `@${handle}`, `pages[${i}].name`, 300), followers: counter(row.followers, `pages[${i}].followers`), posts, coverage, overall,
      last_synced_at: time(row.last_synced_at ?? row.lastSyncedAt, `pages[${i}].lastSyncedAt`, true), sync_error: string(row.sync_error ?? row.syncError, `pages[${i}].syncError`, 2000, true),
      provider: string(row.provider, `pages[${i}].provider`, 100, true), canonical_id: string(row.canonical_id ?? row.canonicalId, `pages[${i}].canonicalId`, 200, true), locked_until: 0 };
  });
  const memberships = payload.memberships.map((row, i) => {
    if (!plain(row)) fail(`memberships[${i}] must be an object.`);
    const collection_id = uuid(row.collection_id ?? row.collectionId, `memberships[${i}].collectionId`), page_id = uuid(row.page_id ?? row.pageId, `memberships[${i}].pageId`);
    const targetOwner = row.owner || row.ownerId ? owner(row.owner ?? row.ownerId, `memberships[${i}].owner`) : collectionIds.get(collection_id);
    if (!targetOwner || collectionIds.get(collection_id) !== targetOwner || pageIds.get(page_id) !== targetOwner) fail('Every imported membership must link an imported collection and page belonging to the same mapped owner.');
    const key = `${collection_id}:${page_id}`; if (memberKeys.has(key)) fail('Duplicate membership in export.'); memberKeys.add(key);
    return { collection_id, page_id, owner: targetOwner };
  });
  const attachedPages = new Set(memberships.map(member => member.page_id));
  if (pages.some(page => !attachedPages.has(page.id))) fail('Every imported page must belong to at least one imported collection.');
  return { collections, pages, memberships, owners: [...perOwner.keys()] };
}

async function readJson(file, label) {
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > 100 * 1024 * 1024) fail(`${label} must be a JSON file smaller than 100 MiB.`);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error instanceof ImportError) throw error; fail(`${label} could not be read as JSON.`); }
}
function parseArgs(args) {
  const options = { apply: false, validateOnly: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' || arg === '--owners') { if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`Provide a path after ${arg}.`); options[arg === '--file' ? 'file' : 'owners'] = args[++i]; }
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--validate-only') options.validateOnly = true;
    else if (arg === '--help') options.help = true;
    else fail('Unknown argument. Use --help for usage.');
  }
  if (options.apply && options.validateOnly) fail('--apply and --validate-only cannot be combined.');
  return options;
}
export async function importRows(client, data, apply = false) {
  const { data: summary, error } = await client.rpc('desk_import_legacy', { p_data: data, p_apply: apply });
  if (error) {
    // Do not print remote messages: they can contain SQL values or private row data.
    const code = typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? ` (${error.code})` : '';
    fail(`Import failed${code}. No partial import was committed. Check the target users, ownership conflicts, record limits, and required SDK migrations, then retry.`);
  }
  if (!plain(summary)) fail('The import RPC returned an invalid summary. Check the SDK import migration.');
  return summary;
}
async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log('Usage: npm run import:legacy -- --file EXPORT.json --owners OWNER-MAP.json [--validate-only | --apply]\nDefault mode checks Supabase through the SDK and reports a dry run. --validate-only checks files without contacting Supabase. --apply calls the atomic import RPC and never overwrites existing records. NEXT_PUBLIC_SUPABASE_URL and server-only SUPABASE_SECRET_KEY (legacy SUPABASE_SERVICE_ROLE_KEY also supported) come from the environment, never command-line arguments.'); return; }
    if (!options.file || !options.owners) fail('Provide --file EXPORT.json and --owners OWNER-MAP.json.');
    const data = validateLegacyExport(await readJson(options.file, 'Export'), await readJson(options.owners, 'Owner map'));
    if (options.validateOnly) { console.log(JSON.stringify({ mode: 'files validated; no database connection', collections: data.collections.length, pages: data.pages.length, memberships: data.memberships.length, owners: data.owners.length })); return; }
    const backend = validateSupabaseBackend(process.env);
    const configErrors = [...backend.errors, ...validatePublicSecrets(process.env)];
    if (configErrors.length) fail(configErrors.join(' '));
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(backend.url, backend.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(120000) }) } });
    const result = await importRows(client, data, options.apply);
    console.log(JSON.stringify({ mode: options.apply ? 'import committed' : 'dry run; no rows written', ...result }));
    console.log('Accounts, roles, API keys, settings, usage, and local browser preferences were not imported. Re-enter API keys in the new app.');
  } catch (error) {
    console.error(error instanceof ImportError ? error.message : 'Import failed. Check Supabase connectivity and the SDK migrations. If the connection failed during --apply, the result may be unknown; retrying the same export is safe.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
