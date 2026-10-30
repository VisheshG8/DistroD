"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, AlertCircle, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, ArrowUpRight, Bell, CalendarDays, ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, CircleHelp, ExternalLink, FileText, FolderOpen, Grid3x3, IndianRupee, LayoutDashboard, Layers3, Loader2, LogOut, Pause, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users, Video, X } from 'lucide-react';
import SignOutButton from '@/components/auth/sign-out-button';
import { WorkspaceDialog } from '@/components/workspace-dialog';
import { downloadFile } from '@/lib/workspace-transfer';
import { parsePage } from '@/lib/pages';
import { PRODUCT_NAME } from '@/lib/product';
import { loadAnalyticsDataset } from '@/lib/analytics/client';
import { HISTORY_REUSE_MS, historyStart, narrowHistory } from '@/lib/analytics/history-window';
import { applyContentLinks, contentMatrix, contentTitle, isContentGroup, linkKey, MATCH_RULES, suggestMatches, type MatchMember, type MatchSuggestion } from '@/lib/analytics/matching';
import { ALERT_RULES, calculateHealthScores, contentStandouts, createWorkspaceCalculator, healthBand, indiaDay, previousRange, rangeForPreset } from '@/lib/analytics/metrics';
import type { AnalyticsAlert, AnalyticsDataset, AnalyticsPage, AnalyticsPlatform, AnalyzedPost, ComparisonMetrics, ContentStandout, DateRange, HealthBand, MetricChange, MetricCoverage, MonthlyChangeKey, MonthlyRow, PageAnalysis, PostPick, RangePreset, WorkspaceAnalysis, WorkspaceTotals } from '@/lib/analytics/types';
import './analytics.css';

type Account = { id: string; email: string | null; name: string | null; userType: 'admin' | 'user' };
type Section = 'overview' | 'pages' | 'performance' | 'posts' | 'matrix' | 'economics' | 'monthly' | 'alerts';
type ViewMode = 'gained' | 'published';
type PostSort = 'newest' | 'views' | 'shares' | 'engagement' | 'best' | 'least-viewed' | 'least-engaging' | 'lowest-share-rate' | 'worst';
type Sort = { key: string; dir: 'asc' | 'desc' };
type Modal = { type: 'add' } | { type: 'edit' | 'remove'; page: AnalyticsPage } | null;
type PageForm = { input: string; platform: AnalyticsPlatform; displayName: string; monthlyPay: string; editor: string; startDate: string; active: boolean; notes: string };
type MonthlyRestore = { range: DateRange; preset: string; auto: DateRange };
type ExtendedDataset = AnalyticsDataset & { collections?: { id: string; name: string }[]; memberships?: { collectionId: string; pageId: string }[] };
type LoadedHistory = { key: string; revision: number; start: number; stale: boolean; dataset: ExtendedDataset };
const emptyForm: PageForm = { input: '', platform: 'instagram', displayName: '', monthlyPay: '', editor: '', startDate: '', active: true, notes: '' };
const platforms: AnalyticsPlatform[] = ['instagram', 'youtube', 'tiktok'];
const platformNames = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' };
const platformShort = { instagram: 'IG', youtube: 'YT', tiktok: 'TT' };
// Codes follow the owner's spec numbering (05 is not a dashboard tab).
const sections: { id: Section; code: string; label: string; icon: typeof Activity }[] = [
  { id: 'overview', code: '01', label: 'Command Center', icon: LayoutDashboard }, { id: 'pages', code: '02', label: 'Page Master', icon: Users },
  { id: 'performance', code: '03', label: 'Page Performance', icon: ChartNoAxesCombined }, { id: 'posts', code: '04', label: 'Content Tracker', icon: Video },
  { id: 'matrix', code: '06', label: 'Page × Content', icon: Grid3x3 }, { id: 'economics', code: '07', label: 'Economics', icon: IndianRupee },
  { id: 'monthly', code: '08', label: 'Monthly Report', icon: FileText }, { id: 'alerts', code: '09', label: 'Attention / Alerts', icon: Bell },
];
const presets: { id: RangePreset | '6m'; label: string }[] = [{ id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: '90d', label: '90 days' }, { id: 'this-month', label: 'This month' }, { id: 'last-month', label: 'Last month' }, { id: '6m', label: 'Last 6 months' }];
const bandLabels: Record<HealthBand, string> = { good: 'Healthy', watch: 'Watch', low: 'At risk', pending: 'Building history' };
const postSorts: { id: PostSort; label: string; key: 'views' | 'shares' | 'engagementRate' | 'baselineRatio' | 'fixedAgeViews' | 'shareRate' | null; asc?: boolean; raw?: boolean }[] = [
  { id: 'newest', label: 'Newest posts', key: null }, { id: 'views', label: 'Most viewed', key: 'views', raw: true }, { id: 'shares', label: 'Most shared', key: 'shares', raw: true },
  { id: 'engagement', label: 'Most engaging', key: 'engagementRate', raw: true }, { id: 'best', label: 'Best against baseline', key: 'baselineRatio' },
  { id: 'least-viewed', label: 'Lowest day-7 views', key: 'fixedAgeViews', asc: true, raw: true }, { id: 'least-engaging', label: 'Least engaging', key: 'engagementRate', asc: true, raw: true },
  { id: 'lowest-share-rate', label: 'Lowest share rate', key: 'shareRate', asc: true, raw: true }, { id: 'worst', label: 'Lowest against baseline', key: 'baselineRatio', asc: true },
];
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const decimalFormats = new Map<number, Intl.NumberFormat>();
const moneyFormat = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const smallMoneyFormat = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const exactDateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
const shortDateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const count = (value: number | null | undefined, compact = false) => isNumber(value) ? (compact ? compactFormat : numberFormat).format(value) : '-';
const decimal = (value: number | null | undefined, digits = 2) => {
  if (!isNumber(value)) return '-';
  if (!decimalFormats.has(digits)) decimalFormats.set(digits, new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }));
  return decimalFormats.get(digits)!.format(value);
};
const money = (value: number | null | undefined) => isNumber(value) ? (value < 100 && value !== 0 ? smallMoneyFormat : moneyFormat).format(value) : '-';
const percent = (value: number | null | undefined) => isNumber(value) ? percentFormat.format(value) : '-';
const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (month: string) => monthFormat.format(new Date(month + '-15T12:00:00Z'));
/** The owner's Page Master name wins; the provider name and the handle are fallbacks. */
const pageLabel = (page: AnalyticsPage) => page.displayName || page.name || page.handle;
const steadiness = (score: number | null) => !isNumber(score) ? 'Needs day-7 posts' : score >= 75 ? 'Steady' : score >= 50 ? 'Variable' : 'Erratic';
const delta = (current: number | null, previous: number | null): MetricChange => ({ current, previous, difference: current !== null && previous !== null ? current - previous : null, percent: current !== null && previous !== null && previous !== 0 ? (current - previous) / Math.abs(previous) : null });
/** The current month plus the previous months - 1 whole months, ending today (India time). */
function recentMonths(now: string, months: number): DateRange {
  const current = rangeForPreset('this-month', now), year = Number(current.from.slice(0, 4)), month = Number(current.from.slice(5, 7));
  return { from: new Date(Date.UTC(year, month - months, 1)).toISOString().slice(0, 10), to: current.to };
}
/** Sort a copy; missing values always go last, whatever the direction. */
function sortRows<T>(rows: T[], sort: Sort, read: (row: T, key: string) => number | string | null | undefined) {
  const sign = sort.dir === 'asc' ? 1 : -1, blank = (value: unknown) => value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value));
  return [...rows].sort((a, b) => { const av = read(a, sort.key), bv = read(b, sort.key); if (blank(av)) return blank(bv) ? 0 : 1; if (blank(bv)) return -1; return sign * (typeof av === 'string' ? av.localeCompare(String(bv)) : (av as number) - (bv as number)); });
}
function date(value: string | null | undefined, exact = false) {
  if (!value) return 'Not available';
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T12:00:00Z' : value);
  if (!Number.isFinite(at.getTime())) return 'Not available';
  return (exact ? exactDateFormat : dateFormat).format(at) + (exact ? ' IST' : '');
}
const rangeLabel = (range: DateRange) => date(range.from) + ' – ' + date(range.to);
const shortDate = (value: string) => shortDateFormat.format(new Date(value + 'T12:00:00Z'));
const initials = (value: string | null | undefined) => (value || 'P').replace(/^@/, '').slice(0, 2).toUpperCase();
const safeUrl = (value: string | null | undefined) => value && /^https:\/\//i.test(value) ? value : null;
function validRange(range: DateRange) {
  return /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to) &&
    Number.isFinite(Date.parse(range.from)) && Number.isFinite(Date.parse(range.to)) && range.from <= range.to;
}
function pageSlice<T>(items: T[], current: number, size = 25) { const start = Math.min(current, Math.max(0, Math.ceil(items.length / size) - 1)) * size; return items.slice(start, start + size); }

function CsvDownload(name: string, rows: (string | number | null | undefined)[][]) {
  const cell = (value: string | number | null | undefined) => {
    if (value == null) return '';
    // Ratios and prorated money are rounded so spreadsheets show report-ready values.
    const raw = typeof value === 'number' && !Number.isInteger(value) ? String(Math.round(value * 10_000) / 10_000) : String(value), safe = typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  downloadFile(new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), name + '.csv');
}
function Pagination({ total, current, onChange }: { total: number; current: number; onChange: (page: number) => void }) {
  const last = Math.max(0, Math.ceil(total / 25) - 1), active = Math.min(current, last);
  return <div className="an-pagination"><span>{total ? `${count(active * 25 + 1)}–${count(Math.min(total, (active + 1) * 25))} of ${count(total)}` : '0 records'}</span><div><button className="an-button" disabled={active === 0} onClick={() => onChange(active - 1)}><ChevronLeft size={15} />Previous</button><button className="an-button" disabled={active === last} onClick={() => onChange(active + 1)}>Next<ChevronRight size={15} /></button></div></div>;
}
function Coverage({ value }: { value: MetricCoverage | undefined }) {
  if (!value || value.status === 'complete') return null;
  return <span className={'an-coverage ' + value.status} title={value.reason}>{value.status === 'partial' ? 'Partial history' : 'History needed'}<CircleHelp size={12} /></span>;
}
function Change({ change, lowerBetter = false, neutral = false, against = 'vs comparison' }: { change?: MetricChange; lowerBetter?: boolean; neutral?: boolean; against?: string }) {
  if (!change || change.difference == null) return <span className="an-change neutral">Comparison unavailable</span>;
  // Spend is neither good nor bad on its own, so pay changes stay neutral.
  const direction = change.difference === 0 || neutral ? 'neutral' : (change.difference > 0) !== lowerBetter ? 'up' : 'down';
  return <span className={'an-change ' + direction}>{change.difference > 0 ? '+' : ''}{change.percent == null ? decimal(change.difference) : percent(change.percent)}{against && <> <small>{against}</small></>}</span>;
}
function Kpi({ label, value, note, featured = false, text = false, change, lowerBetter, neutral, coverage, children }: { label: string; value: string; note?: string; featured?: boolean; text?: boolean; change?: MetricChange; lowerBetter?: boolean; neutral?: boolean; coverage?: MetricCoverage; children?: ReactNode }) {
  return <div className={'an-kpi' + (featured ? ' featured' : '') + (text ? ' text' : '')}><span>{label}</span><strong title={text ? value : undefined}>{value}</strong>{change ? <Change change={change} lowerBetter={lowerBetter} neutral={neutral} /> : note && <small>{note}</small>}{change && note && <small>{note}</small>}<Coverage value={coverage} />{children}</div>;
}
function SortHeader({ label, id, sort, onSort, title }: { label: string; id: string; sort: Sort; onSort: (sort: Sort) => void; title?: string }) {
  const active = sort.key === id;
  return <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} title={title}><button type="button" className={'an-sort' + (active ? ' active' : '')} onClick={() => onSort(active ? { key: id, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: id, dir: id === 'name' || id === 'editor' ? 'asc' : 'desc' })}>{label}{active ? sort.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ArrowUpDown size={13} />}</button></th>;
}
type MonthMetric = { label: string; csv: string; key?: MonthlyChangeKey; value: (totals: WorkspaceTotals) => number | null; format: (value: number | null) => string; lower?: boolean; neutral?: boolean; cost?: boolean };
// The first five rows are the spec's Monthly Economics example; their change uses monthlyChanges (same days for a month to date).
const monthMetrics: MonthMetric[] = [
  { label: 'Total pay', csv: 'Total pay INR', key: 'pay', value: t => t.pay, format: money, neutral: true },
  { label: 'Total views', csv: 'Total views gained', key: 'views', value: t => t.viewsGained, format: value => count(value, true) },
  { label: 'Total posts', csv: 'Total posts', key: 'posts', value: t => t.postsPublished, format: value => count(value) },
  { label: 'Cost / 1K views', csv: 'Cost per 1K views INR', key: 'costPerThousand', value: t => t.costPerThousand, format: money, lower: true, cost: true },
  { label: 'Avg views / post', csv: 'Avg views per post', key: 'viewsPerPost', value: t => t.viewsPerPost, format: value => count(value, true) },
  { label: 'Cost / 1M views', csv: 'Cost per 1M views INR', value: t => t.costPerMillion, format: money, lower: true, cost: true },
  { label: 'Views per ₹1,000', csv: 'Views per INR 1000', value: t => t.viewsPerThousand, format: value => count(value), cost: true },
  { label: 'Cost / post', csv: 'Cost per post INR', value: t => t.costPerPost, format: money, lower: true },
  { label: 'Follower growth', csv: 'Follower growth', value: t => t.followerGrowth, format: value => count(value) },
];
/** Leading months with no pay, recorded views or posts predate tracking; they are left off the month tables. */
const trackedMonths = (rows: MonthlyRow[]) => { const first = rows.findIndex(row => !!row.totals.pay || isNumber(row.totals.viewsGained) || row.totals.postsPublished > 0); return first < 0 ? rows.slice(-1) : rows.slice(first); };
const monthPrevious = (rows: MonthlyRow[]) => rows[rows.length - 1]?.sameDays?.totals || rows[rows.length - 2]?.totals || null;
const monthChange = (metric: MonthMetric, latest: MonthlyRow, previous: WorkspaceTotals | null) => metric.key && latest.change ? latest.change.metrics[metric.key] : delta(metric.value(latest.totals), previous ? metric.value(previous) : null);
const sumOf = (values: (number | null | undefined)[]) => { const known = values.filter(isNumber); return known.length ? known.reduce((n, value) => n + value, 0) : null; };
function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="an-empty"><Layers3 size={30} /><h3>{title}</h3><p>{children}</p>{action}</div>;
}

type ChartPoint = { label: string; value: number | null };
function LineChart({ points, title, description, unit = 'count' }: { points: ChartPoint[]; title: string; description?: string; unit?: 'count' | 'money' }) {
  const values = points.map(point => point.value).filter(isNumber);
  if (!values.length) return <div className="an-chart-empty"><Activity size={27} /><strong>{title}</strong><p>{description || 'A chart will appear once enough snapshots have been recorded.'}</p></div>;
  const width = 760, height = 230, left = 65, right = 16, top = 20, bottom = 36;
  const min = Math.min(0, ...values), max = Math.max(1, ...values), span = max - min || 1;
  const x = (index: number) => left + index / Math.max(1, points.length - 1) * (width - left - right);
  const y = (value: number) => top + (max - value) / span * (height - top - bottom);
  const paths: string[] = []; let path = '';
  points.forEach((point, index) => { if (!isNumber(point.value)) { if (path) paths.push(path); path = ''; } else path += (path ? ' L ' : 'M ') + x(index) + ' ' + y(point.value); });
  if (path) paths.push(path);
  const number = (value: number) => unit === 'money' ? money(value) : count(value, true);
  return <figure className="an-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title + '. ' + (description || '')}>
    <title>{title}</title><desc>{description || 'Missing dates leave gaps rather than estimated values.'}</desc>
    {[0, .5, 1].map(fraction => { const value = min + fraction * span; return <g key={fraction}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e1e7df" /><text x={left - 10} y={y(value) + 4} textAnchor="end">{number(value)}</text></g>; })}
    {paths.map((value, index) => <path key={index} d={value} fill="none" stroke="#0f7d5a" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />)}
    {points.map((point, index) => isNumber(point.value) && <circle key={index} cx={x(index)} cy={y(point.value)} r={points.length > 70 ? 1.5 : 3.3} fill="#0f7d5a"><title>{`${point.label}: ${number(point.value)}`}</title></circle>)}
    {[0, Math.floor((points.length - 1) / 2), points.length - 1].filter((item, index, all) => all.indexOf(item) === index).map(index => <text key={index} x={x(index)} y={height - 8} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{points[index].label}</text>)}
  </svg><figcaption>{description || 'Missing dates are gaps, not zeros.'}</figcaption></figure>;
}
function ConsistencyChart({ analysis }: { analysis: PageAnalysis }) {
  const posts = analysis.posts.filter(post => post.inRange && isNumber(post.fixedAgeViews)).sort((a, b) => Date.parse(a.publishedAt || '') - Date.parse(b.publishedAt || ''));
  const values = posts.map(post => post.fixedAgeViews!);
  if (!values.length) return <div className="an-chart-empty"><Activity size={26} /><strong>Comparable posts are still building</strong><p>We need a snapshot near each post’s seventh day. An older post’s current views cannot replace its day-seven count.</p></div>;
  const maximum = Math.max(1, ...values), width = 760, height = 230;
  const y = (value: number) => 190 - value / maximum * 160;
  return <figure className="an-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Each dot is a post's recorded views near day seven. Median and average are shown as reference lines.">
    <title>Post consistency at day seven</title><line x1="60" x2="735" y1="190" y2="190" stroke="#dfe5dc" />
    {[{ label: 'Median', value: analysis.metrics.medianViews, color: '#0f7d5a' }, { label: 'Average', value: analysis.metrics.averageViews, color: '#b87a00' }].map(item => isNumber(item.value) && <g key={item.label}><line x1="60" x2="735" y1={y(item.value)} y2={y(item.value)} stroke={item.color} strokeDasharray="5 4" /><text x={item.label === 'Median' ? 62 : 733} y={Math.max(15, y(item.value) - 7)} textAnchor={item.label === 'Median' ? 'start' : 'end'} fill={item.color}>{item.label}: {count(item.value)}</text></g>)}
    {posts.map((post, index) => <circle key={post.id} cx={65 + index / Math.max(1, posts.length - 1) * 660} cy={y(post.fixedAgeViews!)} r="4" fill="#142231"><title>{`${post.title || post.id}: ${count(post.fixedAgeViews)} day-seven views`}</title></circle>)}
    <text x="60" y="218">Earlier posts</text><text x="735" y="218" textAnchor="end">Later posts</text>
  </svg><figcaption>Each dot is one comparable post. Typical performance uses the median; the average is a secondary reference.</figcaption></figure>;
}
function EconomicsChart({ pages }: { pages: PageAnalysis[] }) {
  const points = pages.filter(row => isNumber(row.metrics.pay) && isNumber(row.metrics.viewsGained));
  if (!points.length) return <div className="an-chart-empty"><IndianRupee size={27} /><strong>Pay and view history are needed</strong><p>Add monthly pay to your pages. Recorded views gained will then appear against prorated pay.</p></div>;
  const maxPay = Math.max(1, ...points.map(row => row.metrics.pay!)), maxViews = Math.max(1, ...points.map(row => row.metrics.viewsGained!));
  return <figure className="an-chart"><svg viewBox="0 0 760 245" role="img" aria-label="Page pay versus recorded views gained. Each dot represents a page."><title>Pay versus views gained</title>
    {[0, .5, 1].map(value => <g key={value}><line x1="68" x2="730" y1={195 - value * 160} y2={195 - value * 160} stroke="#e1e7df" /><text x="58" y={199 - value * 160} textAnchor="end">{count(maxViews * value, true)}</text><text x={68 + value * 662} y="216" textAnchor={value === 0 ? 'start' : value === 1 ? 'end' : 'middle'}>{moneyFormat.format(maxPay * value)}</text></g>)}
    {points.map(row => <circle key={row.page.id} cx={68 + row.metrics.pay! / maxPay * 662} cy={195 - Math.max(0, row.metrics.viewsGained!) / maxViews * 160} r="6" fill="#0f7d5a" fillOpacity=".7"><title>{`${pageLabel(row.page)}: ${money(row.metrics.pay)} pay, ${count(row.metrics.viewsGained)} views gained`}</title></circle>)}
    {points.length <= 12 && points.map(row => { const x = 68 + row.metrics.pay! / maxPay * 662, end = x > 560; return <text key={row.page.id} className="an-chart-point-label" x={end ? x - 10 : x + 10} y={199 - Math.max(0, row.metrics.viewsGained!) / maxViews * 160} textAnchor={end ? 'end' : 'start'}>{pageLabel(row.page)}</text>; })}
    <text x="400" y="240" textAnchor="middle">Prorated pay for the selected dates</text>
  </svg><figcaption>Compare within the same platform. Partial history can understate recorded views and distort cost estimates.</figcaption></figure>;
}

export default function AnalyticsDashboard({ account, initialDataset, demo = false }: { account: Account; initialDataset?: AnalyticsDataset; demo?: boolean }) {
  const [clock] = useState(() => initialDataset?.generatedAt || new Date().toISOString());
  const [section, setSection] = useState<Section>('overview'), [selectedPage, setSelectedPage] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('30d', clock)), [preset, setPreset] = useState<string>('30d');
  const [draft, setDraft] = useState<DateRange>(range), [comparison, setComparison] = useState<DateRange | null>(null), [compareDraft, setCompareDraft] = useState<DateRange>(() => previousRange(range));
  const [rangeError, setRangeError] = useState(''), [platform, setPlatform] = useState<AnalyticsPlatform | 'all'>('all'), [collectionId, setCollectionId] = useState('');
  const [search, setSearch] = useState(''), [revision, setRevision] = useState(0), [pageIndex, setPageIndex] = useState(0), [postIndex, setPostIndex] = useState(0);
  const [mode, setMode] = useState<ViewMode>('gained'), [postSort, setPostSort] = useState<PostSort>('newest');
  const [postFilter, setPostFilter] = useState({ page: '', type: '', editor: '' }), [pageStatus, setPageStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [pageSort, setPageSort] = useState<Sort>({ key: 'status', dir: 'desc' }), [perfSort, setPerfSort] = useState<Sort>({ key: 'distribution', dir: 'desc' });
  const [report, setReport] = useState<LoadedHistory | null>(null), [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const [modal, setModal] = useState<Modal>(null), [form, setForm] = useState<PageForm>(emptyForm), [saving, setSaving] = useState(false), [modalError, setModalError] = useState('');
  const [notice, setNotice] = useState(''), [actionError, setActionError] = useState(''), [refreshProgress, setRefreshProgress] = useState<{ current: number; total: number } | null>(null);
  const [links, setLinks] = useState<Record<string, string | null>>({}), [demoStatus, setDemoStatus] = useState<Record<string, Pick<AnalyticsPage, 'active' | 'endDate'>>>({}), [matrixDay7, setMatrixDay7] = useState(false), [showPossible, setShowPossible] = useState(false);
  const stopRefresh = useRef(false), mounted = useRef(true), monthlyRestore = useRef<MonthlyRestore | null>(null), localGroups = useRef(0);
  const requestKey = JSON.stringify([range.from, range.to, comparison?.from, comparison?.to, revision]);
  const neededStart = useMemo(() => historyStart(range, comparison), [range, comparison]);
  // A loaded history already contains every observation a narrower range needs, so reuse it instead of refetching.
  // After an edit or refresh, keep the previous numbers on screen while the new history loads.
  const covers = !!report && report.start <= neededStart;
  const current = !!report && (report.key === requestKey || (covers && report.revision === revision && !report.stale));
  const shown = demo && initialDataset ? null : current || covers ? report : null;
  const shownDataset = shown?.dataset, shownStart = shown?.start;
  const loadedDataset = useMemo(() => shownDataset && shownStart !== undefined ? narrowHistory(shownDataset, shownStart, neededStart) : null, [shownDataset, shownStart, neededStart]);
  // Confirmed or undone content links patch the loaded history in place instead of reloading it; the demo also keeps its status switches here.
  const dataset: ExtendedDataset | null = useMemo(() => { const base = demo && initialDataset ? { ...initialDataset, pages: initialDataset.pages.map(page => demoStatus[page.id] ? { ...page, ...demoStatus[page.id] } : page) } : loadedDataset; return applyContentLinks(base, links); }, [demo, initialDataset, loadedDataset, links, demoStatus]);
  const needsLoad = !(demo && initialDataset) && !current;
  const error = loadError?.key === requestKey ? loadError.message : '';
  const loading = !dataset && !error;
  const updating = needsLoad && !!dataset && !error;
  const busy = saving || !!refreshProgress;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopRefresh.current = true; }; }, []);
  useEffect(() => {
    if (!needsLoad) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (comparison) { params.set('compareFrom', comparison.from); params.set('compareTo', comparison.to); }
    loadAnalyticsDataset(params, controller.signal).then(value => { if (!controller.signal.aborted) setReport({ key: requestKey, revision, start: neededStart, stale: false, dataset: value }); }).catch(cause => { if (!controller.signal.aborted) setLoadError({ key: requestKey, message: cause instanceof Error ? cause.message : 'Could not load your workspace. Please retry.' }); });
    return () => controller.abort();
  }, [needsLoad, requestKey, revision, neededStart, range.from, range.to, comparison]);
  useEffect(() => {
    if (!report || report.stale) return;
    const timer = setTimeout(() => setReport(value => value === report ? { ...value, stale: true } : value), HISTORY_REUSE_MS);
    return () => clearTimeout(timer);
  }, [report]);
  useEffect(() => { setPageIndex(0); setPostIndex(0); }, [section, platform, search, collectionId, range.from, range.to, postSort, postFilter, pageStatus, pageSort]);
  // Typing stays responsive; the workspace is recalculated once the input settles.
  const searchQuery = useDeferredValue(search);
  const filteredDataset = useMemo(() => {
    if (!dataset) return null;
    const collectionPages = collectionId ? new Set(dataset.memberships?.filter(item => item.collectionId === collectionId).map(item => item.pageId)) : null;
    const text = searchQuery.trim().toLowerCase();
    const pages = dataset.pages.filter(page => (platform === 'all' || page.platform === platform) && (!collectionPages || collectionPages.has(page.id)) && (!text || [page.displayName, page.name, page.handle, page.editor].some(value => value?.toLowerCase().includes(text))));
    return { ...dataset, pages };
  }, [dataset, platform, collectionId, searchQuery]);
  const calculate = useMemo(() => dataset ? createWorkspaceCalculator(dataset) : null, [dataset]);
  const hasPageFilter = !!dataset && !!filteredDataset && filteredDataset.pages.length !== dataset.pages.length;
  const stableHealth = useMemo(() => {
    if (!dataset || !hasPageFilter) return null;
    try { return calculateHealthScores(dataset, range, dataset.generatedAt); }
    catch { return null; }
  }, [dataset, hasPageFilter, range]);
  const calculation = useMemo(() => {
    if (!filteredDataset || !calculate) return { analysis: null, error: '' };
    try { return { analysis: calculate(range, comparison, filteredDataset.generatedAt, stableHealth || undefined, new Set(filteredDataset.pages.map(page => page.id))), error: '' }; }
    catch (cause) { return { analysis: null, error: cause instanceof Error ? cause.message : 'These dates could not be analysed.' }; }
  }, [filteredDataset, calculate, range, comparison, stableHealth]);
  const analysis = calculation.analysis, total = analysis?.totals, detail = analysis?.pages.find(item => item.page.id === selectedPage);
  const title = detail ? pageLabel(detail.page) : sections.find(item => item.id === section)!.label;
  const viewLabel = mode === 'gained' ? 'Views gained' : 'Published-post views';
  const pagesById = useMemo(() => new Map((analysis?.pages || []).map(row => [row.page.id, row.page])), [analysis]);
  const rangePosts = useMemo(() => (detail ? detail.posts : analysis?.pages.flatMap(item => item.posts) || []).filter(post => post.inRange), [analysis, detail]);
  const visiblePosts = useMemo(() => {
    const rows = rangePosts.filter(post => (detail || !postFilter.page || !pagesById.has(postFilter.page) || post.pageId === postFilter.page) && (!postFilter.type || post.typeLabel === postFilter.type) && (detail || !postFilter.editor || (post.pageEditor || 'Unassigned') === postFilter.editor));
    const sort = postSorts.find(item => item.id === postSort) || postSorts[0];
    if (!sort.key) return [...rows].sort((a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || ''));
    const key = sort.key;
    return sortRows(rows, { key, dir: sort.asc ? 'asc' : 'desc' }, post => post[key]);
  }, [rangePosts, detail, postSort, postFilter, pagesById]);
  const standouts = useMemo(() => contentStandouts(visiblePosts), [visiblePosts]);
  // Matching runs over every page so a confirmed group never gains a second post from a page hidden by the filters.
  const suggestions = useMemo(() => section === 'matrix' && dataset ? suggestMatches(dataset.pages) : [], [section, dataset]);
  const matrix = useMemo(() => section === 'matrix' && analysis ? contentMatrix(analysis.pages, matrixDay7 ? 'day7' : mode) : null, [section, analysis, matrixDay7, mode]);

  function setDates(next: DateRange, nextPreset: string) {
    setRange(next); setDraft(next); setPreset(nextPreset);
    if (comparison) { const prior = previousRange(next); setComparison(prior); setCompareDraft(prior); }
  }
  // A short preset shows too few months, so the report opens on the last six months. The user's own
  // dates are kept, and the earlier preset comes back on leaving unless the dates were changed meanwhile.
  function chooseSection(next: Section) {
    if (next === 'monthly' && section !== 'monthly' && ['today', '7d', '30d'].includes(preset) && !comparison) { const auto = recentMonths(clock, 6); monthlyRestore.current = { range, preset, auto }; setDates(auto, '6m'); }
    else if (next !== 'monthly' && monthlyRestore.current) { const saved = monthlyRestore.current; monthlyRestore.current = null; if (range.from === saved.auto.from && range.to === saved.auto.to) setDates(saved.range, saved.preset); }
    setSection(next); setSelectedPage(null); setPageIndex(0); setPostIndex(0); setActionError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function choosePreset(value: string) {
    setPreset(value); setRangeError(''); if (value === 'custom') return;
    setDates(value === '6m' ? recentMonths(clock, 6) : rangeForPreset(value as RangePreset, clock), value);
  }
  function applyDates(event: FormEvent) {
    event.preventDefault();
    if (!validRange(draft) || (comparison && !validRange(compareDraft))) { setRangeError('Choose a valid start date and an end date on or after it.'); return; }
    setRangeError(''); setRange({ ...draft }); setPreset('custom'); if (comparison) setComparison({ ...compareDraft });
  }
  function openPage(id: string) { setSelectedPage(id); setPostIndex(0); setActionError(''); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function openModal(value: Modal) {
    setModalError(''); setModal(value);
    if (value?.type === 'edit') { const page = value.page; setForm({ input: page.url, platform: page.platform, displayName: page.displayName || '', monthlyPay: page.monthlyPay == null ? '' : String(page.monthlyPay), editor: page.editor, startDate: page.startDate || '', active: page.active, notes: page.notes }); }
    else setForm({ ...emptyForm, startDate: indiaDay() });
  }
  async function mutate(data: Record<string, unknown>) {
    const response = await fetch('/api/analytics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'The change could not be saved. Please retry.'); return result as { ok: boolean; pageId?: string; warning?: string; existed?: boolean; refreshed?: boolean; endDate?: string | null; groupId?: string | null; linked?: number };
  }
  async function submitPage(event: FormEvent) {
    event.preventDefault(); if (demo || !modal || saving) return;
    const monthlyPay = form.monthlyPay.trim() ? Number(form.monthlyPay) : null;
    if (monthlyPay !== null && (!Number.isFinite(monthlyPay) || monthlyPay < 0)) { setModalError('Monthly pay must be zero or a positive amount.'); return; }
    setSaving(true); setModalError(''); setActionError('');
    try {
      const payload = modal.type === 'remove' ? { action: 'removePage', pageId: modal.page.id } : { action: modal.type === 'add' ? 'addPage' : 'savePage', ...(modal.type === 'edit' ? { pageId: modal.page.id } : { input: form.input.trim(), platform: form.platform, ...(collectionId ? { collectionId } : {}) }), displayName: form.displayName.trim(), monthlyPay, editor: form.editor.trim(), startDate: form.startDate || null, active: form.active, notes: form.notes.trim() };
      const result = await mutate(payload);
      if (modal.type === 'remove') setSelectedPage(null);
      setNotice(result.warning || (modal.type === 'remove' ? 'Page removed from your workspace.' : modal.type === 'add' ? result.existed ? 'This page was already in your page master. Only its blank details were filled in.' : 'Page added. Its history starts with the first successful refresh.' : 'Page details saved.'));
      setModal(null); setRevision(value => value + 1);
    } catch (cause) { setModalError(cause instanceof Error ? cause.message : 'Could not save this page.'); }
    finally { setSaving(false); }
  }
  async function refresh(pages: AnalyticsPage[]) {
    if (demo || busy || !pages.length) return;
    stopRefresh.current = false; setActionError(''); setNotice(''); const failures: string[] = []; let done = 0;
    for (const page of pages) {
      if (stopRefresh.current || !mounted.current) break;
      setRefreshProgress({ current: done + 1, total: pages.length });
      try {
        const response = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: page.id, scope: { mode: 'posts', postLimit: 100, from: null, to: null }, reconcile: false }) });
        const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'Refresh failed.');
      } catch (cause) { failures.push(`${pageLabel(page)}: ${cause instanceof Error ? cause.message : 'Refresh failed.'}`); }
      done++;
    }
    // Alerts are checked once for the whole batch; a failed check is retried by the next refresh.
    if (done > failures.length) await mutate({ action: 'reconcileAlerts' }).catch(() => undefined);
    if (!mounted.current) return;
    setRefreshProgress(null); setRevision(value => value + 1);
    if (failures.length) setActionError(`${failures.length} ${failures.length === 1 ? 'page needs' : 'pages need'} another refresh. ${failures[0]}`);
    else setNotice(`${done} ${done === 1 ? 'page refreshed' : 'pages refreshed'}. Recorded snapshots are now available in your history.`);
  }
  async function setActive(page: AnalyticsPage, active: boolean) {
    if (busy) return;
    if (demo) { const endDate = active ? null : indiaDay(); setDemoStatus(value => ({ ...value, [page.id]: { active, endDate } })); setActionError(''); setNotice(`${pageLabel(page)} is ${active ? 'active again.' : 'inactive. Pay counts through ' + date(endDate!) + '.'} In the demo this changes only this browser tab.`); return; }
    setSaving(true); setActionError('');
    try { const result = await mutate({ action: 'setActive', pageId: page.id, active }); setRevision(value => value + 1); setNotice(active ? `${pageLabel(page)} is active again.` : `${pageLabel(page)} is inactive. ${result.endDate ? 'Pay counts through ' + date(result.endDate) + '.' : 'It no longer counts pay.'}`); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not change this page’s status.'); }
    finally { setSaving(false); }
  }
  /** Confirm a group ('group'), mark posts as unique ('solo') or undo either ('unlink'). The demo changes only this tab's copy. */
  async function linkContent(mode: 'group' | 'solo' | 'unlink', members: MatchMember[] | { pageId: string; postId: string }[], groupId: string | null, message: string) {
    if (busy || !members.length) return;
    const patch = (id: string | null, solo: (index: number) => string) => setLinks(value => ({ ...value, ...Object.fromEntries(members.map((member, index) => [linkKey(member.pageId, member.postId), mode === 'group' ? id : mode === 'solo' ? solo(index) : null])) }));
    if (demo) { const base = ++localGroups.current; patch(groupId || 'ca_demo-local-' + base, index => `solo_demo-${base}-${index}`); setActionError(''); setNotice(message + ' In the demo this changes only this browser tab.'); return; }
    setSaving(true); setActionError('');
    try {
      let id = groupId;
      // The API takes up to 50 posts per call; later chunks join the group the first one created.
      for (let start = 0; start < members.length; start += 50) { const result = await mutate({ action: 'linkContent', mode, posts: members.slice(start, start + 50).map(member => ({ pageId: member.pageId, postId: member.postId })), ...(id ? { groupId: id } : {}) }); if (mode === 'group') id = result.groupId || id; }
      patch(id, () => 'solo_saved'); setNotice(message);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not change these content links.'); }
    finally { setSaving(false); }
  }
  const groupPosts = (groupId: string) => (dataset?.pages || []).flatMap(page => page.posts.filter(post => post.sourceAssetId === groupId).map(post => ({ pageId: page.id, postId: post.id })));
  function confirmMatch(item: MatchSuggestion) {
    const fresh = item.members.filter(member => !member.linked);
    // A server group id is extended in place; any other id (an imported or sample group) is regrouped with all its posts under a new one.
    const extend = !!item.groupId && (demo || /^ca_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.groupId));
    void linkContent('group', extend || !item.groupId ? fresh : [...fresh, ...groupPosts(item.groupId)], extend ? item.groupId : null, `Linked ${item.members.length} posts as the same content.`);
  }
  async function resolveAlert(id: string) {
    if (demo || busy) return; setSaving(true); setActionError('');
    try { await mutate({ action: 'resolveAlert', id }); setRevision(value => value + 1); setNotice('Alert marked as resolved.'); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not resolve this alert.'); }
    finally { setSaving(false); }
  }
  function exportPages() {
    if (!analysis) return;
    const rows: (string | number | null | undefined)[][] = [['Platform', 'Page', 'Display name', 'Handle', 'URL', 'Range start', 'Range end', 'Views gained', 'History coverage', 'History note', 'Published-post lifetime views', 'Posts published', 'Avg views per post', 'Day-7 median views', 'Day-7 average views', 'Comparable posts', 'Highest content', 'Highest content views', 'Lowest content', 'Lowest content views', 'Consistency score', 'Health score', 'Health band', 'Health note', 'Distribution score', 'Engagement rate', 'Shares', 'Saves', 'Share rate', 'Followers', 'Follower growth', 'Posts per day', 'Monthly pay INR', 'Range pay INR', 'Cost per post INR', 'Cost per 1M views INR', 'Cost per 1K views INR', 'Views per INR 1000', 'Editor', 'Start date', 'End date', 'Active']];
    (detail ? [detail] : analysis.pages.filter(row => section !== 'pages' || pageStatus === 'all' || row.page.active === (pageStatus === 'active'))).forEach(({ page, metrics, health, bestPost, worstPost, distributionScore }) => rows.push([platformNames[page.platform], page.name, page.displayName || '', page.handle, page.url, range.from, range.to, metrics.viewsGained, metrics.viewsCoverage.status, metrics.viewsCoverage.reason, metrics.publishedViews, metrics.postsPublished, metrics.viewsPerPost, metrics.medianViews, metrics.averageViews, metrics.comparablePosts, bestPost?.post.url, bestPost?.value, worstPost?.post.url, worstPost?.value, metrics.consistencyScore, health.score, bandLabels[healthBand(health.score)], health.reason, distributionScore, metrics.engagementRate, metrics.shares, metrics.saves, metrics.shareRate, metrics.followers, metrics.followerGrowth, metrics.postsPerDay, page.monthlyPay, metrics.pay, metrics.costPerPost, metrics.costPerMillion, metrics.costPerThousand, metrics.viewsPerThousand, page.editor, page.startDate, page.endDate, page.active ? 'Yes' : 'No']));
    CsvDownload(`distribution-${detail ? 'page-' + detail.page.platform + '-' + detail.page.handle : 'pages'}-${range.from}-${range.to}`, rows);
  }
  function exportPosts() {
    const rows: (string | number | null | undefined)[][] = [['Platform', 'Page', 'Editor', 'Caption', 'URL', 'Published', 'Type', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Maturing', 'Day-7 views', 'Day-7 observed', 'Engagement rate', 'Share rate', 'Against baseline', 'Reach', 'Followers gained']];
    visiblePosts.forEach(post => { const page = pagesById.get(post.pageId); rows.push([platformNames[post.pagePlatform], page ? pageLabel(page) : post.pageName, post.pageEditor, post.title, post.url, post.publishedAt, post.typeLabel, post.views, post.likes, post.comments, post.shares, post.saves, post.maturing ? 'Yes' : 'No', post.fixedAgeViews, post.fixedAgeObservedAt, post.engagementRate, post.shareRate, post.baselineRatio, 'Not available from public data', 'Not available from public data']); });
    CsvDownload(`distribution-posts-${range.from}-${range.to}`, rows);
  }
  /** The spec's month table: one row per metric, one column per month, then the latest change. */
  function monthTableRows(): (string | number | null | undefined)[][] {
    if (!analysis?.monthly.length) return [];
    const months = trackedMonths(analysis.monthly);
    const latest = months[months.length - 1], previous = monthPrevious(months);
    const rows: (string | number | null | undefined)[][] = [['Metric', ...months.map(row => monthName(row.month) + (row.partial ? ' (partial)' : '')), 'Change (fraction)']];
    monthMetrics.forEach(metric => rows.push([metric.csv, ...months.map(row => metric.value(row.totals)), monthChange(metric, latest, previous).percent]));
    return rows;
  }
  function exportMonthly() {
    if (!analysis) return;
    const rows: (string | number | null | undefined)[][] = [['Month by month', range.from, range.to], ...monthTableRows(), [], ['Month', 'Page', 'Platform', 'Range start', 'Range end', 'Pay INR', 'Views gained', 'Coverage', 'Posts published', 'Avg views per post', 'Day-7 median views', 'Engagement rate', 'Follower growth', 'Cost per post INR', 'Cost per 1M views INR', 'Cost per 1K views INR', 'Views per INR 1000']];
    trackedMonths(analysis.monthly).forEach(month => { rows.push([month.month, 'All filtered pages', platform === 'all' ? 'Mixed raw totals' : platformNames[platform], month.range.from, month.range.to, month.totals.pay, month.totals.viewsGained, month.totals.viewsCoverage.status, month.totals.postsPublished, month.totals.viewsPerPost, month.totals.medianViews, month.totals.engagementRate, month.totals.followerGrowth, month.totals.costPerPost, month.totals.costPerMillion, month.totals.costPerThousand, month.totals.viewsPerThousand]); month.pages.forEach(row => { const page = pagesById.get(row.pageId); if (page) rows.push([month.month, pageLabel(page), platformNames[page.platform], month.range.from, month.range.to, row.metrics.pay, row.metrics.viewsGained, row.metrics.viewsCoverage.status, row.metrics.postsPublished, row.metrics.viewsPerPost, row.metrics.medianViews, row.metrics.engagementRate, row.metrics.followerGrowth, row.metrics.costPerPost, row.metrics.costPerMillion, row.metrics.costPerThousand, row.metrics.viewsPerThousand]); }); });
    if (analysis.comparison) {
      rows.push([], ['Period comparison'], ['Selected range', range.from, range.to], ['Comparison range', analysis.comparison.range.from, analysis.comparison.range.to], ['Verdict', analysis.comparison.verdict], ['Page', 'Metric', 'Selected dates', 'Comparison dates', 'Absolute change', 'Fractional change']);
      const labels: Record<keyof ComparisonMetrics, string> = { pay: 'Prorated pay INR', viewsGained: 'Views gained', postsPublished: 'Posts published', costPerMillion: 'Cost per 1M views INR', medianViews: 'Day-7 median views', engagementRate: 'Engagement rate', followerGrowth: 'Follower growth' };
      const appendComparison = (name: string, comparisonMetrics: ComparisonMetrics) => {
        (Object.keys(labels) as (keyof ComparisonMetrics)[]).forEach(key => { const value = comparisonMetrics[key]; rows.push([name, labels[key], value.current, value.previous, value.difference, value.percent]); });
      };
      appendComparison('All filtered pages', analysis.comparison.metrics);
      analysis.comparison.pages.forEach(row => { const page = pagesById.get(row.pageId); if (page) appendComparison(`${platformNames[page.platform]}: ${pageLabel(page)}`, row.metrics); });
    }
    CsvDownload(`distribution-monthly-${range.from}-${range.to}`, rows);
  }
  function exportEconomics() {
    if (!analysis || !total) return;
    const rows: (string | number | null | undefined)[][] = [['Platform', 'Page', 'Editor', 'Active', 'Monthly pay INR', 'Pay for range INR', 'Views gained', 'Views coverage', 'Posts published', 'Cost per post INR', 'Cost per 1M views INR', 'Cost per 1K views INR', 'Views per INR 1000', 'End date']];
    analysis.pages.forEach(({ page, metrics }) => rows.push([platformNames[page.platform], pageLabel(page), page.editor, page.active ? 'Yes' : 'No', page.monthlyPay, metrics.pay, metrics.viewsGained, metrics.viewsCoverage.status, metrics.postsPublished, metrics.costPerPost, metrics.costPerMillion, metrics.costPerThousand, metrics.viewsPerThousand, page.endDate]));
    rows.push(['All filtered pages', `${total.costViewPages} of ${total.pages} pages in cost ratios`, '', `${total.activePages} active`, total.monthlyPay, total.pay, total.viewsGained, total.viewsCoverage.status, total.postsPublished, total.costPerPost, total.costPerMillion, total.costPerThousand, total.viewsPerThousand, '']);
    rows.push([], ['By responsible person'], ['Editor', 'Pages', 'Active pages', 'Monthly pay INR', 'Pay for range INR', 'Views gained', 'Posts published', 'Cost per 1M views INR']);
    editorRollup().forEach(row => rows.push([row.editor, row.pages, row.active, row.monthlyPay, row.pay, row.views, row.posts, row.costPerMillion]));
    rows.push([], ['Month by month', range.from, range.to], ...monthTableRows());
    CsvDownload(`distribution-economics-${range.from}-${range.to}`, rows);
  }
  function exportMatrix() {
    if (!matrix) return;
    const names = matrix.pageIds.map(id => { const page = pagesById.get(id); return page ? `${pageLabel(page)} (${platformNames[page.platform]})` : id; });
    const rows: (string | number | null | undefined)[][] = [['Page × Content', range.from, range.to, matrixDay7 ? 'Day-7 views' : viewLabel], ['Content', 'Group', 'First posted', 'First page', ...names, 'Total', 'Pages with views', 'Pages posted', 'Best page']];
    matrix.rows.forEach(row => { const best = row.best ? pagesById.get(row.best) : undefined, firstPage = pagesById.get(row.first.pageId); rows.push([row.title, row.groupId, row.first.publishedAt, firstPage ? pageLabel(firstPage) : row.first.pageName, ...matrix.pageIds.map(id => row.cells.get(id)?.value ?? null), row.total, row.known, row.cells.size, best ? pageLabel(best) : '']); });
    rows.push(['Per-page total', '', '', '', ...matrix.pageIds.map(id => matrix.pageTotals.get(id) ?? null), matrix.total, '', '', ''], ['Times best', '', '', '', ...matrix.pageIds.map(id => matrix.wins.get(id) || 0), '', '', '', '']);
    CsvDownload(`distribution-page-content-${range.from}-${range.to}`, rows);
  }
  function exportAlerts() {
    if (!analysis) return;
    const rows: (string | number | null | undefined)[][] = [['Platform', 'Page', 'Level', 'Type', 'Title', 'Details', 'Created']];
    analysis.alerts.filter(alert => !alert.resolvedAt).forEach(alert => {
      const page = pagesById.get(alert.pageId);
      rows.push([page ? platformNames[page.platform] : '', page && pageLabel(page), alert.level, alert.type, alert.title, alert.details, alert.createdAt]);
    });
    CsvDownload(`distribution-alerts-${range.from}-${range.to}`, rows);
  }
  function exportVisibleSection() {
    if (detail) exportPages();
    else if (section === 'monthly') exportMonthly();
    else if (section === 'posts') exportPosts();
    else if (section === 'economics') exportEconomics();
    else if (section === 'alerts') exportAlerts();
    else if (section === 'matrix') exportMatrix();
    else exportPages();
  }

  function pageName(page: AnalyticsPage) {
    return <button className="an-page-name" onClick={() => openPage(page.id)}><span className={'an-avatar ' + page.platform}>{initials(pageLabel(page))}</span><span><strong>{pageLabel(page)}</strong><small>@{page.handle}</small><em>{platformNames[page.platform]}</em></span><ChevronRight size={15} /></button>;
  }
  function healthBadge(row: PageAnalysis) { const band = healthBand(row.health.score); return <span className={'an-health ' + band} title={row.health.reason}>{row.health.score == null ? bandLabels.pending : `${count(row.health.score)}/100 · ${bandLabels[band]}${row.health.provisional ? '*' : ''}`}</span>; }
  function postLink(post: AnalyzedPost, fallback = 'Open post') { return safeUrl(post.url) ? <a href={post.url} target="_blank" rel="noopener noreferrer">{post.title || fallback}<ExternalLink size={12} /></a> : <strong>{post.title || 'Untitled post'}</strong>; }
  function postPageName(post: AnalyzedPost) { const page = pagesById.get(post.pageId); return page ? pageLabel(page) : post.pageName || post.pageHandle; }
  function pickCell(pick: PostPick | null) { return pick ? <>{count(pick.value)}<small className="an-pick">{postLink(pick.post)}</small><small>{pick.basis === 'latest' ? 'Latest views · not yet day 7' : 'Day-7 views'}</small></> : '-'; }
  function standoutValue(item: ContentStandout) { return item.key === 'most-engaging' || item.key === 'least-engaging' || item.key === 'lowest-share-rate' ? percent(item.value) : item.key === 'below-baseline' ? decimal(item.value) + '× page baseline' : count(item.value) + (item.key === 'most-shared' ? ' shares' : item.key === 'most-saved' ? ' saves' : ' views'); }
  function standoutList(direction: 'highest' | 'lowest') {
    return <ul>{standouts.filter(item => item.direction === direction).map(item => <li key={item.key}><span>{item.label}</span>{item.post ? <div>{postLink(item.post)}<small>{postPageName(item.post)} · <b>{standoutValue(item)}</b>{item.basis === 'latest' ? ' · latest counts' : ''}</small></div> : <small className="an-muted">{item.note}</small>}</li>)}</ul>;
  }
  function postTable() {
    const raw = !detail && platform === 'all' && postSorts.find(item => item.id === postSort)?.raw;
    const types = [...new Set([...rangePosts.map(post => post.typeLabel), ...(postFilter.type ? [postFilter.type] : [])])].sort(), editors = [...new Set(rangePosts.map(post => post.pageEditor || 'Unassigned'))].sort();
    return <section className="an-panel"><div className="an-panel-header"><div><h2>{detail ? 'Posts on this page' : 'Content tracker'}</h2><p>Posts published in the selected dates. Counts are the latest saved values.</p></div><button className="an-button" onClick={exportPosts} disabled={!visiblePosts.length}><ArrowDownToLine size={16} />CSV</button></div>
      <div className="an-table-controls">{!detail && <label>Page<select value={postFilter.page} onChange={event => setPostFilter({ ...postFilter, page: event.target.value })}><option value="">All pages</option>{analysis?.pages.map(row => <option key={row.page.id} value={row.page.id}>{pageLabel(row.page)}</option>)}</select></label>}<label>Type<select value={postFilter.type} onChange={event => setPostFilter({ ...postFilter, type: event.target.value })}><option value="">All types</option>{types.map(item => <option key={item} value={item}>{item}</option>)}</select></label>{!detail && <label>Editor<select value={postFilter.editor} onChange={event => setPostFilter({ ...postFilter, editor: event.target.value })}><option value="">All editors</option>{editors.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}<label>Order by<select value={postSort} onChange={event => setPostSort(event.target.value as PostSort)}>{postSorts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>{raw && <span>Raw counts mix platforms. “Against baseline” compares each post with its own page, so it is fair across platforms.</span>}</div>
      {visiblePosts.length > 0 && <div className="an-standout-panels"><section><h3>Top performing content</h3>{standoutList('highest')}</section><section><h3>Lowest performing content</h3>{standoutList('lowest')}</section></div>}
      {!visiblePosts.length ? <Empty title="No posts in these dates">Try another date range, clear the content filters, or refresh your pages.</Empty> : <div className="an-table-wrap" role="region" aria-label="Saved posts" tabIndex={0}><table className="an-table an-posts-table"><thead><tr><th>Post</th><th>Page / date</th><th>Type</th><th>Editor</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Saves</th><th>Engagement</th><th>Vs baseline</th></tr></thead><tbody>{pageSlice(visiblePosts, postIndex).map(post => <tr key={post.pageId + ':' + post.id}><th scope="row"><div className="an-post-title">{safeUrl(post.thumbnail) && <img src={post.thumbnail!} alt="" width={52} height={66} loading="lazy" referrerPolicy="no-referrer" />}<div>{postLink(post)}<div className="an-tags">{post.maturing ? <span className="watch">Maturing · under 7 days</span> : post.fixedAgeViews == null ? <span>Day-7 sample unavailable</span> : <span className="good">Comparable day-7 sample</span>}{post.viral && <span className="good">Viral against baseline</span>}</div></div></div></th><td><button className="an-inline-link" onClick={() => openPage(post.pageId)}>{postPageName(post)}</button><small>{platformNames[post.pagePlatform]} · {date(post.publishedAt)}</small></td><td>{post.typeLabel}</td><td>{post.pageEditor || 'Unassigned'}</td><td>{count(post.views)}</td><td>{count(post.likes)}</td><td>{count(post.comments)}</td><td>{count(post.shares)}</td><td>{count(post.saves)}</td><td>{percent(post.engagementRate)}</td><td>{post.baselineRatio == null ? '—' : decimal(post.baselineRatio) + '×'}<small>Day-7 views</small></td></tr>)}</tbody></table></div>}
      <Pagination total={visiblePosts.length} current={postIndex} onChange={setPostIndex} /><p className="an-panel-note">Maturing posts stay out of medians, health scores, and performance alerts. A dash means unavailable, not zero. Instagram and YouTube saves, reach, and followers gained per post are not available from public data.</p>
    </section>;
  }
  function comparisonTable(metrics: ComparisonMetrics) {
    const rows: { key: keyof ComparisonMetrics; label: string; format: (value: number | null) => string; lower?: boolean; neutral?: boolean }[] = [{ key: 'pay', label: 'Prorated page pay', format: money, neutral: true }, { key: 'viewsGained', label: 'Views gained', format: count }, { key: 'postsPublished', label: 'Posts published', format: count }, { key: 'costPerMillion', label: 'Cost per 1M views', format: money, lower: true }, { key: 'medianViews', label: 'Median day-7 views', format: count }, { key: 'engagementRate', label: 'Engagement rate', format: percent }, { key: 'followerGrowth', label: 'Follower growth', format: count }];
    return <div className="an-table-wrap" role="region" aria-label="Period comparison" tabIndex={0}><table className="an-table"><thead><tr><th>Metric</th><th>Selected dates</th><th>Comparison dates</th><th>Change</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><th scope="row">{row.label}</th><td>{row.format(metrics[row.key].current)}</td><td>{row.format(metrics[row.key].previous)}</td><td><Change change={metrics[row.key]} lowerBetter={row.lower} neutral={row.neutral} /></td></tr>)}</tbody></table></div>;
  }
  /** Metrics as rows, months as columns and a Change column, as in the spec's Monthly Economics example. */
  function monthTable(rows: MonthlyRow[], label: string) {
    if (!rows.length) return null;
    const latest = rows[rows.length - 1], previous = monthPrevious(rows), against = latest.change?.against === 'same-days' ? 'vs same days of ' + monthName(latest.change.range.from.slice(0, 7)) : rows.length > 1 ? 'vs ' + monthName(rows[rows.length - 2].month) : '';
    return <div className="an-table-wrap" role="region" aria-label={label} tabIndex={0}><table className="an-table an-month-table"><thead><tr><th>Metric</th>{rows.map(row => <th key={row.month}>{monthName(row.month)}{row.partial && <small>{row.sameDays ? 'Month to date' : 'Partial month'}</small>}</th>)}<th>Change<small>{against || 'Needs two months'}</small></th></tr></thead><tbody>{monthMetrics.map(metric => <tr key={metric.label}><th scope="row">{metric.label}</th>{rows.map(row => <td key={row.month}>{metric.format(metric.value(row.totals))}{(metric.key === 'views' || metric.cost) && <Coverage value={row.totals.viewsCoverage} />}{metric.cost && isNumber(metric.value(row.totals)) && row.totals.costViewPages < row.totals.pages && <small>{count(row.totals.costViewPages)} of {count(row.totals.pages)} pages</small>}</td>)}<td><Change change={monthChange(metric, latest, previous)} lowerBetter={metric.lower} neutral={metric.neutral} against="" /></td></tr>)}</tbody></table></div>;
  }
  function attentionRows() {
    if (!analysis) return [];
    const rows = new Map<string, { row: PageAnalysis; alerts: AnalyticsAlert[] }>();
    for (const row of analysis.pages) if (row.page.syncError) rows.set(row.page.id, { row, alerts: [] });
    for (const alert of analysis.alerts) {
      const row = alert.resolvedAt || alert.level === 'green' ? null : analysis.pages.find(item => item.page.id === alert.pageId); if (!row) continue;
      const entry = rows.get(row.page.id) || { row, alerts: [] }; entry.alerts.push(alert); rows.set(row.page.id, entry);
    }
    const level = (alert?: AnalyticsAlert) => alert?.level === 'red' ? 0 : 1, red = (entry: { row: PageAnalysis; alerts: AnalyticsAlert[] }) => entry.alerts.some(alert => alert.level === 'red') || entry.row.page.syncError ? 0 : 1;
    rows.forEach(entry => entry.alerts.sort((a, b) => level(a) - level(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    return [...rows.values()].sort((a, b) => red(a) - red(b) || b.alerts.length - a.alerts.length || (a.row.health.score ?? 101) - (b.row.health.score ?? 101));
  }
  function alertCard(alert: AnalyticsAlert, page: AnalyticsPage | undefined, showPage = true) {
    const post = alert.postId ? analysis?.pages.find(row => row.page.id === alert.pageId)?.posts.find(item => item.id === alert.postId) : null;
    return <article className="an-alert" key={alert.id}><AlertCircle size={21} /><div><h3>{alert.title}</h3><p>{alert.details}</p><small>{page ? pageLabel(page) : 'Page'} · {date(alert.createdAt, true)}</small></div><div className="an-alert-actions">{showPage && <button className="an-button" onClick={() => openPage(alert.pageId)}>Open page<ArrowRight size={15} /></button>}{post && safeUrl(post.url) && <a className="an-button" href={post.url} target="_blank" rel="noopener noreferrer">View post<ExternalLink size={15} /></a>}{page && /fetch|private|not.?found|data/i.test(alert.type) && <button className="an-button" disabled={demo || busy} onClick={() => refresh([page])}><RefreshCw size={15} />Retry</button>}<button className="an-inline-link" disabled={demo || busy} onClick={() => resolveAlert(alert.id)}><Check size={15} />Resolve</button></div></article>;
  }
  function freshness() {
    if (!analysis) return null;
    const synced = analysis.pages.map(row => row.page.lastSyncedAt).filter((value): value is string => !!value).sort(), now = Date.parse(analysis.generatedAt);
    const stale = analysis.pages.filter(row => row.page.active && (!row.page.lastSyncedAt || now - Date.parse(row.page.lastSyncedAt) > 48 * 3_600_000));
    return <div className="an-freshness" role="status"><RefreshCw size={15} /><span>{synced.length ? <>Data refreshed {date(synced[synced.length - 1], true)}{synced.length > 1 && synced[0] !== synced[synced.length - 1] ? <> · oldest page {date(synced[0], true)}</> : null}</> : 'No page has been refreshed yet'}</span>{stale.length ? <><strong>{count(stale.length)} active {stale.length === 1 ? 'page has' : 'pages have'} not refreshed in 48 hours</strong><button className="an-inline-link" disabled={demo || busy} onClick={() => refresh(stale.map(row => row.page))}>Refresh these<ArrowRight size={14} /></button></> : <small>All active pages refreshed in the last 48 hours</small>}</div>;
  }
  function overview() {
    if (!analysis || !total) return null;
    const changes = analysis.comparison?.metrics, attention = attentionRows(), shownAttention = attention.slice(0, 5);
    const perPlatform = (read: (totals: WorkspaceTotals) => number | null, format: (value: number | null) => string) => analysis.platforms.filter(group => isNumber(read(group.totals))).map(group => `${platformShort[group.platform]} ${format(read(group.totals))}`).join(' · ');
    const typical = total.mixedPlatforms ? perPlatform(totals => totals.medianViews, value => count(value, true)) : count(total.medianViews, true);
    const best = analysis.platforms.map(group => group.rankings.find(row => row.page.id === group.bestPageId)).filter((row): row is PageAnalysis => !!row).sort((a, b) => (b.distributionScore ?? -1) - (a.distributionScore ?? -1))[0];
    const bestContent = analysis.platforms.filter(group => group.bestPost).map(group => ({ post: group.bestPost!, basis: group.bestPostBasis, views: group.bestPostBasis === 'latest' ? group.bestPost!.views : group.bestPost!.fixedAgeViews })).sort((a, b) => (b.views ?? -1) - (a.views ?? -1))[0];
    const costBasis = total.costViewPages < total.pages ? `Based on ${count(total.costViewPages)} of ${count(total.pages)} pages with pay and views` : 'All pages have pay and recorded views';
    const activePay = analysis.pages.filter(row => row.page.active), payNote = `${count(activePay.filter(row => isNumber(row.page.monthlyPay)).length)} of ${count(activePay.length)} active pages have pay`;
    const health = [...analysis.pages].filter(row => row.page.active).sort((a, b) => (a.health.score ?? Infinity) - (b.health.score ?? Infinity)).slice(0, 8);
    return <>
      {freshness()}
      <section className={'an-panel an-today' + (attention.length ? ' has-attention' : '')}><div className="an-panel-header"><div><h2>Needs attention today</h2><p>{attention.length ? `${count(attention.length)} ${attention.length === 1 ? 'page needs' : 'pages need'} your attention today. Red alerts come first.` : 'Nothing needs attention today. Your open alerts are clear.'}</p></div><button className="an-inline-link" onClick={() => chooseSection('alerts')}>See all {count(analysis.alerts.filter(alert => !alert.resolvedAt).length)}<ArrowRight size={15} /></button></div>
        {shownAttention.length > 0 && <ul className="an-today-list">{shownAttention.map(({ row, alerts: pageAlerts }) => { const top = pageAlerts[0]; return <li key={row.page.id} className={top?.level === 'amber' && !row.page.syncError ? 'amber' : 'red'}>{pageName(row.page)}<div><strong>{top ? top.title : 'The last refresh failed'}</strong><p>{top ? top.details : row.page.syncError}</p>{pageAlerts.length > 1 && <small>+{count(pageAlerts.length - 1)} more {pageAlerts.length === 2 ? 'alert' : 'alerts'}</small>}</div><div className="an-alert-actions"><button className="an-button" onClick={() => openPage(row.page.id)}>Open page<ArrowRight size={15} /></button>{top ? <button className="an-inline-link" disabled={demo || busy} onClick={() => resolveAlert(top.id)}><Check size={15} />Resolve</button> : <button className="an-inline-link" disabled={demo || busy} onClick={() => refresh([row.page])}><RefreshCw size={15} />Retry</button>}</div></li>; })}</ul>}
      </section>
      <h2 className="an-kpi-heading">Reach &amp; output</h2>
      <div className="an-kpis"><Kpi label="Total active pages" value={count(total.activePages)} note={`${count(total.pages)} pages in this view${total.inactivePages ? ` · ${count(total.inactivePages)} inactive` : ''}`} /><Kpi label={mode === 'gained' ? 'Total views' : 'Total views (posts in range)'} value={count(mode === 'gained' ? total.viewsGained : total.publishedViews)} featured coverage={mode === 'gained' ? total.viewsCoverage : undefined} change={mode === 'gained' ? changes?.viewsGained : undefined} note={mode === 'gained' ? 'Recorded changes between snapshots' : 'Lifetime views on posts published in range'} /><Kpi label="Content published" value={count(total.postsPublished)} change={changes?.postsPublished} note="Posts published in the selected dates" /><Kpi label="Avg / typical views per content" value={typical || '-'} text={total.mixedPlatforms} change={total.mixedPlatforms ? undefined : changes?.medianViews} note={total.mixedPlatforms ? 'Typical day-7 views on each platform' : `Typical (median) day-7 views · average ${count(total.averageViews, true)} · ${count(total.comparablePosts)} samples`} /><Kpi label="Total followers" value={count(total.followers)} note="Latest recorded followers and subscribers" /><Kpi label="Follower growth" value={count(total.followerGrowth)} change={changes?.followerGrowth} coverage={total.followerCoverage} note="Measured from available snapshots" /><Kpi label="Best page" value={best ? pageLabel(best.page) : 'Still building history'} text note={best ? `${platformNames[best.page.platform]} · distribution score ${count(best.distributionScore)} · health ${count(best.health.score)}/100` : 'A best page appears when comparable history is available.'} /><Kpi label="Best content" value={bestContent ? bestContent.post.title || 'Untitled post' : 'No post yet'} text note={bestContent ? `${postPageName(bestContent.post)} · ${count(bestContent.views)} ${bestContent.basis === 'latest' ? 'latest views (not yet day 7)' : 'day-7 views'}` : 'No post was published in these dates.'} /></div>
      <h2 className="an-kpi-heading">Money</h2>
      <div className="an-kpis"><Kpi label="Total monthly page pay" value={money(total.monthlyPay)} featured note={payNote} /><Kpi label="Pay for these dates" value={money(total.pay)} change={changes?.pay} neutral note="Prorated by calendar days" /><Kpi label="Cost per 1M views" value={money(total.costPerMillion)} change={changes?.costPerMillion} lowerBetter coverage={total.viewsCoverage} note={costBasis} /><Kpi label="Views per ₹1,000" value={count(total.viewsPerThousand)} coverage={total.viewsCoverage} note={costBasis} /></div>
      <div className="an-two-column"><section className="an-panel"><div className="an-panel-header"><div><h2>{viewLabel} over time</h2><p>{mode === 'gained' ? 'Changes measured between recorded snapshots.' : 'Latest lifetime counts, grouped by publication day.'}</p></div><span className="an-pill">{analysis.days} days</span></div><LineChart title={viewLabel + ' over time'} points={analysis.timeline.map(point => ({ label: shortDate(point.date), value: mode === 'gained' ? point.viewsGained : point.publishedViews ?? null }))} /></section><section className="an-panel an-engagement"><div className="an-panel-header"><div><h2>Engagement</h2><p>Likes, comments and available shares divided by views.</p></div></div><strong className={total.mixedPlatforms ? 'text' : undefined}>{total.mixedPlatforms ? perPlatform(totals => totals.engagementRate, percent) || '-' : percent(total.engagementRate)}</strong><p>{total.mixedPlatforms ? 'Shown per platform: engagement is not compared across Instagram, YouTube, and TikTok.' : 'Uses comparable matured posts and only metrics the source provides.'}</p><dl><div><dt>Shares, where available</dt><dd>{count(total.shares)}</dd></div><div><dt>Average day-7 views</dt><dd>{total.mixedPlatforms ? perPlatform(totals => totals.averageViews, value => count(value, true)) || '-' : count(total.averageViews)}</dd></div></dl></section></div>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Standouts by platform</h2><p>Pages and posts compete only with others on the same platform.</p></div></div><div className="an-standouts">{analysis.platforms.map(group => { const top = group.rankings.find(item => item.page.id === group.bestPageId); return <article key={group.platform}><span className="an-platform-label">{platformNames[group.platform]}</span><h3>{top ? pageLabel(top.page) : 'Still building history'}</h3>{top ? <><p>{count(top.metrics.viewsGained)} recorded views gained<Coverage value={top.metrics.viewsCoverage} /></p><button className="an-inline-link" onClick={() => openPage(top.page.id)}>Open page<ArrowUpRight size={14} /></button></> : <p>A best page appears when comparable history is available.</p>}{group.bestPost ? <div className="an-best-post"><span>Best post</span>{postLink(group.bestPost)}<small>{group.bestPostBasis === 'latest' ? `${count(group.bestPost.views)} latest views · still maturing` : `${count(group.bestPost.fixedAgeViews)} day-7 views`}</small></div> : <div className="an-best-post"><span>Best post</span><small>No post was published on this platform in these dates.</small></div>}</article>; })}</div></section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Page health</h2><p>Lowest health first. Active pages only; scores are 0–100 on an absolute scale, blended with same-platform peers.</p></div><button className="an-inline-link" onClick={() => chooseSection('performance')}>All performance<ArrowRight size={15} /></button></div><div className="an-health-list">{health.map(row => { const weakest = row.health.code === 'scored' && row.health.basis === 'range' ? [...row.health.components].filter(component => isNumber(component.score)).sort((a, b) => a.score! - b.score!)[0] : undefined; return <div key={row.page.id}>{pageName(row.page)}<div>{healthBadge(row)}<small>{weakest ? `Weakest: ${weakest.label} · ${Math.round(weakest.score!)}/100` : row.health.reason}</small></div></div>; })}</div></section>
      {analysis.comparison && <section className="an-panel"><div className="an-panel-header"><div><h2>Your date comparison</h2><p>{rangeLabel(range)} against {rangeLabel(analysis.comparison.range)}</p></div></div>{comparisonTable(analysis.comparison.metrics)}</section>}
    </>;
  }
  function pagesScreen() {
    if (!analysis) return null;
    const read = (row: PageAnalysis, key: string) => key === 'name' ? pageLabel(row.page).toLowerCase() : key === 'editor' ? row.page.editor.toLowerCase() : key === 'pay' ? row.page.monthlyPay : key === 'status' ? (row.page.active ? 1 : 0) : key === 'start' ? row.page.startDate && Date.parse(row.page.startDate) : row.page.lastSyncedAt && Date.parse(row.page.lastSyncedAt);
    const filtered = analysis.pages.filter(row => pageStatus === 'all' || row.page.active === (pageStatus === 'active'));
    const rows = sortRows(sortRows(filtered, { key: 'name', dir: 'asc' }, read), pageSort, read), active = filtered.filter(row => row.page.active);
    const header = (label: string, id: string) => <SortHeader label={label} id={id} sort={pageSort} onSort={setPageSort} />;
    return <section className="an-panel"><div className="an-panel-header"><div><h2>Your page master</h2><p>Every page once: its link, platform, responsible person, monthly pay, and status.</p></div><button className="an-button primary" disabled={busy} onClick={() => openModal({ type: 'add' })}><Plus size={16} />Add page</button></div>
      <div className="an-table-controls"><label>Show<select value={pageStatus} onChange={event => setPageStatus(event.target.value as 'all' | 'active' | 'inactive')}><option value="all">All pages</option><option value="active">Active pages</option><option value="inactive">Inactive pages</option></select></label><span>Click a column heading to sort. Use the search above to find a page or person.</span></div>
      {!rows.length ? <Empty title="No pages with this status">Choose “All pages” to see every page.</Empty> : <div className="an-table-wrap" role="region" aria-label="Page master" tabIndex={0}><table className="an-table"><thead><tr>{header('Page', 'name')}{header('Responsible person', 'editor')}{header('Monthly pay', 'pay')}{header('Status', 'status')}{header('Start date', 'start')}{header('Last updated', 'updated')}<th>Manage</th></tr></thead><tbody>{pageSlice(rows, pageIndex).map(row => <tr key={row.page.id}><th scope="row">{pageName(row.page)}<div className="an-mobile-actions"><button className="an-inline-link" disabled={busy} onClick={() => openModal({ type: 'edit', page: row.page })}>Edit details</button></div></th><td>{row.page.editor || 'Not assigned'}</td><td>{money(row.page.monthlyPay)}</td><td><button type="button" role="switch" aria-checked={row.page.active} aria-label={`${pageLabel(row.page)}: ${row.page.active ? 'active' : 'inactive'}. Switch to ${row.page.active ? 'inactive' : 'active'}`} className={'an-toggle' + (row.page.active ? ' on' : '')} disabled={busy} onClick={() => setActive(row.page, !row.page.active)}><span />{row.page.active ? 'Active' : 'Inactive'}</button>{!row.page.active && <small>{row.page.endDate ? 'Paid through ' + date(row.page.endDate) : 'No pay counted'}</small>}{row.page.syncError && <small className="an-error-text">Needs refresh</small>}</td><td>{date(row.page.startDate)}</td><td>{row.page.lastSyncedAt ? date(row.page.lastSyncedAt, true) : 'Not fetched yet'}{row.page.syncError && <small className="an-error-text">{row.page.syncError}</small>}</td><td><div className="an-row-actions"><button className="an-icon-button" aria-label={'Edit ' + pageLabel(row.page)} disabled={busy} onClick={() => openModal({ type: 'edit', page: row.page })}><Pencil size={16} /></button><button className="an-icon-button" aria-label={'Refresh ' + pageLabel(row.page)} disabled={demo || busy} onClick={() => refresh([row.page])}><RefreshCw size={16} /></button>{safeUrl(row.page.url) && <a className="an-icon-button" href={row.page.url} target="_blank" rel="noopener noreferrer" aria-label={'Open ' + row.page.handle + ' on ' + platformNames[row.page.platform]}><ExternalLink size={16} /></a>}<button className="an-icon-button danger" aria-label={'Remove ' + pageLabel(row.page)} disabled={demo || busy} onClick={() => openModal({ type: 'remove', page: row.page })}><Trash2 size={16} /></button></div></td></tr>)}</tbody><tfoot><tr><th scope="row">{count(rows.length)} {rows.length === 1 ? 'page' : 'pages'}<small>{count(active.length)} active · {count(rows.length - active.length)} inactive</small></th><td /><td>{money(sumOf(active.map(row => row.page.monthlyPay)))}<small>Monthly pay, active pages</small></td><td colSpan={4} /></tr></tfoot></table></div>}<Pagination total={rows.length} current={pageIndex} onChange={setPageIndex} /><p className="an-panel-note">Switching a page to Inactive keeps its history and stops its pay on that day. Monthly pay is prorated from the start date across actual calendar months. Blank pay is unknown; enter 0 for an unpaid page.</p></section>;
  }
  function performance() {
    if (!analysis) return null;
    const read = (row: PageAnalysis, key: string, rank: Map<string, number>) => ({ name: pageLabel(row.page).toLowerCase(), health: row.health.score, distribution: rank.has(row.page.id) ? -rank.get(row.page.id)! : null, views: mode === 'gained' ? row.metrics.viewsGained : row.metrics.publishedViews, posts: row.metrics.postsPublished, perPost: row.metrics.viewsPerPost, median: row.metrics.medianViews, best: row.bestPost?.value, worst: row.worstPost?.value, consistency: row.metrics.consistencyScore, hitRate: row.metrics.hitRate, engagement: row.metrics.engagementRate, shares: row.metrics.shares, saves: row.metrics.saves, growth: row.metrics.followerGrowth, frequency: row.metrics.postsPerDay, pay: row.page.monthlyPay, cost: row.metrics.costPerMillion, perThousand: row.metrics.viewsPerThousand } as Record<string, number | string | null | undefined>)[key];
    const header = (label: string, id: string, title?: string) => <SortHeader label={label} id={id} sort={perfSort} onSort={setPerfSort} title={title} />;
    return <>{analysis.platforms.map(group => { const rank = new Map(group.rankings.filter(row => row.distributionScore !== null).map((row, index) => [row.page.id, index + 1])); const rows = sortRows(group.rankings, perfSort, (row, key) => read(row, key, rank)); return <section className="an-panel" key={group.platform}><div className="an-panel-header"><div><h2>{platformNames[group.platform]} performance</h2><p>Ranked within this platform by distribution score (75% health, 25% cost efficiency). Health needs at least five posts measured at day 7.</p></div><span className="an-pill">{group.rankings.length} pages</span></div><div className="an-table-wrap" role="region" aria-label={platformNames[group.platform] + ' performance'} tabIndex={0}><table className="an-table an-performance-table"><thead><tr>{header('Page', 'name')}{header('Health', 'health')}{header('Distribution score', 'distribution', 'Rank on this platform: 75% health score and 25% views per ₹1,000')}{header(viewLabel, 'views')}{header('Posts', 'posts')}{header('Avg views / post', 'perPost', 'Views gained ÷ posts published')}{header('Day-7 median', 'median')}{header('Highest content', 'best')}{header('Lowest content', 'worst')}{header('Consistency', 'consistency', 'Reliability 0–100 from the spread of the middle half of posts; one viral post cannot inflate it')}{header('Hit rate', 'hitRate', 'Share of posts reaching at least 70% of the page’s typical 90-day views')}{header('Engagement', 'engagement')}{header('Shares', 'shares')}{header('Saves', 'saves', 'Not provided publicly by Instagram or YouTube')}{header('Follower growth', 'growth')}{header('Posts / day', 'frequency')}{header('Monthly pay', 'pay')}{header('Cost / 1M views', 'cost')}{header('Views / ₹1,000', 'perThousand')}</tr></thead><tbody>{rows.map(row => <tr key={row.page.id}><th scope="row">{pageName(row.page)}</th><td>{healthBadge(row)}</td><td>{rank.has(row.page.id) ? <><strong>#{rank.get(row.page.id)}</strong> · {count(row.distributionScore)}</> : '-'}<small>{row.costEfficiency === null ? 'Health only' : 'Cost efficiency ' + count(row.costEfficiency)}</small></td><td>{count(mode === 'gained' ? row.metrics.viewsGained : row.metrics.publishedViews)}{mode === 'gained' && <Coverage value={row.metrics.viewsCoverage} />}</td><td>{count(row.metrics.postsPublished)}</td><td>{count(row.metrics.viewsPerPost)}</td><td>{count(row.metrics.medianViews)}<small>{count(row.metrics.comparablePosts)} {row.metrics.comparablePosts === 1 ? 'sample' : 'samples'}</small></td><td>{pickCell(row.bestPost)}</td><td>{pickCell(row.worstPost)}</td><td title={row.metrics.iqrSpread == null ? undefined : 'Spread ' + decimal(row.metrics.iqrSpread)}>{count(row.metrics.consistencyScore)}<small>{steadiness(row.metrics.consistencyScore)}</small></td><td>{percent(row.metrics.hitRate)}</td><td>{percent(row.metrics.engagementRate)}</td><td>{count(row.metrics.shares)}</td><td title={row.metrics.saves == null ? 'Not provided publicly for this platform' : undefined}>{count(row.metrics.saves)}</td><td>{count(row.metrics.followerGrowth)}<Coverage value={row.metrics.followerCoverage} /></td><td>{decimal(row.metrics.postsPerDay)}</td><td>{money(row.page.monthlyPay)}</td><td>{money(row.metrics.costPerMillion)}{isNumber(row.metrics.costPerMillion) && <Coverage value={row.metrics.viewsCoverage} />}</td><td>{count(row.metrics.viewsPerThousand)}</td></tr>)}</tbody></table></div></section>; })}</>;
  }
  function editorRollup() {
    const groups = new Map<string, PageAnalysis[]>();
    (analysis?.pages || []).forEach(row => { const key = row.page.editor.trim().toLowerCase(); groups.set(key, [...(groups.get(key) || []), row]); });
    return [...groups.values()].map(rows => {
      // Same rule as the workspace totals: paid (or ₹0 active) pages with recorded views, so a paid page that gained no views still counts its spend.
      const paid = rows.filter(row => isNumber(row.metrics.pay) && (row.metrics.pay > 0 || row.page.active && row.page.monthlyPay === 0) && isNumber(row.metrics.viewsGained)), paidViews = sumOf(paid.map(row => row.metrics.viewsGained));
      return { editor: rows[0].page.editor.trim() || 'Unassigned', pages: rows.length, active: rows.filter(row => row.page.active).length, monthlyPay: sumOf(rows.filter(row => row.page.active).map(row => row.page.monthlyPay)), pay: sumOf(rows.map(row => row.metrics.pay)), views: sumOf(rows.map(row => row.metrics.viewsGained)), posts: rows.reduce((n, row) => n + row.metrics.postsPublished, 0), paidPages: paid.length, costPerMillion: paidViews ? sumOf(paid.map(row => row.metrics.pay))! / paidViews * 1_000_000 : null };
    }).sort((a, b) => (a.editor === 'Unassigned' ? 1 : 0) - (b.editor === 'Unassigned' ? 1 : 0) || a.editor.localeCompare(b.editor));
  }
  function economics() {
    if (!analysis || !total) return null;
    const costBasis = `${count(total.costViewPages)} of ${count(total.pages)} pages have pay and recorded views`;
    return <><div className="an-kpis three"><Kpi label="Total monthly page pay" value={money(total.monthlyPay)} note={`${count(analysis.pages.filter(row => row.page.active && isNumber(row.page.monthlyPay)).length)} of ${count(total.activePages)} active pages have pay`} /><Kpi label="Pay for selected dates" value={money(total.pay)} note="Prorated by calendar days" /><Kpi label="Cost per 1M views" value={money(total.costPerMillion)} featured coverage={total.viewsCoverage} note={costBasis} /><Kpi label="Cost per 1K views" value={money(total.costPerThousand)} coverage={total.viewsCoverage} note="Pay ÷ recorded views gained × 1,000" /><Kpi label="Cost per post" value={money(total.costPerPost)} note={`Pay ÷ posts on ${count(total.costPages)} paid pages`} /><Kpi label="Views per ₹1,000" value={count(total.viewsPerThousand)} coverage={total.viewsCoverage} note="Recorded views gained per ₹1,000 of pay" /></div>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Month by month</h2><p>Is more spend producing proportionally more output? A month to date is compared with the same days of the month before.</p></div></div>{monthTable(trackedMonths(analysis.monthly), 'Monthly economics')}</section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>What your page pay is buying</h2><p>Amounts are prorated to {rangeLabel(range)}. Views are measured from recorded snapshots.</p></div></div><EconomicsChart pages={analysis.pages} /></section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Page economics</h2><p>Unknown pay and incomplete history stay clearly labelled.</p></div><button className="an-button" onClick={exportEconomics}><ArrowDownToLine size={16} />CSV</button></div><div className="an-table-wrap" role="region" aria-label="Page economics" tabIndex={0}><table className="an-table"><thead><tr><th>Page</th><th>Monthly pay</th><th>Pay for range</th><th>Views gained</th><th>Posts</th><th>Cost / post</th><th>Cost / 1M views</th><th>Cost / 1K views</th><th>Views / ₹1,000</th></tr></thead><tbody>{analysis.pages.map(row => { const partial = isNumber(row.metrics.costPerMillion) && <Coverage value={row.metrics.viewsCoverage} />; return <tr key={row.page.id}><th scope="row">{pageName(row.page)}</th><td>{money(row.page.monthlyPay)}{!row.page.active && <small>{row.page.endDate ? 'Inactive · paid through ' + date(row.page.endDate) : 'Inactive · no pay counted'}</small>}</td><td>{money(row.metrics.pay)}</td><td>{count(row.metrics.viewsGained)}<Coverage value={row.metrics.viewsCoverage} /></td><td>{count(row.metrics.postsPublished)}</td><td>{money(row.metrics.costPerPost)}</td><td>{money(row.metrics.costPerMillion)}{partial}</td><td>{money(row.metrics.costPerThousand)}{partial}</td><td>{count(row.metrics.viewsPerThousand)}{partial}</td></tr>; })}</tbody><tfoot><tr><th scope="row">All pages in view<small>{costBasis}</small></th><td>{money(total.monthlyPay)}<small>Active pages</small></td><td>{money(total.pay)}</td><td>{count(total.viewsGained)}<Coverage value={total.viewsCoverage} /></td><td>{count(total.postsPublished)}</td><td>{money(total.costPerPost)}</td><td>{money(total.costPerMillion)}</td><td>{money(total.costPerThousand)}</td><td>{count(total.viewsPerThousand)}</td></tr></tfoot></table></div><p className="an-panel-note">These are page/editor costs that you enter. They do not include data-provider costs. Cost ratios use only pages with pay in these dates; a ratio is unavailable when pay or usable view history is missing.</p></section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>By responsible person</h2><p>Pages, pay and recorded output grouped by editor.</p></div></div><div className="an-table-wrap" role="region" aria-label="Economics by responsible person" tabIndex={0}><table className="an-table"><thead><tr><th>Responsible person</th><th>Pages</th><th>Monthly pay</th><th>Pay for range</th><th>Views gained</th><th>Posts</th><th>Cost / 1M views</th></tr></thead><tbody>{editorRollup().map(row => <tr key={row.editor}><th scope="row">{row.editor}</th><td>{count(row.pages)}<small>{count(row.active)} active</small></td><td>{money(row.monthlyPay)}</td><td>{money(row.pay)}</td><td>{count(row.views)}</td><td>{count(row.posts)}</td><td>{money(row.costPerMillion)}{row.paidPages < row.pages && isNumber(row.costPerMillion) && <small>{count(row.paidPages)} of {count(row.pages)} pages</small>}</td></tr>)}</tbody></table></div></section></>;
  }
  function monthVerdict(row: MonthlyRow | undefined) {
    const pay = row?.change?.metrics.pay.percent, views = row?.change?.metrics.views.percent;
    if (!row?.change || !isNumber(pay) || !isNumber(views)) return 'Two months with pay and recorded views are needed to compare spend with output.';
    const period = row.change.against === 'same-days' ? `${monthName(row.month)} so far against the same days of ${monthName(row.change.range.from.slice(0, 7))}` : `${monthName(row.month)} against ${monthName(row.change.range.from.slice(0, 7))}`;
    return `${period}: pay ${pay >= 0 ? '+' : ''}${percent(pay)}, views ${views >= 0 ? '+' : ''}${percent(views)}. ${views > pay ? 'Views grew faster than spend.' : views < pay ? 'Spend grew faster than views.' : 'Views and spend moved together.'}${row.change.partial || row.totals.viewsCoverage.status !== 'complete' ? ' Based on recorded history, which is partial.' : ''}`;
  }
  function monthly() {
    if (!analysis) return null;
    const months = trackedMonths(analysis.monthly);
    return <div className="an-print-report"><div className="an-report-title"><span>{PRODUCT_NAME}</span><h2>Distribution performance report</h2><p>{rangeLabel(range)}{comparison ? ' · Compared with ' + rangeLabel(comparison) : ''}</p><small>{platform === 'all' ? 'All platforms · raw totals, with platform-specific rankings' : platformNames[platform]} · Prepared {date(analysis.generatedAt, true)}</small></div><div className="an-report-actions"><button className="an-button" onClick={exportMonthly}><ArrowDownToLine size={16} />Export CSV</button><button className="an-button primary" onClick={() => window.print()}><FileText size={16} />Print / save PDF</button></div>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Did more pay buy more views?</h2><p className="an-verdict">{monthVerdict(months[months.length - 1])}</p></div></div>{monthTable(months, 'Monthly report')}<LineChart title="Recorded views gained by month" points={months.map(row => ({ label: monthName(row.month), value: row.totals.viewsGained }))} /></section>
      {analysis.comparison && <section className="an-panel"><div className="an-panel-header"><div><h2>Your date comparison</h2><p className="an-verdict">{analysis.comparison.verdict}</p></div></div>{comparisonTable(analysis.comparison.metrics)}</section>}
      <section className="an-panel"><div className="an-panel-header"><div><h2>Page-by-page monthly detail</h2><p>Each page retains its own history and costs. Months before a page had pay, recorded views or posts are left out.</p></div></div><div className="an-table-wrap" role="region" aria-label="Monthly page detail" tabIndex={0}><table className="an-table"><thead><tr><th>Month / page</th><th>Platform</th><th>Pay</th><th>Views gained</th><th>Posts</th><th>Avg views / post</th><th>Cost / 1K views</th><th>Cost / 1M views</th><th>Follower growth</th></tr></thead><tbody>{months.flatMap(month => month.pages.filter(row => !!row.metrics.pay || isNumber(row.metrics.viewsGained) || row.metrics.postsPublished > 0).map(row => { const page = pagesById.get(row.pageId); const partial = isNumber(row.metrics.costPerMillion) && <Coverage value={row.metrics.viewsCoverage} />; return page ? <tr key={month.month + row.pageId}><th scope="row"><strong>{pageLabel(page)}</strong><small>{monthName(month.month)}</small></th><td>{platformNames[page.platform]}</td><td>{money(row.metrics.pay)}</td><td>{count(row.metrics.viewsGained)}<Coverage value={row.metrics.viewsCoverage} /></td><td>{count(row.metrics.postsPublished)}</td><td>{count(row.metrics.viewsPerPost)}</td><td>{money(row.metrics.costPerThousand)}{partial}</td><td>{money(row.metrics.costPerMillion)}{partial}</td><td>{count(row.metrics.followerGrowth)}</td></tr> : null; }))}</tbody></table></div></section><p className="an-report-footnote">View growth is measured from recorded snapshots. Published-post views are lifetime counts, not views earned during a period. Avg views per post is views gained ÷ posts; medians and scores use comparable day-seven samples. Pay uses each page’s current monthly rate. A dash means unavailable. Partial history may limit conclusions.</p></div>;
  }
  function alertRules() {
    const drop = (value: number) => percent(1 - value);
    return `Rules: no post in ${ALERT_RULES.quietDays} days (each page can set its own), views down more than ${drop(ALERT_RULES.weekDrop)} week over week, average views down more than ${drop(ALERT_RULES.averageDrop)}, engagement down more than ${drop(ALERT_RULES.engagementDrop)}, followers falling, posting frequency down more than ${drop(ALERT_RULES.postingDrop)}, typical views below ${percent(ALERT_RULES.belowBaseline)} of the 30-day baseline, views trending up ${percent(ALERT_RULES.upwardTrend - 1)} or more, and posts reaching ${ALERT_RULES.viral}× the page baseline.`;
  }
  function alerts() {
    if (!analysis) return null;
    const active = analysis.alerts.filter(item => !item.resolvedAt);
    return <>{!active.length ? <section className="an-panel"><Empty title="No open alerts">Performance alerts appear after a condition is confirmed on two checks. Fresh accounts may still be building enough history.</Empty></section> : (['red', 'amber', 'green'] as const).map(level => {
      const group = active.filter(item => item.level === level); if (!group.length) return null;
      return <section className={'an-alert-group ' + level} key={level}><h2><span />{level === 'red' ? 'Act today' : level === 'amber' ? 'Keep an eye on these' : 'Opportunities'}<small>{group.length}</small></h2>{group.map(alert => alertCard(alert, pagesById.get(alert.pageId)))}</section>;
    })}<p className="an-help-note">Performance alerts use matured posts and are checked for persistence. Data-health alerts describe fetch problems. Resolving an alert does not change a page’s saved metrics. {alertRules()}</p></>;
  }
  function matrixScreen() {
    if (!analysis || !matrix || !dataset) return null;
    const visible = new Set(analysis.pages.map(row => row.page.id)), allPages = new Map(dataset.pages.map(page => [page.id, page]));
    const queue = suggestions.filter(item => item.members.some(member => visible.has(member.pageId))), shown = queue.filter(item => showPossible || item.band === 'likely');
    const solo = dataset.pages.flatMap(page => page.posts.filter(post => post.sourceAssetId?.startsWith('solo_')).map(post => ({ pageId: page.id, postId: post.id })));
    const linked = new Set(dataset.pages.flatMap(page => page.posts.map(post => post.sourceAssetId)).filter(isContentGroup)).size;
    const name = (pageId: string) => { const page = allPages.get(pageId); return page ? pageLabel(page) : 'Removed page'; };
    const seconds = (value: number | null) => isNumber(value) ? decimal(value, 2) + ' s' : 'length unknown';
    const measureLabel = matrixDay7 ? 'Day-7 views' : viewLabel, top = matrix.pageIds.slice().sort((a, b) => (matrix.wins.get(b) || 0) - (matrix.wins.get(a) || 0))[0];
    // Unlink takes the whole group, including copies on pages the filters hide, so no one-post group is left behind.
    const members = (row: (typeof matrix.rows)[number]) => groupPosts(row.groupId);
    return <>
      <div className="an-kpis three"><Kpi label="Shared content in these dates" value={count(matrix.rows.length)} note={`${count(linked)} linked ${linked === 1 ? 'group' : 'groups'} in the workspace`} featured /><Kpi label={'Total · ' + measureLabel.toLowerCase()} value={count(matrix.total, true)} note={matrix.mixedPlatforms ? 'Adds Instagram plays, YouTube views and TikTok plays' : `Across ${count(matrix.pageIds.length)} pages`} /><Kpi label="Most often the best page" value={top && matrix.wins.get(top) ? name(top) : '-'} text note={top && matrix.wins.get(top) ? `Best on ${count(matrix.wins.get(top))} of ${count(matrix.rows.length)} pieces of content` : 'Needs views on two or more pages'} /></div>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Suggested matches<small className="an-pill">{count(queue.length)}</small></h2><p>Found from caption words (hashtags, mentions and emoji ignored), video length, publish dates within {MATCH_RULES.windowDays} days and shared audio. Nothing is linked until you confirm it.</p></div><label className="an-check"><input type="checkbox" checked={showPossible} onChange={event => setShowPossible(event.target.checked)} />Include possible matches</label></div>
        {!shown.length ? <p className="an-panel-note">{queue.length ? `${count(queue.length)} possible ${queue.length === 1 ? 'match needs' : 'matches need'} a closer look. Tick “Include possible matches” to review ${queue.length === 1 ? 'it' : 'them'}.` : 'No new matches to review. Posts on different pages are suggested here when their captions mostly match and their lengths and publish dates are close.'}</p>
          : <ul className="an-match-list">{shown.slice(0, 20).map(item => <li key={item.key}><div className="an-match-head"><span className={'an-health ' + (item.band === 'likely' ? 'good' : 'watch')}>{item.band === 'likely' ? 'Likely' : 'Possible'} · {percent(item.score)}</span><small>{item.reasons.join(' · ')}{item.groupId ? ' · joins linked content' : ''}</small></div>
            <div className="an-match-members">{item.members.map(member => { const page = allPages.get(member.pageId); return <div key={member.pageId + ':' + member.postId}><strong>{name(member.pageId)}{member.linked && <em>Already linked</em>}</strong><span>{safeUrl(member.post.url) ? <a href={member.post.url} target="_blank" rel="noopener noreferrer">{contentTitle(member.post.title) || 'Untitled post'}<ExternalLink size={12} /></a> : contentTitle(member.post.title) || 'Untitled post'}</span><small>{page ? platformNames[page.platform] + ' · ' : ''}{date(member.post.publishedAt)} · {seconds(member.post.durationSeconds)} · {count(member.post.views, true)} views</small></div>; })}</div>
            <div className="an-alert-actions"><button className="an-button primary" disabled={busy} onClick={() => confirmMatch(item)}><Check size={15} />Confirm same content</button><button className="an-button" disabled={busy} onClick={() => void linkContent('solo', item.members.filter(member => !member.linked), null, 'Marked as different content. These posts will not be suggested again.')}><X size={15} />Not the same</button></div></li>)}</ul>}
        {shown.length > 20 && <p className="an-panel-note">Showing the 20 strongest of {count(shown.length)}. Confirm or reject these to see the rest.</p>}
        {solo.length > 0 && <p className="an-panel-note">{count(solo.length)} {solo.length === 1 ? 'post is' : 'posts are'} marked as unique and never suggested. <button className="an-inline-link" disabled={busy} onClick={() => void linkContent('unlink', solo, null, 'These posts can be suggested again.')}>Allow suggestions again</button></p>}
      </section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Content across pages</h2><p>Each row is one piece of content, each column a page that posted it. {matrixDay7 ? 'Day-7 views compare every copy at the same age, so a later repost is not penalised.' : mode === 'gained' ? 'Views each copy gained during the selected dates.' : 'Latest lifetime views of each copy.'}</p></div><div className="an-panel-actions"><div className="an-view-mode compact"><div role="group" aria-label="Page × Content measurement"><button className={!matrixDay7 ? 'active' : ''} aria-pressed={!matrixDay7} onClick={() => setMatrixDay7(false)}>{viewLabel}</button><button className={matrixDay7 ? 'active' : ''} aria-pressed={matrixDay7} onClick={() => setMatrixDay7(true)}>Day-7 views</button></div></div><button className="an-button" onClick={exportMatrix} disabled={!matrix.rows.length}><ArrowDownToLine size={16} />CSV</button></div></div>
        {!matrix.rows.length ? <Empty title="No linked content in these dates">{linked ? `${count(linked)} linked ${linked === 1 ? 'group has' : 'groups have'} no post or views in these dates. Widen the dates or clear the filters. ` : 'Nothing has been linked yet. '}{`Confirm a suggested match above to add a row. If nothing is suggested, the same video may not be on two pages in these dates, or its copies differ too much: captions must share most of their words, lengths must be within ${MATCH_RULES.durationGate} seconds and publish dates within ${MATCH_RULES.windowDays} days. Refresh your pages so captions and lengths are saved, then come back.`}</Empty>
          : <><div className="an-table-wrap" role="region" aria-label="Page × Content" tabIndex={0}><table className="an-table an-matrix-table"><thead><tr><th>Content</th>{matrix.pageIds.map(id => <th key={id}>{name(id)}<small>{allPages.get(id) ? platformNames[allPages.get(id)!.platform] : ''}</small></th>)}<th>Total</th></tr></thead>
            <tbody>{pageSlice(matrix.rows, pageIndex).map(row => <tr key={row.groupId}><th scope="row"><div className="an-post-title">{row.thumbnail && <img src={row.thumbnail} alt="" width={52} height={66} loading="lazy" referrerPolicy="no-referrer" />}<div><strong>{row.title || 'Untitled content'}</strong><small>First on {name(row.first.pageId)} · {date(row.first.publishedAt)} · {count(row.cells.size)} pages</small><button className="an-inline-link" disabled={busy} onClick={() => void linkContent('unlink', members(row), null, 'Content unlinked. Its posts can be suggested again.')}>Unlink</button></div></div></th>
              {matrix.pageIds.map(id => { const cell = row.cells.get(id); return <td key={id} className={row.best === id ? 'best' : undefined}>{cell ? <>{count(cell.value)}{row.best === id && <small>Best</small>}{isNumber(cell.lagDays) && cell.lagDays >= 0.05 && <small>+{decimal(cell.lagDays, 1)} d</small>}</> : <span className="an-muted" title="Not posted on this page">·</span>}</td>; })}
              <td><strong>{count(row.total)}</strong>{row.known < row.cells.size && <small>{count(row.known)} of {count(row.cells.size)} pages known</small>}{row.platforms.length > 1 && <small>Mixed platforms</small>}</td></tr>)}</tbody>
            <tfoot><tr><th>Per-page total</th>{matrix.pageIds.map(id => <td key={id}>{count(matrix.pageTotals.get(id))}<small>Best {count(matrix.wins.get(id) || 0)}×</small></td>)}<td>{count(matrix.total)}</td></tr></tfoot></table></div>
            <Pagination total={matrix.rows.length} current={pageIndex} onChange={setPageIndex} /><p className="an-panel-note">A dash means the views are not recorded, not zero; totals add only known values.{matrix.mixedPlatforms ? ' Totals combine Instagram plays, YouTube views and TikTok plays, which each platform counts differently.' : ''} Unlink a row if its posts are not the same content.</p></>}
      </section></>;
  }
  function detailScreen(row: PageAnalysis) {
    const comparisonMetrics = analysis?.comparison?.pages.find(item => item.pageId === row.page.id)?.metrics;
    const pageAlerts = (analysis?.alerts || []).filter(alert => !alert.resolvedAt && alert.pageId === row.page.id).sort((a, b) => ['red', 'amber', 'green'].indexOf(a.level) - ['red', 'amber', 'green'].indexOf(b.level));
    return <><section className="an-page-hero"><div><span className="an-platform-label">{platformNames[row.page.platform]} · @{row.page.handle}{row.page.displayName && row.page.name && row.page.displayName !== row.page.name ? ' · ' + row.page.name : ''}</span><h2>{pageLabel(row.page)}</h2><p>{row.page.editor ? 'Responsible person: ' + row.page.editor : 'No responsible person assigned'} · {money(row.page.monthlyPay)} / month · {row.page.active ? 'Active' : row.page.endDate ? 'Inactive · paid through ' + date(row.page.endDate) : 'Inactive'}</p><small>Last updated {row.page.lastSyncedAt ? date(row.page.lastSyncedAt, true) : 'not yet'}</small></div><div className="an-page-hero-actions"><button className="an-button" disabled={busy} onClick={() => openModal({ type: 'edit', page: row.page })}><Pencil size={15} />Edit details</button><button className="an-button primary" disabled={demo || busy} onClick={() => refresh([row.page])}><RefreshCw size={15} />Refresh</button>{safeUrl(row.page.url) && <a className="an-button" href={row.page.url} target="_blank" rel="noopener noreferrer">Public page<ExternalLink size={15} /></a>}</div></section>{row.page.syncError && <div className="an-error" role="alert"><AlertCircle size={19} /><div><strong>The last refresh needs attention</strong><p>{row.page.syncError}</p></div></div>}
      {pageAlerts.length > 0 && <section className="an-page-alerts" aria-label="Alerts for this page"><h2>Needs attention on this page<small>{pageAlerts.length}</small></h2>{pageAlerts.map(alert => <div className={'an-alert-group ' + alert.level} key={alert.id}>{alertCard(alert, row.page, false)}</div>)}</section>}
      <div className="an-kpis four"><Kpi label={viewLabel} value={count(mode === 'gained' ? row.metrics.viewsGained : row.metrics.publishedViews)} featured coverage={mode === 'gained' ? row.metrics.viewsCoverage : undefined} change={mode === 'gained' ? comparisonMetrics?.viewsGained : undefined} /><Kpi label="Follower growth" value={count(row.metrics.followerGrowth)} coverage={row.metrics.followerCoverage} note={`${count(row.metrics.followers)} latest followers`} /><Kpi label="Typical day-7 views" value={count(row.metrics.medianViews)} note={`${count(row.metrics.comparablePosts)} comparable posts · average ${count(row.metrics.averageViews)}`} /><Kpi label="Consistency" value={row.metrics.consistencyScore == null ? '-' : count(row.metrics.consistencyScore) + '/100'} note={`${steadiness(row.metrics.consistencyScore)} · one viral post cannot inflate it`} /></div>
      <div className="an-two-column"><section className="an-panel"><div className="an-panel-header"><h2>Followers over time</h2></div><LineChart title="Recorded followers over time" points={row.timeline.map(point => ({ label: shortDate(point.date), value: point.followers }))} /></section><section className="an-panel"><div className="an-panel-header"><h2>{viewLabel} over time</h2></div><LineChart title={viewLabel + ' over time'} points={row.timeline.map(point => ({ label: shortDate(point.date), value: mode === 'gained' ? point.viewsGained : point.publishedViews ?? null }))} /></section></div>
      <section className="an-panel"><div className="an-panel-header"><div><h2>How consistent are the posts?</h2><p>Every comparable post is measured near day seven.</p></div></div><ConsistencyChart analysis={row} /></section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Health score breakdown</h2><p>{row.health.reason || 'Absolute scores blended with your pages on ' + platformNames[row.page.platform] + '.'}</p></div>{healthBadge(row)}</div><div className="an-score-grid">{row.health.components.map(component => <article key={component.key}><div><strong>{component.label}</strong><span>{percent(component.weight > 1 ? component.weight / 100 : component.weight)} weight</span></div><progress value={component.score ?? 0} max={100} aria-label={component.label + ' score'} /><p>{component.score == null ? 'More history needed' : `Score ${decimal(component.score, 0)}/100 · ${decimal(component.points, 1)} points${component.percentile == null ? '' : component.percentile > 50 ? ' · above same-platform peers' : component.percentile < 50 ? ' · below same-platform peers' : ' · level with same-platform peers'}`}</p></article>)}</div><p className="an-panel-note">Health needs at least five posts measured at day 7. Each component scores 0–100, where 70 is healthy. Typical views use the median, so one viral post cannot inflate the score. Bands: 80+ healthy, 50–79 watch, below 50 at risk. A missing component is left out and marked provisional (*).</p></section>
      {row.page.notes && <section className="an-panel an-notes"><h2>Page notes</h2><p>{row.page.notes}</p></section>}{comparisonMetrics && <section className="an-panel"><div className="an-panel-header"><h2>This page: period comparison</h2></div>{comparisonTable(comparisonMetrics)}</section>}{postTable()}</>;
  }
  let detected: ReturnType<typeof parsePage> | null = null;
  if (modal?.type === 'add' && form.input.trim()) { try { detected = parsePage(form.input, form.platform); } catch { /* The server returns a clear validation error on submit. */ } }
  const duplicate = detected ? dataset?.pages.find(page => page.platform === detected!.platform && page.handle.toLowerCase() === detected!.handle.toLowerCase()) : undefined;

  return <div className={'an-app' + (demo ? ' an-demo' : '')}>
    <aside className="an-sidebar"><a className="an-brand" href={demo ? '/demo' : '/dashboard'}><span><Layers3 size={23} /></span><strong>{PRODUCT_NAME}<i>.</i></strong></a><div className="an-workspace"><span>{initials(account.name || account.email)}</span><div><strong>{demo ? 'Sample workspace' : account.name || 'My workspace'}</strong><small>{demo ? 'Explore with sample data' : account.email}</small></div></div><nav aria-label="Workspace sections">{sections.map(item => <button key={item.id} className={section === item.id && !selectedPage ? 'active' : ''} aria-current={section === item.id && !selectedPage ? 'page' : undefined} onClick={() => chooseSection(item.id)}><small>{item.code}</small><item.icon size={18} /><span>{item.label}</span></button>)}</nav><div className="an-sidebar-bottom"><a href={demo ? '/login' : '/collections'}><FolderOpen size={17} />{demo ? 'Open your workspace' : 'Collections & backups'}</a>{!demo && account.userType === 'admin' && <a href="/admin"><ShieldCheck size={17} />Admin directory</a>}{!demo && <SignOutButton className="an-signout"><LogOut size={17} />Sign out</SignOutButton>}<p>Public page data.<br />Your own workspace.</p></div></aside>
    <main className="an-main"><header className="an-topbar"><div><span>Workspace</span><ChevronRight size={14} /><strong>{title}</strong></div><a href={demo ? '/login' : '/collections'}><ArrowDownToLine size={15} />{demo ? 'Sign in' : 'Import / export'}</a></header>
      <div className="an-content">{demo && <div className="an-demo-banner"><span><strong>Demo workspace</strong> · These are sample records. Your real account is unchanged.</span><a href="/login">Create your workspace<ArrowRight size={15} /></a></div>}
        <div className="an-heading"><div>{selectedPage && <button className="an-back" onClick={() => setSelectedPage(null)}><ArrowLeft size={15} />Back to {sections.find(item => item.id === section)?.label}</button>}<span className="an-eyebrow">YOUR DISTRIBUTION, CLEARLY</span><h1>{title}<span>.</span></h1><p>{detail ? 'Understand this page’s history, typical performance, and cost.' : section === 'overview' ? 'See what needs attention today, what changed, and what worked.' : section === 'pages' ? 'Keep every page, person, and page cost organised.' : section === 'performance' ? 'Compare like with like, on the same platform.' : section === 'posts' ? 'Find the posts behind your pages’ performance.' : section === 'matrix' ? 'See how the same content performs on each page.' : section === 'economics' ? 'Connect page pay to the results you have actually recorded.' : section === 'monthly' ? 'A clear record of performance and page costs.' : 'Act on persistent changes, with the context behind each alert.'}</p></div><div className="an-heading-actions">{updating && <span className="an-updating" role="status"><Loader2 size={15} className="spin" />Updating…</span>}<button className="an-button" onClick={exportVisibleSection} disabled={!analysis}><ArrowDownToLine size={16} />Export CSV</button><button className="an-button primary" disabled={demo || busy || !analysis?.pages.some(row => row.page.active)} onClick={() => refresh(detail ? [detail.page] : analysis!.pages.filter(row => row.page.active).map(row => row.page))}><RefreshCw size={16} className={refreshProgress ? 'spin' : ''} />{refreshProgress ? `Refreshing ${refreshProgress.current}/${refreshProgress.total}` : 'Refresh pages'}</button></div></div>
        <section className="an-filters" aria-label="Analysis filters"><div className="an-filter-row"><label className="an-period"><CalendarDays size={17} /><span className="sr-only">Date preset</span><select aria-label="Date preset" value={preset} onChange={event => choosePreset(event.target.value)}>{presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="custom">Custom dates</option></select></label><label>Platform<select value={platform} onChange={event => { setPlatform(event.target.value as AnalyticsPlatform | 'all'); setSelectedPage(null); }}><option value="all">All platforms</option>{platforms.map(item => <option key={item} value={item}>{platformNames[item]}</option>)}</select></label>{dataset?.collections?.length ? <label>Collection<select value={collectionId} onChange={event => { setCollectionId(event.target.value); setSelectedPage(null); }}><option value="">All collections</option>{dataset.collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}<label className="an-search"><Search size={17} /><input aria-label="Filter pages by name, handle, or responsible person" placeholder="Find a page or person" value={search} onChange={event => { setSearch(event.target.value); setSelectedPage(null); }} /><button type="button" aria-label="Clear page filter" onClick={() => setSearch('')} hidden={!search}><X size={14} /></button></label><label className="an-check"><input type="checkbox" checked={!!comparison} onChange={event => { const prior = previousRange(range); setComparison(event.target.checked ? prior : null); setCompareDraft(prior); }} />Compare dates</label></div>
          {preset !== 'custom' && !comparison ? <p className="an-range-summary"><span>{rangeLabel(range)}</span><small>India time · both dates included</small></p> : <form className="an-dates" onSubmit={applyDates}><label>From<input aria-label="Range start" type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} required /></label><span>to</span><label>To<input aria-label="Range end" type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} required /></label>{comparison && <><span className="an-vs">compared with</span><label>Compare from<input aria-label="Comparison start" type="date" value={compareDraft.from} onChange={event => setCompareDraft({ ...compareDraft, from: event.target.value })} required /></label><label>Compare to<input aria-label="Comparison end" type="date" value={compareDraft.to} onChange={event => setCompareDraft({ ...compareDraft, to: event.target.value })} required /></label></>}<button className="an-button" type="submit">Apply dates</button><small>India time · both dates included</small></form>}{rangeError && <p className="an-error-text" role="alert">{rangeError}</p>}
          {(detail || (section !== 'pages' && section !== 'alerts')) && <div className="an-view-mode"><div role="group" aria-label="View measurement"><button className={mode === 'gained' ? 'active' : ''} aria-pressed={mode === 'gained'} onClick={() => setMode('gained')}>Views gained during range</button><button className={mode === 'published' ? 'active' : ''} aria-pressed={mode === 'published'} onClick={() => setMode('published')}>Views on posts published in range</button></div><p>{mode === 'gained' ? 'Measured from snapshots. History starts when tracking begins.' : 'Latest saved lifetime views of those posts. This is not views earned during the selected dates.'}</p></div>}
        </section>
        {refreshProgress && <div className="an-progress" role="status"><Loader2 size={18} className="spin" /><span>Refreshing page {refreshProgress.current} of {refreshProgress.total}. You can stop after the current page.</span><button className="an-button" onClick={() => { stopRefresh.current = true; }}>Stop after this page</button></div>}
        {notice && <div className="an-notice" role="status"><Check size={18} /><span>{notice}</span><button aria-label="Dismiss update" onClick={() => setNotice('')}><X size={15} /></button></div>}{actionError && <div className="an-error" role="alert"><AlertCircle size={19} /><p>{actionError}</p><button aria-label="Dismiss error" onClick={() => setActionError('')}><X size={15} /></button></div>}
        {loading ? <div className="an-loading" role="status"><Loader2 size={26} className="spin" /><strong>Loading your page history</strong><p>Bringing together your pages, snapshots, and alerts.</p></div> : error || calculation.error ? <div className="an-error an-load-error" role="alert"><AlertCircle size={25} /><div><h2>Your data could not be loaded</h2><p>{error || calculation.error}</p><button className="an-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />Try again</button><a className="an-inline-link" href="/collections">Open collections & backups<ArrowRight size={14} /></a></div></div> : analysis && <>
          {analysis.warnings.length > 0 && <details className="an-history-note"><summary><CircleHelp size={17} /><span>About the history in this view</span><span>{analysis.warnings.length}</span></summary><ul>{analysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          {!dataset?.pages.length ? <section className="an-panel"><Empty title="Start with your first public page" action={<div className="an-empty-actions"><button className="an-button primary" disabled={busy} onClick={() => openModal({ type: 'add' })}><Plus size={16} />Add a page</button><a className="an-button" href="/collections">Import a workspace</a></div>}>Paste an Instagram, YouTube, or TikTok profile. You do not need to connect or sign in to the social account. Growth history builds from the first successful fetch.</Empty></section> : !analysis.pages.length ? <section className="an-panel"><Empty title="No pages match these filters" action={<button className="an-button" onClick={() => { setSearch(''); setPlatform('all'); setCollectionId(''); }}>Clear filters</button>}>Try another page name, platform, or collection.</Empty></section> : selectedPage && !detail ? <section className="an-panel"><Empty title="This page is no longer in this view" action={<button className="an-button" onClick={() => setSelectedPage(null)}>Back to pages</button>}>It may have been removed or excluded by the current filters.</Empty></section> : detail ? detailScreen(detail) : section === 'overview' ? overview() : section === 'pages' ? pagesScreen() : section === 'performance' ? performance() : section === 'posts' ? postTable() : section === 'matrix' ? matrixScreen() : section === 'economics' ? economics() : section === 'monthly' ? monthly() : alerts()}
        </>}
        <footer className="an-footer"><strong>{PRODUCT_NAME}<span>.</span></strong><p>{dataset ? 'Data loaded ' + date(dataset.generatedAt, true) : 'Your private workspace'} · Missing metrics stay unavailable.</p></footer>
      </div>
    </main>
    {modal && <WorkspaceDialog title={modal.type === 'add' ? 'Add a public page' : modal.type === 'edit' ? 'Edit ' + pageLabel(modal.page) : 'Remove this page?'} onClose={() => setModal(null)} busy={saving} wide={modal.type !== 'remove'}><form className="an-page-form" onSubmit={submitPage}>{modal.type === 'remove' ? <><p><strong>{modal.page.name || modal.page.handle}</strong> will be removed from all your collections, together with its saved tracking history.</p><p className="an-form-hint">Export a workspace backup first if you may want this history later. This only changes your workspace.</p>{modal.page.active && <p className="an-form-hint">If you stopped working with this page, mark it inactive instead: its history stays and its pay stops today.</p>}<a className="an-inline-link" href="/collections">Open workspace backups<ArrowUpRight size={14} /></a>{modal.page.active && <button type="button" className="an-button" disabled={saving || demo} onClick={() => { const page = modal.page; setModal(null); setActive(page, false); }}><Pause size={16} />Mark inactive instead</button>}</> : <>{modal.type === 'add' && <><p className="an-form-hint">Add a public profile. We will fetch available data and start recording its history.</p><label>Profile URL or handle<input data-autofocus required maxLength={300} placeholder="instagram.com/yourpage or @yourpage" value={form.input} onChange={event => setForm({ ...form, input: event.target.value })} /></label><label>Platform for a plain handle<select value={form.platform} onChange={event => setForm({ ...form, platform: event.target.value as AnalyticsPlatform })}>{platforms.map(item => <option key={item} value={item}>{platformNames[item]}</option>)}</select></label>{detected && <div className="an-profile-preview"><Check size={18} /><div><strong>{platformNames[detected.platform]} · @{detected.handle}</strong><a href={detected.url} target="_blank" rel="noopener noreferrer">Check public profile<ExternalLink size={13} /></a><small>Profile details will be confirmed during the first fetch.</small></div></div>}{duplicate && <div className="an-duplicate" role="alert"><AlertCircle size={18} /><div><strong>Already in your page master: {pageLabel(duplicate)}</strong><p>Adding it again only fills details that are still blank. Edit the saved page to change its pay, editor, or status.</p><button type="button" className="an-button" onClick={() => openModal({ type: 'edit', page: duplicate })}><Pencil size={15} />Edit instead</button></div></div>}</>}{modal.type === 'edit' && <p className="an-form-hint">{platformNames[modal.page.platform]} · @{modal.page.handle}{safeUrl(modal.page.url) && <> · <a href={modal.page.url} target="_blank" rel="noopener noreferrer">Open public page</a></>}</p>}
      <div className="an-form-grid"><label>Display name<input maxLength={150} placeholder={modal.type === 'edit' ? modal.page.name || modal.page.handle : 'Optional internal name'} value={form.displayName} onChange={event => setForm({ ...form, displayName: event.target.value })} /></label><label>Monthly pay (₹)<input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Leave blank if unknown" value={form.monthlyPay} onChange={event => setForm({ ...form, monthlyPay: event.target.value })} /></label><label>Responsible person / editor<input maxLength={150} placeholder="Name of the person managing it" value={form.editor} onChange={event => setForm({ ...form, editor: event.target.value })} /></label><label>Start date (pay counted from)<input type="date" value={form.startDate} onChange={event => setForm({ ...form, startDate: event.target.value })} /></label><label className="an-check"><input type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} />Active: counts pay and is refreshed</label></div><label>Notes<textarea rows={3} maxLength={2000} placeholder="Anything useful to remember about this page" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label><p className="an-form-hint">Pay is a reporting field, not a payment. An inactive page keeps its saved history and stops counting pay.{demo ? ' Saving is disabled in the demo.' : ''}</p></>}{modalError && <p className="an-error-text" role="alert">{modalError}</p>}<div className="an-dialog-actions"><button type="button" className="an-button" disabled={saving} onClick={() => setModal(null)}>Cancel</button><button className={'an-button ' + (modal.type === 'remove' ? 'danger' : 'primary')} type="submit" disabled={saving || demo}>{saving ? <Loader2 size={16} className="spin" /> : modal.type === 'remove' ? <Trash2 size={16} /> : <Check size={16} />}{saving ? 'Saving…' : modal.type === 'add' ? 'Add and fetch page' : modal.type === 'edit' ? 'Save details' : 'Remove page'}</button></div></form></WorkspaceDialog>}
  </div>;
}
