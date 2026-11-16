// Where a submitted campaign is in its life, from its submitted dates and
// today's date (India): scheduled before it starts, active between its dates,
// ended after. Shared by the server (MCP, Campaigns list) and the app.
// Nothing executes campaigns yet, so "active" means "inside its dates".

export type SubmittedStage = 'scheduled' | 'active' | 'ended' | 'submitted';

export const todayInIndia = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** `submitted` when the submission has no dates (submitted before dates existed). */
export function submittedStage(sub: { startDate?: string; endDate?: string } | null | undefined, now = new Date()): SubmittedStage {
  if (!sub?.startDate || !sub.endDate) return 'submitted';
  const today = todayInIndia(now);
  if (today < sub.startDate) return 'scheduled';
  if (today > sub.endDate) return 'ended';
  return 'active';
}

export const STAGE_LABEL: Record<SubmittedStage, string> = { scheduled: 'Scheduled', active: 'Active', ended: 'Ended', submitted: 'Submitted' };
