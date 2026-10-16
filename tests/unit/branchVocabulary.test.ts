// Cohorts become expressible.
//
// THE DEFECT: the builder has always supported a Condition on an entity
// attribute and an N-way Branch (DECISION_SPLIT). The vocabulary the agent
// writes in had neither — its only fork was "was the last message delivered".
// So cohorting could happen at entry and nowhere else, and a balance-tiered
// journey was unbuildable however good discovery got. In a live run the agent
// offered exactly that as its second candidate architecture and could not have
// built it.
//
// These tests go through the REAL reducer, not a mock, so a graph that builds
// here is one the builder would accept.
import { describe, it, expect } from 'vitest';
import { buildFromBlueprint } from '../../server/blueprint';
import type { CampaignBlueprint, BpStep } from '../../server/blueprint';

const send = (name: string): BpStep => ({
  kind: 'send', name, objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['EMAIL'],
});

const bp = (steps: BpStep[]): CampaignBlueprint => ({
  campaignName: 'c', description: 'd', goal: null,
  entry: { kind: 'audience', entity: 'Account', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
  steps,
});

// The array form is the documented shorthand: channels only, realistic
// 'unavailable' template default.
const build = (steps: BpStep[]) => buildFromBlueprint(bp(steps), ['EMAIL', 'SMS', 'WHATSAPP'] as never);

describe('a condition can read a customer attribute, not just a delivery outcome', () => {
  it('builds an attribute fork with no preceding Send', () => {
    // The old code required a preceding Send for every condition, because the
    // only thing it could check was that Send's outcome.
    const out = build([
      { kind: 'condition', label: 'active card?', on: { entity: 'Card', attribute: 'Status', operator: 'Equals', value: 'Active' },
        yes: [send('For active cards')], no: [send('For everyone else')] },
    ]);
    expect(out.issues).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it('still builds the delivery-outcome fork it always could', () => {
    const out = build([
      send('First'),
      { kind: 'condition', label: 'delivered?', outcomes: ['DELIVERED'], yes: [send('Yes path')], no: [send('No path')] },
    ]);
    expect(out.issues).toEqual([]);
  });

  it('rejects an attribute that does not exist rather than coercing it', () => {
    const out = build([
      { kind: 'condition', label: 'balance?', on: { entity: 'Account', attribute: 'Outstanding Balance', operator: 'Greater than', value: '25000' },
        yes: [send('Large')], no: [send('Small')] },
    ]);
    expect(out.issues[0].problem).toContain('no attribute "Outstanding Balance"');
  });

  it('rejects a condition that checks nothing at all', () => {
    const out = build([{ kind: 'condition', label: 'empty', yes: [send('A')], no: [send('B')] }]);
    expect(out.issues[0].problem).toContain('either delivery outcomes or an attribute');
  });

  it('still requires a preceding Send for a delivery-outcome fork', () => {
    const out = build([
      { kind: 'condition', label: 'delivered?', outcomes: ['DELIVERED'], yes: [send('A')], no: [send('B')] },
    ]);
    expect(out.issues[0].problem).toContain('needs a preceding Send');
  });
});

describe('N-way branching — the step that makes cohorts expressible', () => {
  it('builds three paths on one attribute', () => {
    const out = build([
      { kind: 'branch', label: 'by transaction size', entity: 'Transaction', attribute: 'Transaction Amount',
        paths: [
          { label: 'Large', operator: 'Greater than', value: '25000', steps: [send('Large treatment')] },
          { label: 'Medium', operator: 'Greater than', value: '5000', steps: [send('Medium treatment')] },
          { label: 'Small', operator: 'Less than', value: '5000', steps: [send('Small treatment')] },
        ] },
    ]);
    expect(out.issues).toEqual([]);
    // Every path reached the graph as its own route.
    const sends = Object.values(out.graph.nodes).filter((n) => n.type === 'SEND');
    expect(sends.length).toBe(3);
  });

  it('rejects an attribute the entity does not have', () => {
    const out = build([
      { kind: 'branch', label: 'x', entity: 'Account', attribute: 'Credit Limit',
        paths: [{ label: 'A', operator: 'Equals', value: '1', steps: [send('A')] }] },
    ]);
    expect(out.issues[0].problem).toContain('no attribute "Credit Limit"');
  });

  it('rejects a branch with no paths', () => {
    const out = build([
      { kind: 'branch', label: 'x', entity: 'Account', attribute: 'Status', paths: [] },
    ]);
    expect(out.issues[0].problem).toContain('at least one path');
  });
});
