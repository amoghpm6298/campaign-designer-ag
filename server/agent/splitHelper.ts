// Split helpers. While designing, the main agent may leave a "split idea" on
// a step: a hypothesis that people there would respond differently by some
// signal. After it builds, one helper per idea runs, in parallel. Each tests
// the idea against the data and, only if the data backs it, splits the
// journey from that step onward into routes (a signal switch). Otherwise it
// records why not. Helpers write directly, but only their own step and what
// follows it in that list; the main agent then reviews (closing pass).
import { callClaude, extractJson } from '../anthropic';
import { runWarehouseQuery } from '../warehouse';
import { canonicalCondition, conditionSql, signalConditionProblem, signalsFor, signalsForAgent } from '../signals';
import { incentiveForAgent, incentivesFor, qualifyingShare, validFor } from '../incentives';
import { bucketContext, currentEntries } from '../../src/designer/v2/contextView';
import { stripJourneyIds, walkSteps } from './stepIds';
import { upsertBucket, updateCampaign } from './state';
import { endingGaps } from './compile';
import { offerProblems } from './offerChecks';
import { todayIST } from './schedule';
import type { AgentState } from './types';
import type { BpStep } from '../blueprint';
import type { ToolEnv } from './tools';

/** Hidden caps. */
export const MAX_IDEAS_PER_TURN = 4;
const MAX_ROUNDS = 14;
const MAX_QUERIES = 8;
const MAX_MS = 180_000;

type Rec = Record<string, unknown>;
type Call = (system: string, messages: { role: 'user' | 'assistant'; content: string }[]) => Promise<string>;

export interface SplitIdeaRef {
  bucketId: string;
  bucketName: string;
  stepId: string;
  hypothesis: string;
  by: string[];
}

export interface SplitOutcome {
  ref: SplitIdeaRef;
  status: 'split' | 'not split' | 'failed';
  result: string;
  /** The new tail (a signal switch) when split. */
  branch?: Rec;
  queries: { purpose: string; sql: string; error?: string }[];
}

const lanesOf = (s: AgentState) => [
  ...s.campaign.buckets.map((b) => ({ id: b.id, name: b.name, journey: b.journey })),
  ...(s.campaign.everyoneElse?.approach === 'journey' ? [{ id: 'everyone_else', name: 'Everyone else', journey: s.campaign.everyoneElse.journey }] : []),
];

/** Untested split ideas, outermost first, at most one per bucket and MAX_IDEAS_PER_TURN in all. */
export function pendingSplitIdeas(state: AgentState): SplitIdeaRef[] {
  const out: SplitIdeaRef[] = [];
  for (const lane of lanesOf(state)) {
    let taken = false;
    walkSteps(lane.journey as BpStep[] | null | undefined, (s) => {
      if (taken) return;
      const idea = s.splitIdea as { hypothesis?: unknown; by?: unknown; status?: unknown } | undefined;
      if (!idea || typeof idea.hypothesis !== 'string' || (idea.status && idea.status !== 'untested') || typeof s.id !== 'string') return;
      out.push({ bucketId: lane.id, bucketName: lane.name, stepId: s.id, hypothesis: idea.hypothesis, by: Array.isArray(idea.by) ? idea.by.map(String) : [] });
      taken = true;
    });
  }
  return out.slice(0, MAX_IDEAS_PER_TURN);
}

/** Finds the list holding a step, and its index: the helper's scope is that step and everything after it in that list. */
function locate(journey: BpStep[] | null | undefined, stepId: string): { list: Rec[]; index: number } | null {
  let hit: { list: Rec[]; index: number } | null = null;
  walkSteps(journey, (s, _path, list, index) => {
    if (!hit && s.id === stepId) hit = { list: list as Rec[], index };
  });
  return hit;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The journey with the tail from `stepId` replaced by `replacement` (one step). */
function replaceTail(journey: BpStep[] | null | undefined, stepId: string, replacement: Rec): BpStep[] | null {
  const copy = clone(journey ?? []) as BpStep[];
  const at = locate(copy, stepId);
  if (!at) return null;
  at.list.splice(at.index, at.list.length - at.index, replacement);
  return copy;
}

/** Marks a split idea's outcome on its step (used when not split). */
function markIdea(journey: BpStep[] | null | undefined, stepId: string, status: string, result: string): BpStep[] | null {
  const copy = clone(journey ?? []) as BpStep[];
  const at = locate(copy, stepId);
  if (!at) return null;
  const s = at.list[at.index];
  s.splitIdea = { ...(s.splitIdea as Rec), status, result, testedAt: new Date().toISOString() };
  return copy;
}

const SYSTEM = `You are a route designer for one card campaign. The campaign's designer left a SPLIT IDEA on one step of one bucket's journey: a hypothesis that people there respond differently by some customer signal. Your job: test it with the bank's data, and only if the data backs it, split the journey from that step onward into routes. You change nothing else.

Reply with ONE JSON object and nothing else:
- {"action":"query","purpose":"…","sql":"ONE read-only SQLite SELECT"}: explore. Aggregate; never pull raw customer rows. Treat the latest transaction date as today.
- {"action":"route_sizes","signal":"<key>","paths":[{"label":"…","operator":"…","value":"…"}]}: count each route and everyone else within this bucket (code does it).
- {"action":"offers"}: the offers this bucket may use, with how many qualify and their cost.
- {"action":"split","branch":{…}}: apply the split. branch is ONE step that replaces the step with the idea AND every step after it in that list: {"kind":"branch","signal":"<key>","label":"<the question it asks>","rationale":"why split here, what each route is for, citing the numbers","paths":[{"label":"…","operator":"…","value":"…","steps":[…]}],"otherwise":[…]}. Each route's steps are a complete journey from here to its end, adapted to that group: its own copy and lever, the same discipline as the original (a wait before every goal check, a goal check after every wait, every path ends with an exit that has an outcome, a rationale on every send, wait and branch). Keep the original's length and timing unless the hypothesis is about them. "otherwise" (everyone else) is required: usually the original steps, unchanged.
- {"action":"decline","reason":"…"}: the data doesn't back the idea, or a route would be too small to measure. Say why in one or two plain sentences with the numbers.

How to test: you usually cannot prove people will RESPOND differently (there may be no campaign history; the split itself is how that gets measured). Test the hypothesis's PREMISE instead: do the groups it names exist in this bucket, is each big enough, and do they really differ in the way the idea assumes (e.g. electronics buyers really concentrate their spend there; EMI-eligible share really differs)? If the premise holds and the difference would change what you say or offer, split. If the groups are tiny, or barely differ, decline.

Rules:
- Split only where the premise is backed by the data and the routes would get genuinely different messages or offers. An unnecessary split costs review effort and measurement power.
- At most 4 routes plus everyone else; every route must be big enough to measure (the app checks the minimum and tells you).
- Use only signals in the menu below, with an operator from that signal's "operators" and a value from its "values" (for several values: operator "Any of", value "a,b"). Never invent one.
- Copy: write as the customer reads it; never write a URL, amount, rate or offer terms in copy or CTA. To make an offer, set "incentive":"<id>" on the send (the system adds its exact line) and give "costAssumptions": {"reach":{"expected","few","why"},"redeem":{"expected","few","why"}} as fractions (few ≤ expected). Only offers this route qualifies for; stay within the bucket's share of the budget.
- Numbers you quote must be exactly what a query returned.`;

function brief(state: AgentState, env: ToolEnv, ref: SplitIdeaRef): string {
  const views = bucketContext(state.context.entries);
  const lane = lanesOf(state).find((l) => l.id === ref.bucketId)!;
  const at = locate(lane.journey as BpStep[], ref.stepId);
  const tail = at ? stripJourneyIds(at.list.slice(at.index) as unknown as BpStep[]) : [];
  const strategy = currentEntries(state.context.entries, { kind: 'note', topic: 'campaign strategy' })[0]?.text ?? '(no strategy note)';
  const v = views[ref.bucketId] ?? {};
  const sigs = signalsForAgent(signalsFor(env.tenant)).filter((s) => s.usableIn.includes('switch'));
  return [
    `# The split idea\nBucket "${ref.bucketName}". Hypothesis: ${ref.hypothesis}\nSignals suggested: ${ref.by.join(', ') || '(none named)'}`,
    `# The bucket\nWho: ${v.behaviour ?? '?'}\nWhy stuck: ${v.rationale ?? '?'}\nSize: ${typeof v.size === 'number' ? v.size : 'unknown'}\nSizing SQL: ${v.sql ?? '(none)'}`,
    `# The steps you may change (the one with the idea, and everything after it)\n${JSON.stringify(tail, null, 1)}`,
    `# The campaign's strategy (budget shares, tone, caps)\n${strategy}`,
    `# Campaign: goal ${state.campaign.goal?.eventType ?? '?'}; dates ${state.campaign.schedule ? `${state.campaign.schedule.startDate} to ${state.campaign.schedule.endDate}` : 'not set'}; offer budget cap ${state.campaign.budgetCap ?? 'none'}`,
    `# Signals you may split on\n${JSON.stringify(sigs)}`,
  ].join('\n\n');
}

const defaultCall: Call = async (system, messages) => (await callClaude({ system, messages, maxTokens: 6000, timeoutMs: 90_000 })).text;

/** One helper: test the idea, then split or decline. Works on a snapshot; returns what to apply. */
export async function runSplitHelper(state: AgentState, env: ToolEnv, ref: SplitIdeaRef, call: Call = defaultCall): Promise<SplitOutcome> {
  const queries: SplitOutcome['queries'] = [];
  const bank = env.warehouseBank;
  const signals = signalsFor(env.tenant);
  const views = bucketContext(state.context.entries);
  const bucketSql = views[ref.bucketId]?.sql;
  const lane = lanesOf(state).find((l) => l.id === ref.bucketId);
  if (!lane || !locate(lane.journey as BpStep[], ref.stepId)) return { ref, status: 'failed', result: 'The step is no longer there.', queries };
  if (!bank) return { ref, status: 'not split', result: 'No data access for this bank, so the idea cannot be tested against the data.', queries };
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: brief(state, env, ref) }];
  const started = Date.now();
  let applyTries = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - started > MAX_MS) messages.push({ role: 'user', content: 'Time limit reached: decide now (split or decline).' });
    const text = await call(SYSTEM, messages);
    messages.push({ role: 'assistant', content: text });
    const parsed = extractJson<Rec>(text);
    if (!parsed.ok) {
      messages.push({ role: 'user', content: 'Reply with ONE JSON object only.' });
      continue;
    }
    const a = parsed.value;
    const reply = (o: unknown) => messages.push({ role: 'user', content: typeof o === 'string' ? o : JSON.stringify(o) });
    if (a.action === 'query') {
      if (queries.length >= MAX_QUERIES) {
        reply('Query limit reached: decide now (split or decline).');
        continue;
      }
      const rec = { purpose: String(a.purpose ?? ''), sql: String(a.sql ?? '') };
      try {
        const r = runWarehouseQuery(bank, rec.sql);
        queries.push(rec);
        reply({ columns: r.columns, rows: r.rows.slice(0, 40) });
      } catch (e) {
        queries.push({ ...rec, error: (e as Error).message });
        reply(`Query failed: ${(e as Error).message}`);
      }
      continue;
    }
    if (a.action === 'route_sizes') {
      if (!bucketSql) {
        reply('This bucket has no sizing query, so routes cannot be counted.');
        continue;
      }
      const inner = bucketSql.trim().replace(/;+\s*$/, '');
      const paths = (Array.isArray(a.paths) ? (a.paths as Rec[]) : []).map((p) => ({ label: String(p.label ?? ''), ...canonicalCondition(signals, { attribute: a.signal, operator: p.operator, value: p.value }) }));
      const bad = paths.map((p) => signalConditionProblem(signals, p, 'switch')).filter(Boolean);
      if (bad.length) {
        reply(`Not counted: ${bad.join(' ')}`);
        continue;
      }
      const conds = paths.map((p) => conditionSql(signals, p));
      const n = (where: string) => Number(runWarehouseQuery(bank, `SELECT COUNT(DISTINCT customer_id) AS n FROM (${inner}) WHERE ${where}`).rows[0]?.n ?? 0);
      const sizes = paths.map((p, i) => ({ label: p.label, customers: n(`customer_id IN (${conds[i]})`) }));
      const total = n('1 = 1');
      reply({ bucket: total, routes: sizes, everyoneElse: n(conds.map((c) => `customer_id NOT IN (${c})`).join(' AND ')) });
      continue;
    }
    if (a.action === 'offers') {
      const list = incentivesFor(env.tenant).filter((i) => validFor(i, state.campaign.schedule, todayIST()));
      reply(
        list.map((i) => {
          const q = bucketSql ? qualifyingShare(bank, signals, bucketSql, i) : null;
          return { ...incentiveForAgent(i, signals), ...(q && !('error' in q) ? { qualifyInBucket: `${q.qualify} of ${q.size}` } : {}) };
        }),
      );
      continue;
    }
    if (a.action === 'decline') return { ref, status: 'not split', result: String(a.reason ?? 'The data did not back the idea.'), queries };
    if (a.action === 'split' && a.branch && typeof a.branch === 'object') {
      const raw = a.branch as Rec;
      const paths = (Array.isArray(raw.paths) ? (raw.paths as Rec[]) : []).map((p) => {
        const c = canonicalCondition(signals, { attribute: raw.signal, operator: p.operator, value: p.value });
        return { ...p, operator: c.operator, value: c.value };
      });
      const bad = paths.map((p) => signalConditionProblem(signals, { attribute: String(raw.signal), operator: String(p.operator), value: String(p.value) }, 'switch')).filter(Boolean);
      if (bad.length) {
        reply(`Not applied: ${bad.join(' ')}`);
        continue;
      }
      const branch = { ...raw, paths, kind: 'branch', splitIdea: { hypothesis: ref.hypothesis, by: ref.by, status: 'split', result: '', testedAt: new Date().toISOString() } };
      // Try it on a copy: the checks must pass for this bucket before it is applied for real.
      const journey = replaceTail(lane.journey as BpStep[], ref.stepId, branch);
      const trial = ref.bucketId === 'everyone_else' ? updateCampaign(state, { everyoneElse: { approach: 'journey', journey } }) : upsertBucket(state, { id: ref.bucketId, journey });
      if (trial.error || !journey) {
        reply(`Not applied: ${trial.error ?? 'the step could not be found'}. Fix it and try again.`);
        continue;
      }
      const name = ref.bucketId === 'everyone_else' ? 'Everyone else' : `Bucket "${ref.bucketName}"`;
      const problems = [...endingGaps(trial.state.campaign), ...offerProblems(trial.state.campaign, trial.state.context, env.tenant).problems].filter((p) => p.startsWith(name));
      if (problems.length && applyTries < 2) {
        applyTries++;
        reply(`Not applied yet: fix these and send the split again:\n- ${problems.join('\n- ')}`);
        continue;
      }
      const why = String((a.branch as Rec).rationale ?? '').slice(0, 400);
      (branch.splitIdea as Rec).result = why || `Split by ${String((a.branch as Rec).signal)}.`;
      return { ref, status: 'split', result: (branch.splitIdea as Rec).result as string, branch, queries };
    }
    reply('Use one of: query, route_sizes, offers, split, decline.');
  }
  return { ref, status: 'not split', result: 'Ran out of rounds before deciding; left as it was.', queries };
}

/** Applies the helpers' outcomes to the live state, one by one, by step id. */
export function applySplitOutcomes(state: AgentState, outcomes: SplitOutcome[]): AgentState {
  let s = state;
  for (const o of outcomes) {
    const lane = lanesOf(s).find((l) => l.id === o.ref.bucketId);
    if (!lane) continue;
    const journey = o.status === 'split' && o.branch ? replaceTail(lane.journey as BpStep[], o.ref.stepId, o.branch) : markIdea(lane.journey as BpStep[], o.ref.stepId, o.status === 'failed' ? 'not split' : o.status, o.result);
    if (!journey) continue;
    const r = o.ref.bucketId === 'everyone_else' ? updateCampaign(s, { everyoneElse: { approach: 'journey', journey } }) : upsertBucket(s, { id: o.ref.bucketId, journey });
    if (!r.error) s = r.state;
  }
  return s;
}

/** The message the main agent gets after the helpers, for its closing pass. */
export function closingMessage(outcomes: SplitOutcome[]): string {
  const lines = outcomes.map((o) => `- Bucket "${o.ref.bucketName}" (${o.ref.hypothesis.slice(0, 90)}): ${o.status === 'split' ? 'SPLIT into routes' : 'NOT split'}. ${o.result}`);
  return `AUTOMATIC: the split helpers finished testing your split ideas:\n${lines.join('\n')}\nReview what changed (get_campaign), adjust or undo a split if it doesn't fit the campaign (say why), run the budget pass if offers changed, update your campaign strategy and the campaign brief, rebuild, and tell the manager in a line or two what was split and why.`;
}
