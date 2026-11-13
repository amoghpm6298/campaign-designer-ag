// Bank-wide delivery settings, owned by the system that executes campaigns —
// not decided per message by the agent. Today: what happens when a WhatsApp
// (or RCS) message is not delivered.
//
//   <CAMPAIGN_DIR>/../settings/<tenantId>.json
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { campaignDir } from './campaignFiles';

export interface BankSettings {
  /** If a WhatsApp/RCS message is not delivered, the system sends it again by SMS. */
  smsFallback: boolean;
  updatedAt?: string;
}

const DEFAULTS: BankSettings = { smsFallback: true };

export function settingsDir(): string {
  return process.env.SETTINGS_DIR ? resolve(process.env.SETTINGS_DIR) : resolve(dirname(campaignDir()), 'settings');
}

const fileFor = (tenantId: string, dir: string) => {
  if (!/^[A-Z0-9-]{2,40}$/i.test(tenantId)) throw new Error('Not a valid tenant id.');
  return join(dir, `${tenantId}.json`);
};

export function getBankSettings(tenantId: string, dir = settingsDir()): BankSettings {
  try {
    const p = fileFor(tenantId, dir);
    return existsSync(p) ? { ...DEFAULTS, ...(JSON.parse(readFileSync(p, 'utf8')) as Partial<BankSettings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveBankSettings(tenantId: string, patch: Partial<BankSettings>, dir = settingsDir()): BankSettings {
  const next: BankSettings = { ...getBankSettings(tenantId, dir), ...(typeof patch.smsFallback === 'boolean' ? { smsFallback: patch.smsFallback } : {}), updatedAt: new Date().toISOString() };
  const p = fileFor(tenantId, dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 1));
  renameSync(tmp, p);
  return next;
}

/** The channel a message may also go by, under the bank's policy (or its own exception). */
export function fallbackFor(step: { channelPreference?: string[]; fallbackChannel?: string }, smsFallback: boolean): string | undefined {
  if (step.fallbackChannel) return step.fallbackChannel;
  const ch = (step.channelPreference ?? [])[0];
  return smsFallback && (ch === 'WHATSAPP' || ch === 'RCS') ? 'SMS' : undefined;
}
