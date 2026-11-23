// Checks on the designer's funnel estimates (journeySchema `funnel`): every
// message says how many of the people who arrive open it and convert, so the
// app can work the funnel out top-down (server/costModel.ts).
//
// Only that the estimates are there and well-formed. Whether a rate is right
// is the designer's judgement (a later message can convert better than an
// earlier one: it depends on the message), shown step by step in the funnel
// for the manager to read and change.
import type { CampaignObject } from './types';
import type { BpStep } from '../blueprint';
import { NO_READS } from '../costModel';

type Rec = Record<string, unknown>;
const RATE = (v: unknown): v is { rate: number; why: string } => {
  const r = v as { rate?: unknown; why?: unknown };
  return !!r && typeof r.rate === 'number' && r.rate >= 0 && r.rate <= 1 && typeof r.why === 'string' && !!r.why.trim();
};

export function funnelProblems(campaign: CampaignObject): string[] {
  const problems: string[] = [];
  const lanes = [
    ...campaign.buckets.map((b) => ({ name: `Bucket "${b.name}"`, journey: b.journey })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ name: 'Everyone else', journey: campaign.everyoneElse.journey }] : []),
  ];
  const walk = (list: BpStep[] | null | undefined, lane: string) => {
    for (const st of (list ?? []) as unknown as Rec[]) {
      const at = `${lane} › "${String(st.name ?? st.label ?? 'a message')}"`;
      const f = (st.funnel ?? {}) as { opens?: unknown; converts?: unknown };
      if (st.kind === 'send') {
        const sms = NO_READS.has(String(((st.channelPreference as string[] | undefined) ?? [])[0] ?? 'SMS'));
        const missing = [!sms && !RATE(f.opens) ? 'opens' : null, !RATE(f.converts) ? 'converts' : null].filter(Boolean);
        if (missing.length)
          problems.push(`${at}: give funnel ${missing.join(' and ')} ({rate: 0-1, why}) for the people who arrive at this message${sms ? ' (SMS: converts only)' : ''}, so the funnel and the cost can be worked out.`);
      }
      if (st.kind === 'waitForEvent' && !RATE(f.converts)) problems.push(`${at}: give funnel converts ({rate: 0-1, why}): the share of the people who arrive here who do the event in the window.`);
      for (const k of ['yes', 'no', 'otherwise']) if (Array.isArray(st[k])) walk(st[k] as BpStep[], lane);
      for (const k of ['paths', 'arms']) if (Array.isArray(st[k])) for (const p of st[k] as { steps?: BpStep[] }[]) walk(p.steps, lane);
    }
  };
  for (const l of lanes) walk(l.journey as BpStep[] | null | undefined, l.name);
  return problems;
}
