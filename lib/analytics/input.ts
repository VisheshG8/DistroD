import { parsePage, type Platform } from '../pages';
import { scopeFromDates } from '../scope';
import type { DateRange } from './types';

export function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Choose a valid record.');
  return value;
}
export function validRange(from: unknown, to: unknown): DateRange {
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('Choose a start and end date.');
  scopeFromDates(from, to);
  return {from, to};
}
function text(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return value.trim();
}
export function pageMetadata(value: Record<string, unknown>) {
  const raw = value.monthlyPay;
  const monthlyPay = raw === null || raw === undefined || raw === '' ? null : typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d{1,2})?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (monthlyPay !== null && (!Number.isFinite(monthlyPay) || monthlyPay < 0 || monthlyPay > 999999999999.99 || Math.round(monthlyPay * 100) / 100 !== monthlyPay)) throw new Error('Enter a non-negative monthly pay with up to two decimal places.');
  const startDate = value.startDate === '' || value.startDate == null ? null : validRange(value.startDate, value.startDate).from;
  if (value.active !== undefined && typeof value.active !== 'boolean') throw new Error('Choose active or inactive.');
  const metadata: {monthly_pay: number | null; editor: string; start_date: string | null; active: boolean; notes: string; display_name?: string; alert_quiet_days?: number | null; end_date?: string | null} =
    {monthly_pay: monthlyPay, editor: text(value.editor, 150, 'Editor'), start_date: startDate, active: value.active ?? true, notes: text(value.notes, 2000, 'Notes')};
  // Newer Page Master fields change only when sent, so an older form never clears them.
  if ('displayName' in value) metadata.display_name = text(value.displayName, 150, 'Page name');
  if ('alertQuietDays' in value) metadata.alert_quiet_days = quietDays(value.alertQuietDays);
  if ('endDate' in value) {
    metadata.end_date = value.endDate === '' || value.endDate == null ? null : validRange(value.endDate, value.endDate).from;
    if (metadata.end_date && startDate && metadata.end_date < startDate) throw new Error('The pay end date must be on or after the start date.');
  }
  return metadata;
}
function quietDays(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const days = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,2}$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('Choose a quiet-day alert from 1 to 60 days.');
  return days;
}
export function activeInput(value: Record<string, unknown>) {
  if (typeof value.active !== 'boolean') throw new Error('Choose active or inactive.');
  return {pageId: validId(value.pageId), active: value.active};
}
export type ContentLinkMode = 'group' | 'solo' | 'unlink';
/** group links posts as one piece of content, solo marks them unique (never suggested again), unlink undoes either. */
export function contentLink(value: Record<string, unknown>) {
  const mode = value.mode;
  if (mode !== 'group' && mode !== 'solo' && mode !== 'unlink') throw new Error('Choose how to link these posts.');
  if (!Array.isArray(value.posts) || value.posts.length < 1 || value.posts.length > 50) throw new Error('Choose between 1 and 50 posts.');
  const posts = value.posts.map(item => {
    const post = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (typeof post.postId !== 'string' || post.postId.length < 1 || post.postId.length > 300) throw new Error('Choose valid posts.');
    return {pageId: validId(post.pageId).toLowerCase(), postId: post.postId};
  });
  if (new Set(posts.map(post => JSON.stringify([post.pageId, post.postId]))).size !== posts.length) throw new Error('Choose each post only once.');
  const groupId = value.groupId === undefined || value.groupId === null || value.groupId === '' ? null : value.groupId;
  if (groupId !== null && (mode !== 'group' || typeof groupId !== 'string' || !/^ca_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(groupId))) throw new Error('Choose a valid content group.');
  return {posts, mode: mode as ContentLinkMode, groupId: groupId as string | null};
}
export function pageInput(value: Record<string, unknown>) {
  if (typeof value.input !== 'string') throw new Error('Paste a public profile handle or URL.');
  const platform = value.platform === undefined ? 'instagram' : value.platform;
  if (!['instagram','youtube','tiktok'].includes(String(platform))) throw new Error('Choose a supported platform.');
  return parsePage(value.input, platform as Platform);
}
