// Versions of the campaign object, so any change can be viewed and rolled back.
//
//   <CAMPAIGN_DIR>/<sessionId>/versions/v0007.json   one full version
//   <CAMPAIGN_DIR>/<sessionId>/versions/index.json   the list the dropdown shows
//
// One version per change event: an agent turn that changed the campaign, a
// direct edit, or a rollback. A rollback creates a new version; history is
// never rewritten. Only the campaign object is versioned: the context is
// already append-only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callClaude, hasApiKey } from './anthropic';
import { campaignDir, sessionFolder } from './campaignFiles';
import { diffCampaigns, isEmptyDiff, templateSummary, type CampaignDiff } from './agent/versionDiff';
import type { CampaignObject } from './agent/types';

export type VersionSource = 'chat' | 'direct' | 'rollback' | 'migration' | 'repair';

export interface VersionEntry {
  n: number;
  at: string;
  source: VersionSource;
  /** The manager's words, or a description of the direct edit. */
  request: string;
  summary: string;
  counts: CampaignDiff['counts'];
}

export interface Version extends VersionEntry {
  campaign: CampaignObject;
  diff: CampaignDiff;
}

const SUMMARY_MODEL = 'claude-haiku-5-5';

const folder = (sessionId: string, dir: string) => join(sessionFolder(sessionId, dir), 'versions');
const file = (n: number) => `v${String(n).padStart(4, '0')}.json`;

function writeAtomic(path: string, body: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 1));
  renameSync(tmp, path);
}

export function listVersions(sessionId: string, dir = campaignDir()): VersionEntry[] {
  const p = join(folder(sessionId, dir), 'index.json');
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as VersionEntry[];
  } catch {
    return [];
  }
}

export function getVersion(sessionId: string, n: number, dir = campaignDir()): Version | null {
  const p = join(folder(sessionId, dir), file(n));
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Version;
  } catch {
    return null;
  }
}

/**
 * Records a new version if the campaign actually changed since the last one.
 * Returns the new entry, or null when nothing changed.
 */
export function recordVersion(
  args: { sessionId: string; campaign: CampaignObject; source: VersionSource; request: string; summary?: string },
  dir = campaignDir(),
): Version | null {
  const list = listVersions(args.sessionId, dir);
  const last = list.length ? getVersion(args.sessionId, list[list.length - 1].n, dir) : null;
  const diff = diffCampaigns(last?.campaign ?? null, args.campaign);
  if (last && isEmptyDiff(diff)) return null;
  const n = (list[list.length - 1]?.n ?? 0) + 1;
  const v: Version = {
    n,
    at: new Date().toISOString(),
    source: args.source,
    request: args.request.slice(0, 500),
    summary: args.summary ?? templateSummary(diff),
    counts: diff.counts,
    campaign: args.campaign,
    diff,
  };
  const f = folder(args.sessionId, dir);
  mkdirSync(f, { recursive: true });
  writeAtomic(join(f, file(n)), v);
  const { campaign: _c, diff: _d, ...entry } = v;
  void _c;
  void _d;
  writeAtomic(join(f, 'index.json'), [...list, entry]);
  return v;
}

/** Replaces a version's summary (the model's one arrives after the version is saved). */
export function setSummary(sessionId: string, n: number, summary: string, dir = campaignDir()): void {
  const v = getVersion(sessionId, n, dir);
  if (!v) return;
  const f = folder(sessionId, dir);
  writeAtomic(join(f, file(n)), { ...v, summary });
  writeAtomic(join(f, 'index.json'), listVersions(sessionId, dir).map((e) => (e.n === n ? { ...e, summary } : e)));
}

/**
 * One or two lines on what changed, written by a small model from the code
 * diff and the manager's request only — so it cannot invent a change. Falls
 * back to the plain template if the model is unavailable.
 */
export async function summariseVersion(diff: CampaignDiff, request: string): Promise<string> {
  const fallback = templateSummary(diff);
  if (!hasApiKey()) return fallback;
  try {
    const r = await callClaude({
      model: SUMMARY_MODEL,
      maxTokens: 1000,
      timeoutMs: 30_000,
      system:
        'You write the one-line summary for a version of a marketing campaign, shown in a version history list. State what changed, as a plain statement (e.g. "The benefit reminder in No activation at all now links to the rewards page; its copy was tightened to match."). Use ONLY the changes listed; never add, guess or embellish, and when a step only says "updated", say it was updated without guessing how. Never mention the diff, the data or what you can or cannot confirm. Plain words a campaign manager understands, no ids, no JSON, no link references in snake_case (say "the rewards page"). At most two short sentences, under 30 words. No preamble.',
      messages: [{ role: 'user', content: `What the manager asked: ${request || '(no message)'}\n\nWhat actually changed (computed by code):\n${JSON.stringify(diff)}` }],
    });
    const text = r.text.trim().replace(/^["']|["']$/g, '');
    if (!text) console.error(`[versions] summary model returned no text (stop: ${r.stopReason})`);
    return text || fallback;
  } catch (e) {
    console.error(`[versions] summary model failed, using the plain summary: ${(e as Error).message.slice(0, 300)}`);
    return fallback;
  }
}

/** A campaign saved before versioning existed gets a starting version, so its first change diffs against it. */
export function ensureBaseline(sessionId: string, campaign: CampaignObject | null | undefined, dir = campaignDir()): void {
  if (!campaign || listVersions(sessionId, dir).length) return;
  if (!campaign.buckets.length && !campaign.goal && !campaign.entry) return;
  recordVersion({ sessionId, campaign, source: 'migration', request: '', summary: 'The campaign as it was before version history started' }, dir);
}
