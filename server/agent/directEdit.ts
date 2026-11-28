// Direct edits from the canvas: clear-cut settings the manager changes with a
// control, no agent involved. Each one is applied through the same state
// transitions the agent's tools use, rebuilt (code only), saved, noted in the
// context, and recorded as a version. Also: restoring an old version.
import { scheduleText } from './schedule';
import { LOCKED, loadStores, loadSubmission, saveCampaignObject, saveContext } from '../campaignFiles';
import { ensureBaseline, getVersion, recordVersion, type Version } from '../campaignVersions';
import { addContext, editJourney, emptyContext, initialState, updateCampaign, upsertBucket } from './state';
import { findStep } from './stepIds';
import { buildCampaign } from './tools';
import { toolEnvFor } from './loop';
import { costSnapshot } from '../costModel';
import { resolveTenant } from '../tenants';
import { type AfterJourney, type AfterOutcome, type AgentState, type CampaignContext, type CampaignObject, type TimelineEntry } from './types';

const OUTCOME_WORDS: Record<AfterOutcome, string> = { no_response: "Didn't respond", not_reachable: "Couldn't reach", declined: 'Said no', converted: 'Converted' };
const afterWords = (v: AfterJourney[AfterOutcome]) => (v === undefined ? 'not set' : v === 'leave' ? 'leaves' : `can rejoin after ${v} days`);

export type DirectOp =
  | { op: 'membership'; type: 'locked' | 'open'; refresh?: 'daily' | 'weekly' | 'monthly' }
  | { op: 'holdout'; bucketId: string; pct: number }
  | { op: 'split'; bucketId: string; stepId: string; pcts: number[] }
  | { op: 'wait'; bucketId: string; stepId: string; days: number }
  | { op: 'afterJourney'; outcome: AfterOutcome; value: number | 'leave' }
  | { op: 'maxAttempts'; value: number }
  | { op: 'schedule'; startDate: string; endDate?: string }
  | { op: 'budgetCap'; value: number | null }
  | { op: 'funnelRate'; bucketId: string; stepId: string; which: 'opens' | 'converts'; pct: number }
  | { op: 'copy'; bucketId: string; stepId: string; copy: string; cta?: string };

export interface DirectResult {
  ok: boolean;
  error?: string;
  campaign?: CampaignObject;
  context?: CampaignContext;
  version?: Omit<Version, 'campaign' | 'diff'>;
  /** For the chat's timeline, so the agent sees it on the next turn. */
  timeline?: TimelineEntry;
  notes?: string[];
}

const fail = (error: string): DirectResult => ({ ok: false, error });

function apply(state: AgentState, op: DirectOp): { state: AgentState; said: string } | { error: string } {
  const c = state.campaign;
  if (op.op === 'membership') {
    const prev = c.membership;
    const res = updateCampaign(state, { membership: { type: op.type, ...(op.type === 'open' ? { refresh: op.refresh ?? 'weekly' } : {}) } });
    if (res.error) return { error: res.error };
    const txt = (m: typeof prev) => (!m ? 'not decided' : m.type === 'open' ? `recurring, ${m.refresh ?? 'weekly'}` : 'one-time');
    return { state: res.state, said: `Refresh: ${txt(prev)} → ${txt(res.state.campaign.membership)}` };
  }
  if (op.op === 'schedule') {
    const prev = c.schedule;
    const res = updateCampaign(state, { schedule: { startDate: op.startDate, ...(op.endDate ? { endDate: op.endDate } : {}) } });
    if (res.error) return { error: res.error };
    return { state: res.state, said: `Dates: ${scheduleText(prev)} → ${scheduleText(res.state.campaign.schedule)}` };
  }
  if (op.op === 'maxAttempts') {
    const prev = c.maxAttempts;
    const res = updateCampaign(state, { maxAttempts: op.value });
    if (res.error) return { error: res.error };
    const w = (v: number | null | undefined) => (v ? `at most ${v} time${v === 1 ? '' : 's'}` : 'not set');
    return { state: res.state, said: `Times through the campaign: ${w(prev)} → ${w(res.state.campaign.maxAttempts)}` };
  }
  if (op.op === 'budgetCap') {
    const prev = c.budgetCap;
    const res = updateCampaign(state, { budgetCap: op.value });
    if (res.error) return { error: res.error };
    const w = (v: number | null | undefined) => (typeof v === 'number' ? `₹${v.toLocaleString('en-IN')}` : 'no cap');
    return { state: res.state, said: `Offer budget cap: ${w(prev)} → ${w(res.state.campaign.budgetCap)}` };
  }
  if (op.op === 'afterJourney') {
    if (op.value !== 'leave' && !(Number(op.value) >= 0 && Number(op.value) <= 365)) return { error: 'Days must be between 0 and 365.' };
    const prev = c.afterJourney?.[op.outcome];
    const res = updateCampaign(state, { afterJourney: { [op.outcome]: op.value } });
    if (res.error) return { error: res.error };
    return { state: res.state, said: `After the journey, ${OUTCOME_WORDS[op.outcome]}: ${afterWords(prev)} → ${afterWords(res.state.campaign.afterJourney?.[op.outcome])}` };
  }
  const bucket = op.bucketId === 'everyone_else' ? null : c.buckets.find((b) => b.id === op.bucketId);
  if (op.bucketId !== 'everyone_else' && !bucket) return { error: 'That bucket no longer exists.' };
  if (op.op === 'holdout') {
    const pct = Math.round(op.pct);
    if (!(pct >= 0 && pct <= 30)) return { error: 'Holdout must be between 0% and 30%.' };
    const res = upsertBucket(state, { id: op.bucketId, holdoutPct: pct });
    if (res.error) return { error: res.error };
    return { state: res.state, said: `"${bucket!.name}" holdout: ${bucket!.holdoutPct ?? 0}% → ${pct}%` };
  }
  const journey = op.bucketId === 'everyone_else' ? c.everyoneElse?.journey : bucket!.journey;
  const hit = findStep(journey, op.stepId);
  if (!hit) return { error: 'That step no longer exists.' };
  const lane = bucket ? `"${bucket.name}"` : 'Everyone else';
  if (op.op === 'funnelRate') {
    // The manager overrides one of the designer's funnel estimates; the funnel and cost are worked out again by code.
    if (hit.step.kind !== 'send' && hit.step.kind !== 'waitForEvent') return { error: 'That step has no funnel estimates.' };
    const r = Number(op.pct) / 100;
    if (!(r >= 0 && r <= 1)) return { error: 'Use a percentage from 0 to 100.' };
    const fu = { ...((hit.step.funnel as Record<string, unknown>) ?? {}) } as Record<string, { rate: number; why: string }>;
    const prev = fu[op.which];
    fu[op.which] = { rate: r, why: 'Set by the manager.' };
    const res = editJourney(state, op.bucketId, [{ op: 'replace', path: hit.path, step: { ...hit.step, funnel: fu } }]);
    if (res.error) return { error: res.error };
    const w = (e?: { rate: number }) => (e ? `${Math.round(e.rate * 100)}%` : 'not set');
    return { state: res.state, said: `${lane} "${String(hit.step.name ?? 'message')}" ${op.which}: ${w(prev)} → ${w(fu[op.which])}` };
  }
  if (op.op === 'copy') {
    // An approver's edit to a message's wording (Comm approvals: edit & approve).
    if (hit.step.kind !== 'send') return { error: 'That step is not a message.' };
    const copy = String(op.copy ?? '').trim();
    if (!copy) return { error: 'The message can\'t be empty.' };
    if (/https?:\/\/|www\./i.test(`${copy} ${op.cta ?? ''}`)) return { error: 'A message can\'t contain a web address: its link is added by the system.' };
    const step = { ...hit.step, copy, ...(op.cta !== undefined ? { cta: String(op.cta).trim() } : {}) };
    const res = editJourney(state, op.bucketId, [{ op: 'replace', path: hit.path, step }]);
    if (res.error) return { error: res.error };
    return { state: res.state, said: `${lane} "${String(hit.step.name ?? 'message')}": wording edited in approval` };
  }
  if (op.op === 'split') {
    if (hit.step.kind !== 'experiment') return { error: 'That step is not an A/B test.' };
    const arms = (hit.step.arms as { label?: string; pct: number }[]) ?? [];
    const pcts = op.pcts.map((x) => Math.round(Number(x)));
    if (pcts.length !== arms.length || pcts.some((x) => !(x > 0))) return { error: 'Give every arm a share above 0%.' };
    if (pcts.reduce((a, b) => a + b, 0) !== 100) return { error: 'The split must add up to 100%.' };
    const step = { ...hit.step, arms: arms.map((a, i) => ({ ...a, pct: pcts[i] })) };
    const res = editJourney(state, op.bucketId, [{ op: 'replace', path: hit.path, step }]);
    if (res.error) return { error: res.error };
    return { state: res.state, said: `${lane} A/B test split: ${arms.map((a) => `${a.pct}%`).join(' / ')} → ${pcts.map((x) => `${x}%`).join(' / ')}` };
  }
  if (hit.step.kind !== 'wait') return { error: 'That step is not a wait.' };
  const days = Math.round(Number(op.days) * 10) / 10;
  if (!(days > 0 && days <= 60)) return { error: 'A wait must be between 0 and 60 days.' };
  const from = Math.round((Number(hit.step.durationHours) / 24) * 10) / 10;
  const res = editJourney(state, op.bucketId, [{ op: 'replace', path: hit.path, step: { ...hit.step, durationHours: days * 24 } }]);
  if (res.error) return { error: res.error };
  return { state: res.state, said: `${lane} wait: ${from} → ${days} days` };
}

function stateFromDisk(sessionId: string): AgentState | null {
  const stores = loadStores(sessionId);
  if (!stores.campaign) return null;
  return { ...initialState(), campaign: stores.campaign, context: stores.context ?? emptyContext() };
}

function finish(sessionId: string, tenantId: string, before: AgentState, after: AgentState, source: 'direct' | 'rollback', said: string, summary: string): DirectResult {
  const env = toolEnvFor(tenantId, sessionId);
  if (!env) return fail('Unknown tenant.');
  // Rebuild with code (no model) to check it still builds.
  const built = buildCampaign({ ...after, flags: { ...after.flags, campaignBuilt: false } }, env);
  ensureBaseline(sessionId, before.campaign);
  // Keep the rebuild's fresh counts (bucket sizes, the target and who is eligible), so a change on the canvas is counted again.
  const counted = built.ok ? { ...after, context: (built.state as AgentState).context } : after;
  let next = addContext(counted, [{ kind: 'note', topic: `${source === 'rollback' ? 'rollback' : 'manager edit'} ${new Date().toISOString()}`, text: said, source: 'manager' }], 'user').state;
  saveCampaignObject(sessionId, tenantId, next.campaign);
  saveContext(sessionId, tenantId, next.context);
  const v = recordVersion({ sessionId, campaign: next.campaign, source, request: said, summary, cost: costSnapshot(next.campaign, next.context, resolveTenant(tenantId)), costOf: (c) => costSnapshot(c, next.context, resolveTenant(tenantId)) });
  next = { ...next };
  const { campaign: _c, diff: _d, ...version } = v ?? ({} as Version);
  void _c;
  void _d;
  return {
    ok: true,
    campaign: next.campaign,
    context: next.context,
    ...(v ? { version } : {}),
    timeline: { at: new Date().toISOString(), actor: 'user', type: source === 'rollback' ? 'plan_section_updated' : 'journey_edited', note: `${source === 'rollback' ? 'Rolled back' : 'Changed directly'}: ${said}` },
    notes: (built.result as { notes?: string[] } | undefined)?.notes ?? [],
  };
}

export function directEdit(sessionId: string, tenantId: string, op: DirectOp): DirectResult {
  if (loadSubmission(sessionId)) return fail(LOCKED);
  const state = stateFromDisk(sessionId);
  if (!state) return fail('This chat has no campaign yet.');
  const r = apply(state, op);
  if ('error' in r) return fail(r.error);
  return finish(sessionId, tenantId, state, r.state, 'direct', r.said, r.said);
}

export function restoreVersion(sessionId: string, tenantId: string, n: number): DirectResult {
  if (loadSubmission(sessionId)) return fail(LOCKED);
  const state = stateFromDisk(sessionId);
  if (!state) return fail('This chat has no campaign yet.');
  const v = getVersion(sessionId, n);
  if (!v) return fail(`There is no version ${n}.`);
  const said = `Restored v${n}`;
  return finish(sessionId, tenantId, state, { ...state, campaign: v.campaign }, 'rollback', said, `Restored v${n}: ${v.summary}`);
}
