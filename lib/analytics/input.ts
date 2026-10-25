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
  return {monthly_pay: monthlyPay, editor: text(value.editor, 150, 'Editor'), start_date: startDate, active: value.active ?? true, notes: text(value.notes, 2000, 'Notes')};
}
export function pageInput(value: Record<string, unknown>) {
  if (typeof value.input !== 'string') throw new Error('Paste a public profile handle or URL.');
  const platform = value.platform === undefined ? 'instagram' : value.platform;
  if (!['instagram','youtube','tiktok'].includes(String(platform))) throw new Error('Choose a supported platform.');
  return parsePage(value.input, platform as Platform);
}
