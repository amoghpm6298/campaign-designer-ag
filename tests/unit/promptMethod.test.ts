// Phase 5: the system prompt encodes a campaign-design method, and the
// contradictions it used to carry are gone.
//
// These are CONTRACT tests, not quality tests. They prove the instruction set
// says what it is supposed to say and no longer says two opposite things.
// Whether the agent then designs a good campaign is assessed by a person
// against agent-proto/scenarios/evaluation-set.json — see
// agent-proto/evaluateScenarios.ts, and the 'campaign-quality' check in
// agent-proto/validate.ts, which has always recorded that quality is not
// mechanically checkable.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGENT_TOOLS } from '../../server/agentTools';
import { OUTPUT_TOOLS } from '../../server/outputTools';

const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();

const evalSet = JSON.parse(
  readFileSync(new URL('../../agent-proto/scenarios/evaluation-set.json', import.meta.url), 'utf8'),
) as {
  rubric: Record<string, string>;
  scenarios: { id: string; title: string; objective: string; reasoning: string; watchFor: string[]; clarification?: string }[];
};

describe('the prompt teaches a design method, not a form', () => {
  it('tells the model to reason about the sequence before choosing an entry event', () => {
    // The EMI failure in one instruction: the objective said EMI, the
    // vocabulary had an EMI category, and nothing asked where in the
    // customer's sequence the intervention belongs.
    expect(SYSTEM).toMatch(/sequence, before you pick an entry event/i);
    expect(SYSTEM).toMatch(/Entry belongs where the behaviour you want has NOT happened yet/);
    expect(SYSTEM).toMatch(/Never choose an event because its name shares a word with the objective/);
  });

  it('separates the business objective from the platform goal', () => {
    expect(SYSTEM).toMatch(/the goal is the event that proves the behaviour happened/i);
    expect(SYSTEM).toMatch(/If no event can prove it, say so/i);
  });

  it('asks for a hypothesis, and forbids predicting a number', () => {
    expect(SYSTEM).toMatch(/by what mechanism should this campaign change the behaviour/i);
    expect(SYSTEM).toMatch(/It is a hypothesis, not a prediction/);
    expect(SYSTEM).toMatch(/Never claim a conversion lift/);
  });

  it('requires proportionate design with stated rejections', () => {
    // RETARGETED TWICE. The first wording argued only against doing MORE,
    // which the agent read as licence to ship a three-message clock. The
    // replacement, "A THREE-MESSAGE CLOCK IS NOT A PLAN", then over-corrected:
    // it reads as "do not list reminders", and the fix for a flat schedule was
    // never to name FEWER sends — it was to react to what happened. Measured
    // 2026-10-22: a 14-day plan proposed "a staggered multi-touch sequence"
    // and named not one send.
    //
    // So the rule splits in two. Reaction is still required, and every touch
    // must now be named.
    expect(SYSTEM).toMatch(/EVEN SPACING WITH NO REACTION IS NOT A PLAN/);
    expect(SYSTEM).toMatch(/NAME EVERY TOUCH/);
    expect(SYSTEM).not.toMatch(/A THREE-MESSAGE CLOCK IS NOT A PLAN/);
    // The window is time to work the action, and a lighter path is named
    // rather than assumed.
    expect(SYSTEM).toMatch(/the time you have to work an unfinished action/);
    expect(SYSTEM).toMatch(/FEWER touches as a NAMED path/);
    // Send count still cannot tell two architectures apart.
    expect(SYSTEM).toMatch(/Send count still does not make two architectures different/);
    expect(SYSTEM).toMatch(/Simplest RELATIVE TO THE STRATEGY, not fewest steps/);
    expect(SYSTEM).toMatch(/they converted, and the campaign stops for them/);
    expect(SYSTEM).toMatch(/say what you considered and rejected/i);
    // Restraint runs BOTH ways. The rule above, alone, only ever argued
    // against doing more — so an option the builder could not express was as
    // good as an option not worth doing, and the strategy silently shrank to
    // whatever happened to be buildable. The converse is now explicit.
    expect(SYSTEM).toMatch(/Platform capability decides what gets BUILT, never what gets CONSIDERED/);
    expect(SYSTEM).toMatch(/Never quietly downgrade it to a weaker thing the builder allows/);
    expect(SYSTEM).toMatch(/DNC, NPA OR THE CONTROL GROUP/);
    expect(SYSTEM).toMatch(/Do not put a holdout in "touches"/);
  });

  it('requires customer-facing copy, written by the agent', () => {
    expect(SYSTEM).toMatch(/Write each one as the CUSTOMER will read it/);
    expect(SYSTEM).toMatch(/never a description of it and never an instruction to the campaign manager/);
    expect(SYSTEM).toMatch(/Never ask for message copy or CTA wording/);
  });

  it('tells the model what to do with a conflict the application detected', () => {
    expect(SYSTEM).toMatch(/UNRESOLVED CONFLICT/);
    expect(SYSTEM).toMatch(/do not substitute a different attribute or value for it/);
  });
});

describe('the contradictions the old prompt carried are gone', () => {
  it('no longer pleads for one batch of tool calls', () => {
    // Phase 2 made this structural: the tools are withdrawn once there is
    // nothing left to look up. A plea the model can decline, on top of a
    // mechanism that cannot be declined, was noise.
    expect(SYSTEM).not.toMatch(/ONE batch/);
    expect(SYSTEM).not.toMatch(/Two rounds of tool calls is the practical maximum/);
  });

  it('no longer pushes for evidence the knowledge base says does not exist', () => {
    // Three paragraphs used to urge requesting aggregates, while the KB states
    // plainly that no performance history exists for this bank.
    expect(SYSTEM).not.toMatch(/An assumption you could have tested with one aggregated table/);
    expect(SYSTEM).toMatch(/no performance history exists for this bank, so do not ask for it again/i);
  });

  it('makes discovery the opening move, not a last resort', () => {
    // Phase 2's contract is that a strategy always travels with its open
    // questions. "Pick ONE of three moves per round" contradicted it.
    expect(SYSTEM).not.toMatch(/pick ONE of three moves/i);

    // THE REVERSAL. Asking used to be gated behind "Only when you genuinely
    // cannot propose anything responsible", while proposing was framed as
    // "Normally" — so one question per conversation was the prompt being
    // obeyed, not ignored. Both framings are gone.
    expect(SYSTEM).not.toMatch(/Normally, propose/);
    expect(SYSTEM).not.toMatch(/Only when you genuinely cannot propose anything responsible/);
    expect(SYSTEM).toMatch(/DISCOVER FIRST/);
    expect(SYSTEM).toMatch(/Propose only once the user has answered at least one question AND no dimension is still "open"/);

    // Preserved from the old framing: a drip campaign may simply be the wrong
    // instrument, and the agent must be able to say so.
    expect(SYSTEM).toMatch(/a drip campaign is the wrong instrument for it entirely/);
  });

  it('tells the agent to find the dimensions before designing anything', () => {
    // The gap both live runs exhibited: the method went objective -> event
    // sequence -> journey, with "segmentation" as one word in a list of
    // twelve. Nothing asked whether customers differ in ways that matter.
    const method = SYSTEM.slice(SYSTEM.indexOf('HOW TO DESIGN A CAMPAIGN'), SYSTEM.indexOf('QUESTIONS AND OPEN ITEMS'));
    expect(method).toMatch(/The dimensions\. Do this BEFORE you pick an entry event or design anything/);
    // ORDERING: dimensions must come before the entry-event step. They used to
    // sit after it, so the model had already committed to an event-centric
    // frame — observed live as 4 of 5 dimensions being platform mechanics.
    expect(method.indexOf('The dimensions.')).toBeLessThan(method.indexOf('The sequence, before you pick an entry event'));
    // NO PRE-FILTER: "could the answer change the design? if not, do not raise
    // it" contradicted the later "if the platform cannot represent it, mark it
    // unavailable" — a dimension that cannot be built cannot change the
    // design, so the first test deleted exactly what the third wanted
    // disclosed. That is why OS amount never appeared in any recorded run.
    expect(method).not.toMatch(/Could the answer change the design\? If not, do not raise it/);
    expect(method).toMatch(/silently dropping it is the one outcome that is never acceptable/);
    expect(method).toMatch(/3-5/);
    // A DIMENSION IS A BUSINESS FACTOR. Measured: of six dimensions in a live
    // run, three were platform concerns (product-type scoping, channel order,
    // event reliability) and outstanding balance was closed as unavailable
    // before the user was ever asked their view of it. Two bullets caused it —
    // "can a TOOL answer it" (every tool is platform metadata) and a
    // buildability test that fired before "ask the user".
    expect(method).toMatch(/A DIMENSION IS A BUSINESS OR CUSTOMER FACTOR, never a platform setting/);
    expect(method).toMatch(/those are IMPLEMENTATION questions/);
    expect(method).toMatch(/They must not occupy the 3-5 slots/);
    expect(method).toMatch(/THE USER IS THE PRIMARY SOURCE for a dimension/);
    // Narrowed deliberately. The old blanket ban stopped the agent using the
    // attribute list to PROPOSE customer factors, which is the thing that made
    // dimension discovery a recording exercise: every scenario produced the
    // same three slots because those are the three the prompt names. The part
    // that matters — platform concerns may not occupy a slot — is kept.
    expect(method).toMatch(/BUT DO NOT ONLY RECORD WHAT THEY RAISED/);
    // RETARGETED 2026-10-22, not weakened. §2 stated this rule twice: once in
    // the paragraph that bars platform concerns from the slots, and again in a
    // follow-up paragraph that repeated the same three examples and the same
    // test. The duplicate paid for the trends rules added this slice; the rule
    // itself is where it always was, in the paragraph above.
    expect(method).toMatch(/the test is whether the answer describes a customer and could change what someone gets/);
    expect(method).toMatch(/A DIMENSION IS A BUSINESS OR CUSTOMER FACTOR, never a platform setting/);
    expect(method).not.toMatch(/Can a TOOL answer it\? Then call the tool/);
    expect(method).not.toMatch(/Can the builder express it at all/);
    // Platform limits may never end an investigation, and nor may missing data.
    expect(method).toMatch(/NEVER close a dimension because the platform cannot express it/);
    expect(method).toMatch(/Ask the user whether it matters first/);
    expect(method).toMatch(/Missing numbers are likewise not a reason to drop a dimension/);
    // Business strategy precedes platform mapping.
    expect(method.indexOf('The business strategy, before any platform mapping')).toBeLessThan(
      method.indexOf('The sequence, before you pick an entry event'),
    );
    // The whole status vocabulary must be teachable from the prompt alone.
    for (const status of ['open', 'retained', 'deferred', 'unavailable']) {
      expect(method, status).toContain(`"${status}"`);
    }
    // And the honesty rules that stopped OS amount being faked.
    expect(method).toMatch(/do not substitute a loosely related attribute/);
    expect(method).toMatch(/Never invent a threshold, a bucket, a distribution or a rate/);
    // Was /Reassess after every answer/ — one clause that asked for a
    // reassessment without saying what one consists of, so in practice an
    // answer closed its dimension and discovery ended. Replaced by the
    // four-way read in followUpDiscovery.test.ts; the anchor here just holds
    // the rule inside the dimensions step.
    expect(method).toMatch(/AN ANSWER IS NOT AUTOMATICALLY A CLOSED DIMENSION/);
  });

  it('requires unresolved dimensions to survive the discovery limit as decisions', () => {
    // At the limit the gate stops enforcing, so the prompt is what stops an
    // open dimension simply vanishing from the record.
    const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    const limit = src.slice(src.indexOf('DISCOVERY LIMIT REACHED'), src.indexOf('DISCOVERY LIMIT REACHED') + 600);
    expect(limit).toMatch(/strategy\.assumptions/);
    expect(limit).toMatch(/strategy\.unknowns/);
    expect(limit).toMatch(/limitation/);
    expect(limit).toMatch(/Do not drop one/);
  });

  it('no longer asks for a field nothing reads', () => {
    // workingHypothesis was requested in the schema and read nowhere.
    expect(SYSTEM).not.toMatch(/workingHypothesis/);
    const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/workingHypothesis/);
  });

  it('does not restate platform facts the tools already carry', () => {
    // Phase 1 put allowed values, operators and the entity mapping in the
    // tools. Repeating them in prose is how the two drift apart.
    expect(SYSTEM).not.toMatch(/CUSTOMER_INITIATED|AUTHORIZE|Single-Txn/);
    expect(SYSTEM).not.toMatch(/EMI_STATUS_CHANGED/);
    // ...and it still points at the tools as the source.
    expect(SYSTEM).toMatch(/only the events, entities, attributes, values, channels and step kinds the tools report/i);
  });

  it('keeps the earlier phases\' contracts intact', () => {
    for (const kind of ['strategic-ambiguity', 'evidence-gap', 'optional-preference', 'operational-limitation']) {
      expect(SYSTEM, kind).toContain(kind);
    }
    // The payload templates are gone; these contracts live in the tools now.
    expect(OUTPUT_TOOLS.map((t) => t.name)).toContain('propose_strategy');
    expect(JSON.stringify(OUTPUT_TOOLS.find((t) => t.name === 'build_campaign')!.input_schema)).toContain('"copy"');
    expect(SYSTEM).toMatch(/Nothing is built until the user confirms it/);
  });

  it('stays bounded, and spends its length on the method', () => {
    // History: the pre-Phase-5 prompt was 8,246 characters, of which roughly
    // 400 were about designing a campaign. Phase 5 kept the total within 1%
    // while making the method the largest section. Discovery-first then added
    // the dimensions step, which is a real increase and the reason this cap
    // moved from 8,400 to 15,800 rather than being removed — the guard is
    // against unbounded growth and dilution, not against the prompt ever
    // changing size. ~5% headroom: enough that an ordinary edit does not trip
    // it, tight enough that another whole section is a deliberate decision.
    //
    // 15,800 -> 19,500 is one such decision: the strategic-options step. The
    // journey step used to be a flat menu of things to "consider", which is
    // not a method — nothing required a verdict, so an option the agent never
    // thought about looked exactly like one it had weighed and dismissed, and
    // the default outcome was a linear chain of sends. The replacement names
    // seven options and makes each one answerable.
    // 19,500 -> 21,700 for iterative discovery: the agent asked its opening
    // questions, took the answers, and proposed — never testing whether an
    // answer had narrowed a question rather than settled it, and never
    // tracing a decision back to the answer that drove it.
    // 22,300 -> 23,000 for answer attribution: the agent must now say which
    // questions a reply actually answered, because the application was
    // asserting that all of them were.
    // 23,000 -> 25,000 for risk-weighted resolution: a question now carries how
    // much rides on its answer, and a fork may not be settled by assumption.
    // 25,000 -> 27,500 for the architecture rules (2.1/2.2/2.5). The agent
    // reasoned well in prose and then built a generic sequence: across both
    // scenarios the only alternative weighed was "send one message instead of
    // three", and a discovered timing factor was reported as a platform
    // limitation when a different entry would have carried it.
    // 27,500 -> 29,000. Two of these changes are SUBTRACTIONS (a prohibition
    // narrowed, an instruction scoped) and still cost characters to say
    // precisely; one adds the count-vs-value question.
    // Raised from 29,000, deliberately and once.
    //
    // The old number was set when the prompt happened to be 28.4k — it was a
    // bloat guard, not a budget anyone had costed. Meeting it the last time
    // cost real substance: the concrete half of the attribute-exploration rule
    // ("read the attribute list — balance bands, credit limit, tenure...") was
    // deleted to save characters, and the next live run recorded five
    // dimensions of which three merely restated the user and one was the
    // user's own hunch. Trimming instructions to hit an invented number is the
    // wrong trade. The rule is restored, along with two that make uncertainty
    // widen the search rather than narrow it, and the guard moves with it.
    // 31,000 -> 32,000, and the reason matters more than the number.
    //
    // P1 adds a genuinely new step to the contract: the agent states the
    // intervention BEFORE it is told what the platform supports, so that a
    // requirement the user asked for cannot quietly become whatever happened
    // to be buildable. That is substance, not bloat.
    //
    // The first attempt paid for it by trimming the Experimentation rule — and
    // five tests failed, because the sentences cut were pins on real measured
    // defects ("no history is a reason TO test", "do not ask the user for copy
    // variants"). Trimming instructions to hit a number I invented is the same
    // mistake that produced thin dimensions earlier, so the number moves
    // instead. The guard still exists; it guards at a level that reflects what
    // the prompt now has to carry.
    // 32,000 -> 33,000. The SECOND raise, and I should be honest that the
    // first was declared "deliberately and once".
    //
    // What grew is the CONTRACT, not the prose: a design action, an experiment
    // claim, a question contingency, and now two new step kinds — a condition
    // on a customer attribute and an N-way branch. Those last two exist
    // because the builder has always supported them and the vocabulary the
    // agent writes in had no words for them, which is why cohorting could only
    // ever happen at entry and every campaign came out flat.
    //
    // Genuine fat WAS removed first: every reference to the per-campaign
    // message cap (which no longer exists) and nine placeholder hints that
    // restated rules argued at length elsewhere. What remains is load-bearing
    // — each long line is pinned by a test encoding a measured defect, and
    // trimming those is how the thin-dimensions regression happened.
    //
    // RAISED FROM 33,000 TO 33,400, deliberately and once, for capability
    // rather than for prose:
    //  - the two customer findings the agent must establish before it can
    //    propose (who converts, why the rest do not), which is the whole
    //    point of the findings model;
    //  - entry's `groups`, which the agent did not know existed. Not knowing
    //    it, the agent told a campaign manager that the platform could not
    //    combine KYC status with account standing in one entry, and offered
    //    that as a trade-off to accept. It has been able to since
    //    2026-10-09.
    //
    // Editorial savings were taken first and are exhausted: a duplicated
    // "no performance data" statement, the `stage` values listed twice, and
    // a sentence about entry filtering ONE entity that this change made
    // untrue. Together those paid for about half of it.
    //
    // The reduction still available is structural rather than editorial, but
    // it is SMALLER than previously claimed here. Most of the ~7,350
    // characters of JSON response shapes is placeholder prose
    // ("<a materially different approach you CHOSE not to take>"), which the
    // types cannot generate and several tests pin verbatim. Generating the
    // key names alone would save far less than the 2,700 this comment used
    // to promise.
    // 33,400 -> 33,500, 2026-10-16, for 38 characters of schema slot.
    //
    // Raised because the alternative was worse. The propose payload had no
    // place for "converters" or "barriers" while the prompt said "You cannot
    // propose without both" and the gate enforced it — a guaranteed deadlock,
    // hit three turns running in a live session. Fitting the slot under the
    // old cap meant editing method sentences that other tests pin verbatim
    // because each one records a measured correction, and shortening those to
    // buy room for a bug fix trades a known lesson for a character count.
    expect(SYSTEM.length).toBeLessThanOrEqual(33_500);
    const method = SYSTEM.slice(SYSTEM.indexOf('HOW TO DESIGN A CAMPAIGN'), SYSTEM.indexOf('QUESTIONS AND OPEN ITEMS'));
    // Still the largest section, and now roughly half the prompt.
    expect(method.length).toBeGreaterThan(4000);
    expect(method.length).toBeGreaterThan(SYSTEM.length * 0.4);
  });
});

describe('the evaluation set is usable test data, not a production rule', () => {
  it('covers ten distinct objectives, each with a reviewer rationale', () => {
    expect(evalSet.scenarios).toHaveLength(10);
    expect(new Set(evalSet.scenarios.map((s) => s.id)).size).toBe(10);
    expect(new Set(evalSet.scenarios.map((s) => s.objective)).size).toBe(10);
    for (const s of evalSet.scenarios) {
      expect(s.reasoning.length, s.id).toBeGreaterThan(40);
      expect(s.watchFor.length, s.id).toBeGreaterThan(0);
    }
  });

  it('states a rubric that a well-formed response alone cannot satisfy', () => {
    expect(Object.keys(evalSet.rubric)).toEqual(
      expect.arrayContaining(['objective', 'causal', 'grounded', 'proportionate', 'questions', 'messaging']),
    );
  });

  it('is read by nobody in the application', () => {
    // The fixture must never become behaviour. Only the manual runner may
    // load it.
    const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/evaluation-set/);
    for (const t of AGENT_TOOLS) expect(JSON.stringify(t)).not.toMatch(/evaluation-set/);
  });

  it('pairs the two scenarios whose difference is the whole point', () => {
    // S1 enters before the customer has acted; S6 enters after. Same subject,
    // different point in the sequence — the distinction the method teaches.
    const s1 = evalSet.scenarios.find((s) => s.id === 'S1-auth-txn-to-emi')!;
    const s6 = evalSet.scenarios.find((s) => s.id === 'S6-pending-emi')!;
    expect(s1.objective).not.toEqual(s6.objective);
    expect(s6.reasoning).toMatch(/contrast with S1/i);
  });
});
