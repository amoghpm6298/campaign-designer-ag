// The bank's link registry: every destination a message may send a customer
// to, entered by the bank's admin. The agent may read the URLs (to understand
// where a link goes), but a message only ever carries a link's reference; the
// engine swaps it for the real URL when the message is sent (resolveLink), so
// a wrong or invented URL can never go out, and fixing a URL here fixes every
// campaign.
//
//   <CAMPAIGN_DIR>/../links/<tenantId>.json
//
// Short URLs come from the bank's own DLT-whitelisted shortener: the admin
// enters them; we never make them up.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { campaignDir } from './campaignFiles';
import { assembleSms } from '../src/designer/v2/smsText';

export type LinkChannel = 'SMS' | 'WHATSAPP' | 'EMAIL' | 'RCS' | 'PUSH';

export interface BankLink {
  /** Stable internal reference, chosen once, never changes. */
  ref: string;
  label: string;
  /** What the page does, in words: what the agent reasons with. */
  purpose: string;
  url: string;
  /** From the bank's whitelisted shortener. Needed for SMS. */
  shortUrl?: string;
  channels: LinkChannel[];
  status: 'active' | 'retired';
  /** Seeded example data, not the bank's real links. */
  mock?: boolean;
  updatedAt: string;
  updatedBy?: string;
}

const REF = /^[a-z][a-z0-9_]{1,40}$/;
const ALL: LinkChannel[] = ['SMS', 'WHATSAPP', 'EMAIL', 'RCS', 'PUSH'];

export function linksDir(): string {
  return process.env.LINKS_DIR ? resolve(process.env.LINKS_DIR) : resolve(dirname(campaignDir()), 'links');
}

const fileFor = (tenantId: string, dir: string) => {
  if (!/^[A-Z0-9-]{2,40}$/i.test(tenantId)) throw new Error('Not a valid tenant id.');
  return join(dir, `${tenantId}.json`);
};

/** Example links so the agent has real references from day one. Marked mock. */
function seedFor(tenantId: string): BankLink[] {
  const at = '2026-11-13T00:00:00.000Z';
  const bank = tenantId === 'TEN-YES' ? { web: 'https://www.yesbank.in/cards', short: 'https://yesb.in' } : { web: 'https://www.indusind.com/in/en/personal/cards', short: 'https://indus.in' };
  const mk = (ref: string, label: string, purpose: string, path: string, code: string | null): BankLink => ({
    ref,
    label,
    purpose,
    url: `${bank.web}/${path}`,
    ...(code ? { shortUrl: `${bank.short}/${code}` } : {}),
    channels: ['SMS', 'WHATSAPP', 'EMAIL'],
    status: 'active',
    mock: true,
    updatedAt: at,
  });
  return [
    mk('activate_card', 'Activate your card', 'Opens card activation in the app (deep link), with the web page as fallback. The customer activates in under a minute.', 'activate', 'Ac7k2'),
    mk('set_pin', 'Set your card PIN', 'Opens PIN setting in the app. Needed before ATM or in-store PIN use.', 'set-pin', 'Pn4q8'),
    mk('virtual_card', 'Use your virtual card', 'Shows the virtual card details in the app and how to add it to UPI apps or pay online.', 'virtual-card', 'Vc2m9'),
    mk('card_benefits', 'Your card benefits', 'The page listing this card’s benefits: rewards, lounge access, fee waivers, EMI options.', 'benefits', 'Bn5t3'),
    mk('emi_convert', 'Convert a purchase to EMI', 'Lets the customer pick a recent purchase and convert it to EMI in the app.', 'emi', 'Em8r1'),
    mk('rewards', 'Your reward points', 'Shows the customer’s reward points balance and how to redeem them.', 'rewards', 'Rw3h6'),
    mk('help_activation', 'Help with activation', 'Help-centre article: activation steps and what to do if activation fails. No short link yet.', 'help/activation', null),
  ];
}

export function listLinks(tenantId: string, dir = linksDir()): BankLink[] {
  const p = fileFor(tenantId, dir);
  if (!existsSync(p)) return seedFor(tenantId);
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as BankLink[];
  } catch {
    return seedFor(tenantId);
  }
}

function write(tenantId: string, links: BankLink[], dir: string): void {
  const p = fileFor(tenantId, dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(links, null, 1));
  renameSync(tmp, p);
}

const isUrl = (s: unknown) => typeof s === 'string' && /^https:\/\/[^\s/]+\.[^\s]+$/i.test(s.trim());

/** Adds or changes a link. A ref, once created, never changes. */
export function saveLink(tenantId: string, input: Partial<BankLink>, by = 'admin', dir = linksDir()): { ok: boolean; error?: string; link?: BankLink } {
  const ref = String(input.ref ?? '').trim();
  if (!REF.test(ref)) return { ok: false, error: 'A reference is lower-case letters, digits and underscores, starting with a letter (e.g. activate_card).' };
  if (!String(input.label ?? '').trim()) return { ok: false, error: 'Give the link a label.' };
  if (!isUrl(input.url)) return { ok: false, error: 'The full URL must start with https://' };
  if (input.shortUrl && !isUrl(input.shortUrl)) return { ok: false, error: 'The short URL must start with https://' };
  const channels = (input.channels ?? ALL).filter((c): c is LinkChannel => ALL.includes(c as LinkChannel));
  const links = listLinks(tenantId, dir);
  const prev = links.find((l) => l.ref === ref);
  const link: BankLink = {
    ref,
    label: String(input.label).trim(),
    purpose: String(input.purpose ?? prev?.purpose ?? '').trim(),
    url: String(input.url).trim(),
    ...(input.shortUrl ? { shortUrl: String(input.shortUrl).trim() } : {}),
    channels: channels.length ? channels : ALL,
    status: input.status === 'retired' ? 'retired' : 'active',
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
  write(tenantId, prev ? links.map((l) => (l.ref === ref ? link : l)) : [...links, link], dir);
  return { ok: true, link };
}

export function retireLink(tenantId: string, ref: string, dir = linksDir()): { ok: boolean; error?: string } {
  const links = listLinks(tenantId, dir);
  if (!links.some((l) => l.ref === ref)) return { ok: false, error: `No link "${ref}".` };
  write(tenantId, links.map((l) => (l.ref === ref ? { ...l, status: 'retired' as const, updatedAt: new Date().toISOString() } : l)), dir);
  return { ok: true };
}

/** Why a link reference cannot be used on a channel, or null if it can. */
export function linkProblem(links: BankLink[], ref: string, channel: string | undefined): string | null {
  const l = links.find((x) => x.ref === ref);
  if (!l) return `there is no link "${ref}"`;
  if (l.status === 'retired') return `the link "${l.label}" (${ref}) was retired`;
  const ch = (channel ?? 'SMS').toUpperCase();
  if (!l.channels.includes(ch as LinkChannel)) return `the link "${l.label}" (${ref}) is not allowed on ${ch}`;
  if (ch === 'SMS' && !l.shortUrl) return `the link "${l.label}" (${ref}) has no short link yet, so it cannot go by SMS`;
  return null;
}

/**
 * The engine's contract: the URL to send for a reference on a channel. SMS
 * gets the short URL; WhatsApp, email and the rest get the full URL. Throws
 * for anything that cannot be sent, so a bad link stops the send instead of
 * going out.
 */
export function resolveLink(tenantId: string, ref: string, channel: string, dir = linksDir()): string {
  const links = listLinks(tenantId, dir);
  const problem = linkProblem(links, ref, channel);
  if (problem) throw new Error(`Cannot send: ${problem}.`);
  const l = links.find((x) => x.ref === ref)!;
  return channel.toUpperCase() === 'SMS' ? l.shortUrl! : l.url;
}

/**
 * What the agent sees of a link: everything, URLs included, so it understands
 * where a link really goes and can count SMS length with the short link. It
 * still never WRITES a URL into a message: messages carry the reference, and
 * the edit tools refuse any URL in copy or CTA.
 */
export const forAgent = (l: BankLink) => ({
  ref: l.ref,
  label: l.label,
  purpose: l.purpose,
  url: l.url,
  ...(l.shortUrl ? { shortUrl: l.shortUrl, shortUrlLength: l.shortUrl.length } : {}),
  channels: l.channels,
  smsReady: !!l.shortUrl,
  ...(l.status === 'retired' ? { retired: true } : {}),
});

/** The engine's contract for SMS: the exact text sent (copy, CTA, then the short link), same as the preview. */
export function smsTextFor(tenantId: string, step: { copy?: string; cta?: string; link?: string }, dir = linksDir()): string {
  const url = step.link ? resolveLink(tenantId, step.link, 'SMS', dir) : undefined;
  return assembleSms(step.copy ?? '', step.cta, url);
}
