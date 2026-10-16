// READ-ONLY DIAGNOSTIC. Changes no prompt, no question, no strategy, no
// blueprint. It computes what the platform can express for a set of factors
// and prints it, so a human can compare it against what the agent actually did.
//
// The point is not to recommend anything. It is to answer one question the
// transcripts cannot: when the agent said a factor was unbuildable, was that
// true of the PLATFORM, or only of the entry it had already picked?
//
// Capability definitions are imported, never restated. If the platform gains
// an attribute this table gains a column with no edit here.
import { ELIGIBILITY_META, EVENT_CATEGORIES } from '../src/data/sharedConstants';

export type Support = 'direct' | 'alternative-entry' | 'elsewhere-in-journey' | 'unsupported';

/** A thing the user asked for, and the attribute that would express it. */
export interface Factor {
  /** The user's requirement, in their words. */
  need: string;
  /**
   * The attribute that would express it, if one does. Stated by whoever runs
   * the diagnostic, NOT inferred — the table verifies existence and ownership,
   * it does not do semantics.
   */
  attribute?: string;
  /** Set when no attribute could plausibly express it at all. */
  noAttribute?: string;
}

export interface FactorResult {
  need: string;
  support: Support;
  /** Entities whose attribute set contains it. */
  carriedBy: string[];
  detail: string;
}

const ents = ELIGIBILITY_META as Record<string, Record<string, unknown>>;
const cats = EVENT_CATEGORIES as Record<string, { events: string[] }>;

/** Which entity a given event category filters on, where it maps to one. */
const EVENT_ENTITY: Record<string, string> = {
  'Transaction Events': 'Transaction',
  'EMI Events': 'EMI Request',
  'Card Events': 'Card',
};

/** Every distinct place a campaign can start, computed from real metadata. */
export function entryPoints() {
  const out: { label: string; entity: string | null }[] = [];
  for (const e of Object.keys(ents)) out.push({ label: `Audience · ${e}`, entity: e });
  for (const [c, m] of Object.entries(cats))
    for (const ev of m.events) out.push({ label: `Event · ${ev}`, entity: EVENT_ENTITY[c] ?? null });
  return out;
}

/** Which entities own a given attribute. */
export const owners = (attr: string) =>
  Object.entries(ents).filter(([, a]) => Object.keys(a).includes(attr)).map(([e]) => e);

export function evaluate(factors: Factor[], chosenEntity: string | null): FactorResult[] {
  return factors.map((f) => {
    if (!f.attribute) {
      return {
        need: f.need, support: 'unsupported' as const, carriedBy: [],
        detail: f.noAttribute ?? 'no attribute in the schema expresses this',
      };
    }
    const owns = owners(f.attribute);
    if (!owns.length) {
      return { need: f.need, support: 'unsupported' as const, carriedBy: [],
        detail: `"${f.attribute}" does not exist on any entity` };
    }
    if (chosenEntity && owns.includes(chosenEntity)) {
      return { need: f.need, support: 'direct' as const, carriedBy: owns,
        detail: `${chosenEntity}.${f.attribute} — usable at the chosen entry` };
    }
    return {
      need: f.need, support: 'alternative-entry' as const, carriedBy: owns,
      detail: `${f.attribute} exists on ${owns.join(', ')} — NOT on the chosen entry (${chosenEntity ?? 'none'}), but a different entry would carry it`,
    };
  });
}

/**
 * Which requirements can hold at the same time.
 *
 * Entry filters ONE entity's attributes, so factors group by the entity that
 * owns them: same entity, compatible; different entities, mutually exclusive
 * at entry. This is the computation the agent does in prose and then resolves
 * silently.
 */
export function compatibility(factors: Factor[]) {
  const groups = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const f of factors) {
    const owns = f.attribute ? owners(f.attribute) : [];
    if (!owns.length) { orphans.push(f.need); continue; }
    for (const e of owns) groups.set(e, [...(groups.get(e) ?? []), f.need]);
  }
  return { groups, orphans };
}

export function render(label: string, factors: Factor[], chosenEntity: string | null): string {
  const L: string[] = [];
  L.push(`\n${'='.repeat(78)}\nARCHITECTURE TABLE — ${label}  (read-only diagnostic)\n${'='.repeat(78)}`);
  L.push(`\nThe agent's chosen entry filters: ${chosenEntity ?? '(none)'}\n`);

  const res = evaluate(factors, chosenEntity);
  L.push('WHAT THE USER ASKED FOR, AND WHETHER THE PLATFORM CAN DO IT\n');
  for (const r of res) {
    const tag = { direct: 'SUPPORTED HERE', 'alternative-entry': 'NEEDS ANOTHER ENTRY',
      'elsewhere-in-journey': 'LATER IN JOURNEY', unsupported: 'NOT POSSIBLE' }[r.support];
    L.push(`  [${tag.padEnd(19)}] ${r.need}`);
    L.push(`   ${' '.repeat(21)} ${r.detail}`);
  }

  const { groups, orphans } = compatibility(factors);
  L.push('\nWHICH REQUIREMENTS CAN BE SATISFIED TOGETHER');
  L.push('  (entry filters one entity, so each group is one possible campaign)\n');
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [entity, needs] of sorted)
    L.push(`  Enter on ${entity.padEnd(12)} -> ${needs.length} of ${factors.length}: ${needs.join('; ')}`);
  if (orphans.length) L.push(`  Nothing carries     -> ${orphans.join('; ')}`);

  const best = sorted[0]?.[1].length ?? 0;
  L.push('\nREADING');
  if (best <= 1 && factors.length > 1)
    L.push(`  No single entry satisfies more than ${best} of ${factors.length} requirements.`);
  if (sorted.length > 1)
    L.push(`  ${sorted.length} mutually exclusive campaigns are possible. Choosing one gives up the others.`);
  if (orphans.length)
    L.push(`  ${orphans.length} requirement(s) no entry can satisfy — a genuine platform limit.`);
  return L.join('\n');
}
