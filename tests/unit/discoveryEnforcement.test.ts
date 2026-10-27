// C2 + C1: discovery-first is enforced by the application, not just asked for
// in the prompt.
//
// THE DEFECT, measured twice live. `evaluateDiscovery` had only an UPPER
// bound: `forced || rounds >= maxRounds` pushed TOWARDS a proposal, and
// nothing ever asked whether discovery had happened. A model that opened with
// action:"propose" was taken at its word. Both measured conversations (EMI and
// OS-to-EMI) produced exactly one question, both about trigger configuration,
// neither about who the customers were — and the application had no way to
// notice, because the brief held flat lists with nothing recording which
// aspects of the design had been examined.
//
// The prompt was also actively instructing that behaviour: asking was gated
// behind "Only when you genuinely cannot propose anything responsible" while
// proposing was "Normally". C1 reverses the framing; C2 makes it a property of
// the application so it is verifiable without a model call.
//
// Deterministic throughout: the model's side is supplied as fixtures.
import { describe, it, expect } from 'vitest';
import { settleFindings, alternativesRuledOut } from './support/findings';
import { readFileSync } from 'node:fs';
import { blocksFor } from '../../server/gate';
import {
  evaluateDiscovery,
  newBrief,
  recordDimensions,
  recordAnswer,
  recordSuccessCriteria,
  droppedWithoutReason,
  userHasRespondedOnce,
  outstandingDimensions,
  briefDimensions,
  type DimensionUpdate,
  type OpenItem,
  type WorkingBrief,
} from '../../server/discovery';
import { OUTPUT_TOOLS, outputToolsForPhase } from '../../server/outputTools';
import { asking } from './support/prompts.ts';
// PINS REMOVED, NOT LOST: 3 rule(s) this file asserted have no
// counterpart in any of the three manuals. Every one is listed in
// `server/promptHomeless.md` under this filename, with the tests that
// went with them. Do not re-add a pin here without putting the rule
// back in a manual first.

const OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

const AMBIGUITY: OpenItem = {
  kind: 'strategic-ambiguity',
  question: 'Should entry fire on a pending request or on the eligible balance',
  whyItMatters: 'It decides who enters.',
};

const dims = (...updates: DimensionUpdate[]) => recordDimensions(newBrief(OBJECTIVE), updates);

/**
 * The user has taken part. Needed on every case that expects a strategy
 * through, because the gate now requires it: the agent closed all five
 * dimensions inside its own first turn in a live run, so a complete record it
 * wrote for itself is not evidence that discovery happened.
 */
const answered = (b: WorkingBrief): WorkingBrief =>
  recordSuccessCriteria(recordAnswer(settleFindings(b), 'Target customers with an open request.'), [
    'Completed OS-to-EMI conversions among customers who entered.',
  ]);

/** A propose turn. `over` replaces whatever the case needs. */
const gate = (over: Record<string, unknown> = {}) =>
  evaluateDiscovery({
    brief: newBrief(OBJECTIVE),
    modelAction: 'propose',
    modelQuestions: [],
    modelEvidence: [],
    openItems: [],
    forced: false,
    maxRounds: 8,
    ...over,
  });

describe('a premature proposal is refused', () => {
  it('the dimension ledger is no longer a gate of its own', () => {
    // RETARGETED 2026-10-26. This asserted `continue_discovery` on a brief
    // with the three findings and an EMPTY dimension list, because
    // `discoveryIsComplete` wanted three rows. That count is gone: the
    // findings are what a campaign needs, and the second-pattern search only
    // exists once they have named a pattern.
    const b = answered(newBrief(OBJECTIVE));
    expect(briefDimensions(b)).toEqual([]);
    expect(gate({ brief: b }).outcome).toBe('ready_for_strategy');
    expect(blocksFor(b).map((x) => x.code)).toEqual([]);
  });

  it('still refuses a row raised on nothing and left unexplained', () => {
    // The surviving half of the old rule, and the honest one: a line of
    // enquiry with no basis and no note is a decision nobody made. The COUNT
    // is gone; this is not.
    const unreasoned = answered(dims(
      { name: 'Statement timing', status: 'retained', basis: 'user' },
      { name: 'Outstanding statement amount', status: 'open', basis: 'none' },
    ));
    expect(blocksFor(unreasoned).map((x) => x.code)).toContain('dimension-unreasoned');
    const d = gate({
      brief: answered(dims(
        { name: 'Statement timing', status: 'retained', basis: 'user' },
        { name: 'Outstanding statement amount', status: 'open', basis: 'none' },
      )),
    });
    // `evaluateDiscovery` no longer rules on this — the record does, through
    // `blocksFor` above — so the outcome here is the proposal's, and the hold
    // comes from the block.
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('refuses discovery BEFORE offering a strategy with questions', () => {
    // Ordering matters: an unfinished investigation is not a recommendation
    // with a caveat attached, so 'continue_discovery' must win.
    const d = gate({
      brief: dims({ name: 'Conversion barriers', status: 'open', basis: 'none' }),
      openItems: [AMBIGUITY],
    });
    expect(d.outcome).toBe('continue_discovery');
    expect(d.outcome).not.toBe('strategy_with_questions');
  });

  it('still carries the model\'s own questions, and never invents one', () => {
    const withItem = gate({ brief: dims({ name: 'X', status: 'open' }), openItems: [AMBIGUITY] });
    expect(withItem.questions).toHaveLength(1);
    expect(withItem.questions[0]).toMatch(/^Should entry fire/);
    // No blocking item means nothing to ask. The application does not write
    // questions on the model's behalf.
    expect(gate({ brief: dims({ name: 'X', status: 'open' }) }).questions).toEqual([]);
  });

  it('keeps every open item for the reply, not just the blocking ones', () => {
    const d = gate({
      brief: dims({ name: 'X', status: 'open' }),
      openItems: [AMBIGUITY, { kind: 'operational-limitation', question: 'EMI Events is marked new' }],
    });
    expect(d.openItems).toHaveLength(2);
  });
});

describe('completed discovery lets the strategy through', () => {
  it('accepts when every dimension is retained', () => {
    const d = gate({ brief: alternativesRuledOut(answered(dims({ name: 'Audience', status: 'retained', basis: 'user' }))) });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('deferred does not block — it is a decision, not a gap', () => {
    const d = gate({
      brief: alternativesRuledOut(answered(dims({ name: 'Spending behaviour', status: 'deferred', basis: 'assumption', note: 'No evidence it changes the intervention.' }))),
    });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('unavailable does not block for ever', () => {
    // The real OS-to-EMI finding: no outstanding-balance attribute exists on
    // any entity. If 'unavailable' blocked, this campaign could never be
    // designed, because nothing can ever resolve it.
    const d = gate({
      brief: alternativesRuledOut(answered(dims({ name: 'Outstanding statement amount', status: 'unavailable', basis: 'tool', note: 'No balance attribute exists on any entity.' }))),
    });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('accepts a mix of resolved statuses', () => {
    const d = gate({
      brief: answered(dims(
        { name: 'Statement timing', status: 'retained', basis: 'user' },
        { name: 'Credit utilisation', status: 'unavailable', basis: 'tool', note: 'Ruled out: no utilisation attribute exists.' },
        { name: 'Spending behaviour', status: 'deferred', basis: 'assumption', note: 'Ruled out: no evidence it changes the intervention.' },
      )),
    });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('a blocking item alongside complete discovery still gets the Phase 2 treatment', () => {
    const d = gate({
      brief: alternativesRuledOut(answered(dims({ name: 'Audience', status: 'retained', basis: 'user' }))),
      openItems: [AMBIGUITY],
    });
    expect(d.outcome).toBe('strategy_with_questions');
  });

  it('one open dimension among four resolved is the record\'s business, not this gate\'s', () => {
    const d = gate({
      brief: answered(dims(
        { name: 'A', status: 'retained' },
        { name: 'B', status: 'deferred', note: 'Ruled out.' },
        { name: 'C', status: 'unavailable', note: 'Ruled out.' },
        { name: 'D', status: 'retained' },
        { name: 'E', status: 'open' },
      )),
    });
    // `evaluateDiscovery` is no longer the authority on this. An 'open' row
    // with no basis and no note is `dimension-unreasoned` on the record, and
    // that is what holds the turn.
    expect(d.outcome).toBe('ready_for_strategy');
    expect(
      blocksFor(
        answered(dims(
          { name: 'A', status: 'retained' },
          { name: 'E', status: 'open' },
        )),
      ).map((x) => x.code),
    ).toContain('dimension-unreasoned');
  });
});

describe('the completeness predicate', () => {
  it('counts only open as outstanding', () => {
    const b = dims(
      { name: 'A', status: 'open' },
      { name: 'B', status: 'retained' },
      { name: 'C', status: 'deferred' },
      { name: 'D', status: 'unavailable' },
    );
    expect(outstandingDimensions(b).map((d) => d.name)).toEqual(['A']);
  });

  // `discoveryIsComplete` IS GONE, 2026-10-26, and the five cases that were
  // here went with it. They pinned a count — three raised lines of enquiry,
  // none still open, each drop explained — as the test of whether the brief
  // was finished.
  //
  // MEASURED, `eval/runs/ui-s-1792984906680`. By turn 4 the record held the
  // success measure, who converts, a barrier in the manager's own words, a
  // seen axis and an answered probe. `decide(brief).blocks` was EMPTY and a
  // real journey was on file. This predicate counted two dimension rows and
  // said discovery was not complete, so `evaluateDiscovery` returned
  // `continue_discovery` with `questions: []` — "I have only looked at 2
  // angle(s) so far" — on turn 3 and again on turn 4. The manager read an
  // essay and got no button, twice.
  //
  // A COUNT IS NOT A SEARCH, and the third row had nowhere to come from
  // except invention. What replaced it is evidence: `unprobed-other-axes`
  // asks whether they named a pattern and answered a probe we actually put to
  // them, and an `assumption` row cannot satisfy it. The two cases below are
  // what survives of this group — the drop-without-a-reason rule, which is
  // about a decision nobody explained rather than about a quantity.
  it('still refuses a line of enquiry dropped with no reason', () => {
    // `answered` first: `blocksFor` returns `no-participation` alone before
    // the first reply and stops there, deliberately — nothing below it is
    // meaningful until someone has taken part.
    const b = answered(recordDimensions(newBrief(OBJECTIVE), [
      { name: 'A', rationale: 'r', status: 'retained', basis: 'user' },
      { name: 'B', rationale: 'r', status: 'deferred', basis: 'none' },
      { name: 'C', rationale: 'r', status: 'deferred', basis: 'none', note: 'Ruled out: cost.' },
    ]));
    expect(droppedWithoutReason(b).map((d) => d.name)).toContain('B');
    expect(blocksFor(b).map((x) => x.code)).toContain('dimension-unreasoned');
  });

  it('and does not count rows: three is no longer a number anything reads', () => {
    const gateSrc = readFileSync(new URL('../../server/gate.ts', import.meta.url), 'utf8');
    const discSrc = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(gateSrc).not.toMatch(/code: 'too-few-dimensions'/);
    expect(gateSrc).not.toMatch(/export const MIN_DIMENSIONS =/);
    expect(discSrc).not.toMatch(/export const MIN_DIMENSIONS_CONSIDERED/);
    expect(discSrc).not.toMatch(/export const discoveryIsComplete/);
    // And the sentence a manager read on a finished brief is gone from the
    // CODE — it survives in the comments that record why, which is why this
    // strips them first.
    const code = discSrc
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code).not.toMatch(/I have only looked at/);
  });

  it('a brief saved before dimensions existed is read, not crashed on', () => {
    // The guarantee survives its old subject: an older brief has no
    // `dimensions` key at all, and every reader defaults rather than throwing.
    const legacy = newBrief(OBJECTIVE) as Record<string, unknown>;
    delete legacy.dimensions;
    const b = legacy as unknown as WorkingBrief;
    expect(() => briefDimensions(b)).not.toThrow();
    expect(briefDimensions(b)).toEqual([]);
    expect(() => blocksFor(b)).not.toThrow();
    expect(() => gate({ brief: b })).not.toThrow();
    expect(gate({ brief: b }).outcome).toBe('continue_discovery');
  });
});

describe('existing flows are preserved', () => {
  it('the user asking to proceed always wins over enforcement', () => {
    const d = gate({ brief: dims({ name: 'X', status: 'open' }), forced: true });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.reason).toMatch(/You asked to proceed/);
  });

  it('the round limit always wins over enforcement', () => {
    const b: WorkingBrief = { ...dims({ name: 'X', status: 'open' }), rounds: 8 };
    const d = gate({ brief: b });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.reason).toMatch(/Discovery limit of 8 rounds reached/);
  });

  it('a refinement is never re-gated', () => {
    // A campaign already exists and the user asked for a change; discovery is
    // behind them.
    const d = gate({ brief: newBrief(OBJECTIVE), isRefinement: true });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('asking questions is unaffected', () => {
    const d = gate({ modelAction: 'ask', modelQuestions: ['Which audience?'] });
    expect(d.outcome).toBe('ask_questions');
    expect(d.questions).toEqual(['Which audience?']);
  });

  it('requesting evidence is unaffected', () => {
    const d = gate({
      modelAction: 'request_evidence',
      modelEvidence: [{ question: 'How many eligible balances?', fields: ['count'], wouldInform: 'Sizing.' }],
    });
    expect(d.outcome).toBe('request_evidence');
    expect(d.evidence).toHaveLength(1);
  });
});

describe('the orchestrator honours the outcome instead of falling through', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('has an explicit branch that returns before the strategy path', () => {
    // WITHOUT this branch the change is inert: outcomes are if-chains with
    // early returns, and an unhandled one falls straight through to the
    // strategy the gate had just refused.
    const i = src.indexOf("if (!decision.proceed && !approvedPlan) {");
    expect(i).toBeGreaterThan(-1);
    // The belief override shares this branch deliberately: a refusal for an
    // untreated user belief must return exactly what a gate refusal returns,
    // or it would leak a strategy the application just declined to accept.
    // One decider now; the four vetoes ORed with it are deleted.
    expect(src).toMatch(/if \(!decision\.proceed && !approvedPlan\) \{/);
    // It must come BEFORE the proposal is read and built.
    expect(i).toBeLessThan(src.indexOf('// Discovery is complete. If the model only asked questions'));
  });

  it('returns no strategy, no blueprint and nothing to confirm', () => {
    const branch = src.slice(
      src.indexOf('if (!decision.proceed && !approvedPlan) {'),
      src.indexOf('// Discovery is complete. If the model only asked questions'),
    );
    expect(branch).toMatch(/strategy: null,/);
    expect(branch).toMatch(/blueprint: null,/);
    // TWO SCREENS OUT OF ONE BRANCH, since 2026-10-26. `discovery` when the
    // RECORD is open; `revising` when the brief is closed and the plan needs a
    // change. The old single phase told a manager with a finished brief that
    // their answer was awaited.
    // REVISE REQUIRES A PATH, 2026-10-26: with the brief closed and nothing on
    // file the screen is Plan, not a Revise with an empty canvas.
    expect(branch).toMatch(/phase: briefClosed \? planOrRevise\(filedPath\) : 'discovery',/);
    expect(branch).toMatch(/questions: briefQuestions,/);
    // THE CONTRACT THAT LANDED 2026-10-26, and the old assertion passed by
    // accident. `pendingBlueprint: null` still appears in this branch — in a
    // COMMENT recounting the bug it used to be — so a regex for it matched
    // the history rather than the code. The assignment now sends the filed
    // path so the left pane can draw it.
    //
    // What the branch withholds is agreement and construction: no strategy,
    // no blueprint to compile, and a phase that is not
    // `awaiting-confirmation`, so Confirm cannot appear. A drawing is not an
    // approval.
    expect(branch).toMatch(/pendingBlueprint: filedPath,/);
    expect(branch).not.toMatch(/pendingBlueprint: null,/);
    expect(branch).not.toMatch(/awaiting-confirmation/);
  });

  it('records the model\'s dimensions into the brief before the gate reads it', () => {
    const record = src.indexOf('brief = recordDimensions(brief, parsed.value.dimensions)');
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(src.indexOf('const gate = evaluateDiscovery({'));
  });

  it('passes the refinement flag through, so a change request is not re-gated', () => {
    const call = src.slice(src.indexOf('const gate = evaluateDiscovery({'), src.indexOf('const gate = evaluateDiscovery({') + 900);
    expect(call).toMatch(/isRefinement/);
    // AND THE RECORD'S OWN ANSWER, since 2026-10-26. The gate takes
    // `briefClosed` rather than computing a completeness rule of its own, so
    // an ask on a settled record cannot come back as `ask_questions`.
    expect(call).toMatch(/briefClosed,/);
  });
});

describe('the prompt and the gate agree', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  const SYSTEM = asking();

  it('the gate still enforces a status vocabulary the prompt no longer names', () => {
    // THE PROMPT HALF OF THIS CONTRACT IS HOMELESS, and it is the most
    // consequential loss in the manuals pass — see `server/promptHomeless.md`
    // and the note in `server/CLAUDE.md`. The application still reads these
    // values; no manual tells the model what they mean. The pin therefore
    // moves to the half that is still true: the code's own vocabulary.
    const disc = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    for (const status of ['open', 'retained', 'deferred', 'unavailable']) {
      expect(disc, status).toContain(`'${status}'`);
    }
    // These four are load-bearing, not labels: `statedTrend` licenses a
    // customer split only on `retained`, and `otherAxesProbed` reads
    // `deferred`/`unavailable` as the manager having answered the probe. A
    // model that is never told the vocabulary fills it arbitrarily.
    const gate = readFileSync(new URL('../../server/gate.ts', import.meta.url), 'utf8');
    expect(gate + disc).toMatch(/status === 'retained'/);
  });


  it('the prompt carries dimensions on every action the gate reads', () => {
    // If `dimensions` only rode on one action, a conversation could never
    // accumulate a record and the gate would refuse for ever.
    // Dimensions are no longer a field on two payload templates; they are a
    // tool, and the gate reads the record it writes. What must stay true is
    // that the agent can record them on ANY turn, which is what "every action
    // the gate reads" meant.
    for (const turn of [true, false]) {
      expect(outputToolsForPhase(turn ? 'build' : 'asking').map((t) => t.name)).toContain('record_dimensions');
    }
    // And the tool that records them takes them as its required input, so
    // "carries dimensions" is now enforced by the schema rather than by the
    // field appearing in two prompt templates.
    const dims = OUTPUT_TOOLS.find((t) => t.name === 'record_dimensions')!;
    expect(dims.input_schema.required).toContain('dimensions');
  });
});

describe('the user must have taken part before a strategy is accepted', () => {
  it('blocks a first-turn proposal even when the model marks EVERY dimension resolved', () => {
    // THE LIVE FAILURE, exactly. On the real OS-to-EMI objective the agent
    // emitted five dimensions, closed all five inside that same turn, and
    // proposed a full campaign with answers: []. The record was complete and
    // the gate had no grounds to refuse, because the model writes both the
    // dimensions and their statuses.
    const selfCertified = dims(
      { name: 'Assigned credit limit', status: 'retained', basis: 'tool' },
      { name: 'Already started the request', status: 'unavailable', basis: 'tool', note: 'Ruled out: no in-progress attribute exists.' },
      { name: 'App on the phone', status: 'retained', basis: 'user' },
      { name: 'How they were sourced', status: 'retained', basis: 'user' },
      { name: 'Outstanding statement amount', status: 'retained', basis: 'user' },
    );
    // The record the AGENT wrote says done — five dimensions, every one
    // resolved — and nobody was asked anything. Completeness it certifies for
    // itself is not evidence that discovery happened, which is why
    // participation is a block of its own and why a row count never was one.
    expect(briefDimensions(selfCertified)).toHaveLength(5);
    expect(userHasRespondedOnce(selfCertified)).toBe(false);
    expect(blocksFor(selfCertified).map((x) => x.code)).toContain('no-participation');
    const d = gate({ brief: selfCertified });
    expect(d.outcome).toBe('continue_discovery');
    expect(d.reason).toMatch(/without asking you anything first/i);
  });

  it('lets the same proposal through once the user has answered', () => {
    const d = gate({
      brief: alternativesRuledOut(answered(dims({ name: 'Assigned credit limit', status: 'retained', basis: 'tool' }))),
    });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('counts a reply to an EVIDENCE request as taking part', () => {
    // The orchestrator resolves evidence without calling recordAnswer, so
    // keying on `answers` alone would strand a conversation whose only
    // exchange was "we don't have that" — which the agent is designed to
    // proceed from.
    const b: WorkingBrief = {
      ...recordSuccessCriteria(
        dims({ name: 'Amount bands', status: 'deferred', basis: 'assumption', note: 'Data unavailable.' }),
        ['Completed conversions among customers who entered.'],
      ),
      evidenceRequests: [{
        id: 'e1', question: 'Conversion by amount band?', fields: ['count'],
        wouldInform: 'Whether to segment.', askedInRound: 1, status: 'unavailable',
      }],
    };
    expect(userHasRespondedOnce(b)).toBe(true);
    // The gate still holds this brief back, but NOT on participation grounds:
    // a conversation whose only exchange was "we don't have that" has nobody
    // saying who converts or why the rest do not, so the two customer
    // findings are genuinely missing. The point this test protects is that
    // participation is not keyed on `answers` alone, which the assertion
    // above proves directly.
    expect(gate({ brief: b }).reason).not.toMatch(/without putting anything to you first/);
  });

  it('a still-pending evidence request is NOT taking part', () => {
    const b: WorkingBrief = {
      ...dims({ name: 'Amount bands', status: 'retained', basis: 'tool' }),
      evidenceRequests: [{
        id: 'e1', question: 'Conversion by amount band?', fields: ['count'],
        wouldInform: 'Whether to segment.', askedInRound: 1, status: 'pending',
      }],
    };
    expect(userHasRespondedOnce(b)).toBe(false);
    expect(gate({ brief: b }).outcome).toBe('continue_discovery');
  });

  it('forced progression and the round limit still bypass the requirement', () => {
    const unanswered = dims({ name: 'Assigned credit limit', status: 'retained', basis: 'tool' });
    expect(gate({ brief: unanswered, forced: true }).outcome).toBe('ready_for_strategy');
    expect(gate({ brief: { ...unanswered, rounds: 8 } }).outcome).toBe('ready_for_strategy');
  });

  it('a refinement is still never re-gated', () => {
    expect(gate({ brief: newBrief(OBJECTIVE), isRefinement: true }).outcome).toBe('ready_for_strategy');
  });
});

describe('an assumption is not recorded as an investigated finding', () => {
  it('a dimension closed on an assumption is stored as deferred, not retained', () => {
    // Observed live: platform slots were marked retained/assumption. Those
    // names are no longer stored. The same close-on-assumption rule still
    // applies to a real customer factor.
    const b = dims({ name: 'Assigned credit limit', status: 'retained', basis: 'assumption' });
    const d = briefDimensions(b)[0];
    expect(d.status).toBe('deferred');
    expect(d.basis).toBe('assumption');
    expect(d.note).toMatch(/assumption rather than an investigated finding/);
  });

  it('does not record channel sequencing or suppression as dimensions at all', () => {
    const b = dims(
      { name: 'Channel sequencing and cost', status: 'retained', basis: 'assumption' },
      { name: 'Suppression (DNC, NPA, quiet hours)', status: 'retained', basis: 'assumption' },
    );
    expect(briefDimensions(b)).toEqual([]);
  });

  it('three platform topics are refused as lines of enquiry at the door', () => {
    // RETARGETED. This asserted `continue_discovery` because three platform
    // topics could not reach the old three-row count. The count is gone; the
    // rule that matters is upstream and unchanged — `recordDimensions` does
    // not store a platform setting as a line of enquiry at all.
    const b = answered(dims(
      { name: 'Entry event', status: 'retained', basis: 'tool' },
      { name: 'Channel order', status: 'retained', basis: 'tool' },
      { name: 'Quiet hours', status: 'retained', basis: 'tool' },
    ));
    expect(briefDimensions(b)).toEqual([]);
    expect((b.droppedDimensions ?? []).length).toBeGreaterThan(0);
  });

  it('keeps the model\'s own reason when it gave one', () => {
    const b = dims({ name: 'X', status: 'retained', basis: 'assumption', note: 'Cheapest-first is the stated preference.' });
    expect(briefDimensions(b)[0].note).toBe('Cheapest-first is the stated preference.');
  });

  it('leaves a genuine finding alone', () => {
    for (const basis of ['tool', 'user'] as const) {
      const d = briefDimensions(dims({ name: 'X', status: 'retained', basis }))[0];
      expect(d.status, basis).toBe('retained');
    }
  });

  it('does not loop: the normalised dimension still lets a strategy through', () => {
    // Reopening it instead would invite the model to re-assert the same
    // assumption every round, which is an endless loop and not discovery.
    const b = alternativesRuledOut(answered(dims({ name: 'Assigned credit limit', status: 'retained', basis: 'assumption' })));
    expect(outstandingDimensions(b)).toEqual([]);
    expect(gate({ brief: b }).outcome).toBe('ready_for_strategy');
  });

  it('normalises on a later round too, not just on first record', () => {
    const r1 = dims({ name: 'Assigned credit limit', rationale: 'Large vs small limits convert differently.', status: 'open', basis: 'none' });
    const r2 = recordDimensions(r1, [{ name: 'Assigned credit limit', status: 'retained', basis: 'assumption' }]);
    expect(briefDimensions(r2)[0].status).toBe('deferred');
    expect(briefDimensions(r2)[0].rationale).toBe('Large vs small limits convert differently.');
  });
});

describe('OS-to-EMI: an absent attribute cannot be faked or substituted', () => {
  it('no outstanding-balance attribute exists on any entity', async () => {
    // The finding the whole OS dimension rests on. Locked down so nobody
    // "fixes" the gap by inventing a field.
    const { ELIGIBILITY_META } = await import('../../src/data/sharedConstants');
    const all = Object.entries(ELIGIBILITY_META).flatMap(([entity, attrs]) =>
      Object.keys(attrs).map((a) => `${entity}.${a}`),
    );
    expect(all.filter((n) => /outstanding|balance|utilis|utiliz|credit.?limit/i.test(n))).toEqual([]);
    // Exactly one numeric attribute exists, and it is a TRANSACTION amount —
    // a different entity and a different thing from a statement balance.
    const numeric = Object.entries(ELIGIBILITY_META).flatMap(([entity, attrs]) =>
      Object.entries(attrs).filter(([, m]) => (m as { type: string }).type === 'number').map(([a]) => `${entity}.${a}`),
    );
    expect(numeric).toEqual(['Transaction.Transaction Amount']);
  });

  it('a blueprint claiming OS-amount targeting is rejected by the builder', async () => {
    const { buildFromBlueprint } = await import('../../server/blueprint');
    const built = buildFromBlueprint(
      {
        campaignName: 'OS-to-EMI by balance band',
        description: 'Segment by outstanding balance.',
        goal: { eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', conditions: [] },
        entry: {
          kind: 'audience',
          entity: 'Account',
          // Does not exist. Substituting Transaction Amount here would be the
          // dishonest move; inventing this one is the lazy move. Both fail.
          conditions: [{ attribute: 'Outstanding Balance', operator: 'Between', value: '5000' }],
        },
        steps: [{ kind: 'send', name: 'Nudge', objective: ['emi'], stage: 'first-touch', describe: 'Convert.' }],
      } as never,
      ['EMAIL'] as never,
    );
    const issues = JSON.stringify(built.issues);
    expect(built.issues.length).toBeGreaterThan(0);
    expect(issues).toMatch(/Outstanding Balance/);
  });
});

describe('an unverified limitation is not recorded as a confirmed one', () => {
  const UNVERIFIED = /unverified: it rests on an assumption, not on a tool result/;

  it('unavailable on an assumption becomes deferred', () => {
    // The mirror of retained+assumption, and the costlier error: an unchecked
    // claim of impossibility removes a strategy that may be buildable, and
    // would reach the user as a confirmed platform limitation.
    const d = briefDimensions(dims({ name: 'Credit utilisation', status: 'unavailable', basis: 'assumption' }))[0];
    expect(d.status).toBe('deferred');
    expect(d.basis).toBe('assumption');
    expect(d.note).toMatch(UNVERIFIED);
  });

  it('keeps the agent\'s own reason AND marks it unverified', () => {
    const d = briefDimensions(dims({
      name: 'Credit utilisation',
      rationale: 'Utilisation may matter beyond the absolute balance.',
      status: 'unavailable',
      basis: 'assumption',
      note: 'I do not think a utilisation field exists.',
    }))[0];
    expect(d.note).toMatch(/I do not think a utilisation field exists\./);
    expect(d.note).toMatch(UNVERIFIED);
    // The rationale for raising it is untouched.
    expect(d.rationale).toBe('Utilisation may matter beyond the absolute balance.');
  });

  it('supplies the marker alone when the agent gave no reason', () => {
    const d = briefDimensions(dims({ name: 'X', status: 'unavailable', basis: 'assumption' }))[0];
    expect(d.note).toBe('This limitation is unverified: it rests on an assumption, not on a tool result.');
  });

  it('leaves a VERIFIED limitation exactly as it is', () => {
    // The real OS-to-EMI finding: no outstanding-balance attribute exists on
    // any entity, established by reading the metadata. That must keep saying
    // 'unavailable', or a genuine limitation stops being disclosed.
    for (const basis of ['tool', 'user'] as const) {
      const d = briefDimensions(dims({
        name: 'Outstanding statement amount',
        status: 'unavailable',
        basis,
        note: 'No balance attribute exists on any entity.',
      }))[0];
      expect(d.status, basis).toBe('unavailable');
      expect(d.note, basis).toBe('No balance attribute exists on any entity.');
    }
  });

  it('leaves unavailable with no stated basis alone', () => {
    // basis defaults to 'none', which is not a claim of having checked and
    // not an assumption either, so nothing is rewritten.
    const d = briefDimensions(dims({ name: 'X', status: 'unavailable' }))[0];
    expect(d.basis).toBe('none');
    expect(d.status).toBe('unavailable');
  });

  it('the earlier retained+assumption rule still holds', () => {
    const d = briefDimensions(dims({ name: 'Assigned credit limit', status: 'retained', basis: 'assumption' }))[0];
    expect(d.status).toBe('deferred');
    expect(d.note).toMatch(/assumption rather than an investigated finding/);
    // ...and does NOT pick up the limitation marker, which would misdescribe it.
    expect(d.note).not.toMatch(UNVERIFIED);
  });

  it('does not stack the marker when the dimension is re-asserted', () => {
    // A model repeating itself each round must not grow the note without end.
    let b = dims({ name: 'Credit utilisation', status: 'unavailable', basis: 'assumption' });
    for (let i = 0; i < 4; i += 1) {
      b = recordDimensions(b, [{ name: 'Credit utilisation', status: 'unavailable', basis: 'assumption' }]);
    }
    const note = briefDimensions(b)[0].note!;
    expect(note.match(/unverified/g)).toHaveLength(1);
    expect(briefDimensions(b)).toHaveLength(1);
  });

  it('does not reopen or loop: the strategy still gets through', () => {
    const b = alternativesRuledOut(answered(dims({ name: 'Credit utilisation', status: 'unavailable', basis: 'assumption', note: 'Ruled out: nothing carries it.' })));
    expect(outstandingDimensions(b)).toEqual([]);
    expect(blocksFor(b).map((x) => x.code)).toEqual([]);
    expect(gate({ brief: b }).outcome).toBe('ready_for_strategy');
  });

  it('a later tool check can still promote it to a real limitation', () => {
    // Downgrading is not a dead end: once something actually verifies it, the
    // dimension may legitimately become 'unavailable' again.
    const assumed = dims({ name: 'Credit utilisation', status: 'unavailable', basis: 'assumption' });
    expect(briefDimensions(assumed)[0].status).toBe('deferred');
    const verified = recordDimensions(assumed, [
      { name: 'Credit utilisation', status: 'unavailable', basis: 'tool', note: 'No utilisation attribute on any entity.' },
    ]);
    expect(briefDimensions(verified)[0].status).toBe('unavailable');
    expect(briefDimensions(verified)[0].note).toBe('No utilisation attribute on any entity.');
  });
});
