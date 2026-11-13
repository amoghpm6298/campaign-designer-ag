// "The manager wants a change on this block." The client sends which block
// (by its backend id); this turns it into plain words for the agent: where
// the block is, what it is now, and its current address for edit_journey.
// The agent never handles ids.
import { currentEntries } from '../../src/designer/v2/contextView';
import { findStep, stripJourneyIds } from './stepIds';
import { outline } from './state';
import type { AgentState, CampaignBucket } from './types';

export interface Focus {
  kind: 'step' | 'bucket' | 'entry' | 'goal' | 'everyone_else';
  /** A bucket id, or 'everyone_else' for that journey. */
  bucketId?: string;
  stepId?: string;
}

const describeStep = (s: Record<string, unknown>): string => {
  const k = String(s.kind);
  if (k === 'send') return `the ${(s.channelPreference as string[] | undefined)?.[0] ?? ''} message "${s.name ?? s.label ?? ''}"`;
  if (k === 'wait') return `the wait of ${s.durationHours} hours`;
  if (k === 'branch') return `the branch "${s.label ?? ''}"`;
  if (k === 'experiment') return `the A/B test "${s.label ?? ''}" (${((s.arms as { label?: string; pct?: number }[]) ?? []).map((a) => `${a.label} ${a.pct}%`).join(' vs ')})`;
  if (k === 'condition') return `the check "${s.label ?? ''}"`;
  if (k === 'waitForEvent') return `the wait for ${s.eventType}`;
  if (k === 'exit') return `the exit "${s.reason ?? ''}"`;
  return k;
};

function bucketReasoning(state: AgentState, bucketId: string): string {
  const notes = currentEntries(state.context.entries, { kind: 'bucket', bucketId });
  return notes.length ? notes.map((e) => `  - ${e.topic}: ${e.text}`).join('\n') : '  - (no reasoning on file)';
}

/** The status-block section for a focused block, or null if it cannot be found any more. */
export function focusSection(state: AgentState, focus: Focus | null | undefined): string | null {
  if (!focus) return null;
  const c = state.campaign;
  const bucketIndex = (id: string) => [...c.buckets].sort((a, b) => a.priority - b.priority).findIndex((b) => b.id === id);
  const head = '## The manager wants a change on this block\nTheir message is about this block. Make the change, then check the rest of the tree and change anything else that needs to change because of it (see "Changes, through chat").';

  if (focus.kind === 'entry' || focus.kind === 'goal') {
    const what = focus.kind === 'goal' ? `the campaign goal (${c.goal ? `${c.goal.eventType}, ${c.goal.eventCategory}` : 'not set'}): the check after every message that exits anyone who has reached it` : 'the entry: who can join the campaign, and whether it is one-time or recurring';
    return `${head}\n- Block: ${what}.\n- Now: ${JSON.stringify({ goal: c.goal, entry: c.entry, membership: c.membership })}\n- Change it with edit_campaign.`;
  }
  if (focus.kind === 'everyone_else' && !focus.stepId) {
    return `${head}\n- Block: "Everyone else", the customers who match no bucket.\n- Now: ${c.everyoneElse ? c.everyoneElse.approach : 'not decided'}${c.everyoneElse?.journey?.length ? `, journey:\n${outline(stripJourneyIds(c.everyoneElse.journey)).map((l) => `    ${l}`).join('\n')}` : ''}\n- Change it with edit_campaign (everyoneElse).`;
  }
  const bucket: CampaignBucket | undefined = focus.bucketId && focus.bucketId !== 'everyone_else' ? c.buckets.find((b) => b.id === focus.bucketId) : undefined;
  const laneName = focus.bucketId === 'everyone_else' ? 'Everyone else' : bucket ? `Bucket ${bucketIndex(bucket.id) + 1} "${bucket.name}" (id ${bucket.id})` : null;
  if (!laneName) return `${head}\n- The block they pointed at no longer exists (it was probably removed). Ask them what they meant.`;

  if (focus.kind === 'bucket' || !focus.stepId) {
    return `${head}\n- Block: ${laneName} as a whole: who is in it, its holdout and its journey.\n- Rule now: ${JSON.stringify(bucket?.rule ?? [])}; holdout ${bucket?.holdoutPct ?? 0}%\n- Its reasoning (context):\n${bucketReasoning(state, bucket!.id)}\n- Its journey now:\n${outline(stripJourneyIds(bucket?.journey)).map((l) => `    ${l}`).join('\n') || '    (none)'}`;
  }

  const journey = focus.bucketId === 'everyone_else' ? c.everyoneElse?.journey : bucket?.journey;
  const hit = findStep(journey, focus.stepId);
  if (!hit) return `${head}\n- The block they pointed at in ${laneName} no longer exists (it was probably removed or replaced). Ask them what they meant.`;
  const { id: _id, ...content } = hit.step;
  void _id;
  return [
    head,
    `- Block: ${[laneName, ...hit.trail, describeStep(hit.step)].join(' › ')}.`,
    `- Its address in that journey (for edit_journey): ${hit.path} (bucketId "${focus.bucketId}")`,
    `- Now: ${JSON.stringify(stripJourneyIds([content as never])?.[0])}`,
    ...(bucket ? [`- The bucket's reasoning (context):\n${bucketReasoning(state, bucket.id)}`] : []),
  ].join('\n');
}
