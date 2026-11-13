// What changed between two versions of the campaign object, computed by code
// (using the backend step ids), so a version's summary can never claim a
// change that did not happen.
import { ownSignature, walkSteps } from './stepIds';
import type { CampaignObject } from './types';
import type { BpStep } from '../blueprint';

export interface BucketChange {
  id: string;
  name: string;
  renamedFrom?: string;
  ruleChanged?: boolean;
  priorityChanged?: boolean;
  holdout?: { from: number; to: number };
  steps: { added: string[]; changed: string[]; removed: string[] };
}

export interface CampaignDiff {
  settings: string[];
  bucketsAdded: string[];
  bucketsRemoved: string[];
  bucketsChanged: BucketChange[];
  everyoneElse?: { approach?: { from: string; to: string }; steps: { added: string[]; changed: string[]; removed: string[] } };
  counts: { added: number; changed: number; removed: number };
}

const stepLabel = (s: Record<string, unknown>) => {
  const k = String(s.kind);
  if (k === 'send') return `${String(s.name ?? s.label ?? 'message')} (${((s.channelPreference as string[] | undefined) ?? [])[0] ?? ''})`;
  if (k === 'wait') return `wait ${Math.round(Number(s.durationHours) / 24 * 10) / 10} days`;
  if (k === 'goalCheck') return 'goal check';
  if (k === 'experiment') return `A/B test "${s.label ?? ''}" ${((s.arms as { pct?: number }[]) ?? []).map((a) => `${a.pct}%`).join('/')}`;
  return `${k}${s.label ? ` "${s.label}"` : ''}`;
};

/** In words, what changed inside one step: "link: card_benefits → rewards; copy updated". */
function fieldChanges(o: Record<string, unknown>, n: Record<string, unknown>): string {
  const show: Record<string, (v: unknown) => string> = {
    link: (v) => (v ? String(v) : 'none'),
    channelPreference: (v) => ((v as string[] | undefined) ?? [])[0] ?? 'none',
    fallbackChannel: (v) => (v ? String(v) : 'none'),
    durationHours: (v) => `${Math.round((Number(v) / 24) * 10) / 10} days`,
    delayDays: (v) => `day ${v ?? 0}`,
    atTime: (v) => String(v ?? ''),
    outcome: (v) => (v ? String(v).replace('_', ' ') : 'none'),
  };
  const words: Record<string, string> = { link: 'link', channelPreference: 'channel', fallbackChannel: 'fallback', durationHours: 'wait', delayDays: 'timing', atTime: 'time', copy: 'copy', cta: 'CTA wording', name: 'name', label: 'label', arms: 'split', paths: 'paths' };
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter((k) => !['id', 'yes', 'no', 'otherwise', 'describe', 'objective', 'stage'].includes(k));
  const out: string[] = [];
  for (const k of keys) {
    const a = k === 'arms' || k === 'paths' ? JSON.stringify(((o[k] as Record<string, unknown>[]) ?? []).map(({ steps: _s, ...r }) => (void _s, r))) : JSON.stringify(o[k]);
    const b = k === 'arms' || k === 'paths' ? JSON.stringify(((n[k] as Record<string, unknown>[]) ?? []).map(({ steps: _s, ...r }) => (void _s, r))) : JSON.stringify(n[k]);
    if (a === b) continue;
    out.push(show[k] ? `${words[k] ?? k}: ${show[k](o[k])} → ${show[k](n[k])}` : `${words[k] ?? k} updated`);
  }
  return out.join('; ');
}

function stepDiff(prev: BpStep[] | null | undefined, next: BpStep[] | null | undefined) {
  const a = new Map<string, { sig: string; label: string; s: Record<string, unknown> }>();
  const b = new Map<string, { sig: string; label: string; s: Record<string, unknown> }>();
  walkSteps(prev, (s) => typeof s.id === 'string' && a.set(s.id, { sig: ownSignature(s), label: stepLabel(s), s }));
  walkSteps(next, (s) => typeof s.id === 'string' && b.set(s.id, { sig: ownSignature(s), label: stepLabel(s), s }));
  return {
    added: [...b].filter(([id]) => !a.has(id)).map(([, v]) => v.label),
    changed: [...b]
      .filter(([id, v]) => a.has(id) && a.get(id)!.sig !== v.sig)
      .map(([id, v]) => {
        const what = fieldChanges(a.get(id)!.s, v.s);
        return v.s.kind === 'wait' && what ? what : `${a.get(id)!.label}: ${what || 'updated'}`;
      }),
    removed: [...a].filter(([id]) => !b.has(id)).map(([, v]) => v.label),
  };
}

const membershipText = (m: CampaignObject['membership']) => (!m ? 'not decided' : m.type === 'open' ? `recurring, ${m.refresh ?? 'weekly'}` : 'one-time');

export function diffCampaigns(prev: CampaignObject | null | undefined, next: CampaignObject): CampaignDiff {
  const p: CampaignObject = prev ?? { goal: null, entry: null, membership: null, buckets: [], everyoneElse: null };
  const settings: string[] = [];
  if ((p.name ?? '') !== (next.name ?? '')) settings.push(`name: "${p.name ?? ''}" → "${next.name ?? ''}"`);
  if (JSON.stringify(p.goal) !== JSON.stringify(next.goal)) settings.push(`goal: ${p.goal?.eventType ?? 'none'} → ${next.goal?.eventType ?? 'none'}`);
  if (JSON.stringify(p.entry) !== JSON.stringify(next.entry)) settings.push('who can join (entry) changed');
  if (JSON.stringify(p.membership) !== JSON.stringify(next.membership)) settings.push(`refresh: ${membershipText(p.membership)} → ${membershipText(next.membership)}`);
  if ((p.maxAttempts ?? null) !== (next.maxAttempts ?? null)) settings.push(`times through the campaign: ${p.maxAttempts ? `at most ${p.maxAttempts}` : 'not set'} → ${next.maxAttempts ? `at most ${next.maxAttempts}` : 'not set'}`);
  for (const k of ['no_response', 'not_reachable', 'declined', 'converted'] as const) {
    const a = p.afterJourney?.[k];
    const b = next.afterJourney?.[k];
    const w = (v: typeof a) => (v === undefined ? 'not set' : v === 'leave' ? 'leaves' : `can rejoin after ${v} days`);
    if (a !== b) settings.push(`after the journey, ${k.replace('_', ' ')}: ${w(a)} → ${w(b)}`);
  }

  const before = new Map(p.buckets.map((b) => [b.id, b]));
  const after = new Map(next.buckets.map((b) => [b.id, b]));
  const bucketsAdded = next.buckets.filter((b) => !before.has(b.id)).map((b) => b.name);
  const bucketsRemoved = p.buckets.filter((b) => !after.has(b.id)).map((b) => b.name);
  const bucketsChanged: BucketChange[] = [];
  for (const b of next.buckets) {
    const o = before.get(b.id);
    if (!o) continue;
    const steps = stepDiff(o.journey, b.journey);
    const ch: BucketChange = { id: b.id, name: b.name, steps };
    if (o.name !== b.name) ch.renamedFrom = o.name;
    if (JSON.stringify(o.rule) !== JSON.stringify(b.rule)) ch.ruleChanged = true;
    if (o.priority !== b.priority) ch.priorityChanged = true;
    if ((o.holdoutPct ?? 0) !== (b.holdoutPct ?? 0)) ch.holdout = { from: o.holdoutPct ?? 0, to: b.holdoutPct ?? 0 };
    if (ch.renamedFrom || ch.ruleChanged || ch.priorityChanged || ch.holdout || steps.added.length || steps.changed.length || steps.removed.length) bucketsChanged.push(ch);
  }
  let everyoneElse: CampaignDiff['everyoneElse'];
  const eeSteps = stepDiff(p.everyoneElse?.journey, next.everyoneElse?.journey);
  if ((p.everyoneElse?.approach ?? '') !== (next.everyoneElse?.approach ?? '') || eeSteps.added.length || eeSteps.changed.length || eeSteps.removed.length) {
    everyoneElse = { ...((p.everyoneElse?.approach ?? '') !== (next.everyoneElse?.approach ?? '') ? { approach: { from: p.everyoneElse?.approach ?? 'not decided', to: next.everyoneElse?.approach ?? 'not decided' } } : {}), steps: eeSteps };
  }
  const allSteps = [...bucketsChanged.map((c) => c.steps), ...(everyoneElse ? [everyoneElse.steps] : [])];
  return {
    settings,
    bucketsAdded,
    bucketsRemoved,
    bucketsChanged,
    ...(everyoneElse ? { everyoneElse } : {}),
    counts: {
      added: bucketsAdded.length + allSteps.reduce((n, s) => n + s.added.length, 0),
      changed: settings.length + bucketsChanged.filter((c) => c.renamedFrom || c.ruleChanged || c.holdout || c.priorityChanged).length + allSteps.reduce((n, s) => n + s.changed.length, 0),
      removed: bucketsRemoved.length + allSteps.reduce((n, s) => n + s.removed.length, 0),
    },
  };
}

export const isEmptyDiff = (d: CampaignDiff) => !d.counts.added && !d.counts.changed && !d.counts.removed;

/** A plain one-line summary from the diff alone (direct edits, rollbacks, and the fallback when the model is unavailable). */
export function templateSummary(d: CampaignDiff): string {
  const parts: string[] = [...d.settings];
  if (d.bucketsAdded.length) parts.push(`added bucket${d.bucketsAdded.length === 1 ? '' : 's'} ${d.bucketsAdded.map((n) => `"${n}"`).join(', ')}`);
  if (d.bucketsRemoved.length) parts.push(`removed bucket${d.bucketsRemoved.length === 1 ? '' : 's'} ${d.bucketsRemoved.map((n) => `"${n}"`).join(', ')}`);
  for (const c of d.bucketsChanged) {
    const bits = [
      c.renamedFrom ? `renamed from "${c.renamedFrom}"` : '',
      c.ruleChanged ? 'who is in it changed' : '',
      c.holdout ? `holdout ${c.holdout.from}% → ${c.holdout.to}%` : '',
      ...c.steps.changed.slice(0, 2),
      c.steps.added.length ? `${c.steps.added.length} step${c.steps.added.length === 1 ? '' : 's'} added` : '',
      c.steps.removed.length ? `${c.steps.removed.length} step${c.steps.removed.length === 1 ? '' : 's'} removed` : '',
    ].filter(Boolean);
    if (bits.length) parts.push(`"${c.name}": ${bits.join(', ')}`);
  }
  if (d.everyoneElse) parts.push('everyone else changed');
  const s = parts.join('; ');
  return s ? s[0].toUpperCase() + s.slice(1) : 'No changes';
}
