import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPage, parseCounter, normalizeDate, normalizeInstagramPost,
  normalizeTikTokPost, normalizeYouTubePost, instagramContentType, tiktokContentType,
} from '../lib/providers.ts';

const settings = { provider: 'tikhub', postLimit: 3, apiKey: 'fixture-key', youtubeKey: '' };
const page = { id: 'page-1', platform: 'instagram', handle: 'creator', url: 'https://www.instagram.com/creator/' };

test('zero counters remain zero; malformed and absent counters remain unavailable', () => {
  assert.deepEqual(parseCounter('0'), { value: 0, rounded: false });
  assert.deepEqual(parseCounter('-1'), { value: null, rounded: false });
  assert.deepEqual(parseCounter('unknown'), { value: null, rounded: false });
  assert.deepEqual(parseCounter(1.5), { value: null, rounded: false });
  assert.deepEqual(parseCounter(Number.MAX_SAFE_INTEGER + 1), { value: null, rounded: false });
  assert.deepEqual(parseCounter('12,345 views'), { value: 12345, rounded: false });
  assert.deepEqual(parseCounter('1.2M views'), { value: 1200000, rounded: true });
  assert.deepEqual(parseCounter('1.2\u4e07\u6b21\u89c2\u770b'), { value: 12000, rounded: true });
  const zero = normalizeInstagramPost({ pk: '9', like_count: 0, comment_count: -1 }, page);
  assert.equal(zero.likes, 0);
  assert.equal(zero.views, null);
  assert.equal(zero.comments, null);
  assert.equal(zero.shares, null);
  const hidden = normalizeInstagramPost({ pk: '9', play_count: 20, like_count: 3, like_and_view_counts_disabled: true }, page);
  assert.equal(hidden.views, 20);
  assert.equal(hidden.likes, 3);
  assert.equal(hidden.likesReason, null);
  const unavailable = normalizeInstagramPost({ pk: '9', like_count: -1, like_and_view_counts_disabled: true }, page);
  assert.equal(unavailable.likes, null);
  assert.equal(unavailable.likesReason, 'hidden');
});

test('Hindi Podcasts live-shaped Instagram counters survive the disabled presentation flag', () => {
  const post = normalizeInstagramPost({ id: 'fixture_123', code: 'DecHgH3Plby', play_count: 1860,
    ig_play_count: 1860, like_count: 3, comment_count: 0, like_and_view_counts_disabled: true }, page);
  assert.equal(post.views, 1860);
  assert.equal(post.likes, 3);
  assert.equal(post.comments, 0);
});

test('unknown dates are not inferred; native IDs and duration units are retained', () => {
  assert.equal(normalizeDate('2 days ago'), null);
  assert.equal(normalizeDate('2026-10-01'), null);
  assert.equal(normalizeDate('2026-10-01T10:00:00+05:30'), '2026-10-01T04:30:00.000Z');
  const ig = normalizeInstagramPost({ id: '123_456' }, page);
  assert.equal(ig.id, '123');
  assert.equal(normalizeInstagramPost({ shortcode: 'abc_def' }, page).id, 'abc_def');
  const tt = normalizeTikTokPost({ aweme_id: '8', statistics: { play_count: 0 }, video: { duration: 5000 } }, { ...page, platform: 'tiktok' });
  assert.equal(tt.views, 0);
  assert.equal(tt.durationSeconds, 5);
  const yt = normalizeYouTubePost({ id: 'video', statistics: { viewCount: '2' } }, { ...page, platform: 'youtube' });
  assert.equal(yt.shares, null);
  assert.equal(yt.comments, null);
  assert.equal(yt.publishedAt, null);
});

test('Instagram nested envelopes paginate with max_id and deduplicate overlapping posts', async () => {
  let calls = 0;
  const result = await fetchPage(page, settings, async (url, headers) => {
    calls++;
    const u = new URL(url);
    assert.equal(headers.Authorization, 'Bearer fixture-key');
    if (calls === 1) return { code: 200, data: { data: { user: { id: '123', full_name: 'Creator', edge_followed_by: { count: 0 } } } } };
    if (calls === 2) return { code: 200, data: { items: [{ pk: '1', play_count: 0 }, { pk: '2', play_count: 12 }], more_available: true, next_max_id: 'next' } };
    assert.equal(u.searchParams.get('max_id'), 'next');
    return { code: 200, data: { items: [{ pk: '2', play_count: 12 }, { pk: '3' }], more_available: false } };
  });
  assert.equal(calls, 3);
  assert.equal(result.posts.length, 3);
  assert.equal(result.followers, 0);
  assert.equal(result.canonicalId, '123');
  assert.equal(result.posts[0].views, 0);
  assert.equal(result.posts[2].views, null);
  assert.equal(result.coverage.incomplete, true);
});

test('TikTok repeated cursors stop promptly and return explicit partial coverage', async () => {
  let calls = 0;
  const result = await fetchPage({ ...page, platform: 'tiktok' }, settings, async () => {
    calls++;
    if (calls === 1) return { code: 200, data: { userInfo: { user: { id: 'tt', secUid: 'sec', nickname: 'Tik' }, stats: { followerCount: 3 } } } };
    return { code: 200, data: { itemList: [{ id: String(calls), stats: { playCount: 10, shareCount: 2 } }], cursor: 'repeat', hasMore: true } };
  });
  assert.equal(calls, 3);
  assert.equal(result.posts.length, 2);
  assert.equal(result.coverage.incomplete, true);
  assert.match(result.coverage.note, /pagination cursor/);
  assert.equal(result.posts[0].shares, 2);
});

test('a sparse feed cannot trigger more than 50 provider calls', async () => {
  let calls = 0;
  const result = await fetchPage(page, { ...settings, postLimit: 100 }, async () => {
    calls++;
    if (calls === 1) return { code: 200, data: { user: { id: '123' } } };
    return { code: 200, data: { items: [{ pk: String(calls), play_count: calls }], more_available: true, next_max_id: String(calls) } };
  });
  assert.equal(calls, 50);
  assert.equal(result.posts.length, 49);
  assert.equal(result.coverage.hasMore, true);
  assert.equal(result.coverage.incomplete, true);
});

test('a later feed failure keeps fetched data with an incomplete-coverage note', async () => {
  let calls = 0;
  const result = await fetchPage(page, settings, async () => {
    calls++;
    if (calls === 1) return { code: 200, data: { user: { id: '123' } } };
    if (calls === 2) return { code: 200, data: { items: [{ pk: '1', play_count: 12 }], more_available: true, next_max_id: 'next' } };
    throw new Error('fixture outage');
  });
  assert.equal(calls, 3);
  assert.equal(result.posts.length, 1);
  assert.equal(result.coverage.incomplete, true);
  assert.match(result.coverage.note, /stopped/);
});

test('ScrapeCreators fetches both YouTube tabs without per-video enrichment calls', async () => {
  let calls = 0;
  const result = await fetchPage({ ...page, platform: 'youtube' }, { ...settings, provider: 'scrapecreators' }, async url => {
    calls++;
    const u = new URL(url);
    if (u.pathname === '/v1/youtube/channel') return { success: true, name: 'YT', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', subscriberCount: 4 };
    if (u.pathname.endsWith('/shorts')) return { success: true, shorts: [{ id: 'short', viewCountInt: 5, likeCountInt: 0, publishDate: '2026-10-23T12:00:00Z' }] };
    return { success: true, videos: [{ id: 'long', viewCountInt: 3, publishedTime: '2026-10-21T12:00:00Z' }] };
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.posts.map(p => p.id), ['short', 'long']);
  assert.equal(result.posts[0].likes, 0);
  assert.equal(result.posts[1].likes, null);
  assert.deepEqual(result.posts.map(p => p.type), ['short', 'video']);
});

test('official YouTube fetches 100 uploads in five requests and preserves missing metrics', async () => {
  let calls = 0;
  const result = await fetchPage({ ...page, platform: 'youtube' }, { ...settings, postLimit: 100, youtubeKey: 'official-fixture' }, async url => {
    calls++;
    const u = new URL(url);
    assert.equal(u.pathname.startsWith('/youtube/v3/'), true);
    if (u.pathname.endsWith('/channels')) return { items: [{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', snippet: { title: 'Official' }, statistics: { subscriberCount: '0' }, contentDetails: { relatedPlaylists: { uploads: 'playlist' } } }] };
    if (u.pathname.endsWith('/playlistItems')) {
      const second = u.searchParams.has('pageToken');
      return { items: Array.from({ length: 50 }, (_, i) => ({ contentDetails: { videoId: String(i + (second ? 50 : 0)) } })), ...(second ? {} : { nextPageToken: 'second' }) };
    }
    return { items: u.searchParams.get('id').split(',').map(id => ({ id, snippet: { title: id, publishedAt: '2026-10-20T12:00:00Z' }, statistics: { viewCount: '0', likeCount: '0' } })) };
  });
  assert.equal(calls, 5);
  assert.equal(result.posts.length, 100);
  assert.equal(result.posts[0].views, 0);
  assert.equal(result.posts[0].comments, null);
  assert.equal(result.provider, 'youtube-official');
});

test('private profiles and unsupported TikHub YouTube handles fail actionably', async () => {
  await assert.rejects(() => fetchPage(page, settings, async () => ({ code: 200, data: { user: { is_private: true } } })), /private/);
  await assert.rejects(() => fetchPage({ ...page, platform: 'youtube' }, settings, async () => { throw new Error('must not request'); }), /free YouTube/);
  await assert.rejects(() => fetchPage(page, settings, async () => ({ success: false, message: 'Profile is restricted' })), /restricted/);
});

test('date scope filters publication dates and scans past pinned old outliers until two older pages', async () => {
  const batches = [
    [{ pk:'pinned',created_at:'2025-05-01T12:00:00Z' },{ pk:'future',created_at:'2026-10-24T12:00:00Z' },{ pk:'a',created_at:'2026-10-20T12:00:00Z' }],
    [{ pk:'old-one',created_at:'2026-09-01T12:00:00Z' }],
    [{ pk:'b',created_at:'2026-10-18T12:00:00Z' }],
    [{ pk:'old-two',created_at:'2026-09-02T12:00:00Z' }],
    [{ pk:'old-three',created_at:'2026-09-03T12:00:00Z' }],
  ];
  let calls=0,feeds=0;
  const result=await fetchPage(page,{...settings,scope:{mode:'date',postLimit:1000,from:'2026-10-10T00:00:00Z',to:'2026-10-22T00:00:00Z'}},async()=>{
    if(++calls===1)return {code:200,data:{user:{id:'123',media_count:500}}};
    const items=batches[feeds++].map(p=>({...p,play_count:10,like_count:1,comment_count:0}));
    return {code:200,data:{items,more_available:true,next_max_id:String(feeds)}};
  });
  assert.equal(calls,6);
  assert.deepEqual(result.posts.map(p=>p.id),['a','b']);
  assert.equal(result.coverage.requestedMode,'date');
  assert.equal(result.coverage.scanned,7);
  assert.equal(result.coverage.fetched,2);
  assert.equal(result.coverage.oldest,'2026-10-18T12:00:00.000Z');
  assert.equal(result.coverage.newest,'2026-10-20T12:00:00.000Z');
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.stopReason,'date-boundary');
  assert.equal(result.overall.views,null);
  assert.equal(result.overall.posts,500);
});

test('date scope excludes undated posts and marks metric coverage partial even after complete traversal', async()=>{
  let calls=0;
  const result=await fetchPage(page,{...settings,scope:{mode:'date',postLimit:1000,from:'2026-10-01T00:00:00Z',to:'2026-11-01T00:00:00Z'}},async()=>++calls===1?{code:200,data:{user:{id:'123'}}}:{code:200,data:{items:[{pk:'a',created_at:'2026-10-20T12:00:00Z',play_count:10,like_count:1,comment_count:0},{pk:'unknown',play_count:100,like_count:5,comment_count:0}],more_available:false}});
  assert.deepEqual(result.posts.map(p=>p.id),['a']);
  assert.equal(result.coverage.scanned,2);
  assert.equal(result.coverage.unknownDates,1);
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.incomplete,true);
  assert.match(result.coverage.note,/excluded from the selected period/);
});

test('an empty fully scanned publication period is a valid zero-post selection', async()=>{
  let calls=0;
  const result=await fetchPage(page,{...settings,scope:{mode:'date',postLimit:1000,from:'2026-10-01T00:00:00Z',to:'2026-11-01T00:00:00Z'}},async()=>++calls===1?{code:200,data:{user:{id:'123'}}}:{code:200,data:{items:[{pk:'a',created_at:'2025-10-20T12:00:00Z',play_count:10}],more_available:false}});
  assert.equal(result.posts.length,0);
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.incomplete,false);
  assert.equal(result.coverage.oldest,null);
});

test('official YouTube returns separate lifetime totals and supports a custom 1000-post selection in 41 calls',async()=>{
  let calls=0;
  const result=await fetchPage({...page,platform:'youtube'},{...settings,youtubeKey:'fixture',scope:{mode:'posts',postLimit:1000,from:null,to:null}},async url=>{
    calls++;const u=new URL(url);
    if(u.pathname.endsWith('/channels'))return {items:[{id:'UCaaaaaaaaaaaaaaaaaaaaaa',snippet:{title:'Lifetime'},statistics:{viewCount:'9000000',videoCount:'3500',subscriberCount:'123'},contentDetails:{relatedPlaylists:{uploads:'uploads'}}}]};
    if(u.pathname.endsWith('/playlistItems')){const batch=Number(u.searchParams.get('pageToken')||0);return {items:Array.from({length:50},(_,i)=>({contentDetails:{videoId:String(batch*50+i)}})),nextPageToken:String(batch+1)};}
    return {items:u.searchParams.get('id').split(',').map(id=>({id,snippet:{publishedAt:'2026-10-20T12:00:00Z'},statistics:{viewCount:'10',likeCount:'2',commentCount:'0'}}))};
  });
  assert.equal(calls,41);
  assert.equal(result.posts.length,1000);
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.hasMore,true);
  assert.equal(result.overall.views,9000000);
  assert.equal(result.overall.posts,3500);
  assert.equal(result.posts.reduce((sum,p)=>sum+p.views,0),10000);
});

test('missing YouTube likes remain unavailable and get an explicit source note',async()=>{
  const result=await fetchPage({...page,platform:'youtube'},{...settings,youtubeKey:'fixture'},async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/channels'))return {items:[{id:'UCaaaaaaaaaaaaaaaaaaaaaa',statistics:{viewCount:'500',videoCount:'1'},contentDetails:{relatedPlaylists:{uploads:'uploads'}}}]};
    if(u.pathname.endsWith('/playlistItems'))return {items:[{contentDetails:{videoId:'bLYFhWWGjzA'}}]};
    return {items:[{id:'bLYFhWWGjzA',snippet:{publishedAt:'2026-10-20T12:00:00Z'},statistics:{viewCount:'18089',commentCount:'4',favoriteCount:'0'}}]};
  });
  assert.equal(result.posts[0].likes,null);
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.incomplete,true);
  assert.match(result.coverage.note,/YouTube did not return public like counts for 1\/1/);
});

test('Instagram public missing-like enrichment is limited to three detail calls',async()=>{
  let details=0;
  const result=await fetchPage(page,{...settings,provider:'scrapecreators',postLimit:5},async url=>{
    const u=new URL(url);
    if(u.pathname==='/v1/instagram/profile')return {success:true,user:{id:'123',username:'creator'}};
    if(u.pathname==='/v2/instagram/user/posts')return {success:true,items:Array.from({length:5},(_,i)=>({id:String(i),code:'post'+i,play_count:10,comment_count:0})),more_available:false};
    assert.equal(u.pathname,'/v1/instagram/post');details++;return {success:true,data:{xdt_shortcode_media:{edge_media_preview_like:{count:7}}}};
  });
  assert.equal(details,3);
  assert.equal(result.posts.filter(p=>p.likes===7).length,3);
  assert.equal(result.coverage.unavailableLikes,2);
  assert.equal(result.coverage.incomplete,true);
});

test('a final oversized feed cannot falsely claim complete date coverage past the scan cap',async()=>{
  let calls=0;
  const result=await fetchPage(page,{...settings,scope:{mode:'date',postLimit:1000,from:'2026-10-01T00:00:00Z',to:'2026-11-01T00:00:00Z'}},async()=>++calls===1?{code:200,data:{user:{id:'123'}}}:{code:200,data:{items:Array.from({length:1001},(_,i)=>({pk:String(i),created_at:'2026-10-20T12:00:00Z',play_count:1,like_count:1,comment_count:0})),more_available:false}});
  assert.equal(result.posts.length,1000);
  assert.equal(result.coverage.scanned,1000);
  assert.equal(result.coverage.complete,false);
  assert.equal(result.coverage.incomplete,true);
  assert.equal(result.coverage.stopReason,'post-scan-limit');
});

test('content type, audio and fractional durations come from the provider payload, never guessed', () => {
  assert.equal(instagramContentType({ media_type: 2, product_type: 'clips' }), 'reel');
  assert.equal(instagramContentType({ media_type: 2, product_type: 'igtv' }), 'video');
  assert.equal(instagramContentType({ __typename: 'XDTGraphSidecar' }), 'carousel');
  assert.equal(instagramContentType({ media_type: 8, product_type: 'carousel_container' }), 'carousel');
  assert.equal(instagramContentType({ __typename: 'GraphImage' }), 'image');
  assert.equal(instagramContentType({}), null);
  const reel = normalizeInstagramPost({ pk: '1', media_type: 2, product_type: 'clips', video_duration: 12.416,
    clips_metadata: { original_sound_info: { audio_asset_id: '1789012345678901' } } }, page);
  assert.equal(reel.type, 'reel'); assert.equal(reel.durationSeconds, 12.416); assert.equal(reel.audioId, '1789012345678901');
  assert.equal(normalizeInstagramPost({ pk: '2', clips_metadata: { music_info: { music_asset_info: { audio_cluster_id: 98765 } } } }, page).audioId, '98765');
  // An unsafe numeric ID has already lost precision, and an absent one stays null.
  assert.equal(normalizeInstagramPost({ pk: '3', clips_metadata: { original_sound_info: { audio_asset_id: 2 ** 60 } } }, page).audioId, null);
  assert.equal(normalizeInstagramPost({ pk: '4' }, page).type, null);
  const tiktok = { ...page, platform: 'tiktok' };
  const video = normalizeTikTokPost({ aweme_id: '8', video: { duration: 15123 }, music: { id: 7012345678901234567, id_str: '7012345678901234567' } }, tiktok);
  assert.equal(video.type, 'video'); assert.equal(video.durationSeconds, 15.123); assert.equal(video.audioId, '7012345678901234567');
  assert.equal(normalizeTikTokPost({ id: '9', video: { duration: 9.5 }, music: { id: '701' } }, tiktok).durationSeconds, 9.5);
  assert.equal(tiktokContentType({ image_post_info: { images: [] } }), 'carousel');
  assert.equal(normalizeTikTokPost({ id: '10', imagePost: { images: [{}] } }, tiktok).type, 'carousel');
  assert.equal(normalizeTikTokPost({ id: '11' }, tiktok).type, null);
  const youtube = { ...page, platform: 'youtube' };
  assert.equal(normalizeYouTubePost({ id: 'a', contentDetails: { duration: 'PT45S' } }, youtube).type, 'video');
  assert.equal(normalizeYouTubePost({ id: 'b' }, youtube, 'short').type, 'short');
  assert.equal(normalizeYouTubePost({ id: 'c', url: 'https://www.youtube.com/shorts/c' }, youtube).type, 'short');
  assert.equal(normalizeYouTubePost({ id: 'd' }, youtube).audioId, null);
  // Numeric strings are durations too: YouTube's lengthSeconds, and TikTok app milliseconds.
  assert.equal(normalizeYouTubePost({ id: 'e', lengthSeconds: '245' }, youtube).durationSeconds, 245);
  assert.equal(normalizeTikTokPost({ aweme_id: '12', video: { duration: '15123' } }, tiktok).durationSeconds, 15.123);
  assert.equal(normalizeTikTokPost({ id: '13', video: { duration: '9.5' } }, tiktok).durationSeconds, 9.5);
});

test('a legacy Instagram refresh keeps the content type', async () => {
  const result = await fetchPage(page, settings, async () => ({ code: 200, data: { user: { id: '123' }, items: [
    { pk: '1', media_type: 2, product_type: 'clips', play_count: 4, taken_at: 1790200000 },
    { pk: '2', media_type: 8, carousel_media: [], taken_at: 1790100000 }], more_available: false } }));
  assert.deepEqual(result.posts.map(p => p.type), ['reel', 'carousel']);
});
