// The capability check that makes the platform gap the application's finding
// rather than the agent's claim.
//
// Grounded entirely in real metadata: if the platform gains an attribute these
// answers change with no edit here. That is the point — a hand-maintained copy
// of what the builder supports would drift, and a drifted capability check is
// worse than none, because it would confidently deny something buildable.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluate, owners, attributesIn, allEvents, entryPoints, compatibility, gaps, briefBack } from '../../server/capability';

describe('attribute ownership comes from real metadata', () => {
  it('finds the entity that actually carries an attribute', () => {
    expect(owners('EMI Eligible')).toEqual(['Transaction']);
    expect(owners('Statement Due Date')).toEqual(['Account']);
    expect(owners('Smart Tag').sort()).toEqual(['Account', 'Card']);
  });

  it('is case and whitespace forgiving, because the agent types these', () => {
    expect(owners('  emi eligible ')).toEqual(['Transaction']);
  });

  it('knows an invented attribute is invented', () => {
    // The one the whole OS-to-EMI problem turns on: there is no running
    // outstanding balance anywhere in this platform.
    expect(owners('Outstanding Balance')).toEqual([]);
    expect(owners('Credit Limit')).toEqual([]);
  });
});

describe('a requirement is judged against where the campaign starts', () => {
  it('is direct when the chosen entry owns it', () => {
    const [v] = evaluate([{ need: 'only eligible balances', attribute: 'EMI Eligible' }], 'Transaction');
    expect(v.support).toBe('direct');
  });

  it('is alternative-entry when another entity owns it', () => {
    // THE MEASURED CASE: eligibility lives on Transaction, due-date timing on
    // Account. Entry filters one entity, so one of them is always out of reach.
    const [v] = evaluate([{ need: 'time it to the statement', attribute: 'Statement Due Date' }], 'Transaction');
    expect(v.support).toBe('alternative-entry');
    expect(v.carriedBy).toEqual(['Account']);
    expect(v.detail).toContain('rather than Transaction');
  });

  it('is elsewhere-in-journey when no attribute filters it but an event exists', () => {
    // "Have they already started a request?" cannot be filtered at entry. It
    // can be waited for. That is a real answer and not the same as "no".
    const [v] = evaluate(
      [{ need: 'exclude people who already started', event: allEvents().find((e) => /EMI/i.test(e)) }],
      'Account',
    );
    expect(v.support).toBe('elsewhere-in-journey');
    expect(v.detail).toContain('wait for');
  });

  it('is unsupported when neither an attribute nor an event covers it', () => {
    const [v] = evaluate([{ need: 'target by outstanding balance size', attribute: 'Outstanding Balance' }], 'Account');
    expect(v.support).toBe('unsupported');
    expect(v.detail).toContain('does not exist');
  });

  it('treats a nonexistent event as no answer at all', () => {
    const [v] = evaluate([{ need: 'wait for something imaginary', event: 'CUSTOMER_CHANGED_MIND' }], 'Account');
    expect(v.support).toBe('unsupported');
  });

  it('reads nothing as direct while no entry has been chosen', () => {
    // Honest: nothing is usable at an entry nobody has picked yet.
    const [v] = evaluate([{ need: 'only eligible balances', attribute: 'EMI Eligible' }], null);
    expect(v.support).toBe('alternative-entry');
  });
});

describe('requirements that cannot hold together are named', () => {
  const reqs = [
    { need: 'only eligible balances', attribute: 'EMI Eligible' },
    { need: 'time it to the statement', attribute: 'Statement Due Date' },
  ];

  it('groups by the entity that would have to be the entry', () => {
    const { groups } = compatibility(reqs);
    expect(groups.get('Transaction')).toEqual(['only eligible balances']);
    expect(groups.get('Account')).toEqual(['time it to the statement']);
  });

  it('lists what nothing carries', () => {
    expect(compatibility([{ need: 'balance size', attribute: 'Outstanding Balance' }]).orphans)
      .toEqual(['balance size']);
  });

  it('tells the model these are different campaigns, not one', () => {
    const text = briefBack(evaluate(reqs, 'Transaction'), reqs);
    expect(text).toContain('Entry filters ONE entity');
    expect(text).toMatch(/choosing one gives up the others/);
  });
});

describe('the brief back aims at the next design, not at itself', () => {
  it('demands the gap be stated in the user\'s own terms', () => {
    const reqs = [{ need: 'never started a conversion', attribute: 'Outstanding Balance' }];
    const text = briefBack(evaluate(reqs, 'Account'), reqs);
    expect(text).toContain('1 of your 1 requirements cannot be met');
    expect(text).toMatch(/who they asked for, who will actually be reached/);
    expect(text).toMatch(/Do not quietly narrow/);
  });

  it('says so plainly when nothing is in the way', () => {
    const reqs = [{ need: 'only eligible balances', attribute: 'EMI Eligible' }];
    const text = briefBack(evaluate(reqs, 'Transaction'), reqs);
    expect(text).toContain('Every requirement you stated can be met');
    expect(gaps(evaluate(reqs, 'Transaction'))).toEqual([]);
  });
});

describe('an eligibility gap is never put to the user as a choice', () => {
  // THE RUN THIS COMES FROM. briefBack used to end with "that difference is
  // the user's decision, not yours" for every unmet requirement, and the
  // model obeyed: it spent both of its fork questions asking a campaign
  // manager whether they minded messaging customers with incomplete KYC, and
  // whether to hold the campaign pending a suppression list. Neither is a
  // question about EMI conversion.
  const reach = { need: 'Catch the customer when the balance becomes convertible', attribute: 'Nonexistent Attribute' };
  const hygiene = { need: 'Exclude: customers whose KYC is incomplete', attribute: 'Nonexistent Attribute' };

  it('tells the model NOT to ask about an exclusion it cannot apply', () => {
    const text = briefBack(evaluate([hygiene], 'Transaction'), [hygiene]);
    expect(text).toMatch(/Do NOT put these to the user as a choice/);
    expect(text).toMatch(/record it as a limitation/);
  });

  it('does not attach the user-decides instruction to an exclusion', () => {
    const text = briefBack(evaluate([hygiene], 'Transaction'), [hygiene]);
    expect(text).not.toMatch(/the user's decision, not yours/);
  });

  it('still hands a REACHED-AUDIENCE gap to the user, which is theirs to decide', () => {
    // The other half must survive. Who gets reached is material, and the
    // prompt pins this rule in three separate test files.
    const text = briefBack(evaluate([reach], 'Transaction'), [reach]);
    expect(text).toMatch(/who they asked for, who will actually be reached/);
    expect(text).toMatch(/the user's decision, not yours/);
  });

  it('separates the two when a design carries both', () => {
    const reqs = [reach, hygiene];
    const text = briefBack(evaluate(reqs, 'Transaction'), reqs);
    expect(text).toMatch(/change WHO IS REACHED/);
    expect(text).toMatch(/Do NOT put these to the user as a choice/);
  });

  it('says nothing about either when every requirement is met', () => {
    const ok = [{ need: 'Filter on account standing', attribute: 'Account Status' }];
    const text = briefBack(evaluate(ok, 'Account'), ok);
    expect(text).toMatch(/can be met at entry/);
    expect(text).not.toMatch(/Do NOT put these/);
  });
});

describe('the platform surface is read, not hardcoded', () => {
  it('enumerates every real entry point', () => {
    const eps = entryPoints();
    expect(eps.filter((e) => e.label.startsWith('Audience')).length).toBe(5);
    expect(eps.some((e) => e.label.startsWith('Event'))).toBe(true);
  });
});

// The design step is wired into the orchestrator, not merely callable.
//
// Every one of these is a source-shape assertion, which is weaker than a
// behavioural one — but the behaviour needs a live model round, and the thing
// most likely to silently regress is the ORDERING: a design step that runs
// after the blueprint exists is worthless, because a model writing both at
// once describes an intervention that matches what it built.
describe('the design step runs before the blueprint, inside the model loop', () => {
  const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('intercepts a design action and loops again rather than finishing', () => {
    expect(orch).toMatch(/act === 'design' && !designSeen/);
    expect(orch).toMatch(/conversation\.push\(\{ role: 'user', content: briefBackCapability/);
    // `continue`, not `break` — the model answers again in the same turn, so
    // this costs no extra turn from the user.
    const block = orch.slice(orch.indexOf("act === 'design'"), orch.indexOf("act === 'propose'"));
    expect(block).toMatch(/continue;/);
  });

  it('sends back a proposal that skipped the design step, exactly once', () => {
    expect(orch).toMatch(/act === 'propose' && !designSeen && !designDemanded/);
    // Once only. A guard with no way out is a deadlock, and this codebase has
    // already paid for that with a five-turn run that never proposed.
    expect(orch).toMatch(/designDemanded = true;/);
  });

  it('puts the gap in front of the user rather than only in the prompt', () => {
    expect(orch).toContain('**What you asked for that this platform cannot do**');
    expect(orch).toMatch(/\+ gapSection;/);
  });
});

// The agent writes filters, not attribute names.
//
// MEASURED on the first live run of the design step: every `attribute` the
// agent supplied was a whole expression — "Transaction: EMI Eligible = true
// (combined with a settled/approved transaction status)". Exact matching found
// none of them and reported SIX of six requirements unsupported, three of them
// wrongly. A capability check that says "impossible" about something possible
// makes the design SMALLER, which is the precise failure the design step was
// built to prevent.
describe('attribute lookup reads what the agent actually writes', () => {
  it('finds the attribute inside a filter expression', () => {
    expect(owners('Transaction: EMI Eligible = true (combined with a settled status)')).toEqual(['Transaction']);
    expect(owners('Transaction: Transaction Amount (Greater than / Between a threshold)')).toEqual(['Transaction']);
  });

  it('prefers the longer name when two overlap', () => {
    // "Transaction Status" must win over "Status", or the requirement is
    // attributed to Account and Card as well.
    expect(attributesIn('Transaction Status is approved')).toEqual(['Transaction Status']);
    expect(owners('Transaction Status is approved')).toEqual(['Transaction']);
  });

  it('follows the entity the agent named, not an incidental word', () => {
    expect(owners('Card: Blocked = false, Locked = false')).toEqual(['Card']);
    // MY TEST WAS WRONG HERE FIRST. I expected [] on the reasoning that two
    // entities cannot both be the entry — but Card genuinely owns BOTH Status
    // and Card Expiry, so Card alone satisfies it. Naming both entities
    // returns both, and `compatibility` is what reports that they are
    // mutually exclusive at entry. That separation is deliberate: this
    // function answers "who could carry this", not "can these coexist".
    expect(owners('Account Status active and Card Expiry soon').sort()).toEqual(['Account', 'Card']);
  });

  it('requires one entity to carry everything when no entity is named', () => {
    expect(owners('Statement Due Date and EMI Eligible together')).toEqual([]);
  });

  it('still finds nothing when there is genuinely nothing', () => {
    expect(owners('absence of any prior EMI request record')).toEqual([]);
    expect(attributesIn('outstanding balance across the account')).toEqual([]);
  });

  it('does not match an attribute name inside a longer word', () => {
    expect(attributesIn('the statuses were reviewed')).toEqual([]);
  });
});
