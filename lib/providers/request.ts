import type { SupabaseClient } from '@supabase/supabase-js';
import { checkPayload } from './shared';
import { ProviderError } from './types';
import type { ProviderRequest } from './types';

const HOSTS: Readonly<Record<string, readonly string[]>> = {
  hikerapi: ['api.hikerapi.com'], lamatok: ['api.lamatok.com'],
  'youtube-official': ['www.googleapis.com'], tikhub: ['api.tikhub.io'], scrapecreators: ['api.scrapecreators.com'],
  'instagram-looter': ['instagram-looter2.p.rapidapi.com'],
};
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 32 * 1024;
const sensitive = /authorization|apikey|accesskey|privatekey|token|password|secret|cookie|session|email|phone|^key$/i;

/** Debug samples are short lived, size bounded, and never retain credentials or signed URL queries. */
export function redactProviderResponse(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const cleanString = (input: string): string => {
    let result = input;
    for (const secret of secrets) if (secret.length >= 3) result = result.split(secret).join('[redacted]');
    result = result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    result = result.replace(/\b(api[_ -]?key|access[_ -]?key|(?:access|refresh)[_ -]?token|password|secret|sessionid)\s*[:=]\s*["']?[^\s,"'&}]+/gi, '$1=[redacted]');
    result = result.replace(/https?:\/\/[^\s"<>]+/gi, raw => {
      try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
      catch { return '[redacted URL]'; }
    });
    return result.slice(0, 4000);
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return cleanString(item);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (!item || typeof item !== 'object') return null;
    if (depth > 12 || seen.has(item)) return '[truncated]';
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 200).map(child => visit(child, depth + 1));
    return Object.fromEntries(Object.entries(item).slice(0, 200).map(([name, child]) => [name,
      sensitive.test(name.replace(/[^a-z0-9]/gi, '')) ? '[redacted]' : visit(child, depth + 1)]));
  };
  const result = visit(value, 0);
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  return bytes <= MAX_LOG_BYTES ? result : { truncated: true, redactedBytes: bytes, note: 'Response exceeds the debug sample limit.' };
}

async function readJson(response: Response): Promise<unknown> {
  const advertised = Number(response.headers.get('content-length'));
  if (advertised > MAX_BODY_BYTES) { await response.body?.cancel(); throw new ProviderError('The provider response exceeded the allowed size.'); }
  if (!response.body) throw new ProviderError('The provider returned an empty response.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ProviderError('The provider response exceeded the allowed size.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new ProviderError('The provider returned an unreadable response.'); }
}

export type ProviderRequestOptions = {
  db?: SupabaseClient; platform: string; owner?: string;
  deadline?: number; maxCalls?: number; reserveGlobal?: boolean;
  beforeRequest?: (provider: string) => Promise<void>;
  fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
  minIntervalMs?: number;
};

/** All outbound attempts (including the one retry) reserve a request before spending any credits. */
export function createProviderRequest(options: ProviderRequestOptions): ProviderRequest {
  const now = options.now || Date.now;
  const deadline = options.deadline ?? now() + 120_000;
  const maxCalls = Math.min(150, Math.max(1, options.maxCalls ?? 70));
  const fetcher = options.fetcher || fetch;
  const sleep = options.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const interval = Math.max(0, options.minIntervalMs ?? 200);
  let calls = 0; let lastStarted: number | null = null; let queue: Promise<unknown> = Promise.resolve(); let cleanedLogs = false;
  const checkLimits = () => {
    if (now() >= deadline) throw new ProviderError('This refresh reached its time limit. Try again to continue.', 'DEADLINE', 408);
    if (calls >= maxCalls) throw new ProviderError('This refresh reached its provider request limit.', 'REQUEST_LIMIT', 429);
  };
  const wait = async (ms: number) => {
    if (now() + ms >= deadline) throw new ProviderError('This refresh reached its time limit. Try again to continue.', 'DEADLINE', 408);
    if (ms > 0) await sleep(ms);
    checkLimits();
  };
  const run: ProviderRequest = async (provider, rawUrl, headers) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new ProviderError('The provider endpoint is invalid.', 'CONFIGURATION', 400); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !HOSTS[provider]?.includes(url.hostname)) {
      throw new ProviderError('The provider endpoint is not allowed.', 'CONFIGURATION', 400);
    }
    const endpoint = url.pathname.slice(0, 300);
    const secrets = [...Object.values(headers), ...[...url.searchParams].filter(([name]) => /key|token|secret/i.test(name)).map(([, value]) => value)];
    if (options.db && !cleanedLogs) {
      checkLimits();
      try {
        const cleaned = await options.db.rpc('desk_cleanup_provider_logs');
        if (cleaned.error) throw new Error('Cleanup failed');
        cleanedLogs = true;
      } catch { throw new ProviderError('Old provider debug samples could not be cleared.', 'LOGGING', 503); }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      checkLimits();
      if (lastStarted !== null) await wait(Math.max(0, interval - (now() - lastStarted)));
      if (options.beforeRequest) {
        try { await options.beforeRequest(provider); }
        catch { throw new ProviderError('The workspace request allowance has been reached or could not be checked.', 'REQUEST_BLOCKED', 429); }
      }
      let logId: string | null = null;
      if (options.db) {
        try {
          if (options.reserveGlobal !== false) {
            const reserved = await options.db.rpc('desk_reserve_provider_request', { p_provider: provider, p_platform: options.platform, p_endpoint: endpoint });
            if (reserved.error) throw new ProviderError('The provider request allowance could not be checked.', 'LOGGING', 503);
            if (!reserved.data) throw new ProviderError('The monthly provider request or budget limit has been reached.', 'BUDGET_LIMIT', 429);
            logId = String(reserved.data);
          } else {
            const inserted = await options.db.from('provider_requests').insert({ provider, platform: options.platform, endpoint,
              funding: 'workspace', owner: options.owner || null, estimated_cost_usd: 0 }).select('id').single();
            if (inserted.error || !inserted.data?.id) throw new ProviderError('The provider request could not be logged.', 'LOGGING', 503);
            logId = inserted.data.id;
          }
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError('The provider request allowance could not be checked.', 'LOGGING', 503);
        }
      }
      calls++; lastStarted = now();
      const started = now(); const controller = new AbortController();
      const remaining = deadline - now(); const timeoutMs = Math.min(20_000, remaining);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let raw: unknown = null; let failure: ProviderError | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(remaining <= 20_000
            ? new ProviderError('This refresh reached its time limit. Try again to continue.', 'DEADLINE', 408)
            : new ProviderError('The data provider timed out.', 'PROVIDER', 504, true));
        }, Math.max(1, timeoutMs));
      });
      try {
        raw = await Promise.race([timeout, (async () => {
          if (now() >= deadline) throw new ProviderError('This refresh reached its time limit. Try again to continue.', 'DEADLINE', 408);
          const response = await fetcher(url.toString(), { method: 'GET', headers, signal: controller.signal, cache: 'no-store', redirect: 'error' });
          // Never include provider error text: it may contain signed URLs or echo API keys.
          if (!response.ok) {
            try { raw = await readJson(response); } catch { /* Status still conveys the failure safely. */ }
            throw new ProviderError(`The data provider returned HTTP ${response.status}.`, 'PROVIDER', response.status,
              response.status === 429 || response.status >= 500);
          }
          const data = await readJson(response); raw = data;
          checkPayload(data);
          return data;
        })()]);
      } catch (error) {
        failure = error instanceof ProviderError ? error : new ProviderError('The data provider could not be reached.', 'PROVIDER', 502, true);
      } finally { if (timer) clearTimeout(timer); controller.abort(); }
      if (options.db && logId) {
        try {
          const logged = await options.db.from('provider_requests').update({ success: !failure,
            latency_ms: Math.max(0, Math.min(2_147_483_647, Math.round(now() - started))),
            raw_response: raw === null ? null : redactProviderResponse(raw, secrets), error: failure?.message.slice(0, 500) || null }).eq('id', logId);
          if (logged.error) throw new ProviderError('The provider response log could not be saved.', 'LOGGING', 503);
        } catch {
          throw new ProviderError('The provider response log could not be saved.', 'LOGGING', 503);
        }
      }
      if (!failure) return raw;
      if (!failure.retryable || attempt === 1) throw failure;
      await wait(500);
    }
    throw new ProviderError('The data provider could not complete the request.');
  };
  return (provider, url, headers) => {
    const current = queue.then(() => run(provider, url, headers));
    queue = current.catch(() => undefined);
    return current;
  };
}
