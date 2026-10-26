import { normalizeInstagramPost, parseCounter } from '../providers';
import { boolean, checkPayload, collectPosts, envelopes, image, object, text } from './shared';
import { ProviderError } from './types';
import type { SocialDataProvider, StandardPost, StandardProfile } from './types';

const HOST = 'instagram-looter2.p.rapidapi.com';

// Public counters must be exact. Rounded display labels are not observations.
function exact(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = parseCounter(value);
    if (parsed.value !== null && !parsed.rounded) return parsed.value;
  }
  return null;
}

/** RapidAPI playground contract, checked 2026-10-26:
 * /web-profile?username=... and /user-feeds?id=...&count=...&max_id=...
 * https://rapidapi.com/irrors-apis/api/instagram-looter2/playground
 * Native Instagram web/mobile envelopes are validated below. The public
 * playground supplies no response examples; fixture tests are not live verification.
 */
export const instagramLooter: SocialDataProvider = {
  id: 'instagram-looter', platforms: ['instagram'],
  async fetchPage(page, { key, scope, request }) {
    const call = async (path: string, params: Record<string, string>) => {
      const url = new URL(path, `https://${HOST}`);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const body = await request('instagram-looter', url.toString(), {
        'x-rapidapi-host': HOST, 'x-rapidapi-key': key,
      });
      checkPayload(body);
      if (envelopes(body).some(item => item.status === false)) throw new ProviderError('Instagram Looter could not return this account.');
      return body;
    };
    const handle = page.handle.replace(/^@/, '');
    const body = await call('/web-profile', { username: handle });
    const candidates = envelopes(body).flatMap(item => [object(item.user), object(item.graphql?.user), item]);
    const user = candidates.find(item => text(item.username) && text(item.pk, item.id));
    if (!user) throw new ProviderError('Instagram Looter returned an unrecognized profile response.');
    checkPayload(user);
    if (text(user.username).toLowerCase() !== handle.toLowerCase()) throw new ProviderError('Instagram Looter returned a different account.');
    const id = text(user.pk, user.id);
    if (!/^\d+$/.test(id)) throw new ProviderError('Instagram Looter did not return a reliable account identifier.');
    const profile: StandardProfile = {
      id, handle: text(user.username), name: text(user.full_name, user.username),
      avatar: image(user.profile_pic_url_hd, user.profile_pic_url),
      followers: exact(user.edge_followed_by?.count, user.follower_count),
      following: exact(user.edge_follow?.count, user.following_count),
      postCount: exact(user.edge_owner_to_timeline_media?.count, user.media_count),
      isVerified: boolean(user.is_verified),
    };
    return collectPosts({ page, provider: 'instagram-looter', profile, scope,
      load: async cursor => {
        const feed = await call('/user-feeds', { id, count: String(Math.min(50, Math.max(12, scope.postLimit))),
          allow_restricted_media: 'false', ...(cursor ? { max_id: cursor } : {}) });
        const payload = envelopes(feed).find(item => Array.isArray(item.items));
        if (!payload) throw new ProviderError('Instagram Looter returned an unrecognized post response.');
        const next = text(payload.next_max_id) || null;
        const more = boolean(payload.more_available);
        // Do not label a truncated or changed vendor response as an exhausted feed.
        if (more === null && !next) throw new ProviderError('Instagram Looter did not return reliable pagination information.');
        return { items: payload.items, cursor: next, hasMore: more ?? !!next };
      },
      normalize: input => {
        const raw = object(input.node || input.media || input);
        const postId = text(raw.pk, raw.id);
        // Numeric JSON identifiers outside JS's safe range have already lost precision.
        if (!/^\d+(?:_\d+)?$/.test(postId)) return null;
        const post = normalizeInstagramPost({ ...raw, pk: postId }, page);
        if (!post) return null;
        const type: StandardPost['type'] = raw.media_type === 8 || raw.__typename === 'GraphSidecar' || Array.isArray(raw.carousel_media) ? 'carousel'
          : raw.media_type === 2 || raw.is_video === true || raw.__typename === 'GraphVideo' ? 'video'
            : raw.media_type === 1 || raw.is_video === false || raw.__typename === 'GraphImage' ? 'image' : null;
        // play_count can include Facebook. Never substitute a combined total when
        // the payload indicates cross-platform plays and omits the Instagram total.
        const combined = (exact(raw.fb_play_count, raw.facebook_play_count) ?? 0) > 0 || raw.is_crossposted_to_facebook === true;
        const views = type === 'image' || type === 'carousel' ? null
          : exact(raw.ig_play_count, raw.video_view_count, raw.video_play_count, combined ? null : raw.play_count);
        const likes = exact(raw.like_count, raw.edge_media_preview_like?.count, raw.edge_liked_by?.count);
        const code = text(raw.code, raw.shortcode);
        return { ...post, type, sourceAssetId: null, views, likes,
          likesReason: likes === null ? raw.like_and_view_counts_disabled === true ? 'hidden' : 'not-returned' : null,
          comments: exact(raw.comment_count, raw.edge_media_to_comment?.count, raw.edge_media_to_parent_comment?.count),
          shares: null, saves: null,
          url: code && /^[\w-]+$/.test(code) ? `https://www.instagram.com/p/${code}/` : page.url,
        };
      },
    });
  },
};
