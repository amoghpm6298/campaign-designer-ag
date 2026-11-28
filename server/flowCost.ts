// What a flow costs a MONTH. A campaign is costed once, on everyone in it. A
// flow keeps going: everyone already eligible joins when it goes live, then new
// people join every week. So:
//   cost per person     = the cost model's estimate ÷ people in target today;
//   joiners per month   = the average weekly inflow over the last 90 days × 4.33
//                         (the same replay as the entry card's 90-day line, server/trend.ts);
//   a month             = cost per person × joiners per month (estimate and max alike);
//   the first month     = everyone already eligible (today's total) + that month's joiners.
// When a bucket can't be replayed for past weeks, the inflow is partial and says so.
import { loadStores } from './campaignFiles';
import { cohortTrend } from './trend';
import { bucketContext } from '../src/designer/v2/contextView';
import { kindOf } from '../src/designer/v2/kind';

export interface FlowMonthly {
  expected: number;
  max: number;
  joinersPerMonth: number;
  /** Everyone already eligible joins at launch: the first month costs today's total plus that month's joiners. */
  firstMonth: { expected: number; max: number };
  /** Buckets whose joiners could not be replayed (counted as today's). */
  partial: string[];
}

export function flowMonthly(sessionId: string, tenantId: string, report: { mode?: string; total?: { expected: number; max: number } }): FlowMonthly | null {
  const st = loadStores(sessionId);
  if (!st.campaign || kindOf(st.campaign) !== 'flow' || report.mode !== 'totals' || !report.total) return null;
  const target = bucketContext(st.context?.entries ?? [])['__target']?.size;
  if (typeof target !== 'number' || target <= 0) return null;
  const trend = cohortTrend(sessionId, tenantId);
  if ('error' in trend || trend.measure !== 'inflow' || !trend.points.length) return null;
  // No bucket can be replayed for past weeks: there is no honest monthly inflow, so no monthly figure.
  if (trend.partial.length >= st.campaign.buckets.length) return null;
  const weekly = trend.points.reduce((n, p) => n + p.count, 0) / trend.points.length;
  const joinersPerMonth = Math.round(weekly * 4.33);
  const share = joinersPerMonth / target;
  const expected = Math.round(report.total.expected * share);
  const max = Math.round(report.total.max * share);
  return { expected, max, joinersPerMonth, firstMonth: { expected: Math.round(report.total.expected) + expected, max: Math.round(report.total.max) + max }, partial: trend.partial };
}
