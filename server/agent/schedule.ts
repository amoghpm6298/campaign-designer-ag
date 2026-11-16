// A campaign's dates: when it starts and when it ends. Every campaign has an
// end date; a recurring one can simply use a far-off one.
// Part of the campaign object (what executes). Same names as the bank's own
// campaign builder (DripCampaign.startDate / endDate). Dates are calendar days,
// YYYY-MM-DD, in India time.
import type { BpStep } from '../blueprint';

export interface Schedule {
  startDate: string;
  endDate: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in India, YYYY-MM-DD. */
export const todayIST = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const realDay = (s: string) => {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** "20 Nov 2026 → 6 Dec 2026". */
export function scheduleText(s: Schedule | null | undefined): string {
  if (!s) return 'dates not set';
  const f = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${f(s.startDate)} → ${f(s.endDate)}`;
}

/**
 * Checks a schedule. Refuses a date that is not a real YYYY-MM-DD day, a start
 * before today (today or any future date is fine), a missing end date, and an
 * end on or before the start.
 */
export function parseSchedule(input: unknown, now = new Date()): { value: Schedule } | { error: string } {
  const o = (input ?? {}) as { startDate?: unknown; endDate?: unknown };
  const start = typeof o.startDate === 'string' ? o.startDate.trim() : '';
  const end = typeof o.endDate === 'string' ? o.endDate.trim() : '';
  const today = todayIST(now);
  if (!realDay(start)) return { error: `startDate must be a real date written YYYY-MM-DD (today is ${today}). Nothing was changed.` };
  if (!end) return { error: 'endDate is required for every campaign; a recurring campaign can use a far-off end date. Nothing was changed.' };
  if (!realDay(end)) return { error: 'endDate must be a real date written YYYY-MM-DD. Nothing was changed.' };
  if (start < today) return { error: `startDate ${start} is in the past (today is ${today}). A campaign can start today or on any later date. Nothing was changed.` };
  if (end <= start) return { error: `endDate ${end} must be after startDate ${start}. Nothing was changed.` };
  return { value: { startDate: start, endDate: end } };
}

/** The longest a customer can spend on a journey, in hours: the waits (and wait-for-event timeouts) along its slowest path. */
export function longestPathHours(steps: BpStep[] | null | undefined): number {
  let total = 0;
  for (const raw of (steps ?? []) as unknown as Record<string, unknown>[]) {
    if (raw.kind === 'wait') total += Number(raw.durationHours) || 0;
    if (raw.kind === 'waitForEvent') total += (Number(raw.timeoutDays) || 0) * 24;
    if (raw.kind === 'send') total += (Number(raw.delayDays) || 0) * 24;
    const forks = [
      ...((raw.arms as { steps?: BpStep[] }[] | undefined) ?? []).map((a) => a.steps),
      ...((raw.paths as { steps?: BpStep[] }[] | undefined) ?? []).map((p) => p.steps),
      raw.otherwise as BpStep[] | undefined,
      raw.yes as BpStep[] | undefined,
      raw.no as BpStep[] | undefined,
    ].filter(Boolean) as BpStep[][];
    if (forks.length) total += Math.max(0, ...forks.map((f) => longestPathHours(f)));
  }
  return total;
}
