import { instagramContentType, normalizeInstagramPost } from '../providers';
import { boolean, checkPayload, collectPosts, count, envelopes, image, object, text } from './shared';
import { ProviderError } from './types';
import type { SocialDataProvider, StandardProfile } from './types';

/** Contract: https://api.hikerapi.com/openapi.json (v2 profile, current g2 media pagination).
 * The deprecated v1/v2 media feeds can return false 404s. Only top-level next_page_id is reusable.
 */
export const hikerapi: SocialDataProvider = {
  id: 'hikerapi', platforms: ['instagram'],
  async fetchPage(page, { key, scope, request }) {
    const call = async (path: string, params: Record<string, string>) => {
      const url = new URL(path, 'https://api.hikerapi.com');
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const body = await request('hikerapi', url.toString(), { 'x-access-key': key });
      checkPayload(body); return body;
    };
    const body = await call('/v2/user/by/username', { username: page.handle.replace(/^@/, ''), safe_int: 'true' });
    const candidates = envelopes(body);
    const profileEnvelope = candidates.find(item => item.user || item.username || item.pk);
    const user = object(profileEnvelope?.user || profileEnvelope);
    checkPayload(user);
    const id = text(user.pk, user.id, user.strong_id__);
    if (!id || !text(user.username)) throw new ProviderError('HikerAPI returned an unrecognized profile response.');
    const profile: StandardProfile = {
      id, handle: text(user.username) || page.handle, name: text(user.full_name, user.username),
      avatar: image(user.profile_pic_url_hd, user.profile_pic_url), followers: count(user.follower_count),
      following: count(user.following_count), postCount: count(user.media_count), isVerified: boolean(user.is_verified),
    };
    return collectPosts({ page, provider: 'hikerapi', profile, scope,
      load: async cursor => {
        const feed = await call('/g2/user/medias', { user_id: id, flat: 'true', ...(cursor ? { next_page_id: cursor } : {}) });
        const payload = object(feed?.response);
        if (!Array.isArray(payload.items)) throw new ProviderError('HikerAPI returned an unrecognized post response.');
        const next = text(feed.next_page_id) || null;
        return { items: payload.items, cursor: next, hasMore: payload.more_available === true || !!next };
      },
      normalize: raw => {
        // g2 play_count can include Facebook. Prefer the explicitly Instagram counter where supplied.
        const id = text(raw.pk, raw.id, raw.code, raw.shortcode);
        if (!id) return null;
        const post = normalizeInstagramPost({ ...raw, pk: id, play_count: count(raw.ig_play_count, raw.play_count) }, page);
        return post ? { ...post, shares: null, saves: null, type: instagramContentType(raw), sourceAssetId: null } : null;
      },
    });
  },
};
