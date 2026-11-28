// Where a submitted campaign is in its life, from its submitted dates and
// today's date (India): scheduled before it starts, active between its dates,
// ended after. Shared by the server (MCP, Campaigns list) and the app.
// Nothing executes campaigns yet, so "active" means "inside its dates".

export type SubmittedStage = 'scheduled' | 'active' | 'ended' | 'submitted';

export const todayInIndia = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * `submitted` when the submission has no dates (submitted before dates existed).
 * A flow has a start date and no end date: active from its start until stopped.
 */
export function submittedStage(sub: { startDate?: string; endDate?: string } | null | undefined, now = new Date()): SubmittedStage {
  if (!sub?.startDate) return 'submitted';
  const today = todayInIndia(now);
  if (today < sub.startDate) return 'scheduled';
  if (sub.endDate && today > sub.endDate) return 'ended';
  return 'active';
}

/** A flow that was live and has been stopped (taken back; it can go live again). */
export type ItemState = 'draft' | 'scheduled' | 'active' | 'ended' | 'stopped';

/** The words for a state, by kind: a running flow is "Live", a running campaign "Active". */
export function stateLabel(state: string, kind: 'flow' | 'campaign'): string {
  if (state === 'active') return kind === 'flow' ? 'Live' : 'Active';
  return ({ draft: 'Draft', scheduled: 'Scheduled', ended: 'Ended', stopped: 'Stopped', submitted: 'Submitted' } as Record<string, string>)[state] ?? state;
}

export const STAGE_LABEL: Record<SubmittedStage, string> = { scheduled: 'Scheduled', active: 'Active', ended: 'Ended', submitted: 'Submitted' };
