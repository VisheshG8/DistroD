import type { PageFetchResult, PageInput, Platform, Post } from '../providers';

export type ProviderId = 'youtube-official' | 'hikerapi' | 'lamatok' | 'tikhub' | 'scrapecreators';
export type Scope = { mode: 'posts' | 'date'; postLimit: number; from: string | null; to: string | null };
export type StandardProfile = {
  id: string | null; handle: string; name: string; avatar: string | null;
  followers: number | null; following: number | null; postCount: number | null; isVerified: boolean | null;
};
export type StandardPost = Post & { type: 'video' | 'image' | 'carousel' | null; sourceAssetId: string | null };
export type SocialFetchResult = Omit<PageFetchResult, 'posts'> & { profile: StandardProfile; posts: StandardPost[] };
export type ProviderRequest = (providerId: string, url: string, headers: Record<string, string>) => Promise<any>;
export type ProviderContext = { scope: Scope; key: string; request: ProviderRequest };

/** A combined fetch shares the resolved profile ID with pagination, avoiding a second paid lookup. */
export interface SocialDataProvider {
  id: ProviderId;
  platforms: readonly Platform[];
  fetchPage(page: PageInput, context: ProviderContext): Promise<SocialFetchResult>;
}

export type ProviderErrorCode = 'BUDGET_LIMIT' | 'DEADLINE' | 'REQUEST_LIMIT' | 'REQUEST_BLOCKED'
  | 'CONFIGURATION' | 'PROVIDER' | 'PRIVATE' | 'NOT_FOUND' | 'LOGGING';
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, code: ProviderErrorCode = 'PROVIDER', status = 502, retryable = false) {
    super(message); this.name = 'ProviderError'; this.code = code; this.status = status; this.retryable = retryable;
  }
}
export function isTerminalProviderError(error: unknown): boolean {
  return error instanceof ProviderError && ['BUDGET_LIMIT', 'DEADLINE', 'REQUEST_LIMIT', 'REQUEST_BLOCKED', 'PRIVATE', 'LOGGING'].includes(error.code);
}
