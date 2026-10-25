export type AnalyticsPlatform = 'instagram' | 'tiktok' | 'youtube';
export type DateRange = { from: string; to: string };
export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'this-month' | 'last-month';
export type AnalyticsPost = {
  id: string; pageId: string; platform?: string; url: string; title: string;
  publishedAt: string | null; thumbnail: string | null; durationSeconds: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  type?: string | null; sourceAssetId?: string | null; observedAt?: string | null;
};
export type AnalyticsPage = {
  id: string; platform: AnalyticsPlatform; handle: string; url: string; name: string;
  followers: number | null; lastSyncedAt: string | null; syncError: string | null;
  posts: AnalyticsPost[]; monthlyPay: number | null; editor: string; startDate: string | null;
  active: boolean; notes: string; avatar?: string | null;
  coverage?: { requestedMode?: 'posts' | 'date'; from?: string | null; to?: string | null; complete?: boolean; hasMore?: boolean; limit?: number };
};
export type AccountSnapshot = { pageId: string; observedAt: string; followers: number | null; following: number | null; postCount: number | null };
export type PostSnapshot = { pageId: string; postId: string; observedAt: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null };
export type AnalyticsAlert = { id: string; pageId: string; level: 'red' | 'amber' | 'green'; type: string; title: string; details: string; createdAt: string; resolvedAt: string | null };
export type AnalyticsCollection = { id: string; name: string };
export type AnalyticsMembership = { collectionId: string; pageId: string };
export type AnalyticsDataset = { pages: AnalyticsPage[]; collections?: AnalyticsCollection[]; memberships?: AnalyticsMembership[]; accountSnapshots: AccountSnapshot[]; postSnapshots: PostSnapshot[]; alerts: AnalyticsAlert[]; historyTruncated?: boolean; generatedAt: string };
export type MetricCoverage = {
  status: 'complete' | 'partial' | 'unavailable'; known: number; total: number;
  from: string | null; to: string | null; reason: string; adjustments: number;
};
export type HealthComponentKey = 'trend' | 'median' | 'engagement' | 'growth' | 'consistency' | 'activity';
export type HealthComponent = { key: HealthComponentKey; label: string; weight: number; value: number | null; percentile: number | null; points: number | null };
export type HealthScore = { score: number | null; reason: string; peerCount: number; components: HealthComponent[] };
export type PageMetrics = {
  viewsGained: number | null; viewsCoverage: MetricCoverage; publishedViews: number | null;
  postsPublished: number; maturedPosts: number; comparablePosts: number; medianViews: number | null; averageViews: number | null;
  baselineMedian90d: number | null; baselineMedian30d: number | null; viewsTrend: number | null;
  iqrSpread: number | null; hitRate: number | null; engagementRate: number | null; shares: number | null;
  followers: number | null; followerGrowth: number | null; followerGrowthRate: number | null; followerCoverage: MetricCoverage;
  postsPerDay: number; maturedPostsPerDay: number; monthlyPay: number | null; pay: number | null; costPerPost: number | null;
  costPerMillion: number | null; viewsPerThousand: number | null;
};
export type AnalyzedPost = AnalyticsPost & {
  pageName: string; pageHandle: string; pagePlatform: AnalyticsPlatform; ageDays: number | null; maturing: boolean; inRange: boolean;
  fixedAgeViews: number | null; fixedAgeObservedAt: string | null; fixedAgeInteractions: number | null; engagementRate: number | null;
  baselineRatio: number | null; viral: boolean; viewsGained: number | null; viewsCoverage: MetricCoverage;
};
export type DailyPoint = { date: string; viewsGained: number | null; publishedViews: number | null; followers: number | null; followerGrowth: number | null; postsPublished: number; coverage: 'complete' | 'partial' | 'unavailable' };
export type PageAnalysis = { page: AnalyticsPage; metrics: PageMetrics; health: HealthScore; posts: AnalyzedPost[]; timeline: DailyPoint[] };
export type WorkspaceTotals = {
  pages: number; activePages: number; attentionPages: number; viewsGained: number | null; viewsCoverage: MetricCoverage;
  publishedViews: number | null; postsPublished: number; maturedPosts: number; comparablePosts: number;
  medianViews: number | null; averageViews: number | null; engagementRate: number | null; shares: number | null;
  followers: number | null; followerGrowth: number | null; followerCoverage: MetricCoverage;
  monthlyPay: number | null; pay: number | null; payKnownPages: number; costPerMillion: number | null; costPerPost: number | null;
  viewsPerThousand: number | null; mixedPlatforms: boolean;
};
export type MetricChange = { current: number | null; previous: number | null; difference: number | null; percent: number | null };
export type ComparisonMetrics = { viewsGained: MetricChange; pay: MetricChange; postsPublished: MetricChange; costPerMillion: MetricChange; medianViews: MetricChange; engagementRate: MetricChange; followerGrowth: MetricChange };
export type MonthlyRow = { month: string; range: DateRange; totals: WorkspaceTotals; pages: { pageId: string; metrics: PageMetrics }[] };
export type PlatformAnalysis = { platform: AnalyticsPlatform; totals: WorkspaceTotals; rankings: PageAnalysis[]; bestPageId: string | null; bestPost: AnalyzedPost | null };
export type WorkspaceAnalysis = {
  range: DateRange; compareRange: DateRange | null; days: number; generatedAt: string;
  pages: PageAnalysis[]; totals: WorkspaceTotals; platforms: PlatformAnalysis[]; timeline: DailyPoint[]; monthly: MonthlyRow[];
  comparison: { range: DateRange; totals: WorkspaceTotals; metrics: ComparisonMetrics; pages: { pageId: string; metrics: ComparisonMetrics }[]; verdict: string } | null;
  alerts: AnalyticsAlert[]; warnings: string[];
};
export type AlertCandidate = { pageId: string; level: 'red' | 'amber' | 'green'; type: string; title: string; details: string; fingerprint: string };
