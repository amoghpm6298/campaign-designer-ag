// Deterministic validation for a single campaign condition.
//
// WHY THIS EXISTS: a condition could reach a built, "valid" campaign carrying
// a value that matches nobody. Only audience entries checked attribute NAMES
// (server/blueprint.ts), event entries checked nothing at all, and no
// validator anywhere looked at a value. A live run produced
// `Transaction Status = "Auth"` — not one of the five values the platform
// accepts — and every check passed.
//
// Everything below is derived from the application's own definitions:
// ELIGIBILITY_META for attributes, types and allowed values,
// dcOperatorsForAttribute for operators, DC_EVENT_ENTITY for which entity an
// event category filters, EVENT_ATTR_BY_TYPE + LOCKED_ATTR_OPERATORS for the
// categories that lock to one attribute. No value list is restated here.
import {
  ELIGIBILITY_META,
  DC_EVENT_ENTITY,
  EVENT_ATTR_BY_TYPE,
  EVENT_CATEGORIES,
  LOCKED_ATTR_OPERATORS,
  dcOperatorsForAttribute,
  type AttrMeta,
} from './sharedConstants';
import type { DripGoalCondition } from './graphTypes';

export type ConditionIssueCode =
  | 'unknown-entity'
  | 'unknown-attribute'
  | 'wrong-entity'
  | 'bad-operator'
  | 'bad-value'
  | 'missing-value'
  | 'conditions-unsupported'
  | 'locked-attribute';

export interface ConditionIssue {
  code: ConditionIssueCode;
  /** The attribute as written, never corrected. */
  attribute: string;
  /** Plain language, safe to show a campaign manager. */
  problem: string;
  allowedValues?: string[];
  allowedOperators?: string[];
  /** Where the real attribute lives, when it exists on another entity. */
  ownedBy?: string;
  /** Closest real names. A suggestion for a person, never applied for them. */
  nearest?: string[];
}

/**
 * Something the platform cannot check either way — a Smart Tag's real values
 * are issuer-configured and not modelled here. Reported rather than passed
 * silently, because "no error" would otherwise read as "verified".
 */
export interface ConditionLimitation {
  attribute: string;
  note: string;
}

export interface ConditionCheck {
  issues: ConditionIssue[];
  limitations: ConditionLimitation[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every attribute the platform knows, with the entity that owns it. */
export function attributeIndex(): Map<string, { entity: string; name: string; meta: AttrMeta }[]> {
  const idx = new Map<string, { entity: string; name: string; meta: AttrMeta }[]>();
  for (const [entity, attrs] of Object.entries(ELIGIBILITY_META)) {
    for (const [name, meta] of Object.entries(attrs as Record<string, AttrMeta>)) {
      const key = norm(name);
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key)!.push({ entity, name, meta });
    }
  }
  return idx;
}

/** Real attribute names whose text is closest to what was written. */
export function nearestAttributes(attribute: string, entity?: string): string[] {
  const target = norm(attribute);
  const pool = entity
    ? Object.keys((ELIGIBILITY_META as Record<string, object>)[entity] ?? {})
    : Object.values(ELIGIBILITY_META).flatMap((a) => Object.keys(a));
  return [...new Set(pool)]
    .map((name) => {
      const n = norm(name);
      const score = n === target ? 3 : n.includes(target) || target.includes(n) ? 2 : shareAWord(name, attribute) ? 1 : 0;
      return { name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.name);
}

const shareAWord = (a: string, b: string) => {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  return b
    .toLowerCase()
    .split(/\W+/)
    .some((w) => w.length > 2 && wa.has(w));
};

/** The values a condition carries, in either shape the blueprint may use. */
export function conditionValues(c: DripGoalCondition): string[] {
  if (Array.isArray(c.values) && c.values.length) return c.values.map(String);
  // The model emits `value: ["AUTHORIZE"]` for a multiSelect. That is a shape
  // difference, not a different value, so it is read here rather than being
  // rejected — and normaliseCondition writes it into `values` where the
  // application's own label and validity code looks for it.
  if (Array.isArray(c.value)) return (c.value as unknown as string[]).map(String);
  return c.value === undefined || c.value === '' ? [] : [String(c.value)];
}

/**
 * Puts a condition into the shape the application's own reducer and
 * validators expect, WITHOUT changing any value. Only the container moves:
 * a multiSelect's values belong in `values[]`.
 */
export function normaliseCondition(c: DripGoalCondition, meta?: AttrMeta | null): DripGoalCondition {
  const vals = conditionValues(c);
  if (meta?.type === 'multiSelect') {
    return { attribute: c.attribute, operator: c.operator || 'Any of', values: vals, value: '' };
  }
  if (Array.isArray(c.value)) return { ...c, value: vals[0] ?? '', values: undefined };
  return c;
}

/** Case-insensitive match against the allowed list, returning the real spelling. */
export function canonicalValue(value: string, options: string[]): string | null {
  return options.find((o) => o.toLowerCase() === String(value).toLowerCase()) ?? null;
}

/**
 * Validates one condition against one entity.
 *
 * `locked` is for the categories whose attribute is fixed by the event type
 * (Journey and Offer Events), where the operator vocabulary differs.
 */
export function validateCondition(
  entity: string | null,
  c: DripGoalCondition,
  opts: { lockedAttribute?: string | null } = {},
): ConditionCheck {
  const issues: ConditionIssue[] = [];
  const limitations: ConditionLimitation[] = [];
  const attribute = String(c.attribute ?? '').trim();

  if (opts.lockedAttribute) {
    if (norm(attribute) !== norm(opts.lockedAttribute)) {
      issues.push({
        code: 'locked-attribute',
        attribute,
        problem: `This event type narrows on "${opts.lockedAttribute}" only, so "${attribute}" cannot be used here.`,
        nearest: [opts.lockedAttribute],
      });
      return { issues, limitations };
    }
    if (c.operator && !LOCKED_ATTR_OPERATORS.includes(c.operator)) {
      issues.push({
        code: 'bad-operator',
        attribute,
        problem: `"${c.operator}" is not an operator this attribute accepts.`,
        allowedOperators: LOCKED_ATTR_OPERATORS,
      });
    }
    if (!conditionValues(c).length) {
      issues.push({ code: 'missing-value', attribute, problem: 'This condition has no value.' });
    }
    return { issues, limitations };
  }

  if (!entity) {
    issues.push({
      code: 'conditions-unsupported',
      attribute,
      problem: 'This event category cannot be narrowed by attribute, so no condition can be attached to it.',
    });
    return { issues, limitations };
  }

  const attrs = (ELIGIBILITY_META as Record<string, Record<string, AttrMeta>>)[entity];
  if (!attrs) {
    issues.push({
      code: 'unknown-entity',
      attribute,
      problem: `"${entity}" is not an entity this platform defines.`,
      nearest: Object.keys(ELIGIBILITY_META),
    });
    return { issues, limitations };
  }

  const realName = Object.keys(attrs).find((n) => norm(n) === norm(attribute));
  if (!realName) {
    // Does it exist somewhere else? That is a far more useful thing to say
    // than "unknown attribute", and it is the shape of the real conflict:
    // Product Type is real, but it belongs to EMI Request, not Transaction.
    const elsewhere = attributeIndex().get(norm(attribute))?.[0];
    issues.push(
      elsewhere
        ? {
            code: 'wrong-entity',
            attribute,
            problem: `"${elsewhere.name}" is an attribute of ${elsewhere.entity}, not ${entity}, so it cannot be used in a ${entity} condition.`,
            ownedBy: elsewhere.entity,
            allowedValues: elsewhere.meta.options,
            nearest: nearestAttributes(attribute, entity),
          }
        : {
            code: 'unknown-attribute',
            attribute,
            problem: `${entity} has no attribute called "${attribute}".`,
            nearest: nearestAttributes(attribute, entity),
          },
    );
    return { issues, limitations };
  }

  const meta = attrs[realName];
  const allowedOperators = dcOperatorsForAttribute(meta);
  if (c.operator && !allowedOperators.includes(c.operator)) {
    issues.push({
      code: 'bad-operator',
      attribute: realName,
      problem: `"${c.operator}" is not an operator ${realName} accepts.`,
      allowedOperators,
    });
  }

  const values = conditionValues(c);
  if (!values.length) {
    issues.push({ code: 'missing-value', attribute: realName, problem: `${realName} has no value.` });
    return { issues, limitations };
  }
  if (meta.type !== 'multiSelect' && values.length > 1) {
    issues.push({
      code: 'bad-value',
      attribute: realName,
      problem: `${realName} takes a single value, but ${values.length} were given.`,
      allowedValues: meta.options,
    });
  }

  if (meta.options?.length) {
    for (const v of values) {
      if (!canonicalValue(v, meta.options)) {
        issues.push({
          code: 'bad-value',
          attribute: realName,
          problem: `"${v}" is not a value ${realName} accepts, so this condition would match nobody.`,
          allowedValues: meta.options,
        });
      }
    }
  } else if (meta.type === 'number') {
    for (const v of values) {
      if (Number.isNaN(Number(v))) {
        issues.push({ code: 'bad-value', attribute: realName, problem: `${realName} is numeric, but "${v}" is not a number.` });
      }
    }
  } else if (meta.type === 'bool') {
    for (const v of values) {
      if (!/^(true|false)$/i.test(v)) {
        issues.push({
          code: 'bad-value',
          attribute: realName,
          problem: `${realName} is true or false, but "${v}" was given.`,
          allowedValues: ['true', 'false'],
        });
      }
    }
  } else if (meta.type === 'smartTag' || meta.type === 'list') {
    limitations.push({
      attribute: realName,
      note:
        meta.type === 'smartTag'
          ? `${realName} is an issuer-configured Smart Tag. The platform metadata holds no list of real tag values, so "${values.join(', ')}" cannot be verified here.`
          : `${realName} is a free-form list, so its entries cannot be checked against platform metadata.`,
    });
  }

  return { issues, limitations };
}

/** Which entity an event category's conditions filter, and any locked attribute. */
export function eventConditionTarget(
  eventCategory: string,
  eventType?: string,
): { entity: string | null; lockedAttribute: string | null; isNew: boolean; known: boolean } {
  const cat = EVENT_CATEGORIES[eventCategory];
  return {
    entity: DC_EVENT_ENTITY[eventCategory] ?? null,
    lockedAttribute: eventType ? (EVENT_ATTR_BY_TYPE[eventType] ?? null) : null,
    isNew: Boolean(cat?.isNew),
    known: Boolean(cat),
  };
}

/** Validates every condition on an event entry, wait-for-event or goal. */
export function validateEventConditions(
  eventCategory: string,
  eventType: string,
  conds: DripGoalCondition[] | undefined,
): ConditionCheck {
  const target = eventConditionTarget(eventCategory, eventType);
  const out: ConditionCheck = { issues: [], limitations: [] };
  for (const c of conds ?? []) {
    const r = validateCondition(target.entity, c, { lockedAttribute: target.lockedAttribute });
    out.issues.push(...r.issues);
    out.limitations.push(...r.limitations);
  }
  return out;
}

/** Validates every condition on an audience entry. */
export function validateAudienceConditions(entity: string, conds: DripGoalCondition[] | undefined): ConditionCheck {
  const out: ConditionCheck = { issues: [], limitations: [] };
  for (const c of conds ?? []) {
    const r = validateCondition(entity, c);
    out.issues.push(...r.issues);
    out.limitations.push(...r.limitations);
  }
  return out;
}

/** One line a person can act on, with the real alternatives attached. */
export function describeIssue(i: ConditionIssue): string {
  const bits = [i.problem];
  if (i.allowedValues?.length) bits.push(`Accepted values: ${i.allowedValues.join(', ')}.`);
  if (i.allowedOperators?.length) bits.push(`Accepted operators: ${i.allowedOperators.join(', ')}.`);
  if (i.nearest?.length && !i.allowedValues?.length) bits.push(`Closest available: ${i.nearest.join(', ')}.`);
  return bits.join(' ');
}
