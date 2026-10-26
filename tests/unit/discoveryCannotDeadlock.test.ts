// Discovery must always be able to end.
//
// THE MEASURED FAILURE, from a live session on new-cardholder activation. The
// agent asked the same question three turns running, verbatim, while the
// campaign manager answered it every time and eventually wrote "im tired man".
// Three independent defects stacked, and each one alone was enough:
//
// 1. `converters` and `barriers` existed only in the ASK payload. The prompt
//    said "You cannot propose without both" and the gate enforced exactly
//    that, so on a propose turn the model had nowhere to declare the barrier
//    it had just been given. The gate then refused with "I do not yet know
//    what is stopping them" and re-asked. Guaranteed, not probabilistic.
//
// 2. `unresolvedDimensions` holds a proposal while a dimension sits on
//    `basis: 'assumption'` with no `note`. Nothing in the brief said a note
//    was what the application wanted, so the model did the only other thing
//    the refusal suggested — asked another question — and the refusal
//    regenerated identically.
//
// 3. `evaluateDiscovery` escapes at the round limit, but four vetoes computed
//    in the orchestrator were ORed with its outcome and none of them read the
//    limit. The escape hatch existed and was overridden.
//
// Each test below fails if its defect returns.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OUTPUT_TOOLS, outputToolsForPhase } from '../../server/outputTools';

const schemaOf = (name: string) =>
  JSON.stringify(OUTPUT_TOOLS.find((t) => t.name === name)!.input_schema);
import {
  newBrief,
  isPlatformDimension,
  recordQuestions,
  recordAnswer,
  recordDimensions as record,
  briefDimensions,
  briefForPrompt,
  unresolvedDimensions,
  type WorkingBrief,
} from '../../server/discovery';
import { blocksFor, satisfy } from '../../server/gate';
import { recordAsked, recordReply } from '../../server/record';

const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
const SYSTEM = /const SYSTEM = `([\s\S]*?)`;\n/.exec(orch)![1];

describe('1 — the findings have a slot in every payload that can be refused for lacking them', () => {
  it('gives the findings ONE slot, reachable on every turn', () => {
    // The original defect was two hand-maintained copies of the payload with
    // the findings in only one of them. The fix is not a third copy — it is
    // that there is now a single tool carrying both, available on every turn
    // including a propose turn, so the gate can never demand a field the model
    // has nowhere to put.
    const findings = OUTPUT_TOOLS.find((t) => t.name === 'record_findings')!;
    expect(Object.keys(findings.input_schema.properties)).toEqual(
      expect.arrayContaining(['converters', 'barriers']),
    );
    for (const turn of [true, false]) {
      expect(outputToolsForPhase(turn ? 'build' : 'asking').map((t) => t.name)).toContain('record_findings');
    }
  });

  it('keeps the instruction that makes them mandatory, so the two cannot drift apart', () => {
    // If this sentence is ever softened, the schema slots above become
    // optional and this whole file is testing nothing.
    expect(SYSTEM).toMatch(/send "converters" and "barriers" on EVERY turn/);
    expect(SYSTEM).toMatch(/You cannot propose without both/);
  });
});

describe('2 — a refusal names the one thing that clears it', () => {
  const stuckBrief = (): WorkingBrief => {
    let b = recordQuestions(newBrief('Get new cardholders activated'), [
      { text: 'Where in the two weeks do they drop off?', impact: 'detail' },
    ]);
    b = recordAnswer(b, 'not sure');
    // Exactly what the model sent in the real session: its own assumption,
    // with a rationale but no note.
    return record(b, [
      {
        name: 'Point in the two-week window where engagement drops',
        rationale: 'If drop-off is early or late, that changes when reminders are sent.',
        status: 'deferred',
        basis: 'assumption',
      },
    ]);
  };

  it('is genuinely held by the record, so this fixture reproduces the deadlock', () => {
    expect(unresolvedDimensions(stuckBrief()).map((d) => d.name)).toEqual([
      'Point in the two-week window where engagement drops',
    ]);
  });

  it('tells the model a note releases it, and that asking again does not', () => {
    const out = briefForPrompt(stuckBrief());
    expect(out).toContain('THESE ARE HOLDING UP YOUR PROPOSAL');
    expect(out).toContain('"Point in the two-week window where engagement drops"');
    expect(out).toMatch(/Send it again in "dimensions" with a "note"/);
    expect(out).toMatch(/A note is what releases it\. Asking another question does not\./);
  });

  it('accepts "the user does not know" as a complete reason', () => {
    // The real answer was "not sure". If that cannot close a dimension, the
    // loop is unavoidable whatever the wording says.
    expect(briefForPrompt(stuckBrief())).toMatch(/the user does not know, so I am assuming X/);
    const closed = record(stuckBrief(), [
      {
        name: 'Point in the two-week window where engagement drops',
        status: 'deferred',
        basis: 'assumption',
        note: 'The user does not know, so reminders are spread evenly.',
      },
    ]);
    expect(unresolvedDimensions(closed)).toHaveLength(0);
  });

  it('says nothing when no dimension is holding anything up', () => {
    // A standing instruction that fires every turn is noise the model learns
    // to skip, which is the same lesson the belief block already records.
    const fine = record(newBrief('o'), [
      { name: 'Activation definition', status: 'retained', basis: 'user', note: 'PIN set.' },
    ]);
    expect(briefForPrompt(fine)).not.toContain('THESE ARE HOLDING UP YOUR PROPOSAL');
  });
});

describe('3 — the budget is an escape hatch that nothing can override', () => {
  it('makes all four orchestrator vetoes yield when the budget is spent', () => {
    // These four are ORed with the gate's outcome. The gate already returns
    // `ready_for_strategy` at the limit, so any one of them ignoring the limit
    // reopens an unbounded refusal.
    // The four vetoes are DELETED, which is a stronger fix than making them
    // yield: there is one decider, it checks the budget first, and nothing is
    // ORed with its outcome any more.
    for (const gone of ['beliefUntreated', 'forkUnanswered', 'dimensionUnresolved', 'questionDropped']) {
      expect(orch, gone).not.toContain(`const ${gone} =`);
    }
    expect(orch).toMatch(/if \(!decision\.proceed && !approvedPlan\) \{/);
    expect(orch).toMatch(/const decision = decide\(brief, \{/);
  });

  it('defines the budget from the round limit or an explicit request to proceed', () => {
    // Now also set by the user TYPING it. `forceProposal` was only ever set
    // by a button click, and nobody types "go ahead" into a chat box
    // expecting to have to find a button.
    expect(orch).toMatch(/req\.discoveryRounds >= MAX_DISCOVERY_ROUNDS \|\| Boolean\(req\.forceProposal\) \|\| saysProceed\(latestUserText\)/);
  });

  it('records why, so this is not later read as a loosened guard', () => {
    expect(orch).toMatch(/THE FOUR VETOES ARE GONE/);
    const gateSrc3 = readFileSync(new URL('../../server/gate.ts', import.meta.url), 'utf8');
    expect(gateSrc3).toMatch(/THE BUDGET IS CHECKED FIRST AND NOTHING OVERRIDES IT/);
  });
});

describe('4 — a dropped dimension is explained, not silently discarded', () => {
  // THE LOOP THIS CLOSES, reproduced before it was fixed:
  //   raised 3, stored 0
  //   gate: "I have only weighed 0 angles so far"
  //   gate tells it to: "Raise at least 3 lines of enquiry."
  //   brief mentions the drop: false
  //   agent does exactly as told, with the same three -> still 0, still blocked
  //
  // `recordDimensions` refuses to store a dimension that names a platform
  // setting, which is right. Refusing SILENTLY is what made it unescapable.
  const platformNames = [
    { name: 'Entry event for activation', rationale: 'r', status: 'retained' as const, basis: 'user' as const },
    { name: 'Which channels are available', rationale: 'r', status: 'retained' as const, basis: 'user' as const },
    { name: 'Quiet hours window', rationale: 'r', status: 'retained' as const, basis: 'user' as const },
  ];
  const customerNames = [
    { name: 'Assigned credit limit', rationale: 'r', status: 'retained' as const, basis: 'user' as const },
    { name: 'Already started the request', rationale: 'r', status: 'retained' as const, basis: 'user' as const },
    { name: 'App on the phone', rationale: 'r', status: 'retained' as const, basis: 'user' as const },
  ];
  const started = () =>
    recordReply(recordAsked(newBrief('Get cardholders activated'), [{ text: 'q' }], 'agent'), 'PIN set');

  it('stores none of the three platform names', () => {
    const b = record(started(), platformNames);
    expect(briefDimensions(b)).toHaveLength(0);
    for (const d of platformNames) expect(isPlatformDimension(d.name)).toBe(true);
  });

  it('tells the model exactly what was dropped and what to raise instead', () => {
    const out = briefForPrompt(record(started(), platformNames));
    expect(out).toMatch(
      /These were not stored as lines of enquiry because they describe the platform, not the customer:/,
    );
    for (const d of platformNames) expect(out).toContain(d.name);
    expect(out).toMatch(/Raise three things about the customers/);
    expect(out).toMatch(/Do not raise entry events, channel lists, templates, quiet hours, or DND\./);
  });

  it('says nothing when nothing was dropped', () => {
    // A standing message that fires every turn is noise the model learns to
    // skip, which is the lesson the belief block already records.
    expect(briefForPrompt(record(started(), customerNames))).not.toMatch(/not stored as lines of enquiry/);
  });

  it('stops saying it once enough real dimensions exist', () => {
    const b = record(record(started(), platformNames), customerNames);
    expect(briefDimensions(b)).toHaveLength(3);
    expect(briefForPrompt(b)).not.toMatch(/not stored as lines of enquiry/);
  });

  it('clears the gate once the model raises customer factors instead', () => {
    const stuck = record(started(), platformNames);
    expect(blocksFor(stuck).some((x) => x.code === 'too-few-dimensions')).toBe(true);
    const fixed = record(stuck, customerNames);
    expect(blocksFor(fixed).some((x) => x.code === 'too-few-dimensions')).toBe(false);
  });

  it('satisfy() uses names an agent could really emit, not "Angle 1"', () => {
    // The invariant has to prove the path an agent can walk. `satisfy` used to
    // generate "Angle 1", which clears the block in a test and could never be
    // produced by a model — and would survive the platform filter for the
    // wrong reason.
    const stuck = record(started(), platformNames);
    const block = blocksFor(stuck).find((x) => x.code === 'too-few-dimensions')!;
    const after = satisfy(stuck, block.clears);
    expect(briefDimensions(after).map((d) => d.name)).not.toContain('Angle 1');
    expect(briefDimensions(after)).toHaveLength(3);
    for (const d of briefDimensions(after)) expect(isPlatformDimension(d.name)).toBe(false);
    expect(blocksFor(after).some((x) => x.code === 'too-few-dimensions')).toBe(false);
  });
});
