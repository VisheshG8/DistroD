export type AnalyticsPlatform = 'instagram' | 'tiktok' | 'youtube';
export type DateRange = { from: string; to: string };
export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'this-month' | 'last-month';
export type AnalyticsPost = {
  id: string; pageId: string; platform?: string; url: string; title: string;
  publishedAt: string | null; thumbnail: string | null; durationSeconds: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  type?: string | null; sourceAssetId?: string | null; observedAt?: string | null;
  /** Provider audio ID: a Page × Content matching hint only, since re-uploads usually get a new one. */
  audioId?: string | null;
};
export type AnalyticsPage = {
  id: string; platform: AnalyticsPlatform; handle: string; url: string; name: string;
  followers: number | null; lastSyncedAt: string | null; syncError: string | null;
  posts: AnalyticsPost[]; monthlyPay: number | null; editor: string; startDate: string | null;
  active: boolean; notes: string; avatar?: string | null;
  /** Last paid day of an inactive page. Without one an inactive page counts no pay. */
  endDate?: string | null; alertQuietDays?: number | null;
  /** The owner's internal Page Master name; name stays the provider's. Blank when not set. */
  displayName?: string;
  coverage?: { requestedMode?: 'posts' | 'date'; from?: string | null; to?: string | null; complete?: boolean; hasMore?: boolean; limit?: number };
};
export type AccountSnapshot = { pageId: string; observedAt: string; followers: number | null; following: number | null; postCount: number | null };
export type PostSnapshot = { pageId: string; postId: string; observedAt: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null };
export type AnalyticsAlert = { id: string; pageId: string; level: 'red' | 'amber' | 'green'; type: string; title: string; details: string; createdAt: string; resolvedAt: string | null; postId?: string | null };
export type AnalyticsCollection = { id: string; name: string };
export type AnalyticsMembership = { collectionId: string; pageId: string };
export type AnalyticsDataset = { pages: AnalyticsPage[]; collections?: AnalyticsCollection[]; memberships?: AnalyticsMembership[]; accountSnapshots: AccountSnapshot[]; postSnapshots: PostSnapshot[]; alerts: AnalyticsAlert[]; historyTruncated?: boolean; generatedAt: string };
export type MetricCoverage = {
  status: 'complete' | 'partial' | 'unavailable'; known: number; total: number;
  from: string | null; to: string | null; reason: string; adjustments: number;
};
export type HealthComponentKey = 'trend' | 'median' | 'engagement' | 'growth' | 'consistency' | 'activity';
/** score is the 0-100 component score; percentile is only the rank among active same-platform peers. */
export type HealthComponent = { key: HealthComponentKey; label: string; weight: number; value: number | null; score: number | null; percentile: number | null; points: number | null };
export type HealthBand = 'good' | 'watch' | 'low' | 'pending';
export type HealthScore = {
  score: number | null; reason: string; peerCount: number; components: HealthComponent[];
  band: HealthBand; code: 'scored' | 'provisional' | 'few-posts' | 'missing'; provisional: boolean;
  basis: 'range' | 'matured-window' | null; window: DateRange | null;
};
export type PageMetrics = {
  viewsGained: number | null; viewsCoverage: MetricCoverage; publishedViews: number | null;
  postsPublished: number; maturedPosts: number; comparablePosts: number; medianViews: number | null; averageViews: number | null;
  baselineMedian90d: number | null; baselineMedian30d: number | null; viewsTrend: number | null;
  iqrSpread: number | null; hitRate: number | null; engagementRate: number | null; shares: number | null;
  followers: number | null; followerGrowth: number | null; followerGrowthRate: number | null; followerCoverage: MetricCoverage;
  postsPerDay: number; maturedPostsPerDay: number; monthlyPay: number | null; pay: number | null; costPerPost: number | null;
  costPerMillion: number | null; viewsPerThousand: number | null;
  saves: number | null; shareRate: number | null; engagementPerPost: number | null; consistencyScore: number | null;
  viewsPerPost: number | null; costPerThousand: number | null;
};
export type AnalyzedPost = AnalyticsPost & {
  pageName: string; pageHandle: string; pagePlatform: AnalyticsPlatform; ageDays: number | null; maturing: boolean; inRange: boolean;
  fixedAgeViews: number | null; fixedAgeObservedAt: string | null; fixedAgeInteractions: number | null; engagementRate: number | null;
  baselineRatio: number | null; viral: boolean; viewsGained: number | null; viewsCoverage: MetricCoverage;
  pageEditor: string; typeLabel: string; fixedAgeShares: number | null; fixedAgeSaves: number | null; shareRate: number | null;
};
export type PostPick = { post: AnalyzedPost; value: number; basis: 'day-7' | 'latest' };
export type DailyPoint = { date: string; viewsGained: number | null; publishedViews: number | null; followers: number | null; followerGrowth: number | null; postsPublished: number; coverage: 'complete' | 'partial' | 'unavailable' };
export type PageAnalysis = {
  page: AnalyticsPage; metrics: PageMetrics; health: HealthScore; posts: AnalyzedPost[]; timeline: DailyPoint[];
  bestPost: PostPick | null; worstPost: PostPick | null; costEfficiency: number | null; distributionScore: number | null;
};
export type WorkspaceTotals = {
  pages: number; activePages: number; attentionPages: number; viewsGained: number | null; viewsCoverage: MetricCoverage;
  publishedViews: number | null; postsPublished: number; maturedPosts: number; comparablePosts: number;
  medianViews: number | null; averageViews: number | null; engagementRate: number | null; shares: number | null;
  followers: number | null; followerGrowth: number | null; followerCoverage: MetricCoverage;
  monthlyPay: number | null; pay: number | null; payKnownPages: number; costPerMillion: number | null; costPerPost: number | null;
  viewsPerThousand: number | null; mixedPlatforms: boolean;
  /** Cost ratios use only paid pages: costPages for cost per post, costViewPages (paid pages with recorded views) for view ratios. */
  costPages: number; costViewPages: number; costPerThousand: number | null; inactivePages: number;
  saves: number | null; shareRate: number | null; viewsPerPost: number | null;
};
export type MetricChange = { current: number | null; previous: number | null; difference: number | null; percent: number | null };
export type ComparisonMetrics = { viewsGained: MetricChange; pay: MetricChange; postsPublished: MetricChange; costPerMillion: MetricChange; medianViews: MetricChange; engagementRate: MetricChange; followerGrowth: MetricChange };
export type MonthlyChangeKey = 'pay' | 'views' | 'posts' | 'costPerThousand' | 'viewsPerPost';
export type MonthlyChange = { month: string; against: 'previous-month' | 'same-days'; range: DateRange; partial: boolean; metrics: Record<MonthlyChangeKey, MetricChange> };
export type MonthlyRow = {
  month: string; range: DateRange; totals: WorkspaceTotals; pages: { pageId: string; metrics: PageMetrics }[];
  partial: boolean; sameDays: { range: DateRange; totals: WorkspaceTotals } | null; change: MonthlyChange | null;
};
export type PlatformAnalysis = { platform: AnalyticsPlatform; totals: WorkspaceTotals; rankings: PageAnalysis[]; bestPageId: string | null; bestPost: AnalyzedPost | null; bestPostBasis: 'day-7' | 'latest' | null };
export type WorkspaceAnalysis = {
  range: DateRange; compareRange: DateRange | null; days: number; generatedAt: string;
  pages: PageAnalysis[]; totals: WorkspaceTotals; platforms: PlatformAnalysis[]; timeline: DailyPoint[]; monthly: MonthlyRow[];
  comparison: { range: DateRange; totals: WorkspaceTotals; metrics: ComparisonMetrics; pages: { pageId: string; metrics: ComparisonMetrics }[]; verdict: string } | null;
  alerts: AnalyticsAlert[]; warnings: string[];
};
export type AlertCandidate = { pageId: string; level: 'red' | 'amber' | 'green'; type: string; title: string; details: string; fingerprint: string; postId?: string | null };
/** unchecked pages could not be evaluated now; their open alerts must be kept, not resolved. */
export type AlertCheck = { candidates: AlertCandidate[]; unchecked: { pageId: string; reason: string }[] };
export type StandoutKey = 'most-viewed' | 'most-shared' | 'most-saved' | 'most-engaging' | 'most-followers' | 'least-viewed' | 'least-engaging' | 'lowest-share-rate' | 'below-baseline';
export type ContentStandout = { key: StandoutKey; direction: 'highest' | 'lowest'; label: string; post: AnalyzedPost | null; value: number | null; basis: 'day-7' | 'latest' | null; note: string };
