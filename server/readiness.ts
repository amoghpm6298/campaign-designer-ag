// Whether a draft can be submitted, and if not, why (in the manager's words).
// There is no "ready" state: anything not submitted is a draft, and a draft
// that can't be submitted yet says why (shown as a small icon on its card,
// and as canSubmit + notReady through the MCP). The submit itself still runs
// every check (submitChecked); this is the same answer shown ahead of time.
import { loadStores } from './campaignFiles';
import { approvalProblem, summarise, syncApprovals } from './approvals';
import { resolveTenant } from './tenants';

export function notReadyReasons(sessionId: string, tenantId: string, designed: boolean): string[] {
  const out: string[] = [];
  if (!designed) out.push("The designer hasn't finished building it.");
  try {
    const c = loadStores(sessionId).campaign;
    if (!c) return designed ? ['Nothing is built yet.'] : out;
    const waiting = approvalProblem(summarise(syncApprovals(sessionId, c, resolveTenant(tenantId))));
    if (waiting) out.push(waiting.split('. Every message')[0].replace(/^./, (x) => x.toUpperCase()) + '.');
  } catch {
    /* the submit check is still the gate */
  }
  return out;
}
