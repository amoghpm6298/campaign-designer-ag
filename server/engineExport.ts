// What the engine runs. campaign.json is the full design: what runs plus the
// reasoning next to each part (AI rationale, test hypotheses, cost
// estimates). At submit, this keeps only the fields the engine needs, per
// step kind, and the result is frozen as engine.json with the submission.
//
// The engine's real input format isn't fixed yet; this list is the contract
// until it is, and the one place to change when it is. Reasoning never goes
// to the engine.
import type { CampaignObject } from './agent/types';
import type { BpStep } from './blueprint';
import type { TenantConfig } from './tenants';
import { incentivesFor } from './incentives';

export const ENGINE_FORMAT_VERSION = 'cd-engine-1';

/** The fields each step kind sends to the engine. Anything else stays in the design. */
const STEP_FIELDS: Record<string, string[]> = {
  send: ['id', 'kind', 'name', 'channelPreference', 'fallbackChannel', 'copy', 'cta', 'link', 'incentive', 'delayDays', 'atTime'],
  wait: ['id', 'kind', 'durationHours'],
  waitForEvent: ['id', 'kind', 'eventCategory', 'eventType', 'conditions', 'timeoutDays'],
  goalCheck: ['id', 'kind'],
  exit: ['id', 'kind', 'outcome', 'reason'],
  experiment: ['id', 'kind', 'label', 'tests', 'arms'],
  condition: ['id', 'kind', 'label', 'on', 'outcomes', 'audience', 'yes', 'no'],
  branch: ['id', 'kind', 'label', 'entity', 'attribute', 'signal', 'paths', 'otherwise'],
};
/** Fields of an experiment arm or branch path. */
const ARM_FIELDS = ['label', 'pct', 'operator', 'value', 'statuses', 'steps'];
const NESTED = ['yes', 'no', 'otherwise'];

type Rec = Record<string, unknown>;

function exportSteps(steps: BpStep[] | null | undefined, problems: string[], where: string): Rec[] {
  return ((steps ?? []) as unknown as Rec[]).map((s, i) => {
    const kind = String(s.kind ?? '');
    const at = `${where} step ${i + 1}${s.name ? ` "${s.name}"` : ''}`;
    const fields = STEP_FIELDS[kind];
    if (!fields) {
      problems.push(`${at}: "${kind}" is not a step the engine runs.`);
      return { kind };
    }
    const out: Rec = {};
    for (const f of fields) {
      const v = s[f];
      if (v === undefined || v === null || v === '') continue;
      if (NESTED.includes(f)) out[f] = exportSteps(v as BpStep[], problems, `${at} › ${f}`);
      else if (f === 'arms' || f === 'paths')
        out[f] = (v as Rec[]).map((a, j) => {
          const arm: Rec = {};
          for (const k of ARM_FIELDS) if (a[k] !== undefined) arm[k] = k === 'steps' ? exportSteps(a.steps as BpStep[], problems, `${at} › ${f} ${j + 1}`) : a[k];
          return arm;
        });
      else out[f] = v;
    }
    if (kind === 'send' && !(Array.isArray(s.channelPreference) && s.channelPreference.length)) problems.push(`${at}: no channel.`);
    if (kind === 'send' && !String(s.copy ?? '').trim()) problems.push(`${at}: no message copy.`);
    if (kind === 'wait' && !(Number(s.durationHours) > 0)) problems.push(`${at}: no wait length.`);
    if (kind === 'exit' && !s.outcome) problems.push(`${at}: no ending (outcome).`);
    return out;
  });
}

/** The engine's version of the campaign: only what runs. Offers carry their exact line and terms from the menu. */
export function toEngineCampaign(c: CampaignObject, tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null): { engine: Rec; problems: string[] } {
  const problems: string[] = [];
  const buckets = [...c.buckets]
    .sort((a, b) => a.priority - b.priority)
    .map((b) => ({ id: b.id, name: b.name, priority: b.priority, rule: b.rule, holdoutPct: b.holdoutPct ?? 0, journey: exportSteps(b.journey, problems, `Bucket "${b.name}"`) }));
  const ee = c.everyoneElse;
  // Offers used, resolved from the menu, so the engine gets the exact terms the canvas showed.
  const used = new Set<string>();
  const collect = (steps: Rec[]) =>
    steps.forEach((s) => {
      if (typeof s.incentive === 'string') used.add(s.incentive);
      for (const k of NESTED) if (Array.isArray(s[k])) collect(s[k] as Rec[]);
      for (const k of ['arms', 'paths']) if (Array.isArray(s[k])) (s[k] as Rec[]).forEach((a) => collect((a.steps as Rec[]) ?? []));
    });
  buckets.forEach((b) => collect(b.journey));
  const eeJourney = ee?.approach === 'journey' ? exportSteps(ee.journey, problems, 'Everyone else') : [];
  collect(eeJourney);
  const menu = incentivesFor(tenant);
  const offers = [...used].map((id) => {
    const i = menu.find((m) => m.id === id);
    if (!i) problems.push(`Offer "${id}" is not on the bank's menu.`);
    return i ? { id: i.id, label: i.label, offerLine: i.offerLine, terms: i.terms, trigger: i.trigger, requires: i.requires, eligibility: i.eligibility, checkedByTheEngineOnly: i.unmatchedCriteria } : { id };
  });
  if (!c.goal) problems.push('No goal: the engine needs the event that proves success.');
  if (!c.entry) problems.push('No entry: the engine needs who is eligible.');
  if (!c.schedule) problems.push('No dates.');
  return {
    engine: {
      format: ENGINE_FORMAT_VERSION,
      tenantId: tenant?.tenantId ?? null,
      name: c.name ?? null,
      goal: c.goal,
      entry: c.entry,
      membership: c.membership,
      schedule: c.schedule ?? null,
      ...(c.maxAttempts ? { maxAttempts: c.maxAttempts } : {}),
      ...(c.afterJourney ? { afterJourney: c.afterJourney } : {}),
      ...(typeof c.budgetCap === 'number' ? { budgetCap: c.budgetCap } : {}),
      buckets,
      everyoneElse: ee ? { approach: ee.approach, ...(ee.approach === 'journey' ? { journey: eeJourney } : {}) } : null,
      offers,
    },
    problems,
  };
}

/** Field names that are reasoning, never sent to the engine (for tests and checks). */
export const REASONING_FIELDS = ['rationale', 'hypothesis', 'successMetric', 'costAssumptions', 'splitIdea', 'describe', 'objective', 'barrier', 'why', 'stage'];
