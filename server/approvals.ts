// Comm approvals (Smart Engage 2.0): every message a customer would read is
// approved by the bank before the campaign can run. The designer drafts; a
// person at the bank approves, edits and approves, or rejects with a reason.
//
// What is approved is a message's content as the customer sees it: channel,
// copy, CTA, link reference and the system's offer line. Its fingerprint is a
// hash of that content, so any change to the words makes it a new message,
// pending again: an approval never carries over to different words. The same
// content on several paths shares one fingerprint and one decision.
//
//   <CAMPAIGN_DIR>/../approvals/<sessionId>.json
//
// A message's status is looked up by its current fingerprint, never stored on
// the step. syncApprovals() adds new messages as pending, keeps decisions, and
// moves records no message uses any more to the history (the audit trail).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { campaignDir } from './campaignFiles';
import { incentivesFor } from './incentives';
import { walkSteps } from './agent/stepIds';
import type { BpStep } from './blueprint';
import type { CampaignObject } from './agent/types';
import type { TenantConfig } from './tenants';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface MessageContent {
  channel: string;
  copy: string;
  cta: string;
  link: string;
  offerLine: string;
}

export interface MessageUse {
  bucketId: string;
  bucketName: string;
  stepId: string;
  name: string;
}

export interface ApprovalRecord {
  fp: string;
  content: MessageContent;
  status: ApprovalStatus;
  uses: MessageUse[];
  /** When it first came into the queue. */
  queuedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Why it was rejected (required on reject). */
  reason?: string;
}

interface ApprovalFile {
  records: Record<string, ApprovalRecord>;
  /** Records no message uses any more, kept for the audit trail (newest last, capped). */
  history: ApprovalRecord[];
}

const HISTORY_CAP = 200;

export function approvalsDir(): string {
  return process.env.APPROVALS_DIR ? resolve(process.env.APPROVALS_DIR) : resolve(dirname(campaignDir()), 'approvals');
}

const fileFor = (sessionId: string, dir: string) => {
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(sessionId)) throw new Error('Not a valid campaign id.');
  return join(dir, `${sessionId}.json`);
};

function load(sessionId: string, dir: string): ApprovalFile {
  const p = fileFor(sessionId, dir);
  if (!existsSync(p)) return { records: {}, history: [] };
  try {
    const f = JSON.parse(readFileSync(p, 'utf8')) as Partial<ApprovalFile>;
    return { records: f.records ?? {}, history: f.history ?? [] };
  } catch {
    return { records: {}, history: [] };
  }
}

function save(sessionId: string, f: ApprovalFile, dir: string): void {
  const p = fileFor(sessionId, dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 1));
  renameSync(tmp, p);
}

export const fingerprint = (c: MessageContent) => createHash('sha1').update(JSON.stringify([c.channel, c.copy.trim(), c.cta.trim(), c.link, c.offerLine])).digest('hex').slice(0, 16);

/** Every message in the campaign, with its content and fingerprint. A message with no copy yet is left out. */
export function messagesOf(campaign: CampaignObject, tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null): (MessageUse & { fp: string; content: MessageContent })[] {
  const offers = incentivesFor(tenant);
  const lanes = [
    ...campaign.buckets.map((b) => ({ id: b.id, name: b.name, journey: b.journey })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ id: 'everyone_else', name: 'Everyone else', journey: campaign.everyoneElse.journey }] : []),
  ];
  const out: (MessageUse & { fp: string; content: MessageContent })[] = [];
  for (const lane of lanes) {
    walkSteps(lane.journey as BpStep[] | null | undefined, (s) => {
      if (s.kind !== 'send') return;
      const copy = String(s.copy ?? '').trim();
      if (!copy) return;
      const content: MessageContent = {
        channel: String(((s.channelPreference as string[] | undefined) ?? [])[0] ?? 'SMS'),
        copy,
        cta: String(s.cta ?? '').trim(),
        link: String(s.link ?? ''),
        offerLine: typeof s.incentive === 'string' ? (offers.find((o) => o.id === s.incentive)?.offerLine ?? '') : '',
      };
      out.push({ bucketId: lane.id, bucketName: lane.name, stepId: String(s.id ?? ''), name: String(s.name ?? s.label ?? 'Message'), fp: fingerprint(content), content });
    });
  }
  return out;
}

/** Brings the queue in line with the campaign: new messages pending, decisions kept, unused records to history. */
export function syncApprovals(sessionId: string, campaign: CampaignObject, tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null, dir = approvalsDir()): ApprovalRecord[] {
  const f = load(sessionId, dir);
  const now = new Date().toISOString();
  const msgs = messagesOf(campaign, tenant);
  const byFp = new Map<string, typeof msgs>();
  for (const m of msgs) byFp.set(m.fp, [...(byFp.get(m.fp) ?? []), m]);
  const next: Record<string, ApprovalRecord> = {};
  for (const [fp, uses] of byFp) {
    const prev = f.records[fp];
    next[fp] = { ...(prev ?? { fp, content: uses[0].content, status: 'pending' as const, queuedAt: now }), uses: uses.map(({ bucketId, bucketName, stepId, name }) => ({ bucketId, bucketName, stepId, name })) };
  }
  const gone = Object.values(f.records).filter((r) => !next[r.fp]);
  const changed = gone.length || Object.keys(next).length !== Object.keys(f.records).length || Object.values(next).some((r) => JSON.stringify(r) !== JSON.stringify(f.records[r.fp]));
  if (changed) save(sessionId, { records: next, history: [...f.history, ...gone].slice(-HISTORY_CAP) }, dir);
  return Object.values(next);
}

/** The current queue for a campaign (after syncing it with the campaign). */
export const approvalsFor = syncApprovals;

export interface ApprovalSummary {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  rejectedList: { name: string; bucketName: string; reason: string }[];
}

export function summarise(records: ApprovalRecord[]): ApprovalSummary {
  const count = (s: ApprovalStatus) => records.filter((r) => r.status === s).length;
  return {
    total: records.length,
    approved: count('approved'),
    pending: count('pending'),
    rejected: count('rejected'),
    rejectedList: records.filter((r) => r.status === 'rejected').map((r) => ({ name: r.uses[0]?.name ?? 'Message', bucketName: r.uses[0]?.bucketName ?? '', reason: r.reason ?? '' })),
  };
}

/** Why the campaign can't be submitted yet, or null when every message is approved. */
export function approvalProblem(s: ApprovalSummary): string | null {
  if (s.total && s.approved === s.total) return null;
  if (!s.total) return null;
  const parts = [s.pending ? `${s.pending} message${s.pending === 1 ? ' is' : 's are'} waiting for approval` : '', s.rejected ? `${s.rejected} ${s.rejected === 1 ? 'was' : 'were'} rejected` : ''].filter(Boolean);
  return `${parts.join(' and ')}. Every message must be approved in Comm approvals before the campaign can be submitted.`;
}

/** Approves or rejects one message (by fingerprint). A reject needs a reason. */
export function decide(sessionId: string, fp: string, action: 'approve' | 'reject', by: string, reason?: string, dir = approvalsDir()): { ok: boolean; error?: string } {
  const f = load(sessionId, dir);
  const r = f.records[fp];
  if (!r) return { ok: false, error: 'That message is no longer in the campaign.' };
  if (action === 'reject' && !String(reason ?? '').trim()) return { ok: false, error: 'Say why it is rejected, so the designer can rewrite it.' };
  f.records[fp] = { ...r, status: action === 'approve' ? 'approved' : 'rejected', decidedBy: by, decidedAt: new Date().toISOString(), ...(action === 'reject' ? { reason: String(reason).trim() } : { reason: undefined }) };
  save(sessionId, f, dir);
  return { ok: true };
}

/** For the designer's status: one line, plus the rejected messages and why. */
export function approvalsLine(s: ApprovalSummary): string {
  if (!s.total) return '- No messages with copy yet.';
  const lines = [`- ${s.approved} approved, ${s.pending} waiting, ${s.rejected} rejected (of ${s.total} distinct messages).`];
  for (const r of s.rejectedList) lines.push(`- Rejected: "${r.name}" in ${r.bucketName}. Reason: ${r.reason}`);
  return lines.join('\n');
}
