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
import { newBrief, briefDimensions, type WorkingBrief } from '../../server/discovery';
import { recordReply, recordAsked, outstanding } from '../../server/record';
import { OUTPUT_TOOLS, OUTPUT_TOOL_NAMES, isOutputTool, applyOutputTool } from '../../server/outputTools';
import { blocksFor } from '../../server/gate';

const started = (): WorkingBrief =>
  recordReply(
    recordAsked(newBrief('Get new cardholders activated'), [{ text: 'What counts as activated?', impact: 'fork' }], 'agent'),
    'setting a PIN, and we count cards activated',
  );

describe('the tools are declared where they cost no prompt budget', () => {
  it('exposes every way the model writes, and nothing else', () => {
    expect(OUTPUT_TOOL_NAMES.sort()).toEqual(
      ['ask_questions', 'build_campaign', 'propose_strategy', 'record_dimensions', 'record_findings'],
    );
    expect(isOutputTool('record_findings')).toBe(true);
    // A data LOOKUP is not an output tool. The distinction matters: output
    // calls skip the lookup cache and the repeat-escalation counter, because
    // recording a finding twice is not a wasted re-read.
    expect(isOutputTool('list_event_types')).toBe(false);
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
    expect(applyOutputTool(started(), 'record_findings', {}).error).toMatch(/Send "converters", "barriers", or both/);
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
  const plan = (architectures: unknown[]) => ({
    summary: 'Nudge new cardholders to set a PIN.',
    approach: ['Enter at issuance.'],
    assumptions: [],
    unknowns: [],
    architectures,
  });

  /**
   * A brief with real barriers recorded, because an architecture now cites a
   * barrier by ID. Free text was defeatable by appending words, and a live run
   * defeated it three times out of three.
   */
  const withBarriers = (ids: string[]) =>
    applyOutputTool(started(), 'record_findings', {
      barriers: ids.map((id) => ({
        id,
        statement: `Problem ${id}.`,
        basis: 'user-belief',
        lever: 'message',
        quote: 'setting a PIN, and we count cards activated',
      })),
    }).brief;

  it('rejects two candidates citing the same recorded barrier', () => {
    const out = applyOutputTool(withBarriers(['awareness', 'friction']), 'propose_strategy', plan([
      { name: 'Segmented reminders', barrier: 'awareness' },
      { name: 'Escalating reminders', barrier: 'awareness' },
    ]));
    expect(out.error).toMatch(/one architecture described twice/);
    expect(out.strategy).toBeUndefined();
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

  it('says what to do when only one theory of the problem exists', () => {
    // The deeper finding: with one barrier recorded there IS only one theory,
    // and the campaign cannot learn which explanation is right.
    const out = applyOutputTool(withBarriers(['awareness']), 'propose_strategy', plan([
      { name: 'A', barrier: 'awareness' },
      { name: 'B', barrier: 'awareness' },
    ]));
    expect(out.error).toMatch(/only one theory of the problem/);
    expect(out.error).toMatch(/Record a second candidate explanation/);
    expect(out.error).toMatch(/"assumption" is an honest basis/);
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
