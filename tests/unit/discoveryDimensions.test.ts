// Step 2: the brief can say WHICH lines of enquiry were considered, and what
// became of each.
//
// WHY THIS EXISTS. Measured in two real conversations (EMI and OS-to-EMI), the
// agent asked exactly one question each time, both about trigger
// configuration, and never considered how customers differ from one another.
// The application could not detect that, because `WorkingBrief` held flat
// lists of facts, questions and answers with nothing recording which aspects
// of the design had been examined. A dimension never examined and one
// examined and dismissed were indistinguishable.
//
// This step adds the record only. Nothing reads it yet: the gate, the prompts,
// the stopping conditions and the strategy are deliberately untouched, so the
// agent's behaviour is byte-for-byte what it was. Those come later.
import { describe, it, expect } from 'vitest';
import {
  newBrief,
  recordDimensions,
  briefDimensions,
  isPlatformDimension,
  type DiscoveryDimension,
  type WorkingBrief,
} from '../../server/discovery';

const OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

/** The dimension a real OS-to-EMI run never raised. */
const OS_AMOUNT = {
  name: 'Outstanding statement amount',
  rationale: 'Different balances may make EMI more or less attractive, which would change targeting.',
  status: 'open',
  basis: 'none',
} as const;

describe('creation', () => {
  it('a new brief starts with an empty, present record', () => {
    const b = newBrief(OBJECTIVE);
    expect(b.dimensions).toEqual([]);
    expect(b.successCriteria).toEqual([]);
    expect(b.contextChecked).toEqual([]);
  });

  it('records a dimension with its rationale, status and basis', () => {
    const b = recordDimensions(newBrief(OBJECTIVE), [OS_AMOUNT]);
    expect(b.dimensions).toHaveLength(1);
    expect(b.dimensions![0]).toEqual(OS_AMOUNT);
  });

  it('defaults an under-specified dimension to open with no basis', () => {
    // "Raised, nothing established yet" — never a finding the agent has not made.
    const b = recordDimensions(newBrief(OBJECTIVE), [{ name: 'Credit utilisation' }]);
    expect(b.dimensions![0]).toEqual({ name: 'Credit utilisation', rationale: '', status: 'open', basis: 'none' });
  });

  it('records several dimensions in the order they were raised', () => {
    const b = recordDimensions(newBrief(OBJECTIVE), [
      { name: 'Outstanding statement amount' },
      { name: 'Credit utilisation' },
      { name: 'Statement timing' },
    ]);
    expect(briefDimensions(b).map((d) => d.name)).toEqual([
      'Outstanding statement amount',
      'Credit utilisation',
      'Statement timing',
    ]);
  });

  it('ignores a dimension with no usable name', () => {
    const b = recordDimensions(newBrief(OBJECTIVE), [{ name: '' }, { name: '   ' }]);
    expect(b.dimensions).toEqual([]);
  });

  it('trims the stored name', () => {
    const b = recordDimensions(newBrief(OBJECTIVE), [{ name: '  Statement timing  ' }]);
    expect(b.dimensions![0].name).toBe('Statement timing');
  });

  it('does not store platform topics, so they cannot fill the three slots', () => {
    // Live runs satisfied MIN_DIMENSIONS with entry event, channel order and
    // quiet hours. Those describe the builder, not a customer.
    const b = recordDimensions(newBrief(OBJECTIVE), [
      { name: 'Entry event' },
      { name: 'Channel sequencing' },
      { name: 'Quiet hours' },
      { name: 'Which channels exist' },
      { name: 'Message template' },
      { name: 'Suppression (DNC, NPA, quiet hours)' },
      { name: 'Assigned credit limit' },
      { name: 'Already started the request' },
      { name: 'App on the phone' },
    ]);
    expect(briefDimensions(b).map((d) => d.name)).toEqual([
      'Assigned credit limit',
      'Already started the request',
      'App on the phone',
    ]);
  });

  it('still records a customer channel difference, which is not the channel list', () => {
    const b = recordDimensions(newBrief(OBJECTIVE), [{ name: 'Channel preference by segment' }]);
    expect(briefDimensions(b)).toHaveLength(1);
    expect(isPlatformDimension('Channel preference by segment')).toBe(false);
  });
});

describe('status changes', () => {
  const run = (status: DiscoveryDimension['status'], basis: DiscoveryDimension['basis'], note: string) =>
    recordDimensions(recordDimensions(newBrief(OBJECTIVE), [OS_AMOUNT]), [
      { name: 'Outstanding statement amount', status, basis, note },
    ]);

  it('moves a dimension to retained', () => {
    const d = briefDimensions(run('retained', 'user', 'The bank confirmed a hypothesis worth acting on.'))[0];
    expect(d.status).toBe('retained');
    expect(d.basis).toBe('user');
  });

  it('moves a dimension to deferred, keeping the reason', () => {
    const d = briefDimensions(run('deferred', 'assumption', 'No evidence it should change the intervention yet.'))[0];
    expect(d.status).toBe('deferred');
    expect(d.note).toMatch(/No evidence/);
  });

  it('moves a dimension to unavailable on a TOOL basis, not an assumption', () => {
    // The real finding: no outstanding-balance attribute exists on any
    // entity. "Checked and absent" must never read as "assumed absent".
    const d = briefDimensions(run('unavailable', 'tool', 'No outstanding-balance attribute exists on any entity.'))[0];
    expect(d.status).toBe('unavailable');
    expect(d.basis).toBe('tool');
  });

  it('can reopen a dimension a later answer unsettles', () => {
    const settled = recordDimensions(newBrief(OBJECTIVE), [{ ...OS_AMOUNT, status: 'deferred', basis: 'assumption' }]);
    const reopened = recordDimensions(settled, [{ name: 'Outstanding statement amount', status: 'open' }]);
    expect(briefDimensions(reopened)[0].status).toBe('open');
    // Reopening does not discard the basis already recorded.
    expect(briefDimensions(reopened)[0].basis).toBe('assumption');
  });
});

describe('merging across turns preserves what it does not change', () => {
  it('an update that omits a field keeps the previous value', () => {
    const round1 = recordDimensions(newBrief(OBJECTIVE), [OS_AMOUNT]);
    const round2 = recordDimensions(round1, [{ name: 'Outstanding statement amount', status: 'unavailable' }]);
    const d = briefDimensions(round2)[0];
    expect(d.status).toBe('unavailable');
    // THE REGRESSION: a status-only update must not blank the rationale that
    // justified raising the dimension.
    expect(d.rationale).toBe(OS_AMOUNT.rationale);
  });

  it('a round that discusses one dimension leaves the others untouched', () => {
    const round1 = recordDimensions(newBrief(OBJECTIVE), [
      { ...OS_AMOUNT, status: 'unavailable', basis: 'tool', note: 'No balance attribute exists.' },
      { name: 'Statement timing', rationale: 'Decides when we can intervene.', status: 'retained', basis: 'user' },
    ]);
    // Round 2 only talks about timing.
    const round2 = recordDimensions(round1, [{ name: 'Statement timing', note: 'After statement generation.' }]);

    const os = briefDimensions(round2).find((d) => d.name === OS_AMOUNT.name)!;
    expect(os.status).toBe('unavailable');
    expect(os.basis).toBe('tool');
    expect(os.note).toBe('No balance attribute exists.');
    const timing = briefDimensions(round2).find((d) => d.name === 'Statement timing')!;
    expect(timing.status).toBe('retained');
    expect(timing.note).toBe('After statement generation.');
  });

  it('does not duplicate a dimension restated with different casing or spacing', () => {
    const round1 = recordDimensions(newBrief(OBJECTIVE), [OS_AMOUNT]);
    const round2 = recordDimensions(round1, [{ name: '  outstanding STATEMENT amount ', status: 'deferred' }]);
    expect(briefDimensions(round2)).toHaveLength(1);
    // The first spelling wins, so the identity is stable across rounds.
    expect(briefDimensions(round2)[0].name).toBe(OS_AMOUNT.name);
    expect(briefDimensions(round2)[0].status).toBe('deferred');
  });

  it('appends a newly raised dimension after the existing ones', () => {
    const round1 = recordDimensions(newBrief(OBJECTIVE), [OS_AMOUNT]);
    const round2 = recordDimensions(round1, [
      { name: 'Outstanding statement amount', status: 'deferred' },
      { name: 'Conversion barriers', rationale: 'Why eligible customers do not convert.' },
    ]);
    expect(briefDimensions(round2).map((d) => d.name)).toEqual([OS_AMOUNT.name, 'Conversion barriers']);
  });

  it('survives many rounds without losing the earliest finding', () => {
    let b: WorkingBrief = newBrief(OBJECTIVE);
    b = recordDimensions(b, [{ ...OS_AMOUNT, status: 'unavailable', basis: 'tool', note: 'Checked: absent.' }]);
    for (const name of ['Credit utilisation', 'Spending behaviour', 'Statement timing', 'Previous EMI behaviour']) {
      b = recordDimensions(b, [{ name, rationale: 'Considered for this objective.' }]);
    }
    expect(briefDimensions(b)).toHaveLength(5);
    expect(briefDimensions(b)[0]).toMatchObject({ status: 'unavailable', basis: 'tool', note: 'Checked: absent.' });
  });

  it('never mutates the brief it was given', () => {
    const before = recordDimensions(newBrief(OBJECTIVE), [OS_AMOUNT]);
    const snapshot = JSON.parse(JSON.stringify(before));
    recordDimensions(before, [{ name: 'Outstanding statement amount', status: 'unavailable' }]);
    expect(before).toEqual(snapshot);
  });

  it('an empty update list changes nothing', () => {
    const before = recordDimensions(newBrief(OBJECTIVE), [OS_AMOUNT]);
    expect(recordDimensions(before, []).dimensions).toEqual(before.dimensions);
  });
});

describe('briefs saved before these fields existed', () => {
  /** Exactly what an older client round-trips: no new fields at all. */
  const legacy = (): WorkingBrief => {
    const b = newBrief(OBJECTIVE) as Record<string, unknown>;
    delete b.dimensions;
    delete b.successCriteria;
    delete b.contextChecked;
    return b as unknown as WorkingBrief;
  };

  it('reads as an empty record rather than throwing', () => {
    const b = legacy();
    expect(b.dimensions).toBeUndefined();
    expect(briefDimensions(b)).toEqual([]);
  });

  it('accepts dimensions onto a legacy brief', () => {
    const b = recordDimensions(legacy(), [OS_AMOUNT]);
    expect(b.dimensions).toHaveLength(1);
    expect(b.dimensions![0].name).toBe(OS_AMOUNT.name);
  });

  it('keeps every pre-existing field intact', () => {
    const b = legacy();
    b.facts = [{ statement: 'Goal is EMI_STATUS_CHANGED Successful.', source: 'retrieved-context', round: 1 }];
    b.limitations = ['EMI Events is marked new in the platform metadata.'];
    const after = recordDimensions(b, [OS_AMOUNT]);
    expect(after.facts).toEqual(b.facts);
    expect(after.limitations).toEqual(b.limitations);
    expect(after.objective).toBe(OBJECTIVE);
  });
});

describe('success criteria and the context check are recorded, never invented', () => {
  it('holds criteria as the user framed them, with no target value', () => {
    const b: WorkingBrief = {
      ...newBrief(OBJECTIVE),
      successCriteria: ['Successful OS-to-EMI conversions', 'Conversion rate among eligible entrants'],
    };
    expect(b.successCriteria).toHaveLength(2);
    // No performance history exists for this bank, so nothing numeric belongs here.
    expect(b.successCriteria!.join(' ')).not.toMatch(/\d+\s*%/);
  });

  it('records which sources were checked and whether anything was found', () => {
    const b: WorkingBrief = {
      ...newBrief(OBJECTIVE),
      contextChecked: [
        { source: 'knowledge base', found: true },
        { source: 'bank context', found: true },
        { source: 'existing campaign designs', found: false },
      ],
    };
    expect(b.contextChecked!.filter((c) => !c.found).map((c) => c.source)).toEqual(['existing campaign designs']);
  });
});
