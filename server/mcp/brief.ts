// A campaign brief in words, for a caller's agent that cannot see the canvas:
// what the campaign is, who it is for, the buckets (who and why), and each
// bucket's journey in one or two plain sentences. Built from the campaign
// object and its context: nothing here is invented.
import type { BpStep } from '../blueprint';
import type { CampaignContext, CampaignObject } from '../agent/types';
import { bucketContext, currentEntries, noteText } from '../../src/designer/v2/contextView';
import { costLine, type CostReport } from '../costModel';

const CHANNEL: Record<string, string> = { WHATSAPP: 'WhatsApp', SMS: 'SMS', EMAIL: 'email', RCS: 'RCS', PUSH: 'push' };
const OUTCOME: Record<string, string> = { no_response: "didn't respond", not_reachable: "couldn't be reached", declined: 'said no' };
type Step = Record<string, unknown>;

/** A fork in words: its label, or what its paths are. */
const forkName = (s: Step): string => {
  if (typeof s.label === 'string' && s.label.trim()) return `"${s.label.trim()}"`;
  const names = [
    ...((s.paths as { label?: string }[] | undefined) ?? []).map((p) => p.label),
    ...((s.arms as { label?: string; pct?: number }[] | undefined) ?? []).map((a) => `${a.label ?? ''}${typeof a.pct === 'number' ? ` ${a.pct}%` : ''}`),
    ...(s.otherwise ? ['anything else'] : []),
  ].filter(Boolean);
  return names.length ? names.join(' / ') : 'a check';
};

const days = (hours: number) => {
  const d = Math.round((hours / 24) * 10) / 10;
  return d === 1 ? '1 day' : `${d} days`;
};

/** Every message, wait and ending on a journey, including its forks. */
function walk(steps: BpStep[] | null | undefined, acc: { sends: Step[]; waits: number[]; forks: string[]; endings: Set<string>; tests: Step[] }) {
  for (const raw of (steps ?? []) as unknown as Step[]) {
    const k = raw.kind;
    if (k === 'send') acc.sends.push(raw);
    else if (k === 'wait') acc.waits.push(Number(raw.durationHours) || 0);
    else if (k === 'exit' && typeof raw.outcome === 'string') acc.endings.add(OUTCOME[raw.outcome] ?? raw.outcome);
    if (k === 'branch' || k === 'condition') acc.forks.push(forkName(raw));
    if (k === 'experiment') acc.tests.push(raw);
    for (const a of (raw.arms as { steps?: BpStep[] }[] | undefined) ?? []) walk(a.steps, acc);
    for (const p of (raw.paths as { steps?: BpStep[] }[] | undefined) ?? []) walk(p.steps, acc);
    walk(raw.otherwise as BpStep[] | undefined, acc);
    walk(raw.yes as BpStep[] | undefined, acc);
    walk(raw.no as BpStep[] | undefined, acc);
  }
}

/** The main line of a journey in words, following the first path at each fork, e.g. "SMS → wait 2 days → check the goal → split (Read / …) → [Read] WhatsApp …". */
function mainLine(steps: BpStep[] | null | undefined): string {
  const out: string[] = [];
  const go = (list: BpStep[] | null | undefined) => {
    for (const s of (list ?? []) as unknown as Step[]) {
      if (s.kind === 'send') out.push(`${CHANNEL[(s.channelPreference as string[] | undefined)?.[0] ?? ''] ?? 'message'} "${String(s.name ?? '')}"`);
      else if (s.kind === 'wait') out.push(`wait ${days(Number(s.durationHours) || 0)}`);
      else if (s.kind === 'goalCheck') out.push('check the goal');
      else if (s.kind === 'exit') out.push(`end (${OUTCOME[String(s.outcome)] ?? 'end'})`);
      else if (s.kind === 'branch' || s.kind === 'condition' || s.kind === 'experiment') {
        out.push(`${s.kind === 'experiment' ? 'A/B test' : 'split'} (${forkName(s)})`);
        const first = ((s.paths ?? s.arms) as { label?: string; steps?: BpStep[] }[] | undefined)?.[0] ?? (s.yes ? { label: 'yes', steps: s.yes as BpStep[] } : undefined);
        if (first) {
          out.push(`[${first.label ?? 'first path'}]`);
          go(first.steps);
        }
        return; // what follows a fork continues on each path
      }
    }
  };
  go(steps);
  return out.join(' → ').replace(/ → \[/g, ' → [').replace(/\] → /g, '] ');
}

/** An A/B test for a reader: its arms, what it is trying to learn and how the winner is judged. */
export interface TestInWords {
  name: string;
  arms: string[];
  hypothesis: string | null;
  successMetric: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function journeyInWords(steps: BpStep[] | null | undefined): { messages: number; channels: string[]; inWords: string; firstPath: string; tests: TestInWords[] } {
  const acc = { sends: [] as Step[], waits: [] as number[], forks: [] as string[], endings: new Set<string>(), tests: [] as Step[] };
  walk(steps, acc);
  const channels = [...new Set(acc.sends.map((s) => CHANNEL[(s.channelPreference as string[] | undefined)?.[0] ?? ''] ?? 'message'))];
  const parts = [
    `${acc.sends.length} message${acc.sends.length === 1 ? '' : 's'}${channels.length ? ` (${channels.join(', ')})` : ''} across its paths`,
    acc.forks.length ? `splits ${acc.forks.length === 1 ? 'once' : `${acc.forks.length} times`} on what customers did (e.g. ${acc.forks[0]})` : 'one straight path',
    acc.tests.length ? `${acc.tests.length} A/B test${acc.tests.length === 1 ? '' : 's'}` : '',
    acc.endings.size ? `customers who don't convert end as: ${[...acc.endings].join(', ')}` : '',
  ].filter(Boolean);
  const tests = acc.tests.map((t) => ({
    name: str(t.name) ?? str(t.label) ?? 'A/B test',
    arms: ((t.arms as { label?: string; pct?: number }[] | undefined) ?? []).map((a) => `${a.label ?? 'arm'}${typeof a.pct === 'number' ? ` ${a.pct}%` : ''}`),
    hypothesis: str(t.hypothesis),
    successMetric: str(t.successMetric),
  }));
  return { messages: acc.sends.length, channels, inWords: `${parts.join('; ')}.`, firstPath: mainLine(steps), tests };
}

const membershipText = (c: CampaignObject) =>
  !c.membership ? 'not decided' : c.membership.type === 'open' ? `recurring: new customers who match join ${c.membership.refresh ?? 'weekly'}` : 'one-time: the list is fixed at launch';

export function campaignBrief(c: CampaignObject, context: CampaignContext | null, cost?: CostReport | null) {
  const entries = context?.entries ?? [];
  const views = bucketContext(entries);
  const buckets = [...c.buckets].sort((a, b) => a.priority - b.priority);
  const journeys = buckets.map((b) => journeyInWords(b.journey));
  const totalMessages = journeys.reduce((n, j) => n + j.messages, 0);
  const ee = c.everyoneElse;
  return {
    name: c.name ?? null,
    // Written by the campaign's own agent after every build; the description if it has not written one yet.
    summary: noteText(entries, 'campaign brief') ?? c.description ?? null,
    goal: c.goal ? `${c.goal.eventType} (${c.goal.eventCategory})` : null,
    startDate: c.schedule?.startDate ?? null,
    endDate: c.schedule?.endDate ?? null,
    success: currentEntries(entries, { kind: 'brief', topic: 'Success' })[0]?.text ?? null,
    // How fast they need results and whether they'll spend on offers (and any budget), as the designer has it.
    spendAppetite: currentEntries(entries, { kind: 'brief', topic: 'Spend' })[0]?.text ?? null,
    incentiveStrategy: noteText(entries, 'incentive strategy') ?? null,
    ...(cost && cost.mode !== 'none'
      ? { potentialSpend: { summary: costLine(cost), ifItUnderperforms: cost.total.under, asExpected: cost.total.expected, ifItOutperformsMax: cost.total.max, budgetCap: cost.budgetCap, unit: cost.mode === 'perThousand' ? 'per 1,000 customers (no data access)' : 'rupees, whole campaign', workedOutBy: 'code, from the data and the designer\'s estimates', ...(cost.notes.length ? { notes: cost.notes } : {}) } }
      : {}),
    membership: membershipText(c),
    ...(c.maxAttempts ? { timesThroughAtMost: c.maxAttempts } : {}),
    bucketCount: buckets.length,
    totalMessages,
    buckets: buckets.map((b, i) => ({
      checked: i + 1,
      name: b.name,
      who: views[b.id]?.behaviour ?? null,
      aiRationale: views[b.id]?.rationale ?? null,
      evidence: views[b.id]?.evidence ?? 'hypothesis',
      size: typeof views[b.id]?.size === 'number' ? views[b.id]!.size : 'unknown',
      ...(b.holdoutPct ? { heldBackPct: b.holdoutPct } : {}),
      journey: journeys[i].inWords,
      firstPath: journeys[i].firstPath,
      // What each A/B test is for: arms, what it tries to learn, how the winner is judged.
      ...(journeys[i].tests.length ? { tests: journeys[i].tests } : {}),
      ...(cost?.buckets.find((x) => x.bucketId === b.id) ? { potentialSpend: (({ under, expected, max }) => ({ ifItUnderperforms: under, asExpected: expected, ifItOutperformsMax: max }))(cost.buckets.find((x) => x.bucketId === b.id)!) } : {}),
    })),
    everyoneElse:
      ee?.approach === 'journey' ? `customers in no bucket get their own journey: ${journeyInWords(ee.journey).inWords}` : 'customers in no bucket get no messages',
    howBucketsWork: 'Each customer goes into the first bucket they match, in the order above.',
    segmentation: noteText(entries, 'segmentation') ?? null,
  };
}
