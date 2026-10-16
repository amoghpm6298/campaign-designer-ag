// What the user said, checked against what the platform can represent.
//
// THE DEFECT: in a live run the user wrote "Product type is Auth" and "new
// status is successful". Product Type is a real attribute — of EMI Request,
// not of Transaction — and "Auth" is not one of its three values. The agent
// quietly proposed `EMI Eligible = true` instead and never mentioned the
// mismatch. The campaign then targeted something the user had not asked for,
// and nothing in the system could tell, because the substituted condition was
// itself perfectly valid.
//
// So statements are checked HERE, deterministically, against ELIGIBILITY_META.
// Nothing is corrected: the user's words are kept verbatim, the mismatch is
// described, and the real alternatives are offered for them to choose.
import { ELIGIBILITY_META, type AttrMeta } from '../src/data/sharedConstants';
import { attributeIndex, canonicalValue } from '../src/data/conditionValidation';

export type StatedValueStatus =
  /** Attribute and value both exist. */
  | 'matches'
  /** The attribute exists but the value is not one it accepts. */
  | 'value-not-allowed'
  /** The attribute exists on no entity the platform defines. */
  | 'attribute-unknown'
  /** The attribute exists but the platform cannot check its values. */
  | 'unverifiable';

export interface StatedValue {
  /** Exactly as the user wrote it, never normalised for storage. */
  statement: string;
  attribute: string;
  value: string;
  status: StatedValueStatus;
  /** Entities that define this attribute. */
  entities: string[];
  /** The platform's own spelling, when the value matched case-insensitively. */
  canonical?: string;
  allowedValues?: string[];
  /** Plain language, safe to show a campaign manager. */
  explanation: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Pulls "<name> = <value>" style assertions out of a message.
 *
 * Deliberately conservative: the left-hand side must match an attribute the
 * platform actually defines, so ordinary prose ("conversion = the point of
 * the campaign") is ignored rather than guessed at. Three separators, because
 * people write all three.
 */
export function extractStatements(text: string): { statement: string; attribute: string; value: string }[] {
  const out: { statement: string; attribute: string; value: string }[] = [];
  // The value runs to a clause boundary, not for a fixed number of
  // characters: "Transaction Status = approved. Product type is Auth" would
  // otherwise swallow the next sentence into the value and report a conflict
  // on a value nobody wrote. Multi-word values are real ("Small KYC",
  // "Pending closure"), so a space cannot end it — only punctuation can.
  const re = /([A-Za-z][A-Za-z _-]{2,40}?)\s*(?:=|:|\bis\b)\s*([A-Za-z0-9_][^,.;\n]{0,39}?)(?=\s*(?:,|\.|;|\n|$|\band\b))/g;
  for (const m of text.matchAll(re)) {
    const attribute = m[1].trim().replace(/^(and|the|with|where|a|an)\s+/i, '');
    const value = m[2].trim().replace(/[.,;)]+$/, '');
    if (!attribute || !value) continue;
    out.push({ statement: m[0].trim(), attribute, value });
  }
  return out;
}

/** Checks each stated value against the platform's own metadata. */
export function detectStatedValues(text: string): StatedValue[] {
  const index = attributeIndex();
  const seen = new Set<string>();
  const out: StatedValue[] = [];

  for (const s of extractStatements(text)) {
    const owners = index.get(norm(s.attribute));
    if (!owners?.length) continue; // not an attribute this platform defines
    const key = `${norm(s.attribute)}:${norm(s.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const entities = [...new Set(owners.map((o) => o.entity))];
    const realName = owners[0].name;
    const withOptions = owners.find((o) => o.meta.options?.length);

    if (!withOptions) {
      out.push({
        ...s,
        attribute: realName,
        status: 'unverifiable',
        entities,
        explanation: `${realName} has no fixed list of values in the platform metadata, so "${s.value}" cannot be verified here.`,
      });
      continue;
    }

    const options = withOptions.meta.options!;
    const canonical = canonicalValue(s.value, options) ?? matchLoosely(s.value, options);
    if (canonical) {
      out.push({
        ...s,
        attribute: realName,
        status: 'matches',
        entities,
        canonical,
        allowedValues: options,
        explanation:
          canonical === s.value
            ? `${realName} = ${canonical} is a value the platform accepts.`
            : `${realName} = "${s.value}" matches the platform's "${canonical}". The campaign will carry the platform's spelling.`,
      });
      continue;
    }

    out.push({
      ...s,
      attribute: realName,
      status: 'value-not-allowed',
      entities,
      allowedValues: options,
      explanation:
        `You said "${s.statement}". ${realName} is defined on ${entities.join(' and ')}, and "${s.value}" is not one of its values. ` +
        `It accepts: ${options.join(', ')}.`,
    });
  }
  return out;
}

/** CUSTOMER_INITIATED vs customer_initiated vs "customer initiated". */
function matchLoosely(value: string, options: string[]): string | null {
  const v = norm(value);
  return options.find((o) => norm(o) === v) ?? null;
}

/**
 * Supersedes an earlier statement about the same attribute.
 *
 * This is how a conflict gets RESOLVED: the user restates it with a value the
 * platform has, and the old conflict stops being raised. Nothing is resolved
 * by the agent deciding on the user's behalf.
 */
export function mergeStatedValues(existing: StatedValue[], incoming: StatedValue[]): StatedValue[] {
  const byAttr = new Map(existing.map((s) => [norm(s.attribute), s]));
  for (const s of incoming) byAttr.set(norm(s.attribute), s);
  return [...byAttr.values()];
}

/** The conflicts worth putting to the user, newest reading of each attribute. */
export const unresolvedConflicts = (stated: StatedValue[]) =>
  stated.filter((s) => s.status === 'value-not-allowed');

/** Entities that define an attribute, for explaining where a concept lives. */
export function entitiesDefining(attribute: string): string[] {
  const owners = attributeIndex().get(norm(attribute));
  return owners ? [...new Set(owners.map((o) => o.entity))] : [];
}

/** Attribute names on an entity, for offering real alternatives. */
export function attributesOf(entity: string): string[] {
  return Object.keys((ELIGIBILITY_META as Record<string, Record<string, AttrMeta>>)[entity] ?? {});
}
