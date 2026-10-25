import { normalizeTikTokPost } from '../providers';
import { boolean, checkPayload, collectPosts, count, envelopes, image, object, text } from './shared';
import { ProviderError } from './types';
import type { SocialDataProvider, StandardProfile } from './types';

/** Contract: https://api.lamatok.com/openapi.json and https://lamatok.com/tiktok-api.
 * v2 media uses secUid and max_cursor, not username. v3 profile restoration may bill 2-3 calls;
 * it is deliberately not invoked implicitly. Vendor responses contain TikTok web/app envelopes.
 */
export const lamatok: SocialDataProvider = {
  id: 'lamatok', platforms: ['tiktok'],
  async fetchPage(page, { key, scope, request }) {
    const call = async (path: string, params: Record<string, string>) => {
      const url = new URL(path, 'https://api.lamatok.com');
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const body = await request('lamatok', url.toString(), { 'x-access-key': key });
      checkPayload(body); return body;
    };
    const body = await call('/v1/user/by/username', { username: page.handle.replace(/^@/, '') });
    const candidates = envelopes(body);
    const payload = candidates.find(item => item.userInfo || item.user || item.user_info || item.secUid || item.sec_uid) || {};
    const info = object(payload.userInfo || payload);
    const user = object(info.user || info.user_info || info);
    checkPayload(user);
    if (user.privateAccount === true || user.secret === 1) throw new ProviderError('This account is private. Only public accounts can be refreshed.', 'PRIVATE', 422);
    const stats = object(info.stats || info.statsV2 || user.stats || user.statsV2);
    const id = text(user.id, user.uid, user.pk);
    const secUid = text(user.secUid, user.sec_uid);
    if (!id || !secUid) throw new ProviderError('LamaTok did not return the public account identifier needed to fetch its posts.');
    const profile: StandardProfile = {
      id, handle: text(user.uniqueId, user.unique_id, user.username) || page.handle,
      name: text(user.nickname, user.full_name, user.uniqueId, user.unique_id) || page.handle,
      avatar: image(user.avatarLarger, user.avatarMedium, user.avatar_thumb, user.avatar_larger, user.avatar_url),
      followers: count(stats.followerCount, user.follower_count, user.followerCount),
      following: count(stats.followingCount, user.following_count, user.followingCount),
      postCount: count(stats.videoCount, user.video_count, user.aweme_count, user.videoCount),
      isVerified: boolean(user.verified, user.is_verified),
    };
    return collectPosts({ page, provider: 'lamatok', profile, scope,
      load: async cursor => {
        const feed = await call('/v2/user/medias/by/secUid', { secUid, count: String(Math.min(50, scope.mode === 'date' ? 50 : scope.postLimit)), max_cursor: cursor || '0' });
        const payload = envelopes(feed).find(item => Array.isArray(item.aweme_list) || Array.isArray(item.itemList) || Array.isArray(item.item_list));
        if (!payload) throw new ProviderError('LamaTok returned an unrecognized post response.');
        const next = text(payload.max_cursor, payload.cursor) || null;
        const more = payload.has_more ?? payload.hasMore;
        if (![true, false, 0, 1, '0', '1'].includes(more)) throw new ProviderError('LamaTok did not return a recognizable pagination status.');
        return { items: payload.aweme_list || payload.itemList || payload.item_list,
          cursor: next, hasMore: more === true || more === 1 || more === '1' };
      },
      normalize: raw => {
        const id = text(raw.aweme_id, raw.id);
        if (!id) return null;
        const post = normalizeTikTokPost({ ...raw, ...(raw.aweme_id !== undefined ? { aweme_id: id } : { id }) }, page);
        return post ? { ...post, type: raw.image_post_info || Array.isArray(raw.imagePost?.images) ? 'carousel' : raw.video ? 'video' : null,
          sourceAssetId: null } : null;
      },
    });
  },
};
