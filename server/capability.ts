// Can this platform express the intervention the agent actually wants?
//
// THE DEFECT THIS EXISTS FOR. The agent fetches the platform's vocabulary
// during discovery, so by the time it forms an idea it already knows what the
// builder can express — and only ever forms ideas that fit. The right answer is
// never generated, so it is never stated, so nobody gets to decide about it.
// MEASURED: the user asked for "customers who have never started a conversion".
// Entry cannot filter on request history. The requirement did not get refused,
// it evaporated, and the campaign went out to `Account Status = Active` — the
// entire active base — with the loss recorded as a passing remark.
//
// So the order changes: the agent states what it wants BEFORE it is told what
// is possible, and this module answers. The gap then belongs to the
// application, computed from real metadata, rather than to the agent's prose.
//
// Promoted from eval/architectureTable.ts, which was a read-only diagnostic
// written to answer one question the transcripts could not: when the agent
// said something was unbuildable, was that true of the PLATFORM, or only of
// the entry it had already chosen?
import { ELIGIBILITY_META, EVENT_CATEGORIES, DC_EVENT_ENTITY } from '../src/data/sharedConstants';

/** How well the platform can express one requirement. */
export type Support =
  /** The chosen entry filters this entity, so the attribute is usable at entry. */
  | 'direct'
  /** A real attribute, but owned by an entity a different entry would filter. */
  | 'alternative-entry'
  /** Not filterable at entry, but the journey can wait for the event instead. */
  | 'elsewhere-in-journey'
  /** No attribute and no event expresses this at all. */
  | 'unsupported';

/** One thing the agent says the campaign needs. Authored before any blueprint. */
export interface Requirement {
  /** What it needs, in business terms, in the agent's own words. */
  need: string;
  /**
   * The attribute the agent believes expresses it, if it believes one does.
   * Stated by the agent, never guessed here — this module verifies existence
   * and ownership, it does not do semantics.
   */
  attribute?: string;
  /** The event the journey could wait for instead, where one applies. */
  event?: string;
}

export interface RequirementVerdict {
  need: string;
  support: Support;
  /** Entities whose attribute set contains it. */
  carriedBy: string[];
  /** Plain sentence a campaign manager can read. */
  detail: string;
}

const entities = ELIGIBILITY_META as Record<string, Record<string, unknown>>;
const categories = EVENT_CATEGORIES as Record<string, { events: string[] }>;

/** Every attribute name the platform defines, longest first. */
const ALL_ATTRS: string[] = [
  ...new Set(Object.values(entities).flatMap((a) => Object.keys(a))),
].sort((a, b) => b.length - a.length);

/**
 * Attribute names mentioned anywhere in a piece of text.
 *
 * MEASURED, on the first live run of the design step: the agent does not write
 * a bare attribute name. It writes the filter it has in mind — "Transaction:
 * EMI Eligible = true (combined with a settled/approved transaction status)",
 * or "Account: Status (exclude Closed, Dormant...); Card: Blocked = false".
 * An exact-match lookup found none of them and reported SIX of six requirements
 * unsupported, including three whose attributes plainly exist.
 *
 * That is the most damaging way this check could fail: telling the agent
 * something is impossible when it is not would make the design SMALLER, which
 * is the exact problem the design step exists to stop.
 *
 * Longest name first so "Transaction Status" is found before "Status", and
 * matched on word boundaries so "Status" does not match inside "Statuses".
 */
export function attributesIn(text: string): string[] {
  const hay = ` ${text.toLowerCase()} `;
  const found: string[] = [];
  let remaining = hay;
  for (const a of ALL_ATTRS) {
    const needle = a.toLowerCase();
    const at = remaining.indexOf(needle);
    if (at === -1) continue;
    const before = remaining[at - 1];
    const after = remaining[at + needle.length];
    if (/[a-z0-9]/.test(before ?? ' ') || /[a-z0-9]/.test(after ?? ' ')) continue;
    found.push(a);
    // Blank it out so a shorter name cannot match inside one already claimed.
    remaining = remaining.slice(0, at) + ' '.repeat(needle.length) + remaining.slice(at + needle.length);
  }
  return found;
}

/**
 * Which entities own the attribute(s) the text refers to.
 *
 * Reads what the agent actually wrote rather than demanding a bare name — see
 * `attributesIn`. An entity qualifies when it owns EVERY attribute mentioned,
 * because a requirement naming two attributes needs one entry that carries
 * both; entry filters one entity.
 */
export const owners = (attribute: string): string[] => {
  const named = attributesIn(attribute);
  if (!named.length) return [];
  const ownsAny = (attrs: Record<string, unknown>) => {
    const have = new Set(Object.keys(attrs).map((a) => a.toLowerCase()));
    return named.some((n) => have.has(n.toLowerCase()));
  };

  // The agent writes the entity as well as the attribute — "Transaction: EMI
  // Eligible = true", "Card: Blocked = false". When it does, that is far better
  // evidence than inferring from attribute names alone, which over-matches on
  // ordinary words: "a settled/approved transaction status" contains "Status",
  // an attribute of Account and Card, and that one incidental word was enough
  // to make a Transaction requirement look like it belonged to three entities
  // and therefore to none.
  const mentioned = Object.keys(entities).filter((e) =>
    new RegExp(`\\b${e.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(attribute.toLowerCase()),
  );
  if (mentioned.length) return mentioned.filter((e) => ownsAny(entities[e]));

  // No entity named: require one that carries EVERY attribute mentioned, since
  // entry filters a single entity and a requirement spanning two cannot be met
  // at any one of them.
  return Object.entries(entities)
    .filter(([, attrs]) => {
      const have = new Set(Object.keys(attrs).map((a) => a.toLowerCase()));
      return named.every((n) => have.has(n.toLowerCase()));
    })
    .map(([e]) => e);
};

/** Every event the platform can fire, flattened. */
export const allEvents = (): string[] => Object.values(categories).flatMap((c) => c.events);

/** Every distinct place a campaign can start. */
export function entryPoints(): { label: string; entity: string | null }[] {
  const out: { label: string; entity: string | null }[] = [];
  for (const e of Object.keys(entities)) out.push({ label: `Audience · ${e}`, entity: e });
  for (const [cat, meta] of Object.entries(categories))
    for (const ev of meta.events) out.push({ label: `Event · ${ev}`, entity: DC_EVENT_ENTITY[cat] ?? null });
  return out;
}

/**
 * Judge each requirement against the real vocabulary.
 *
 * `chosenEntity` is whatever the agent's intended entry would filter. It may be
 * null, which is the honest state while the intervention is still being
 * designed — everything then reads as alternative-entry rather than direct,
 * which is accurate: nothing is usable at an entry nobody has picked.
 */
export function evaluate(reqs: Requirement[], chosenEntity: string | null): RequirementVerdict[] {
  const events = new Set(allEvents().map((e) => e.toLowerCase()));
  return reqs.map((r) => {
    const attr = r.attribute?.trim();
    const owns = attr ? owners(attr) : [];

    if (attr && owns.length) {
      if (chosenEntity && owns.includes(chosenEntity))
        return { need: r.need, support: 'direct' as const, carriedBy: owns,
          detail: `${chosenEntity} carries ${attr}, so this can be filtered where the campaign starts.` };
      return { need: r.need, support: 'alternative-entry' as const, carriedBy: owns,
        detail: `${attr} exists, but on ${owns.join(' and ')} rather than ${chosenEntity ?? 'the entry chosen'}. A campaign starting there could filter on it; this one cannot.` };
    }

    // No usable attribute. The journey may still be able to wait for the
    // behaviour as an event, which is a real answer and not the same as "no".
    const ev = r.event?.trim();
    if (ev && events.has(ev.toLowerCase()))
      return { need: r.need, support: 'elsewhere-in-journey' as const, carriedBy: [],
        detail: `No attribute filters this at entry, but the journey can wait for ${ev} and branch on it after people have entered.` };

    return { need: r.need, support: 'unsupported' as const, carriedBy: [],
      detail: attr
        ? `"${attr}" does not exist on any entity, and no event covers it either. Nothing in the platform expresses this.`
        : 'No attribute and no event expresses this. Nothing in the platform can act on it.' };
  });
}

/**
 * Which requirements can hold AT THE SAME TIME.
 *
 * Entry filters one entity, so requirements group by the entity that owns them:
 * same entity, compatible; different entities, mutually exclusive at entry.
 * This is the computation the agent otherwise does in prose and resolves
 * silently, which is how a requirement goes missing.
 */
export function compatibility(reqs: Requirement[]): { groups: Map<string, string[]>; orphans: string[] } {
  const groups = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const r of reqs) {
    const owns = r.attribute ? owners(r.attribute) : [];
    if (!owns.length) { orphans.push(r.need); continue; }
    for (const e of owns) groups.set(e, [...(groups.get(e) ?? []), r.need]);
  }
  return { groups, orphans };
}

/** Requirements the campaign cannot satisfy where it starts. */
export const gaps = (vs: RequirementVerdict[]): RequirementVerdict[] =>
  vs.filter((v) => v.support !== 'direct');

/**
 * What goes back to the model after it has stated its intervention.
 *
 * Written as instructions about what to do next rather than as a verdict to
 * admire, because the point is to change the design that follows, not to
 * decorate the one already formed.
 */
export function briefBack(vs: RequirementVerdict[], reqs: Requirement[]): string {
  const lines: string[] = ['WHAT THIS PLATFORM CAN ACTUALLY DO WITH THE INTERVENTION YOU JUST DESCRIBED.'];
  for (const v of vs) lines.push(`- ${v.need} — ${v.support.toUpperCase().replace(/-/g, ' ')}. ${v.detail}`);

  const { groups, orphans } = compatibility(reqs);
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  if (sorted.length > 1) {
    lines.push(
      '',
      'Entry filters ONE entity, so these cannot all hold where the campaign starts. Each of these is a different possible campaign, and choosing one gives up the others:',
    );
    for (const [entity, needs] of sorted) lines.push(`- Start on ${entity}: satisfies ${needs.length} of ${reqs.length} — ${needs.join('; ')}`);
  }
  if (orphans.length) lines.push('', `Nothing in the platform carries: ${orphans.join('; ')}.`);

  const missing = gaps(vs);

  // Reached-audience gaps and eligibility-hygiene gaps are told apart here,
  // and that distinction is the whole point of this rewrite.
  //
  // THE DEFECT THIS FIXES, measured in a live run. This function used to end
  // with "that difference is the user's decision, not yours", applied to
  // EVERY unmet requirement. The model did as instructed, and the result was
  // a turn that spent both of its scarce fork questions asking a campaign
  // manager whether they were comfortable messaging customers with incomplete
  // KYC, and whether to hold the campaign until a suppression list could
  // exclude customers with a prior EMI Request. Neither is a question about
  // EMI conversion. The verdicts could never reach the `questions` array —
  // the gate is not even given them — so the model wrote those questions
  // itself, because it was told to escalate.
  //
  // Both kinds of gap are still reported. The difference is who decides:
  //  - WHO GETS REACHED is the manager's call. If the audience that can be
  //    built is not the audience they asked for, that is material and they
  //    must hear it in their own terms.
  //  - WHO IS EXCLUDED is plumbing. Nobody needs asking whether to avoid
  //    messaging people who cannot act; apply the sensible default, and
  //    record what could not be expressed as a limitation on the campaign.
  const hygiene = missing.filter((v) => v.need.startsWith('Exclude: '));
  const reach = missing.filter((v) => !v.need.startsWith('Exclude: '));

  lines.push('');
  if (!missing.length) {
    lines.push('Every requirement you stated can be met at entry. Build it.');
  } else {
    lines.push('Now build the campaign.');
    if (reach.length) {
      lines.push(
        `${reach.length} of your ${reqs.length} requirements cannot be met where it starts, and they change WHO IS REACHED. Say so plainly in your answer, in the user's own terms — who they asked for, who will actually be reached, and what that difference costs them. Do not quietly narrow what you asked for into what you can build: that difference is the user's decision, not yours.`,
      );
    }
    if (hygiene.length) {
      lines.push(
        `${hygiene.length} exclusion(s) cannot be applied at entry. Do NOT put these to the user as a choice — they are not deciding whether to avoid people who cannot act. Where the exclusion can be made later in the journey, do that. Where it cannot be made at all, build the campaign anyway and record it as a limitation, in one sentence, with what it means in practice.`,
      );
    }
  }
  return lines.join('\n');
}
