// Bank-wide delivery settings, owned by the system that executes campaigns —
// not decided per message by the agent. Today: what happens when a WhatsApp
// (or RCS) message is not delivered.
//
//   <CAMPAIGN_DIR>/../settings/<tenantId>.json
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { campaignDir } from './campaignFiles';

/** Share of messages that reach the customer, per channel: the top of every message's funnel. Typical rates to start; each bank sets its own. */
export type DeliveryRates = Record<'WHATSAPP' | 'SMS' | 'EMAIL' | 'RCS' | 'PUSH', number>;
export const DEFAULT_DELIVERY_RATES: DeliveryRates = { WHATSAPP: 0.9, SMS: 0.95, EMAIL: 0.97, RCS: 0.85, PUSH: 0.8 };

export interface BankSettings {
  /** If a WhatsApp/RCS message is not delivered, the system sends it again by SMS. */
  smsFallback: boolean;
  deliveryRates: DeliveryRates;
  updatedAt?: string;
}

const DEFAULTS: BankSettings = { smsFallback: true, deliveryRates: DEFAULT_DELIVERY_RATES };

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
    if (!existsSync(p)) return { ...DEFAULTS, deliveryRates: { ...DEFAULT_DELIVERY_RATES } };
    const saved = JSON.parse(readFileSync(p, 'utf8')) as Partial<BankSettings>;
    return { ...DEFAULTS, ...saved, deliveryRates: { ...DEFAULT_DELIVERY_RATES, ...(saved.deliveryRates ?? {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveBankSettings(tenantId: string, patch: Partial<BankSettings>, dir = settingsDir()): BankSettings {
  const prev = getBankSettings(tenantId, dir);
  // Rates are fractions 0-1; anything else is ignored.
  const rates = Object.fromEntries(
    Object.entries(patch.deliveryRates ?? {}).filter(([k, v]) => k in DEFAULT_DELIVERY_RATES && typeof v === 'number' && v >= 0 && v <= 1),
  ) as Partial<DeliveryRates>;
  const next: BankSettings = {
    ...prev,
    ...(typeof patch.smsFallback === 'boolean' ? { smsFallback: patch.smsFallback } : {}),
    deliveryRates: { ...prev.deliveryRates, ...rates },
    updatedAt: new Date().toISOString(),
  };
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
