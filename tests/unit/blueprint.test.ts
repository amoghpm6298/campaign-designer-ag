// The model/code boundary: a blueprint is business intent, and everything
// structural is built by the application's own reducer. These tests cover the
// deterministic half — no LLM involved — because that is the half that must
// never let an invented node type, event or template reach the campaign.
import { describe, it, expect } from 'vitest';
import { buildFromBlueprint, blueprintVocabulary, type CampaignBlueprint } from '../../server/blueprint';
import { scoreTemplates } from '../../agent-proto/templateSelect';
import { validateCampaignGraph } from '../../agent-proto/validate';
import { EVENT_CATEGORIES, COMMS_TEMPLATES, ELIGIBILITY_META, type Channel } from '../../src/data/sharedConstants';

const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

const linear: CampaignBlueprint = {
  campaignName: 'Auth txn to EMI',
  description: 'Convert an eligible purchase to EMI before the request expires.',
  goal: {
    eventCategory: 'EMI Events',
    eventType: 'EMI_STATUS_CHANGED',
    conditions: [{ attribute: 'New Status', operator: 'Equals', value: 'Successful' }],
  },
  entry: {
    kind: 'event',
    eventCategory: 'Transaction Events',
    eventType: 'Transaction',
    conditions: [{ attribute: 'EMI Eligible', operator: 'Equals', value: 'true' }],
  },
  steps: [
    { kind: 'send', name: 'EMI offer', objective: ['emi', 'convert'], stage: 'first-touch', describe: 'Convert to EMI.' },
    { kind: 'wait', durationHours: 48 },
    { kind: 'send', name: 'EMI reminder', objective: ['emi', 'convert'], stage: 'reminder', describe: 'Still open.' },
    { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7 },
  ],
};

describe('blueprint → graph, built by the application reducer', () => {
  it('builds a linear campaign that passes the app\'s own validators', () => {
    const r = buildFromBlueprint(linear, CHANNELS);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.graph.rootId).toBeTruthy();

    // Goal Checks are inserted by the app's reducer, not by the blueprint.
    const types = Object.values(r.graph.nodes).map((n) => n.type);
    expect(types).toContain('ENTRY_EVENT');
    expect(types.filter((t) => t === 'SEND')).toHaveLength(2);
    expect(types).toContain('PAUSE');
    expect(types).toContain('WAIT_UNTIL');
    expect(types).toContain('GOAL_CHECK');
    expect(types).toContain('GOAL_EXIT');

    const report = validateCampaignGraph(r.graph, { fanOut: [] });
    expect(report.checks.find((c) => c.id === 'node-config')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'no-open-branches')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'referential-integrity')?.status).toBe('pass');
  });

  it('resolves only real template ids, by objective rather than by id', () => {
    const r = buildFromBlueprint(linear, CHANNELS);
    const real = new Set(COMMS_TEMPLATES.map((t) => t.id));
    expect(r.templateChoices.length).toBe(2);
    for (const c of r.templateChoices) {
      expect(real.has(c.templateId!), `${c.templateId} must be a real template`).toBe(true);
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  it('rejects an invented event type instead of coercing it', () => {
    const bad: CampaignBlueprint = {
      ...linear,
      entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'TOTALLY_MADE_UP' },
    };
    const r = buildFromBlueprint(bad, CHANNELS);
    expect(r.ok).toBe(false);
    expect(r.issues[0].problem).toMatch(/is not a real event/);
    // And it did not quietly build something else.
    expect(r.graph.rootId).toBeNull();
  });

  it('rejects an invented attribute on an audience entry', () => {
    const r = buildFromBlueprint(
      { ...linear, entry: { kind: 'audience', entity: 'Account', conditions: [{ attribute: 'Vibes', operator: 'Equals', value: 'good' }] } },
      CHANNELS,
    );
    // Wording moved to the shared validator in Phase 3; the guarantee did
    // not. The attribute is named back as written, and nothing is swapped in
    // for it.
    expect(r.issues.some((i) => /Account has no attribute called "Vibes"/.test(i.problem))).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('keeps the Send and reports it unresolved instead of inventing a template id', () => {
    // Behaviour changed deliberately: a step the agent cannot complete is no
    // longer dropped. It stays in the journey with the application's own
    // unset values, and the validator blocks export. See
    // tests/unit/missingTemplate.test.ts for the full contract.
    const r = buildFromBlueprint(
      {
        ...linear,
        steps: [{ kind: 'send', name: 'Mortgage push', objective: ['mortgage', 'refinance'], stage: 'first-touch', describe: 'Refinance your home loan.' }],
      },
      CHANNELS,
    );
    expect(r.sendProposals).toHaveLength(1);
    expect(r.templateChoices).toEqual([]);
    expect(Object.values(r.graph.nodes).filter((n) => n.type === 'SEND')).toHaveLength(1);
    expect(JSON.stringify(r.graph)).not.toMatch(/"templateId":"CT-/);
  });

  it('builds a real A/B experiment with the app\'s RANDOM_SPLIT node', () => {
    const r = buildFromBlueprint(
      {
        ...linear,
        steps: [
          {
            kind: 'experiment',
            label: 'Channel test',
            arms: [
              { label: 'SMS first', pct: 50, steps: [{ kind: 'send', name: 'A', objective: ['emi'], stage: 'first-touch', describe: 'x', channelPreference: ['SMS'] }] },
              { label: 'WhatsApp first', pct: 50, steps: [{ kind: 'send', name: 'B', objective: ['emi'], stage: 'first-touch', describe: 'x', channelPreference: ['WHATSAPP'] }] },
            ],
          },
        ],
      },
      CHANNELS,
    );
    expect(r.issues).toEqual([]);
    const split = Object.values(r.graph.nodes).find((n) => n.type === 'RANDOM_SPLIT');
    expect(split).toBeTruthy();
    expect(r.graph.edges.filter((e) => e.from === split!.id)).toHaveLength(2);
    // Both arms used the channel they asked for.
    expect(r.templateChoices.map((c) => c.channel).sort()).toEqual(['SMS', 'WHATSAPP']);
    expect(validateCampaignGraph(r.graph, { fanOut: [] }).checks.find((c) => c.id === 'no-open-branches')?.status).toBe('pass');
  });

  it('rejects experiment arms that do not sum to 100', () => {
    const r = buildFromBlueprint(
      {
        ...linear,
        steps: [
          {
            kind: 'experiment',
            label: 'Bad split',
            arms: [
              { label: 'A', pct: 30, steps: [] },
              { label: 'B', pct: 30, steps: [] },
            ],
          },
        ],
      },
      CHANNELS,
    );
    expect(r.issues.some((i) => /sum to 60, not 100/.test(i.problem))).toBe(true);
  });

  it('closes every open path so the app\'s submit gate passes', () => {
    const r = buildFromBlueprint(linear, CHANNELS);
    expect(r.graph.edges.every((e) => e.to !== null)).toBe(true);
    const report = validateCampaignGraph(r.graph, { fanOut: [] });
    expect(report.checks.find((c) => c.id === 'no-open-branches')?.status).toBe('pass');
  });

  it('the vocabulary handed to the model contains only real values', () => {
    const v = blueprintVocabulary(CHANNELS, 'synthetic-demo');
    for (const cat of Object.keys(EVENT_CATEGORIES)) expect(v).toContain(cat);
    for (const kind of ['send', 'wait', 'waitForEvent', 'exit', 'experiment']) expect(v).toContain(kind);
    // Template NAMES are listed so the model can reason about coverage, but
    // no ids — the model must never pick one by id.
    expect(v).toContain(COMMS_TEMPLATES[0].name);
    expect(v).not.toMatch(/CT-\d{4}/);
  });

  // --- defects found by real Claude runs, not by reasoning about the code ---

  it('turns phrase objectives into usable keywords', () => {
    // A live run returned objective: ['prompt EMI conversion', ...]. Template
    // matching is substring-based, so the phrase matched nothing and every
    // real EMI template was reported as a gap. Phrases are now split.
    const r = buildFromBlueprint(
      {
        ...linear,
        steps: [
          {
            kind: 'send',
            name: 'Nudge',
            objective: ['prompt EMI conversion', 'inform customer of eligible purchase'],
            stage: 'first-touch',
            describe: 'x',
            channelPreference: ['SMS'],
          },
        ],
      },
      CHANNELS,
    );
    expect(r.sendProposals).toEqual([]);
    expect(r.templateChoices[0].templateId).toBe('CT-3301');
  });

  it('rejects an invalid send stage instead of crashing', () => {
    // A live run sent stage "reinforcement", which indexed the stage-signal
    // table with undefined and returned a 500 for the whole request.
    const r = buildFromBlueprint(
      {
        ...linear,
        steps: [
          { kind: 'send', name: 'x', objective: ['emi'], stage: 'reinforcement' as never, describe: 'x' },
        ],
      },
      CHANNELS,
    );
    expect(r.issues.some((i) => /is not a valid stage/.test(i.problem))).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('tells the model which nodes the application inserts for it', () => {
    // A live refinement emitted exit steps meaning "they already converted",
    // not knowing the app auto-inserts Goal Check + Goal Reached. Those
    // exits consumed the open slot and dropped every later step.
    const v = blueprintVocabulary(CHANNELS, 'synthetic-demo');
    expect(v).toContain('automatically inserts a Goal Check');
    expect(v).toContain('do NOT add an exit step');
    expect(v).toContain('"first-touch" | "reminder" | "outcome"'.replace(/"/g, '').split(' | ')[0]);
  });

  it('off-topic signals are judged relative to what was asked for', () => {
    // Absolute off-topic signals disqualified every real activation template
    // for an ACTIVATION campaign. A signal only disqualifies when the caller
    // did not ask for it.
    const forActivation = scoreTemplates(
      { objective: ['activation', 'card'], stage: 'first-touch', describe: '' },
      'WHATSAPP',
    );
    expect(forActivation[0].score).toBeGreaterThan(0);
    expect(forActivation[0].offTopic).toEqual([]);

    // ...and it still disqualifies an activation template for an EMI ask.
    const forEmi = scoreTemplates({ objective: ['emi', 'convert'], stage: 'first-touch', describe: '' }, 'WHATSAPP');
    const activation = forEmi.find((r) => r.template.id === 'CT-3313')!;
    expect(activation.score).toBeLessThan(0);
    expect(activation.offTopic).toContain('card activation');
  });
});

describe('the vocabulary tells the agent what it CANNOT build', () => {
  // The trailing "node types the application supports" list named all eleven
  // types, four of which a blueprint cannot produce. Once list_step_types
  // began reporting those same types with their wiring, two sources said
  // Branch exists and nothing said it was unreachable from a blueprint.
  const v = () => blueprintVocabulary(CHANNELS, 'unavailable');

  /** Every node type buildFromBlueprint can actually construct, found by building one. */
  const constructible = () => {
    const types = new Set<string>();
    const add = (bp: CampaignBlueprint) => {
      const r = buildFromBlueprint(bp, CHANNELS);
      for (const n of Object.values(r.graph.nodes)) types.add(n.type);
    };
    const send = { kind: 'send' as const, name: 's', objective: ['emi'], stage: 'first-touch' as const, describe: 'x' };
    // One blueprint per supported step kind, so the set is derived from the
    // builder's real output rather than from a list written here.
    add({ ...linear, entry: { kind: 'audience', entity: 'Account' }, steps: [send] });
    add({
      ...linear,
      steps: [
        send,
        { kind: 'wait', durationHours: 24 },
        { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7 },
        { kind: 'exit', reason: 'done' },
      ],
    });
    add({
      ...linear,
      steps: [{ kind: 'experiment', label: 'ab', arms: [{ label: 'A', pct: 50, steps: [send] }, { label: 'B', pct: 50, steps: [send] }] }],
    });
    add({ ...linear, steps: [send, { kind: 'condition', label: 'c', outcomes: ['DELIVERED'], yes: [], no: [] }] });
    // The two the sample used to omit — which is how the vocabulary block
    // came to claim, for weeks, that neither could be built.
    add({
      ...linear,
      steps: [
        {
          kind: 'branch',
          label: 'band',
          entity: 'Account',
          attribute: 'Status',
          paths: [
            { label: 'Active', operator: 'Equals', value: 'Active', steps: [send] },
            { label: 'Rest', operator: 'Not Equals', value: 'Active', steps: [send] },
          ],
        },
      ],
    } as CampaignBlueprint);
    add({
      ...linear,
      steps: [
        { kind: 'condition', label: 'limit', on: { entity: 'Account', attribute: 'Status', operator: 'Equals', value: 'Active' }, yes: [send], no: [send] },
      ],
    } as CampaignBlueprint);
    return types;
  };

  it('does not hand the agent raw node-type names', () => {
    expect(v()).not.toMatch(/^- DECISION_SPLIT/m);
  });

  it('DOES construct a Branch and an attribute condition, so the prompt must not deny them', () => {
    // REVERSED 2026-10-22, and the old assertion is why this mattered. It read
    // "the builder genuinely never constructs one" and passed only because the
    // sample above fed no `branch` step. Meanwhile the vocabulary block told
    // the agent, every turn, that a Branch was unavailable and that a
    // condition could read nothing but a delivery outcome. Both are built —
    // DECISION_SPLIT from `kind: 'branch'`, SPLIT from `condition.on` — so the
    // agent was being talked out of the two tools it has for treating groups
    // differently, and then measured on how flat its campaigns were.
    const types = constructible();
    expect(types.has('DECISION_SPLIT')).toBe(true);
    expect(types.has('SPLIT')).toBe(true);
    const text = v();
    expect(text).not.toMatch(/more than two outcomes/i);
    expect(text).not.toMatch(/except the previous send's delivery outcome/i);
  });

  it('names every capability the builder has but the blueprint cannot reach', () => {
    const text = v();
    expect(text).toMatch(/Builder capabilities this blueprint CANNOT express/);
    for (const [what, pattern] of [
      ['mid-journey transaction history', /Transaction history and milestone checks/i],
      ['simultaneous paths', /every customer takes every path/i],
      ['parallel paths', /parallel paths/i],
      ['audience extras', /Milestone as an audience entity/i],
    ] as const) {
      expect(text, what).toMatch(pattern);
    }
  });

  it('tells the agent to raise a limitation rather than fake the capability', () => {
    const text = v();
    expect(text).toMatch(/operational-limitation/);
    expect(text).toMatch(/do not pretend you built it/i);
    expect(text).toMatch(/do not quietly design around it/i);
    // A supported alternative is offered where one exists.
    expect(text).toMatch(/Closest supported:/);
  });

  it('the claimed limitations are true of the real builder', () => {
    // Each claim checked against behaviour, not against the prose.
    const built = buildFromBlueprint(
      { ...linear, steps: [{ kind: 'send', name: 's', objective: ['emi'], stage: 'first-touch', describe: 'x' }] },
      CHANNELS,
    );
    const send = Object.values(built.graph.nodes).find((n) => n.type === 'SEND')!;
    const cfg = send._config as Record<string, unknown>;
    // Unspecified send timing keeps the builder default, not a zeroed clock.
    expect(cfg.timing).toBe('Absolute');
    expect(cfg.absTime).toBe('11:00');
    expect(cfg.fallbackChannel).toBe('');
    // Milestone is not an audience entity the blueprint accepts
    const milestone = buildFromBlueprint({ ...linear, entry: { kind: 'audience', entity: 'Milestone' } }, CHANNELS);
    expect(milestone.ok).toBe(false);
    expect(milestone.issues.some((i) => /not a real entity/.test(i.problem))).toBe(true);
  });

  it('the supported step kinds it advertises are exactly what the builder constructs', () => {
    // The "step kinds you may use" line must not promise a kind the builder
    // cannot produce, which is the failure mode this whole section exists for.
    const text = v();
    for (const kind of ['send', 'wait', 'waitForEvent', 'exit', 'experiment', 'condition']) {
      expect(text, kind).toContain(kind);
    }
    const types = constructible();
    for (const t of ['SEND', 'PAUSE', 'WAIT_UNTIL', 'EXIT', 'RANDOM_SPLIT', 'SPLIT', 'ENTRY_EVENT', 'ENTRY_SEGMENT']) {
      expect(types.has(t), t).toBe(true);
    }
  });
});

// Every step the agent designed reached the canvas, or it did not.
//
// THE LIVE FAILURE. A manager approved a two-arm message-wording experiment
// — each arm a send, a wait, a second send, a wait, a third send, an exit —
// and the canvas came back with FOUR nodes and zero message steps: the entry,
// the experiment, and two auto-inserted goal exits. Twelve designed steps,
// none of them built. The chat listed fourteen issues, twelve of which were
// the compiler reporting its own confusion back to the user.
//
// Two causes, stacked.
//
//   `addSteps` honoured its attachment point for the FIRST step only; every
//   later step asked `nextInChain`, which searches the WHOLE graph. Two arms
//   leave two open slots, so from each arm's second step the answer was always
//   "2 open slots exist; the continuation is ambiguous".
//
//   And each arm's first step was a send with no `objective`, which returned
//   before inserting anything — so even the first step of each arm was gone.
//
// This fixture is that campaign, trimmed to the shape that reproduces both.
describe('an experiment arm is a chain, not a single step', () => {
  const armStep = (name: string, objective?: string[]) => ({
    kind: 'send' as const,
    name,
    // Omitted on the opening send of each arm, exactly as the live payload had
    // it. The step must still be built.
    ...(objective ? { objective } : {}),
    stage: 'first-touch' as const,
    describe: `Tell them about ${name}.`,
    copy: `Set your PIN — ${name}.`,
  });

  const experiment: CampaignBlueprint = {
    campaignName: 'New Cardholder Virtual Card PIN Activation — Message Wording Test',
    description: 'Which framing moves activation.',
    goal: null,
    entry: { kind: 'audience', entity: 'Card', conditions: [] },
    steps: [
      {
        kind: 'experiment',
        label: 'Message wording',
        tests: 'explanation',
        arms: [
          {
            label: 'Reassurance (quick and secure framing)',
            pct: 50,
            steps: [
              armStep('reassurance opener'),
              { kind: 'wait', durationHours: 72 },
              armStep('reassurance reminder', ['activate', 'pin']),
              { kind: 'exit', reason: 'Did not reach the goal in this window' },
            ],
          },
          {
            label: 'Plain reminder (pending-step framing)',
            pct: 50,
            steps: [
              armStep('plain opener'),
              { kind: 'wait', durationHours: 72 },
              armStep('plain reminder', ['activate', 'pin']),
              { kind: 'exit', reason: 'Did not reach the goal in this window' },
            ],
          },
        ],
      },
    ],
  } as CampaignBlueprint;

  const built = () => buildFromBlueprint(experiment, CHANNELS);
  const typed = (t: string) => Object.values(built().graph.nodes).filter((n) => n.type === t);

  it('builds every send in both arms, not just the first', () => {
    // Four: an opener and a reminder on each of the two arms.
    expect(typed('SEND')).toHaveLength(4);
  });

  it('builds the waits between them', () => {
    expect(typed('PAUSE')).toHaveLength(2);
  });

  it('never reports the continuation as ambiguous', () => {
    // The compiler's own confusion, reported to a campaign manager twelve
    // times in one message.
    const ambiguous = built().issues.filter((i) => /open slots exist/.test(i.problem));
    expect(ambiguous).toEqual([]);
  });

  it('keeps a send whose objective was missing, and does not block export for it when the send is named', () => {
    // The keywords exist to search a template library. Their absence makes
    // that search worse; it does not make the message imaginary. A name is
    // enough to derive from — raising twelve empty-keyword issues on labelled
    // EMI sends blocked export (`ui-s-1792770967470`).
    const names = typed('SEND').map((n) => (n._config as { stepName?: string }).stepName ?? n.label);
    expect(names.join(' ')).toMatch(/reassurance opener/i);
    expect(built().issues.some((i) => /objective/.test(i.problem))).toBe(false);
  });

  it('reaches both arm exits', () => {
    expect(typed('EXIT').length).toBeGreaterThanOrEqual(2);
  });
});

// Spelling is absorbed. Capability gaps are not.
//
// From the same live Confirm. Two of the fourteen reported issues were:
//
//   entry.conditions: "equals" is not an operator Virtual Card Activated accepts.
//   entry.conditions: "within_days" is not an operator Created On accepts.
//
// These are not the same kind of problem, and treating them the same is how a
// build goes thin without anyone being able to say why.
//
// `equals` IS `Equals` — an API spelling of a form label. Rejecting it loses a
// condition the builder can express perfectly.
//
// `within_days` is an operator the builder does not have. The nearest match by
// string distance is `Less than`, which would turn a relative window into an
// absolute threshold and silently build a different campaign than the one
// approved. So it is dropped, named, and the gap is reported — which is the
// signal telling us what to add to the platform.
describe('operators and attributes: fold the spelling, report the gap', () => {
  const withEntry = (conditions: unknown[]): CampaignBlueprint =>
    ({
      campaignName: 'PIN activation',
      description: 'Activate new cardholders.',
      goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions },
      steps: [
        { kind: 'send', name: 'Opening', objective: ['activate'], stage: 'first-touch', describe: 'Set your PIN.' },
        { kind: 'exit', reason: 'Window closed.' },
      ],
    }) as CampaignBlueprint;

  const entryConditions = (r: ReturnType<typeof buildFromBlueprint>) => {
    const entry = Object.values(r.graph.nodes).find((n) => n.type === 'ENTRY_SEGMENT')!;
    return ((entry._config as { conditions?: { attribute?: string; operator?: string }[] }).conditions ?? []);
  };
  const sends = (r: ReturnType<typeof buildFromBlueprint>) =>
    Object.values(r.graph.nodes).filter((n) => n.type === 'SEND');

  it('accepts a lower-case operator as the operator it plainly is', () => {
    const r = buildFromBlueprint(withEntry([{ attribute: 'Status', operator: 'equals', value: 'Active' }]), CHANNELS);
    expect(entryConditions(r)[0]).toMatchObject({ attribute: 'Status', operator: 'Equals' });
    expect(r.issues.filter((i) => /operator/.test(i.problem))).toEqual([]);
  });

  it('folds separators too, since an API spells it not_equals', () => {
    const r = buildFromBlueprint(withEntry([{ attribute: 'Status', operator: 'not_equals', value: 'Blocked' }]), CHANNELS);
    expect(entryConditions(r)[0]).toMatchObject({ operator: 'Not Equals' });
  });

  it('never writes an operator the builder does not have', () => {
    const r = buildFromBlueprint(
      withEntry([
        { attribute: 'Created On', operator: 'within_days', value: '14' },
        { attribute: 'Status', operator: 'Equals', value: 'Active' },
      ]),
      CHANNELS,
    );
    const kept = entryConditions(r);
    expect(kept.map((c) => c.operator)).not.toContain('within_days');
    // NOT nearest-matched into 'Less than', which would be a different campaign.
    expect(kept.find((c) => c.attribute === 'Created On')).toBeUndefined();
    // The valid condition beside it survives.
    expect(kept.find((c) => c.attribute === 'Status')).toMatchObject({ operator: 'Equals' });
    // And so does the journey.
    expect(sends(r)).toHaveLength(1);
  });

  it('names the gap, with what the builder does accept', () => {
    const r = buildFromBlueprint(withEntry([{ attribute: 'Created On', operator: 'within_days', value: '14' }]), CHANNELS);
    const said = [...r.limitations.map((l) => l.note), ...r.issues.map((i) => i.problem)].join(' ');
    expect(said).toMatch(/within_days/);
    expect(said).toMatch(/Equals/);
    expect(said).toMatch(/Between/);
  });

  it('drops an attribute the entity does not have, and keeps the journey', () => {
    // The agent reached for "PIN Set" on Card. Card has "Virtual Card
    // Activated", which is a DIFFERENT fact — swapping it in would ship a
    // campaign nobody designed and destroy the signal that we are missing an
    // attribute.
    const r = buildFromBlueprint(
      withEntry([{ attribute: 'PIN Set', operator: 'Equals', value: 'No' }]),
      CHANNELS,
    );
    const onGraph = JSON.stringify(r.graph);
    expect(onGraph).not.toMatch(/PIN Set/);
    expect(entryConditions(r)).toHaveLength(0);
    expect(sends(r)).toHaveLength(1);
  });

  it('reports what was asked for and what exists instead', () => {
    const r = buildFromBlueprint(withEntry([{ attribute: 'PIN Set', operator: 'Equals', value: 'No' }]), CHANNELS);
    const said = [...r.limitations.map((l) => l.note), ...r.issues.map((i) => i.problem)].join(' ');
    expect(said).toMatch(/PIN Set/);
    expect(said).toMatch(/Virtual Card Activated/);
  });

  it('does not add the invented name to the app\'s own vocabulary', () => {
    // The one fix that must never be made: making the build pass by widening
    // sharedConstants. The platform gap is the finding.
    const meta = JSON.stringify(ELIGIBILITY_META);
    for (const invented of ['PIN Set', 'within_days', 'Credit Limit']) {
      expect(meta, invented).not.toContain(invented);
    }
  });
});

describe('a Send keeps the builder\'s own clock, delay and fallback', () => {
  const send = (extra: Record<string, unknown> = {}) =>
    ({
      campaignName: 'Timed',
      description: 'd',
      goal: null,
      entry: { kind: 'audience' as const, entity: 'Account' },
      steps: [
        {
          kind: 'send' as const,
          name: 'Opening',
          objective: ['activate'],
          stage: 'first-touch' as const,
          describe: 'Set PIN.',
          ...extra,
        },
      ],
    }) as CampaignBlueprint;

  const cfg = (bp: CampaignBlueprint) => {
    const node = Object.values(buildFromBlueprint(bp, CHANNELS).graph.nodes).find((n) => n.type === 'SEND')!;
    return node._config as Record<string, unknown>;
  };

  it('keeps Absolute 11:00 when the agent names no delay', () => {
    const c = cfg(send());
    expect(c.timing).toBe('Absolute');
    expect(c.absTime).toBe('11:00');
    expect(c.relativeDuration).toBe(1);
    expect(c.relativeUnit).toBe('days');
  });

  it('writes delayDays onto the Send, not as a missing capability', () => {
    const c = cfg(send({ delayDays: 3 }));
    expect(c.timing).toBe('Relative');
    expect(c.relativeDuration).toBe(3);
    expect(c.relativeUnit).toBe('days');
    expect(c.absTime).toBe('11:00');
  });

  it('accepts a clock time the builder already stores', () => {
    expect(cfg(send({ atTime: '09:30' })).absTime).toBe('09:30');
  });

  it('ignores a clock time that is not a time', () => {
    expect(cfg(send({ atTime: 'morning' })).absTime).toBe('11:00');
  });

  it('sets SMS fallback on the same Send', () => {
    const c = cfg(send({ channelPreference: ['WHATSAPP'], fallbackChannel: 'SMS' }));
    expect(c.channel).toBe('WHATSAPP');
    expect(c.fallbackChannel).toBe('SMS');
  });

  it('does not use the primary channel as its own fallback', () => {
    expect(cfg(send({ channelPreference: ['SMS'], fallbackChannel: 'SMS' })).fallbackChannel).toBe('');
  });
});
