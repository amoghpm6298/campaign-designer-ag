// Phase 3: a condition is checked against what the platform can represent.
//
// THE DEFECT: an event entry validated its EVENT and nothing else, and an
// audience entry checked attribute NAMES only. No validator anywhere looked
// at a value. A live run produced `Transaction Status = "Auth"` — not one of
// the five values the platform defines — and every check passed, so a
// campaign that would match nobody was reported as pre-validated.
//
// Assertions compare against ELIGIBILITY_META itself, never against a list
// copied into this file. A hardcoded expectation here would be the second
// source of truth the whole design exists to avoid.
import { describe, it, expect } from 'vitest';
import {
  validateCondition,
  validateEventConditions,
  validateAudienceConditions,
  eventConditionTarget,
  normaliseCondition,
  conditionValues,
  describeIssue,
} from '../../src/data/conditionValidation';
import { detectStatedValues, mergeStatedValues, unresolvedConflicts } from '../../server/conflicts';
import { buildFromBlueprint, type CampaignBlueprint } from '../../server/blueprint';
import { validateCampaignGraph } from '../../agent-proto/validate';
import { ELIGIBILITY_META, DC_EVENT_ENTITY, type Channel } from '../../src/data/sharedConstants';

const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP'];
const TXN_STATUS = ELIGIBILITY_META.Transaction['Transaction Status'].options!;
const EMI_PRODUCT = ELIGIBILITY_META['EMI Request']['Product Type'].options!;

describe('attributes, operators and values', () => {
  it('rejects an attribute the entity does not have, and offers real ones', () => {
    const { issues } = validateCondition('Transaction', { attribute: 'Vibes', operator: 'Equals', value: 'good' });
    expect(issues[0].code).toBe('unknown-attribute');
    expect(issues[0].attribute).toBe('Vibes'); // named back as written
    expect(describeIssue(issues[0])).toMatch(/Transaction has no attribute called "Vibes"/);
  });

  it('says WHERE an attribute really lives when it exists on another entity', () => {
    // The EMI conflict in its structural form: Product Type is real, but it
    // belongs to EMI Request. "Unknown attribute" would have been misleading.
    const { issues } = validateCondition('Transaction', { attribute: 'Product Type', operator: 'Equals', value: 'Auth' });
    expect(issues[0].code).toBe('wrong-entity');
    expect(issues[0].ownedBy).toBe('EMI Request');
    expect(issues[0].allowedValues).toEqual(EMI_PRODUCT);
  });

  it('rejects an operator the attribute does not accept', () => {
    const { issues } = validateCondition('Transaction', {
      attribute: 'Transaction Status',
      operator: 'Greater than',
      values: [TXN_STATUS[0]],
    });
    expect(issues.some((i) => i.code === 'bad-operator')).toBe(true);
    expect(issues.find((i) => i.code === 'bad-operator')!.allowedOperators).toEqual(['Any of']);
  });

  it('rejects a value outside the allowed list, and lists the real values', () => {
    const { issues } = validateCondition('Transaction', {
      attribute: 'Transaction Status',
      operator: 'Any of',
      values: ['Auth'],
    });
    expect(issues[0].code).toBe('bad-value');
    expect(issues[0].allowedValues).toEqual(TXN_STATUS);
    expect(describeIssue(issues[0])).toMatch(/would match nobody/);
  });

  it('accepts every value the platform actually defines', () => {
    for (const v of TXN_STATUS) {
      const { issues } = validateCondition('Transaction', {
        attribute: 'Transaction Status',
        operator: 'Any of',
        values: [v],
      });
      expect(issues, v).toEqual([]);
    }
  });

  it('accepts a multi-select carrying several real values, and rejects a mixed set', () => {
    expect(
      validateCondition('Transaction', { attribute: 'Transaction Status', operator: 'Any of', values: TXN_STATUS.slice(0, 2) })
        .issues,
    ).toEqual([]);
    const mixed = validateCondition('Transaction', {
      attribute: 'Transaction Status',
      operator: 'Any of',
      values: [TXN_STATUS[0], 'Nope'],
    });
    expect(mixed.issues).toHaveLength(1);
    expect(mixed.issues[0].problem).toMatch(/"Nope"/);
  });

  it('refuses several values on a single-select attribute', () => {
    const { issues } = validateCondition('Account', { attribute: 'Status', operator: 'Equals', values: ['Active', 'Dormant'] });
    expect(issues.some((i) => /takes a single value/.test(i.problem))).toBe(true);
  });

  it('checks numbers and booleans by type, not by list', () => {
    expect(validateCondition('Transaction', { attribute: 'Transaction Amount', operator: 'Equals', value: '5000' }).issues).toEqual([]);
    expect(
      validateCondition('Transaction', { attribute: 'Transaction Amount', operator: 'Equals', value: 'lots' }).issues[0].problem,
    ).toMatch(/is numeric/);
    expect(validateCondition('Transaction', { attribute: 'EMI Eligible', operator: 'Equals', value: 'true' }).issues).toEqual([]);
    expect(
      validateCondition('Transaction', { attribute: 'EMI Eligible', operator: 'Equals', value: 'maybe' }).issues[0].problem,
    ).toMatch(/true or false/);
  });

  it('reports a missing value rather than treating it as valid', () => {
    const { issues } = validateCondition('Account', { attribute: 'Status', operator: 'Equals', value: '' });
    expect(issues[0].code).toBe('missing-value');
  });

  it('states a limitation where the platform holds no values, instead of passing silently', () => {
    const { issues, limitations } = validateCondition('Account', {
      attribute: 'Smart Tag',
      operator: 'Equals',
      value: 'whatever-the-issuer-configured',
    });
    expect(issues).toEqual([]);
    expect(limitations[0].note).toMatch(/cannot be verified/i);
  });
});

describe('event-to-entity compatibility', () => {
  it('maps each category to the entity its conditions filter', () => {
    for (const [category, entity] of Object.entries(DC_EVENT_ENTITY)) {
      expect(eventConditionTarget(category).entity, category).toBe(entity);
    }
  });

  it('accepts Transaction attributes on a Transaction event', () => {
    const { issues } = validateEventConditions('Transaction Events', 'Transaction', [
      { attribute: 'Transaction Status', operator: 'Any of', values: [TXN_STATUS[0]] },
    ]);
    expect(issues).toEqual([]);
  });

  it('rejects an EMI Request attribute on a Transaction event', () => {
    // The event-source mix-up, caught structurally: New Status is real, but
    // it is not reachable from a Transaction event.
    const { issues } = validateEventConditions('Transaction Events', 'Transaction', [
      { attribute: 'New Status', operator: 'Equals', value: 'Successful' },
    ]);
    expect(issues[0].code).toBe('wrong-entity');
    expect(issues[0].ownedBy).toBe('EMI Request');
  });

  it('rejects a Transaction attribute on an EMI event', () => {
    const { issues } = validateEventConditions('EMI Events', 'EMI_STATUS_CHANGED', [
      { attribute: 'Transaction Status', operator: 'Any of', values: [TXN_STATUS[0]] },
    ]);
    expect(issues[0].code).toBe('wrong-entity');
    expect(issues[0].ownedBy).toBe('Transaction');
  });

  it('refuses conditions on a category that supports none', () => {
    // Card Events resolves neither an entity nor a locked attribute. That is
    // a real gap in the source, reported rather than papered over.
    const { issues } = validateEventConditions('Card Events', 'Card Issued', [
      { attribute: 'Status', operator: 'Equals', value: 'Active' },
    ]);
    expect(issues[0].code).toBe('conditions-unsupported');
  });

  it('holds a locked-attribute category to its one attribute', () => {
    expect(validateEventConditions('Journey Events', 'Pageload', [
      { attribute: 'Page Name', operator: 'Equals', value: 'offers' },
    ]).issues).toEqual([]);
    const wrong = validateEventConditions('Journey Events', 'Pageload', [
      { attribute: 'Button Name', operator: 'Equals', value: 'Apply' },
    ]);
    expect(wrong.issues[0].code).toBe('locked-attribute');
  });
});

describe('the builder refuses to construct an invalid condition', () => {
  const base: CampaignBlueprint = {
    campaignName: 'x',
    description: 'x',
    goal: null,
    entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction', conditions: [] },
    steps: [{ kind: 'send', name: 'Nudge', objective: ['emi'], stage: 'first-touch', describe: 'x' }],
  };

  it('blocks an event entry carrying a value the platform does not define', () => {
    const r = buildFromBlueprint(
      {
        ...base,
        entry: {
          kind: 'event',
          eventCategory: 'Transaction Events',
          eventType: 'Transaction',
          conditions: [{ attribute: 'Transaction Status', operator: 'Any of', value: 'Auth' }],
        },
      },
      CHANNELS,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'entry.conditions' && /"Auth"/.test(i.problem))).toBe(true);
    // The real values are offered, so a person can choose one.
    expect(r.issues.find((i) => i.path === 'entry.conditions')!.problem).toContain(TXN_STATUS.join(', '));
  });

  it('blocks a goal carrying a status the platform does not define', () => {
    const r = buildFromBlueprint(
      {
        ...base,
        goal: {
          eventCategory: 'EMI Events',
          eventType: 'EMI_STATUS_CHANGED',
          conditions: [{ attribute: 'New Status', operator: 'Equals', value: 'Converted' }],
        },
      },
      CHANNELS,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'goal.conditions')).toBe(true);
  });

  it('builds a valid entry, and puts multi-select values where the app looks for them', () => {
    const r = buildFromBlueprint(
      {
        ...base,
        entry: {
          kind: 'event',
          eventCategory: 'Transaction Events',
          eventType: 'Transaction',
          // The shape a live model emits: an array inside `value`.
          conditions: [{ attribute: 'Transaction Status', operator: 'Any of', value: ['APPROVED'] as never }],
        },
      },
      CHANNELS,
    );
    expect(r.issues).toEqual([]);
    const entry = Object.values(r.graph.nodes).find((n) => n.type === 'ENTRY_EVENT')!;
    const cond = (entry._config as { conditions: { values?: string[]; value?: string }[] }).conditions[0];
    // Moved, not changed: the value itself is untouched.
    expect(cond.values).toEqual(['APPROVED']);
  });

  it('reports a Smart Tag as unverifiable rather than passing it as checked', () => {
    const r = buildFromBlueprint(
      {
        ...base,
        entry: { kind: 'audience', entity: 'Account', conditions: [{ attribute: 'Smart Tag', operator: 'Equals', value: 'VIP' }] },
      },
      CHANNELS,
    );
    expect(r.issues).toEqual([]);
    expect(r.limitations[0].note).toMatch(/Smart Tag/);
  });
});

describe('the graph validator catches what the builder would have let through', () => {
  it('fails a graph whose stored condition carries an impossible value', () => {
    // Hand-built, bypassing buildFromBlueprint, which is exactly how a graph
    // reached validation carrying a bad value before this check existed.
    const graph = {
      rootId: 'n1',
      nodes: {
        n1: {
          id: 'n1',
          type: 'ENTRY_EVENT' as const,
          label: 'Transaction',
          meta: '',
          autoGenerated: false,
          _config: {
            eventCategory: 'Transaction Events',
            eventType: 'Transaction',
            conditions: [{ attribute: 'Transaction Status', operator: 'Any of', values: ['Auth'] }],
          },
        },
        n2: { id: 'n2', type: 'EXIT' as const, label: 'End', meta: '', autoGenerated: false, _config: { reason: 'done' } },
      },
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    };
    const report = validateCampaignGraph(graph, { fanOut: [] });
    const check = report.checks.find((c) => c.id === 'condition-validity')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/"Auth"/);
    expect(report.outcome).toBe('failed');
  });

  it('passes a graph whose conditions are all real', () => {
    const graph = {
      rootId: 'n1',
      nodes: {
        n1: {
          id: 'n1',
          type: 'ENTRY_EVENT' as const,
          label: 'Transaction',
          meta: '',
          autoGenerated: false,
          _config: {
            eventCategory: 'Transaction Events',
            eventType: 'Transaction',
            conditions: [{ attribute: 'Transaction Status', operator: 'Any of', values: [TXN_STATUS[0]] }],
          },
        },
        n2: { id: 'n2', type: 'EXIT' as const, label: 'End', meta: '', autoGenerated: false, _config: { reason: 'done' } },
      },
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    };
    const check = validateCampaignGraph(graph, { fanOut: [] }).checks.find((c) => c.id === 'condition-validity')!;
    expect(check.status).toBe('pass');
  });
});

describe('a value the user states is never silently replaced', () => {
  // The live transcript, verbatim.
  const CLARIFY =
    'Entry comes from a Transaction event. Initiated By = customer_initiated, Transaction Type = authorize, ' +
    'Transaction Status = approved. Product type is Auth and new status is successful.';

  it('matches the values the platform does define, whatever the casing', () => {
    const stated = detectStatedValues(CLARIFY);
    const byAttr = Object.fromEntries(stated.map((s) => [s.attribute, s]));
    expect(byAttr['Initiated By'].status).toBe('matches');
    expect(byAttr['Initiated By'].canonical).toBe('CUSTOMER_INITIATED');
    expect(byAttr['Transaction Status'].canonical).toBe('APPROVED');
    expect(byAttr['New Status'].canonical).toBe('Successful');
    // The user's own words are kept, not overwritten by the canonical form.
    expect(byAttr['Transaction Status'].statement).toMatch(/approved/);
  });

  it('flags the one value the platform cannot hold, with the real alternatives', () => {
    const conflicts = unresolvedConflicts(detectStatedValues(CLARIFY));
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0];
    expect(c.attribute).toBe('Product Type');
    expect(c.value).toBe('Auth');
    expect(c.entities).toEqual(['EMI Request']);
    expect(c.allowedValues).toEqual(EMI_PRODUCT);
    // Preserved verbatim, explained, alternatives offered — and no
    // substitute attribute anywhere in the explanation.
    expect(c.statement).toMatch(/Product type is Auth/i);
    expect(c.explanation).toContain(EMI_PRODUCT.join(', '));
    expect(c.explanation).not.toMatch(/EMI Eligible/);
  });

  it('a conflict is resolved by the user restating it, not by the agent choosing', () => {
    let stated = detectStatedValues(CLARIFY);
    expect(unresolvedConflicts(stated)).toHaveLength(1);
    stated = mergeStatedValues(stated, detectStatedValues(`Product Type = ${EMI_PRODUCT[0]}`));
    expect(unresolvedConflicts(stated)).toHaveLength(0);
  });

  it('ignores ordinary prose rather than guessing at it', () => {
    expect(detectStatedValues('The problem is silent non-conversion and the goal is more conversions.')).toEqual([]);
  });

  it('says so when the platform cannot verify a stated value', () => {
    const stated = detectStatedValues('Smart Tag = VIP-GOLD');
    expect(stated[0].status).toBe('unverifiable');
    expect(stated[0].explanation).toMatch(/cannot be verified/i);
  });
});

describe('helpers behave as the rest of the system assumes', () => {
  it('reads values from either shape without changing them', () => {
    expect(conditionValues({ attribute: 'a', operator: 'Any of', value: ['X', 'Y'] as never })).toEqual(['X', 'Y']);
    expect(conditionValues({ attribute: 'a', operator: 'Equals', value: 'X' })).toEqual(['X']);
    expect(conditionValues({ attribute: 'a', operator: 'Any of', values: ['X'] })).toEqual(['X']);
  });

  it('normalising moves a multi-select value without altering it', () => {
    const out = normaliseCondition(
      { attribute: 'Transaction Status', operator: 'Any of', value: 'APPROVED' },
      ELIGIBILITY_META.Transaction['Transaction Status'],
    );
    expect(out.values).toEqual(['APPROVED']);
    expect(validateAudienceConditions('Transaction', [out]).issues).toEqual([]);
  });
});
