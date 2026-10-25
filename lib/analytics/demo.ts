import { indiaDay } from './metrics';
import type { AnalyticsDataset, AnalyticsPage, AnalyticsPlatform, AnalyticsPost, PostSnapshot } from './types';

const DAY = 86_400_000;
type DemoPage = {
  name: string; handle: string; platform: AnalyticsPlatform; editor: string;
  pay: number; baseViews: number; followers: number; dailyGrowth: number;
  trend: number; engagement: number; theme: string[];
};

const profiles: DemoPage[] = [
  { name: 'Studio North Clips', handle: 'demo_studio_north', platform: 'instagram', editor: 'Aarav', pay: 18_000, baseViews: 24_000, followers: 48_200, dailyGrowth: 76, trend: .42, engagement: .049, theme: ['A small idea, a better routine', 'Behind the edit', 'Three things worth saving', 'The detail everyone missed'] },
  { name: 'Everyday Edit', handle: 'demo_everyday_edit', platform: 'instagram', editor: 'Meera', pay: 16_000, baseViews: 17_000, followers: 35_600, dailyGrowth: 31, trend: -.24, engagement: .032, theme: ['A fresh take on the everyday', 'One minute, one useful tip', 'A quieter kind of creativity', 'From the first cut to the final frame'] },
  { name: 'Loop Lab', handle: 'demo_loop_lab', platform: 'youtube', editor: 'Kabir', pay: 25_000, baseViews: 51_000, followers: 72_900, dailyGrowth: 123, trend: .34, engagement: .041, theme: ['How it works in 45 seconds', 'The experiment that surprised us', 'Small changes, visible results', 'One question, a clear answer'] },
  { name: 'Minute Science', handle: 'demo_minute_science', platform: 'youtube', editor: 'Isha', pay: 22_000, baseViews: 38_000, followers: 61_400, dailyGrowth: 65, trend: .08, engagement: .036, theme: ['The science hiding in plain sight', 'Try this simple experiment', 'Why does that happen?', 'A tiny discovery for your day'] },
  { name: 'Urban Motion', handle: 'demo_urban_motion', platform: 'tiktok', editor: 'Rohan', pay: 15_000, baseViews: 43_000, followers: 86_700, dailyGrowth: 147, trend: .53, engagement: .067, theme: ['A new angle on the city', 'The walk home, reimagined', 'Move with the moment', 'A story from the street'] },
  { name: 'Street Kitchen', handle: 'demo_street_kitchen', platform: 'tiktok', editor: 'Ananya', pay: 17_000, baseViews: 31_000, followers: 68_300, dailyGrowth: 82, trend: -.1, engagement: .058, theme: ['One pan, plenty of flavour', 'The recipe behind the queue', 'A familiar dish with a twist', 'Good food, simple ingredients'] },
];

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
    const page: AnalyticsPage = {
      id: pageId, platform: profile.platform, handle: profile.handle, name: profile.name,
      // No outbound profile, post, or image requests: all demo records are fictional.
      url: '', avatar: null, posts: [], followers: profile.followers,
      lastSyncedAt: generatedAt, syncError: null, monthlyPay: profile.pay,
      editor: profile.editor, startDate: indiaDay(new Date(firstObservation)), active: true,
      notes: 'Fictional demo page. Pay, people, posts and every observation are sample records. Tracking is illustrated over the last 120 days.',
      coverage: { requestedMode: 'date', from: indiaDay(new Date(firstObservation)), to: indiaDay(now), complete: true, hasMore: false },
    };

    // A post every two days provides at least eleven matured, age-matched posts
    // in the default thirty-day report, plus genuine earlier baseline samples.
    for (let index = 0; index < 60; index++) {
      const ageDays = 119 - index * 2;
      const publishedTime = observedAt - ageDays * DAY - (pageIndex + 1) * 45 * 60_000;
      const id = `demo-post-${pageIndex + 1}-${index + 1}`;
      const variation = 1 + Math.sin(index * 1.71 + pageIndex) * .22 + Math.cos(index * .83) * .08;
      const progression = 1 + profile.trend * index / 59;
      const viral = index === 51 && pageIndex % 2 === 0 ? 6.5 : 1;
      const daySevenViews = Math.round(profile.baseViews * variation * progression * viral);
      const valuesAt = (age: number): Pick<PostSnapshot, 'views' | 'likes' | 'comments' | 'shares' | 'saves'> => {
        const multiplier = age <= 7 ? Math.pow(Math.max(0, age) / 7, .72) : 1 + .13 * Math.log1p(age - 7);
        const views = Math.round(daySevenViews * multiplier);
        return {
          views, likes: Math.round(views * profile.engagement * .87),
          comments: Math.round(views * profile.engagement * .045),
          shares: profile.platform === 'tiktok' ? Math.round(views * profile.engagement * .085) : null,
          saves: null,
        };
      };
      const actualAge = (observedAt - publishedTime) / DAY;
      const post: AnalyticsPost = {
        id, pageId, platform: profile.platform, url: '', title: profile.theme[index % profile.theme.length],
        publishedAt: new Date(publishedTime).toISOString(), observedAt: generatedAt,
        thumbnail: null, durationSeconds: 21 + (index * 7 + pageIndex * 3) % 38,
        type: profile.platform === 'instagram' ? 'Reel' : profile.platform === 'youtube' ? 'Short' : 'Video',
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
        const timestamp = observedAt - back * DAY;
        if (timestamp >= publishedTime) observationTimes.add(timestamp);
      }
      for (const timestamp of [...observationTimes].sort((a, b) => a - b)) {
        result.postSnapshots.push({ pageId, postId: id, observedAt: new Date(timestamp).toISOString(), ...valuesAt((timestamp - publishedTime) / DAY) });
      }
    }

    for (let back = 120; back >= 0; back--) {
      const at = observedAt - back * DAY;
      const movement = Math.round(profile.dailyGrowth * back * (1 + .06 * Math.sin(back / 11 + pageIndex)));
      result.accountSnapshots.push({
        pageId, observedAt: new Date(at).toISOString(), followers: Math.max(0, profile.followers - movement),
        following: profile.platform === 'youtube' ? null : 120 + pageIndex * 37,
        postCount: page.posts.filter(post => Date.parse(post.publishedAt!) <= at).length,
      });
    }
    page.posts.reverse();
    result.pages.push(page);
    result.memberships.push({ collectionId: pageIndex === 2 || pageIndex === 3 ? 'demo-learning' : 'demo-stories', pageId });
  });

  result.alerts = [
    { id: 'demo-alert-1', pageId: 'demo-page-2', level: 'amber', type: 'performance-watch', title: 'Typical views need a closer look', details: 'Sample alert: recent matured posts are below this page’s earlier baseline. Review the content mix before changing its budget.', createdAt: new Date(observedAt - DAY).toISOString(), resolvedAt: null },
    { id: 'demo-alert-2', pageId: 'demo-page-5', level: 'green', type: 'opportunity', title: 'A format worth repeating', details: 'Sample alert: a matured post performed well above this page’s own baseline. Open the page to see its day-seven results and consistency.', createdAt: new Date(observedAt - 2 * DAY).toISOString(), resolvedAt: null },
  ];
  return result;
}

