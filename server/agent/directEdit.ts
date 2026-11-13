// Direct edits from the canvas: clear-cut settings the manager changes with a
// control, no agent involved. Each one is applied through the same state
// transitions the agent's tools use, rebuilt (code only), saved, noted in the
// context, and recorded as a version. Also: restoring an old version.
import { loadStores, saveCampaignObject, saveContext } from '../campaignFiles';
import { ensureBaseline, getVersion, recordVersion, type Version } from '../campaignVersions';
import { addContext, editJourney, emptyContext, initialState, updateCampaign, upsertBucket } from './state';
import { findStep } from './stepIds';
import { buildCampaign } from './tools';
import { toolEnvFor } from './loop';
import type { AgentState, CampaignContext, CampaignObject, TimelineEntry } from './types';

export type DirectOp =
  | { op: 'membership'; type: 'locked' | 'open'; refresh?: 'daily' | 'weekly' | 'monthly' }
  | { op: 'holdout'; bucketId: string; pct: number }
  | { op: 'split'; bucketId: string; stepId: string; pcts: number[] }
  | { op: 'wait'; bucketId: string; stepId: string; days: number };

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
  let next = addContext(after, [{ kind: 'note', topic: `${source === 'rollback' ? 'rollback' : 'manager edit'} ${new Date().toISOString()}`, text: said, source: 'manager' }], 'user').state;
  saveCampaignObject(sessionId, tenantId, next.campaign);
  saveContext(sessionId, tenantId, next.context);
  const v = recordVersion({ sessionId, campaign: next.campaign, source, request: said, summary });
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
  const state = stateFromDisk(sessionId);
  if (!state) return fail('This chat has no campaign yet.');
  const r = apply(state, op);
  if ('error' in r) return fail(r.error);
  return finish(sessionId, tenantId, state, r.state, 'direct', r.said, r.said);
}

export function restoreVersion(sessionId: string, tenantId: string, n: number): DirectResult {
  const state = stateFromDisk(sessionId);
  if (!state) return fail('This chat has no campaign yet.');
  const v = getVersion(sessionId, n);
  if (!v) return fail(`There is no version ${n}.`);
  const said = `Restored v${n}`;
  return finish(sessionId, tenantId, state, { ...state, campaign: v.campaign }, 'rollback', said, `Restored v${n}: ${v.summary}`);
}
