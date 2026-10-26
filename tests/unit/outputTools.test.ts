// The model writes to the record through tools, and each call stands alone.
//
// The property that matters most here is PARTIAL CREDIT. Under the single-JSON
// contract, one malformed field invalidated the whole turn — so a correctly
// stated barrier was thrown away because an unrelated dimension was wrong, and
// the user paid for it with another round. These tests pin that a bad call
// cannot take a good one down with it.
//
// The second property is that a rejection tells the model what to do instead.
// A tool result the model cannot act on produces the same loop as a refusal
// the user cannot act on, one level down.
import { describe, it, expect } from 'vitest';
import { newBrief, briefDimensions, recordAnswer, recordSuccessCriteria, type WorkingBrief } from '../../server/discovery';
import { recordReply, recordAsked, outstanding } from '../../server/record';
import { OUTPUT_TOOLS, OUTPUT_TOOL_NAMES, isOutputTool, applyOutputTool, outputToolsForPhase } from '../../server/outputTools';
import { blocksFor } from '../../server/gate';
import { reactingPath } from './support/journeys';

const started = (): WorkingBrief =>
  recordReply(
    recordAsked(newBrief('Get new cardholders activated'), [{ text: 'What counts as activated?', impact: 'fork' }], 'agent'),
    'setting a PIN, and we count cards activated',
  );

describe('the tools are declared where they cost no prompt budget', () => {
  it('exposes every way the model writes, and nothing else', () => {
    expect(OUTPUT_TOOL_NAMES.sort()).toEqual(
      ['ask_questions', 'build_campaign', 'propose_strategy', 'record_dimensions', 'record_findings', 'request_evidence'],
    );
    expect(isOutputTool('record_findings')).toBe(true);
    // A data LOOKUP is not an output tool. The distinction matters: output
    // calls skip the lookup cache and the repeat-escalation counter, because
    // recording a finding twice is not a wasted re-read.
    expect(isOutputTool('list_event_types')).toBe(false);
  });

  it('withholds the journey grammar until something is actually being built', () => {
    // build_campaign's schema IS the blueprint vocabulary. Offering it on a
    // discovery turn hands the agent the builder's limits before it has a
    // plan, which is the leak `systemForPhase` closed and this reopened the
    // moment the grammar moved from the prompt into a tool.
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('build_campaign');
    expect(outputToolsForPhase('build').map((t) => t.name)).toContain('build_campaign');
    // The record tools travel on every phase, because writing down what you
    // learn is never phase-dependent — a build turn still finds things worth
    // recording. What moves is which single plan tool is on the call.
    const names = (p: 'asking' | 'ready' | 'build') => outputToolsForPhase(p).map((t) => t.name);
    for (const always of ['ask_questions', 'record_findings', 'record_dimensions', 'request_evidence']) {
      for (const p of ['asking', 'ready', 'build'] as const) expect(names(p), `${always} on ${p}`).toContain(always);
    }
    expect(outputToolsForPhase('asking')).toHaveLength(OUTPUT_TOOLS.length - 2);
    expect(outputToolsForPhase('ready')).toHaveLength(OUTPUT_TOOLS.length - 1);
    expect(outputToolsForPhase('build')).toHaveLength(OUTPUT_TOOLS.length - 1);
  });

  it('does not offer propose_strategy at all on an ASKING turn', () => {
    // REWRITTEN 2026-10-24. It used to travel with `blueprint` and `$defs`
    // stripped out, so the GATE rather than the tool list could decide when a
    // proposal was allowed — "a model that proposes early should be refused by
    // the record, not left unable to speak". Measured twice, that refusal was
    // not a correction but an invitation: `ui-s-1792834072700` turn 3 sent the
    // same plan five times and then put it in the chat by hand, and
    // `ui-s-1792839251135` turn 3 asked the manager to type "go ahead".
    //
    // A tool that is absent needs no refusal, and there is no schema left to
    // be missing a field.
    expect(outputToolsForPhase('asking').find((t) => t.name === 'propose_strategy')).toBeUndefined();
    const askingSchemas = JSON.stringify(outputToolsForPhase('asking').map((t) => t.input_schema));
    for (const leak of ['"branch"', '"waitForEvent"', 'first-touch', 'campaignName', '$defs']) {
      expect(askingSchemas, leak).not.toContain(leak);
    }

    // The turn that may propose gets the whole thing, path included.
    const ready = outputToolsForPhase('ready').find((t) => t.name === 'propose_strategy')!.input_schema;
    expect(ready.properties.blueprint).toBeDefined();
    expect(ready.$defs?.step).toBeDefined();
    expect(JSON.stringify(ready)).toContain('#/$defs/step');
    for (const kept of ['summary', 'approach', 'architectures', 'touches', 'openItems']) {
      expect(ready.properties[kept], kept).toBeDefined();
    }
    expect(ready.required).toContain('touches');

    // AND THE SHARED OBJECT IS NOT MUTATED. Phasing is a filter over
    // `OUTPUT_TOOLS`, so nothing can quietly remove `blueprint` from the
    // definition every later caller reads.
    expect(
      (OUTPUT_TOOLS.find((t) => t.name === 'propose_strategy')!.input_schema.properties as Record<string, unknown>)
        .blueprint,
    ).toBeDefined();
  });

  it('expresses the recursive journey grammar with $defs, which prose could not', () => {
    const build = OUTPUT_TOOLS.find((t) => t.name === 'build_campaign')!;
    expect(build.input_schema.$defs).toBeDefined();
    expect(JSON.stringify(build.input_schema)).toContain('#/$defs/step');
  });

  it('carries a real JSON schema per tool, not prose', () => {
    for (const t of OUTPUT_TOOLS) {
      expect(t.input_schema.type).toBe('object');
      expect(Object.keys(t.input_schema.properties).length).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(0);
    }
  });

  it('keeps the enums in the schema identical to the types they feed', () => {
    // Drift here is the deadlock's exact cause: a schema that no longer
    // matches the interface, with nothing checking. The compiler covers the
    // input interfaces; this covers the enum values inside the schema.
    const findings = OUTPUT_TOOLS.find((t) => t.name === 'record_findings')!;
    const barriers = (findings.input_schema.properties.barriers as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties;
    expect(barriers.basis.enum).toEqual(['user', 'user-belief', 'assumption', 'none']);
    expect(barriers.lever.enum).toEqual(['message', 'timing', 'targeting', 'not-addressable']);
    const dims = OUTPUT_TOOLS.find((t) => t.name === 'record_dimensions')!;
    const d = (dims.input_schema.properties.dimensions as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties;
    expect(d.status.enum).toEqual(['open', 'retained', 'deferred', 'unavailable']);
    expect(d.basis.enum).toEqual(['user', 'user-belief', 'assumption', 'none', 'tool']);
  });
});

describe('a barrier the manager actually stated clears the block it is supposed to clear', () => {
  it('records it and the gate stops asking what is stopping them', () => {
    // THE FIVE-TURN LOOP, end to end. The manager said this in turn 3 of a
    // real session and the gate asked three more times, because the model had
    // nowhere to put it on a propose turn.
    const brief = recordReply(started(), 'not realising they need to do bcs we are not nudging then');
    expect(blocksFor(brief).some((b) => b.code === 'no-barrier')).toBe(true);

    const out = applyOutputTool(brief, 'record_findings', {
      barriers: [
        {
          id: 'not-told',
          statement: 'They do not realise they need to set a PIN.',
          basis: 'user-belief',
          lever: 'message',
          quote: 'not realising they need to do bcs we are not nudging then',
        },
      ],
    });
    expect(out.error).toBeUndefined();
    expect(blocksFor(out.brief).some((b) => b.code === 'no-barrier')).toBe(false);
  });

  it('tells the model when a quote did not check out, instead of downgrading in silence', () => {
    // `recordBarriers` already verifies attribution and downgrades to
    // 'assumption'. It used to do so invisibly, so the model had no way to
    // learn its quote was wrong and no reason to stop inventing them.
    const out = applyOutputTool(started(), 'record_findings', {
      barriers: [
        {
          id: 'invented',
          statement: 'They think the interest is too expensive.',
          basis: 'user',
          lever: 'message',
          quote: 'the interest rate is frankly punitive and nobody explained the tenure options',
        },
      ],
    });
    expect(out.brief.barriers![0].basis).toBe('assumption');
    expect(out.ok).toMatch(/your own inference rather than theirs/);
    expect(out.ok).toMatch(/say it is untested/);
  });
});

describe('partial credit: one bad call cannot discard a good one', () => {
  it('keeps the findings when the dimensions call is malformed', () => {
    const base = started();
    const good = applyOutputTool(base, 'record_findings', {
      barriers: [{ id: 'b', statement: 'Not nudged.', basis: 'user-belief', lever: 'message', quote: 'setting a PIN' }],
    });
    const bad = applyOutputTool(good.brief, 'record_dimensions', { dimensions: [{ rationale: 'no name' }] });

    expect(bad.error).toBeDefined();
    // The barrier survived the failed call next to it.
    expect(bad.brief.barriers).toHaveLength(1);
    expect(blocksFor(bad.brief).some((b) => b.code === 'no-barrier')).toBe(false);
  });

  it('applies the usable items in a call and drops only the rest', () => {
    const out = applyOutputTool(started(), 'record_dimensions', {
      dimensions: [{ name: 'Acquisition channel', rationale: 'r', status: 'retained', basis: 'user' }, { rationale: 'nameless' }],
    });
    expect(out.error).toBeUndefined();
    expect(briefDimensions(out.brief).map((d) => d.name)).toEqual(['Acquisition channel']);
  });
});

describe('success is recordable without a plan', () => {
  // MEASURED, `eval/runs/ui-s-1792835962676`. `successCriteria` lived on
  // `propose_strategy` alone, and `briefForPrompt` told the model to "record
  // it in successCriteria on this turn" — a field the asking turn refuses.
  // The brief named something the turn could not reach, which is the
  // schema-versus-handler contradiction one layer up.
  const theirs = ['The number of eligible purchases converted.'];

  it('record_findings takes it, on its own, as a complete call', () => {
    const out = applyOutputTool(started(), 'record_findings', { successCriteria: theirs });
    expect(out.error).toBeUndefined();
    expect(out.brief.successCriteria).toEqual(theirs);
    expect(out.ok).toMatch(/how they would judge this/);
  });

  it('takes it alongside the findings, and reports all of it', () => {
    const out = applyOutputTool(started(), 'record_findings', {
      successCriteria: theirs,
      barriers: [{ id: 'b', statement: 'Not nudged.', basis: 'user-belief', lever: 'message', quote: 'setting a PIN' }],
    });
    expect(out.error).toBeUndefined();
    expect(out.brief.successCriteria).toEqual(theirs);
    expect(out.brief.barriers).toHaveLength(1);
  });

  it('accepts one bare string, because a single measure is sent as one', () => {
    const out = applyOutputTool(started(), 'record_findings', { successCriteria: 'Purchases converted.' });
    expect(out.brief.successCriteria).toEqual(['Purchases converted.']);
  });

  it('treats an empty list as silence, not retraction', () => {
    const filed = applyOutputTool(started(), 'record_findings', { successCriteria: theirs }).brief;
    const after = applyOutputTool(filed, 'record_findings', {
      successCriteria: [],
      barriers: [{ id: 'b', statement: 'Not nudged.', basis: 'user-belief', lever: 'message', quote: 'setting a PIN' }],
    });
    expect(after.brief.successCriteria).toEqual(theirs);
  });

  it('still refuses a call that carries none of the three', () => {
    expect(applyOutputTool(started(), 'record_findings', {}).error).toMatch(/recorded nothing/);
    expect(applyOutputTool(started(), 'record_findings', { successCriteria: [] }).error).toMatch(/recorded nothing/);
  });

  it('is in the schema, so the model can see the field exists', () => {
    const schema = OUTPUT_TOOLS.find((t) => t.name === 'record_findings')!.input_schema;
    expect(schema.properties.successCriteria).toBeDefined();
    // Never a target number: no performance history exists for this bank.
    expect(JSON.stringify(schema.properties.successCriteria)).toMatch(/Never a target number/);
  });
});

describe('every rejection says what to do instead', () => {
  const rejections = [
    ['ask_questions', { questions: [] }],
    ['ask_questions', {}],
    ['record_findings', {}],
    ['record_dimensions', { dimensions: [] }],
    ['no_such_tool', {}],
  ] as const;

  for (const [name, input] of rejections) {
    it(`${name} with ${JSON.stringify(input)} is actionable`, () => {
      const out = applyOutputTool(started(), name, input);
      expect(out.error, 'expected a rejection').toBeDefined();
      // An error that only states the problem leaves the model guessing, which
      // is how the dimension-note refusal looped for five turns.
      expect(out.error!.length).toBeGreaterThan(20);
      expect(out.brief).toEqual(started());
    });
  }

  it('names the field to send, not the internal reason it failed', () => {
    expect(applyOutputTool(started(), 'record_findings', {}).error).toMatch(/Send "converters", "barriers", "successCriteria"/);
    expect(applyOutputTool(started(), 'record_dimensions', { dimensions: [] }).error).toMatch(/non-empty "name"/);
  });
});

describe('asking goes through the record, so the app owns attribution', () => {
  it('records questions as agent-authored and they become outstanding', () => {
    const out = applyOutputTool(started(), 'ask_questions', {
      questions: [{ text: 'Who activates today?', impact: 'shaping' }],
    });
    expect(out.error).toBeUndefined();
    expect(outstanding(out.brief).map((q) => q.text)).toEqual(['Who activates today?']);
    expect(blocksFor(out.brief).some((b) => b.code === 'awaiting-reply')).toBe(true);
  });

  it('and the next reply closes them without the model confessing anything', () => {
    const asked = applyOutputTool(started(), 'ask_questions', {
      questions: [{ text: 'Who activates today?', impact: 'shaping' }],
    }).brief;
    const replied = recordReply(asked, 'no idea honestly');
    expect(outstanding(replied)).toHaveLength(0);
    expect(blocksFor(replied).some((b) => b.code === 'awaiting-reply')).toBe(false);
  });
});

describe('a proposal must compare two genuinely different theories of the problem', () => {
  // THE STRATEGY WEAKNESS, measured on the activation run: both candidates
  // segmented or branched differently while sharing one theory of the problem
  // ("they are not being nudged"). Two mechanics for one barrier is one
  // architecture described twice, and the whole double-down-versus-expand
  // comparison collapses into routing trivia.
  // AND A PATH, since 2026-10-23. `propose_strategy` refuses a plan with no
  // journey: they are approving a sequence, so it has to exist before they
  // agree, and Confirm compiles this same one rather than designing a second.
  const plan = (architectures: unknown[]) => ({
    summary: 'Nudge new cardholders to set a PIN.',
    approach: ['Enter at issuance.'],
    assumptions: [],
    unknowns: [],
    architectures,
    blueprint: reactingPath({}, 'awareness'),
  });

  /**
   * A brief with real barriers recorded, because an architecture now cites a
   * barrier by ID. Free text was defeatable by appending words, and a live run
   * defeated it three times out of three.
   */
  // A RECORD THE GATE CALLS READY, since 2026-10-24. These cases are about
  // the ARCHITECTURE rules, and the tool now refuses a proposal differently
  // when discovery is not finished — so without converters, success and three
  // reasoned dimensions, the accepting cases got the asking-turn refusal and
  // stopped testing architectures at all.
  const withBarriers = (ids: string[]) => {
    const withFindings = applyOutputTool(started(), 'record_findings', {
      converters: { shape: 'Cards issued with a welcome offer activate sooner.', basis: 'user', knowledge: 'known' },
      barriers: ids.map((id) => ({
        id,
        statement: `Problem ${id}.`,
        basis: 'user-belief',
        lever: 'message',
        quote: 'setting a PIN, and we count cards activated',
      })),
    }).brief;
    const withDims = applyOutputTool(withFindings, 'record_dimensions', {
      dimensions: [
        { name: 'welcome offer at sign-up', rationale: 'They said those activate sooner.', status: 'retained', basis: 'user', note: 'Theirs.' },
        { name: 'acquisition channel', rationale: 'Asked about.', status: 'unavailable', basis: 'user', note: 'They do not track it.' },
        { name: 'existing relationship', rationale: 'Asked about.', status: 'unavailable', basis: 'user', note: 'They do not track it.' },
      ],
    }).brief;
    return recordSuccessCriteria(withDims, ['Count of cards activated in the first two weeks.']);
  };

  it('rejects two candidates that share a barrier AND a treatment', () => {
    // Identical on every axis a customer would experience, so they are one
    // architecture described twice whatever they are called.
    const out = applyOutputTool(withBarriers(['awareness', 'friction']), 'propose_strategy', plan([
      { name: 'Segmented reminders', barrier: 'awareness', entry: 'At issuance', timing: 'Day 0, 3, 7', lever: 'message', journey: 'reminder' },
      { name: 'Escalating reminders', barrier: 'awareness', entry: 'At issuance', timing: 'Day 0, 3, 7', lever: 'message', journey: 'reminder' },
    ]));
    expect(out.error).toMatch(/one architecture described twice/);
    expect(out.strategy).toBeUndefined();
  });

  it('ACCEPTS two candidates on one barrier when the treatment differs', () => {
    // REVERSED 2026-10-23, and this is the defect it was encoding.
    //
    // One recorded barrier is the ordinary case when the manager answers
    // clearly. Refusing the plan for it told the agent to "record a second
    // candidate explanation" with basis "assumption" — the application asking
    // the agent to invent a customer problem, which every other rule here
    // exists to prevent. Measured in
    // eval/runs/ui-s-1792735473522/turns/turn-3.json: it obeyed, the invented
    // rival then replaced the manager's own barrier, and the turn ended with
    // "Recorded." on screen.
    //
    // A rival to one problem is a different TREATMENT of it.
    const out = applyOutputTool(withBarriers(['awareness']), 'propose_strategy', plan([
      { name: 'Catch them at checkout', barrier: 'awareness', entry: 'On authorisation', timing: 'Within 30 minutes', lever: 'timing', journey: 'single-touch', chosen: true },
      { name: 'Work it over the window', barrier: 'awareness', entry: 'On authorisation', timing: 'Day 1, 3, 6', lever: 'message', journey: 'reminder' },
    ]));
    expect(out.error).toBeUndefined();
    expect(out.strategy).toBeTruthy();
  });

  it('cannot be defeated by appending words to the barrier, which is how it failed live', () => {
    // The exact strings from the run: chosen cited "no-nudge-awareness", the
    // rival cited the same thing plus a qualifier. Two distinct strings, one
    // customer problem. An id is a closed set, so this is now unrepresentable.
    const out = applyOutputTool(withBarriers(['no-nudge-awareness']), 'propose_strategy', plan([
      { name: 'Universal nudge', barrier: 'no-nudge-awareness' },
      { name: 'Channel-aware timing', barrier: 'no-nudge-awareness, compounded by delivery timing for courier-issued cards' },
    ]));
    expect(out.error).toMatch(/Cite the barrier by its recorded id/);
    expect(out.strategy).toBeUndefined();
  });

  it('says to vary the treatment, never to invent a second why', () => {
    // The refusal that remains when one barrier is recorded and the two
    // candidates really are identical. What it must NOT say any more is
    // "record a second candidate explanation".
    const out = applyOutputTool(withBarriers(['awareness']), 'propose_strategy', plan([
      { name: 'A', barrier: 'awareness', entry: 'At issuance', timing: 'Day 0', lever: 'message', journey: 'reminder' },
      { name: 'B', barrier: 'awareness', entry: 'At issuance', timing: 'Day 0', lever: 'message', journey: 'reminder' },
    ]));
    expect(out.error).toMatch(/make the rival a different TREATMENT of it/);
    expect(out.error).toMatch(/Do not invent a second reason customers do not convert/);
    expect(out.error).not.toMatch(/Record a second candidate explanation/);
  });

  it('refuses a barrier that is not in the record at all', () => {
    const out = applyOutputTool(withBarriers(['awareness']), 'propose_strategy', plan([
      { name: 'A', barrier: 'awareness' },
      { name: 'B', barrier: 'invented-on-the-spot' },
    ]));
    expect(out.error).toMatch(/record a new barrier first with record_findings/);
  });

  it('accepts two candidates citing different recorded barriers', () => {
    const out = applyOutputTool(withBarriers(['awareness', 'friction']), 'propose_strategy', plan([
      { name: 'Awareness reminders', barrier: 'awareness', chosen: true, why: 'their stated cause' },
      { name: 'Friction removal', barrier: 'friction' },
    ]));
    expect(out.error).toBeUndefined();
    expect(out.strategy!.architectures).toHaveLength(2);
  });

  it('asks for a second candidate rather than accepting one', () => {
    const out = applyOutputTool(started(), 'propose_strategy', plan([{ name: 'Only one', barrier: 'awareness' }]));
    expect(out.error).toMatch(/at least two candidate architectures/);
    // And says where to look, rather than only that it is wrong.
    expect(out.error).toMatch(/the factor the first one cannot carry/);
  });

  it('needs a summary in the manager\'s terms', () => {
    expect(applyOutputTool(started(), 'propose_strategy', { approach: [] }).error).toMatch(/needs a "summary"/);
  });

  it('coerces rejected from a sentence so the renderer is not handed a string', () => {
    const out = applyOutputTool(withBarriers(['awareness']), 'propose_strategy', {
      ...plan([
        { name: 'Catch them at checkout', barrier: 'awareness', entry: 'On authorisation', timing: 'Within 30 minutes', lever: 'timing', journey: 'single-touch', chosen: true },
        { name: 'Work the window', barrier: 'awareness', entry: 'On authorisation', timing: 'Day 1, 3, 6', lever: 'message', journey: 'reminder' },
      ]),
      rejected: 'A daily digest would miss the moment of purchase.',
    });
    expect(out.error).toBeUndefined();
    expect(out.strategy?.rejected).toEqual([
      { option: 'A daily digest would miss the moment of purchase.', why: '' },
    ]);
  });
});

describe('building is separate from proposing', () => {
  const journey = {
    campaignName: 'PIN activation',
    description: 'Four reminders over two weeks.',
    entry: { kind: 'audience', entity: 'Card' },
    steps: [{ kind: 'send', name: 'Day 0', stage: 'first-touch', describe: 'Nudge', barrier: 'not-told' }],
  };

  it('returns the blueprint for the application to compile', () => {
    const out = applyOutputTool(started(), 'build_campaign', journey);
    expect(out.error).toBeUndefined();
    expect(out.blueprint!.campaignName).toBe('PIN activation');
    expect(out.ok).toMatch(/1 step/);
  });

  it('refuses an empty journey by inviting the honest alternative', () => {
    // "Do not quietly build a lesser version" was prompt-only before this.
    const out = applyOutputTool(started(), 'build_campaign', { ...journey, steps: [] });
    expect(out.error).toMatch(/say in text what is stopping you building this/);
  });

  it('names each missing piece specifically', () => {
    expect(applyOutputTool(started(), 'build_campaign', { ...journey, campaignName: '' }).error).toMatch(/"campaignName"/);
    expect(applyOutputTool(started(), 'build_campaign', { ...journey, entry: undefined }).error).toMatch(/"entry"/);
  });
});

// The tool boundary has to survive a shape the schema did not get.
//
// THE LIVE FAILURE. An OS-to-EMI turn died with "(barriers ?? []).some is not
// a function" after the manager mapped click to page-open/button-click. The
// model sent `barriers` as a STRING. `?? []` only replaces null and
// undefined, so the string survived: `.length` worked, `.some` did not, and
// the TypeError escaped as the assistant's message. No canvas.
//
// Second time in one day. The Confirm crash was `describe.replace` on a field
// the schema does not require; this is `.some` on a field whose schema says
// array. A declared type is a statement about what callers should pass. Data
// arriving from a model is not a caller.
//
// `record_dimensions`, three cases below in the same function, already used
// `Array.isArray`. The difference was invisible until a model chose the other
// shape.
describe('record_findings survives a wrong shape', () => {
  const brief = () => newBrief('Convert outstanding balances to EMI.');
  const barrier = {
    id: 'cost-perception',
    statement: 'Customers believe converting to EMI is expensive.',
    basis: 'user-belief' as const,
    lever: 'message' as const,
    quote: 'they think the interest is too expensive',
  };

  it('does not throw when barriers is a string', () => {
    const out = applyOutputTool(brief(), 'record_findings', { barriers: 'unknown-stall-point' });
    expect(out.error).toBeTruthy();
    expect(out.error).toMatch(/must be a list of objects/);
    expect(out.brief.barriers ?? []).toHaveLength(0);
  });

  it('never iterates a string into one barrier per character', () => {
    // The outcome worse than the crash: it would have been RECORDED.
    const out = applyOutputTool(brief(), 'record_findings', { barriers: 'cost' });
    const ids = (out.brief.barriers ?? []).map((b) => b.id);
    expect(ids).not.toContain('c');
    expect(out.brief.barriers ?? []).toHaveLength(0);
  });

  it('accepts a single object where a list was meant', () => {
    // A near-miss worth accepting: the model found one barrier and sent it,
    // rather than a list containing it.
    const answered = recordAnswer(brief(), 'they think the interest is too expensive');
    const out = applyOutputTool(answered, 'record_findings', { barriers: barrier });
    expect(out.error).toBeUndefined();
    expect(out.brief.barriers ?? []).toHaveLength(1);
    expect((out.brief.barriers ?? [])[0].id).toBe('cost-perception');
  });

  it('is unchanged for the shape the schema asks for', () => {
    const answered = recordAnswer(brief(), 'they think the interest is too expensive');
    const out = applyOutputTool(answered, 'record_findings', { barriers: [barrier] });
    expect(out.error).toBeUndefined();
    expect(out.brief.barriers ?? []).toHaveLength(1);
  });

  it('does not throw when converters is a string', () => {
    // `recordConverters` reads `.shape.trim()`, so this is the same hole one
    // field over.
    const out = applyOutputTool(brief(), 'record_findings', { converters: 'big spenders' });
    expect(out.error).toMatch(/must be an object/);
    expect(out.brief.converters ?? null).toBeNull();
  });

  it('does not throw when converters.candidates is a string', () => {
    // And the same hole one level DOWN: `(c.candidates ?? []).filter(...)`.
    const out = applyOutputTool(brief(), 'record_findings', {
      converters: { shape: 'nobody knows yet', basis: 'user', knowledge: 'none-yet', candidates: 'high spenders' },
    });
    expect(out.error).toBeUndefined();
    expect(out.brief.converters?.candidates ?? []).toHaveLength(0);
  });

  it('still reports an empty call as empty, not as malformed', () => {
    // The two are different problems and the model can only fix the right
    // one if it is told which.
    const out = applyOutputTool(brief(), 'record_findings', {});
    expect(out.error).toMatch(/recorded nothing/);
  });

  it('keeps the brief untouched on every malformed call', () => {
    // The turn continues. A tool error is a sentence the model can act on;
    // a throw is the end of the conversation.
    const before = recordAnswer(brief(), 'they think the interest is too expensive');
    for (const input of [{ barriers: 'x' }, { converters: 'y' }, {}]) {
      const out = applyOutputTool(before, 'record_findings', input);
      expect(out.brief).toBe(before);
    }
  });
});

// The hole was in four places, not one.
//
// `barriers` crashed live. `contextChecked`, `questionResolutions` and
// `architectures` had the identical `?? []`-on-model-data shape in the same
// function, each one line from a `.map` or an iteration. `record_dimensions`
// and `ask_questions` already used `Array.isArray` — so the function had both
// habits side by side, and which one a field got was down to who wrote it.
//
// Beyond the brief for the barriers fix, deliberately: the stated goal is
// that the tool BOUNDARY survives a wrong shape, and a boundary with three
// known holes left in it does not.
describe('every list at the tool boundary is coerced, not cast', () => {
  const brief = () => newBrief('Convert outstanding balances to EMI.');

  it('does not throw when contextChecked is a string', () => {
    const out = applyOutputTool(brief(), 'record_dimensions', {
      dimensions: [{ name: 'Balance size', rationale: 'r', status: 'open', basis: 'none' }],
      contextChecked: 'the knowledge base',
    });
    expect(out.error).toBeUndefined();
    expect(out.ok).toBeTruthy();
  });

  it('does not throw when questionResolutions is a single object', () => {
    const out = applyOutputTool(brief(), 'record_dimensions', {
      dimensions: [{ name: 'Balance size', rationale: 'r', status: 'open', basis: 'none' }],
      questionResolutions: { questionId: 'q1-0', kind: 'deferred', why: 'A default applies.' },
    });
    expect(out.error).toBeUndefined();
  });

  it('does not throw when architectures is a string', () => {
    // `.map` over a string would throw exactly as `.some` did.
    const out = applyOutputTool(brief(), 'propose_strategy', {
      summary: 'A plan.',
      approach: [],
      assumptions: [],
      unknowns: [],
      touches: [{ day: 0 }, { day: 3 }],
      architectures: 'double down versus expand',
    });
    // Refused for having fewer than two candidates — which is the right
    // refusal, and a refusal rather than a crash is the point.
    expect(out.error).toMatch(/two candidate architectures/);
  });
});
