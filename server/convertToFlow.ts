// "Convert to flow": a one-time campaign, at any stage, becomes the starting
// point of a new always-on flow. Campaigns are the sandbox; what worked
// graduates. The whole campaign (buckets, journeys, messages, the designer's
// reasoning, approved messages) is copied into a new flow, and the flow
// designer is then asked, in the manager's name, to convert it, with the
// manager's own note first. The campaign itself is never changed; the two are
// linked both ways (origin on the flow, conversions.json beside the campaign).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { campaignDir, loadStores, loadSubmission, loadWithdrawals, saveCampaignObject, saveContext, sessionFolder } from './campaignFiles';
import { carryApprovals } from './approvals';
import { resolveTenant } from './tenants';
import { kindOf } from '../src/designer/v2/kind';
import { submittedStage } from '../src/designer/v2/lifecycle';
import type { CampaignObject, ContextEntry } from './agent/types';

/** Where a converted flow came from, kept on the flow. */
export interface FlowOrigin {
  fromId: string;
  fromName: string;
  /** The manager's note for the designer, if any. */
  note?: string;
  by: string;
  at: string;
}

/** A conversion, kept beside the campaign (its campaign.json may be locked). */
export interface Conversion {
  toId: string;
  toName: string;
  note?: string;
  by: string;
  at: string;
}

export function loadConversions(sessionId: string, dir = campaignDir()): Conversion[] {
  const p = join(sessionFolder(sessionId, dir), 'conversions.json');
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Conversion[]) : [];
  } catch {
    return [];
  }
}

/** Has the campaign actually run: live now, ended, or submitted once and stopped since. A never-run draft has proven nothing. */
export function hasRun(sessionId: string, dir = campaignDir()): boolean {
  const sub = loadSubmission(sessionId, dir);
  if (sub) {
    const st = submittedStage(sub);
    return st === 'active' || st === 'ended' || st === 'submitted';
  }
  return loadWithdrawals(sessionId, dir).length > 0;
}

/** The message sent to the flow designer, in the manager's name, as the new flow's first turn. */
export function conversionBrief(fromName: string, note: string): string {
  return [
    `Convert the one-time campaign "${fromName}" into this always-on flow. Everything from it is already here: its buckets, journeys, messages and reasoning.`,
    'Keep who each bucket is for and the lever that worked; adapt the rest to how a flow runs. Keep the name I gave it, and keep message wording that is still true for anyone joining at any time.',
    ...(note ? [`My note: ${note}`] : []),
  ].join('\n\n');
}

export function convertToFlow(
  fromId: string,
  tenantId: string,
  opts: { name: string; note?: string; by: string },
  dir = campaignDir(),
): { sessionId: string; name: string; brief: string; intent: string | null; productId: string | null } {
  const from = loadStores(fromId, dir);
  const c = from.campaign;
  const owner = (() => {
    try {
      return (JSON.parse(readFileSync(join(sessionFolder(fromId, dir), 'campaign.json'), 'utf8')) as { tenantId?: string }).tenantId;
    } catch {
      return undefined;
    }
  })();
  if (!c) throw new Error('No such campaign.');
  if (owner && owner !== tenantId) throw new Error('This campaign belongs to another bank.');
  if (kindOf(c) !== 'campaign') throw new Error('Only a one-time campaign can be converted into a flow.');
  if (!c.buckets.some((b) => b.journey?.length)) throw new Error('This campaign has nothing built to convert yet.');
  const name = opts.name.trim();
  if (!name) throw new Error('Give the flow a name.');
  const note = (opts.note ?? '').trim();
  const at = new Date().toISOString();
  const fromName = c.name || 'the campaign';

  const sessionId = `cv-${Date.now().toString(36)}`;
  const origin: FlowOrigin = { fromId, fromName, ...(note ? { note } : {}), by: opts.by, at };
  // The whole campaign, as a flow: open membership, no dates or budget yet (the designer sets a start and a monthly cap),
  // nothing about coming back yet (the designer decides it). Buckets, journeys and step ids exactly as they were.
  const flow: CampaignObject = {
    ...c,
    name,
    kind: 'flow',
    membership: { type: 'open', refresh: 'weekly' },
    schedule: null,
    budgetCap: null,
    afterJourney: null,
    maxAttempts: null,
    origin,
  };
  saveCampaignObject(sessionId, tenantId, flow, dir);
  // The designer's reasoning comes along, with a note on where the flow came from.
  const entries: ContextEntry[] = [
    ...(from.context?.entries ?? []),
    {
      id: `conv-${Date.now().toString(36)}`,
      at,
      kind: 'note',
      topic: 'converted from',
      text: `Converted from the one-time campaign "${fromName}" (${fromId}) by ${opts.by}.${note ? ` Their note: ${note}` : ''}`,
      source: 'manager',
    } as ContextEntry,
  ];
  saveContext(sessionId, tenantId, { entries }, dir);
  // Messages the bank already approved stay approved while their words stay the same.
  carryApprovals(fromId, sessionId, flow, resolveTenant(tenantId));
  // The campaign keeps a record of what it became.
  const conv: Conversion = { toId: sessionId, toName: name, ...(note ? { note } : {}), by: opts.by, at };
  const folder = sessionFolder(fromId, dir);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'conversions.json'), JSON.stringify([...loadConversions(fromId, dir), conv], null, 1));
  return { sessionId, name, brief: conversionBrief(fromName, note), intent: c.intent ?? null, productId: c.productId ?? null };
}
