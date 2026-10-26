import type { PageInput, Platform } from '../providers';
import { hikerapi } from './hikerapi';
import { lamatok } from './lamatok';
import { youtubeOfficial } from './youtube-official';
import { tikhub } from './tikhub';
import { scrapecreators } from './scrapecreators';
import { instagramLooter } from './instagram-looter';
import { normalizeScope } from './shared';
import { isTerminalProviderError, ProviderError } from './types';
import type { ProviderId, ProviderRequest, Scope, SocialDataProvider, SocialFetchResult } from './types';

export const DEFAULT_PROVIDER_ORDER: Record<Platform, ProviderId[]> = {
  instagram: ['hikerapi', 'tikhub', 'scrapecreators', 'instagram-looter'],
  tiktok: ['lamatok', 'tikhub', 'scrapecreators'],
  youtube: ['youtube-official', 'tikhub', 'scrapecreators'],
};
export const PROVIDERS: Readonly<Record<ProviderId, SocialDataProvider>> = {
  hikerapi, lamatok, 'youtube-official': youtubeOfficial, tikhub, scrapecreators, 'instagram-looter': instagramLooter,
};
export function providerIsSupported(provider: string, platform: string): provider is ProviderId {
  return Object.hasOwn(PROVIDERS, provider) && PROVIDERS[provider as ProviderId].platforms.includes(platform as Platform);
}
export async function fetchSocialPage(page: PageInput, options: {
  scope: Scope; providerOrder?: string[]; keys: Record<string, string>; request: ProviderRequest;
}): Promise<SocialFetchResult> {
  const scope = normalizeScope(options.scope);
  const defaults = DEFAULT_PROVIDER_ORDER[page.platform as Platform];
  if (!defaults) throw new ProviderError('This social platform is not supported.', 'CONFIGURATION', 400);
  const order = [...new Set(options.providerOrder ?? defaults)].filter(id => providerIsSupported(id, page.platform) && options.keys[id]?.trim()) as ProviderId[];
  if (!order.length) throw new ProviderError('No configured data provider is available for this platform. Ask an administrator to configure a provider key.', 'CONFIGURATION', 503);
  let lastError: unknown;
  for (const id of order) {
    let terminalError: unknown;
    try {
      const result = await PROVIDERS[id].fetchPage(page, { scope, key: options.keys[id].trim(), request: async (provider, url, headers) => {
        if (terminalError) throw terminalError;
        try { return await options.request(provider, url, headers); }
        catch (error) { if (isTerminalProviderError(error)) terminalError = error; throw error; }
      } });
      // Legacy adapters retain partial data on pagination errors. A cap/deadline is never swallowed or bypassed.
      if (terminalError) throw terminalError;
      return result;
    } catch (error) {
      if (terminalError) throw terminalError;
      if (isTerminalProviderError(error)) throw error;
      lastError = error;
    }
  }
  // Provider messages can include request URLs or credentials. Keep outward errors predictable and safe.
  if (lastError instanceof ProviderError) throw lastError;
  throw new ProviderError('The configured data providers could not refresh this public account. Try again later.');
}
