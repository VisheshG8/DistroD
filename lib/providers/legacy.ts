import { fetchPage } from '../providers';
import type { PageInput } from '../providers';
import { boolean, checkPayload, count, envelopes, image, object, text } from './shared';
import { ProviderError } from './types';
import type { ProviderContext, ProviderId, SocialFetchResult, StandardProfile } from './types';

/** Preserve the tested TikHub/ScrapeCreators/YouTube parsers while exposing one stable contract. */
export async function fetchLegacy(provider: ProviderId, page: PageInput, context: ProviderContext): Promise<SocialFetchResult> {
  let profileRaw: Record<string, any> = {};
  const result = await fetchPage(page, {
    provider: provider === 'scrapecreators' ? 'scrapecreators' : 'tikhub',
    apiKey: provider === 'youtube-official' ? '' : context.key,
    // Passing this only to the official adapter prevents a paid-provider choice silently using Google.
    youtubeKey: provider === 'youtube-official' ? context.key : '', scope: context.scope, postLimit: context.scope.postLimit,
  }, async (url, headers) => {
    const data = await context.request(provider, url, headers);
    for (const payload of envelopes(data)) {
      const user = object(payload.userInfo?.user || payload.user || payload.user_info);
      checkPayload(user);
      if (user.privateAccount === true || user.secret === 1) throw new ProviderError('This account is private. Only public accounts can be refreshed.', 'PRIVATE', 422);
    }
    if (Object.keys(profileRaw).length === 0) profileRaw = object(data);
    return data;
  });
  const candidates = envelopes(profileRaw);
  const raw = candidates.find(item => item.user || item.userInfo || item.user_info || item.channel || item.items || item.username || item.followerCount) || candidates.at(-1) || {};
  const user = object(raw.userInfo?.user || raw.user || raw.user_info || raw.channel || raw.items?.[0] || raw);
  const stats = object(raw.userInfo?.stats || user.statistics || raw.stats || user);
  const profile: StandardProfile = {
    id: result.canonicalId, handle: text(user.username, user.uniqueId, user.unique_id, user.snippet?.customUrl)?.replace(/^@/, '') || page.handle,
    name: result.name, followers: result.followers, postCount: result.overall.posts,
    following: page.platform === 'youtube' ? null : count(stats.followingCount, user.following_count, user.following),
    isVerified: boolean(user.is_verified, user.verified),
    avatar: image(user.profile_pic_url_hd, user.profile_pic_url, user.avatarLarger, user.avatar_thumb, user.avatar,
      user.snippet?.thumbnails?.high, user.snippet?.thumbnails?.default),
  };
  return { ...result, provider, profile, posts: result.posts.map(post => ({ ...post,
    ...(page.platform === 'instagram' ? { saves: null, shares: null } : {}),
    type: post.type ?? (page.platform === 'youtube' ? 'video' : null), sourceAssetId: null })) };
}
