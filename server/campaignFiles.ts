// The campaign on disk. One chat is one campaign: the file is keyed by the
// chat's session id, so nobody ever handles a campaign id.
//
// Only the campaign goes in the file: the brief it rests on, the campaign
// shell, and the buckets with their journeys (the PlanFile shape). The
// conversation itself (messages, questions, flags, timeline) stays with the
// chat. The agent reads and writes this file through its campaign tools.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanFile } from './agent/types';

const here = dirname(fileURLToPath(import.meta.url));

export interface CampaignFile {
  sessionId: string;
  tenantId: string;
  updatedAt: string;
  campaign: PlanFile;
}

export function campaignDir(): string {
  return process.env.CAMPAIGN_DIR ? resolve(process.env.CAMPAIGN_DIR) : resolve(here, '../data/campaigns');
}

const SESSION_ID = /^[a-z0-9-]{1,64}$/i;

/** The file for a session. Throws for anything that is not a plain session id, so no path can escape the folder. */
export function campaignPath(sessionId: string, dir = campaignDir()): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('Not a valid session id.');
  return join(dir, `${sessionId}.json`);
}

export function loadCampaignFile(sessionId: string, dir = campaignDir()): CampaignFile | null {
  const p = campaignPath(sessionId, dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CampaignFile;
  } catch {
    return null;
  }
}

export function loadCampaign(sessionId: string, dir = campaignDir()): PlanFile | null {
  return loadCampaignFile(sessionId, dir)?.campaign ?? null;
}

/** Writes to a temp file and renames it over the old one, so a crash never leaves half a campaign. */
export function saveCampaign(sessionId: string, tenantId: string, campaign: PlanFile, dir = campaignDir()): void {
  const p = campaignPath(sessionId, dir);
  mkdirSync(dir, { recursive: true });
  const body: CampaignFile = { sessionId, tenantId, updatedAt: new Date().toISOString(), campaign };
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 1));
  renameSync(tmp, p);
}
