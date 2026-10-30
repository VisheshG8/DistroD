import { alertCandidates, indiaDay } from './metrics';
import type { AnalyticsDataset, AnalyticsPage, AnalyticsPlatform, AnalyticsPost, PostSnapshot } from './types';

const DAY = 86_400_000;
type DemoPage = {
  name: string; handle: string; platform: AnalyticsPlatform; editor: string;
  pay: number; baseViews: number; followers: number; dailyGrowth: number;
  trend: number; engagement: number; theme: string[];
  /** Days before now that pay starts (default 120), the page stopped (inactive) or stopped posting; the recent slump; followers lost lately. */
  payDays?: number; endDays?: number; quietDays?: number; slump?: number; followerLoss?: number; alertQuietDays?: number;
};

const profiles: DemoPage[] = [
  { name: 'Studio North Clips', handle: 'demo_studio_north', platform: 'instagram', editor: 'Aarav', pay: 18_000, baseViews: 24_000, followers: 48_200, dailyGrowth: 76, trend: .42, engagement: .049, theme: ['A small idea, a better routine', 'Behind the edit', 'Three things worth saving', 'The detail everyone missed'] },
  { name: 'Everyday Edit', handle: 'demo_everyday_edit', platform: 'instagram', editor: 'Meera', pay: 16_000, baseViews: 17_000, followers: 35_600, dailyGrowth: 31, trend: -.24, engagement: .032, slump: .5, theme: ['A fresh take on the everyday', 'One minute, one useful tip', 'A quieter kind of creativity', 'From the first cut to the final frame'] },
  { name: 'Loop Lab', handle: 'demo_loop_lab', platform: 'youtube', editor: 'Kabir', pay: 25_000, baseViews: 51_000, followers: 72_900, dailyGrowth: 123, trend: .34, engagement: .041, alertQuietDays: 3, theme: ['How it works in 45 seconds', 'The experiment that surprised us', 'Small changes, visible results', 'One question, a clear answer'] },
  { name: 'Minute Science', handle: 'demo_minute_science', platform: 'youtube', editor: 'Kabir', pay: 22_000, baseViews: 38_000, followers: 61_400, dailyGrowth: 65, trend: .08, engagement: .036, quietDays: 8, theme: ['The science hiding in plain sight', 'Try this simple experiment', 'Why does that happen?', 'A tiny discovery for your day'] },
  { name: 'Urban Motion', handle: 'demo_urban_motion', platform: 'tiktok', editor: 'Rohan', pay: 15_000, baseViews: 43_000, followers: 86_700, dailyGrowth: 147, trend: .53, engagement: .067, theme: ['A new angle on the city', 'The walk home, reimagined', 'Move with the moment', 'A story from the street'] },
  { name: 'Street Kitchen', handle: 'demo_street_kitchen', platform: 'tiktok', editor: 'Ananya', pay: 17_000, baseViews: 31_000, followers: 68_300, dailyGrowth: 82, trend: -.1, engagement: .058, payDays: 60, followerLoss: 1_500, theme: ['One pan, plenty of flavour', 'The recipe behind the queue', 'A familiar dish with a twist', 'Good food, simple ingredients'] },
  { name: 'Campus Notes', handle: 'demo_campus_notes', platform: 'instagram', editor: 'Meera', pay: 9_000, baseViews: 11_000, followers: 21_900, dailyGrowth: 18, trend: -.18, engagement: .038, endDays: 20, theme: ['Notes from the library', 'A study trick that sticks', 'Exam week, simplified', 'What the syllabus leaves out'] },
];

/** The same content distributed on several pages (Page × Content). ca_demo-* groups are confirmed links;
 * the unlinked ones keep sourceAssetId null so the automatic-match review queue has real candidates. */
const shared: { index: number; asset: string | null; title: string; duration: number; members: { page: number; views: number }[] }[] = [
  { index: 45, asset: 'ca_demo-1', title: 'Why the metro beats the road at rush hour', duration: 34.2, members: [{ page: 0, views: 2.1 }, { page: 1, views: .9 }, { page: 2, views: .45 }, { page: 4, views: 1.4 }] },
  { index: 47, asset: 'ca_demo-2', title: 'The five-minute habit that fixed my mornings', duration: 41.8, members: [{ page: 0, views: .6 }, { page: 2, views: 1.7 }, { page: 4, views: .55 }] },
  { index: 49, asset: 'ca_demo-3', title: 'How a street vendor prices a cup of tea', duration: 27.5, members: [{ page: 1, views: 1.8 }, { page: 2, views: .8 }, { page: 4, views: 1.1 }, { page: 5, views: 1.6 }] },
  { index: 51, asset: 'ca_demo-4', title: 'What really happens when your phone overheats', duration: 52, members: [{ page: 0, views: 1.2 }, { page: 1, views: .7 }, { page: 5, views: .9 }] },
  { index: 53, asset: null, title: 'The real reason airline food tastes different', duration: 38.6, members: [{ page: 0, views: 1.1 }, { page: 2, views: .9 }, { page: 5, views: 1.3 }] },
  { index: 57, asset: null, title: 'Three questions to ask before buying a used bike', duration: 45.3, members: [{ page: 1, views: 1 }, { page: 4, views: 1.2 }, { page: 5, views: .8 }] },
];
// Each page reposts with its own caption habits: hashtags, emoji and a call to action.
const captionStyle = (pageIndex: number, title: string) => [title + ' #learn', title + '\nFollow for more', title + ' #shorts', title, title + ' 👀', title + ' #streetfood', title][pageIndex];
const istMidnight = (day: string) => Date.parse(day + 'T00:00:00+05:30');

export type DemoDataset = AnalyticsDataset & {
  collections: { id: string; name: string }[];
  memberships: { collectionId: string; pageId: string }[];
};

/** Fictional, deterministic records for the public demo. Never reads or writes a workspace. */
export function createDemoDataset(now: Date = new Date()): DemoDataset {
  const generatedAt = now.toISOString();
  const observedAt = now.getTime();
  const firstObservation = observedAt - 120 * DAY;
  const result: DemoDataset = {
    pages: [], accountSnapshots: [], postSnapshots: [], alerts: [], generatedAt,
    collections: [{ id: 'demo-stories', name: 'Stories & culture' }, { id: 'demo-learning', name: 'Ideas & learning' }],
    memberships: [],
  };

  profiles.forEach((profile, pageIndex) => {
    const pageId = `demo-page-${pageIndex + 1}`;
    // An inactive page stopped being refreshed (and paid) on its end date.
    const lastSeen = observedAt - (profile.endDays ?? 0) * DAY, active = profile.endDays === undefined;
    const page: AnalyticsPage = {
      id: pageId, platform: profile.platform, handle: profile.handle, name: profile.name,
      // No outbound profile, post, or image requests: all demo records are fictional.
      url: '', avatar: null, posts: [], followers: null,
      lastSyncedAt: new Date(lastSeen).toISOString(), syncError: null, monthlyPay: profile.pay,
      editor: profile.editor, startDate: indiaDay(new Date(observedAt - (profile.payDays ?? 120) * DAY)), active,
      endDate: active ? null : indiaDay(new Date(lastSeen)), alertQuietDays: profile.alertQuietDays ?? null,
      notes: active ? 'Fictional demo page. Pay, people, posts and every observation are sample records. Tracking is illustrated over the last 120 days.'
        : 'Fictional demo page, paused: pay stopped on its end date and its saved history is kept.',
      coverage: { requestedMode: 'date', from: new Date(istMidnight(indiaDay(new Date(firstObservation)))).toISOString(),
        to: new Date(istMidnight(indiaDay(new Date(lastSeen))) + DAY).toISOString(), complete: true, hasMore: false },
    };

    // A post every two days provides at least eleven matured, age-matched posts
    // in the default thirty-day report, plus genuine earlier baseline samples.
    for (let index = 0; index < 60; index++) {
      const repost = shared.find(item => item.index === index), member = repost?.members.findIndex(item => item.page === pageIndex) ?? -1;
      const copy = repost && member >= 0 ? repost.members[member] : null;
      // Reposts land within a few days of each other, so the publish window is a usable matching signal.
      const ageDays = 119 - index * 2 - (copy ? member * .75 : 0);
      const publishedTime = observedAt - ageDays * DAY - (pageIndex + 1) * 45 * 60_000;
      if (publishedTime > lastSeen || (profile.quietDays && ageDays < profile.quietDays)) continue;
      const id = `demo-post-${pageIndex + 1}-${index + 1}`;
      const variation = 1 + Math.sin(index * 1.71 + pageIndex) * .22 + Math.cos(index * .83) * .08;
      const progression = 1 + profile.trend * index / 59;
      const viral = index === 55 && (pageIndex === 0 || pageIndex === 4) ? 8 : 1;
      // A slump in the latest matured fortnight gives the alert rules a real decline to find.
      const slumping = !!profile.slump && ageDays < 15;
      const daySevenViews = Math.round(profile.baseViews * variation * progression * viral * (copy?.views ?? 1) * (slumping ? profile.slump! : 1));
      const engagementRate = profile.engagement * (slumping ? .6 : 1);
      // Instagram does not publish carousel views, and long YouTube uploads sit beside Shorts.
      const type = copy ? profile.platform === 'instagram' ? 'reel' : profile.platform === 'youtube' ? 'short' : 'video'
        : profile.platform === 'instagram' ? index % 7 === 3 ? 'carousel' : pageIndex === 1 && index === 20 ? null : 'reel'
          : profile.platform === 'youtube' ? pageIndex === 2 && index % 5 === 1 ? 'video' : 'short'
            : pageIndex === 5 && index % 9 === 4 ? 'carousel' : 'video';
      const valuesAt = (age: number): Pick<PostSnapshot, 'views' | 'likes' | 'comments' | 'shares' | 'saves'> => {
        const multiplier = age <= 7 ? Math.pow(Math.max(0, age) / 7, .72) : 1 + .13 * Math.log1p(age - 7);
        const views = Math.round(daySevenViews * multiplier);
        return {
          views: profile.platform === 'instagram' && type === 'carousel' ? null : views, likes: Math.round(views * engagementRate * .87),
          comments: Math.round(views * engagementRate * .045),
          // Only TikTok publishes share and save counts; Instagram and YouTube keep them unavailable.
          shares: profile.platform === 'tiktok' ? Math.round(views * engagementRate * .085) : null,
          saves: profile.platform === 'tiktok' ? Math.round(views * engagementRate * .06) : null,
        };
      };
      const actualAge = (lastSeen - publishedTime) / DAY;
      const post: AnalyticsPost = {
        id, pageId, platform: profile.platform, url: '', title: copy ? captionStyle(pageIndex, repost!.title) : profile.theme[index % profile.theme.length],
        publishedAt: new Date(publishedTime).toISOString(), observedAt: new Date(lastSeen).toISOString(), thumbnail: null,
        // Fractional seconds as providers report them; a re-encoded repost differs by a frame or two.
        durationSeconds: profile.platform === 'instagram' && type === 'carousel' ? null : copy ? Math.round((repost!.duration + [0, .04, -.03, .07][member]) * 1000) / 1000
          : type === 'video' && profile.platform === 'youtube' ? 240 + index * 13 % 420 : Math.round((21 + (index * 7 + pageIndex * 3) % 38 + (index % 10) / 10) * 1000) / 1000,
        type, sourceAssetId: copy ? repost!.asset : null,
        audioId: profile.platform === 'youtube' || type === 'carousel' ? null : copy && repost!.index === 45 && profile.platform === 'tiktok' ? 'demo-audio-metro' : `demo-audio-${pageIndex + 1}-${index + 1}`,
        ...valuesAt(actualAge),
      };
      page.posts.push(post);
      // Exact day-seven snapshots establish fair fixed-age comparisons. Later
      // observations retain real differences instead of fabricating range gains.
      const ages = [1, 3, 7, 10, 14, 21, 30, 45, 60, 90].filter(age => age < actualAge);
      const observationTimes = new Set(ages.map(age => publishedTime + age * DAY));
      // One observation per day during the last month keeps the live demo's
      // growth chart useful, while older retained snapshots stay less frequent.
      for (let back = 30; back >= 0; back--) {
        const timestamp = lastSeen - back * DAY;
        if (timestamp >= publishedTime) observationTimes.add(timestamp);
      }
      for (const timestamp of [...observationTimes].sort((a, b) => a - b)) {
        result.postSnapshots.push({ pageId, postId: id, observedAt: new Date(timestamp).toISOString(), ...valuesAt((timestamp - publishedTime) / DAY) });
      }
    }

    // followerLoss is shed over the last ten days, after months of steady growth.
    const followersAt = (back: number) => Math.max(0, profile.followers + (profile.followerLoss ?? 0) - Math.round(profile.dailyGrowth * back * (1 + .06 * Math.sin(back / 11 + pageIndex)))
      - (profile.followerLoss && back < 10 ? Math.round(profile.followerLoss * (10 - back) / 10) : 0));
    for (let back = 120; back >= (profile.endDays ?? 0); back--) {
      const at = observedAt - back * DAY;
      result.accountSnapshots.push({
        pageId, observedAt: new Date(at).toISOString(), followers: followersAt(back),
        following: profile.platform === 'youtube' ? null : 120 + pageIndex * 37,
        postCount: page.posts.filter(post => Date.parse(post.publishedAt!) <= at).length,
      });
    }
    page.followers = followersAt(profile.endDays ?? 0);
    page.posts.reverse();
    result.pages.push(page);
    result.memberships.push({ collectionId: pageIndex === 2 || pageIndex === 3 || pageIndex === 6 ? 'demo-learning' : 'demo-stories', pageId });
  });

  // The alerts are the engine's own output for this data, so the demo shows exactly what a workspace would.
  result.alerts = alertCandidates(result, now).map((candidate, index) => ({
    id: `demo-alert-${index + 1}`, pageId: candidate.pageId, level: candidate.level, type: candidate.type, title: candidate.title,
    details: candidate.details, postId: candidate.postId ?? null, createdAt: new Date(observedAt - (candidate.level === 'red' ? 1 : 2) * DAY).toISOString(), resolvedAt: null,
  }));
  return result;
}
