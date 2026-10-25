import 'server-only';

// Features and jobs use this entry point; only adapters know vendor endpoints and payloads.
export { fetchSocialPage, DEFAULT_PROVIDER_ORDER, PROVIDERS, providerIsSupported } from './providers/registry';
export { createProviderRequest } from './providers/request';
export { ProviderError, isTerminalProviderError } from './providers/types';
export type { ProviderRequestOptions } from './providers/request';
export type { SocialDataProvider, SocialFetchResult, StandardProfile, StandardPost, ProviderId, Scope, ProviderRequest } from './providers/types';

/** Read only on the server. Credentials never enter browser responses or public configuration. */
export function getConfiguredKeys(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    hikerapi: env.HIKERAPI_KEY?.trim() || '', lamatok: env.LAMATOK_KEY?.trim() || '',
    'youtube-official': env.YOUTUBE_API_KEY?.trim() || '', tikhub: env.TIKHUB_KEY?.trim() || '',
    scrapecreators: env.SCRAPECREATORS_KEY?.trim() || '',
  };
}
