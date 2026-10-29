import { scopeFromDates } from '../scope';
import type { AnalyticsDataset, DateRange } from './types';

/** Keep in step with `bounds()` in ./server.ts: observations load from 100 days before the earliest selected day. */
const LOOKBACK_MS = 100 * 86400000;
/** A loaded history is reused for narrower ranges only while it is reasonably fresh. */
export const HISTORY_REUSE_MS = 5 * 60000;

export function historyStart(range: DateRange, comparison: DateRange | null): number {
  const start = Date.parse(scopeFromDates(range.from, range.to).from!);
  const compareStart = comparison ? Date.parse(scopeFromDates(comparison.from, comparison.to).from!) : Infinity;
  return Math.min(start, compareStart) - LOOKBACK_MS;
}

/**
 * Returns the dataset the server would have sent for a later history start.
 * Posts, pages, alerts and memberships do not depend on the range; only observations are windowed.
 */
export function narrowHistory<T extends AnalyticsDataset>(dataset: T, loadedStart: number, start: number): T {
  if (start <= loadedStart) return dataset;
  const keep = (item: { observedAt: string }) => Date.parse(item.observedAt) >= start;
  return { ...dataset, accountSnapshots: dataset.accountSnapshots.filter(keep), postSnapshots: dataset.postSnapshots.filter(keep) };
}
