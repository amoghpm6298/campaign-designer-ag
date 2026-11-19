// Submitting a campaign for execution: one set of checks, used by the app's
// "Submit for execution" button and the MCP's submit_campaign alike.
import { checkJourneys } from './agent/compile';
import { directEdit } from './agent/directEdit';
import { daysBetween, longestPathHours, parseSchedule } from './agent/schedule';
import { LOCKED, loadChat, loadStores, loadSubmission, saveEngineCampaign, submitCampaign, type Submission } from './campaignFiles';
import { toEngineCampaign } from './engineExport';
import { isRunning } from './mcp/runner';
import { offerProblems } from './agent/offerChecks';
import { resolveTenant } from './tenants';

/**
 * Checks and submits. Dates passed in set (or change) the campaign's own dates
 * first, with the same rules as anywhere else. Refuses: a locked campaign, one
 * the designer is working on, one not built, no dates, a past start, an end
 * not after the start, a journey longer than the window, or anything broken.
 * `fixHint` ends refusals that need a change ("…with request_changes" for the
 * MCP, "…in the chat" for the app).
 */
export function submitChecked(
  sessionId: string,
  tenantId: string,
  by: string,
  dates: { startDate?: string; endDate?: string } = {},
  fixHint = 'ask for the change in the chat',
): { ok: true; submission: Submission } | { ok: false; error: string } {
  if (loadSubmission(sessionId)) return { ok: false, error: LOCKED };
  if (isRunning(sessionId)) return { ok: false, error: 'The designer is still working on this campaign. Submit it once it has finished.' };
  const chat = loadChat(sessionId) as { tenantId?: string; lastBuilt?: boolean; state?: { flags?: { campaignBuilt?: boolean } } } | null;
  if (chat?.tenantId && chat.tenantId !== tenantId) return { ok: false, error: 'This campaign belongs to another bank.' };
  if (!(chat?.lastBuilt || chat?.state?.flags?.campaignBuilt)) return { ok: false, error: 'Only a ready (built) campaign can be submitted.' };
  if (dates.startDate !== undefined || dates.endDate !== undefined) {
    const cur = loadStores(sessionId).campaign?.schedule;
    const r = directEdit(sessionId, tenantId, { op: 'schedule', startDate: String(dates.startDate ?? cur?.startDate ?? ''), endDate: String(dates.endDate ?? cur?.endDate ?? '') });
    if (!r.ok) return { ok: false, error: `Not submitted: ${r.error}` };
  }
  const c = loadStores(sessionId).campaign;
  if (!c) return { ok: false, error: 'There is no campaign yet.' };
  const sch = c.schedule;
  if (!sch) return { ok: false, error: 'Not submitted: the campaign has no start and end dates. Give a startDate and an endDate (YYYY-MM-DD).' };
  const checked = parseSchedule(sch);
  if ('error' in checked) return { ok: false, error: `Not submitted: ${checked.error.replace(' Nothing was changed.', '')} Give new dates.` };
  const windowDays = daysBetween(sch.startDate, sch.endDate);
  const tooLong = [...c.buckets.map((b) => ({ name: b.name, journey: b.journey })), ...(c.everyoneElse?.approach === 'journey' ? [{ name: 'Everyone else', journey: c.everyoneElse.journey }] : [])]
    .map((l) => ({ name: l.name, days: Math.ceil(longestPathHours(l.journey) / 24) }))
    .filter((l) => l.days > windowDays);
  if (tooLong.length)
    return { ok: false, error: `Not submitted: the campaign runs ${windowDays} days (${sch.startDate} → ${sch.endDate}), but ${tooLong.map((l) => `"${l.name}" takes about ${l.days} days`).join(', ')}. Give later dates, or ${fixHint} for shorter journeys.` };
  const broken = [...checkJourneys(c, undefined, true, true), ...offerProblems(c, loadStores(sessionId).context, resolveTenant(tenantId)).problems];
  if (broken.length) return { ok: false, error: `Not submitted: these need fixing first (${fixHint}):\n- ${broken.join('\n- ')}` };
  // What the engine runs: only its fields, checked, then frozen with the submission.
  const exported = toEngineCampaign(c, resolveTenant(tenantId));
  if (exported.problems.length) return { ok: false, error: `Not submitted: the engine version has problems (${fixHint}):\n- ${exported.problems.join('\n- ')}` };
  const submission = submitCampaign(sessionId, tenantId, by, sch);
  saveEngineCampaign(sessionId, tenantId, { ...exported.engine, submittedAt: submission.at, submittedBy: by });
  return { ok: true, submission };
}
