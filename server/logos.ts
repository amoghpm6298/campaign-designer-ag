// Card logos (card products) and the SCOPE of a flow or campaign.
//
// A bank has many logos (MARQUEE, ACE, KLICK…), each with its own fees, rewards
// and benefits, and a customer may hold more than one card. Every flow and
// campaign is scoped to one or more logos, or to all cards; the scope must be
// clear before anything is designed. Code enforces it: every signal, size and
// trend counts only cards of the scoped logos (signals.ts resolveSignalSql),
// and every bucket's own SQL is intersected with the scope's cardholders.
//
// The catalogue is server/logos.json (the banks' real lineups, researched; fees
// indicative). For a bank with a warehouse, the logos and their card counts come
// from its data (scripts/add-logos.mjs writes them there from the same file).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TenantConfig } from './tenants';
import { runWarehouseQuery, warehouseAvailable } from './warehouse';
import type { SignalContext } from './signals';

export interface Logo {
  logo_id: string;
  name: string;
  tier: string;
  network: string;
  joining_fee: number;
  annual_fee: number;
  fee_waiver: string;
  rewards_rule: string;
  key_benefits: string[];
  launch_date: string;
  /** From the bank's data, when it has a warehouse. */
  cards?: number;
  activated?: number;
}

/** One logo, several, or every card the bank issues. Unset (null/undefined) means not decided yet. */
export type Scope = { logos: string[] } | { all: true };

const here = dirname(fileURLToPath(import.meta.url));
let catalogue: Record<string, Logo[]> | null = null;
function fromFile(): Record<string, Logo[]> {
  if (!catalogue) {
    const raw = JSON.parse(readFileSync(join(here, 'logos.json'), 'utf8')) as Record<string, unknown>;
    catalogue = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_'))) as Record<string, Logo[]>;
  }
  return catalogue;
}

/** Which catalogue a tenant uses: its warehouse's, or by issuer for a bank without data. */
const catalogueKey = (t: Pick<TenantConfig, 'warehouse' | 'issuer'> | null | undefined) => t?.warehouse?.bank ?? (/yes/i.test(t?.issuer ?? '') ? 'yesbank' : 'indusind');

const cache = new Map<string, Logo[]>();

/** The bank's card logos, with card and activation counts when it has data. */
export function logosFor(tenant: Pick<TenantConfig, 'warehouse' | 'issuer'> | null | undefined): Logo[] {
  const key = catalogueKey(tenant);
  const base = fromFile()[key] ?? [];
  const bank = tenant?.warehouse?.bank;
  if (!bank || !warehouseAvailable(bank)) return base;
  if (!cache.has(bank)) {
    try {
      const counts = new Map(
        runWarehouseQuery(bank, 'SELECT logo_id, COUNT(*) AS cards, SUM(activated) AS activated FROM cards GROUP BY logo_id').rows.map((r) => [String(r.logo_id), { cards: Number(r.cards), activated: Number(r.activated) }]),
      );
      cache.set(bank, base.map((l) => ({ ...l, ...(counts.get(l.logo_id) ?? {}) })));
    } catch {
      cache.set(bank, base); // a warehouse from before logos: no cards table yet
    }
  }
  return cache.get(bank)!;
}

/** For the designer: the facts it may use, with fees and rewards marked as indicative. */
export function logoForAgent(l: Logo) {
  return {
    id: l.logo_id,
    name: l.name,
    tier: l.tier,
    network: l.network,
    fees: `${l.joining_fee ? `₹${l.joining_fee.toLocaleString('en-IN')} joining, ` : ''}${l.annual_fee ? `₹${l.annual_fee.toLocaleString('en-IN')} a year` : 'no annual fee'}${l.fee_waiver ? ` (${l.fee_waiver})` : ''}`,
    rewards: l.rewards_rule,
    benefits: l.key_benefits,
    ...(l.cards != null ? { cards: l.cards, activated: l.activated } : {}),
    note: 'From public sources, not the bank\'s official terms: indicative. Never quote a fee, rate or number as exact terms in a message.',
  };
}

export const isScope = (v: unknown): v is Scope =>
  !!v && typeof v === 'object' && ((v as { all?: unknown }).all === true || (Array.isArray((v as { logos?: unknown }).logos) && (v as { logos: unknown[] }).logos.length > 0));

/** Checks a scope sent by the designer or a caller against the bank's logos (ids or names). Returns the canonical scope or an error. */
export function parseScope(input: unknown, logos: Logo[]): { value: Scope } | { error: string } {
  const o = (input ?? {}) as { all?: unknown; logos?: unknown };
  if (o.all === true) return { value: { all: true } };
  const asked = Array.isArray(o.logos) ? o.logos.map(String) : [];
  if (!asked.length) return { error: `scope is either {all: true} or {logos: [...]} with one or more of: ${logos.map((l) => `${l.logo_id} (${l.name})`).join(', ')}.` };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ids: string[] = [];
  for (const a of asked) {
    const hit = logos.find((l) => l.logo_id === a || norm(l.name) === norm(a) || norm(l.name).endsWith(norm(a)));
    if (!hit) return { error: `"${a}" is not one of this bank's card logos: ${logos.map((l) => `${l.logo_id} (${l.name})`).join(', ')}.` };
    if (!ids.includes(hit.logo_id)) ids.push(hit.logo_id);
  }
  return ids.length === logos.length && logos.length > 0 ? { value: { all: true } } : { value: { logos: ids } };
}

/** The signal context for a scope (and, for the trend, a past day). */
export function scopeContext(scope: Scope | null | undefined, asOf?: string): SignalContext {
  return { ...(scope && 'logos' in scope ? { logos: scope.logos } : {}), ...(asOf ? { asOf } : {}) };
}

/** The customers the scope covers: holders of a card of the scoped logos (issued by `asOf`). Null when the warehouse has no cards (before logos). */
export function holdersSql(scope: Scope | null | undefined, asOf?: string): string {
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const where = [scope && 'logos' in scope ? `logo_id IN (${scope.logos.map(lit).join(', ')})` : '', asOf ? `issued_date <= ${lit(asOf)}` : ''].filter(Boolean);
  return `SELECT DISTINCT customer_id FROM cards${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
}

/** Any customer-id query, kept within the scope: nobody outside it can be counted. */
export function withinScope(sql: string, scope: Scope | null | undefined): string {
  if (!scope || !('logos' in scope)) return sql;
  return `SELECT customer_id FROM (${sql.trim().replace(/;+\s*$/, '')}) WHERE customer_id IN (${holdersSql(scope)})`;
}

/** "ACE · ELITE+" or "All cards"; short names without the bank's prefix. */
export function scopeText(scope: Scope | null | undefined, logos: Logo[]): string {
  if (!scope) return 'not decided';
  if ('all' in scope) return 'All cards';
  return scope.logos.map((id) => shortLogoName(logos.find((l) => l.logo_id === id)?.name ?? id)).join(' · ');
}

export const shortLogoName = (name: string) => name.replace(/^(YES BANK|YES|IndusInd Bank|IndusInd)\s+/i, '').replace(/\s+IndusInd Bank$/i, '').trim() || name;

/**
 * The "Scope" section of the designer's status, every turn: which cards this is for, with each
 * scoped logo's fact sheet; or, when undecided, that scope comes first.
 */
export function scopeBlock(c: { scope?: Scope | null }, tenant: Pick<TenantConfig, 'warehouse' | 'issuer'> | null): string {
  const logos = logosFor(tenant);
  if (!logos.length) return '';
  if (!c.scope)
    return [
      '## Scope: NOT DECIDED (which cards this is for)',
      `- Decide it first. If the brief names a card (or cards, or says all cards), set_scope now. If it doesn't, ask it in your first questions: "Which card is this for?" with these options (multi): ${logos.map((l) => shortLogoName(l.name)).join(', ')}, All cards.`,
      '- Nothing can be built until it is set.',
    ].join('\n');
  const inScope = 'all' in c.scope ? logos : logos.filter((l) => (c.scope as { logos: string[] }).logos.includes(l.logo_id));
  return [
    `## Scope: ${scopeText(c.scope, logos)}`,
    `- Every size, rule and count is within ${'all' in c.scope ? 'all the bank\'s cards' : 'these logos only'}: customers who hold one, and their spends on it. You never add a logo filter yourself.`,
    'all' in c.scope
      ? '- Messages go to holders of every card, so they speak of benefits all cards share, unless you route by the "logo" signal.'
      : inScope.length > 1
        ? '- Several logos: messages must be true for all of them, or route by the "logo" signal and name each card\'s own benefits on its route.'
        : '- One logo: name the card and use its own benefits (below) as levers and words. Never quote a fee or rate as exact terms.',
    ...('all' in c.scope ? [] : inScope.map((l) => `- ${JSON.stringify(logoForAgent(l))}`)),
  ].join('\n');
}
