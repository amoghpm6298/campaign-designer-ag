// The model/code boundary: a blueprint is business intent, and everything
// structural is built by the application's own reducer. These tests cover the
// deterministic half — no LLM involved — because that is the half that must
// never let an invented node type, event or template reach the campaign.
import { describe, it, expect } from 'vitest';
import { buildFromBlueprint, blueprintVocabulary, type CampaignBlueprint } from '../../server/blueprint';
import { scoreTemplates } from '../../agent-proto/templateSelect';
import { validateCampaignGraph } from '../../agent-proto/validate';
import { EVENT_CATEGORIES, COMMS_TEMPLATES, type Channel } from '../../src/data/sharedConstants';

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
    expect(v).toContain('send, wait, waitForEvent, exit, experiment');
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
    return types;
  };

  it('no longer presents Branch as something the blueprint can produce', () => {
    expect(v()).not.toMatch(/^- DECISION_SPLIT/m);
    // And the builder genuinely never constructs one.
    expect(constructible().has('DECISION_SPLIT')).toBe(false);
  });

  it('names every capability the builder has but the blueprint cannot reach', () => {
    const text = v();
    expect(text).toMatch(/Builder capabilities this blueprint CANNOT express/);
    for (const [what, pattern] of [
      ['N-way branch', /more than two outcomes/i],
      ['condition sources', /except the previous send's delivery outcome/i],
      ['per-send timing', /per-message delay/i],
      ['fallback channel', /fallback channel/i],
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
    // per-message delay: always relative, always zero
    expect(cfg.timing).toBe('Relative');
    expect(cfg.relativeDuration).toBe(0);
    // fallback channel: never set
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
