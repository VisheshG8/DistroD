"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, AlertCircle, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Bell, CalendarDays, ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, CircleHelp, ExternalLink, FileText, FolderOpen, IndianRupee, LayoutDashboard, Layers3, Loader2, LogOut, Pause, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users, Video, X } from 'lucide-react';
import SignOutButton from '@/components/auth/sign-out-button';
import { WorkspaceDialog } from '@/components/workspace-dialog';
import { downloadFile } from '@/lib/workspace-transfer';
import { parsePage } from '@/lib/pages';
import { PRODUCT_NAME } from '@/lib/product';
import { loadAnalyticsDataset } from '@/lib/analytics/client';
import { HISTORY_REUSE_MS, historyStart, narrowHistory } from '@/lib/analytics/history-window';
import { calculateHealthScores, createWorkspaceCalculator, previousRange, rangeForPreset } from '@/lib/analytics/metrics';
import type { AnalyticsDataset, AnalyticsPage, AnalyticsPlatform, AnalyzedPost, ComparisonMetrics, DateRange, MetricChange, MetricCoverage, PageAnalysis, RangePreset, WorkspaceAnalysis } from '@/lib/analytics/types';
import './analytics.css';

type Account = { id: string; email: string | null; name: string | null; userType: 'admin' | 'user' };
type Section = 'overview' | 'pages' | 'performance' | 'posts' | 'economics' | 'monthly' | 'alerts';
type ViewMode = 'gained' | 'published';
type PostSort = 'newest' | 'views' | 'shares' | 'engagement' | 'best' | 'worst';
type Modal = { type: 'add' } | { type: 'edit' | 'remove'; page: AnalyticsPage } | null;
type PageForm = { input: string; platform: AnalyticsPlatform; monthlyPay: string; editor: string; startDate: string; active: boolean; notes: string };
type ExtendedDataset = AnalyticsDataset & { collections?: { id: string; name: string }[]; memberships?: { collectionId: string; pageId: string }[] };
type LoadedHistory = { key: string; revision: number; start: number; stale: boolean; dataset: ExtendedDataset };
const emptyForm: PageForm = { input: '', platform: 'instagram', monthlyPay: '', editor: '', startDate: '', active: true, notes: '' };
const platforms: AnalyticsPlatform[] = ['instagram', 'youtube', 'tiktok'];
const platformNames = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' };
const sections: { id: Section; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'pages', label: 'Pages', icon: Users },
  { id: 'performance', label: 'Performance', icon: ChartNoAxesCombined }, { id: 'posts', label: 'Posts', icon: Video },
  { id: 'economics', label: 'Economics', icon: IndianRupee }, { id: 'monthly', label: 'Monthly report', icon: FileText },
  { id: 'alerts', label: 'Alerts', icon: Bell },
];
const presets: { id: RangePreset; label: string }[] = [{ id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: '90d', label: '90 days' }, { id: 'this-month', label: 'This month' }, { id: 'last-month', label: 'Last month' }];
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
const money = (value: number | null | undefined) => isNumber(value) ? (value < 100 ? smallMoneyFormat : moneyFormat).format(value) : '-';
const percent = (value: number | null | undefined) => isNumber(value) ? percentFormat.format(value) : '-';
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
    const raw = String(value), safe = typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/.test(raw) ? "'" + raw : raw;
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
function Change({ change, lowerBetter = false }: { change?: MetricChange; lowerBetter?: boolean }) {
  if (!change || change.difference == null) return <span className="an-change neutral">Comparison unavailable</span>;
  const direction = change.difference === 0 ? 'neutral' : (change.difference > 0) !== lowerBetter ? 'up' : 'down';
  return <span className={'an-change ' + direction}>{change.difference > 0 ? '+' : ''}{change.percent == null ? decimal(change.difference) : percent(change.percent)} <small>vs comparison</small></span>;
}
function Kpi({ label, value, note, featured = false, change, lowerBetter, coverage }: { label: string; value: string; note?: string; featured?: boolean; change?: MetricChange; lowerBetter?: boolean; coverage?: MetricCoverage }) {
  return <div className={'an-kpi' + (featured ? ' featured' : '')}><span>{label}</span><strong>{value}</strong>{change ? <Change change={change} lowerBetter={lowerBetter} /> : note && <small>{note}</small>}<Coverage value={coverage} /></div>;
}
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
    {[{ label: 'Median', value: analysis.metrics.medianViews, color: '#0f7d5a' }, { label: 'Average', value: analysis.metrics.averageViews, color: '#b87a00' }].map(item => isNumber(item.value) && <g key={item.label}><line x1="60" x2="735" y1={y(item.value)} y2={y(item.value)} stroke={item.color} strokeDasharray="5 4" /><text x="62" y={Math.max(15, y(item.value) - 7)} fill={item.color}>{item.label}: {count(item.value)}</text></g>)}
    {posts.map((post, index) => <circle key={post.id} cx={65 + index / Math.max(1, posts.length - 1) * 660} cy={y(post.fixedAgeViews!)} r="4" fill="#142231"><title>{`${post.title || post.id}: ${count(post.fixedAgeViews)} day-seven views`}</title></circle>)}
    <text x="60" y="218">Earlier posts</text><text x="735" y="218" textAnchor="end">Later posts</text>
  </svg><figcaption>Each dot is one comparable post. Typical performance uses the median; the average is a secondary reference.</figcaption></figure>;
}
function EconomicsChart({ pages }: { pages: PageAnalysis[] }) {
  const points = pages.filter(row => isNumber(row.metrics.pay) && isNumber(row.metrics.viewsGained));
  if (!points.length) return <div className="an-chart-empty"><IndianRupee size={27} /><strong>Pay and view history are needed</strong><p>Add monthly pay to your pages. Recorded views gained will then appear against prorated pay.</p></div>;
  const maxPay = Math.max(1, ...points.map(row => row.metrics.pay!)), maxViews = Math.max(1, ...points.map(row => row.metrics.viewsGained!));
  return <figure className="an-chart"><svg viewBox="0 0 760 245" role="img" aria-label="Page pay versus recorded views gained. Each dot represents a page."><title>Pay versus views gained</title>
    {[0, .5, 1].map(value => <g key={value}><line x1="68" x2="730" y1={195 - value * 160} y2={195 - value * 160} stroke="#e1e7df" /><text x="58" y={199 - value * 160} textAnchor="end">{count(maxViews * value, true)}</text><text x={68 + value * 662} y="216" textAnchor={value === 0 ? 'start' : value === 1 ? 'end' : 'middle'}>{money(maxPay * value)}</text></g>)}
    {points.map(row => <circle key={row.page.id} cx={68 + row.metrics.pay! / maxPay * 662} cy={195 - Math.max(0, row.metrics.viewsGained!) / maxViews * 160} r="6" fill="#0f7d5a" fillOpacity=".7"><title>{`${row.page.name || row.page.handle}: ${money(row.metrics.pay)} pay, ${count(row.metrics.viewsGained)} views gained`}</title></circle>)}
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
  const [report, setReport] = useState<LoadedHistory | null>(null), [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const [modal, setModal] = useState<Modal>(null), [form, setForm] = useState<PageForm>(emptyForm), [saving, setSaving] = useState(false), [modalError, setModalError] = useState('');
  const [notice, setNotice] = useState(''), [actionError, setActionError] = useState(''), [refreshProgress, setRefreshProgress] = useState<{ current: number; total: number } | null>(null);
  const stopRefresh = useRef(false), mounted = useRef(true);
  const requestKey = JSON.stringify([range.from, range.to, comparison?.from, comparison?.to, revision]);
  const neededStart = useMemo(() => historyStart(range, comparison), [range, comparison]);
  // A loaded history already contains every observation a narrower range needs, so reuse it instead of refetching.
  // After an edit or refresh, keep the previous numbers on screen while the new history loads.
  const covers = !!report && report.start <= neededStart;
  const current = !!report && (report.key === requestKey || (covers && report.revision === revision && !report.stale));
  const shown = demo && initialDataset ? null : current || covers ? report : null;
  const shownDataset = shown?.dataset, shownStart = shown?.start;
  const loadedDataset = useMemo(() => shownDataset && shownStart !== undefined ? narrowHistory(shownDataset, shownStart, neededStart) : null, [shownDataset, shownStart, neededStart]);
  const dataset: ExtendedDataset | null = demo && initialDataset ? initialDataset : loadedDataset;
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
  useEffect(() => { setPageIndex(0); setPostIndex(0); }, [section, platform, search, collectionId, range.from, range.to, postSort]);
  // Typing stays responsive; the workspace is recalculated once the input settles.
  const searchQuery = useDeferredValue(search);
  const filteredDataset = useMemo(() => {
    if (!dataset) return null;
    const collectionPages = collectionId ? new Set(dataset.memberships?.filter(item => item.collectionId === collectionId).map(item => item.pageId)) : null;
    const text = searchQuery.trim().toLowerCase();
    const pages = dataset.pages.filter(page => (platform === 'all' || page.platform === platform) && (!collectionPages || collectionPages.has(page.id)) && (!text || [page.name, page.handle, page.editor].some(value => value?.toLowerCase().includes(text))));
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
  const title = detail ? detail.page.name || detail.page.handle : sections.find(item => item.id === section)!.label;
  const viewLabel = mode === 'gained' ? 'Views gained' : 'Published-post views';
  const visiblePosts = useMemo(() => {
    const rows = (detail ? detail.posts : analysis?.pages.flatMap(item => item.posts) || []).filter(post => post.inRange);
    const sort = platform === 'all' && !detail ? 'newest' : postSort;
    return [...rows].sort((a, b) => {
      if (sort === 'newest') return Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '');
      const key = sort === 'shares' ? 'shares' : sort === 'engagement' ? 'engagementRate' : sort === 'best' || sort === 'worst' ? 'baselineRatio' : 'views';
      const av = a[key], bv = b[key];
      if (av == null) return bv == null ? 0 : 1;
      if (bv == null) return -1;
      return sort === 'worst' ? av - bv : bv - av;
    });
  }, [analysis, detail, postSort, platform, range]);

  function chooseSection(next: Section) {
    setSection(next); setSelectedPage(null); setPageIndex(0); setPostIndex(0); setActionError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (next === 'monthly') { const current = rangeForPreset('this-month', clock), prior = rangeForPreset('last-month', clock); setRange(current); setDraft(current); setPreset('this-month'); setComparison(prior); setCompareDraft(prior); }
  }
  function choosePreset(value: string) {
    setPreset(value); setRangeError(''); if (value === 'custom') return;
    const next = rangeForPreset(value as RangePreset, clock); setRange(next); setDraft(next);
    if (comparison) { const prior = previousRange(next); setComparison(prior); setCompareDraft(prior); }
  }
  function applyDates(event: FormEvent) {
    event.preventDefault();
    if (!validRange(draft) || (comparison && !validRange(compareDraft))) { setRangeError('Choose a valid start date and an end date on or after it.'); return; }
    setRangeError(''); setRange({ ...draft }); setPreset('custom'); if (comparison) setComparison({ ...compareDraft });
  }
  function openPage(id: string) { setSelectedPage(id); setPostIndex(0); setActionError(''); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function openModal(value: Modal) {
    setModalError(''); setModal(value);
    if (value?.type === 'edit') { const page = value.page; setForm({ input: page.url, platform: page.platform, monthlyPay: page.monthlyPay == null ? '' : String(page.monthlyPay), editor: page.editor, startDate: page.startDate || '', active: page.active, notes: page.notes }); }
    else setForm({ ...emptyForm });
  }
  async function mutate(data: Record<string, unknown>) {
    const response = await fetch('/api/analytics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'The change could not be saved. Please retry.'); return result as { ok: boolean; pageId?: string; warning?: string };
  }
  async function submitPage(event: FormEvent) {
    event.preventDefault(); if (demo || !modal || saving) return;
    const monthlyPay = form.monthlyPay.trim() ? Number(form.monthlyPay) : null;
    if (monthlyPay !== null && (!Number.isFinite(monthlyPay) || monthlyPay < 0)) { setModalError('Monthly pay must be zero or a positive amount.'); return; }
    setSaving(true); setModalError(''); setActionError('');
    try {
      const payload = modal.type === 'remove' ? { action: 'removePage', pageId: modal.page.id } : { action: modal.type === 'add' ? 'addPage' : 'savePage', ...(modal.type === 'edit' ? { pageId: modal.page.id } : { input: form.input.trim(), platform: form.platform, ...(collectionId ? { collectionId } : {}) }), monthlyPay, editor: form.editor.trim(), startDate: form.startDate || null, active: form.active, notes: form.notes.trim() };
      const result = await mutate(payload);
      if (modal.type === 'remove') setSelectedPage(null);
      setNotice(result.warning || (modal.type === 'remove' ? 'Page removed from your workspace.' : modal.type === 'add' ? 'Page added. Its history starts with the first successful refresh.' : 'Page details saved.'));
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
        const response = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: page.id, scope: { mode: 'posts', postLimit: 100, from: null, to: null } }) });
        const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'Refresh failed.');
      } catch (cause) { failures.push(`${page.name || page.handle}: ${cause instanceof Error ? cause.message : 'Refresh failed.'}`); }
      done++;
    }
    if (!mounted.current) return;
    setRefreshProgress(null); setRevision(value => value + 1);
    if (failures.length) setActionError(`${failures.length} ${failures.length === 1 ? 'page needs' : 'pages need'} another refresh. ${failures[0]}`);
    else setNotice(`${done} ${done === 1 ? 'page refreshed' : 'pages refreshed'}. Recorded snapshots are now available in your history.`);
  }
  async function resolveAlert(id: string) {
    if (demo || busy) return; setSaving(true); setActionError('');
    try { await mutate({ action: 'resolveAlert', id }); setRevision(value => value + 1); setNotice('Alert marked as resolved.'); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not resolve this alert.'); }
    finally { setSaving(false); }
  }
  function exportPages() {
    if (!analysis) return;
    const rows: (string | number | null | undefined)[][] = [['Platform', 'Page', 'Handle', 'Range start', 'Range end', 'Views gained', 'History coverage', 'History note', 'Published-post lifetime views', 'Posts published', 'Day-7 median views', 'Day-7 average views', 'Comparable posts', 'Health score', 'Health note', 'Engagement rate', 'Shares', 'Followers', 'Follower growth', 'Monthly pay INR', 'Range pay INR', 'Cost per 1M views INR', 'Editor', 'Active']];
    (detail ? [detail] : analysis.pages).forEach(({ page, metrics, health }) => rows.push([platformNames[page.platform], page.name, page.handle, range.from, range.to, metrics.viewsGained, metrics.viewsCoverage.status, metrics.viewsCoverage.reason, metrics.publishedViews, metrics.postsPublished, metrics.medianViews, metrics.averageViews, metrics.comparablePosts, health.score, health.reason, metrics.engagementRate, metrics.shares, metrics.followers, metrics.followerGrowth, page.monthlyPay, metrics.pay, metrics.costPerMillion, page.editor, page.active ? 'Yes' : 'No']));
    CsvDownload(`distribution-${detail ? 'page-' + detail.page.platform + '-' + detail.page.handle : 'pages'}-${range.from}-${range.to}`, rows);
  }
  function exportPosts() {
    const rows: (string | number | null | undefined)[][] = [['Platform', 'Page', 'Caption', 'URL', 'Published', 'Type', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Maturing', 'Day-7 views', 'Day-7 observed', 'Engagement rate', 'Against baseline']];
    visiblePosts.forEach(post => rows.push([platformNames[post.pagePlatform], post.pageName, post.title, post.url, post.publishedAt, post.type, post.views, post.likes, post.comments, post.shares, post.saves, post.maturing ? 'Yes' : 'No', post.fixedAgeViews, post.fixedAgeObservedAt, post.engagementRate, post.baselineRatio]));
    CsvDownload(`distribution-posts-${range.from}-${range.to}`, rows);
  }
  function exportMonthly() {
    if (!analysis) return;
    const rows: (string | number | null | undefined)[][] = [['Month', 'Page', 'Platform', 'Range start', 'Range end', 'Pay INR', 'Views gained', 'Coverage', 'Posts published', 'Day-7 median views', 'Engagement rate', 'Follower growth', 'Cost per 1M views INR']];
    analysis.monthly.forEach(month => { rows.push([month.month, 'All filtered pages', platform === 'all' ? 'Mixed raw totals' : platformNames[platform], month.range.from, month.range.to, month.totals.pay, month.totals.viewsGained, month.totals.viewsCoverage.status, month.totals.postsPublished, month.totals.medianViews, month.totals.engagementRate, month.totals.followerGrowth, month.totals.costPerMillion]); month.pages.forEach(row => { const page = analysis.pages.find(item => item.page.id === row.pageId)?.page; if (page) rows.push([month.month, page.name, platformNames[page.platform], month.range.from, month.range.to, row.metrics.pay, row.metrics.viewsGained, row.metrics.viewsCoverage.status, row.metrics.postsPublished, row.metrics.medianViews, row.metrics.engagementRate, row.metrics.followerGrowth, row.metrics.costPerMillion]); }); });
    if (analysis.comparison) {
      rows.push([], ['Period comparison'], ['Selected range', range.from, range.to], ['Comparison range', analysis.comparison.range.from, analysis.comparison.range.to], ['Verdict', analysis.comparison.verdict], ['Page', 'Metric', 'Selected dates', 'Comparison dates', 'Absolute change', 'Fractional change']);
      const labels: Record<keyof ComparisonMetrics, string> = { pay: 'Prorated pay INR', viewsGained: 'Views gained', postsPublished: 'Posts published', costPerMillion: 'Cost per 1M views INR', medianViews: 'Day-7 median views', engagementRate: 'Engagement rate', followerGrowth: 'Follower growth' };
      const appendComparison = (name: string, comparisonMetrics: ComparisonMetrics) => {
        (Object.keys(labels) as (keyof ComparisonMetrics)[]).forEach(key => { const value = comparisonMetrics[key]; rows.push([name, labels[key], value.current, value.previous, value.difference, value.percent]); });
      };
      appendComparison('All filtered pages', analysis.comparison.metrics);
      analysis.comparison.pages.forEach(row => { const page = analysis.pages.find(item => item.page.id === row.pageId)?.page; if (page) appendComparison(`${platformNames[page.platform]}: ${page.name || page.handle}`, row.metrics); });
    }
    CsvDownload(`distribution-monthly-${range.from}-${range.to}`, rows);
  }
  function exportAlerts() {
    if (!analysis) return;
    const rows: (string | number | null | undefined)[][] = [['Platform', 'Page', 'Level', 'Type', 'Title', 'Details', 'Created']];
    analysis.alerts.filter(alert => !alert.resolvedAt).forEach(alert => {
      const page = analysis.pages.find(row => row.page.id === alert.pageId)?.page;
      rows.push([page ? platformNames[page.platform] : '', page?.name || page?.handle, alert.level, alert.type, alert.title, alert.details, alert.createdAt]);
    });
    CsvDownload(`distribution-alerts-${range.from}-${range.to}`, rows);
  }
  function exportVisibleSection() {
    if (detail) exportPages();
    else if (section === 'monthly') exportMonthly();
    else if (section === 'posts') exportPosts();
    else if (section === 'alerts') exportAlerts();
    else exportPages();
  }

  function pageName(page: AnalyticsPage) {
    return <button className="an-page-name" onClick={() => openPage(page.id)}><span className={'an-avatar ' + page.platform}>{initials(page.name || page.handle)}</span><span><strong>{page.name || page.handle}</strong><small>@{page.handle}</small><em>{platformNames[page.platform]}</em></span><ChevronRight size={15} /></button>;
  }
  function healthBadge(row: PageAnalysis) { return <span className={'an-health ' + (row.health.score == null ? 'pending' : row.health.score >= 70 ? 'good' : row.health.score < 40 ? 'low' : 'watch')} title={row.health.reason}>{row.health.score == null ? 'Building history' : count(row.health.score) + '/100'}</span>; }
  function postTable() {
    return <section className="an-panel"><div className="an-panel-header"><div><h2>{detail ? 'Posts on this page' : 'Content tracker'}</h2><p>Posts published in the selected dates. Counts are the latest saved values.</p></div><button className="an-button" onClick={exportPosts} disabled={!visiblePosts.length}><ArrowDownToLine size={16} />CSV</button></div>
      <div className="an-table-controls"><label>Order by<select value={platform === 'all' && !detail ? 'newest' : postSort} onChange={event => setPostSort(event.target.value as PostSort)}><option value="newest">Newest posts</option><option value="views" disabled={platform === 'all' && !detail}>Most viewed</option><option value="shares" disabled={platform === 'all' && !detail}>Most shared</option><option value="engagement" disabled={platform === 'all' && !detail}>Most engaging</option><option value="best" disabled={platform === 'all' && !detail}>Best against baseline</option><option value="worst" disabled={platform === 'all' && !detail}>Lowest against baseline</option></select></label>{platform === 'all' && !detail && <span>Choose one platform above to rank posts fairly.</span>}</div>
      {!visiblePosts.length ? <Empty title="No posts in these dates">Try another date range or refresh your pages.</Empty> : <div className="an-table-wrap" role="region" aria-label="Saved posts" tabIndex={0}><table className="an-table an-posts-table"><thead><tr><th>Post</th><th>Page / date</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Saves</th><th>Engagement</th><th>Vs baseline</th></tr></thead><tbody>{pageSlice(visiblePosts, postIndex).map(post => <tr key={post.pageId + ':' + post.id}><th scope="row"><div className="an-post-title">{safeUrl(post.thumbnail) && <img src={post.thumbnail!} alt="" width={52} height={66} loading="lazy" referrerPolicy="no-referrer" />}<div>{safeUrl(post.url) ? <a href={post.url} target="_blank" rel="noopener noreferrer">{post.title || 'Open post'}<ExternalLink size={12} /></a> : <strong>{post.title || 'Untitled post'}</strong>}<div className="an-tags"><span>{post.type || 'Post'}</span>{post.maturing ? <span className="watch">Maturing · under 7 days</span> : post.fixedAgeViews == null ? <span>Day-7 sample unavailable</span> : <span className="good">Comparable day-7 sample</span>}{post.viral && <span className="good">Viral against baseline</span>}</div></div></div></th><td><button className="an-inline-link" onClick={() => openPage(post.pageId)}>{post.pageName || post.pageHandle}</button><small>{platformNames[post.pagePlatform]} · {date(post.publishedAt)}</small></td><td>{count(post.views)}</td><td>{count(post.likes)}</td><td>{count(post.comments)}</td><td>{count(post.shares)}</td><td>{count(post.saves)}</td><td>{percent(post.engagementRate)}</td><td>{post.baselineRatio == null ? '—' : decimal(post.baselineRatio) + '×'}<small>Day-7 views</small></td></tr>)}</tbody></table></div>}
      <Pagination total={visiblePosts.length} current={postIndex} onChange={setPostIndex} /><p className="an-panel-note">Maturing posts stay out of medians, health scores, and performance alerts. A dash means unavailable, not zero. Instagram saves and reach are not available from public data.</p>
    </section>;
  }
  function comparisonTable(metrics: ComparisonMetrics) {
    const rows: { key: keyof ComparisonMetrics; label: string; format: (value: number | null) => string; lower?: boolean }[] = [{ key: 'pay', label: 'Prorated page pay', format: money }, { key: 'viewsGained', label: 'Views gained', format: count }, { key: 'postsPublished', label: 'Posts published', format: count }, { key: 'costPerMillion', label: 'Cost per 1M views', format: money, lower: true }, { key: 'medianViews', label: 'Median day-7 views', format: count }, { key: 'engagementRate', label: 'Engagement rate', format: percent }, { key: 'followerGrowth', label: 'Follower growth', format: count }];
    return <div className="an-table-wrap" role="region" aria-label="Period comparison" tabIndex={0}><table className="an-table"><thead><tr><th>Metric</th><th>Selected dates</th><th>Comparison dates</th><th>Change</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><th scope="row">{row.label}</th><td>{row.format(metrics[row.key].current)}</td><td>{row.format(metrics[row.key].previous)}</td><td><Change change={metrics[row.key]} lowerBetter={row.lower} /></td></tr>)}</tbody></table></div>;
  }
  function overview() {
    if (!analysis || !total) return null;
    const changes = analysis.comparison?.metrics;
    return <>
      <button className={'an-attention ' + (total.attentionPages ? 'has-attention' : '')} onClick={() => chooseSection('alerts')}><Bell size={18} /><span><strong>{count(total.attentionPages)} {total.attentionPages === 1 ? 'page needs' : 'pages need'} attention</strong><small>{total.attentionPages ? 'Review performance and data alerts.' : 'Your saved alerts are clear.'}</small></span><ArrowRight size={18} /></button>
      <div className="an-kpis"><Kpi label="Active pages" value={count(total.activePages)} note={`${count(total.pages)} pages in this view`} /><Kpi label={viewLabel} value={count(mode === 'gained' ? total.viewsGained : total.publishedViews)} featured coverage={mode === 'gained' ? total.viewsCoverage : undefined} change={mode === 'gained' ? changes?.viewsGained : undefined} note={mode === 'gained' ? 'Recorded changes between snapshots' : 'Lifetime views on posts published in range'} /><Kpi label="Posts published" value={count(total.postsPublished)} change={changes?.postsPublished} note="Published in the selected dates" /><Kpi label="Median views per post" value={count(total.medianViews)} change={changes?.medianViews} note={total.mixedPlatforms ? 'Select a platform for a fair comparison' : `${count(total.comparablePosts)} comparable day-7 samples`} /><Kpi label="Followers / subscribers" value={count(total.followers)} note="Latest recorded account counts" /><Kpi label="Follower growth" value={count(total.followerGrowth)} change={changes?.followerGrowth} coverage={total.followerCoverage} note="Measured from available snapshots" /><Kpi label="Pay for these dates" value={money(total.pay)} change={changes?.pay} note={`${money(total.monthlyPay)} total monthly pay`} /><Kpi label="Cost per 1M views" value={money(total.costPerMillion)} change={changes?.costPerMillion} lowerBetter note="Pay ÷ recorded views gained × 1M" /></div>
      <div className="an-two-column"><section className="an-panel"><div className="an-panel-header"><div><h2>{viewLabel} over time</h2><p>{mode === 'gained' ? 'Changes measured between recorded snapshots.' : 'Latest lifetime counts, grouped by publication day.'}</p></div><span className="an-pill">{analysis.days} days</span></div><LineChart title={viewLabel + ' over time'} points={analysis.timeline.map(point => ({ label: shortDate(point.date), value: mode === 'gained' ? point.viewsGained : point.publishedViews ?? null }))} /></section><section className="an-panel an-engagement"><div className="an-panel-header"><div><h2>Engagement</h2><p>Likes, comments and available shares divided by views.</p></div></div><strong>{total.mixedPlatforms ? 'Choose a platform' : percent(total.engagementRate)}</strong><p>{total.mixedPlatforms ? 'Engagement rates are not compared across Instagram, YouTube, and TikTok.' : 'Uses comparable matured posts and only metrics the source provides.'}</p><dl><div><dt>Shares, where available</dt><dd>{count(total.shares)}</dd></div><div><dt>Average day-7 views</dt><dd>{count(total.averageViews)}</dd></div></dl></section></div>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Standouts by platform</h2><p>Pages and posts compete only with others on the same platform.</p></div></div><div className="an-standouts">{analysis.platforms.map(group => { const best = group.rankings.find(item => item.page.id === group.bestPageId); return <article key={group.platform}><span className="an-platform-label">{platformNames[group.platform]}</span><h3>{best?.page.name || best?.page.handle || 'Still building history'}</h3>{best ? <><p>{count(best.metrics.viewsGained)} recorded views gained<Coverage value={best.metrics.viewsCoverage} /></p><button className="an-inline-link" onClick={() => openPage(best.page.id)}>Open page<ArrowUpRight size={14} /></button></> : <p>A best page appears when comparable history is available.</p>}{group.bestPost && <div className="an-best-post"><span>Best post</span>{safeUrl(group.bestPost.url) ? <a href={group.bestPost.url} target="_blank" rel="noopener noreferrer">{group.bestPost.title || 'Open post'}<ExternalLink size={12} /></a> : <strong>{group.bestPost.title || 'Saved post'}</strong>}<small>{count(group.bestPost.fixedAgeViews)} day-7 views</small></div>}</article>; })}</div></section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Page health</h2><p>Based on comparable posts and peers on the same platform.</p></div><button className="an-inline-link" onClick={() => chooseSection('performance')}>All performance<ArrowRight size={15} /></button></div><div className="an-health-list">{analysis.pages.slice(0, 8).map(row => <div key={row.page.id}>{pageName(row.page)}<div>{healthBadge(row)}<small>{row.health.reason}</small></div></div>)}</div></section>
      {analysis.comparison && <section className="an-panel"><div className="an-panel-header"><div><h2>Your date comparison</h2><p>{rangeLabel(range)} against {rangeLabel(analysis.comparison.range)}</p></div></div>{comparisonTable(analysis.comparison.metrics)}</section>}
    </>;
  }
  function pagesScreen() {
    if (!analysis) return null;
    return <section className="an-panel"><div className="an-panel-header"><div><h2>Your page master</h2><p>Manage responsibility, monthly pay, and tracking status in one place.</p></div><button className="an-button primary" disabled={demo || busy} onClick={() => openModal({ type: 'add' })}><Plus size={16} />Add page</button></div><div className="an-table-wrap" role="region" aria-label="Page master" tabIndex={0}><table className="an-table"><thead><tr><th>Page</th><th>Responsible person</th><th>Monthly pay</th><th>Tracking</th><th>Start date</th><th>Last updated</th><th>Manage</th></tr></thead><tbody>{pageSlice(analysis.pages, pageIndex).map(row => <tr key={row.page.id}><th scope="row">{pageName(row.page)}<div className="an-mobile-actions"><button className="an-inline-link" disabled={demo || busy} onClick={() => openModal({ type: 'edit', page: row.page })}>Edit details</button></div></th><td>{row.page.editor || 'Not assigned'}</td><td>{money(row.page.monthlyPay)}</td><td><span className={'an-status ' + (row.page.active ? 'good' : 'paused')}>{row.page.active ? 'Active' : 'Paused'}</span>{row.page.syncError && <small className="an-error-text">Needs refresh</small>}</td><td>{date(row.page.startDate)}</td><td>{row.page.lastSyncedAt ? date(row.page.lastSyncedAt, true) : 'Not fetched yet'}{row.page.syncError && <small className="an-error-text">{row.page.syncError}</small>}</td><td><div className="an-row-actions"><button className="an-icon-button" aria-label={'Edit ' + (row.page.name || row.page.handle)} disabled={demo || busy} onClick={() => openModal({ type: 'edit', page: row.page })}><Pencil size={16} /></button><button className="an-icon-button" aria-label={'Refresh ' + (row.page.name || row.page.handle)} disabled={demo || busy} onClick={() => refresh([row.page])}><RefreshCw size={16} /></button>{safeUrl(row.page.url) && <a className="an-icon-button" href={row.page.url} target="_blank" rel="noopener noreferrer" aria-label={'Open ' + row.page.handle + ' on ' + platformNames[row.page.platform]}><ExternalLink size={16} /></a>}<button className="an-icon-button danger" aria-label={'Remove ' + (row.page.name || row.page.handle)} disabled={demo || busy} onClick={() => openModal({ type: 'remove', page: row.page })}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div><Pagination total={analysis.pages.length} current={pageIndex} onChange={setPageIndex} /><p className="an-panel-note">Paused pages keep their history. Monthly pay is prorated from the start date across actual calendar months. Blank pay is unknown; enter 0 for an unpaid page.</p></section>;
  }
  function performance() {
    if (!analysis) return null;
    return <>{analysis.platforms.map(group => <section className="an-panel" key={group.platform}><div className="an-panel-header"><div><h2>{platformNames[group.platform]} performance</h2><p>Ranked within this platform. Scores need at least eight comparable matured posts and sufficient history.</p></div><span className="an-pill">{group.rankings.length} pages</span></div><div className="an-table-wrap" role="region" aria-label={platformNames[group.platform] + ' performance'} tabIndex={0}><table className="an-table"><thead><tr><th>Page</th><th>Health</th><th>{viewLabel}</th><th>Posts</th><th>Day-7 median</th><th>Hit rate</th><th>Engagement</th><th>Shares</th><th>Follower growth</th><th>Posts / day</th><th>Monthly pay</th><th>Cost / 1M views</th></tr></thead><tbody>{group.rankings.map(row => <tr key={row.page.id}><th scope="row">{pageName(row.page)}</th><td>{healthBadge(row)}</td><td>{count(mode === 'gained' ? row.metrics.viewsGained : row.metrics.publishedViews)}{mode === 'gained' && <Coverage value={row.metrics.viewsCoverage} />}</td><td>{count(row.metrics.postsPublished)}</td><td>{count(row.metrics.medianViews)}<small>{count(row.metrics.comparablePosts)} samples</small></td><td>{percent(row.metrics.hitRate)}</td><td>{percent(row.metrics.engagementRate)}</td><td>{count(row.metrics.shares)}</td><td>{count(row.metrics.followerGrowth)}<Coverage value={row.metrics.followerCoverage} /></td><td>{decimal(row.metrics.postsPerDay)}</td><td>{money(row.page.monthlyPay)}</td><td>{money(row.metrics.costPerMillion)}<small>Uses views gained</small></td></tr>)}</tbody></table></div></section>)}</>;
  }
  function economics() {
    if (!analysis || !total) return null;
    return <><div className="an-kpis four"><Kpi label="Pay for selected dates" value={money(total.pay)} note={`${count(total.payKnownPages)} pages have a pay amount`} /><Kpi label="Cost per 1M views" value={money(total.costPerMillion)} featured note="Main cost metric · recorded views gained" /><Kpi label="Cost per post" value={money(total.costPerPost)} note="Prorated pay ÷ posts published" /><Kpi label="Views per ₹1,000" value={count(total.viewsPerThousand)} note="Reference only · inverse of the cost metric" /></div><section className="an-panel"><div className="an-panel-header"><div><h2>What your page pay is buying</h2><p>Amounts are prorated to {rangeLabel(range)}. Views are measured from recorded snapshots.</p></div></div><EconomicsChart pages={analysis.pages} /></section><section className="an-panel"><div className="an-panel-header"><div><h2>Page economics</h2><p>Unknown pay and incomplete history stay clearly labelled.</p></div><button className="an-button" onClick={exportPages}><ArrowDownToLine size={16} />CSV</button></div><div className="an-table-wrap" role="region" aria-label="Page economics" tabIndex={0}><table className="an-table"><thead><tr><th>Page</th><th>Monthly pay</th><th>Pay for range</th><th>Views gained</th><th>Posts</th><th>Cost / post</th><th>Cost / 1M views</th><th>Views / ₹1,000</th></tr></thead><tbody>{analysis.pages.map(row => <tr key={row.page.id}><th scope="row">{pageName(row.page)}</th><td>{money(row.page.monthlyPay)}</td><td>{money(row.metrics.pay)}</td><td>{count(row.metrics.viewsGained)}<Coverage value={row.metrics.viewsCoverage} /></td><td>{count(row.metrics.postsPublished)}</td><td>{money(row.metrics.costPerPost)}</td><td>{money(row.metrics.costPerMillion)}</td><td>{count(row.metrics.viewsPerThousand)}</td></tr>)}</tbody></table></div><p className="an-panel-note">These are page/editor costs that you enter. They do not include data-provider costs. A cost ratio is unavailable when pay or usable view history is missing.</p></section></>;
  }
  function monthly() {
    if (!analysis) return null;
    return <div className="an-print-report"><div className="an-report-title"><span>{PRODUCT_NAME}</span><h2>Distribution performance report</h2><p>{rangeLabel(range)}{comparison ? ' · Compared with ' + rangeLabel(comparison) : ''}</p><small>{platform === 'all' ? 'All platforms · raw totals, with platform-specific rankings' : platformNames[platform]} · Prepared {date(analysis.generatedAt, true)}</small></div><div className="an-report-actions"><button className="an-button" onClick={exportMonthly}><ArrowDownToLine size={16} />Export CSV</button><button className="an-button primary" onClick={() => window.print()}><FileText size={16} />Print / save PDF</button></div>
      {analysis.comparison ? <section className="an-panel"><div className="an-panel-header"><div><h2>Did more pay buy more views?</h2><p className="an-verdict">{analysis.comparison.verdict}</p></div></div>{comparisonTable(analysis.comparison.metrics)}</section> : <div className="an-callout"><CalendarDays size={20} /><p>Turn on Compare dates above to see the change against another period.</p></div>}
      <section className="an-panel"><div className="an-panel-header"><div><h2>Month by month</h2><p>Only the dates inside your selected range count toward each month.</p></div></div><LineChart title="Recorded views gained by month" points={analysis.monthly.map(row => ({ label: row.month, value: row.totals.viewsGained }))} /><div className="an-table-wrap" role="region" aria-label="Monthly totals" tabIndex={0}><table className="an-table"><thead><tr><th>Month</th><th>Pay</th><th>Views gained</th><th>Posts</th><th>Cost / 1M views</th><th>Day-7 median</th><th>Engagement</th><th>Follower growth</th></tr></thead><tbody>{analysis.monthly.map(row => <tr key={row.month}><th scope="row">{row.month}<small>{rangeLabel(row.range)}</small></th><td>{money(row.totals.pay)}</td><td>{count(row.totals.viewsGained)}<Coverage value={row.totals.viewsCoverage} /></td><td>{count(row.totals.postsPublished)}</td><td>{money(row.totals.costPerMillion)}</td><td>{count(row.totals.medianViews)}</td><td>{percent(row.totals.engagementRate)}</td><td>{count(row.totals.followerGrowth)}</td></tr>)}</tbody></table></div></section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Page-by-page monthly detail</h2><p>Each page retains its own history and costs.</p></div></div><div className="an-table-wrap" role="region" aria-label="Monthly page detail" tabIndex={0}><table className="an-table"><thead><tr><th>Month / page</th><th>Platform</th><th>Pay</th><th>Views gained</th><th>Posts</th><th>Cost / 1M views</th><th>Follower growth</th></tr></thead><tbody>{analysis.monthly.flatMap(month => month.pages.map(row => { const page = analysis.pages.find(item => item.page.id === row.pageId)?.page; return page ? <tr key={month.month + row.pageId}><th scope="row"><strong>{page.name || page.handle}</strong><small>{month.month}</small></th><td>{platformNames[page.platform]}</td><td>{money(row.metrics.pay)}</td><td>{count(row.metrics.viewsGained)}<Coverage value={row.metrics.viewsCoverage} /></td><td>{count(row.metrics.postsPublished)}</td><td>{money(row.metrics.costPerMillion)}</td><td>{count(row.metrics.followerGrowth)}</td></tr> : null; }))}</tbody></table></div></section><p className="an-report-footnote">View growth is measured from recorded snapshots. Published-post views are lifetime counts, not views earned during a period. Medians and scores use comparable day-seven samples. A dash means unavailable. Partial history may limit conclusions.</p></div>;
  }
  function alerts() {
    if (!analysis) return null;
    const active = analysis.alerts.filter(item => !item.resolvedAt);
    return <>{!active.length ? <section className="an-panel"><Empty title="No open alerts">Performance alerts appear after a condition is confirmed on two checks. Fresh accounts may still be building enough history.</Empty></section> : (['red', 'amber', 'green'] as const).map(level => {
      const group = active.filter(item => item.level === level); if (!group.length) return null;
      return <section className={'an-alert-group ' + level} key={level}><h2><span />{level === 'red' ? 'Act today' : level === 'amber' ? 'Keep an eye on these' : 'Opportunities'}<small>{group.length}</small></h2>{group.map(alert => { const page = analysis.pages.find(item => item.page.id === alert.pageId)?.page; return <article className="an-alert" key={alert.id}><AlertCircle size={21} /><div><h3>{alert.title}</h3><p>{alert.details}</p><small>{page?.name || page?.handle || 'Page'} · {date(alert.createdAt, true)}</small></div><div className="an-alert-actions"><button className="an-button" onClick={() => openPage(alert.pageId)}>Open page<ArrowRight size={15} /></button>{page && /fetch|private|not.?found|data/i.test(alert.type) && <button className="an-button" disabled={demo || busy} onClick={() => refresh([page])}><RefreshCw size={15} />Retry</button>}<button className="an-inline-link" disabled={demo || busy} onClick={() => resolveAlert(alert.id)}><Check size={15} />Resolve</button></div></article>; })}</section>;
    })}<p className="an-help-note">Performance alerts use matured posts and are checked for persistence. Data-health alerts describe fetch problems. Resolving an alert does not change a page’s saved metrics.</p></>;
  }
  function detailScreen(row: PageAnalysis) {
    const comparisonMetrics = analysis?.comparison?.pages.find(item => item.pageId === row.page.id)?.metrics;
    return <><section className="an-page-hero"><div><span className="an-platform-label">{platformNames[row.page.platform]} · @{row.page.handle}</span><h2>{row.page.name || row.page.handle}</h2><p>{row.page.editor ? 'Responsible person: ' + row.page.editor : 'No responsible person assigned'} · {money(row.page.monthlyPay)} / month · {row.page.active ? 'Active' : 'Paused'}</p><small>Last updated {row.page.lastSyncedAt ? date(row.page.lastSyncedAt, true) : 'not yet'}</small></div><div className="an-page-hero-actions"><button className="an-button" disabled={demo || busy} onClick={() => openModal({ type: 'edit', page: row.page })}><Pencil size={15} />Edit details</button><button className="an-button primary" disabled={demo || busy} onClick={() => refresh([row.page])}><RefreshCw size={15} />Refresh</button>{safeUrl(row.page.url) && <a className="an-button" href={row.page.url} target="_blank" rel="noopener noreferrer">Public page<ExternalLink size={15} /></a>}</div></section>{row.page.syncError && <div className="an-error" role="alert"><AlertCircle size={19} /><div><strong>The last refresh needs attention</strong><p>{row.page.syncError}</p></div></div>}
      <div className="an-kpis four"><Kpi label={viewLabel} value={count(mode === 'gained' ? row.metrics.viewsGained : row.metrics.publishedViews)} featured coverage={mode === 'gained' ? row.metrics.viewsCoverage : undefined} change={mode === 'gained' ? comparisonMetrics?.viewsGained : undefined} /><Kpi label="Follower growth" value={count(row.metrics.followerGrowth)} coverage={row.metrics.followerCoverage} note={`${count(row.metrics.followers)} latest followers`} /><Kpi label="Typical day-7 views" value={count(row.metrics.medianViews)} note={`${count(row.metrics.comparablePosts)} comparable posts`} /><Kpi label="Consistency spread" value={decimal(row.metrics.iqrSpread)} note="Interquartile range ÷ median · lower is steadier" /></div>
      <div className="an-two-column"><section className="an-panel"><div className="an-panel-header"><h2>Followers over time</h2></div><LineChart title="Recorded followers over time" points={row.timeline.map(point => ({ label: shortDate(point.date), value: point.followers }))} /></section><section className="an-panel"><div className="an-panel-header"><h2>{viewLabel} over time</h2></div><LineChart title={viewLabel + ' over time'} points={row.timeline.map(point => ({ label: shortDate(point.date), value: mode === 'gained' ? point.viewsGained : point.publishedViews ?? null }))} /></section></div>
      <section className="an-panel"><div className="an-panel-header"><div><h2>How consistent are the posts?</h2><p>Every comparable post is measured near day seven.</p></div></div><ConsistencyChart analysis={row} /></section>
      <section className="an-panel"><div className="an-panel-header"><div><h2>Health score breakdown</h2><p>{row.health.reason || 'Percentile comparisons within your pages on ' + platformNames[row.page.platform] + '.'}</p></div>{healthBadge(row)}</div><div className="an-score-grid">{row.health.components.map(component => <article key={component.key}><div><strong>{component.label}</strong><span>{percent(component.weight > 1 ? component.weight / 100 : component.weight)} weight</span></div><progress value={component.percentile ?? 0} max={100} aria-label={component.label + ' percentile'} /><p>{component.percentile == null ? 'More history needed' : `Percentile ${decimal(component.percentile, 1)} · ${decimal(component.points, 1)} points`}</p></article>)}</div><p className="an-panel-note">At least eight comparable matured posts are required. Missing components stay unavailable instead of creating an artificial score.</p></section>
      {row.page.notes && <section className="an-panel an-notes"><h2>Page notes</h2><p>{row.page.notes}</p></section>}{comparisonMetrics && <section className="an-panel"><div className="an-panel-header"><h2>This page: period comparison</h2></div>{comparisonTable(comparisonMetrics)}</section>}{postTable()}</>;
  }
  let detected: ReturnType<typeof parsePage> | null = null;
  if (modal?.type === 'add' && form.input.trim()) { try { detected = parsePage(form.input, form.platform); } catch { /* The server returns a clear validation error on submit. */ } }

  return <div className={'an-app' + (demo ? ' an-demo' : '')}>
    <aside className="an-sidebar"><a className="an-brand" href={demo ? '/demo' : '/dashboard'}><span><Layers3 size={23} /></span><strong>{PRODUCT_NAME}<i>.</i></strong></a><div className="an-workspace"><span>{initials(account.name || account.email)}</span><div><strong>{demo ? 'Sample workspace' : account.name || 'My workspace'}</strong><small>{demo ? 'Explore with sample data' : account.email}</small></div></div><nav aria-label="Workspace sections">{sections.map((item, index) => <button key={item.id} className={section === item.id && !selectedPage ? 'active' : ''} aria-current={section === item.id && !selectedPage ? 'page' : undefined} onClick={() => chooseSection(item.id)}><small>{String(index + 1).padStart(2, '0')}</small><item.icon size={18} /><span>{item.label}</span></button>)}</nav><div className="an-sidebar-bottom"><a href={demo ? '/login' : '/collections'}><FolderOpen size={17} />{demo ? 'Open your workspace' : 'Collections & backups'}</a>{!demo && account.userType === 'admin' && <a href="/admin"><ShieldCheck size={17} />Admin directory</a>}{!demo && <SignOutButton className="an-signout"><LogOut size={17} />Sign out</SignOutButton>}<p>Public page data.<br />Your own workspace.</p></div></aside>
    <main className="an-main"><header className="an-topbar"><div><span>Workspace</span><ChevronRight size={14} /><strong>{title}</strong></div><a href={demo ? '/login' : '/collections'}><ArrowDownToLine size={15} />{demo ? 'Sign in' : 'Import / export'}</a></header>
      <div className="an-content">{demo && <div className="an-demo-banner"><span><strong>Demo workspace</strong> · These are sample records. Your real account is unchanged.</span><a href="/login">Create your workspace<ArrowRight size={15} /></a></div>}
        <div className="an-heading"><div>{selectedPage && <button className="an-back" onClick={() => setSelectedPage(null)}><ArrowLeft size={15} />Back to {sections.find(item => item.id === section)?.label.toLowerCase()}</button>}<span className="an-eyebrow">YOUR DISTRIBUTION, CLEARLY</span><h1>{title}<span>.</span></h1><p>{detail ? 'Understand this page’s history, typical performance, and cost.' : section === 'overview' ? 'See what changed, what worked, and where to act next.' : section === 'pages' ? 'Keep every page, person, and page cost organised.' : section === 'performance' ? 'Compare like with like, on the same platform.' : section === 'posts' ? 'Find the posts behind your pages’ performance.' : section === 'economics' ? 'Connect page pay to the results you have actually recorded.' : section === 'monthly' ? 'A clear record of performance and page costs.' : 'Act on persistent changes, with the context behind each alert.'}</p></div><div className="an-heading-actions">{updating && <span className="an-updating" role="status"><Loader2 size={15} className="spin" />Updating…</span>}<button className="an-button" onClick={exportVisibleSection} disabled={!analysis}><ArrowDownToLine size={16} />Export CSV</button><button className="an-button primary" disabled={demo || busy || !analysis?.pages.some(row => row.page.active)} onClick={() => refresh(detail ? [detail.page] : analysis!.pages.filter(row => row.page.active).map(row => row.page))}><RefreshCw size={16} className={refreshProgress ? 'spin' : ''} />{refreshProgress ? `Refreshing ${refreshProgress.current}/${refreshProgress.total}` : 'Refresh pages'}</button></div></div>
        <section className="an-filters" aria-label="Analysis filters"><div className="an-filter-row"><label className="an-period"><CalendarDays size={17} /><span className="sr-only">Date preset</span><select aria-label="Date preset" value={preset} onChange={event => choosePreset(event.target.value)}>{presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="custom">Custom dates</option></select></label><label>Platform<select value={platform} onChange={event => { setPlatform(event.target.value as AnalyticsPlatform | 'all'); setSelectedPage(null); }}><option value="all">All platforms</option>{platforms.map(item => <option key={item} value={item}>{platformNames[item]}</option>)}</select></label>{dataset?.collections?.length ? <label>Collection<select value={collectionId} onChange={event => { setCollectionId(event.target.value); setSelectedPage(null); }}><option value="">All collections</option>{dataset.collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}<label className="an-search"><Search size={17} /><input aria-label="Filter pages by name, handle, or responsible person" placeholder="Find a page or person" value={search} onChange={event => { setSearch(event.target.value); setSelectedPage(null); }} /><button type="button" aria-label="Clear page filter" onClick={() => setSearch('')} hidden={!search}><X size={14} /></button></label><label className="an-check"><input type="checkbox" checked={!!comparison} onChange={event => { const prior = previousRange(range); setComparison(event.target.checked ? prior : null); setCompareDraft(prior); }} />Compare dates</label></div>
          {preset !== 'custom' && !comparison ? <p className="an-range-summary"><span>{rangeLabel(range)}</span><small>India time · both dates included</small></p> : <form className="an-dates" onSubmit={applyDates}><label>From<input aria-label="Range start" type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} required /></label><span>to</span><label>To<input aria-label="Range end" type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} required /></label>{comparison && <><span className="an-vs">compared with</span><label>Compare from<input aria-label="Comparison start" type="date" value={compareDraft.from} onChange={event => setCompareDraft({ ...compareDraft, from: event.target.value })} required /></label><label>Compare to<input aria-label="Comparison end" type="date" value={compareDraft.to} onChange={event => setCompareDraft({ ...compareDraft, to: event.target.value })} required /></label></>}<button className="an-button" type="submit">Apply dates</button><small>India time · both dates included</small></form>}{rangeError && <p className="an-error-text" role="alert">{rangeError}</p>}
          <div className="an-view-mode"><div role="group" aria-label="View measurement"><button className={mode === 'gained' ? 'active' : ''} aria-pressed={mode === 'gained'} onClick={() => setMode('gained')}>Views gained during range</button><button className={mode === 'published' ? 'active' : ''} aria-pressed={mode === 'published'} onClick={() => setMode('published')}>Views on posts published in range</button></div><p>{mode === 'gained' ? 'Measured from snapshots. History starts when tracking begins.' : 'Latest saved lifetime views of those posts. This is not views earned during the selected dates.'}</p></div>
        </section>
        {refreshProgress && <div className="an-progress" role="status"><Loader2 size={18} className="spin" /><span>Refreshing page {refreshProgress.current} of {refreshProgress.total}. You can stop after the current page.</span><button className="an-button" onClick={() => { stopRefresh.current = true; }}>Stop after this page</button></div>}
        {notice && <div className="an-notice" role="status"><Check size={18} /><span>{notice}</span><button aria-label="Dismiss update" onClick={() => setNotice('')}><X size={15} /></button></div>}{actionError && <div className="an-error" role="alert"><AlertCircle size={19} /><p>{actionError}</p><button aria-label="Dismiss error" onClick={() => setActionError('')}><X size={15} /></button></div>}
        {loading ? <div className="an-loading" role="status"><Loader2 size={26} className="spin" /><strong>Loading your page history</strong><p>Bringing together your pages, snapshots, and alerts.</p></div> : error || calculation.error ? <div className="an-error an-load-error" role="alert"><AlertCircle size={25} /><div><h2>Your data could not be loaded</h2><p>{error || calculation.error}</p><button className="an-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />Try again</button><a className="an-inline-link" href="/collections">Open collections & backups<ArrowRight size={14} /></a></div></div> : analysis && <>
          {analysis.warnings.length > 0 && <details className="an-history-note"><summary><CircleHelp size={17} /><span>About the history in this view</span><span>{analysis.warnings.length}</span></summary><ul>{analysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          {!dataset?.pages.length ? <section className="an-panel"><Empty title="Start with your first public page" action={<div className="an-empty-actions"><button className="an-button primary" disabled={demo || busy} onClick={() => openModal({ type: 'add' })}><Plus size={16} />Add a page</button><a className="an-button" href="/collections">Import a workspace</a></div>}>Paste an Instagram, YouTube, or TikTok profile. You do not need to connect or sign in to the social account. Growth history builds from the first successful fetch.</Empty></section> : !analysis.pages.length ? <section className="an-panel"><Empty title="No pages match these filters" action={<button className="an-button" onClick={() => { setSearch(''); setPlatform('all'); setCollectionId(''); }}>Clear filters</button>}>Try another page name, platform, or collection.</Empty></section> : selectedPage && !detail ? <section className="an-panel"><Empty title="This page is no longer in this view" action={<button className="an-button" onClick={() => setSelectedPage(null)}>Back to pages</button>}>It may have been removed or excluded by the current filters.</Empty></section> : detail ? detailScreen(detail) : section === 'overview' ? overview() : section === 'pages' ? pagesScreen() : section === 'performance' ? performance() : section === 'posts' ? postTable() : section === 'economics' ? economics() : section === 'monthly' ? monthly() : alerts()}
        </>}
        <footer className="an-footer"><strong>{PRODUCT_NAME}<span>.</span></strong><p>{dataset ? 'Data loaded ' + date(dataset.generatedAt, true) : 'Your private workspace'} · Missing metrics stay unavailable.</p></footer>
      </div>
    </main>
    {modal && <WorkspaceDialog title={modal.type === 'add' ? 'Add a public page' : modal.type === 'edit' ? 'Edit page details' : 'Remove this page?'} onClose={() => setModal(null)} busy={saving} wide={modal.type !== 'remove'}><form className="an-page-form" onSubmit={submitPage}>{modal.type === 'remove' ? <><p><strong>{modal.page.name || modal.page.handle}</strong> will be removed from all your collections, together with its saved tracking history.</p><p className="an-form-hint">Export a workspace backup first if you may want this history later. This only changes your workspace.</p><a className="an-inline-link" href="/collections">Open workspace backups<ArrowUpRight size={14} /></a></> : <>{modal.type === 'add' && <><p className="an-form-hint">Add a public profile. We will fetch available data and start recording its history.</p><label>Profile URL or handle<input data-autofocus required maxLength={300} placeholder="instagram.com/yourpage or @yourpage" value={form.input} onChange={event => setForm({ ...form, input: event.target.value })} /></label><label>Platform for a plain handle<select value={form.platform} onChange={event => setForm({ ...form, platform: event.target.value as AnalyticsPlatform })}>{platforms.map(item => <option key={item} value={item}>{platformNames[item]}</option>)}</select></label>{detected && <div className="an-profile-preview"><Check size={18} /><div><strong>{platformNames[detected.platform]} · @{detected.handle}</strong><a href={detected.url} target="_blank" rel="noopener noreferrer">Check public profile<ExternalLink size={13} /></a><small>Profile details will be confirmed during the first fetch.</small></div></div>}</>}
      <div className="an-form-grid"><label>Monthly pay (₹)<input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Leave blank if unknown" value={form.monthlyPay} onChange={event => setForm({ ...form, monthlyPay: event.target.value })} /></label><label>Responsible person / editor<input maxLength={150} placeholder="Name of the person managing it" value={form.editor} onChange={event => setForm({ ...form, editor: event.target.value })} /></label><label>Pay / tracking start date<input type="date" value={form.startDate} onChange={event => setForm({ ...form, startDate: event.target.value })} /></label><label className="an-check"><input type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} />Actively track this page</label></div><label>Notes<textarea rows={3} maxLength={2000} placeholder="Anything useful to remember about this page" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label><p className="an-form-hint">Pay is a reporting field, not a payment. Pausing tracking keeps your saved history.</p></>}{modalError && <p className="an-error-text" role="alert">{modalError}</p>}<div className="an-dialog-actions"><button type="button" className="an-button" disabled={saving} onClick={() => setModal(null)}>Cancel</button><button className={'an-button ' + (modal.type === 'remove' ? 'danger' : 'primary')} type="submit" disabled={saving || demo}>{saving ? <Loader2 size={16} className="spin" /> : modal.type === 'remove' ? <Trash2 size={16} /> : <Check size={16} />}{saving ? 'Saving…' : modal.type === 'add' ? 'Add and fetch page' : modal.type === 'edit' ? 'Save details' : 'Remove page'}</button></div></form></WorkspaceDialog>}
  </div>;
}
