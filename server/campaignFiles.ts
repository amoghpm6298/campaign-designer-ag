// The two stores on disk. One chat is one campaign, so both are keyed by the
// chat's session id and nobody ever handles a campaign id.
//
//   <CAMPAIGN_DIR>/<sessionId>/campaign.json  — the CAMPAIGN OBJECT: what the
//                                               core engine executes, nothing else
//   <CAMPAIGN_DIR>/<sessionId>/context.json   — the CAMPAIGN CONTEXT: answers,
//                                               brief, reasoning, sizing, research,
//                                               later metrics; append-only
//
// They are linked by the folder (and context entries by bucket id), never
// mixed. The conversation itself stays with the chat.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BpAudienceGroup, BpStep } from './blueprint';
import { ensureIds } from './agent/stepIds';
import type { CampaignBucket, CampaignContext, CampaignObject, ContextEntry } from './agent/types';

const here = dirname(fileURLToPath(import.meta.url));

interface Stamped<T> {
  sessionId: string;
  tenantId: string;
  updatedAt: string;
  body: T;
}

export interface Stores {
  campaign: CampaignObject | null;
  context: CampaignContext | null;
}

export function campaignDir(): string {
  return process.env.CAMPAIGN_DIR ? resolve(process.env.CAMPAIGN_DIR) : resolve(here, '../data/campaigns');
}

const SESSION_ID = /^[a-z0-9-]{1,64}$/i;

/** The folder for a session. Throws for anything that is not a plain session id, so no path can escape. */
export function sessionFolder(sessionId: string, dir = campaignDir()): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('Not a valid session id.');
  return join(dir, sessionId);
}

function readStamped<T>(path: string): Stamped<T> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Stamped<T>;
  } catch {
    return null;
  }
}

/** Temp file, then rename over the old one: a crash never leaves half a file. */
function writeStamped<T>(path: string, sessionId: string, tenantId: string, body: T): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sessionId, tenantId, updatedAt: new Date().toISOString(), body } satisfies Stamped<T>, null, 1));
  renameSync(tmp, path);
}

export function loadStores(sessionId: string, dir = campaignDir()): Stores {
  migrateLegacy(sessionId, dir);
  const folder = sessionFolder(sessionId, dir);
  const stamped = readStamped<CampaignObject>(join(folder, 'campaign.json'));
  let campaign = stamped?.body ?? null;
  // Every step carries a stable id; campaigns saved before ids existed get them now.
  if (campaign) {
    const used = new Set<string>();
    let changed = false;
    const buckets = campaign.buckets.map((b) => {
      const r = ensureIds(b.journey, used);
      changed ||= r.changed;
      return { ...b, journey: r.steps };
    });
    const ee = campaign.everyoneElse?.journey ? ensureIds(campaign.everyoneElse.journey, used) : null;
    if (ee?.changed) changed = true;
    if (changed) {
      campaign = { ...campaign, buckets, everyoneElse: campaign.everyoneElse ? { ...campaign.everyoneElse, ...(ee ? { journey: ee.steps ?? undefined } : {}) } : null };
      saveCampaignObject(sessionId, stamped?.tenantId ?? '', campaign, dir);
    }
  }
  return { campaign, context: readStamped<CampaignContext>(join(folder, 'context.json'))?.body ?? null };
}

export function saveCampaignObject(sessionId: string, tenantId: string, campaign: CampaignObject, dir = campaignDir()): void {
  writeStamped(join(sessionFolder(sessionId, dir), 'campaign.json'), sessionId, tenantId, campaign);
}

export function saveContext(sessionId: string, tenantId: string, context: CampaignContext, dir = campaignDir()): void {
  writeStamped(join(sessionFolder(sessionId, dir), 'context.json'), sessionId, tenantId, context);
}

// --- one-time migration from the single mixed file ------------------------------

interface LegacyFile {
  tenantId?: string;
  updatedAt?: string;
  campaign?: {
    brief?: { findings?: { aspect: string; text: string; source: string }[]; summary?: string };
    campaign?: (Partial<CampaignObject> & { segmentationLogic?: string; guardrails?: string; measurement?: string; everyoneElse?: { approach: 'journey' | 'none'; why?: string; journey?: BpStep[] } | null }) | null;
    buckets?: {
      id: string;
      name: string;
      priority: number;
      rule: BpAudienceGroup[];
      holdoutPct?: number;
      journey: BpStep[] | null;
      behaviour?: string;
      thesis?: string;
      evidence?: string;
      evidenceNotes?: string;
      metric?: string;
      sql?: string;
      size?: number;
      sizeError?: string;
    }[];
  };
}

/** Splits an old mixed plan file into the two stores. Pure, exported for tests. */
export function splitLegacy(file: LegacyFile): { campaign: CampaignObject; context: CampaignContext } {
  const pf = file.campaign ?? {};
  const shell = pf.campaign ?? null;
  const at = file.updatedAt ?? new Date().toISOString();
  const entries: ContextEntry[] = [];
  const add = (e: Omit<ContextEntry, 'id' | 'at'>) => entries.push({ id: `c${entries.length + 1}`, at, ...e });
  const src = (s: string): ContextEntry['source'] => (s === 'manager' || s === 'data' || s === 'assumption' ? s : 'agent');
  for (const f of pf.brief?.findings ?? []) add({ kind: 'brief', topic: f.aspect, text: f.text, source: src(f.source) });
  if (pf.brief?.summary) add({ kind: 'brief', topic: 'Summary', text: pf.brief.summary, source: 'agent' });
  if (shell?.segmentationLogic) add({ kind: 'note', topic: 'segmentation', text: shell.segmentationLogic, source: 'agent' });
  if (shell?.measurement) add({ kind: 'note', topic: 'measurement', text: shell.measurement, source: 'agent' });
  if (shell?.guardrails) add({ kind: 'note', topic: 'guardrails', text: shell.guardrails, source: 'agent' });
  if (shell?.everyoneElse?.why) add({ kind: 'note', topic: 'everyone_else', text: shell.everyoneElse.why, source: 'agent' });
  const buckets: CampaignBucket[] = (pf.buckets ?? []).map((b) => {
    if (b.behaviour) add({ kind: 'bucket', bucketId: b.id, topic: 'behaviour', text: b.behaviour, source: 'agent' });
    if (b.thesis) add({ kind: 'bucket', bucketId: b.id, topic: 'thesis', text: b.thesis, source: 'agent' });
    if (b.evidence || b.evidenceNotes) add({ kind: 'bucket', bucketId: b.id, topic: 'evidence', text: b.evidenceNotes ?? '', source: 'agent', data: { level: b.evidence ?? 'hypothesis' } });
    if (b.metric) add({ kind: 'bucket', bucketId: b.id, topic: 'metric', text: b.metric, source: 'agent' });
    if (b.sql || b.size !== undefined || b.sizeError)
      add({ kind: 'sizing', bucketId: b.id, topic: 'size', text: '', source: 'data', data: { ...(b.sql ? { sql: b.sql } : {}), ...(b.size !== undefined ? { size: b.size } : {}), ...(b.sizeError ? { error: b.sizeError } : {}) } });
    return { id: b.id, name: b.name, priority: b.priority, rule: b.rule ?? [], ...(b.holdoutPct !== undefined ? { holdoutPct: b.holdoutPct } : {}), journey: b.journey ?? null };
  });
  return {
    campaign: {
      ...(shell?.name ? { name: shell.name } : {}),
      ...(shell?.description ? { description: shell.description } : {}),
      goal: shell?.goal ?? null,
      entry: shell?.entry ?? null,
      membership: shell?.membership ?? null,
      buckets,
      everyoneElse: shell?.everyoneElse ? { approach: shell.everyoneElse.approach, ...(shell.everyoneElse.journey ? { journey: shell.everyoneElse.journey } : {}) } : null,
    },
    context: { entries },
  };
}

function migrateLegacy(sessionId: string, dir: string): void {
  const folder = sessionFolder(sessionId, dir);
  const legacy = join(dir, `${sessionId}.json`);
  if (existsSync(folder) || !existsSync(legacy)) return;
  try {
    const file = JSON.parse(readFileSync(legacy, 'utf8')) as LegacyFile;
    const { campaign, context } = splitLegacy(file);
    const tenantId = file.tenantId ?? '';
    saveCampaignObject(sessionId, tenantId, campaign, dir);
    saveContext(sessionId, tenantId, context, dir);
    unlinkSync(legacy);
  } catch (e) {
    console.error(`[campaign] could not migrate ${sessionId}: ${(e as Error).message}`);
  }
}

// --- the conversation, per campaign -----------------------------------------------
//
// <CAMPAIGN_DIR>/<sessionId>/chat.json — the chat that built the campaign
// (messages, questions, flags, timeline, last-change markers), so a campaign
// reopens from the Campaigns page exactly as it was left. Separate from the
// campaign object and the context; never read by the engine.

export function loadChat(sessionId: string, dir = campaignDir()): unknown | null {
  return readStamped<unknown>(join(sessionFolder(sessionId, dir), 'chat.json'))?.body ?? null;
}

export function saveChat(sessionId: string, tenantId: string, chat: unknown, dir = campaignDir()): void {
  writeStamped(join(sessionFolder(sessionId, dir), 'chat.json'), sessionId, tenantId, chat);
}

/**
 * Deletes a campaign from the Campaigns page. The folder is moved into
 * `.deleted/` (not erased), so a mistaken delete can still be recovered by hand.
 * Refuses a campaign that belongs to another bank.
 */
export function deleteCampaign(sessionId: string, tenantId: string, dir = campaignDir()): void {
  const folder = sessionFolder(sessionId, dir);
  if (!existsSync(folder)) throw new Error('No such campaign.');
  const owner = readStamped<unknown>(join(folder, 'campaign.json'))?.tenantId || readStamped<unknown>(join(folder, 'chat.json'))?.tenantId;
  if (owner && owner !== tenantId) throw new Error('This campaign belongs to another bank.');
  const bin = join(dir, '.deleted');
  mkdirSync(bin, { recursive: true });
  renameSync(folder, join(bin, `${sessionId}-${Date.now()}`));
}

export interface CampaignSummary {
  sessionId: string;
  tenantId: string;
  name: string;
  ask: string;
  built: boolean;
  buckets: number;
  messages: number;
  membership: 'one-time' | 'recurring' | null;
  refresh?: string;
  version: number;
  updatedAt: string;
}

/** Every saved campaign for a bank, newest first: what the Campaigns page shows. */
export function listCampaigns(tenantId: string, dir = campaignDir()): CampaignSummary[] {
  if (!existsSync(dir)) return [];
  const out: CampaignSummary[] = [];
  for (const name of readdirSync(dir)) {
    const folder = join(dir, name);
    if (!SESSION_ID.test(name) || !statSync(folder).isDirectory()) continue;
    const camp = readStamped<CampaignObject>(join(folder, 'campaign.json'));
    const chat = readStamped<{ turns?: { role: string; content: string; auto?: boolean }[]; state?: { flags?: { campaignBuilt?: boolean } } }>(join(folder, 'chat.json'));
    const tid = camp?.tenantId || chat?.tenantId;
    if (tid !== tenantId) continue;
    const c = camp?.body;
    let messages = 0;
    const count = (steps: BpStep[] | null | undefined) =>
      (steps ?? []).forEach((s) => {
        const r = s as unknown as { kind?: string; arms?: { steps?: BpStep[] }[]; paths?: { steps?: BpStep[] }[]; yes?: BpStep[]; no?: BpStep[] };
        if (r.kind === 'send') messages++;
        r.arms?.forEach((a) => count(a.steps));
        r.paths?.forEach((p) => count(p.steps));
        count(r.yes);
        count(r.no);
      });
    c?.buckets.forEach((b) => count(b.journey));
    count(c?.everyoneElse?.journey);
    let version = 0;
    try {
      const idx = JSON.parse(readFileSync(join(folder, 'versions', 'index.json'), 'utf8')) as { n: number }[];
      version = idx.length ? idx[idx.length - 1].n : 0;
    } catch {
      /* no versions yet */
    }
    const firstAsk = chat?.body?.turns?.find((t) => t.role === 'user' && !t.auto)?.content ?? '';
    out.push({
      sessionId: name,
      tenantId,
      name: c?.name || (firstAsk ? firstAsk.slice(0, 60) : 'Untitled campaign'),
      ask: firstAsk.slice(0, 160),
      // Built if the chat says so, or if it has versions (only a built campaign is versioned).
      built: !!chat?.body?.state?.flags?.campaignBuilt || version > 0,
      buckets: c?.buckets.length ?? 0,
      messages,
      membership: c?.membership ? (c.membership.type === 'open' ? 'recurring' : 'one-time') : null,
      ...(c?.membership?.type === 'open' ? { refresh: c.membership.refresh ?? 'weekly' } : {}),
      version,
      updatedAt: [camp?.updatedAt, chat?.updatedAt].filter(Boolean).sort().pop() ?? '',
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
